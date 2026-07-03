"""Tests for the AWS Bedrock provider.

Covers:
- BedrockProvider.__init__: stores model, resolves region, creates client
- Message conversion: system, human, assistant, tool messages
- Tool spec conversion
- chat(): calls converse, parses response (text + tool calls)
- stream(): yields ChatCompletionChunks from converse_stream events
- Capabilities: bedrock: prefix fallback (vision=False), exact Claude/Nova overrides
- Settings: AWS_BEDROCK_REGION and AWS_BEDROCK_PROFILE fields
- Factory: bedrock branch builds BedrockProvider
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

from app.agent.providers.bedrock.bedrock import (
    BedrockProvider,
    _messages_to_bedrock,
    _parse_converse_response,
    _tools_to_bedrock,
)
from app.agent.providers.capabilities import get_capabilities
from app.agent.schemas.chat import (
    AssistantMessage,
    FunctionCall,
    HumanMessage,
    SystemMessage,
    TextBlock,
    ToolCall,
    ToolMessage,
)


# ============================================================================
# Helpers
# ============================================================================


def _make_provider(**kwargs) -> BedrockProvider:
    """Build a BedrockProvider with the boto3 client patched out."""
    with patch(
        "app.agent.providers.bedrock.bedrock._make_client", return_value=MagicMock()
    ):
        return BedrockProvider(model="anthropic.claude-sonnet-4-6", **kwargs)


# ============================================================================
# __init__
# ============================================================================


class TestBedrockProviderInit:
    def test_model_stored(self):
        p = _make_provider()
        assert p.model == "anthropic.claude-sonnet-4-6"

    def test_region_defaults_to_us_east_1(self, monkeypatch):
        monkeypatch.delenv("AWS_DEFAULT_REGION", raising=False)
        with patch("app.core.config.settings") as mock_s:
            mock_s.AWS_BEDROCK_REGION = None
            with patch(
                "app.agent.providers.bedrock.bedrock._make_client",
                return_value=MagicMock(),
            ):
                p = BedrockProvider(model="anthropic.claude-sonnet-4-6")
        assert p._region == "us-east-1"

    def test_explicit_region_used(self):
        p = _make_provider(region_name="eu-west-1")
        assert p._region == "eu-west-1"

    def test_max_tokens_stored(self):
        p = _make_provider(max_tokens=512)
        assert p.max_tokens == 512

    def test_model_kwargs_stored(self):
        p = _make_provider(model_kwargs={"top_k": 50})
        assert p.model_kwargs["top_k"] == 50


# ============================================================================
# Message conversion
# ============================================================================


class TestMessagesToBedrock:
    def test_system_message_extracted(self):
        msgs = [SystemMessage(content="You are helpful."), HumanMessage(content="Hi")]
        system, converse = _messages_to_bedrock(msgs)
        assert system == "You are helpful."
        assert converse[0]["role"] == "user"

    def test_human_message_text(self):
        msgs = [HumanMessage(content="Hello")]
        _, converse = _messages_to_bedrock(msgs)
        assert converse[0] == {"role": "user", "content": [{"text": "Hello"}]}

    def test_human_message_with_parts(self):
        msg = HumanMessage(content="see image", parts=[TextBlock(text="describe this")])
        _, converse = _messages_to_bedrock([msg])
        assert converse[0]["content"] == [{"text": "describe this"}]

    def test_assistant_message_text(self):
        msgs = [AssistantMessage(content="Hi there")]
        _, converse = _messages_to_bedrock(msgs)
        assert converse[0] == {"role": "assistant", "content": [{"text": "Hi there"}]}

    def test_assistant_message_with_tool_calls(self):
        tc = ToolCall(
            id="call_1",
            function=FunctionCall(name="get_weather", arguments='{"city":"Paris"}'),
        )
        msgs = [AssistantMessage(content=None, tool_calls=[tc])]
        _, converse = _messages_to_bedrock(msgs)
        block = converse[0]["content"][0]
        assert "toolUse" in block
        assert block["toolUse"]["toolUseId"] == "call_1"
        assert block["toolUse"]["name"] == "get_weather"
        assert block["toolUse"]["input"] == {"city": "Paris"}

    def test_tool_message_becomes_tool_result_user_turn(self):
        msgs = [ToolMessage(content="Sunny", tool_call_id="call_1", name="get_weather")]
        _, converse = _messages_to_bedrock(msgs)
        assert converse[0]["role"] == "user"
        block = converse[0]["content"][0]
        assert "toolResult" in block
        assert block["toolResult"]["toolUseId"] == "call_1"
        assert block["toolResult"]["content"] == [{"text": "Sunny"}]

    def test_multiple_tool_messages_merged_into_one_user_turn(self):
        msgs = [
            ToolMessage(content="Sunny", tool_call_id="call_1"),
            ToolMessage(content="Rainy", tool_call_id="call_2"),
        ]
        _, converse = _messages_to_bedrock(msgs)
        assert len(converse) == 1  # one user turn with two tool results
        assert len(converse[0]["content"]) == 2

    def test_no_system_returns_none(self):
        msgs = [HumanMessage(content="Hello")]
        system, _ = _messages_to_bedrock(msgs)
        assert system is None

    def test_multiple_system_messages_joined(self):
        msgs = [
            SystemMessage(content="Part one."),
            SystemMessage(content="Part two."),
            HumanMessage(content="Hi"),
        ]
        system, _ = _messages_to_bedrock(msgs)
        assert system == "Part one.\n\nPart two."


# ============================================================================
# Tool spec conversion
# ============================================================================


class TestToolsToBedrock:
    def test_none_returns_none(self):
        assert _tools_to_bedrock(None) is None

    def test_empty_returns_none(self):
        # Empty list is treated the same as None — no toolConfig in the request
        assert _tools_to_bedrock([]) is None

    def test_converts_openai_tool_spec(self):
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "get_weather",
                    "description": "Get weather",
                    "parameters": {"type": "object", "properties": {}},
                },
            }
        ]
        result = _tools_to_bedrock(tools)
        assert result is not None
        assert len(result) == 1
        spec = result[0]["toolSpec"]
        assert spec["name"] == "get_weather"
        assert spec["description"] == "Get weather"
        assert spec["inputSchema"]["json"] == {"type": "object", "properties": {}}


# ============================================================================
# Response parsing
# ============================================================================


class TestParseConverseResponse:
    def _make_response(self, content_blocks, stop_reason="end_turn", usage=None):
        resp = {
            "output": {"message": {"role": "assistant", "content": content_blocks}},
            "stopReason": stop_reason,
        }
        if usage:
            resp["usage"] = usage
        return resp

    def test_text_response(self):
        resp = self._make_response([{"text": "Hello!"}])
        msg = _parse_converse_response(resp)
        assert msg.content == "Hello!"
        assert msg.tool_calls is None

    def test_tool_use_response(self):
        resp = self._make_response(
            [
                {
                    "toolUse": {
                        "toolUseId": "call_1",
                        "name": "get_weather",
                        "input": {"city": "Paris"},
                    }
                }
            ]
        )
        msg = _parse_converse_response(resp)
        assert msg.content is None
        assert msg.tool_calls is not None
        assert len(msg.tool_calls) == 1
        tc = msg.tool_calls[0]
        assert tc.id == "call_1"
        assert tc.function.name == "get_weather"
        assert json.loads(tc.function.arguments) == {"city": "Paris"}

    def test_mixed_text_and_tool_use(self):
        resp = self._make_response(
            [
                {"text": "Checking weather..."},
                {
                    "toolUse": {
                        "toolUseId": "call_1",
                        "name": "get_weather",
                        "input": {},
                    }
                },
            ]
        )
        msg = _parse_converse_response(resp)
        assert msg.content == "Checking weather..."
        assert msg.tool_calls is not None
        assert len(msg.tool_calls) == 1

    def test_empty_content_blocks(self):
        resp = self._make_response([])
        msg = _parse_converse_response(resp)
        assert msg.content is None
        assert msg.tool_calls is None


# ============================================================================
# chat() — async, uses asyncio.to_thread
# ============================================================================


class TestBedrockChat:
    """Chat tests mock at the boto3 client level (p._client.converse)."""

    def _make_converse_response(self, text: str = "ok", usage: dict | None = None):
        return {
            "output": {"message": {"role": "assistant", "content": [{"text": text}]}},
            "stopReason": "end_turn",
            "usage": usage or {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15},
        }

    @pytest.mark.asyncio
    async def test_chat_returns_assistant_message(self):
        p = _make_provider()
        p._client.converse = MagicMock(
            return_value=self._make_converse_response("Hello from Bedrock")
        )
        result = await p.chat([HumanMessage(content="Hi")])
        assert isinstance(result, AssistantMessage)
        assert result.content == "Hello from Bedrock"
        p._client.converse.assert_called_once()

    @pytest.mark.asyncio
    async def test_chat_passes_system_to_request(self):
        p = _make_provider()
        p._client.converse = MagicMock(return_value=self._make_converse_response())
        await p.chat(
            [SystemMessage(content="Be brief."), HumanMessage(content="Hello")]
        )
        call_kwargs = p._client.converse.call_args.kwargs
        assert call_kwargs.get("system") == [{"text": "Be brief."}]

    @pytest.mark.asyncio
    async def test_chat_passes_inference_config(self):
        p = _make_provider(max_tokens=100)
        p._client.converse = MagicMock(return_value=self._make_converse_response())
        await p.chat([HumanMessage(content="Hi")])
        ic = p._client.converse.call_args.kwargs.get("inferenceConfig", {})
        assert ic.get("maxTokens") == 100


# ============================================================================
# stream() — yields ChatCompletionChunk
# ============================================================================


class TestBedrockStream:
    """Stream tests mock at the boto3 client level (converse_stream), not asyncio internals.

    p._client.converse_stream is patched to return {"stream": [list of events]}.
    _nonblocking_iter receives that list and iterates it synchronously in the test
    thread pool — no real network I/O, no deadlocks.
    """

    def _patch_stream(self, provider: BedrockProvider, events: list):
        """Patch the boto3 client so converse_stream returns the given event list."""
        provider._client.converse_stream = MagicMock(return_value={"stream": events})

    @pytest.mark.asyncio
    async def test_stream_text_delta(self):
        events = [
            {"contentBlockDelta": {"delta": {"text": "Hello"}}},
            {"messageStop": {"stopReason": "end_turn"}},
        ]
        p = _make_provider()
        self._patch_stream(p, events)
        chunks = [c async for c in p.stream([HumanMessage(content="Hi")])]

        text_chunks = [c for c in chunks if c.choices[0].delta.content]
        assert any("Hello" in (c.choices[0].delta.content or "") for c in text_chunks)

    @pytest.mark.asyncio
    async def test_stream_stop_reason_in_last_chunk(self):
        events = [
            {"contentBlockDelta": {"delta": {"text": "Hi"}}},
            {"messageStop": {"stopReason": "end_turn"}},
        ]
        p = _make_provider()
        self._patch_stream(p, events)
        chunks = [c async for c in p.stream([HumanMessage(content="Hi")])]

        stop_chunks = [c for c in chunks if c.choices[0].finish_reason is not None]
        assert stop_chunks[-1].choices[0].finish_reason == "end_turn"

    @pytest.mark.asyncio
    async def test_stream_tool_use_emits_tool_call_deltas(self):
        events = [
            {
                "contentBlockStart": {
                    "start": {"toolUse": {"toolUseId": "call_1", "name": "get_weather"}}
                }
            },
            {
                "contentBlockDelta": {
                    "delta": {"toolUse": {"input": '{"city": "Paris"}'}}
                }
            },
            {"messageStop": {"stopReason": "tool_use"}},
        ]
        p = _make_provider()
        self._patch_stream(p, events)
        chunks = [c async for c in p.stream([HumanMessage(content="weather?")])]

        tool_chunks = [c for c in chunks if c.choices[0].delta.tool_calls]
        assert len(tool_chunks) >= 1
        first_tc = tool_chunks[0].choices[0].delta.tool_calls[0]
        assert first_tc.id == "call_1"
        assert first_tc.function.name == "get_weather"

    @pytest.mark.asyncio
    async def test_stream_usage_emitted(self):
        events = [
            {"contentBlockDelta": {"delta": {"text": "Hi"}}},
            {
                "metadata": {
                    "usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}
                }
            },
            {"messageStop": {"stopReason": "end_turn"}},
        ]
        p = _make_provider()
        self._patch_stream(p, events)
        chunks = [c async for c in p.stream([HumanMessage(content="Hi")])]

        usage_chunks = [c for c in chunks if c.usage is not None]
        assert len(usage_chunks) == 1
        assert usage_chunks[0].usage.prompt_tokens == 10
        assert usage_chunks[0].usage.completion_tokens == 5


# ============================================================================
# Capabilities
# ============================================================================


class TestBedrockCapabilities:
    """Bedrock uses a conservative text-only prefix default.

    Bedrock capabilities come from the bundled YAML registry. Claude
    4.x and Nova are listed with vision=true (both in-region and global
    inference profile IDs); unlisted Bedrock model IDs fall through to
    the all-false defaults. See
    ``documents/techdebts/model-capabilities-registry.md``.
    """

    def test_unknown_bedrock_model_defaults_no_vision(self):
        caps = get_capabilities("bedrock:some-unknown-model")
        assert caps.input.vision is False

    def test_claude_opus_4_7_listed_with_vision(self):
        caps = get_capabilities("bedrock:anthropic.claude-opus-4-7")
        assert caps.input.vision is True

    def test_claude_opus_4_7_global_listed_with_vision(self):
        caps = get_capabilities("bedrock:global.anthropic.claude-opus-4-7")
        assert caps.input.vision is True

    def test_nova_pro_listed_with_vision(self):
        caps = get_capabilities("bedrock:amazon.nova-pro-v1:0")
        assert caps.input.vision is True

    def test_document_text_true(self):
        caps = get_capabilities("bedrock:anthropic.claude-sonnet-4-6")
        assert caps.input.document_text is True

    def test_output_text_true(self):
        caps = get_capabilities("bedrock:some-model")
        assert caps.output.text is True


# ============================================================================
# Settings
# ============================================================================


class TestBedrockSettings:
    def test_aws_bedrock_region_field_exists(self):
        from app.core.config import Settings

        s = Settings()
        assert hasattr(s, "AWS_BEDROCK_REGION")

    def test_aws_bedrock_region_defaults_to_none(self, monkeypatch):
        from app.core.config import Settings

        monkeypatch.delenv("AWS_BEDROCK_REGION", raising=False)
        s = Settings()
        assert s.AWS_BEDROCK_REGION is None

    def test_aws_bedrock_region_reads_from_env(self, monkeypatch):
        from app.core.config import Settings

        monkeypatch.setenv("AWS_BEDROCK_REGION", "eu-central-1")
        s = Settings()
        assert s.AWS_BEDROCK_REGION == "eu-central-1"

    def test_aws_bedrock_profile_defaults_to_none(self, monkeypatch):
        from app.core.config import Settings

        monkeypatch.delenv("AWS_BEDROCK_PROFILE", raising=False)
        # Instantiate with no env_file so .env on disk doesn't interfere
        s = Settings(_env_file=None)  # type: ignore[call-arg]
        assert s.AWS_BEDROCK_PROFILE is None

    def test_aws_bedrock_profile_reads_from_env(self, monkeypatch):
        from app.core.config import Settings

        monkeypatch.setenv("AWS_BEDROCK_PROFILE", "my-profile")
        s = Settings()
        assert s.AWS_BEDROCK_PROFILE == "my-profile"


# ============================================================================
# Factory
# ============================================================================


class TestBedrockFactory:
    def test_factory_builds_bedrock_provider(self):
        from app.agent.providers.factory import build_provider

        with patch(
            "app.agent.providers.factory.BedrockProvider", return_value=MagicMock()
        ) as MockB:
            with patch("app.core.config.settings") as mock_s:
                mock_s.AWS_BEDROCK_REGION = None
                mock_s.AWS_BEDROCK_PROFILE = None
                build_provider("bedrock:anthropic.claude-sonnet-4-6")

            MockB.assert_called_once()
            assert MockB.call_args.kwargs["model"] == "anthropic.claude-sonnet-4-6"

    def test_factory_passes_region_from_settings(self):
        from app.agent.providers.factory import build_provider

        with patch(
            "app.agent.providers.factory.BedrockProvider", return_value=MagicMock()
        ) as MockB:
            with patch("app.core.config.settings") as mock_s:
                mock_s.AWS_BEDROCK_REGION = "us-west-2"
                mock_s.AWS_BEDROCK_PROFILE = None
                build_provider("bedrock:amazon.nova-pro-v1:0")

            assert MockB.call_args.kwargs["region_name"] == "us-west-2"

    def test_factory_passes_profile_from_settings(self):
        from app.agent.providers.factory import build_provider

        with patch(
            "app.agent.providers.factory.BedrockProvider", return_value=MagicMock()
        ) as MockB:
            with patch("app.core.config.settings") as mock_s:
                mock_s.AWS_BEDROCK_REGION = None
                mock_s.AWS_BEDROCK_PROFILE = "prod-profile"
                build_provider("bedrock:anthropic.claude-haiku-4-5-20251001-v1:0")

            assert MockB.call_args.kwargs["profile_name"] == "prod-profile"

    def test_factory_bedrock_in_supported_providers(self):
        from app.agent.providers.factory import SUPPORTED_PROVIDERS

        assert "bedrock" in SUPPORTED_PROVIDERS

    def test_factory_strips_provider_prefix_from_model(self):
        from app.agent.providers.factory import build_provider

        with patch(
            "app.agent.providers.factory.BedrockProvider", return_value=MagicMock()
        ) as MockB:
            with patch("app.core.config.settings") as mock_s:
                mock_s.AWS_BEDROCK_REGION = None
                mock_s.AWS_BEDROCK_PROFILE = None
                build_provider("bedrock:anthropic.claude-sonnet-4-6")

            assert MockB.call_args.kwargs["model"] == "anthropic.claude-sonnet-4-6"


# ============================================================================
# _build_request — provider-specific key stripping
# ============================================================================


class TestBuildRequestStripsProviderKeys:
    """thinking_level and other non-Bedrock keys must not reach additionalModelRequestFields."""

    def test_thinking_level_is_stripped(self):
        prov = _make_provider(model_kwargs={"thinking_level": "low"})
        messages = [HumanMessage(content="hi")]
        req = prov._build_request(
            messages, tools=None, merged={"thinking_level": "low"}
        )
        additional = req.get("additionalModelRequestFields", {})
        assert "thinking_level" not in additional

    def test_responses_api_is_stripped(self):
        prov = _make_provider(model_kwargs={"responses_api": True})
        messages = [HumanMessage(content="hi")]
        req = prov._build_request(messages, tools=None, merged={"responses_api": True})
        additional = req.get("additionalModelRequestFields", {})
        assert "responses_api" not in additional

    def test_reasoning_effort_is_stripped(self):
        prov = _make_provider(model_kwargs={"reasoning_effort": "high"})
        messages = [HumanMessage(content="hi")]
        req = prov._build_request(
            messages, tools=None, merged={"reasoning_effort": "high"}
        )
        additional = req.get("additionalModelRequestFields", {})
        assert "reasoning_effort" not in additional

    def test_unknown_bedrock_field_passes_through(self):
        """Genuine Bedrock-specific extras should still reach additionalModelRequestFields."""
        prov = _make_provider(model_kwargs={"top_k": 50})
        messages = [HumanMessage(content="hi")]
        req = prov._build_request(messages, tools=None, merged={"top_k": 50})
        assert req.get("additionalModelRequestFields", {}).get("top_k") == 50

    def test_no_additional_fields_key_when_all_stripped(self):
        """If all extra keys are stripped, additionalModelRequestFields must be absent."""
        prov = _make_provider(model_kwargs={"thinking_level": "high"})
        messages = [HumanMessage(content="hi")]
        req = prov._build_request(
            messages, tools=None, merged={"thinking_level": "high"}
        )
        assert "additionalModelRequestFields" not in req
