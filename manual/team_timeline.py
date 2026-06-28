"""Print a chronological timeline of all messages across a team session.

Shows timestamps, agent, role, and message detail so you can trace the
exact order of tool calls, inbox deliveries, and responses.

Usage:
  uv run python -m manual.team_timeline SESSION_ID
  uv run python -m manual.team_timeline SESSION_ID --full        # no content truncation
  uv run python -m manual.team_timeline SESSION_ID --env production
"""

from __future__ import annotations

import argparse
import asyncio
from uuid import UUID

from sqlmodel import select

from manual._common import add_env_argument, apply_env_override


async def run(session_id: str, *, full: bool = False) -> None:
    """Print the chronological timeline across lead + member sessions.

    Uses the shared ``async_session_factory`` so the script honours the same
    XDG-based DB layout, pool sizing, and pragmas as the running server —
    no separate engine, no leaked connections.
    """
    # Lazy import so APP_ENV is already in os.environ before settings loads.
    from app.core.db import async_session_factory
    from app.models.chat import ChatSession, SessionMessage

    trunc = None if full else 100
    sid = UUID(session_id)

    async with async_session_factory() as s:
        # Resolve lead + all sub-sessions
        result = await s.exec(
            select(ChatSession).where(
                (ChatSession.id == sid) | (ChatSession.parent_session_id == sid)
            )
        )
        sessions = result.all()
        if not sessions:
            print(f"No session found: {session_id}")
            return

        sid_to_agent: dict[str, str] = {}
        for sess in sessions:
            label = sess.agent_name or "unknown"
            sid_to_agent[sess.id] = label
            role_tag = "[lead]" if sess.id == sid else "[member]"
            print(f"  {sess.id}  {label} {role_tag}")

        # Fetch all messages ordered by created_at
        all_sids = list(sid_to_agent.keys())
        result2 = await s.exec(
            select(SessionMessage)
            .where(SessionMessage.session_id.in_(all_sids))
            .order_by(SessionMessage.created_at)
        )
        msgs = result2.all()

    print(f"\n{'timestamp':26s}  {'agent':16s}  {'role':8s}  detail")
    print("-" * 110)

    for m in msgs:
        agent = sid_to_agent.get(m.session_id, "?")
        ts = str(m.created_at)[:23] if m.created_at else "?"

        if m.tool_calls:
            for tc in m.tool_calls:
                fn = tc.get("function", {})
                name = fn.get("name", "?")
                args = fn.get("arguments") or ""
                if trunc:
                    args = args[:trunc]
                print(f"{ts:26s}  {agent:16s}  [asst  ]  CALL {name}({args})")

        elif m.tool_call_id:
            content = m.content or ""
            if trunc:
                content = content[:trunc]
            print(f"{ts:26s}  {agent:16s}  [tool  ]  RESULT {content}")

        else:
            content = m.content or ""
            if trunc:
                content = content[:trunc]
            extra = m.extra or {}
            from_agents = extra.get("from_agents") or (
                [extra["from_agent"]] if extra.get("from_agent") else []
            )
            tag = f" [inbox from={','.join(from_agents)}]" if from_agents else ""
            sum_tag = " [SUMMARY]" if m.is_summary else ""
            ctx_tag = " [excl]" if m.exclude_from_context else ""
            print(
                f"{ts:26s}  {agent:16s}  [{m.role:6s}]{tag}{sum_tag}{ctx_tag}  {content}"
            )

    print(f"\n{len(msgs)} messages total")


def main() -> None:
    p = argparse.ArgumentParser(
        description="Timeline of all messages in a team session"
    )
    add_env_argument(p)
    p.add_argument("session_id", help="Lead session ID")
    p.add_argument("--full", action="store_true", help="Don't truncate message content")
    args = p.parse_args()
    apply_env_override(args)  # must run before asyncio.run() triggers app imports
    asyncio.run(run(args.session_id, full=args.full))


if __name__ == "__main__":
    main()
