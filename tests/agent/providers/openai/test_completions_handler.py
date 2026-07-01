"""Tests for `CompletionsHandler` — request building, response parsing,
HTTP integration, usage extraction, and tool-message image handling.

See `app/agent/providers/openai/completions.py`.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from app.agent.providers.openai.completions import CompletionsHandler
from app.agent.schemas.chat import (
    AssistantMessage,
    FunctionCall,
    HumanMessage,
    ImageDataBlock,
    ImageUrlBlock,
    SystemMessage,
    TextBlock,
    ToolCall,
    ToolMessage,
)


# ─────────────────────────────────────────────────────────────────────────────
# Test CompletionsHandler
# ─────────────────────────────────────────────────────────────────────────────


class TestCompletionsHandler:
    """Test Chat Completions API handler."""

    @pytest.fixture
    def handler(self):
        """Create a CompletionsHandler instance."""
        return CompletionsHandler(
            model="gpt-4o",
            base_url="https://api.openai.com/v1",
            headers={"Authorization": "Bearer sk-test"},
        )

    # ─────────────────────────────────────────────────────────────────────────
    # Message conversion tests
    # ─────────────────────────────────────────────────────────────────────────

    def test_convert_messages_system_message(self, handler):
        """Convert SystemMessage to OpenAI format."""
        messages = [SystemMessage(content="You are a helpful assistant.")]
        result = handler.convert_messages(messages)
        assert len(result) == 1
        assert result[0].role == "system"
        assert result[0].content == "You are a helpful assistant."

    def test_convert_messages_human_message_text_only(self, handler):
        """Convert HumanMessage with plain text."""
        messages = [HumanMessage(content="Hello, world!")]
        result = handler.convert_messages(messages)
        assert len(result) == 1
        assert result[0].role == "user"
        assert result[0].content == "Hello, world!"

    def test_convert_messages_human_message_with_text_block(self, handler):
        """Convert HumanMessage with TextBlock parts."""
        messages = [
            HumanMessage(
                parts=[
                    TextBlock(text="What is in this image?"),
                ]
            )
        ]
        result = handler.convert_messages(messages)
        assert len(result) == 1
        assert result[0].role == "user"
        assert isinstance(result[0].content, list)
        assert result[0].content[0]["type"] == "text"
        assert result[0].content[0]["text"] == "What is in this image?"

    def test_convert_messages_human_message_with_image_url(self, handler):
        """Convert HumanMessage with ImageUrlBlock."""
        messages = [
            HumanMessage(
                parts=[
                    TextBlock(text="Describe this:"),
                    ImageUrlBlock(url="https://example.com/image.jpg", detail="high"),
                ]
            )
        ]
        result = handler.convert_messages(messages)
        assert len(result) == 1
        assert isinstance(result[0].content, list)
        assert len(result[0].content) == 2
        assert result[0].content[1]["type"] == "image_url"
        assert (
            result[0].content[1]["image_url"]["url"] == "https://example.com/image.jpg"
        )
        assert result[0].content[1]["image_url"]["detail"] == "high"

    def test_convert_messages_human_message_with_image_data(self, handler):
        """Convert HumanMessage with ImageDataBlock."""
        messages = [
            HumanMessage(
                parts=[
                    ImageDataBlock(data="iVBORw0KGgo=", media_type="image/png"),
                ]
            )
        ]
        result = handler.convert_messages(messages)
        assert len(result) == 1
        assert isinstance(result[0].content, list)
        assert result[0].content[0]["type"] == "image_url"
        assert "data:image/png;base64," in result[0].content[0]["image_url"]["url"]

    def test_convert_messages_assistant_message_text_only(self, handler):
        """Convert AssistantMessage with text only."""
        messages = [AssistantMessage(content="I can help with that.")]
        result = handler.convert_messages(messages)
        assert len(result) == 1
        assert result[0].role == "assistant"
        assert result[0].content == "I can help with that."
        assert result[0].tool_calls is None

    def test_convert_messages_assistant_message_with_tool_calls(self, handler):
        """Convert AssistantMessage with tool calls."""
        messages = [
            AssistantMessage(
                content="I'll call a tool.",
                tool_calls=[
                    ToolCall(
                        id="call_123",
                        function=FunctionCall(
                            name="get_weather",
                            arguments='{"city": "NYC"}',
                        ),
                    ),
                ],
            )
        ]
        result = handler.convert_messages(messages)
        assert len(result) == 1
        assert result[0].role == "assistant"
        assert result[0].tool_calls is not None
        assert len(result[0].tool_calls) == 1
        assert result[0].tool_calls[0].id == "call_123"
        assert result[0].tool_calls[0].function.name == "get_weather"
        assert result[0].tool_calls[0].function.arguments == '{"city": "NYC"}'

    def test_convert_messages_assistant_message_with_tool_calls_without_content(
        self, handler
    ):
        """OpenAI requires assistant content to be a string, even for tool calls."""
        messages = [
            AssistantMessage(
                content=None,
                tool_calls=[
                    ToolCall(
                        id="call_123",
                        function=FunctionCall(name="get_weather", arguments="{}"),
                    )
                ],
            )
        ]

        result = handler.convert_messages(messages)

        assert result[0].role == "assistant"
        assert result[0].content == ""
        assert result[0].tool_calls is not None

    def test_convert_messages_tool_message_text_only(self, handler):
        """Convert ToolMessage with plain text."""
        messages = [
            ToolMessage(
                tool_call_id="call_123",
                name="get_weather",
                content="Sunny, 72°F",
            )
        ]
        result = handler.convert_messages(messages)
        assert len(result) == 1
        assert result[0].role == "tool"
        assert result[0].content == "Sunny, 72°F"
        assert result[0].tool_call_id == "call_123"
        assert result[0].name == "get_weather"

    def test_convert_messages_tool_message_with_parts(self, handler):
        """Convert ToolMessage with multimodal parts."""
        messages = [
            ToolMessage(
                tool_call_id="call_123",
                name="read_file",
                parts=[
                    TextBlock(text="File contents:"),
                    ImageUrlBlock(url="https://example.com/doc.jpg"),
                ],
            )
        ]
        result = handler.convert_messages(messages)
        assert len(result) == 1
        assert result[0].role == "tool"
        assert isinstance(result[0].content, list)
        assert len(result[0].content) == 2

    def test_build_request_drops_orphan_tool_message(self, handler):
        """OpenAI request building drops invalid tool outputs defensively."""
        messages = [
            HumanMessage(content="Hello"),
            ToolMessage(tool_call_id="missing_call", content="orphan"),
        ]

        body = handler.build_request(messages, tools=None, stream=False, merged={})

        assert len(body["messages"]) == 1
        assert body["messages"][0]["role"] == "user"

    def test_build_request_strips_incomplete_assistant_tool_calls(self, handler):
        """OpenAI request building does not send tool_calls without outputs."""
        messages = [
            AssistantMessage(
                content="Calling a tool.",
                tool_calls=[
                    ToolCall(
                        id="call_123",
                        function=FunctionCall(name="get_weather", arguments="{}"),
                    )
                ],
            ),
            HumanMessage(content="next"),
        ]

        body = handler.build_request(messages, tools=None, stream=False, merged={})

        assert len(body["messages"]) == 2
        assert body["messages"][0]["role"] == "assistant"
        assert "tool_calls" not in body["messages"][0]
        assert body["messages"][1]["role"] == "user"

    def test_build_request_keeps_valid_assistant_tool_pair(self, handler):
        """OpenAI request building preserves complete assistant/tool pairs."""
        messages = [
            AssistantMessage(
                content="Calling a tool.",
                tool_calls=[
                    ToolCall(
                        id="call_123",
                        function=FunctionCall(name="get_weather", arguments="{}"),
                    )
                ],
            ),
            ToolMessage(tool_call_id="call_123", content="sunny"),
        ]

        body = handler.build_request(messages, tools=None, stream=False, merged={})

        assert len(body["messages"]) == 2
        assert body["messages"][0]["tool_calls"][0]["id"] == "call_123"
        assert body["messages"][1]["role"] == "tool"
        assert body["messages"][1]["tool_call_id"] == "call_123"

    # ─────────────────────────────────────────────────────────────────────────
    # Tool conversion tests
    # ─────────────────────────────────────────────────────────────────────────

    def test_convert_tools_none(self, handler):
        """convert_tools(None) returns None."""
        result = handler.convert_tools(None)
        assert result is None

    def test_convert_tools_empty_list(self, handler):
        """convert_tools([]) returns None."""
        result = handler.convert_tools([])
        assert result is None

    def test_convert_tools_single_function(self, handler):
        """Convert a single function tool."""
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "get_weather",
                    "description": "Get weather for a city",
                    "parameters": {
                        "type": "object",
                        "properties": {"city": {"type": "string"}},
                    },
                },
            }
        ]
        result = handler.convert_tools(tools)
        assert result is not None
        assert len(result) == 1
        assert result[0].function.name == "get_weather"
        assert result[0].function.description == "Get weather for a city"
        assert result[0].function.parameters is not None

    def test_convert_tools_multiple_functions(self, handler):
        """Convert multiple function tools."""
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "tool_a",
                    "description": "Tool A",
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "tool_b",
                    "description": "Tool B",
                },
            },
        ]
        result = handler.convert_tools(tools)
        assert result is not None
        assert len(result) == 2
        assert result[0].function.name == "tool_a"
        assert result[1].function.name == "tool_b"

    def test_convert_tools_skips_non_function_types(self, handler):
        """Skip tools that are not of type 'function'."""
        tools = [
            {
                "type": "function",
                "function": {"name": "tool_a", "description": "Tool A"},
            },
            {
                "type": "other",
                "function": {"name": "tool_b", "description": "Tool B"},
            },
        ]
        result = handler.convert_tools(tools)
        assert result is not None
        assert len(result) == 1
        assert result[0].function.name == "tool_a"

    # ─────────────────────────────────────────────────────────────────────────
    # Request building tests
    # ─────────────────────────────────────────────────────────────────────────

    def test_build_request_basic(self, handler):
        """Build a basic request without special parameters."""
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(messages, tools=None, stream=False, merged={})
        assert body["model"] == "gpt-4o"
        assert body["stream"] is False
        assert len(body["messages"]) == 1
        assert "tools" not in body  # exclude_none=True removes None values
        assert "stream_options" not in body

    def test_build_request_forwards_prompt_cache_key(self, handler):
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(
            messages,
            tools=None,
            stream=False,
            merged={"prompt_cache_key": "session-123"},
        )
        assert body["prompt_cache_key"] == "session-123"

    def test_build_request_with_temperature(self, handler):
        """Include temperature in request."""
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(
            messages, tools=None, stream=False, merged={"temperature": 0.7}
        )
        assert body["temperature"] == 0.7

    def test_build_request_with_top_p(self, handler):
        """Include top_p in request."""
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(
            messages, tools=None, stream=False, merged={"top_p": 0.9}
        )
        assert body["top_p"] == 0.9

    def test_build_request_with_max_tokens(self, handler):
        """``max_tokens`` from the caller routes to ``max_completion_tokens``.

        OpenAI's reasoning-capable models (o-series, gpt-5*, gpt-5.4*)
        reject the legacy ``max_tokens`` field with a 400
        ``unsupported_parameter`` error.  The handler maps the canonical
        caller-side name (``max_tokens``) to the wire field name OpenAI
        actually accepts (``max_completion_tokens``).  The legacy field
        must NOT appear in the body — sending both raises an
        ``unsupported_parameter`` error too.
        """
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(
            messages, tools=None, stream=False, merged={"max_tokens": 1000}
        )
        assert body["max_completion_tokens"] == 1000
        assert "max_tokens" not in body

    def test_build_request_max_tokens_uses_legacy_field_when_flag_off(self):
        """Subclasses can flip the flag to keep ``max_tokens`` on the wire.

        Deepseek's API still requires the legacy ``max_tokens`` name as
        of 2026-Q2 — verify the override mechanism works so
        ``_DeepSeekCompletionsHandler`` (and any future legacy-only
        OpenAI-compatible endpoints) can downgrade cleanly.
        """
        from app.agent.providers.openai.completions import CompletionsHandler

        class _LegacyHandler(CompletionsHandler):
            uses_max_completion_tokens = False

        handler = _LegacyHandler("deepseek-v4-pro", "https://api.deepseek.com/v1", {})
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(
            messages, tools=None, stream=False, merged={"max_tokens": 1000}
        )
        assert body["max_tokens"] == 1000
        assert "max_completion_tokens" not in body

    def test_build_request_streaming_includes_stream_options(self, handler):
        """Streaming request includes stream_options."""
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(messages, tools=None, stream=True, merged={})
        assert body["stream"] is True
        assert "stream_options" in body
        assert body["stream_options"]["include_usage"] is True

    def test_build_request_non_streaming_no_stream_options(self, handler):
        """Non-streaming request excludes stream_options."""
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(messages, tools=None, stream=False, merged={})
        assert body["stream"] is False
        assert "stream_options" not in body

    def test_build_request_thinking_level_low_maps_to_reasoning_effort(self, handler):
        """thinking_level: 'low' → reasoning_effort: 'low'."""
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(
            messages, tools=None, stream=False, merged={"thinking_level": "low"}
        )
        assert body["reasoning_effort"] == "low"

    def test_build_request_thinking_level_high_maps_to_reasoning_effort(self, handler):
        """thinking_level: 'high' → reasoning_effort: 'high'."""
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(
            messages, tools=None, stream=False, merged={"thinking_level": "high"}
        )
        assert body["reasoning_effort"] == "high"

    def test_build_request_thinking_level_none_omits_reasoning_effort(self, handler):
        """thinking_level: 'none' → no reasoning_effort."""
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(
            messages, tools=None, stream=False, merged={"thinking_level": "none"}
        )
        assert "reasoning_effort" not in body

    def test_build_request_thinking_level_off_omits_reasoning_effort(self, handler):
        """thinking_level: 'off' → no reasoning_effort."""
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(
            messages, tools=None, stream=False, merged={"thinking_level": "off"}
        )
        assert "reasoning_effort" not in body

    def test_build_request_no_thinking_level_omits_reasoning_effort(self, handler):
        """No thinking_level → no reasoning_effort."""
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(messages, tools=None, stream=False, merged={})
        assert "reasoning_effort" not in body

    def test_build_request_with_tools(self, handler):
        """Include tools in request."""
        messages = [HumanMessage(content="Hello")]
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "get_weather",
                    "description": "Get weather",
                },
            }
        ]
        body = handler.build_request(messages, tools=tools, stream=False, merged={})
        assert body["tools"] is not None
        assert len(body["tools"]) == 1

    def test_build_request_service_tier_official_url(self, handler):
        """Official OpenAI URL maps service_tier: 'fast' -> 'priority'."""
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(
            messages, tools=None, stream=False, merged={"service_tier": "fast"}
        )
        assert body["service_tier"] == "priority"

    def test_build_request_service_tier_custom_url(self):
        """Custom OpenAI compatible URL omits service_tier to avoid 400s."""
        handler = CompletionsHandler(
            model="gpt-4o",
            base_url="https://api.deepseek.com/v1",
            headers={"Authorization": "Bearer sk-test"},
        )
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(
            messages, tools=None, stream=False, merged={"service_tier": "fast"}
        )
        assert "service_tier" not in body

    # ─────────────────────────────────────────────────────────────────────────
    # Response parsing tests
    # ─────────────────────────────────────────────────────────────────────────

    def test_parse_response_text_only(self, handler):
        """Parse response with text content only."""
        data = {
            "id": "chatcmpl-123",
            "created": 1234567890,
            "model": "gpt-4o",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": "Hello, I can help!",
                    },
                    "finish_reason": "stop",
                }
            ],
        }
        result = handler.parse_response(data)
        assert isinstance(result, AssistantMessage)
        assert result.content == "Hello, I can help!"
        assert result.tool_calls is None
        assert result.reasoning_content is None

    def test_parse_response_with_tool_calls(self, handler):
        """Parse response with tool calls."""
        data = {
            "id": "chatcmpl-123",
            "created": 1234567890,
            "model": "gpt-4o",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": "I'll get the weather.",
                        "tool_calls": [
                            {
                                "id": "call_123",
                                "type": "function",
                                "function": {
                                    "name": "get_weather",
                                    "arguments": '{"city": "NYC"}',
                                },
                            }
                        ],
                    },
                    "finish_reason": "tool_calls",
                }
            ],
        }
        result = handler.parse_response(data)
        assert result.content == "I'll get the weather."
        assert result.tool_calls is not None
        assert len(result.tool_calls) == 1
        assert result.tool_calls[0].id == "call_123"
        assert result.tool_calls[0].function.name == "get_weather"
        assert result.tool_calls[0].function.arguments == '{"city": "NYC"}'

    def test_parse_response_with_reasoning_content(self, handler):
        """Parse response with reasoning_content (o-series models)."""
        data = {
            "id": "chatcmpl-123",
            "created": 1234567890,
            "model": "gpt-4o",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": "The answer is 42.",
                        "reasoning_content": "Let me think about this...",
                    },
                    "finish_reason": "stop",
                }
            ],
        }
        result = handler.parse_response(data)
        assert result.content == "The answer is 42."
        assert result.reasoning_content == "Let me think about this..."

    def test_parse_response_empty_choices(self, handler):
        """Parse response with empty choices."""
        data = {
            "id": "chatcmpl-123",
            "created": 1234567890,
            "model": "gpt-4o",
            "choices": [],
        }
        result = handler.parse_response(data)
        assert result.content is None
        assert result.tool_calls is None

    def test_parse_response_null_content(self, handler):
        """Parse response with null content."""
        data = {
            "id": "chatcmpl-123",
            "created": 1234567890,
            "model": "gpt-4o",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": None,
                    },
                    "finish_reason": "stop",
                }
            ],
        }
        result = handler.parse_response(data)
        assert result.content is None


# ─────────────────────────────────────────────────────────────────────────────
# Test ResponsesHandler
# ─────────────────────────────────────────────────────────────────────────────


# ─────────────────────────────────────────────────────────────────────────────
# Test CompletionsHandler.chat() and stream() — HTTP integration
# ─────────────────────────────────────────────────────────────────────────────


class TestCompletionsHandlerHTTP:
    """Test CompletionsHandler HTTP methods (chat and stream)."""

    @pytest.fixture
    def handler(self):
        """Create a CompletionsHandler instance."""
        return CompletionsHandler(
            model="gpt-4o",
            base_url="https://api.openai.com/v1",
            headers={"Authorization": "Bearer sk-test"},
        )

    async def test_chat_successful_response(self, handler):
        """Test successful chat() call with mocked httpx."""
        from unittest.mock import AsyncMock, patch

        messages = [HumanMessage(content="Hello")]
        response_data = {
            "id": "chatcmpl-123",
            "created": 1234567890,
            "model": "gpt-4o",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": "Hello, I can help!",
                    },
                    "finish_reason": "stop",
                }
            ],
        }

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json = MagicMock(return_value=response_data)

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)

        with patch("httpx.AsyncClient", return_value=mock_client):
            result = await handler.chat(messages, tools=None, merged={})

        assert isinstance(result, AssistantMessage)
        assert result.content == "Hello, I can help!"
        assert result.tool_calls is None

    async def test_chat_error_response(self, handler):
        """Test chat() with error response (status >= 400)."""
        from unittest.mock import AsyncMock, patch

        messages = [HumanMessage(content="Hello")]

        mock_response = MagicMock()
        mock_response.status_code = 401
        mock_response.text = "Unauthorized"
        mock_response.raise_for_status = MagicMock(
            side_effect=Exception("Unauthorized")
        )

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)

        with patch("httpx.AsyncClient", return_value=mock_client):
            with pytest.raises(Exception, match="Unauthorized"):
                await handler.chat(messages, tools=None, merged={})

    async def test_stream_successful_text_chunks(self, handler):
        """Test successful stream() with text chunks."""
        from unittest.mock import AsyncMock, patch
        from contextlib import asynccontextmanager

        messages = [HumanMessage(content="Hello")]

        # Mock SSE stream response
        async def mock_aiter_lines():
            yield (
                "data: "
                + '{"id":"chatcmpl-123","created":1234567890,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}'
            )
            yield (
                "data: "
                + '{"id":"chatcmpl-123","created":1234567890,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}'
            )
            yield (
                "data: "
                + '{"id":"chatcmpl-123","created":1234567890,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}'
            )
            yield (
                "data: "
                + '{"id":"chatcmpl-123","created":1234567890,"model":"gpt-4o","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}'
            )
            yield "data: [DONE]"

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.aiter_lines = mock_aiter_lines

        @asynccontextmanager
        async def mock_stream(*args, **kwargs):
            yield mock_response

        mock_client = AsyncMock()
        mock_client.stream = mock_stream
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)

        with patch("httpx.AsyncClient", return_value=mock_client):
            chunks = []
            async for chunk in handler.stream(messages, tools=None, merged={}):
                chunks.append(chunk)

        # Should have 4 chunks: 2 text deltas + 1 done + 1 usage
        assert len(chunks) == 4
        assert chunks[0].choices[0].delta.content == "Hello"
        assert chunks[1].choices[0].delta.content == " world"
        assert chunks[2].choices[0].finish_reason == "stop"
        assert chunks[3].usage is not None
        assert chunks[3].usage.prompt_tokens == 10

    async def test_stream_with_tool_calls(self, handler):
        """Test stream() with tool call chunks."""
        from unittest.mock import AsyncMock, patch
        from contextlib import asynccontextmanager

        messages = [HumanMessage(content="Call a tool")]

        async def mock_aiter_lines():
            yield (
                "data: "
                + '{"id":"chatcmpl-123","created":1234567890,"model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_123","function":{"name":"get_weather","arguments":"{\\"city"}}]},"finish_reason":null}]}'
            )
            yield (
                "data: "
                + '{"id":"chatcmpl-123","created":1234567890,"model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_123","function":{"name":null,"arguments":"\\": \\"NYC\\"}"}}]},"finish_reason":null}]}'
            )
            yield (
                "data: "
                + '{"id":"chatcmpl-123","created":1234567890,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}'
            )
            yield (
                "data: "
                + '{"id":"chatcmpl-123","created":1234567890,"model":"gpt-4o","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}'
            )
            yield "data: [DONE]"

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.aiter_lines = mock_aiter_lines

        @asynccontextmanager
        async def mock_stream(*args, **kwargs):
            yield mock_response

        mock_client = AsyncMock()
        mock_client.stream = mock_stream
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)

        with patch("httpx.AsyncClient", return_value=mock_client):
            chunks = []
            async for chunk in handler.stream(messages, tools=None, merged={}):
                chunks.append(chunk)

        # Should have 4 chunks: 2 tool call deltas + 1 done + 1 usage
        assert len(chunks) == 4
        assert chunks[0].choices[0].delta.tool_calls is not None
        assert chunks[0].choices[0].delta.tool_calls[0].id == "call_123"

    async def test_stream_error_response(self, handler):
        """Test stream() with error response (status >= 400)."""
        from unittest.mock import AsyncMock, patch
        from contextlib import asynccontextmanager

        messages = [HumanMessage(content="Hello")]

        mock_response = MagicMock()
        mock_response.status_code = 500
        mock_response.aread = AsyncMock(return_value=b"Internal Server Error")
        mock_response.raise_for_status = MagicMock(
            side_effect=Exception("Server Error")
        )

        @asynccontextmanager
        async def mock_stream(*args, **kwargs):
            yield mock_response

        mock_client = AsyncMock()
        mock_client.stream = mock_stream
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)

        with patch("httpx.AsyncClient", return_value=mock_client):
            with pytest.raises(Exception, match="Server Error"):
                async for _ in handler.stream(messages, tools=None, merged={}):
                    pass

    async def test_stream_usage_only_chunk(self, handler):
        """Test stream() with usage-only chunk (no choices)."""
        from unittest.mock import AsyncMock, patch
        from contextlib import asynccontextmanager

        messages = [HumanMessage(content="Hello")]

        async def mock_aiter_lines():
            yield (
                "data: "
                + '{"id":"chatcmpl-123","created":1234567890,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}'
            )
            yield (
                "data: "
                + '{"id":"chatcmpl-123","created":1234567890,"model":"gpt-4o","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}'
            )
            yield "data: [DONE]"

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.aiter_lines = mock_aiter_lines

        @asynccontextmanager
        async def mock_stream(*args, **kwargs):
            yield mock_response

        mock_client = AsyncMock()
        mock_client.stream = mock_stream
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)

        with patch("httpx.AsyncClient", return_value=mock_client):
            chunks = []
            async for chunk in handler.stream(messages, tools=None, merged={}):
                chunks.append(chunk)

        # Should have 2 chunks: 1 text + 1 usage
        assert len(chunks) == 2
        assert chunks[0].choices[0].delta.content == "Hello"
        assert chunks[1].usage is not None


# ─────────────────────────────────────────────────────────────────────────────
# Test CompletionsHandler._usage_from_openai() and _usage_chunk()
# ─────────────────────────────────────────────────────────────────────────────


# ─────────────────────────────────────────────────────────────────────────────
# Test CompletionsHandler._usage_from_openai() and _usage_chunk()
# ─────────────────────────────────────────────────────────────────────────────


class TestCompletionsHandlerUsage:
    """Test usage parsing and chunk creation."""

    @pytest.fixture
    def handler(self):
        """Create a CompletionsHandler instance."""
        return CompletionsHandler(
            model="gpt-4o",
            base_url="https://api.openai.com/v1",
            headers={"Authorization": "Bearer sk-test"},
        )

    def test_usage_from_openai_with_cached_tokens(self, handler):
        """Test _usage_from_openai with cached_tokens in prompt_tokens_details."""
        from app.agent.providers.openai.schemas import (
            OpenAIUsage,
            OpenAIPromptTokensDetails,
        )

        usage = OpenAIUsage(
            prompt_tokens=100,
            completion_tokens=50,
            total_tokens=150,
            prompt_tokens_details=OpenAIPromptTokensDetails(cached_tokens=10),
        )

        result = handler._usage_from_openai(usage)
        assert result.prompt_tokens == 100
        assert result.completion_tokens == 50
        assert result.total_tokens == 150
        assert result.cached_tokens == 10
        assert result.thoughts_tokens is None

    def test_usage_from_openai_with_reasoning_tokens(self, handler):
        """Test _usage_from_openai with reasoning_tokens in completion_tokens_details."""
        from app.agent.providers.openai.schemas import (
            OpenAIUsage,
            OpenAICompletionTokensDetails,
        )

        usage = OpenAIUsage(
            prompt_tokens=100,
            completion_tokens=50,
            total_tokens=150,
            completion_tokens_details=OpenAICompletionTokensDetails(
                reasoning_tokens=20
            ),
        )

        result = handler._usage_from_openai(usage)
        assert result.prompt_tokens == 100
        assert result.completion_tokens == 50
        assert result.total_tokens == 150
        assert result.cached_tokens is None
        assert result.thoughts_tokens == 20

    def test_usage_from_openai_with_both_details(self, handler):
        """Test _usage_from_openai with both cached and reasoning tokens."""
        from app.agent.providers.openai.schemas import (
            OpenAIUsage,
            OpenAIPromptTokensDetails,
            OpenAICompletionTokensDetails,
        )

        usage = OpenAIUsage(
            prompt_tokens=100,
            completion_tokens=50,
            total_tokens=150,
            prompt_tokens_details=OpenAIPromptTokensDetails(cached_tokens=10),
            completion_tokens_details=OpenAICompletionTokensDetails(
                reasoning_tokens=20
            ),
        )

        result = handler._usage_from_openai(usage)
        assert result.cached_tokens == 10
        assert result.thoughts_tokens == 20

    def test_usage_from_openai_with_none_details(self, handler):
        """Test _usage_from_openai with None details."""
        from app.agent.providers.openai.schemas import OpenAIUsage

        usage = OpenAIUsage(
            prompt_tokens=100,
            completion_tokens=50,
            total_tokens=150,
            prompt_tokens_details=None,
            completion_tokens_details=None,
        )

        result = handler._usage_from_openai(usage)
        assert result.cached_tokens is None
        assert result.thoughts_tokens is None

    def test_usage_from_openai_with_zero_cached_tokens(self, handler):
        """Test _usage_from_openai with zero cached_tokens (should be None)."""
        from app.agent.providers.openai.schemas import (
            OpenAIUsage,
            OpenAIPromptTokensDetails,
        )

        usage = OpenAIUsage(
            prompt_tokens=100,
            completion_tokens=50,
            total_tokens=150,
            prompt_tokens_details=OpenAIPromptTokensDetails(cached_tokens=0),
        )

        result = handler._usage_from_openai(usage)
        assert result.cached_tokens is None

    def test_usage_chunk(self, handler):
        """Test _usage_chunk creates a chunk with usage and empty choices."""
        from app.agent.providers.openai.schemas import (
            OpenAIStreamChunk,
            OpenAIUsage,
        )

        chunk = OpenAIStreamChunk(
            id="chatcmpl-123",
            created=1234567890,
            model="gpt-4o",
            choices=[],
            usage=OpenAIUsage(
                prompt_tokens=10,
                completion_tokens=5,
                total_tokens=15,
            ),
        )

        result = handler._usage_chunk(chunk)
        assert result.id == "chatcmpl-123"
        assert result.created == 1234567890
        assert result.model == "gpt-4o"
        assert result.choices == []
        assert result.usage is not None
        assert result.usage.prompt_tokens == 10


# ─────────────────────────────────────────────────────────────────────────────
# Test ToolMessage with ImageUrlBlock detail field
# ─────────────────────────────────────────────────────────────────────────────


# ─────────────────────────────────────────────────────────────────────────────
# Test ToolMessage with ImageUrlBlock detail field
# ─────────────────────────────────────────────────────────────────────────────


class TestCompletionsHandlerToolMessageWithImageDetail:
    """Test ToolMessage conversion with ImageUrlBlock detail field."""

    @pytest.fixture
    def handler(self):
        """Create a CompletionsHandler instance."""
        return CompletionsHandler(
            model="gpt-4o",
            base_url="https://api.openai.com/v1",
            headers={"Authorization": "Bearer sk-test"},
        )

    def test_convert_tool_message_with_image_url_detail_high(self, handler):
        """Convert ToolMessage with ImageUrlBlock detail='high'."""
        messages = [
            ToolMessage(
                tool_call_id="call_123",
                name="read_image",
                parts=[
                    ImageUrlBlock(url="https://example.com/image.jpg", detail="high"),
                ],
            )
        ]
        result = handler.convert_messages(messages)
        assert len(result) == 1
        assert result[0].role == "tool"
        assert isinstance(result[0].content, list)
        assert result[0].content[0]["type"] == "image_url"
        assert (
            result[0].content[0]["image_url"]["url"] == "https://example.com/image.jpg"
        )
        assert result[0].content[0]["image_url"]["detail"] == "high"

    def test_convert_tool_message_with_image_url_detail_low(self, handler):
        """Convert ToolMessage with ImageUrlBlock detail='low'."""
        messages = [
            ToolMessage(
                tool_call_id="call_123",
                name="read_image",
                parts=[
                    ImageUrlBlock(url="https://example.com/image.jpg", detail="low"),
                ],
            )
        ]
        result = handler.convert_messages(messages)
        assert result[0].content[0]["image_url"]["detail"] == "low"

    def test_convert_tool_message_with_image_url_no_detail(self, handler):
        """Convert ToolMessage with ImageUrlBlock without detail."""
        messages = [
            ToolMessage(
                tool_call_id="call_123",
                name="read_image",
                parts=[
                    ImageUrlBlock(url="https://example.com/image.jpg"),
                ],
            )
        ]
        result = handler.convert_messages(messages)
        # detail should not be in the dict if not provided
        assert "detail" not in result[0].content[0]["image_url"]

    def test_convert_tool_message_with_image_data(self, handler):
        """Convert ToolMessage with ImageDataBlock."""
        messages = [
            ToolMessage(
                tool_call_id="call_123",
                name="read_image",
                parts=[
                    ImageDataBlock(data="iVBORw0KGgo=", media_type="image/png"),
                ],
            )
        ]
        result = handler.convert_messages(messages)
        assert len(result) == 1
        assert result[0].role == "tool"
        assert isinstance(result[0].content, list)
        assert result[0].content[0]["type"] == "image_url"
        assert "data:image/png;base64," in result[0].content[0]["image_url"]["url"]


# ─────────────────────────────────────────────────────────────────────────────
# Test ResponsesHandler.chat() and stream() — HTTP integration
# ─────────────────────────────────────────────────────────────────────────────
