"""Tests for single-agent session runtime."""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession

from app.agent.agent_loop import Agent
from app.agent.providers.base import LLMProviderBase
from app.agent.schemas.chat import (
    AssistantMessage,
    ChatCompletionChunk,
    ChatCompletionChunkChoice,
    ChatCompletionDelta,
    ChatMessage,
)
from app.agent.session import AgentSession
from tests.agent.test_agent_run import make_text_chunk, make_tool_chunk

ASK_USER_ARGS = (
    '{"questions": [{"question": "Which one?", "header": "Pick", '
    '"options": [{"label": "a"}, {"label": "b"}]}]}'
)


class ScriptedProvider(LLMProviderBase):
    """Replays one pre-built chunk list per ``stream()`` call, in order."""

    def __init__(self, scripts: list[list[ChatCompletionChunk]]) -> None:
        super().__init__()
        self.scripts = scripts
        self.stream_call_count = 0

    async def stream(
        self, messages: list[ChatMessage], **kwargs: Any
    ) -> AsyncIterator[ChatCompletionChunk]:
        idx = min(self.stream_call_count, len(self.scripts) - 1)
        self.stream_call_count += 1
        for chunk in self.scripts[idx]:
            yield chunk

    async def complete(
        self, messages: list[ChatMessage], **kwargs: Any
    ) -> AssistantMessage:
        return AssistantMessage(content="mock")

    async def chat(
        self, messages: list[ChatMessage], **kwargs: Any
    ) -> AssistantMessage:
        return await self.complete(messages, **kwargs)


class MockProvider(LLMProviderBase):
    def __init__(self, responses: list[str] | None = None) -> None:
        super().__init__()
        self.responses = responses or ["Hello from agent!"]
        self.call_count = 0
        self.stream_call_count = 0
        self.complete_call_count = 0

    async def stream(
        self,
        messages: list[ChatMessage],
        **kwargs: Any,
    ) -> AsyncIterator[ChatCompletionChunk]:
        idx = min(self.call_count, len(self.responses) - 1)
        self.call_count += 1
        self.stream_call_count += 1
        text = self.responses[idx]
        yield ChatCompletionChunk(
            id=f"chk_{self.call_count}",
            created=1234567890,
            model="mock",
            choices=[
                ChatCompletionChunkChoice(
                    index=0,
                    delta=ChatCompletionDelta(content=text, role="assistant"),
                    finish_reason="stop",
                )
            ],
        )

    async def complete(
        self,
        messages: list[ChatMessage],
        **kwargs: Any,
    ) -> AssistantMessage:
        idx = min(self.call_count, len(self.responses) - 1)
        self.call_count += 1
        self.complete_call_count += 1
        return AssistantMessage(content=self.responses[idx])

    async def chat(
        self,
        messages: list[ChatMessage],
        **kwargs: Any,
    ) -> AssistantMessage:
        return await self.complete(messages, **kwargs)


@pytest_asyncio.fixture
async def db_factory(tmp_path: Path):
    db_path = tmp_path / "test.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{db_path}")
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    yield factory
    await engine.dispose()


@pytest.mark.asyncio
async def test_agent_session_handle_user_message(db_factory, tmp_path):
    provider = MockProvider(["I am OpenAgentd."])
    agent = Agent(
        llm_provider=provider,
        name="openagentd",
        system_prompt="You are OpenAgentd.",
    )
    session = AgentSession(
        agent=agent,
        workspace=str(tmp_path),
        db_factory=db_factory,
    )

    sid = str(uuid.uuid4())
    session_id, message_id = await session.handle_user_message(
        content="Hello agent!",
        session_id=sid,
        workspace=str(tmp_path),
    )

    assert session_id == sid
    assert message_id

    # Wait for turn to complete
    if session._active_task:
        await session._active_task

    assert session.state == "idle"
    assert provider.call_count >= 1


@pytest.mark.asyncio
async def test_agent_session_stop(db_factory, tmp_path):
    provider = MockProvider()
    agent = Agent(
        llm_provider=provider,
        name="openagentd",
    )
    session = AgentSession(
        agent=agent,
        workspace=str(tmp_path),
        db_factory=db_factory,
    )

    sid = str(uuid.uuid4())
    await session.attach_to_session(sid)
    session.state = "working"
    stopped = await session.handle_stop()
    assert stopped is True
    assert session.state == "idle"


@pytest.mark.asyncio
async def test_agent_session_uses_runtime_model_override(db_factory, tmp_path):
    default_provider = MockProvider(["From default model A"])
    override_provider = MockProvider(["From override model B"])

    def mock_factory(model_id: str | None, model_kwargs: dict[str, Any] | None = None):
        if model_id == "custom:model-b":
            return override_provider
        return default_provider

    agent = Agent(
        llm_provider=default_provider,
        name="openagentd",
        model_id="default:model-a",
        system_prompt="You are OpenAgentd.",
    )
    session = AgentSession(
        agent=agent,
        workspace=str(tmp_path),
        db_factory=db_factory,
        provider_factory=mock_factory,
    )

    sid = str(uuid.uuid4())
    await session.handle_user_message(
        content="Use model B please",
        session_id=sid,
        workspace=str(tmp_path),
        model="custom:model-b",
        model_provided=True,
    )

    if session._active_task:
        await session._active_task

    assert default_provider.call_count == 0
    assert override_provider.call_count >= 1


@pytest.mark.asyncio
async def test_agent_session_uses_runtime_thinking_level_override(db_factory, tmp_path):
    default_provider = MockProvider(["Default response"])
    override_provider = MockProvider(["Reasoning response"])
    created_kwargs = {}

    def mock_factory(model_id: str | None, model_kwargs: dict[str, Any] | None = None):
        nonlocal created_kwargs
        created_kwargs = model_kwargs or {}
        return override_provider

    agent = Agent(
        llm_provider=default_provider,
        name="openagentd",
        model_id="default:model-a",
        system_prompt="You are OpenAgentd.",
    )
    session = AgentSession(
        agent=agent,
        workspace=str(tmp_path),
        db_factory=db_factory,
        provider_factory=mock_factory,
    )

    sid = str(uuid.uuid4())
    await session.handle_user_message(
        content="Think deeply",
        session_id=sid,
        workspace=str(tmp_path),
        thinking_level="high",
        thinking_level_provided=True,
    )

    if session._active_task:
        await session._active_task

    assert created_kwargs == {"thinking_level": "high"}
    assert default_provider.call_count == 0
    assert override_provider.call_count >= 1


@pytest.mark.asyncio
async def test_agent_session_streams_events_to_stream_store(db_factory, tmp_path):
    from app.services import memory_stream_store as stream_store

    provider = MockProvider(["Streaming chunk 1", "Streaming chunk 2"])
    agent = Agent(
        llm_provider=provider,
        name="openagentd",
        system_prompt="You are OpenAgentd.",
    )
    session = AgentSession(
        agent=agent,
        workspace=str(tmp_path),
        db_factory=db_factory,
    )

    sid = str(uuid.uuid4())
    await session.attach_to_session(sid)
    await stream_store.init_turn(sid)

    events = []

    async def consume_stream():
        async for event in stream_store.attach(sid):
            events.append(event)

    consumer = asyncio.create_task(consume_stream())
    await asyncio.sleep(0.01)

    await session.handle_user_message(
        content="Hello stream!",
        session_id=sid,
        workspace=str(tmp_path),
    )

    if session._active_task:
        await session._active_task

    await consumer

    event_types = [e.get("event") for e in events]
    assert "agent_status" in event_types
    assert "message" in event_types
    assert "done" in event_types


@pytest.mark.asyncio
async def test_agent_session_activates_queued_message_on_idle(db_factory, tmp_path):
    from app.services.chat_service import save_queued_user_message

    provider = MockProvider(["Response 1", "Response 2"])
    provider.support_interrupt = False
    agent = Agent(
        llm_provider=provider,
        name="openagentd",
        system_prompt="You are OpenAgentd.",
    )
    session = AgentSession(
        agent=agent,
        workspace=str(tmp_path),
        db_factory=db_factory,
    )

    sid = str(uuid.uuid4())
    sess_uuid = uuid.UUID(sid)
    await session.attach_to_session(sid)

    # Start turn 1
    await session.handle_user_message(
        content="Message 1",
        session_id=sid,
        workspace=str(tmp_path),
    )

    # Save a queued message while turn 1 is active
    async with db_factory() as db:
        await save_queued_user_message(db, sess_uuid, "Message 2 (queued)")
        await db.commit()

    # Wait for turn 1 to complete and activate turn 2
    if session._active_task:
        await session._active_task

    # Wait for any follow-up task activated from queue
    for _ in range(50):
        if session._active_task and not session._active_task.done():
            await session._active_task
            break
        await asyncio.sleep(0.01)

    assert provider.stream_call_count == 2


@pytest.mark.asyncio
async def test_agent_session_continuous_stream_across_queued_turns(
    db_factory, tmp_path
):
    from app.services import memory_stream_store as stream_store
    from app.services.chat_service import save_queued_user_message

    provider = MockProvider(["Response 1", "Response 2"])
    provider.support_interrupt = False
    agent = Agent(
        llm_provider=provider,
        name="openagentd",
        system_prompt="You are OpenAgentd.",
    )
    session = AgentSession(
        agent=agent,
        workspace=str(tmp_path),
        db_factory=db_factory,
    )

    sid = str(uuid.uuid4())
    sess_uuid = uuid.UUID(sid)
    await session.attach_to_session(sid)
    await stream_store.init_turn(sid)

    events = []

    async def consume_stream():
        async for event in stream_store.attach(sid):
            events.append(event)

    consumer = asyncio.create_task(consume_stream())
    await asyncio.sleep(0.01)

    await session.handle_user_message(
        content="Message 1",
        session_id=sid,
        workspace=str(tmp_path),
    )

    async with db_factory() as db:
        await save_queued_user_message(db, sess_uuid, "Message 2 (queued)")
        await db.commit()

    if session._active_task:
        await session._active_task

    for _ in range(50):
        if session._active_task and not session._active_task.done():
            await session._active_task
            break
        await asyncio.sleep(0.01)

    await consumer

    event_types = [e.get("event") for e in events]
    assert "queued_turn_start" in event_types
    assert "done" in event_types
    messages = [e for e in events if e.get("event") == "message"]
    assert len(messages) >= 2


@pytest.mark.asyncio
async def test_agent_session_parks_in_waiting_input_on_ask_user(db_factory, tmp_path):
    """``ask_user`` suspends the turn — it must not end it.

    The loop reports the suspension through ``config.metadata`` rather than
    raising, so the session has to read it from there. If it does not, the turn
    is closed like any other (``idle`` + ``done`` + ``mark_done``): every SSE
    subscriber is unblocked and disconnects, and the resumed turn after the
    answer streams into a stream nobody is attached to.
    """
    from app.services import memory_stream_store as stream_store

    provider = ScriptedProvider(
        [
            [make_tool_chunk("ask_user", "call_ask_1", ASK_USER_ARGS)],
            [make_text_chunk("Resumed after the answer.")],
        ]
    )
    agent = Agent(
        llm_provider=provider,
        name="openagentd",
        system_prompt="You are OpenAgentd.",
    )
    session = AgentSession(
        agent=agent,
        workspace=str(tmp_path),
        db_factory=db_factory,
    )

    sid = str(uuid.uuid4())
    await session.attach_to_session(sid)
    await stream_store.init_turn(sid)

    events: list[dict] = []

    async def consume_stream():
        async for event in stream_store.attach(sid):
            events.append(event)

    consumer = asyncio.create_task(consume_stream())
    await asyncio.sleep(0.01)

    await session.handle_user_message(
        content="Do the thing",
        session_id=sid,
        workspace=str(tmp_path),
    )
    assert session._active_task is not None
    await session._active_task

    # Parked, not finished: the subscriber is still attached and the stream is
    # still open, so the answer can resume into the same connection.
    assert session.state == "waiting_input"
    assert session.is_awaiting_question_answer()
    assert session._question_suspended is not None
    assert not consumer.done()
    statuses = [e for e in events if e.get("event") == "agent_status"]
    assert any('"waiting_input"' in e["data"] for e in statuses)
    assert "done" not in [e.get("event") for e in events]
    assert sid in stream_store.running_session_ids()

    # The answer restarts the turn and the still-attached subscriber sees it.
    await session.handle_question_answer(
        session._question_suspended["question_id"], [["a"]]
    )
    assert session._active_task is not None
    await session._active_task
    await asyncio.wait_for(consumer, timeout=2)

    assert session.state == "idle"
    assert provider.stream_call_count == 2
    event_types = [e.get("event") for e in events]
    assert "message" in event_types
    assert event_types[-1] == "done"


async def test_agent_session_supports_multi_question_turns(db_factory, tmp_path):
    """Turns support multiple ask_user suspensions and resumes."""
    from app.services import memory_stream_store as stream_store

    provider = ScriptedProvider(
        [
            [make_tool_chunk("ask_user", "call_ask_1", ASK_USER_ARGS)],
            [make_tool_chunk("ask_user", "call_ask_2", ASK_USER_ARGS)],
            [make_text_chunk("Resumed after both questions.")],
        ]
    )
    agent = Agent(
        llm_provider=provider,
        name="openagentd",
        system_prompt="You are OpenAgentd.",
    )
    session = AgentSession(
        agent=agent,
        workspace=str(tmp_path),
        db_factory=db_factory,
    )

    sid = str(uuid.uuid4())
    await session.attach_to_session(sid)
    await stream_store.init_turn(sid)

    events: list[dict] = []

    async def consume_stream():
        async for event in stream_store.attach(sid):
            events.append(event)

    consumer = asyncio.create_task(consume_stream())
    await asyncio.sleep(0.01)

    await session.handle_user_message(
        content="Do the thing",
        session_id=sid,
        workspace=str(tmp_path),
    )
    assert session._active_task is not None
    await session._active_task

    # First suspension
    assert session.state == "waiting_input"
    assert session.is_awaiting_question_answer()
    assert session._question_suspended is not None
    q1_id = session._question_suspended["question_id"]

    # Answer first question -> restarts turn and asks second question
    await session.handle_question_answer(q1_id, [["a"]])
    assert session._active_task is not None
    await session._active_task

    # Second suspension
    assert session.state == "waiting_input"
    assert session.is_awaiting_question_answer()
    assert session._question_suspended is not None
    q2_id = session._question_suspended["question_id"]
    assert q2_id != q1_id

    # Answer second question -> restarts turn and completes
    await session.handle_question_answer(q2_id, [["b"]])
    assert session._active_task is not None
    await session._active_task
    await asyncio.wait_for(consumer, timeout=2)

    assert session.state == "idle"
    assert provider.stream_call_count == 3
    event_types = [e.get("event") for e in events]
    assert "message" in event_types
    assert event_types[-1] == "done"


async def test_agent_session_allows_ask_user_after_queued_message_injected(
    db_factory, tmp_path
):
    """When a queued message is injected into a resumed turn, ask_user is allowed."""
    from app.services import memory_stream_store as stream_store
    from app.services.chat_service import save_queued_user_message

    provider = ScriptedProvider(
        [
            [make_tool_chunk("ask_user", "call_ask_1", ASK_USER_ARGS)],
            [make_tool_chunk("ask_user", "call_ask_2", ASK_USER_ARGS)],
            [make_text_chunk("Done after queued message and question.")],
        ]
    )
    agent = Agent(
        llm_provider=provider,
        name="openagentd",
        system_prompt="You are OpenAgentd.",
    )
    session = AgentSession(
        agent=agent,
        workspace=str(tmp_path),
        db_factory=db_factory,
    )

    sid = str(uuid.uuid4())
    sess_uuid = uuid.UUID(sid)
    await session.attach_to_session(sid)
    await stream_store.init_turn(sid)

    await session.handle_user_message(
        content="First instruction",
        session_id=sid,
        workspace=str(tmp_path),
    )
    assert session._active_task is not None
    await session._active_task

    assert session.state == "waiting_input"
    q1_id = session._question_suspended["question_id"]

    # Queue a user message while the session was suspended or resuming
    async with db_factory() as db:
        await save_queued_user_message(db, sess_uuid, "Queued instruction")
        await db.commit()

    # Answer the first question -> resumed turn pops the queued message and asks again
    await session.handle_question_answer(q1_id, [["a"]])
    assert session._active_task is not None
    await session._active_task

    # Should suspend on the second question, NOT refuse with ASK_BUDGET_EXHAUSTED
    assert session.state == "waiting_input"
    assert session._question_suspended is not None
    q2_id = session._question_suspended["question_id"]
    assert q2_id != q1_id

    # Answer second question
    await session.handle_question_answer(q2_id, [["b"]])
    assert session._active_task is not None
    await session._active_task

    assert session.state == "idle"
    assert provider.stream_call_count == 3


class FailingProvider(LLMProviderBase):
    """Every call fails the way a dead upstream does."""

    async def stream(
        self, messages: list[ChatMessage], **kwargs: Any
    ) -> AsyncIterator[ChatCompletionChunk]:
        raise RuntimeError("upstream exploded")
        yield  # pragma: no cover — makes this an async generator

    async def complete(
        self, messages: list[ChatMessage], **kwargs: Any
    ) -> AssistantMessage:
        raise RuntimeError("upstream exploded")

    async def chat(
        self, messages: list[ChatMessage], **kwargs: Any
    ) -> AssistantMessage:
        return await self.complete(messages, **kwargs)


async def _run_one_turn(session: AgentSession, sid: str, workspace: str) -> list[dict]:
    """Drive a turn to completion and return everything the stream emitted."""
    from app.services import memory_stream_store as stream_store

    await session.attach_to_session(sid)
    await stream_store.init_turn(sid)
    events: list[dict] = []

    async def consume():
        async for event in stream_store.attach(sid):
            events.append(event)

    consumer = asyncio.create_task(consume())
    await asyncio.sleep(0.01)
    await session.handle_user_message(content="Go", session_id=sid, workspace=workspace)
    assert session._active_task is not None
    await session._active_task
    await asyncio.wait_for(consumer, timeout=2)
    return events


@pytest.mark.asyncio
async def test_agent_session_broadcasts_completion(db_factory, tmp_path, monkeypatch):
    """A finished turn reaches the *global* stream too.

    ``session_turn_completed`` is what other windows use to drop the running
    badge and what the viewing window uses to reconcile its live blocks with
    the persisted rows; ``assistant_done`` is the desktop notification.
    """
    published: list[tuple[str, dict]] = []

    async def capture(event: str, data: dict) -> None:
        published.append((event, data))

    monkeypatch.setattr("app.services.event_broadcaster.publish", capture)
    session = AgentSession(
        agent=Agent(llm_provider=MockProvider(["Done."]), name="openagentd"),
        workspace=str(tmp_path),
        db_factory=db_factory,
    )
    sid = str(uuid.uuid4())

    events = await _run_one_turn(session, sid, str(tmp_path))

    assert [e["event"] for e in events][-1] == "done"
    kinds = [(name, data.get("kind") or data.get("status")) for name, data in published]
    assert ("desktop_notification", "assistant_done") in kinds
    assert ("session_turn_completed", "completed") in kinds
    notification = next(d for n, d in published if n == "desktop_notification")
    assert notification["session_id"] == sid
    assert notification["title"] == f"Session completed - {tmp_path.name}"


@pytest.mark.asyncio
async def test_agent_session_closes_the_turn_on_error(
    db_factory, tmp_path, monkeypatch
):
    """A failed turn is still a finished turn.

    The error status alone leaves every other window showing a running
    session: ``done`` releases this session's subscribers and the global
    event clears the badge. No completion notification — the error is
    already its own signal.
    """
    published: list[tuple[str, dict]] = []

    async def capture(event: str, data: dict) -> None:
        published.append((event, data))

    monkeypatch.setattr("app.services.event_broadcaster.publish", capture)
    session = AgentSession(
        agent=Agent(llm_provider=FailingProvider(), name="openagentd"),
        workspace=str(tmp_path),
        db_factory=db_factory,
    )
    sid = str(uuid.uuid4())

    events = await _run_one_turn(session, sid, str(tmp_path))

    assert session.state == "error"
    types = [e["event"] for e in events]
    assert types[-1] == "done"
    statuses = [e for e in events if e["event"] == "agent_status"]
    assert any('"error"' in e["data"] for e in statuses)
    assert (
        "session_turn_completed",
        {"session_id": sid, "status": "error"},
    ) in published
    assert all(name != "desktop_notification" for name, _ in published)
