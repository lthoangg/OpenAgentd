"""Fixtures for team system tests."""

from __future__ import annotations

from typing import AsyncIterator
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio

from app.agent.agent_loop import Agent
from app.agent.providers.base import LLMProviderBase
from app.agent.schemas.chat import (
    AssistantMessage,
    ChatCompletionChunk,
    ChatCompletionChunkChoice,
    ChatCompletionDelta,
    ChatMessage,
)
from app.agent.mode.team.member import TeamLead, TeamMember
from app.agent.mode.team.team import AgentTeam


def make_text_chunk(text: str) -> ChatCompletionChunk:
    """Create a mock text chunk."""
    return ChatCompletionChunk(
        id="chunk-1",
        created=1_000_000,
        model="mock-model",
        choices=[
            ChatCompletionChunkChoice(
                index=0,
                delta=ChatCompletionDelta(content=text),
                finish_reason="stop",
            )
        ],
    )


class MockTeamProvider(LLMProviderBase):
    """Mock LLM provider for team tests."""

    model = "mock-model"

    def __init__(self, response_text: str = "OK"):
        super().__init__()
        self.response_text = response_text
        self.call_count = 0

    def stream(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ) -> AsyncIterator[ChatCompletionChunk]:
        self.call_count += 1

        async def _gen() -> AsyncIterator[ChatCompletionChunk]:
            yield make_text_chunk(self.response_text)

        return _gen()

    async def chat(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ) -> AssistantMessage:
        return AssistantMessage(content=self.response_text)


@pytest.fixture(autouse=True)
def mock_stream_store():
    """Patch stream_store for tests.

    All tests automatically get this fixture. Access captured events via
    ``mock_stream_store.push_event.call_args_list``.
    """
    with (
        patch(
            "app.services.memory_stream_store.push_event", new_callable=AsyncMock
        ) as push,
        patch("app.services.memory_stream_store.mark_done", new_callable=AsyncMock),
        patch("app.services.memory_stream_store.clear", new_callable=AsyncMock),
        patch("app.services.memory_stream_store.init_turn", new_callable=AsyncMock),
    ):
        yield push


@pytest_asyncio.fixture
async def lead_member() -> TeamLead:
    """Create a lead team member."""
    provider = MockTeamProvider("OK lead")
    agent = Agent(name="lead", llm_provider=provider)
    member = TeamLead(agent)
    return member


@pytest_asyncio.fixture
async def member_a() -> TeamMember:
    """Create a regular team member A."""
    provider = MockTeamProvider("OK member_a")
    agent = Agent(name="member_a", llm_provider=provider)
    member = TeamMember(agent)
    return member


@pytest_asyncio.fixture
async def member_b() -> TeamMember:
    """Create a regular team member B."""
    provider = MockTeamProvider("OK member_b")
    agent = Agent(name="member_b", llm_provider=provider)
    member = TeamMember(agent)
    return member


@pytest_asyncio.fixture
async def basic_team(lead_member, member_a, member_b, tmp_path) -> AgentTeam:
    """Create a basic team with lead and 2 members."""
    team = AgentTeam(
        lead=lead_member,
        members={"member_a": member_a, "member_b": member_b},
        workspace=str(tmp_path),
    )
    return team
