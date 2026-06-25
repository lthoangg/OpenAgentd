"""Tests for app/agent/providers/copilot/copilot.py — CopilotProvider."""

from __future__ import annotations

import json
import os
from unittest.mock import MagicMock, patch

import httpx
import pytest
import respx
from pydantic.types import SecretStr

from app.agent.providers.copilot.copilot import (
    COPILOT_API_BASE,
    CopilotProvider,
    _CopilotCompletionsHandler,
    _endpoint_for_model,
    _is_agent_initiated,
    _supports_reasoning_effort,
    copilot_model_catalog,
)
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


def _usage_from_openai(u):
    """Test helper: invoke the Copilot usage extractor on a stub handler.

    Copilot reports top-level ``reasoning_tokens``; the canonical OpenAI
    handler ignores it. We therefore exercise the Copilot subclass.
    """
    handler = _CopilotCompletionsHandler(model="m", base_url="", headers={})
    return handler._usage_from_openai(u)


_COMPLETIONS_URL = f"{COPILOT_API_BASE}/chat/completions"
_RESPONSES_URL = f"{COPILOT_API_BASE}/responses"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_provider(model: str = "gpt-5-mini", **kwargs) -> CopilotProvider:
    """Build a CopilotProvider with an explicit token so no file/env needed."""
    return CopilotProvider(model=model, github_token="gho_test_token", **kwargs)


def _sse(*chunks: dict) -> str:
    lines = [f"data: {json.dumps(c)}\n" for c in chunks]
    lines.append("data: [DONE]\n")
    return "".join(lines)


def _responses_sse(*events: dict) -> str:
    lines = []
    for e in events:
        lines.append(f"data: {json.dumps(e)}\n")
    lines.append("data: [DONE]\n")
    return "".join(lines)


# ---------------------------------------------------------------------------
# _endpoint_for_model
# ---------------------------------------------------------------------------


class TestEndpointForModel:
    def test_known_completions_model(self):
        assert _endpoint_for_model("gpt-5-mini") == "completions"

    def test_known_responses_model(self):
        assert _endpoint_for_model("gpt-5.4") == "responses"

    def test_unknown_model_defaults_to_completions(self):
        assert _endpoint_for_model("some-unknown-model") == "completions"

    def test_claude_model_is_completions(self):
        assert _endpoint_for_model("claude-sonnet-4") == "completions"

    def test_codex_model_is_responses(self):
        assert _endpoint_for_model("gpt-5.2-codex") == "responses"


# ---------------------------------------------------------------------------
# Constructor
# ---------------------------------------------------------------------------


class TestCopilotProviderInit:
    def test_raises_if_no_token(self):
        """Me no token → ValueError."""
        with (
            patch(
                "app.agent.providers.copilot.copilot.CopilotOAuth.load",
                return_value=None,
            ),
            patch.dict(os.environ, {}, clear=True),
            pytest.raises(ValueError, match="GitHub token"),
        ):
            CopilotProvider(model="gpt-5-mini")

    def test_accepts_explicit_string_token(self):
        p = _make_provider()
        assert p._github_token == "gho_test_token"

    def test_accepts_secret_str_token(self):
        p = CopilotProvider(model="gpt-5-mini", github_token=SecretStr("gho_secret"))
        assert p._github_token == "gho_secret"

    def test_accepts_env_var_token(self):
        with (
            patch(
                "app.agent.providers.copilot.copilot.CopilotOAuth.load",
                return_value=None,
            ),
            patch.dict(os.environ, {"GITHUB_COPILOT_TOKEN": "gho_env_token"}),
        ):
            p = CopilotProvider(model="gpt-5-mini")
        assert p._github_token == "gho_env_token"

    def test_auth_header_set(self):
        p = _make_provider()
        assert p._completions.headers["Authorization"] == "Bearer gho_test_token"

    def test_endpoint_type_set_for_completions_model(self):
        p = _make_provider(model="gpt-5-mini")
        assert p._endpoint_type == "completions"

    def test_endpoint_type_set_for_responses_model(self):
        p = _make_provider(model="gpt-5.4")
        assert p._endpoint_type == "responses"


# ---------------------------------------------------------------------------
# _request_url property
# ---------------------------------------------------------------------------


class TestRequestUrl:
    def test_completions_url(self):
        p = _make_provider(model="gpt-5-mini")
        assert p._request_url == _COMPLETIONS_URL

    def test_responses_url(self):
        p = _make_provider(model="gpt-5.4")
        assert p._request_url == _RESPONSES_URL


class TestCopilotModelCatalog:
    def test_catalog_empty_without_oauth(self):
        with patch(
            "app.agent.providers.copilot.copilot.CopilotOAuth.load", return_value=None
        ):
            assert copilot_model_catalog() == {}

    def test_supports_reasoning_effort_uses_catalog(self):
        with patch(
            "app.agent.providers.copilot.copilot.copilot_model_catalog",
            return_value={
                "gpt-5.4-mini": {"supports": {"reasoning_effort": ["low", "medium"]}}
            },
        ):
            assert _supports_reasoning_effort("gpt-5.4-mini") is True

    def test_supports_reasoning_effort_falls_back_for_unknown_model(self):
        with patch(
            "app.agent.providers.copilot.copilot.copilot_model_catalog",
            return_value={},
        ):
            assert _supports_reasoning_effort("gpt-5-mini") is True
            assert _supports_reasoning_effort("claude-sonnet-4.5") is False


class TestCopilotHeaderHeuristics:
    def test_completions_user_message_is_user_initiated(self):
        is_agent, is_vision = _is_agent_initiated(
            [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
            responses_api=False,
        )
        assert is_agent is False
        assert is_vision is False

    def test_completions_assistant_message_is_agent_initiated(self):
        is_agent, is_vision = _is_agent_initiated(
            [{"role": "assistant", "content": "working"}], responses_api=False
        )
        assert is_agent is True
        assert is_vision is False

    def test_responses_input_image_sets_vision(self):
        is_agent, is_vision = _is_agent_initiated(
            [{"role": "user", "content": [{"type": "input_image", "image_url": "x"}]}],
            responses_api=True,
        )
        assert is_agent is False
        assert is_vision is True


# ---------------------------------------------------------------------------
# _convert_messages
# ---------------------------------------------------------------------------


class TestConvertMessages:
    def test_system_message(self):
        p = _make_provider()
        msgs = p._completions.convert_messages([SystemMessage(content="sys")])
        assert msgs[0].role == "system"
        assert msgs[0].content == "sys"

    def test_human_message(self):
        p = _make_provider()
        msgs = p._completions.convert_messages([HumanMessage(content="hello")])
        assert msgs[0].role == "user"
        assert msgs[0].content == "hello"

    def test_assistant_message_no_tools(self):
        p = _make_provider()
        msgs = p._completions.convert_messages([AssistantMessage(content="hi")])
        assert msgs[0].role == "assistant"
        assert msgs[0].tool_calls is None

    def test_assistant_message_with_tool_calls(self):
        p = _make_provider()
        msg = AssistantMessage(
            content=None,
            tool_calls=[
                ToolCall(
                    id="call_1",
                    function=FunctionCall(name="search", arguments='{"q":"x"}'),
                )
            ],
        )
        converted = p._completions.convert_messages([msg])
        assert converted[0].tool_calls is not None
        tc = converted[0].tool_calls[0]
        assert tc.id == "call_1"
        assert tc.function.name == "search"

    def test_tool_message(self):
        p = _make_provider()
        msg = ToolMessage(content="result", tool_call_id="call_1", name="fn")
        converted = p._completions.convert_messages([msg])
        assert converted[0].role == "tool"
        assert converted[0].tool_call_id == "call_1"
        assert converted[0].name == "fn"

    def test_mixed_conversation(self):
        p = _make_provider()
        msgs = p._completions.convert_messages(
            [
                SystemMessage(content="sys"),
                HumanMessage(content="hi"),
                AssistantMessage(content="hello"),
            ]
        )
        assert [m.role for m in msgs] == ["system", "user", "assistant"]


# ---------------------------------------------------------------------------
# _convert_tools
# ---------------------------------------------------------------------------


class TestConvertTools:
    def test_none_returns_none(self):
        p = _make_provider()
        assert p._completions.convert_tools(None) is None

    def test_empty_returns_none(self):
        p = _make_provider()
        assert p._completions.convert_tools([]) is None

    def test_function_tool_converted(self):
        p = _make_provider()
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "get_weather",
                    "description": "Get weather",
                    "parameters": {"type": "object"},
                },
            }
        ]
        result = p._completions.convert_tools(tools)
        assert result is not None
        assert result[0].function.name == "get_weather"

    def test_non_function_tool_skipped(self):
        p = _make_provider()
        tools = [{"type": "retrieval"}]
        assert p._completions.convert_tools(tools) is None

    def test_mixed_tools_only_function_kept(self):
        p = _make_provider()
        tools = [
            {"type": "function", "function": {"name": "fn1"}},
            {"type": "retrieval"},
        ]
        result = p._completions.convert_tools(tools)
        assert result is not None
        assert len(result) == 1
        assert result[0].function.name == "fn1"


# ---------------------------------------------------------------------------
# _build_completions_request
# ---------------------------------------------------------------------------


class TestBuildCompletionsRequest:
    def test_model_in_body(self):
        p = _make_provider(model="gpt-5-mini")
        body = p._completions.build_request(
            [HumanMessage(content="hi")], None, stream=False, merged=p._merged_kwargs()
        )
        assert body["model"] == "gpt-5-mini"

    def test_stream_flag(self):
        p = _make_provider()
        body = p._completions.build_request(
            [HumanMessage(content="hi")], None, stream=True, merged=p._merged_kwargs()
        )
        assert body["stream"] is True

    def test_stream_options_when_streaming(self):
        p = _make_provider()
        body = p._completions.build_request(
            [HumanMessage(content="hi")], None, stream=True, merged=p._merged_kwargs()
        )
        assert body.get("stream_options", {}).get("include_usage") is True

    def test_no_stream_options_when_not_streaming(self):
        p = _make_provider()
        body = p._completions.build_request(
            [HumanMessage(content="hi")], None, stream=False, merged=p._merged_kwargs()
        )
        assert "stream_options" not in body

    def test_temperature_passed(self):
        p = _make_provider(temperature=0.5)
        body = p._completions.build_request(
            [HumanMessage(content="hi")], None, stream=False, merged=p._merged_kwargs()
        )
        assert body["temperature"] == 0.5

    def test_max_tokens_passed(self):
        """Copilot's gateway accepts the same field name as OpenAI's
        Chat Completions API — ``max_completion_tokens``.  The caller
        still uses the canonical ``max_tokens`` argument; the handler
        translates to the wire-field name (see
        ``CompletionsHandler.uses_max_completion_tokens``).
        """
        p = _make_provider(max_tokens=100)
        body = p._completions.build_request(
            [HumanMessage(content="hi")], None, stream=False, merged=p._merged_kwargs()
        )
        assert body["max_completion_tokens"] == 100
        assert "max_tokens" not in body

    def test_thinking_level_maps_to_reasoning_effort(self):
        p = CopilotProvider(
            model="gpt-5-mini",
            github_token="tok",
            model_kwargs={"thinking_level": "high"},
        )
        body = p._completions.build_request(
            [HumanMessage(content="hi")], None, stream=False, merged=p._merged_kwargs()
        )
        assert body["reasoning_effort"] == "high"

    def test_thinking_level_none_not_added(self):
        p = CopilotProvider(
            model="gpt-5-mini",
            github_token="tok",
            model_kwargs={"thinking_level": "none"},
        )
        body = p._completions.build_request(
            [HumanMessage(content="hi")], None, stream=False, merged=p._merged_kwargs()
        )
        assert "reasoning_effort" not in body


# ---------------------------------------------------------------------------
# _build_responses_request
# ---------------------------------------------------------------------------


class TestBuildResponsesRequest:
    def test_model_in_body(self):
        p = _make_provider(model="gpt-5.4")
        body = p._responses.build_request(
            [HumanMessage(content="hi")], None, stream=False, merged=p._merged_kwargs()
        )
        assert body["model"] == "gpt-5.4"

    def test_input_list_present(self):
        p = _make_provider(model="gpt-5.4")
        body = p._responses.build_request(
            [HumanMessage(content="hi")], None, stream=False, merged=p._merged_kwargs()
        )
        assert "input" in body
        assert isinstance(body["input"], list)

    def test_human_message_in_input(self):
        p = _make_provider(model="gpt-5.4")
        body = p._responses.build_request(
            [HumanMessage(content="hello")],
            None,
            stream=False,
            merged=p._merged_kwargs(),
        )
        assert body["input"][0] == {"role": "user", "content": "hello"}

    def test_system_message_in_input(self):
        p = _make_provider(model="gpt-5.4")
        body = p._responses.build_request(
            [SystemMessage(content="sys")],
            None,
            stream=False,
            merged=p._merged_kwargs(),
        )
        assert body["input"][0] == {"role": "system", "content": "sys"}

    def test_tool_message_as_function_call_output(self):
        p = _make_provider(model="gpt-5.4")
        body = p._responses.build_request(
            [ToolMessage(content="result", tool_call_id="call_1", name="fn")],
            None,
            stream=False,
            merged=p._merged_kwargs(),
        )
        assert body["input"] == []

    def test_assistant_with_tool_calls_in_input(self):
        p = _make_provider(model="gpt-5.4")
        msg = AssistantMessage(
            content=None,
            tool_calls=[
                ToolCall(
                    id="call_1",
                    function=FunctionCall(name="search", arguments='{"q":"x"}'),
                )
            ],
        )
        body = p._responses.build_request(
            [msg], None, stream=False, merged=p._merged_kwargs()
        )
        assert not any(i.get("type") == "function_call" for i in body["input"])

    def test_tools_in_responses_format(self):
        p = _make_provider(model="gpt-5.4")
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "search",
                    "description": "Search",
                    "parameters": {"type": "object"},
                },
            }
        ]
        body = p._responses.build_request(
            [HumanMessage(content="hi")], tools, stream=False, merged=p._merged_kwargs()
        )
        assert "tools" in body
        assert body["tools"][0]["name"] == "search"
        assert body["tools"][0]["type"] == "function"

    def test_max_tokens_maps_to_max_output_tokens(self):
        p = _make_provider(model="gpt-5.4", max_tokens=200)
        body = p._responses.build_request(
            [HumanMessage(content="hi")], None, stream=False, merged=p._merged_kwargs()
        )
        assert body["max_output_tokens"] == 200
        assert "max_tokens" not in body

    def test_thinking_level_maps_to_reasoning_config(self):
        p = CopilotProvider(
            model="gpt-5.4",
            github_token="tok",
            model_kwargs={"thinking_level": "medium"},
        )
        body = p._responses.build_request(
            [HumanMessage(content="hi")], None, stream=False, merged=p._merged_kwargs()
        )
        assert body["reasoning"] == {"effort": "medium", "summary": "auto"}


# ---------------------------------------------------------------------------
# _parse_completions_response
# ---------------------------------------------------------------------------


class TestParseCompletionsResponse:
    def test_text_content(self):
        p = _make_provider()
        data = {
            "id": "x",
            "created": 1,
            "model": "gpt-5-mini",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "Hello!"},
                    "finish_reason": "stop",
                }
            ],
        }
        msg = p._completions.parse_response(data)
        assert msg.content == "Hello!"
        assert msg.tool_calls is None

    def test_tool_calls(self):
        p = _make_provider()
        data = {
            "id": "x",
            "created": 1,
            "model": "gpt-5-mini",
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
                                    "arguments": '{"q":"x"}',
                                },
                            }
                        ],
                    },
                    "finish_reason": "tool_calls",
                }
            ],
        }
        msg = p._completions.parse_response(data)
        assert msg.tool_calls is not None
        assert msg.tool_calls[0].id == "call_1"

    def test_empty_choices(self):
        p = _make_provider()
        data = {"id": "x", "created": 1, "model": "gpt-5-mini", "choices": []}
        msg = p._completions.parse_response(data)
        assert msg.content is None

    def test_reasoning_content(self):
        p = _make_provider()
        data = {
            "id": "x",
            "created": 1,
            "model": "gpt-5-mini",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": "Answer",
                        "reasoning_content": "Thinking...",
                    },
                    "finish_reason": "stop",
                }
            ],
        }
        msg = p._completions.parse_response(data)
        assert msg.reasoning_content == "Thinking..."


# ---------------------------------------------------------------------------
# _parse_responses_response
# ---------------------------------------------------------------------------


class TestParseResponsesResponse:
    def test_message_output_text(self):
        p = _make_provider(model="gpt-5.4")
        data = {
            "output": [
                {
                    "type": "message",
                    "content": [{"type": "output_text", "text": "Hello!"}],
                }
            ]
        }
        msg = p._responses.parse_response(data)
        assert msg.content == "Hello!"

    def test_function_call_output(self):
        p = _make_provider(model="gpt-5.4")
        data = {
            "output": [
                {
                    "type": "function_call",
                    "call_id": "call_1",
                    "name": "search",
                    "arguments": '{"q":"x"}',
                }
            ]
        }
        msg = p._responses.parse_response(data)
        assert msg.tool_calls is not None
        assert msg.tool_calls[0].id == "call_1"
        assert msg.tool_calls[0].function.name == "search"

    def test_empty_output(self):
        p = _make_provider(model="gpt-5.4")
        msg = p._responses.parse_response({"output": []})
        assert msg.content is None
        assert msg.tool_calls is None


# ---------------------------------------------------------------------------
# chat() — completions endpoint
# ---------------------------------------------------------------------------


@respx.mock
async def test_chat_completions_success():
    p = _make_provider(model="gpt-5-mini")
    respx.post(_COMPLETIONS_URL).mock(
        return_value=httpx.Response(
            200,
            json={
                "id": "x",
                "created": 1,
                "model": "gpt-5-mini",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "Hi!"},
                        "finish_reason": "stop",
                    }
                ],
            },
        )
    )
    msg = await p.chat([HumanMessage(content="hello")])
    assert isinstance(msg, AssistantMessage)
    assert msg.content == "Hi!"


@respx.mock
async def test_chat_completions_http_error():
    p = _make_provider(model="gpt-5-mini")
    respx.post(_COMPLETIONS_URL).mock(
        return_value=httpx.Response(401, json={"error": "Unauthorized"})
    )
    with pytest.raises(httpx.HTTPStatusError):
        await p.chat([HumanMessage(content="hi")])


@respx.mock
async def test_chat_responses_success():
    p = _make_provider(model="gpt-5.4")
    respx.post(_RESPONSES_URL).mock(
        return_value=httpx.Response(
            200,
            json={
                "output": [
                    {
                        "type": "message",
                        "content": [{"type": "output_text", "text": "Hello!"}],
                    }
                ]
            },
        )
    )
    msg = await p.chat([HumanMessage(content="hello")])
    assert msg.content == "Hello!"


@respx.mock
async def test_chat_responses_http_error():
    p = _make_provider(model="gpt-5.4")
    respx.post(_RESPONSES_URL).mock(
        return_value=httpx.Response(429, json={"error": "Rate limit"})
    )
    with pytest.raises(httpx.HTTPStatusError):
        await p.chat([HumanMessage(content="hi")])


# ---------------------------------------------------------------------------
# stream() — completions endpoint
# ---------------------------------------------------------------------------


@respx.mock
async def test_stream_completions_text_chunks():
    p = _make_provider(model="gpt-5-mini")
    body = _sse(
        {
            "id": "1",
            "created": 1,
            "model": "gpt-5-mini",
            "choices": [
                {"index": 0, "delta": {"content": "Hello"}, "finish_reason": None}
            ],
        },
        {
            "id": "1",
            "created": 1,
            "model": "gpt-5-mini",
            "choices": [
                {"index": 0, "delta": {"content": " world"}, "finish_reason": "stop"}
            ],
        },
    )
    respx.post(_COMPLETIONS_URL).mock(return_value=httpx.Response(200, content=body))

    chunks = []
    async for chunk in p.stream([HumanMessage(content="hi")]):
        chunks.append(chunk)

    assert len(chunks) == 2
    assert chunks[0].choices[0].delta.content == "Hello"
    assert chunks[1].choices[0].delta.content == " world"


@respx.mock
async def test_stream_completions_tool_call_deltas():
    p = _make_provider(model="gpt-5-mini")
    body = _sse(
        {
            "id": "1",
            "created": 1,
            "model": "gpt-5-mini",
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
    )
    respx.post(_COMPLETIONS_URL).mock(return_value=httpx.Response(200, content=body))

    chunks = []
    async for chunk in p.stream([HumanMessage(content="hi")]):
        chunks.append(chunk)

    assert len(chunks) == 1
    tc = chunks[0].choices[0].delta.tool_calls
    assert tc is not None
    assert tc[0].id == "call_1"
    assert tc[0].function.name == "search"


@respx.mock
async def test_stream_completions_usage_only_chunk():
    p = _make_provider(model="gpt-5-mini")
    body = _sse(
        {
            "id": "1",
            "created": 1,
            "model": "gpt-5-mini",
            "choices": [],
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
            },
        }
    )
    respx.post(_COMPLETIONS_URL).mock(return_value=httpx.Response(200, content=body))

    chunks = []
    async for chunk in p.stream([HumanMessage(content="hi")]):
        chunks.append(chunk)

    assert len(chunks) == 1
    assert chunks[0].choices == []
    assert chunks[0].usage is not None
    assert chunks[0].usage.prompt_tokens == 10


@respx.mock
async def test_stream_completions_http_error():
    p = _make_provider(model="gpt-5-mini")
    respx.post(_COMPLETIONS_URL).mock(
        return_value=httpx.Response(429, json={"error": "Rate limit"})
    )
    with pytest.raises(httpx.HTTPStatusError):
        async for _ in p.stream([HumanMessage(content="hi")]):
            pass


# ---------------------------------------------------------------------------
# stream() — responses endpoint
# ---------------------------------------------------------------------------


@respx.mock
async def test_stream_responses_created_event():
    p = _make_provider(model="gpt-5.4")
    body = _responses_sse(
        {"type": "response.created", "response": {"id": "resp_123"}},
        {
            "type": "response.output_text.delta",
            "delta": "Hello",
        },
        {
            "type": "response.output_text.done",
        },
    )
    respx.post(_RESPONSES_URL).mock(return_value=httpx.Response(200, content=body))

    chunks = []
    async for chunk in p.stream([HumanMessage(content="hi")]):
        chunks.append(chunk)

    # Me text delta + done chunk
    assert len(chunks) >= 1
    text_chunks = [c for c in chunks if c.choices and c.choices[0].delta.content]
    assert text_chunks[0].choices[0].delta.content == "Hello"


@respx.mock
async def test_stream_responses_reasoning_summary():
    p = _make_provider(model="gpt-5.4")
    body = _responses_sse(
        {"type": "response.created", "response": {"id": "resp_1"}},
        {"type": "response.reasoning_summary_text.delta", "delta": "Thinking..."},
        {"type": "response.reasoning_summary_text.done"},
    )
    respx.post(_RESPONSES_URL).mock(return_value=httpx.Response(200, content=body))

    chunks = []
    async for chunk in p.stream([HumanMessage(content="hi")]):
        chunks.append(chunk)

    reasoning_chunks = [
        c for c in chunks if c.choices and c.choices[0].delta.reasoning_content
    ]
    assert len(reasoning_chunks) == 1
    assert reasoning_chunks[0].choices[0].delta.reasoning_content == "Thinking..."


@respx.mock
async def test_stream_responses_function_call_delta():
    p = _make_provider(model="gpt-5.4")
    body = _responses_sse(
        {"type": "response.created", "response": {"id": "resp_1"}},
        {
            "type": "response.function_call_arguments.delta",
            "call_id": "call_1",
            "name": "search",
            "delta": '{"q"',
        },
        {
            "type": "response.function_call_arguments.done",
            "call_id": "call_1",
            "name": "search",
            "arguments": '{"q":"x"}',
        },
    )
    respx.post(_RESPONSES_URL).mock(return_value=httpx.Response(200, content=body))

    chunks = []
    async for chunk in p.stream([HumanMessage(content="hi")]):
        chunks.append(chunk)

    tool_chunks = [c for c in chunks if c.choices and c.choices[0].delta.tool_calls]
    assert len(tool_chunks) >= 1


@respx.mock
async def test_stream_responses_output_text_done():
    p = _make_provider(model="gpt-5.4")
    body = _responses_sse(
        {"type": "response.created", "response": {"id": "resp_1"}},
        {"type": "response.output_text.done"},
    )
    respx.post(_RESPONSES_URL).mock(return_value=httpx.Response(200, content=body))

    chunks = []
    async for chunk in p.stream([HumanMessage(content="hi")]):
        chunks.append(chunk)

    done_chunks = [
        c for c in chunks if c.choices and c.choices[0].finish_reason == "stop"
    ]
    assert len(done_chunks) == 1


@respx.mock
async def test_stream_responses_completed_usage():
    p = _make_provider(model="gpt-5.4")
    body = _responses_sse(
        {"type": "response.created", "response": {"id": "resp_1"}},
        {
            "type": "response.completed",
            "response": {
                "usage": {
                    "input_tokens": 10,
                    "output_tokens": 5,
                    "total_tokens": 15,
                    "input_tokens_details": {"cached_tokens": 3},
                    "output_tokens_details": {"reasoning_tokens": 2},
                }
            },
        },
    )
    respx.post(_RESPONSES_URL).mock(return_value=httpx.Response(200, content=body))

    chunks = []
    async for chunk in p.stream([HumanMessage(content="hi")]):
        chunks.append(chunk)

    usage_chunks = [c for c in chunks if c.usage is not None]
    assert len(usage_chunks) == 1
    u = usage_chunks[0].usage
    assert u.prompt_tokens == 10
    assert u.completion_tokens == 5
    assert u.cached_tokens == 3
    assert u.thoughts_tokens == 2


@respx.mock
async def test_stream_responses_http_error():
    p = _make_provider(model="gpt-5.4")
    respx.post(_RESPONSES_URL).mock(
        return_value=httpx.Response(401, json={"error": "Unauthorized"})
    )
    with pytest.raises(httpx.HTTPStatusError):
        async for _ in p.stream([HumanMessage(content="hi")]):
            pass


# ---------------------------------------------------------------------------
# _build_responses_request — missing coverage
# ---------------------------------------------------------------------------


class TestBuildResponsesRequestExtra:
    def test_assistant_content_none_with_tool_calls_only(self):
        """Line 284: AssistantMessage content=None but has tool_calls — no content dict emitted."""
        p = _make_provider(model="gpt-5.4")
        msg = AssistantMessage(
            content=None,
            tool_calls=[
                ToolCall(
                    id="call_x",
                    function=FunctionCall(name="do_thing", arguments='{"a":1}'),
                )
            ],
        )
        body = p._responses.build_request(
            [msg], None, stream=False, merged=p._merged_kwargs()
        )
        # Me no assistant content dict, and incomplete tool calls are stripped.
        content_items = [i for i in body["input"] if i.get("role") == "assistant"]
        assert len(content_items) == 0
        fc_items = [i for i in body["input"] if i.get("type") == "function_call"]
        assert len(fc_items) == 0

    def test_top_p_in_responses_body(self):
        """Line 332: top_p kwarg appears in responses request body."""
        p = CopilotProvider(
            model="gpt-5.4",
            github_token="tok",
            model_kwargs={"top_p": 0.9},
        )
        body = p._responses.build_request(
            [HumanMessage(content="hi")], None, stream=False, merged=p._merged_kwargs()
        )
        assert body["top_p"] == 0.9

    def test_prepare_headers_sets_agent_initiator_and_vision(self):
        p = _make_provider(model="gpt-5.4")
        body = p._responses.build_request(
            [AssistantMessage(content="thinking")],
            None,
            stream=False,
            merged=p._merged_kwargs(),
        )
        headers = p._prepare_request_headers(body)
        assert headers["x-initiator"] == "agent"
        assert "Copilot-Vision-Request" not in headers

    def test_prepare_headers_sets_vision_request(self):
        p = _make_provider(model="gpt-5.4")
        body = p._responses.build_request(
            [
                HumanMessage(
                    content="", parts=[ImageUrlBlock(url="https://example.com/x.png")]
                )
            ],
            None,
            stream=False,
            merged=p._merged_kwargs(),
        )
        headers = p._prepare_request_headers(body)
        assert headers["x-initiator"] == "user"
        assert headers["Copilot-Vision-Request"] == "true"

    def test_max_tokens_in_responses_body(self):
        """Line 333: max_tokens kwarg maps to max_output_tokens in responses body."""
        p = CopilotProvider(
            model="gpt-5.4",
            github_token="tok",
            model_kwargs={"max_tokens": 512},
        )
        body = p._responses.build_request(
            [HumanMessage(content="hi")], None, stream=False, merged=p._merged_kwargs()
        )
        assert body["max_output_tokens"] == 512


# ---------------------------------------------------------------------------
# _stream_responses — SSE line skipping + malformed JSON
# ---------------------------------------------------------------------------


@respx.mock
async def test_stream_responses_skips_event_prefix_and_junk_lines():
    """Lines 561, 563: event: lines and junk lines are skipped without error."""
    p = _make_provider(model="gpt-5.4")

    # Me build SSE body with event: lines and junk mixed in
    body = (
        "event: response.created\n"
        'data: {"type": "response.created", "response": {"id": "resp_1"}}\n'
        "\n"
        "junk line here\n"
        ": comment line\n"
        'data: {"type": "response.output_text.delta", "delta": "Hello"}\n'
        "data: [DONE]\n"
    )
    respx.post(_RESPONSES_URL).mock(return_value=httpx.Response(200, content=body))

    chunks = []
    async for chunk in p.stream([HumanMessage(content="hi")]):
        chunks.append(chunk)

    text_chunks = [c for c in chunks if c.choices and c.choices[0].delta.content]
    assert len(text_chunks) == 1
    assert text_chunks[0].choices[0].delta.content == "Hello"


@respx.mock
async def test_stream_responses_skips_malformed_json():
    """Lines 571-572: malformed JSON in data line is skipped (continue branch)."""
    p = _make_provider(model="gpt-5.4")

    body = (
        'data: {"type": "response.created", "response": {"id": "resp_1"}}\n'
        "data: {invalid json here}\n"
        "data: not-json-at-all\n"
        'data: {"type": "response.output_text.delta", "delta": "World"}\n'
        "data: [DONE]\n"
    )
    respx.post(_RESPONSES_URL).mock(return_value=httpx.Response(200, content=body))

    chunks = []
    async for chunk in p.stream([HumanMessage(content="hi")]):
        chunks.append(chunk)

    text_chunks = [c for c in chunks if c.choices and c.choices[0].delta.content]
    assert len(text_chunks) == 1
    assert text_chunks[0].choices[0].delta.content == "World"


@respx.mock
async def test_stream_responses_function_call_done_first_seen_call_id():
    """Lines 669-670: done event where call_id NOT in tool_call_map (first-seen in done)."""
    p = _make_provider(model="gpt-5.4")

    # Me send ONLY the .done event — no preceding .delta for this call_id
    body = (
        'data: {"type": "response.created", "response": {"id": "resp_1"}}\n'
        'data: {"type": "response.function_call_arguments.done", "call_id": "call_new", "name": "fresh_tool", "arguments": "{\\"x\\": 1}"}\n'
        "data: [DONE]\n"
    )
    respx.post(_RESPONSES_URL).mock(return_value=httpx.Response(200, content=body))

    chunks = []
    async for chunk in p.stream([HumanMessage(content="hi")]):
        chunks.append(chunk)

    tool_chunks = [c for c in chunks if c.choices and c.choices[0].delta.tool_calls]
    assert len(tool_chunks) >= 1
    tc = tool_chunks[0].choices[0].delta.tool_calls[0]
    assert tc.id == "call_new"
    assert tc.function.name == "fresh_tool"


# ---------------------------------------------------------------------------
# _usage_from_openai
# ---------------------------------------------------------------------------


class TestUsageFromOpenai:
    def _make_usage(self, **kwargs):
        """Build a mock usage object."""
        u = MagicMock()
        u.prompt_tokens = kwargs.get("prompt_tokens", 10)
        u.completion_tokens = kwargs.get("completion_tokens", 5)
        u.total_tokens = kwargs.get("total_tokens", 15)
        u.prompt_tokens_details = kwargs.get("prompt_tokens_details", None)
        u.completion_tokens_details = kwargs.get("completion_tokens_details", None)
        # Me top-level reasoning_tokens (Copilot-specific)
        u.reasoning_tokens = kwargs.get("reasoning_tokens", None)
        return u

    def test_basic_usage(self):
        u = self._make_usage()
        result = _usage_from_openai(u)
        assert result.prompt_tokens == 10
        assert result.completion_tokens == 5
        assert result.total_tokens == 15

    def test_cached_tokens_from_details(self):
        details = MagicMock()
        details.cached_tokens = 4
        u = self._make_usage(prompt_tokens_details=details)
        result = _usage_from_openai(u)
        assert result.cached_tokens == 4

    def test_zero_cached_tokens_maps_to_none(self):
        details = MagicMock()
        details.cached_tokens = 0
        u = self._make_usage(prompt_tokens_details=details)
        result = _usage_from_openai(u)
        assert result.cached_tokens is None

    def test_thoughts_tokens_from_top_level(self):
        u = self._make_usage(reasoning_tokens=8)
        result = _usage_from_openai(u)
        assert result.thoughts_tokens == 8

    def test_thoughts_tokens_from_completion_details(self):
        comp_details = MagicMock()
        comp_details.reasoning_tokens = 6
        u = self._make_usage(completion_tokens_details=comp_details)
        result = _usage_from_openai(u)
        assert result.thoughts_tokens == 6

    def test_no_details_returns_none_for_optional(self):
        u = self._make_usage()
        result = _usage_from_openai(u)
        assert result.cached_tokens is None
        assert result.thoughts_tokens is None


# ---------------------------------------------------------------------------
# _convert_messages — Chat Completions multimodal (lines 192-211)
# ---------------------------------------------------------------------------


class TestCopilotConvertMessagesMultimodal:
    @pytest.fixture
    def prov(self):
        return _make_provider()

    def test_text_block_in_parts(self, prov):
        msg = HumanMessage(content="hi", parts=[TextBlock(text="text part")])
        result = prov._completions.convert_messages([msg])
        content = result[0].content
        assert isinstance(content, list)
        assert content[0] == {"type": "text", "text": "text part"}

    def test_image_url_block_no_detail(self, prov):
        msg = HumanMessage(
            content="",
            parts=[ImageUrlBlock(url="https://example.com/img.jpg")],
        )
        result = prov._completions.convert_messages([msg])
        part = result[0].content[0]
        assert part["type"] == "image_url"
        assert part["image_url"]["url"] == "https://example.com/img.jpg"
        assert "detail" not in part["image_url"]

    def test_image_url_block_with_detail(self, prov):
        msg = HumanMessage(
            content="",
            parts=[ImageUrlBlock(url="https://example.com/img.jpg", detail="high")],
        )
        result = prov._completions.convert_messages([msg])
        part = result[0].content[0]
        assert part["image_url"]["detail"] == "high"

    def test_image_data_block(self, prov):
        msg = HumanMessage(
            content="",
            parts=[ImageDataBlock(data="b64bytes", media_type="image/png")],
        )
        result = prov._completions.convert_messages([msg])
        part = result[0].content[0]
        assert part["type"] == "image_url"
        assert "data:image/png;base64,b64bytes" in part["image_url"]["url"]
        assert part["image_url"]["detail"] == "auto"


# ---------------------------------------------------------------------------
# _build_responses_request — Responses API multimodal (lines 323-343)
# ---------------------------------------------------------------------------


class TestCopilotResponsesAPIMultimodal:
    @pytest.fixture
    def prov(self):
        return _make_provider(model_kwargs={"responses_api": True})

    def test_text_block_responses_api(self, prov):
        msg = HumanMessage(content="hi", parts=[TextBlock(text="some text")])
        result = prov._responses.build_request(
            [msg], tools=[], stream=True, merged=prov._merged_kwargs()
        )
        user_items = [i for i in result["input"] if i.get("role") == "user"]
        part = user_items[0]["content"][0]
        assert part == {"type": "input_text", "text": "some text"}

    def test_image_url_block_responses_api(self, prov):
        msg = HumanMessage(
            content="",
            parts=[ImageUrlBlock(url="https://example.com/img.jpg", detail="low")],
        )
        result = prov._responses.build_request(
            [msg], tools=[], stream=True, merged=prov._merged_kwargs()
        )
        user_items = [i for i in result["input"] if i.get("role") == "user"]
        part = user_items[0]["content"][0]
        assert part["type"] == "input_image"
        assert part["image_url"] == "https://example.com/img.jpg"
        assert part["detail"] == "low"

    def test_image_url_block_no_detail_defaults_to_auto(self, prov):
        msg = HumanMessage(
            content="",
            parts=[ImageUrlBlock(url="https://example.com/img.jpg")],
        )
        result = prov._responses.build_request(
            [msg], tools=[], stream=True, merged=prov._merged_kwargs()
        )
        user_items = [i for i in result["input"] if i.get("role") == "user"]
        part = user_items[0]["content"][0]
        assert part["detail"] == "auto"

    def test_image_data_block_responses_api(self, prov):
        msg = HumanMessage(
            content="",
            parts=[ImageDataBlock(data="encoded", media_type="image/gif")],
        )
        result = prov._responses.build_request(
            [msg], tools=[], stream=True, merged=prov._merged_kwargs()
        )
        user_items = [i for i in result["input"] if i.get("role") == "user"]
        part = user_items[0]["content"][0]
        assert part["type"] == "input_image"
        assert "data:image/gif;base64,encoded" in part["image_url"]
        assert part["detail"] == "auto"
