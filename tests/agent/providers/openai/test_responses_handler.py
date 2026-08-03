"""Tests for `ResponsesHandler` — request building, response parsing,
and HTTP integration (non-streaming).

Streaming behaviour is in `test_responses_streaming.py`.
See `app/agent/providers/openai/responses.py`.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from app.agent.providers.openai.responses import ResponsesHandler
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
# Test ResponsesHandler
# ─────────────────────────────────────────────────────────────────────────────


class TestResponsesHandler:
    """Test Responses API handler."""

    @pytest.fixture
    def handler(self):
        """Create a ResponsesHandler instance."""
        return ResponsesHandler(
            model="gpt-5.4",
            base_url="https://api.openai.com/v1",
            headers={"Authorization": "Bearer sk-test"},
        )

    # ─────────────────────────────────────────────────────────────────────────
    # Message conversion tests
    # ─────────────────────────────────────────────────────────────────────────

    def test_convert_messages_system_message(self, handler):
        """Convert SystemMessage to Responses API format."""
        messages = [SystemMessage(content="You are helpful.")]
        result = handler.convert_messages(messages)
        assert len(result) == 1
        assert result[0]["role"] == "system"
        assert result[0]["content"] == "You are helpful."

    def test_convert_messages_human_message_text_only(self, handler):
        """Convert HumanMessage with plain text."""
        messages = [HumanMessage(content="Hello")]
        result = handler.convert_messages(messages)
        assert len(result) == 1
        assert result[0]["role"] == "user"
        assert result[0]["content"] == "Hello"

    def test_convert_messages_empty_text_content_uses_string(self, handler):
        """Responses API text message content must not be null."""
        messages = [SystemMessage(content=None), HumanMessage(content=None)]
        result = handler.convert_messages(messages)
        assert result == [
            {"role": "system", "content": ""},
            {"role": "user", "content": ""},
        ]

    def test_convert_messages_human_message_with_parts(self, handler):
        """Convert HumanMessage with multimodal parts."""
        messages = [
            HumanMessage(
                parts=[
                    TextBlock(text="Describe this:"),
                    ImageUrlBlock(url="https://example.com/img.jpg", detail="high"),
                ]
            )
        ]
        result = handler.convert_messages(messages)
        assert len(result) == 1
        assert result[0]["role"] == "user"
        assert isinstance(result[0]["content"], list)
        assert len(result[0]["content"]) == 2
        assert result[0]["content"][0]["type"] == "input_text"
        assert result[0]["content"][1]["type"] == "input_image"
        assert result[0]["content"][1]["image_url"] == "https://example.com/img.jpg"
        assert result[0]["content"][1]["detail"] == "high"

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
        assert isinstance(result[0]["content"], list)
        assert result[0]["content"][0]["type"] == "input_image"
        assert "data:image/png;base64," in result[0]["content"][0]["image_url"]

    def test_convert_messages_assistant_message_text_only(self, handler):
        """Convert AssistantMessage with text."""
        messages = [AssistantMessage(content="I can help.")]
        result = handler.convert_messages(messages)
        assert len(result) == 1
        assert result[0]["role"] == "assistant"
        assert result[0]["content"] == [{"type": "output_text", "text": "I can help."}]

    def test_convert_messages_assistant_message_with_tool_calls(self, handler):
        """Convert AssistantMessage with tool calls."""
        messages = [
            AssistantMessage(
                content="Calling a tool.",
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
        # Should have 2 items: content + function_call
        assert len(result) == 2
        assert result[0]["role"] == "assistant"
        assert result[0]["content"] == [
            {"type": "output_text", "text": "Calling a tool."}
        ]
        assert result[1]["type"] == "function_call"
        assert result[1]["call_id"] == "call_123"
        assert result[1]["name"] == "get_weather"
        assert result[1]["arguments"] == '{"city": "NYC"}'

    def test_convert_messages_replays_reasoning_item_before_function_call(
        self, handler
    ):
        """A stored reasoning item (with encrypted_content) must be replayed
        as its own `type: reasoning` input item, ahead of the function_call it
        preceded — matching upstream Codex CLI's verbatim history replay."""
        messages = [
            AssistantMessage(
                content="Calling a tool.",
                reasoning_item_id="rs_1",
                reasoning_encrypted_content="cipher123",
                tool_calls=[
                    ToolCall(
                        id="call_123",
                        function=FunctionCall(name="get_weather", arguments="{}"),
                    ),
                ],
            )
        ]
        result = handler.convert_messages(messages)
        assert [item.get("type") for item in result] == [
            "reasoning",
            None,  # the assistant text message item has no "type" key, only "role"
            "function_call",
        ]
        assert result[0] == {
            "type": "reasoning",
            "id": "rs_1",
            "summary": [],
            "encrypted_content": "cipher123",
        }

    def test_convert_messages_replays_reasoning_summary_text(self, handler):
        """When the assistant message carries reasoning_content (the readable
        summary text streamed to the user), it must be replayed as a
        summary_text entry alongside encrypted_content — matching upstream
        Codex CLI, which stores and replays `ResponseItem::Reasoning.summary`
        verbatim (no `skip_serializing_if`) rather than dropping it."""
        messages = [
            AssistantMessage(
                content="Calling a tool.",
                reasoning_content="**Thinking about it**",
                reasoning_item_id="rs_1",
                reasoning_encrypted_content="cipher123",
                tool_calls=[
                    ToolCall(
                        id="call_123",
                        function=FunctionCall(name="get_weather", arguments="{}"),
                    ),
                ],
            )
        ]
        result = handler.convert_messages(messages)
        assert result[0] == {
            "type": "reasoning",
            "id": "rs_1",
            "summary": [{"type": "summary_text", "text": "**Thinking about it**"}],
            "encrypted_content": "cipher123",
        }

    def test_convert_messages_no_reasoning_item_without_encrypted_content(
        self, handler
    ):
        """Assistant messages without a stored reasoning item emit no extra item."""
        messages = [
            AssistantMessage(
                tool_calls=[
                    ToolCall(
                        id="call_123",
                        function=FunctionCall(name="get_weather", arguments="{}"),
                    ),
                ],
            )
        ]
        result = handler.convert_messages(messages)
        assert not any(item.get("type") == "reasoning" for item in result)

    def test_convert_messages_assistant_message_skips_empty_tool_call_id(self, handler):
        """Skip tool calls with empty call_id."""
        messages = [
            AssistantMessage(
                tool_calls=[
                    ToolCall(
                        id="",  # Empty ID
                        function=FunctionCall(
                            name="get_weather",
                            arguments="{}",
                        ),
                    ),
                ],
            )
        ]
        result = handler.convert_messages(messages)
        # Should be empty since tool call has no ID
        assert len(result) == 0

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
        assert result[0]["type"] == "function_call_output"
        assert result[0]["call_id"] == "call_123"
        assert result[0]["output"] == "Sunny, 72°F"

    def test_convert_messages_tool_message_skips_empty_call_id(self, handler):
        """Skip ToolMessage with empty tool_call_id."""
        messages = [
            ToolMessage(
                tool_call_id="",  # Empty ID
                name="get_weather",
                content="Sunny",
            )
        ]
        result = handler.convert_messages(messages)
        # Should be empty since tool_call_id is empty
        assert len(result) == 0

    def test_convert_messages_tool_message_with_parts(self, handler):
        """Convert multimodal tool output to Responses API content items."""
        messages = [
            ToolMessage(
                tool_call_id="call_123",
                name="read_file",
                parts=[
                    TextBlock(text="[Image: chart.png]"),
                    ImageDataBlock(data="iVBORw0KGgo=", media_type="image/png"),
                    ImageUrlBlock(
                        url="https://example.com/reference.jpg", detail="high"
                    ),
                ],
            )
        ]

        result = handler.convert_messages(messages)

        assert result == [
            {
                "type": "function_call_output",
                "call_id": "call_123",
                "output": [
                    {"type": "input_text", "text": "[Image: chart.png]"},
                    {
                        "type": "input_image",
                        "image_url": "data:image/png;base64,iVBORw0KGgo=",
                        "detail": "auto",
                    },
                    {
                        "type": "input_image",
                        "image_url": "https://example.com/reference.jpg",
                        "detail": "high",
                    },
                ],
            }
        ]

    def test_build_request_drops_orphan_tool_message(self, handler):
        """Responses request building drops invalid function_call_output items."""
        messages = [
            HumanMessage(content="Hello"),
            ToolMessage(tool_call_id="missing_call", content="orphan"),
        ]

        body = handler.build_request(messages, tools=None, stream=False, merged={})

        assert len(body["input"]) == 1
        assert body["input"][0]["role"] == "user"

    def test_build_request_strips_incomplete_assistant_tool_calls(self, handler):
        """Responses request building does not send function_call without output."""
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

        assert len(body["input"]) == 2
        assert body["input"][0]["role"] == "assistant"
        assert body["input"][1]["role"] == "user"
        assert not any(item.get("type") == "function_call" for item in body["input"])

    def test_build_request_keeps_valid_assistant_tool_pair(self, handler):
        """Responses request building preserves complete function call pairs."""
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

        assert len(body["input"]) == 3
        assert body["input"][1]["type"] == "function_call"
        assert body["input"][1]["call_id"] == "call_123"
        assert body["input"][2]["type"] == "function_call_output"
        assert body["input"][2]["call_id"] == "call_123"

    # ─────────────────────────────────────────────────────────────────────────
    # Tool conversion tests
    # ─────────────────────────────────────────────────────────────────────────

    def test_convert_tools_none(self, handler):
        """convert_tools(None) returns empty list."""
        result = handler.convert_tools(None)
        assert result == []

    def test_convert_tools_empty_list(self, handler):
        """convert_tools([]) returns empty list."""
        result = handler.convert_tools([])
        assert result == []

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
        assert len(result) == 1
        assert result[0]["type"] == "function"
        assert result[0]["name"] == "get_weather"
        assert result[0]["description"] == "Get weather for a city"
        assert result[0]["parameters"] is not None

    def test_convert_tools_multiple_functions(self, handler):
        """Convert multiple function tools."""
        tools = [
            {
                "type": "function",
                "function": {"name": "tool_a", "description": "Tool A"},
            },
            {
                "type": "function",
                "function": {"name": "tool_b", "description": "Tool B"},
            },
        ]
        result = handler.convert_tools(tools)
        assert len(result) == 2
        assert result[0]["name"] == "tool_a"
        assert result[1]["name"] == "tool_b"

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
        assert len(result) == 1
        assert result[0]["name"] == "tool_a"

    # ─────────────────────────────────────────────────────────────────────────
    # Request building tests
    # ─────────────────────────────────────────────────────────────────────────

    def test_build_request_basic(self, handler):
        """Build a basic request."""
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(messages, tools=None, stream=False, merged={})
        assert body["model"] == "gpt-5.4"
        assert body["stream"] is False
        assert len(body["input"]) == 1
        assert "tools" not in body

    def test_build_request_forwards_prompt_cache_key(self, handler):
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(
            messages,
            tools=None,
            stream=False,
            merged={"prompt_cache_key": "session-123"},
        )
        assert body["prompt_cache_key"] == "session-123"

    def test_build_request_omits_temperature(self, handler):
        """Responses API does not support temperature."""
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(
            messages, tools=None, stream=False, merged={"temperature": 0.7}
        )
        assert "temperature" not in body

    def test_build_request_omits_top_p(self, handler):
        """Responses API does not support top_p."""
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(
            messages, tools=None, stream=False, merged={"top_p": 0.9}
        )
        assert "top_p" not in body

    def test_build_request_maps_max_tokens_to_max_output_tokens(self, handler):
        """max_tokens → max_output_tokens."""
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(
            messages, tools=None, stream=False, merged={"max_tokens": 1000}
        )
        assert body["max_output_tokens"] == 1000
        assert "max_tokens" not in body

    def test_build_request_service_tier_official_url(self, handler):
        """Official OpenAI URL maps service_tier: 'fast' -> 'priority'."""
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(
            messages, tools=None, stream=False, merged={"service_tier": "fast"}
        )
        assert body["service_tier"] == "priority"

    def test_build_request_service_tier_custom_url(self):
        """Custom OpenAI compatible URL omits service_tier to avoid 400s."""
        from app.agent.providers.openai.responses import ResponsesHandler

        handler = ResponsesHandler(
            model="gpt-4o",
            base_url="https://api.deepseek.com/v1",
            headers={"Authorization": "Bearer sk-test"},
        )
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(
            messages, tools=None, stream=False, merged={"service_tier": "fast"}
        )
        assert "service_tier" not in body

    def test_build_request_thinking_level_low_maps_to_reasoning(self, handler):
        """thinking_level: 'low' → reasoning: {effort: 'low', summary: 'auto'}."""
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(
            messages, tools=None, stream=False, merged={"thinking_level": "low"}
        )
        assert "reasoning" in body
        assert body["reasoning"]["effort"] == "low"
        assert body["reasoning"]["summary"] == "auto"

    def test_build_request_thinking_level_high_maps_to_reasoning(self, handler):
        """thinking_level: 'high' → reasoning: {effort: 'high', summary: 'auto'}."""
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(
            messages, tools=None, stream=False, merged={"thinking_level": "high"}
        )
        assert body["reasoning"]["effort"] == "high"

    def test_build_request_thinking_level_none_omits_reasoning(self, handler):
        """thinking_level: 'none' → no reasoning."""
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(
            messages, tools=None, stream=False, merged={"thinking_level": "none"}
        )
        assert "reasoning" not in body

    def test_build_request_thinking_level_off_omits_reasoning(self, handler):
        """thinking_level: 'off' → no reasoning."""
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(
            messages, tools=None, stream=False, merged={"thinking_level": "off"}
        )
        assert "reasoning" not in body

    def test_build_request_no_thinking_level_omits_reasoning(self, handler):
        """No thinking_level → no reasoning."""
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(messages, tools=None, stream=False, merged={})
        assert "reasoning" not in body

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
        assert "tools" in body
        assert len(body["tools"]) == 1

    # ─────────────────────────────────────────────────────────────────────────
    # Response parsing tests
    # ─────────────────────────────────────────────────────────────────────────

    def test_parse_response_text_only(self, handler):
        """Parse response with text content."""
        data = {
            "output": [
                {
                    "type": "message",
                    "content": [{"type": "output_text", "text": "Hello, I can help!"}],
                }
            ]
        }
        result = handler.parse_response(data)
        assert result.content == "Hello, I can help!"
        assert result.tool_calls is None
        assert result.reasoning_content is None

    def test_parse_response_multiple_text_parts(self, handler):
        """Parse response with multiple text parts (joined with newline)."""
        data = {
            "output": [
                {
                    "type": "message",
                    "content": [
                        {"type": "output_text", "text": "Part 1"},
                        {"type": "output_text", "text": "Part 2"},
                    ],
                }
            ]
        }
        result = handler.parse_response(data)
        assert result.content == "Part 1\nPart 2"

    def test_parse_response_captures_reasoning_encrypted_content(self, handler):
        """`encrypted_content` on the reasoning item must be surfaced so it can
        be replayed as history on the next turn (see `convert_messages`)."""
        data = {
            "output": [
                {
                    "type": "reasoning",
                    "id": "rs_1",
                    "summary": [{"type": "summary_text", "text": "Let me think..."}],
                    "encrypted_content": "cipher123",
                },
                {
                    "type": "message",
                    "content": [{"type": "output_text", "text": "The answer is 42."}],
                },
            ]
        }
        result = handler.parse_response(data)
        assert result.reasoning_item_id == "rs_1"
        assert result.reasoning_encrypted_content == "cipher123"

    def test_parse_response_without_encrypted_content_leaves_fields_none(self, handler):
        """No `include: reasoning.encrypted_content` requested -> nothing to capture."""
        data = {
            "output": [
                {
                    "type": "reasoning",
                    "id": "rs_1",
                    "summary": [{"type": "summary_text", "text": "Let me think..."}],
                },
            ]
        }
        result = handler.parse_response(data)
        assert result.reasoning_item_id is None
        assert result.reasoning_encrypted_content is None

    def test_parse_response_with_reasoning(self, handler):
        """Parse response with reasoning content."""
        data = {
            "output": [
                {
                    "type": "reasoning",
                    "summary": [{"type": "summary_text", "text": "Let me think..."}],
                },
                {
                    "type": "message",
                    "content": [{"type": "output_text", "text": "The answer is 42."}],
                },
            ]
        }
        result = handler.parse_response(data)
        assert result.reasoning_content == "Let me think..."
        assert result.content == "The answer is 42."

    def test_parse_response_joins_multiple_reasoning_summary_parts_with_blank_line(
        self, handler
    ):
        """Multiple ``summary_text`` parts in a single reasoning item must be
        joined by a blank line — each part carries its own ``**Header**`` and
        single-newline joins would glue the next header onto the prior body.
        """
        data = {
            "output": [
                {
                    "type": "reasoning",
                    "summary": [
                        {"type": "summary_text", "text": "**One**\n\nFirst body."},
                        {"type": "summary_text", "text": "**Two**\n\nSecond body."},
                    ],
                },
                {
                    "type": "message",
                    "content": [{"type": "output_text", "text": "final"}],
                },
            ]
        }
        result = handler.parse_response(data)
        assert result.reasoning_content is not None
        assert "First body.\n\n**Two**" in result.reasoning_content
        assert "First body.**Two**" not in result.reasoning_content

    def test_parse_response_with_tool_calls(self, handler):
        """Parse response with function calls."""
        data = {
            "output": [
                {
                    "type": "function_call",
                    "call_id": "fc_123",
                    "name": "get_weather",
                    "arguments": '{"city": "NYC"}',
                }
            ]
        }
        result = handler.parse_response(data)
        assert result.tool_calls is not None
        assert len(result.tool_calls) == 1
        assert result.tool_calls[0].id == "fc_123"
        assert result.tool_calls[0].function.name == "get_weather"
        assert result.tool_calls[0].function.arguments == '{"city": "NYC"}'

    def test_parse_response_empty_output(self, handler):
        """Parse response with empty output."""
        data = {"output": []}
        result = handler.parse_response(data)
        assert result.content is None
        assert result.tool_calls is None

    def test_parse_response_no_output_key(self, handler):
        """Parse response without output key."""
        data = {}
        result = handler.parse_response(data)
        assert result.content is None
        assert result.tool_calls is None


# ─────────────────────────────────────────────────────────────────────────────
# Test ResponsesHandler streaming parser
# ─────────────────────────────────────────────────────────────────────────────


# ─────────────────────────────────────────────────────────────────────────────
# Test ResponsesHandler.chat() and stream() — HTTP integration
# ─────────────────────────────────────────────────────────────────────────────


class TestResponsesHandlerHTTP:
    """Test ResponsesHandler HTTP methods (chat and stream)."""

    @pytest.fixture
    def handler(self):
        """Create a ResponsesHandler instance."""
        return ResponsesHandler(
            model="gpt-5.4",
            base_url="https://api.openai.com/v1",
            headers={"Authorization": "Bearer sk-test"},
        )

    async def test_chat_successful_response(self, handler):
        """Test successful chat() call with mocked httpx."""
        from unittest.mock import AsyncMock, patch

        messages = [HumanMessage(content="Hello")]
        response_data = {
            "output": [
                {
                    "type": "message",
                    "content": [{"type": "output_text", "text": "Hello, I can help!"}],
                }
            ]
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

    async def test_stream_successful_response(self, handler):
        """Test successful stream() call."""
        from unittest.mock import AsyncMock, patch
        from contextlib import asynccontextmanager

        messages = [HumanMessage(content="Hello")]

        async def mock_aiter_lines():
            yield "event: response.created"
            yield 'data: {"type": "response.created", "response": {"id": "resp_123"}}'
            yield "event: response.output_text.delta"
            yield 'data: {"type": "response.output_text.delta", "delta": "Hello"}'
            yield "event: response.output_text.done"
            yield 'data: {"type": "response.output_text.done"}'
            yield "event: response.completed"
            yield 'data: {"type": "response.completed", "response": {"id": "resp_123", "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}}}'

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

        # Should have 3 chunks: 1 text + 1 done + 1 usage
        assert len(chunks) == 3
        assert chunks[0].choices[0].delta.content == "Hello"
        assert chunks[1].choices[0].finish_reason == "stop"
        assert chunks[2].usage is not None

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


# ─────────────────────────────────────────────────────────────────────────────
# Test ResponsesHandler._parse_stream() edge cases
# ─────────────────────────────────────────────────────────────────────────────
