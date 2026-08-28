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
from app.agent.mode.team.runtime import SessionRuntime


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
async def runtime(tmp_path) -> SessionRuntime:
    """Create a session runtime bound to a temporary workspace."""
    return SessionRuntime(
        Agent(name="openagentd", llm_provider=MockTeamProvider("OK")),
        workspace=str(tmp_path),
    )
