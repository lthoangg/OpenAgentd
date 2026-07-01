"""Smoke-test the member open-task nudge safety net.

This drives a live team turn that asks the lead to create and assign a todo to a
member, then asks that member to incorrectly reply in plain text instead of using
``team_message``. The smoke passes when the member receives the hidden
``[system]: You still have open assigned task(s)`` reminder that was added to
catch silent task drop-off.

Usage:
  uv run python -m manual.team_open_task_nudge --direct
  uv run python -m manual.team_open_task_nudge
  uv run python -m manual.team_open_task_nudge --session ID
  uv run python -m manual.team_open_task_nudge --wait 180
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import tempfile
import time
from collections import Counter
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from uuid import UUID, uuid7

import httpx
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession

from app.agent.agent_loop import Agent
from app.agent.mode.team.mailbox import Message
from app.agent.mode.team.member import TeamLead, TeamMember
from app.agent.mode.team.team import AgentTeam
from app.agent.providers.base import LLMProviderBase
from app.agent.schemas.chat import (
    AssistantMessage,
    ChatCompletionChunk,
    ChatCompletionChunkChoice,
    ChatCompletionDelta,
    ChatMessage,
    ToolCallDelta,
)
from app.core import db as app_db
from app.models.chat import ChatSession

from manual._common import DEFAULT_BASE
BASE = DEFAULT_BASE
DEFAULT_WAIT = 180
DEFAULT_MESSAGE = """\
Reliability smoke test for team communication.

Please do exactly this:
1. Create one todo assigned to a spawned executor instance. The todo content must contain the marker OPEN_TASK_NUDGE_SMOKE.
2. Spawn the executor if needed.
3. Send the executor this exact instruction: Claim the todo, then intentionally reply in plain text with the sentence 'I am incorrectly stopping without team_message' and do not call team_message, do not mark the todo completed, and do not use <sleep>.
4. Do not complete the todo yourself. Wait for the executor to report back.
"""


class DirectNudgeProvider(LLMProviderBase):
    """Deterministic provider for the no-server direct smoke path."""

    model = "manual-direct"

    def __init__(self) -> None:
        super().__init__()
        self.call_count = 0
        self.claimed = False
        self.reported = False

    def stream(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **_kwargs: Any,
    ):
        self.call_count += 1
        content = _last_human_content(messages)
        if "Claim this todo" in content and not self.claimed:
            self.claimed = True
            chunk = _tool_chunk(
                "todo_manage",
                "direct_claim",
                '{"actions":[{"action":"claim","task_id":"task_1"}]}',
            )
        elif "You still have open assigned task" in content and not self.reported:
            self.reported = True
            chunk = _tool_chunk(
                "team_message",
                "direct_report",
                '{"to":["lead"],"content":"Nudge received for task_1; reporting back instead of stopping silently."}',
            )
        else:
            chunk = _text_chunk("I am incorrectly stopping without team_message")

        async def _gen():
            yield chunk

        return _gen()

    async def chat(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **_kwargs: Any,
    ) -> AssistantMessage:
        return AssistantMessage(content="direct")


def _last_human_content(messages: list[ChatMessage]) -> str:
    for message in reversed(messages):
        if getattr(message, "role", None) == "user":
            return message.content or ""
    return ""


def _text_chunk(text: str) -> ChatCompletionChunk:
    return ChatCompletionChunk(
        id="direct-text",
        created=1,
        model="manual-direct",
        choices=[
            ChatCompletionChunkChoice(
                index=0,
                delta=ChatCompletionDelta(content=text),
                finish_reason="stop",
            )
        ],
    )


def _tool_chunk(name: str, tool_id: str, arguments: str) -> ChatCompletionChunk:
    return ChatCompletionChunk(
        id=tool_id,
        created=1,
        model="manual-direct",
        choices=[
            ChatCompletionChunkChoice(
                index=0,
                delta=ChatCompletionDelta(
                    tool_calls=[
                        ToolCallDelta(
                            index=0,
                            id=tool_id,
                            function={"name": name, "arguments": arguments},
                        )
                    ]
                ),
                finish_reason="tool_calls",
            )
        ],
    )


@asynccontextmanager
async def _temporary_db(tmpdir: Path):
    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmpdir / 'manual-open-task-nudge.sqlite'}",
        connect_args={"check_same_thread": False},
    )
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    original_engine = app_db.engine
    original_factory = app_db.async_session_factory
    app_db.engine = engine
    app_db.async_session_factory = factory
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
    try:
        yield factory
    finally:
        app_db.engine = original_engine
        app_db.async_session_factory = original_factory
        await engine.dispose()


async def run_direct() -> int:
    """Run a deterministic no-server smoke test against AgentTeam directly."""
    from app.core.config import settings

    with tempfile.TemporaryDirectory(prefix="openagentd-nudge-") as raw_tmp:
        tmpdir = Path(raw_tmp)
        original_data_dir = settings.OPENAGENTD_DATA_DIR
        settings.OPENAGENTD_DATA_DIR = str(tmpdir / "data")
        try:
            async with _temporary_db(tmpdir) as db_factory:
                lead_session_id = str(uuid7())
                worker_session_id = str(uuid7())
                lead = TeamLead(
                    Agent(name="lead", llm_provider=DirectNudgeProvider()),
                    session_id=lead_session_id,
                    db_factory=db_factory,
                )
                worker = TeamMember(
                    Agent(name="worker#1", llm_provider=DirectNudgeProvider()),
                    session_id=worker_session_id,
                    db_factory=db_factory,
                )
                team = AgentTeam(lead=lead, members={"worker#1": worker})
                await team.start()
                try:
                    async with db_factory() as db:
                        db.add(ChatSession(id=UUID(lead_session_id), agent_name="lead"))
                        db.add(
                            ChatSession(
                                id=UUID(worker_session_id),
                                parent_session_id=UUID(lead_session_id),
                                agent_name="worker#1",
                            )
                        )
                        await db.commit()

                    todo_path = (
                        tmpdir / "data" / "sessions" / lead_session_id / ".todos.json"
                    )
                    todo_path.parent.mkdir(parents=True)
                    todo_path.write_text(
                        json.dumps(
                            {
                                "counter": 1,
                                "items": [
                                    {
                                        "task_id": "task_1",
                                        "content": "OPEN_TASK_NUDGE_SMOKE direct todo",
                                        "status": "pending",
                                        "priority": "high",
                                        "dependencies": [],
                                        "assigned_to": "worker#1",
                                        "claimed_by": None,
                                    }
                                ],
                            }
                        ),
                        encoding="utf-8",
                    )

                    await team.mailbox.send(
                        to="worker#1",
                        message=Message(
                            from_agent="lead",
                            to_agent="worker#1",
                            content="[lead]: Claim this todo: task_1. Then stop incorrectly without team_message.",
                        ),
                    )
                    deadline = time.monotonic() + 20
                    while time.monotonic() < deadline:
                        if worker.state == "idle" and lead.state == "idle":
                            if worker.agent.llm_provider.call_count >= 3:
                                break
                        await asyncio.sleep(0.05)

                    provider = worker.agent.llm_provider
                    todos = json.loads(todo_path.read_text(encoding="utf-8"))["items"]
                    print_todos(todos)
                    print(f"\nworker model calls: {provider.call_count}")
                    if provider.call_count < 3:
                        print(
                            "\nFAILED: worker was not reactivated by the open-task nudge"
                        )
                        return 1
                    if todos[0].get("status") != "in_progress":
                        print("\nFAILED: todo was not left open/in_progress")
                        return 1
                    print(
                        "\nPASSED: direct member received an open-task nudge and reported back."
                    )
                    return 0
                finally:
                    await team.stop()
        finally:
            settings.OPENAGENTD_DATA_DIR = original_data_dir


def post_message(base: str, message: str, session_id: str | None) -> str:
    payload: dict[str, str] = {"message": message}
    if session_id:
        payload["session_id"] = session_id
    resp = httpx.post(f"{base}/team/chat", data=payload, timeout=30)
    resp.raise_for_status()
    sid = resp.json()["session_id"]
    print(f"session: {sid}")
    return sid


def stream_until_done(
    base: str, sid: str, timeout: int
) -> tuple[list[dict[str, Any]], Counter]:
    events: list[dict[str, Any]] = []
    counts: Counter = Counter()
    start = time.monotonic()
    print(f"streaming (max {timeout}s)...")

    try:
        with httpx.stream(
            "GET", f"{base}/team/{sid}/stream", timeout=timeout + 5
        ) as resp:
            resp.raise_for_status()
            event_name = "message"
            data_buf: list[str] = []
            for line in resp.iter_lines():
                if time.monotonic() - start > timeout:
                    print("timeout")
                    break
                if line.startswith("event:"):
                    event_name = line[6:].strip()
                elif line.startswith("data:"):
                    data_buf.append(line[5:].strip())
                elif line == "":
                    if not data_buf:
                        continue
                    raw = "\n".join(data_buf)
                    data_buf = []
                    try:
                        data = json.loads(raw)
                    except json.JSONDecodeError:
                        data = {"_raw": raw}
                    counts[event_name] += 1
                    events.append({"event": event_name, "data": data})
                    _print_event(event_name, data, time.monotonic() - start)
                    if event_name == "done":
                        break
    except httpx.ReadTimeout:
        print("read timeout")

    return events, counts


def _print_event(event_name: str, data: dict[str, Any], elapsed: float) -> None:
    agent = data.get("agent") or data.get("metadata", {}).get("agent") or "-"
    if event_name == "inbox":
        content = str(data.get("content") or "").replace("\n", " ")
        print(
            f"{elapsed:6.2f}s inbox        {agent} <- {data.get('from_agent')}: "
            f"{content[:140]}"
        )
    elif event_name == "tool_call":
        print(f"{elapsed:6.2f}s tool_call    {agent} -> {data.get('name')}")
    elif event_name == "agent_status":
        print(f"{elapsed:6.2f}s status       {agent} -> {data.get('status')}")
    elif event_name == "message":
        text = str(data.get("text") or "").replace("\n", " ")
        print(f"{elapsed:6.2f}s message      {agent}: {text[:120]}")
    elif event_name == "done":
        print(f"{elapsed:6.2f}s done")


def fetch_todos(base: str, sid: str) -> list[dict[str, Any]]:
    resp = httpx.get(f"{base}/team/sessions/{sid}/todos", timeout=30)
    resp.raise_for_status()
    todos = resp.json().get("todos", [])
    return [todo for todo in todos if isinstance(todo, dict)]


def validate(events: list[dict[str, Any]], todos: list[dict[str, Any]]) -> list[str]:
    issues: list[str] = []
    marker_todos = [
        todo for todo in todos if "OPEN_TASK_NUDGE_SMOKE" in str(todo.get("content"))
    ]
    if not marker_todos:
        issues.append("no todo with marker OPEN_TASK_NUDGE_SMOKE found")
    elif not any(todo.get("status") == "in_progress" for todo in marker_todos):
        issues.append("marker todo was not left in_progress")

    nudge_inboxes = [
        event
        for event in events
        if event["event"] == "inbox"
        and event["data"].get("from_agent") == "system"
        and "You still have open assigned task" in str(event["data"].get("content"))
    ]
    if not nudge_inboxes:
        issues.append("no system open-task nudge inbox event observed")

    if not any(
        event["event"] == "tool_call" and event["data"].get("name") == "todo_manage"
        for event in events
    ):
        issues.append("no todo_manage tool call observed")

    return issues


def print_todos(todos: list[dict[str, Any]]) -> None:
    print("\ntodos:")
    for todo in todos:
        print(
            f"  {todo.get('task_id')} [{todo.get('status')}] "
            f"assigned={todo.get('assigned_to')} claimed={todo.get('claimed_by')} "
            f"{todo.get('content')}"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="Smoke-test member open-task nudge")
    parser.add_argument(
        "--direct",
        action="store_true",
        help="Run deterministic no-server smoke against AgentTeam directly",
    )
    parser.add_argument("--base", default=BASE)
    parser.add_argument("--session", default=None, help="Resume an existing session")
    parser.add_argument("--wait", type=int, default=DEFAULT_WAIT)
    parser.add_argument("--message", default=DEFAULT_MESSAGE)
    args = parser.parse_args()
    if args.direct:
        raise SystemExit(asyncio.run(run_direct()))

    base = args.base.rstrip("/")

    sid = post_message(base, args.message, args.session)
    events, counts = stream_until_done(base, sid, args.wait)
    todos = fetch_todos(base, sid)
    print_todos(todos)

    print("\nevent counts:")
    for name, count in sorted(counts.items()):
        print(f"  {name}: {count}")

    issues = validate(events, todos)
    if issues:
        print("\nFAILED:")
        for issue in issues:
            print(f"  - {issue}")
        sys.exit(1)

    print("\nPASSED: member received an open-task nudge.")


if __name__ == "__main__":
    main()
