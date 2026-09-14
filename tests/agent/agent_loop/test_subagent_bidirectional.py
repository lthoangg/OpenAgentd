from __future__ import annotations

import json
from typing import AsyncIterator
from uuid import uuid7
import pytest

from app.agent.agent_loop import Agent
from app.agent.providers.base import LLMProviderBase
from app.agent.schemas.chat import (
    ChatCompletionChunk,
    ChatCompletionChunkChoice,
    ChatCompletionDelta,
    FunctionCallDelta,
    HumanMessage,
    ToolCallDelta,
)
from app.agent.schemas.agent import RunConfig
from app.agent.tools.builtin.member import make_ask_lead_tool, make_send_to_lead_tool
from app.agent.tools.builtin.team import (
    make_team_list_tool,
    make_team_send_tool,
    make_team_spawn_tool,
    make_team_stop_tool,
    make_team_wait_tool,
)
import app.core.db as core_db
from app.models.chat import ChatSession
from app.services.subagent_service import (
    _live_instances,
    _instance_counters,
    _reconciled_lead_sessions,
)


class ScriptedProvider(LLMProviderBase):
    """Provider that yields pre-programmed response chunks."""

    model = "mock-model"

    def __init__(self, turns: list[list[ChatCompletionChunk]]) -> None:
        super().__init__()
        self._responses = iter(turns)
        self.call_count = 0

    def stream(
        self, messages, tools=None, **kwargs
    ) -> AsyncIterator[ChatCompletionChunk]:
        self.call_count += 1
        chunks = next(self._responses)

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
async def test_member_send_to_lead_and_ask_lead() -> None:
    lead_id = str(uuid7())
    member_handle = "explorer#1"

    send_tool = make_send_to_lead_tool(lead_id, member_handle)
    ask_tool = make_ask_lead_tool(lead_id, member_handle)

    # 1. Member calls send_to_lead
    res = await send_tool.arun(message="Found 3 files", end_turn=True)
    assert "Message successfully delivered" in res

    # 2. Member calls ask_lead in agent loop -> suspends
    provider = ScriptedProvider(
        [
            [
                make_tool_chunk(
                    "call-1",
                    "ask_lead",
                    json.dumps(
                        {"question": "Which auth?", "options": ["jwt", "session"]}
                    ),
                )
            ]
        ]
    )

    agent = Agent(
        llm_provider=provider,
        system_prompt="You are explorer#1",
        tools=[],
        name=member_handle,
    )

    config = RunConfig(session_id="child-session", metadata={})
    history = [HumanMessage(content="Audit auth flow")]

    await agent.run(history, config=config, injected_tools=[ask_tool, send_tool])

    # Verify turn suspended on ask_lead
    assert "lead_suspended" in config.metadata
    assert config.metadata["lead_suspended"]["question"] == "Which auth?"
    assert config.metadata["lead_suspended"]["options"] == ["jwt", "session"]


@pytest.mark.asyncio
async def test_lead_team_tools_integration() -> None:
    lead_uuid = uuid7()
    lead_id = str(lead_uuid)

    _live_instances.clear()
    _instance_counters.clear()
    _reconciled_lead_sessions.clear()

    # Ensure lead session in DB
    async with core_db.async_session_factory() as db:
        lead_sess = ChatSession(
            id=lead_uuid,
            agent_name="code",
            workspace="",
        )
        db.add(lead_sess)
        await db.commit()

    # Initialize lead tools
    spawn_tool = make_team_spawn_tool(lead_id, core_db.async_session_factory)
    list_tool = make_team_list_tool(lead_id)
    send_tool = make_team_send_tool(lead_id, core_db.async_session_factory)
    stop_tool = make_team_stop_tool(lead_id)
    wait_tool = make_team_wait_tool(lead_id, core_db.async_session_factory)

    # Test team_list initially shows available profiles and empty live members
    list_res = json.loads(await list_tool.arun())
    assert "available_profiles" in list_res
    assert any(p["name"] == "explorer" for p in list_res["available_profiles"])
    assert list_res["live_members"] == []

    # Test team_spawn async mode
    spawn_res_1 = json.loads(
        await spawn_tool.arun(
            profile="explorer",
            task="Find frontend files",
            wait=False,
        )
    )
    assert spawn_res_1["status"] == "spawned"
    assert spawn_res_1["member_id"] == "explorer#1"

    # Test team_spawn a second instance of the same profile
    spawn_res_2 = json.loads(
        await spawn_tool.arun(
            profile="explorer",
            task="Find backend files",
            wait=False,
        )
    )
    assert spawn_res_2["status"] == "spawned"
    assert spawn_res_2["member_id"] == "explorer#2"

    # team_list now shows both live members
    list_res_after = json.loads(await list_tool.arun())
    live_ids = [m["member_id"] for m in list_res_after["live_members"]]
    assert "explorer#1" in live_ids
    assert "explorer#2" in live_ids

    # Send instruction to explorer#2
    send_res = json.loads(
        await send_tool.arun(
            member_id="explorer#2",
            message="Focus on API endpoints only",
            wait=False,
        )
    )
    assert send_res["status"] == "sent"
    assert send_res["member_id"] == "explorer#2"

    # Await explorer#2
    wait_res = json.loads(
        await wait_tool.arun(
            member_ids=["explorer#2"],
            timeout=5,
        )
    )
    assert wait_res["status"] == "completed"
    assert "explorer#2" in wait_res["results"]

    # Stop explorer#1
    stop_res = json.loads(await stop_tool.arun(member_id="explorer#1"))
    assert stop_res["status"] == "stopped"

    # Clean up remaining
    await stop_tool.arun(member_id="explorer#2")
