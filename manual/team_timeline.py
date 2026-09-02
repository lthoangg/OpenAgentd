"""Print a chronological timeline of all messages in an agent session.

Shows timestamps, role, and message detail.

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
    from app.core.db import async_session_factory
    from app.models.chat import ChatSession, SessionMessage

    trunc = None if full else 100
    sid = UUID(session_id)

    async with async_session_factory() as s:
        result = await s.exec(select(ChatSession).where(ChatSession.id == sid))
        sess = result.first()
        if not sess:
            print(f"No session found: {session_id}")
            return

        agent = sess.agent_name or "openagentd"
        print(f"  {sess.id}  {agent} [session]")

        result2 = await s.exec(
            select(SessionMessage)
            .where(SessionMessage.session_id == sid)
            .order_by(SessionMessage.created_at)
        )
        msgs = result2.all()

    print(f"\n{'timestamp':26s}  {'role':8s}  detail")
    print("-" * 90)

    for m in msgs:
        ts = str(m.created_at)[:23] if m.created_at else "?"

        if m.tool_calls:
            for tc in m.tool_calls:
                fn = tc.get("function", {})
                name = fn.get("name", "?")
                args = fn.get("arguments") or ""
                if trunc:
                    args = args[:trunc]
                print(f"{ts:26s}  [asst  ]  CALL {name}({args})")

        elif m.tool_call_id:
            content = m.content or ""
            if trunc:
                content = content[:trunc]
            print(f"{ts:26s}  [tool  ]  RESULT {content}")

        else:
            content = m.content or ""
            if trunc:
                content = content[:trunc]
            kind_tag = f" [{m.kind}]" if m.kind != "chat" else ""
            pin_tag = " [pin]" if getattr(m, "pinned", False) else ""
            print(f"{ts:26s}  [{m.role:6s}]{kind_tag}{pin_tag}  {content}")

    print(f"\n{len(msgs)} messages total")


def main() -> None:
    p = argparse.ArgumentParser(description="Timeline of all messages in a session")
    add_env_argument(p)
    p.add_argument("session_id", help="Session ID")
    p.add_argument("--full", action="store_true", help="Don't truncate message content")
    args = p.parse_args()
    apply_env_override(args)
    asyncio.run(run(args.session_id, full=args.full))


if __name__ == "__main__":
    main()
