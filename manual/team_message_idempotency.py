"""Observe team LLM message windows across turns and verify cache idempotency.

Drives a real multi-agent, multi-turn team run (the default scenario forces the
lead to spawn a member and exchange messages with it), then after **every turn**
snapshots the exact window the agent loop feeds the provider —
``get_messages_for_llm(db, session_id)`` — for the lead and every member session.

It then checks the prompt-cache invariant that motivated this work:

    A turn's LLM window must be an APPEND-ONLY extension of the previous turn's
    window (turn N is a byte-identical prefix of turn N+1).

Anthropic/OpenAI prompt caching only reuses a cached *prefix*; if anything is
inserted or mutated mid-history the cache breaks from that point on. So for each
agent session we compute a per-message fingerprint and assert the prior window
is a strict prefix of the next one.

Legitimate exceptions are detected and reported as EXPECTED, not failures:
  * summarization — a summary row replaces the hidden tail (prefix is rewritten
    once); detected via the DB ``is_summary`` flag.

We also surface roster-change rows (``extra.roster_change``) to confirm roster
updates are delivered as APPENDED ``[system]`` history messages rather than by
mutating the (static) system prompt.

Prereqs: server running (``make run``). Uses the same DB as the server.

Usage:
  uv run python -m manual.team_message_idempotency
  uv run python -m manual.team_message_idempotency --session <LEAD_ID>
  uv run python -m manual.team_message_idempotency --messages "do X" "now do Y"
  uv run python -m manual.team_message_idempotency --wait 300
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import sys
import time
from dataclasses import dataclass
from uuid import UUID

import httpx
from sqlmodel import select

from app.agent.schemas.chat import (
    AssistantMessage,
    ChatMessage,
    ToolMessage,
)
from app.core.db import async_session_factory
from app.models.chat import ChatSession, SessionMessage
from app.services.chat_service import get_messages_for_llm

from manual._common import DEFAULT_BASE
BASE = DEFAULT_BASE

DEFAULT_MESSAGES = [
    "Spawn one explorer member and ask it to reply with exactly the word ALPHA. "
    "Report the explorer's exact reply back to me.",
    "Ask the same explorer to reply with exactly the word BETA, and report it.",
    "In one sentence, summarise what the explorer has told you so far.",
]


# ── Fingerprinting ──────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Fp:
    """Stable identity of one LLM-window message (order-sensitive)."""

    kind: str
    content_hash: str
    tool_calls: tuple[tuple[str, str], ...]
    tool_call_id: str | None

    def short(self) -> str:
        bits = [self.kind]
        if self.tool_calls:
            bits.append("calls=" + ",".join(n for _, n in self.tool_calls))
        if self.tool_call_id:
            bits.append(f"result_for={self.tool_call_id[:8]}")
        bits.append(self.content_hash[:8])
        return " ".join(bits)


def _hash(text: str | None) -> str:
    return hashlib.sha1((text or "").encode("utf-8", "replace")).hexdigest()


def fingerprint(msg: ChatMessage) -> Fp:
    kind = type(msg).__name__
    tool_calls: tuple[tuple[str, str], ...] = ()
    tool_call_id: str | None = None
    if isinstance(msg, AssistantMessage) and msg.tool_calls:
        tool_calls = tuple(
            (tc.id or "", tc.function.name or "") for tc in msg.tool_calls
        )
    if isinstance(msg, ToolMessage):
        tool_call_id = msg.tool_call_id
    return Fp(
        kind=kind,
        content_hash=_hash(getattr(msg, "content", None)),
        tool_calls=tool_calls,
        tool_call_id=tool_call_id,
    )


def preview(msg: ChatMessage, width: int = 72) -> str:
    content = (getattr(msg, "content", None) or "").replace("\n", " ")
    if isinstance(msg, AssistantMessage) and msg.tool_calls and not content:
        names = ", ".join(tc.function.name for tc in msg.tool_calls)
        content = f"<tool_call: {names}>"
    return content[:width]


# ── DB helpers ────────────────────────────────────────────────────────────────


async def member_sessions(lead_sid: UUID) -> dict[str, str]:
    """Return {session_id: agent_label} for the lead + all its member sessions."""
    async with async_session_factory() as s:
        rows = (
            await s.exec(
                select(ChatSession).where(
                    (ChatSession.id == lead_sid)
                    | (ChatSession.parent_session_id == lead_sid)
                )
            )
        ).all()
    out: dict[str, str] = {}
    for row in rows:
        tag = "lead" if str(row.id) == str(lead_sid) else (row.agent_name or "member")
        out[str(row.id)] = tag
    return out


async def summary_row_count(session_id: str) -> int:
    async with async_session_factory() as s:
        rows = (
            await s.exec(
                select(SessionMessage)
                .where(SessionMessage.session_id == UUID(session_id))
                .where(SessionMessage.is_summary)
            )
        ).all()
    return len(rows)


async def snapshot(lead_sid: UUID) -> dict[str, tuple[str, list[ChatMessage]]]:
    """Capture the exact LLM window for every agent session in this team.

    Returns ``{label: (full_session_id, messages)}``.
    """
    labels = await member_sessions(lead_sid)
    windows: dict[str, tuple[str, list[ChatMessage]]] = {}
    async with async_session_factory() as s:
        for session_id, tag in labels.items():
            msgs = await get_messages_for_llm(s, UUID(session_id))
            windows[f"{tag} ({session_id[:8]})"] = (session_id, msgs)
    return windows


# ── HTTP / SSE drive ───────────────────────────────────────────────────────────


def wait_done(base: str, sid: str, timeout: int) -> None:
    start = time.monotonic()
    with httpx.stream("GET", f"{base}/team/{sid}/stream", timeout=timeout + 5) as resp:
        resp.raise_for_status()
        for line in resp.iter_lines():
            if time.monotonic() - start > timeout:
                raise TimeoutError(f"timeout waiting for {sid}")
            if line.startswith("event:") and "done" in line:
                return


def send(base: str, message: str, sid: str | None, timeout: int) -> str:
    payload = {"message": message}
    if sid:
        payload["session_id"] = sid
    resp = httpx.post(f"{base}/team/chat", data=payload, timeout=30)
    resp.raise_for_status()
    sid = resp.json()["session_id"]
    wait_done(base, sid, timeout)
    return sid


# ── Idempotency check ───────────────────────────────────────────────────────


def common_prefix_len(a: list[Fp], b: list[Fp]) -> int:
    n = 0
    for x, y in zip(a, b):
        if x != y:
            break
        n += 1
    return n


def print_window(label: str, msgs: list[ChatMessage]) -> None:
    print(f"    {label}: {len(msgs)} messages")
    for i, m in enumerate(msgs):
        fp = fingerprint(m)
        print(f"      [{i:>2}] {fp.short():<46} | {preview(m)}")


async def run(base: str, messages: list[str], session: str | None, wait: int) -> int:
    sid = session
    # per-session-label → previous-turn window fingerprints
    prev_fps: dict[str, list[Fp]] = {}
    violations = 0

    for turn, message in enumerate(messages, start=1):
        print(f"\n{'=' * 78}\nTURN {turn}: {message}\n{'=' * 78}")
        t0 = time.monotonic()
        sid = send(base, message, sid, wait)
        dt = time.monotonic() - t0
        print(f"  session={sid}  done in {dt:.1f}s")

        windows = await snapshot(UUID(sid))

        for label, (full_sid, msgs) in windows.items():
            cur = [fingerprint(m) for m in msgs]
            print_window(label, msgs)

            if label not in prev_fps:
                prev_fps[label] = cur
                print(f"      → first snapshot for {label} (baseline)")
                continue

            prev = prev_fps[label]
            cpl = common_prefix_len(prev, cur)

            if cpl == len(prev) and len(cur) >= len(prev):
                grew = len(cur) - len(prev)
                print(
                    f"      → APPEND-ONLY ok: prior {len(prev)} msgs are an "
                    f"identical prefix; +{grew} appended"
                )
            else:
                # Diverged before the end of the previous window. Could be a
                # legitimate summarization rewrite, or a real cache-busting
                # mid-history mutation.
                summaries = await summary_row_count(full_sid)
                if summaries > 0:
                    print(
                        f"      → EXPECTED prefix reset: diverged at index {cpl} "
                        f"and session has {summaries} summary row(s) "
                        f"(compaction rewrites the prefix)"
                    )
                else:
                    violations += 1
                    print(
                        f"      → ✗ VIOLATION: prior window is NOT a prefix "
                        f"(diverged at index {cpl}, no summary row)."
                    )
                    if cpl < len(prev):
                        print(f"          prev[{cpl}] = {prev[cpl].short()}")
                    if cpl < len(cur):
                        print(f"          cur [{cpl}] = {cur[cpl].short()}")

            prev_fps[label] = cur

        # Roster-change rows: confirm roster is delivered as appended history,
        # never by mutating the system prompt.
        async with async_session_factory() as s:
            roster_rows = (
                await s.exec(
                    select(SessionMessage)
                    .where(SessionMessage.session_id == UUID(sid))
                    .order_by(SessionMessage.created_at)
                )
            ).all()
        roster = [r for r in roster_rows if (r.extra or {}).get("roster_change")]
        if roster:
            print(f"  roster-change markers in lead history: {len(roster)}")
            for r in roster:
                print(f"    [system msg] {(r.content or '')[:90]}")

    print(f"\n{'=' * 78}")
    if violations:
        print(f"RESULT: ✗ {violations} cache-idempotency violation(s) detected")
        return 1
    print("RESULT: ✓ all LLM windows were append-only across turns")
    print(f"\nInspect further:\n  uv run python -m manual.team_timeline {sid} --full")
    return 0


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--base", default=BASE)
    p.add_argument("--session", help="Existing lead session id to continue")
    p.add_argument(
        "--messages",
        nargs="+",
        default=DEFAULT_MESSAGES,
        help="Override the turn-by-turn messages",
    )
    p.add_argument("--wait", type=int, default=300, help="Per-turn done timeout (s)")
    args = p.parse_args()
    code = asyncio.run(
        run(args.base.rstrip("/"), args.messages, args.session, args.wait)
    )
    sys.exit(code)


if __name__ == "__main__":
    main()
