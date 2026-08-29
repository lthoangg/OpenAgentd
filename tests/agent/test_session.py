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
