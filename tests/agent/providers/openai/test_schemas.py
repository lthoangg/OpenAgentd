"""Tests for app/providers/openai/schemas.py — wire format Pydantic models."""

from app.agent.providers.openai.schemas import (
    OpenAIChatRequest,
    OpenAIChatResponse,
    OpenAICompletionTokensDetails,
    OpenAIFunctionCall,
    OpenAIMessage,
    OpenAIPromptTokensDetails,
    OpenAIStreamChunk,
    OpenAIStreamOptions,
    OpenAITool,
    OpenAIToolCall,
    OpenAIUsage,
)


# ---------------------------------------------------------------------------
# Request schemas
# ---------------------------------------------------------------------------


class TestOpenAIMessage:
    def test_system_message(self):
        msg = OpenAIMessage(role="system", content="You are helpful.")
        assert msg.role == "system"
        assert msg.content == "You are helpful."
        assert msg.tool_calls is None
        assert msg.tool_call_id is None

    def test_user_message(self):
        msg = OpenAIMessage(role="user", content="Hello")
        assert msg.role == "user"

    def test_assistant_message_with_tool_calls(self):
        tc = OpenAIToolCall(
            id="call_abc",
            function=OpenAIFunctionCall(
                name="get_weather", arguments='{"city":"Paris"}'
            ),
        )
        msg = OpenAIMessage(role="assistant", content=None, tool_calls=[tc])
        assert msg.tool_calls is not None
        assert msg.tool_calls[0].id == "call_abc"
        assert msg.tool_calls[0].function.name == "get_weather"

    def test_tool_message(self):
        msg = OpenAIMessage(
            role="tool", content="25°C", tool_call_id="call_abc", name="get_weather"
        )
        assert msg.role == "tool"
        assert msg.tool_call_id == "call_abc"
        assert msg.name == "get_weather"


class TestOpenAIChatRequest:
    def test_minimal_request(self):
        req = OpenAIChatRequest(
            model="gpt-4o",
            messages=[OpenAIMessage(role="user", content="hi")],
        )
        assert req.model == "gpt-4o"
        assert req.stream is False
        assert req.tools is None

    def test_stream_options(self):
        opts = OpenAIStreamOptions(include_usage=True)
        req = OpenAIChatRequest(
            model="gpt-4o",
            messages=[OpenAIMessage(role="user", content="hi")],
            stream=True,
            stream_options=opts,
        )
        assert req.stream is True
        assert req.stream_options is not None
        assert req.stream_options.include_usage is True

    def test_tool_type_default(self):
        tc = OpenAIToolCall(
            id="c1", function=OpenAIFunctionCall(name="fn", arguments="{}")
        )
        assert tc.type == "function"

    def test_openai_tool_type_default(self):
        tool = OpenAITool(function={"name": "fn", "description": "desc"})  # type: ignore[arg-type]
        assert tool.type == "function"


# ---------------------------------------------------------------------------
# Usage schemas
# ---------------------------------------------------------------------------


class TestOpenAIUsage:
    def test_prompt_tokens_details_defaults(self):
        d = OpenAIPromptTokensDetails()
        assert d.cached_tokens == 0
        assert d.audio_tokens == 0

    def test_completion_tokens_details_defaults(self):
        d = OpenAICompletionTokensDetails()
        assert d.reasoning_tokens == 0
        assert d.accepted_prediction_tokens == 0
        assert d.rejected_prediction_tokens == 0

    def test_usage_with_details(self):
        u = OpenAIUsage(
            prompt_tokens=10,
            completion_tokens=5,
            total_tokens=15,
            prompt_tokens_details=OpenAIPromptTokensDetails(cached_tokens=3),
            completion_tokens_details=OpenAICompletionTokensDetails(reasoning_tokens=2),
        )
        assert u.prompt_tokens == 10
        assert u.prompt_tokens_details is not None
        assert u.prompt_tokens_details.cached_tokens == 3
        assert u.completion_tokens_details is not None
        assert u.completion_tokens_details.reasoning_tokens == 2

    def test_usage_extra_fields_ignored(self):
        """extra="ignore" means unknown fields don't raise."""
        u = OpenAIUsage.model_validate(
            {
                "prompt_tokens": 1,
                "completion_tokens": 1,
                "total_tokens": 2,
                "unknown_field": 99,
            }
        )
        assert u.total_tokens == 2


# ---------------------------------------------------------------------------
# Non-streaming response schemas
# ---------------------------------------------------------------------------


class TestOpenAIChatResponse:
    def test_parse_basic_response(self):
        data = {
            "id": "chatcmpl-abc",
            "created": 1714000000,
            "model": "gpt-4o",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "Hello!"},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8},
        }
        resp = OpenAIChatResponse.model_validate(data)
        assert resp.id == "chatcmpl-abc"
        assert len(resp.choices) == 1
        assert resp.choices[0].message.content == "Hello!"
        assert resp.choices[0].finish_reason == "stop"
        assert resp.usage is not None
        assert resp.usage.total_tokens == 8

    def test_parse_tool_call_response(self):
        data = {
            "id": "chatcmpl-xyz",
            "created": 1,
            "model": "gpt-4o",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "type": "function",
                                "function": {
                                    "name": "search",
                                    "arguments": '{"q":"test"}',
                                },
                            }
                        ],
                    },
                    "finish_reason": "tool_calls",
                }
            ],
        }
        resp = OpenAIChatResponse.model_validate(data)
        msg = resp.choices[0].message
        assert msg.tool_calls is not None
        assert msg.tool_calls[0].function.name == "search"

    def test_empty_choices(self):
        resp = OpenAIChatResponse.model_validate(
            {"id": "x", "created": 1, "model": "gpt-4o", "choices": []}
        )
        assert resp.choices == []

    def test_extra_fields_ignored(self):
        data = {
            "id": "x",
            "created": 1,
            "model": "gpt-4o",
            "choices": [],
            "system_fingerprint": "fp_abc",
            "object": "chat.completion",
        }
        resp = OpenAIChatResponse.model_validate(data)
        assert resp.id == "x"

    def test_reasoning_content(self):
        """Non-standard reasoning_content field (e.g. DeepSeek-compatible)."""
        data = {
            "id": "x",
            "created": 1,
            "model": "deepseek-r1",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": "Answer",
                        "reasoning_content": "Thought...",
                    },
                    "finish_reason": "stop",
                }
            ],
        }
        resp = OpenAIChatResponse.model_validate(data)
        assert resp.choices[0].message.reasoning_content == "Thought..."


# ---------------------------------------------------------------------------
# Streaming response schemas
# ---------------------------------------------------------------------------


class TestOpenAIStreamChunk:
    def test_parse_content_chunk(self):
        data = {
            "id": "chatcmpl-1",
            "created": 1714000000,
            "model": "gpt-4o",
            "choices": [
                {"index": 0, "delta": {"content": "Hi"}, "finish_reason": None}
            ],
        }
        chunk = OpenAIStreamChunk.model_validate(data)
        assert chunk.choices[0].delta.content == "Hi"
        assert chunk.usage is None

    def test_parse_usage_only_chunk(self):
        """Final chunk with empty choices and usage (stream_options.include_usage=True)."""
        data = {
            "id": "chatcmpl-1",
            "created": 1714000000,
            "model": "gpt-4o",
            "choices": [],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        }
        chunk = OpenAIStreamChunk.model_validate(data)
        assert chunk.choices == []
        assert chunk.usage is not None
        assert chunk.usage.prompt_tokens == 10

    def test_parse_tool_call_delta(self):
        data = {
            "id": "chatcmpl-1",
            "created": 1,
            "model": "gpt-4o",
            "choices": [
                {
                    "index": 0,
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_1",
                                "type": "function",
                                "function": {"name": "search", "arguments": ""},
                            }
                        ]
                    },
                    "finish_reason": None,
                }
            ],
        }
        chunk = OpenAIStreamChunk.model_validate(data)
        tcs = chunk.choices[0].delta.tool_calls
        assert tcs is not None
        assert tcs[0].id == "call_1"
        assert tcs[0].function is not None
        assert tcs[0].function.name == "search"

    def test_parse_argument_accumulation_chunk(self):
        """Subsequent tool_call delta chunks with only arguments (no id/name)."""
        data = {
            "id": "chatcmpl-1",
            "created": 1,
            "model": "gpt-4o",
            "choices": [
                {
                    "index": 0,
                    "delta": {
                        "tool_calls": [{"index": 0, "function": {"arguments": '{"q":'}}]
                    },
                    "finish_reason": None,
                }
            ],
        }
        chunk = OpenAIStreamChunk.model_validate(data)
        assert chunk.choices[0].delta.tool_calls is not None
        tc = chunk.choices[0].delta.tool_calls[0]
        assert tc.id is None
        assert tc.function is not None
        assert tc.function.arguments == '{"q":'

    def test_extra_fields_ignored(self):
        data = {
            "id": "x",
            "created": 1,
            "model": "gpt-4o",
            "choices": [
                {"index": 0, "delta": {"content": "ok"}, "finish_reason": None}
            ],
            "system_fingerprint": "fp",
            "object": "chat.completion.chunk",
        }
        chunk = OpenAIStreamChunk.model_validate(data)
        assert chunk.choices[0].delta.content == "ok"
