from __future__ import annotations

import json
from typing import AsyncIterator
from uuid import uuid7
import pytest
from sqlmodel import col, select

import app.core.db as core_db
from app.agent.agent_loop import Agent
from app.agent.providers.base import LLMProviderBase
from app.agent.schemas.chat import (
    ChatCompletionChunk,
    ChatCompletionChunkChoice,
    ChatCompletionDelta,
    FunctionCallDelta,
    ToolCallDelta,
)
from app.agent.session import AgentSession
from app.models.chat import ChatSession, SessionMessage
from app.services.subagent_service import (
    _instance_counters,
    _live_instances,
    _reconciled_lead_sessions,
)


class ScriptedProvider(LLMProviderBase):
    def __init__(
        self, turns: list[list[ChatCompletionChunk]], model_id: str = "scripted"
    ):
        super().__init__()
        self.model_id = model_id
        self._turns = list(turns)
        self.turn_idx = 0

    def stream(
        self, messages, tools=None, **kwargs
    ) -> AsyncIterator[ChatCompletionChunk]:
        if self.turn_idx < len(self._turns):
            chunks = self._turns[self.turn_idx]
            self.turn_idx += 1
        else:
            chunks = [
                ChatCompletionChunk(
                    id="done",
                    created=1,
                    model=self.model_id,
                    choices=[
                        ChatCompletionChunkChoice(
                            index=0,
                            delta=ChatCompletionDelta(content="I am finished."),
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


def make_parallel_tools_chunk(calls: list[tuple[str, str, str]]) -> ChatCompletionChunk:
    return ChatCompletionChunk(
        id="chunk-tools",
        created=1,
        model="mock-model",
        choices=[
            ChatCompletionChunkChoice(
                index=0,
                delta=ChatCompletionDelta(
                    tool_calls=[
                        ToolCallDelta(
                            index=i,
                            id=call_id,
                            function=FunctionCallDelta(name=name, arguments=arguments),
                        )
                        for i, (call_id, name, arguments) in enumerate(calls)
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
async def test_full_lead_member_communication_cycle() -> None:
    """Test full cycle: Lead calls delegate -> Member runs and returns report -> Lead finishes."""
    lead_uuid = uuid7()
    lead_id = str(lead_uuid)

    _live_instances.clear()
    _instance_counters.clear()
    _reconciled_lead_sessions.clear()

    # Create lead DB row
    async with core_db.async_session_factory() as db:
        lead_sess = ChatSession(id=lead_uuid, agent_name="code", workspace="")
        db.add(lead_sess)
        await db.commit()

    # Turn 1 for Lead: calls delegate(profile="explorer", task="Find auth routes")
    # Turn 2 for Lead: receives member findings, delivers final synthesis
    lead_turns = [
        [
            make_tool_chunk(
                "spawn_call_1",
                "delegate",
                json.dumps(
                    {
                        "profile": "explorer",
                        "task": "Find auth routes",
                    }
                ),
            )
        ],
        [
            make_text_chunk(
                "Based on the explorer's report, 3 auth routes were identified: login, logout, refresh."
            )
        ],
    ]

    # Turn 1 for Member: directly delivers report in assistant response text
    member_turns = [
        [
            make_text_chunk(
                "Found 3 auth routes in app/api/auth.py: login, logout, refresh"
            )
        ]
    ]

    lead_provider = ScriptedProvider(lead_turns, model_id="lead-model")
    member_provider = ScriptedProvider(member_turns, model_id="member-model")

    def provider_factory(model_id, **kwargs):
        if model_id == "lead-model":
            return lead_provider
        return member_provider

    lead_agent = Agent(
        llm_provider=lead_provider,
        system_prompt="You are OpenAgentd lead.",
        tools=[],
        name="code",
        model_id="lead-model",
    )

    lead_session = AgentSession(
        agent=lead_agent,
        session_id=lead_id,
        workspace="",
        db_factory=core_db.async_session_factory,
        provider_factory=provider_factory,
    )

    # Run lead turn with user message
    await lead_session.handle_user_message(
        content="Where are our auth routes located?",
        session_id=lead_id,
    )
    await lead_session._active_task

    # Await explorer#1 task if still running in background
    inst = _live_instances[lead_id].get("explorer#1")
    if inst and inst.task_handle:
        await inst.task_handle

    # 1. Verify Lead DB messages
    async with core_db.async_session_factory() as db:
        lead_msgs = (
            await db.exec(
                select(SessionMessage)
                .where(col(SessionMessage.session_id) == lead_uuid)
                .order_by(col(SessionMessage.seq).asc())
            )
        ).all()

        assert len(lead_msgs) >= 4
        assert lead_msgs[0].role == "user"
        assert "auth routes located" in lead_msgs[0].content

        spawn_tool_call_msg = lead_msgs[1]
        assert spawn_tool_call_msg.role == "assistant"
        assert spawn_tool_call_msg.tool_calls[0]["function"]["name"] == "delegate"

        tool_result_msg = lead_msgs[2]
        assert tool_result_msg.role == "tool"
        assert tool_result_msg.name == "delegate"
        assert "Subagent 'explorer#1' dispatched" in tool_result_msg.content

        # Member deliverable returned as a user message to lead with from_agent
        subagent_delivered = [
            m
            for m in lead_msgs
            if m.role == "user"
            and m.extra
            and m.extra.get("from_agent") == "explorer#1"
        ]
        assert len(subagent_delivered) == 1
        assert "Found 3 auth routes in app/api/auth.py" in subagent_delivered[0].content

        # 2. Verify Member DB session
        child_sess = (
            await db.exec(
                select(ChatSession).where(
                    col(ChatSession.parent_session_id) == lead_uuid,
                    col(ChatSession.agent_name) == "explorer#1",
                )
            )
        ).first()
        assert child_sess is not None

        # Verify Member DB messages
        member_msgs = (
            await db.exec(
                select(SessionMessage)
                .where(col(SessionMessage.session_id) == child_sess.id)
                .order_by(col(SessionMessage.seq).asc())
            )
        ).all()
        assert len(member_msgs) >= 2
        assert member_msgs[0].role == "user"
        assert "Task from Lead" in member_msgs[0].content
        assert member_msgs[1].role == "assistant"
        assert "Found 3 auth routes" in member_msgs[1].content


@pytest.mark.asyncio
async def test_bidirectional_qa_dialogue_between_lead_and_member() -> None:
    """Test bidirectional dialogue: Member calls ask_lead -> Lead answers via delegate -> Member finishes."""
    lead_uuid = uuid7()
    lead_id = str(lead_uuid)

    _live_instances.clear()
    _instance_counters.clear()
    _reconciled_lead_sessions.clear()

    async with core_db.async_session_factory() as db:
        lead_sess = ChatSession(id=lead_uuid, agent_name="code", workspace="")
        db.add(lead_sess)
        await db.commit()

    # Lead:
    # 1. calls delegate(explorer, task="Audit endpoints")
    # 2. receives "waiting_lead", decides to call delegate(explorer, target="explorer#1", task="Audit public endpoints only.")
    # 3. receives final member response, replies to user
    lead_turns = [
        [
            make_tool_chunk(
                "call_sp",
                "delegate",
                json.dumps(
                    {
                        "profile": "explorer",
                        "task": "Audit endpoints",
                    }
                ),
            )
        ],
        [
            make_tool_chunk(
                "call_se",
                "delegate",
                json.dumps(
                    {
                        "profile": "explorer",
                        "target": "explorer#1",
                        "task": "Audit public endpoints only.",
                    }
                ),
            )
        ],
        [make_text_chunk("All public endpoints have been audited.")],
    ]

    # Member:
    # 1. calls ask_lead(question="Internal or public?", options=["internal", "public"])
    # 2. on resume after Lead answer, delivers final report text
    member_turns = [
        [
            make_tool_chunk(
                "call_ask",
                "ask_lead",
                json.dumps(
                    {
                        "question": "Internal or public?",
                        "options": ["internal", "public"],
                    }
                ),
            )
        ],
        [
            make_text_chunk(
                "Audited public endpoints only: /health and /version verified."
            )
        ],
    ]

    lead_provider = ScriptedProvider(lead_turns, model_id="lead-model")
    member_provider = ScriptedProvider(member_turns, model_id="member-model")

    def provider_factory(model_id, **kwargs):
        if model_id == "lead-model":
            return lead_provider
        return member_provider

    lead_agent = Agent(
        llm_provider=lead_provider,
        system_prompt="You are OpenAgentd lead.",
        tools=[],
        name="code",
        model_id="lead-model",
    )

    lead_session = AgentSession(
        agent=lead_agent,
        session_id=lead_id,
        workspace="",
        db_factory=core_db.async_session_factory,
        provider_factory=provider_factory,
    )

    await lead_session.handle_user_message(
        content="Start endpoint audit", session_id=lead_id
    )
    await lead_session._active_task

    # Check final result
    async with core_db.async_session_factory() as db:
        lead_msgs = (
            await db.exec(
                select(SessionMessage)
                .where(col(SessionMessage.session_id) == lead_uuid)
                .order_by(col(SessionMessage.seq).asc())
            )
        ).all()

        # Assistant tool calls: delegate -> delegate (reply)
        tool_names = [
            m.tool_calls[0]["function"]["name"]
            for m in lead_msgs
            if m.role == "assistant" and m.tool_calls
        ]
        assert tool_names == ["delegate", "delegate"]

        final_msg = [
            m for m in lead_msgs if m.role == "assistant" and not m.tool_calls
        ][-1]
        assert "All public endpoints have been audited" in final_msg.content


@pytest.mark.asyncio
async def test_multi_instance_spawn_ness_in_parallel() -> None:
    """Test multi-instance spawn-ness: Lead spawns explorer#1 and explorer#2 in parallel."""
    lead_uuid = uuid7()
    lead_id = str(lead_uuid)

    _live_instances.clear()
    _instance_counters.clear()
    _reconciled_lead_sessions.clear()

    async with core_db.async_session_factory() as db:
        lead_sess = ChatSession(id=lead_uuid, agent_name="code", workspace="")
        db.add(lead_sess)
        await db.commit()

    # Lead: calls delegate twice in parallel in turn 1
    lead_turns = [
        [
            make_parallel_tools_chunk(
                [
                    (
                        "call_sp1",
                        "delegate",
                        json.dumps({"profile": "explorer", "task": "Task A"}),
                    ),
                    (
                        "call_sp2",
                        "delegate",
                        json.dumps({"profile": "explorer", "task": "Task B"}),
                    ),
                ]
            )
        ],
        [make_text_chunk("Both parallel explorations completed.")],
    ]

    member_turns_1 = [[make_text_chunk("Result from explorer#1")]]
    member_turns_2 = [[make_text_chunk("Result from explorer#2")]]

    lead_provider = ScriptedProvider(lead_turns, model_id="lead-model")
    p1 = ScriptedProvider(member_turns_1, model_id="m1")
    p2 = ScriptedProvider(member_turns_2, model_id="m2")

    member_idx = 0

    def provider_factory(model_id, **kwargs):
        nonlocal member_idx
        if model_id == "lead-model":
            return lead_provider
        member_idx += 1
        return p1 if member_idx == 1 else p2

    lead_agent = Agent(
        llm_provider=lead_provider,
        system_prompt="You are OpenAgentd lead.",
        tools=[],
        name="code",
        model_id="lead-model",
    )

    lead_session = AgentSession(
        agent=lead_agent,
        session_id=lead_id,
        workspace="",
        db_factory=core_db.async_session_factory,
        provider_factory=provider_factory,
    )

    await lead_session.handle_user_message(
        content="Run parallel check", session_id=lead_id
    )
    await lead_session._active_task

    async with core_db.async_session_factory() as db:
        children = (
            await db.exec(
                select(ChatSession.agent_name)
                .where(col(ChatSession.parent_session_id) == lead_uuid)
                .order_by(col(ChatSession.created_at).asc())
            )
        ).all()
        assert "explorer#1" in children
        assert "explorer#2" in children
