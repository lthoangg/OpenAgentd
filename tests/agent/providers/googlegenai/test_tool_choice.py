"""Tests for tool_choice propagation in GeminiProviderBase (GoogleGenAI + VertexAI).

Gemini represents tool_choice via tool_config: {functionCallingConfig: {mode: "NONE"}}.
The canonical string "none" must be translated and serialised to camelCase on the wire.

Critical paths:
- tool_choice="none" → tool_config.functionCallingConfig.mode="NONE" in both chat+stream
- tool_config NOT injected when no tools (no-op guard)
- tool_config NOT injected when tools present but tool_choice is not "none"
- Schema: FunctionCallingConfig / ToolConfig dump to camelCase via by_alias=True
- No tool_config key when tool_choice absent from merged
"""

from __future__ import annotations

import httpx
import respx

from app.agent.providers.googlegenai.googlegenai import GoogleGenAIProvider
from app.agent.providers.googlegenai.schemas import (
    FunctionCallingConfig,
    ToolConfig,
)
from app.agent.schemas.chat import HumanMessage

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_TOOL = {
    "type": "function",
    "function": {
        "name": "shell",
        "description": "Run shell",
        "parameters": {"type": "object", "properties": {}},
    },
}

_MESSAGES = [HumanMessage(content="hi")]


def _provider() -> GoogleGenAIProvider:
    return GoogleGenAIProvider(api_key="goog-test", model="gemini-2.0-flash")


# ===========================================================================
# Schema: ToolConfig / FunctionCallingConfig
# ===========================================================================


class TestToolConfigSchema:
    def test_function_calling_config_dumps_camel_case(self):
        """FunctionCallingConfig must serialise to camelCase for the Gemini REST API."""
        cfg = FunctionCallingConfig(mode="NONE")
        dump = cfg.model_dump(by_alias=True)
        assert dump == {"mode": "NONE"}

    def test_tool_config_dumps_camel_case(self):
        """ToolConfig nests FunctionCallingConfig under functionCallingConfig."""
        tc = ToolConfig(function_calling_config=FunctionCallingConfig(mode="NONE"))
        dump = tc.model_dump(by_alias=True, exclude_none=True)
        assert dump == {"functionCallingConfig": {"mode": "NONE"}}

    def test_tool_config_mode_auto(self):
        tc = ToolConfig(function_calling_config=FunctionCallingConfig(mode="AUTO"))
        dump = tc.model_dump(by_alias=True)
        assert dump["functionCallingConfig"]["mode"] == "AUTO"

    def test_tool_config_mode_any(self):
        tc = ToolConfig(function_calling_config=FunctionCallingConfig(mode="ANY"))
        dump = tc.model_dump(by_alias=True)
        assert dump["functionCallingConfig"]["mode"] == "ANY"

    def test_function_calling_config_default_is_auto(self):
        """Default mode must be AUTO (non-breaking for callers who omit it)."""
        cfg = FunctionCallingConfig()
        assert cfg.mode == "AUTO"


# ===========================================================================
# GeminiProviderBase.chat() — tool_config injection
# ===========================================================================


class TestGeminiChatToolChoice:
    def _make_chat_response(self) -> dict:
        return {
            "candidates": [
                {
                    "content": {
                        "role": "model",
                        "parts": [{"text": "Hello"}],
                    },
                    "finishReason": "STOP",
                }
            ],
            "usageMetadata": {
                "promptTokenCount": 10,
                "candidatesTokenCount": 5,
                "totalTokenCount": 15,
            },
        }

    @respx.mock
    async def test_tool_choice_none_sends_tool_config_none(self):
        """chat() with tool_choice='none' must include toolConfig.functionCallingConfig.mode=NONE."""
        p = _provider()
        url_pattern = respx.post(url__regex=r"generateContent")
        url_pattern.return_value = httpx.Response(200, json=self._make_chat_response())

        await p.chat(_MESSAGES, tools=[_TOOL], tool_choice="none")

        assert url_pattern.called
        request_body = url_pattern.calls[0].request
        import json

        body = json.loads(request_body.content)
        assert "toolConfig" in body
        assert body["toolConfig"]["functionCallingConfig"]["mode"] == "NONE"

    @respx.mock
    async def test_tool_choice_none_without_tools_omits_tool_config(self):
        """chat() with tool_choice='none' but no tools must NOT include toolConfig."""
        p = _provider()
        url_pattern = respx.post(url__regex=r"generateContent")
        url_pattern.return_value = httpx.Response(200, json=self._make_chat_response())

        await p.chat(_MESSAGES, tools=None, tool_choice="none")

        import json

        body = json.loads(url_pattern.calls[0].request.content)
        assert "toolConfig" not in body

    @respx.mock
    async def test_no_tool_choice_omits_tool_config(self):
        """chat() without tool_choice must not include toolConfig even when tools present."""
        p = _provider()
        url_pattern = respx.post(url__regex=r"generateContent")
        url_pattern.return_value = httpx.Response(200, json=self._make_chat_response())

        await p.chat(_MESSAGES, tools=[_TOOL])

        import json

        body = json.loads(url_pattern.calls[0].request.content)
        assert "toolConfig" not in body

    @respx.mock
    async def test_tool_choice_none_tools_list_still_present(self):
        """The tools list must remain in the request alongside toolConfig."""
        p = _provider()
        url_pattern = respx.post(url__regex=r"generateContent")
        url_pattern.return_value = httpx.Response(200, json=self._make_chat_response())

        await p.chat(_MESSAGES, tools=[_TOOL], tool_choice="none")

        import json

        body = json.loads(url_pattern.calls[0].request.content)
        assert "tools" in body
        assert "toolConfig" in body


# ===========================================================================
# GeminiProviderBase.stream() — tool_config injection
# ===========================================================================


class TestGeminiStreamToolChoice:
    def _make_sse_response(self) -> str:
        import json

        chunk = {
            "candidates": [
                {
                    "content": {"role": "model", "parts": [{"text": "Hi"}]},
                    "finishReason": "STOP",
                }
            ],
            "usageMetadata": {
                "promptTokenCount": 5,
                "candidatesTokenCount": 2,
                "totalTokenCount": 7,
            },
        }
        return f"data: {json.dumps(chunk)}\n\n"

    @respx.mock
    async def test_stream_tool_choice_none_sends_tool_config(self):
        """stream() with tool_choice='none' must include toolConfig in the request body."""
        p = _provider()
        url_pattern = respx.post(url__regex=r"streamGenerateContent")
        url_pattern.return_value = httpx.Response(
            200,
            text=self._make_sse_response(),
            headers={"content-type": "text/event-stream"},
        )

        chunks = []
        async for chunk in p.stream(_MESSAGES, tools=[_TOOL], tool_choice="none"):
            chunks.append(chunk)

        import json

        body = json.loads(url_pattern.calls[0].request.content)
        assert "toolConfig" in body
        assert body["toolConfig"]["functionCallingConfig"]["mode"] == "NONE"

    @respx.mock
    async def test_stream_no_tool_choice_omits_tool_config(self):
        """stream() without tool_choice must not include toolConfig."""
        p = _provider()
        url_pattern = respx.post(url__regex=r"streamGenerateContent")
        url_pattern.return_value = httpx.Response(
            200,
            text=self._make_sse_response(),
            headers={"content-type": "text/event-stream"},
        )

        async for _ in p.stream(_MESSAGES, tools=[_TOOL]):
            pass

        import json

        body = json.loads(url_pattern.calls[0].request.content)
        assert "toolConfig" not in body

    @respx.mock
    async def test_stream_tool_choice_none_without_tools_omits_tool_config(self):
        """stream() with tool_choice='none' but no tools omits toolConfig."""
        p = _provider()
        url_pattern = respx.post(url__regex=r"streamGenerateContent")
        url_pattern.return_value = httpx.Response(
            200,
            text=self._make_sse_response(),
            headers={"content-type": "text/event-stream"},
        )

        async for _ in p.stream(_MESSAGES, tools=None, tool_choice="none"):
            pass

        import json

        body = json.loads(url_pattern.calls[0].request.content)
        assert "toolConfig" not in body
