from __future__ import annotations

import json
from typing import AsyncIterator
from uuid import uuid7
import pytest
from sqlmodel import col, select

import app.core.db as core_db
from app.agent.providers.base import LLMProviderBase
from app.agent.schemas.chat import (
    ChatCompletionChunk,
    ChatCompletionChunkChoice,
    ChatCompletionDelta,
    FunctionCallDelta,
    ToolCallDelta,
)
from app.models.chat import ChatSession
from app.models.chat import SessionMessage
from app.services import memory_stream_store as stream_store
from app.agent.tools.builtin.team import make_delegate_tool
from app.agent.agent_loop import Agent
from app.agent.session import AgentSession
from app.services.subagent_service import (
    _live_instances,
    _instance_counters,
    _reconciled_lead_sessions,
    list_subagents,
    send_subagent_message,
    spawn_subagent,
    stop_all_subagents,
)


class ScriptedProvider(LLMProviderBase):
    model = "mock-model"

    def __init__(self, turns: list[list[ChatCompletionChunk]]):
        super().__init__()
        self._responses = list(turns)
        self.call_count = 0

    def stream(
        self, messages, tools=None, **kwargs
    ) -> AsyncIterator[ChatCompletionChunk]:
        if self.call_count < len(self._responses):
            chunks = self._responses[self.call_count]
            self.call_count += 1
        else:
            chunks = [
                ChatCompletionChunk(
                    id="stop",
                    created=1,
                    model="mock-model",
                    choices=[
                        ChatCompletionChunkChoice(
                            index=0,
                            delta=ChatCompletionDelta(content="Task completed."),
                            finish_reason="stop",
                        )
                    ],
                )
            ]

        async def _gen() -> AsyncIterator[ChatCompletionChunk]:
            for chunk in chunks:
                yield chunk

        return _gen()

    async def chat(self, messages, tools=None, **kwargs):
        from app.agent.schemas.chat import AssistantMessage

        return AssistantMessage(content="mock")


def make_tool_chunk(call_id: str, name: str, arguments: str) -> ChatCompletionChunk:
    return ChatCompletionChunk(
        id="chunk-tool",
        created=1,
        model="mock-model",
        choices=[
            ChatCompletionChunkChoice(
                index=0,
                delta=ChatCompletionDelta(
                    tool_calls=[
                        ToolCallDelta(
                            index=0,
                            id=call_id,
                            function=FunctionCallDelta(name=name, arguments=arguments),
                        )
                    ]
                ),
                finish_reason="tool_calls",
            )
        ],
    )


def make_text_chunk(text: str) -> ChatCompletionChunk:
    return ChatCompletionChunk(
        id="chunk-text",
        created=1,
        model="mock-model",
        choices=[
            ChatCompletionChunkChoice(
                index=0,
                delta=ChatCompletionDelta(content=text),
                finish_reason="stop",
            )
        ],
    )


@pytest.mark.asyncio
async def test_subagent_end_to_end_flow(monkeypatch: pytest.MonkeyPatch) -> None:
    lead_uuid = uuid7()
    lead_id = str(lead_uuid)

    _live_instances.clear()
    _instance_counters.clear()
    _reconciled_lead_sessions.clear()

    # 1. Create lead session in DB
    async with core_db.async_session_factory() as db:
        lead = ChatSession(id=lead_uuid, agent_name="code", workspace="")
        db.add(lead)
        await db.commit()

    # Scripted responses for explorer#1: returns final report as text
    explorer_turns = [[make_text_chunk("Audit completed: 4 auth endpoints found")]]

    # Scripted responses for explorer#2: calls ask_lead, then on resume finishes
    ask_turns = [
        [
            make_tool_chunk(
                "c2",
                "ask_lead",
                json.dumps(
                    {"question": "Should I include OAuth?", "options": ["yes", "no"]}
                ),
            )
        ],
        [make_text_chunk("Understood, audited OAuth as requested.")],
    ]

    providers = {
        "p1": ScriptedProvider(explorer_turns),
        "p2": ScriptedProvider(ask_turns),
    }

    provider_idx = 0

    def mock_build_provider(model_id, **kwargs):
        nonlocal provider_idx
        provider_idx += 1
        key = f"p{provider_idx}"
        return providers.get(key, ScriptedProvider([]))

    monkeypatch.setattr(
        "app.agent.providers.factory.build_provider", mock_build_provider
    )

    # 2. Spawn explorer#1 (sync mode, wait=True)
    res1 = await spawn_subagent(
        lead_session_id=lead_id,
        profile="explorer",
        task="Audit auth endpoints",
        wait=True,
        db_factory=core_db.async_session_factory,
        provider_factory=mock_build_provider,
    )

    assert res1["status"] == "completed"
    assert res1["member_id"] == "explorer#1"
    assert "4 auth endpoints found" in res1["output"]

    # Verify child session in DB
    async with core_db.async_session_factory() as db:
        child_1 = (
            await db.exec(
                select(ChatSession).where(
                    col(ChatSession.parent_session_id) == lead_uuid,
                    col(ChatSession.agent_name) == "explorer#1",
                )
            )
        ).first()
        assert child_1 is not None
        assert str(child_1.id) not in stream_store.running_session_ids()

    # 3. Spawn explorer#2 (sync mode, wait=True) which calls ask_lead
    res2 = await spawn_subagent(
        lead_session_id=lead_id,
        profile="explorer",
        task="Audit OAuth endpoints",
        wait=True,
        db_factory=core_db.async_session_factory,
        provider_factory=mock_build_provider,
    )

    assert res2["status"] == "waiting_lead"
    assert res2["member_id"] == "explorer#2"
    assert res2["question"] == "Should I include OAuth?"
    assert res2["options"] == ["yes", "no"]

    # 4. Check list_subagents
    roster = await list_subagents(lead_id, db_factory=core_db.async_session_factory)
    assert len(roster["live_members"]) == 2
    m2 = next(m for m in roster["live_members"] if m["member_id"] == "explorer#2")
    assert m2["status"] == "waiting_lead"
    assert m2["has_pending_question"] is True

    # 5. Lead answers explorer#2 via send_subagent_message
    reply_res = await send_subagent_message(
        lead_session_id=lead_id,
        member_id="explorer#2",
        message="Yes, include OAuth",
        wait=True,
        db_factory=core_db.async_session_factory,
    )

    assert reply_res["status"] == "completed"
    assert "audited OAuth" in reply_res["output"]

    # Verify child_2 persisted ask_lead tool answer and is no longer running
    async with core_db.async_session_factory() as db:
        child_2 = (
            await db.exec(
                select(ChatSession).where(
                    col(ChatSession.parent_session_id) == lead_uuid,
                    col(ChatSession.agent_name) == "explorer#2",
                )
            )
        ).first()
        assert child_2 is not None
        assert str(child_2.id) not in stream_store.running_session_ids()
        child_2_msgs = (
            await db.exec(
                select(SessionMessage).where(
                    col(SessionMessage.session_id) == child_2.id
                )
            )
        ).all()
        tool_answers = [
            m for m in child_2_msgs if m.role == "tool" and m.name == "ask_lead"
        ]
        assert len(tool_answers) == 1
        assert "Yes, include OAuth" in tool_answers[0].content
        assert tool_answers[0].tool_call_id == "c2"

    # 6. Stop all subagents
    await stop_all_subagents(lead_id)
    for inst in _live_instances[lead_id].values():
        assert inst.status == "error"


@pytest.mark.asyncio
async def test_async_subagent_dispatch_and_lead_delivery(tmp_path, monkeypatch) -> None:
    lead_uuid = uuid7()
    lead_id = str(lead_uuid)

    _live_instances.clear()
    _instance_counters.clear()
    _reconciled_lead_sessions.clear()

    # Create lead chat session row
    async with core_db.async_session_factory() as db:
        lead_session_row = ChatSession(
            id=lead_uuid,
            title="Async Lead Session",
            workspace=str(tmp_path),
            model="mock-model",
        )
        db.add(lead_session_row)
        await db.commit()

    # Create fake explorer chunks returning a report
    explorer_chunks = [
        ChatCompletionChunk(
            id="c1",
            created=1,
            model="mock-model",
            choices=[
                ChatCompletionChunkChoice(
                    index=0,
                    delta=ChatCompletionDelta(content="Discovered 3 database tables."),
                    finish_reason="stop",
                )
            ],
        )
    ]

    # Create fake lead chunks when lead is activated
    lead_chunks = [
        ChatCompletionChunk(
            id="c2",
            created=1,
            model="mock-model",
            choices=[
                ChatCompletionChunkChoice(
                    index=0,
                    delta=ChatCompletionDelta(content="Understood the 3 tables."),
                    finish_reason="stop",
                )
            ],
        )
    ]

    provider_map = {
        "explorer#1": ScriptedProvider([explorer_chunks]),
        "lead": ScriptedProvider([lead_chunks]),
    }

    def mock_build_provider(model_id, **kwargs):
        return provider_map.get("explorer#1", ScriptedProvider([]))

    lead_agent = Agent(
        llm_provider=provider_map["lead"],
        system_prompt="You are lead.",
        tools=[],
        name="lead",
        model_id="mock-model",
    )
    lead_session = AgentSession(
        agent=lead_agent,
        session_id=lead_id,
        workspace=str(tmp_path),
        db_factory=core_db.async_session_factory,
        provider_factory=mock_build_provider,
    )

    from app.services import agent_manager

    agent_manager._sessions[(str(tmp_path), lead_id)] = lead_session

    # 1. Delegate tool invocation
    tool = make_delegate_tool(
        lead_id,
        core_db.async_session_factory,
        provider_factory=mock_build_provider,
    )

    res = await tool.arun(
        profile="explorer",
        task="Discover database tables",
        _workspace=str(tmp_path),
    )

    # Verify delegate returns immediately with background dispatch message
    assert "Subagent 'explorer#1' dispatched" in res
    assert "running asynchronously in the background" in res

    inst = _live_instances[lead_id]["explorer#1"]
    assert inst.task_handle is not None

    # Wait for child task to complete in background
    await inst.task_handle

    # Wait briefly for lead session activation task if started
    if lead_session._active_task is not None:
        await lead_session._active_task

    # 2. Verify subagent output was delivered to lead session messages
    async with core_db.async_session_factory() as db:
        stmt = (
            select(SessionMessage)
            .where(col(SessionMessage.session_id) == lead_uuid)
            .where(col(SessionMessage.role) == "user")
        )
        msgs = (await db.exec(stmt)).all()
        subagent_delivered = [
            m for m in msgs if m.extra and m.extra.get("from_agent") == "explorer#1"
        ]
        assert len(subagent_delivered) == 1
        assert "Discovered 3 database tables." in (subagent_delivered[0].content or "")
