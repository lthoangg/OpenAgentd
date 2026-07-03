"""Tests for `OpenAIProvider` — initialization and delegation to handlers.

See `app/agent/providers/openai/openai.py:OpenAIProvider`.
"""

from __future__ import annotations


import pytest

from app.agent.providers.openai.openai import (
    OpenAIProvider,
)
from app.agent.schemas.chat import (
    AssistantMessage,
    ChatCompletionChunk,
    ChatCompletionChunkChoice,
    ChatCompletionDelta,
    HumanMessage,
)


# ─────────────────────────────────────────────────────────────────────────────
# Test OpenAIProvider routing
# ─────────────────────────────────────────────────────────────────────────────


class TestOpenAIProvider:
    """Test OpenAIProvider initialization and routing."""

    def test_init_with_valid_api_key(self):
        """Initialize provider with valid API key."""
        provider = OpenAIProvider(api_key="sk-test", model="gpt-4o")
        assert provider.api_key == "sk-test"
        assert provider.model == "gpt-4o"
        assert provider._use_responses is False

    def test_init_with_secret_str_api_key(self):
        """Initialize provider with SecretStr API key."""
        from pydantic.types import SecretStr

        provider = OpenAIProvider(api_key=SecretStr("sk-test"), model="gpt-4o")
        assert provider.api_key == "sk-test"

    def test_init_with_empty_api_key_raises_error(self):
        """Initialize with empty API key raises ValueError."""
        with pytest.raises(ValueError, match="API key is required"):
            OpenAIProvider(api_key="", model="gpt-4o")

    def test_init_with_thinking_level_routes_to_responses(self):
        """Initialize with thinking_level auto-routes to Responses API."""
        provider = OpenAIProvider(
            api_key="sk-test",
            model="gpt-5.4",
            model_kwargs={"thinking_level": "high"},
        )
        assert provider._use_responses is True

    def test_init_with_explicit_responses_api_true(self):
        """Initialize with explicit responses_api: true."""
        provider = OpenAIProvider(
            api_key="sk-test",
            model="gpt-4o",
            model_kwargs={"responses_api": True},
        )
        assert provider._use_responses is True

    def test_init_with_explicit_responses_api_false(self):
        """Initialize with explicit responses_api: false."""
        provider = OpenAIProvider(
            api_key="sk-test",
            model="gpt-4o",
            model_kwargs={"responses_api": False},
        )
        assert provider._use_responses is False

    def test_init_with_custom_base_url(self):
        """Initialize with custom base URL."""
        provider = OpenAIProvider(
            api_key="sk-test",
            model="gpt-4o",
            base_url="https://custom.example.com/v1/",
        )
        assert provider.base_url == "https://custom.example.com/v1"

    def test_init_strips_trailing_slash_from_base_url(self):
        """Base URL trailing slash is stripped."""
        provider = OpenAIProvider(
            api_key="sk-test",
            model="gpt-4o",
            base_url="https://api.openai.com/v1/",
        )
        assert provider.base_url == "https://api.openai.com/v1"

    def test_init_with_max_tokens(self):
        """Initialize with max_tokens."""
        provider = OpenAIProvider(
            api_key="sk-test",
            model="gpt-4o",
            max_tokens=1000,
        )
        assert provider.max_tokens == 1000


# ─────────────────────────────────────────────────────────────────────────────
# Test CompletionsHandler.chat() and stream() — HTTP integration
# ─────────────────────────────────────────────────────────────────────────────


# ─────────────────────────────────────────────────────────────────────────────
# Test OpenAIProvider.chat() and stream() delegation
# ─────────────────────────────────────────────────────────────────────────────


class TestOpenAIProviderDelegation:
    """Test OpenAIProvider delegation to completions and responses handlers."""

    async def test_chat_delegates_to_completions(self):
        """Test chat() delegates to _completions when _use_responses is False."""
        from unittest.mock import AsyncMock, patch

        provider = OpenAIProvider(
            api_key="sk-test",
            model="gpt-4o",
            model_kwargs={"responses_api": False},
        )

        messages = [HumanMessage(content="Hello")]
        expected_result = AssistantMessage(content="Response from completions")

        with patch.object(
            provider._completions, "chat", new_callable=AsyncMock
        ) as mock_chat:
            mock_chat.return_value = expected_result
            result = await provider.chat(messages)

        assert result == expected_result
        mock_chat.assert_called_once()

    async def test_chat_delegates_to_responses(self):
        """Test chat() delegates to _responses when _use_responses is True."""
        from unittest.mock import AsyncMock, patch

        provider = OpenAIProvider(
            api_key="sk-test",
            model="gpt-5.4",
            model_kwargs={"responses_api": True},
        )

        messages = [HumanMessage(content="Hello")]
        expected_result = AssistantMessage(content="Response from responses")

        with patch.object(
            provider._responses, "chat", new_callable=AsyncMock
        ) as mock_chat:
            mock_chat.return_value = expected_result
            result = await provider.chat(messages)

        assert result == expected_result
        mock_chat.assert_called_once()

    async def test_stream_delegates_to_completions(self):
        """Test stream() delegates to _completions when _use_responses is False."""
        from unittest.mock import patch

        provider = OpenAIProvider(
            api_key="sk-test",
            model="gpt-4o",
            model_kwargs={"responses_api": False},
        )

        messages = [HumanMessage(content="Hello")]

        async def mock_stream(*args, **kwargs):
            yield ChatCompletionChunk(
                id="chunk-1",
                created=1234567890,
                model="gpt-4o",
                choices=[
                    ChatCompletionChunkChoice(
                        index=0,
                        delta=ChatCompletionDelta(content="Hello"),
                        finish_reason=None,
                    )
                ],
            )

        with patch.object(provider._completions, "stream", side_effect=mock_stream):
            chunks = []
            async for chunk in provider.stream(messages):
                chunks.append(chunk)

        assert len(chunks) == 1
        assert chunks[0].choices[0].delta.content == "Hello"

    async def test_stream_delegates_to_responses(self):
        """Test stream() delegates to _responses when _use_responses is True."""
        from unittest.mock import patch

        provider = OpenAIProvider(
            api_key="sk-test",
            model="gpt-5.4",
            model_kwargs={"responses_api": True},
        )

        messages = [HumanMessage(content="Hello")]

        async def mock_stream(*args, **kwargs):
            yield ChatCompletionChunk(
                id="chunk-1",
                created=1234567890,
                model="gpt-5.4",
                choices=[
                    ChatCompletionChunkChoice(
                        index=0,
                        delta=ChatCompletionDelta(content="Hello"),
                        finish_reason=None,
                    )
                ],
            )

        with patch.object(provider._responses, "stream", side_effect=mock_stream):
            chunks = []
            async for chunk in provider.stream(messages):
                chunks.append(chunk)

        assert len(chunks) == 1
        assert chunks[0].choices[0].delta.content == "Hello"
