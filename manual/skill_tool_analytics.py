"""Analytics over real usage: which tools and skills agents actually call.

Source choice — DB, not OTel (deliberate):
  OTel spans only instrument LLM calls (token usage / cost), ``generate_image``
  / ``generate_video``, and summarization. General tool calls (``ls``, ``grep``,
  ``shell``, ``skill`` …) are NOT traced, so OTel cannot answer "which tools /
  skills are used and how often". The complete record is the persisted
  ``session_messages.tool_calls`` JSON — that is what this script reads.
  (For cost/token/latency analytics, read ``{STATE_DIR}/otel/`` instead.)

Reads via the shared ``async_session_factory``, so it honours the same XDG/dev
DB layout, pragmas, and pool sizing as the running server — no separate engine,
no path guessing.

What it answers:
  * Which builtin tools get called, and how often.
  * Which skills get loaded (``skill`` tool calls), and how often.
  * The same two breakdowns split by session ``mode`` (normal vs coding),
    so you can see e.g. that ``mcp-installer`` is used in coding sessions but
    the skill text never accounts for that mode.

Usage:
  # Dev DB (default — APP_ENV unset):
  uv run python -m manual.skill_tool_analytics

  # Production DB:
  APP_ENV=production uv run python -m manual.skill_tool_analytics

  # Only the last 30 days, show skills only:
  uv run python -m manual.skill_tool_analytics --since-days 30 --only skills

Notes:
  * ``tool_calls`` is JSON; each entry is ``{function: {name, arguments}}``.
  * A skill invocation is a ``skill`` tool call; the loaded skill name is read
    from the call's ``skill_name`` argument.
"""

from __future__ import annotations

import argparse
import asyncio
import json
from collections import Counter
from datetime import datetime, timedelta, timezone

from sqlmodel import select

from app.core.db import async_session_factory
from app.models.chat import ChatSession, SessionMessage

# Builtin op-skills we care about specifically (everything else still counts).
_OP_SKILLS = {
    "mcp-installer",
    "skill-installer",
    "plugin-installer",
    "self-healing",
    "browser-use",
}


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--since-days",
        type=int,
        default=None,
        help="Only count calls newer than N days.",
    )
    p.add_argument("--only", choices=["tools", "skills", "both"], default="both")
    p.add_argument(
        "--top", type=int, default=40, help="Max rows per table (default 40)."
    )
    return p.parse_args()


def _skill_name_from_args(raw_args: str | None) -> str | None:
    if not raw_args:
        return None
    try:
        parsed = json.loads(raw_args)
    except (TypeError, ValueError):
        return None
    if not isinstance(parsed, dict):
        return None
    name = parsed.get("skill_name") or parsed.get("name")
    return str(name) if name else None


def _iter_calls(tool_calls: object):
    """Yield ``(name, arguments)`` for each function call in a tool_calls cell."""
    if not isinstance(tool_calls, list):
        return
    for call in tool_calls:
        if not isinstance(call, dict):
            continue
        fn = call.get("function")
        if not isinstance(fn, dict):
            continue
        name = fn.get("name")
        if name:
            yield str(name), fn.get("arguments")


def _bar(count: int, total: int, width: int = 28) -> str:
    if total <= 0:
        return ""
    filled = round(width * count / total)
    return "█" * filled + "·" * (width - filled)


def _print_table(title: str, counter: Counter, *, top: int) -> None:
    total = sum(counter.values())
    print(f"\n{title}  (total calls: {total}, distinct: {len(counter)})")
    if not counter:
        print("  (none)")
        return
    width = max((len(k) for k, _ in counter.most_common(top)), default=4)
    for name, count in counter.most_common(top):
        pct = 100 * count / total if total else 0
        print(f"  {name:<{width}}  {count:>6}  {pct:5.1f}%  {_bar(count, total)}")


async def run(*, since_days: int | None, only: str, top: int) -> None:
    cutoff = None
    if since_days is not None:
        cutoff = datetime.now(timezone.utc) - timedelta(days=since_days)

    tools_by_mode: dict[str, Counter] = {"normal": Counter(), "coding": Counter()}
    skills_by_mode: dict[str, Counter] = {"normal": Counter(), "coding": Counter()}
    sessions_seen: Counter = Counter()

    async with async_session_factory() as s:
        # Map every session id → its mode (member sessions inherit the lead's
        # mode in practice, but we read each row's own mode and default sanely).
        modes = dict(
            (row.id, row.mode or "normal")
            for row in (await s.exec(select(ChatSession))).all()
        )

        stmt = select(SessionMessage).where(SessionMessage.tool_calls.is_not(None))
        if cutoff is not None:
            stmt = stmt.where(SessionMessage.created_at >= cutoff)

        for msg in (await s.exec(stmt)).all():
            mode = modes.get(msg.session_id, "normal")
            if mode not in tools_by_mode:
                mode = "normal"
            counted_here = False
            for name, raw_args in _iter_calls(msg.tool_calls):
                counted_here = True
                tools_by_mode[mode][name] += 1
                if name == "skill":
                    skill = _skill_name_from_args(raw_args) or "(unknown)"
                    skills_by_mode[mode][skill] += 1
            if counted_here:
                sessions_seen[mode] += 1

    scope = f"last {since_days}d" if since_days is not None else "all time"
    print(f"== Skill / tool usage analytics ({scope}) ==")
    print(
        f"messages with tool calls — normal: {sessions_seen['normal']}, coding: {sessions_seen['coding']}"
    )

    if only in ("tools", "both"):
        combined = tools_by_mode["normal"] + tools_by_mode["coding"]
        _print_table("TOOLS — all modes", combined, top=top)
        _print_table("TOOLS — coding mode only", tools_by_mode["coding"], top=top)

    if only in ("skills", "both"):
        combined = skills_by_mode["normal"] + skills_by_mode["coding"]
        _print_table("SKILLS — all modes", combined, top=top)
        _print_table("SKILLS — normal mode", skills_by_mode["normal"], top=top)
        _print_table("SKILLS — coding mode", skills_by_mode["coding"], top=top)

        present = set(combined)
        missing = sorted(_OP_SKILLS - present)
        if missing:
            print(f"\nOp-skills never invoked in this window: {', '.join(missing)}")


def main() -> None:
    args = _parse_args()
    asyncio.run(run(since_days=args.since_days, only=args.only, top=args.top))


if __name__ == "__main__":
    main()
