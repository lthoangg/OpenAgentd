"""Tests for the DeepSeek provider.

Covers:
- DeepSeekProvider.__init__: inherits OpenAIProvider, sets correct base_url
- DeepSeekProvider class hierarchy
- _make_default_provider_factory: deepseek branch reads DEEPSEEK_API_KEY, passes base_url
- Capabilities: deepseek: prefix fallback → vision=False
- app/core/config.py: DEEPSEEK_API_KEY field present
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from app.agent.providers.capabilities import get_capabilities
from app.agent.providers.deepseek import DeepSeekProvider
from app.agent.providers.deepseek.deepseek import DEEPSEEK_API_BASE
from app.agent.providers.openai import OpenAIProvider


# ============================================================================
# DeepSeekProvider class hierarchy
# ============================================================================


class TestDeepSeekProviderInheritance:
    """DeepSeekProvider must be a subclass of OpenAIProvider."""

    def test_deepseek_provider_is_subclass_of_openai_provider(self):
        assert issubclass(DeepSeekProvider, OpenAIProvider)

    def test_deepseek_api_base_constant(self):
        assert DEEPSEEK_API_BASE == "https://api.deepseek.com/v1"


# ============================================================================
# DeepSeekProvider.__init__
# ============================================================================


class TestDeepSeekProviderInit:
    """DeepSeekProvider constructor wires base_url and delegates to OpenAIProvider."""

    def _make_provider(self, **kwargs) -> DeepSeekProvider:
        """Helper — patch httpx so no real network calls are made."""
        with patch("app.agent.providers.openai.openai.CompletionsHandler"):
            with patch("app.agent.providers.openai.openai.ResponsesHandler"):
                return DeepSeekProvider(
                    api_key="ds-test-key", model="deepseek-v4-flash", **kwargs
                )

    def test_base_url_is_deepseek(self):
        p = self._make_provider()
        assert p.base_url == DEEPSEEK_API_BASE

    def test_model_stored(self):
        p = self._make_provider()
        assert p.model == "deepseek-v4-flash"

    def test_api_key_stored(self):
        p = self._make_provider()
        assert p.api_key == "ds-test-key"

    def test_custom_model(self):
        with patch("app.agent.providers.openai.openai.CompletionsHandler"):
            with patch("app.agent.providers.openai.openai.ResponsesHandler"):
                p = DeepSeekProvider(api_key="ds-test-key", model="deepseek-v4-pro")
        assert p.model == "deepseek-v4-pro"

    def test_empty_api_key_raises(self):
        with pytest.raises(ValueError, match="API key"):
            DeepSeekProvider(api_key="", model="deepseek-v4-flash")

    def test_max_tokens_forwarded(self):
        p = self._make_provider(max_tokens=1024)
        assert p.max_tokens == 1024

    def test_model_kwargs_forwarded(self):
        p = self._make_provider(model_kwargs={"extra_param": "value"})
        assert p.model_kwargs.get("extra_param") == "value"

    def test_thinking_level_stays_on_chat_completions(self):
        p = self._make_provider(model_kwargs={"thinking_level": "high"})
        assert p._use_responses is False

    def test_responses_api_true_stays_on_chat_completions(self):
        p = self._make_provider(model_kwargs={"responses_api": True})
        assert p._use_responses is False

    def test_default_max_tokens_is_none(self):
        p = self._make_provider()
        assert p.max_tokens is None


# ============================================================================
# Wire-field-name override (DeepSeek-specific)
# ============================================================================


class TestDeepSeekWireFieldName:
    """DeepSeek's API only accepts the legacy ``max_tokens`` field.

    The shared OpenAI handler now defaults to ``max_completion_tokens``
    (required by OpenAI's reasoning models since 2024-09).  DeepSeek's
    Chat Completions endpoint as of 2026-Q2 documents only
    ``max_tokens`` — sending ``max_completion_tokens`` is silently
    dropped, producing unbounded responses.

    The provider injects a ``CompletionsHandler`` subclass that flips
    the ``uses_max_completion_tokens`` class flag to ``False`` so the
    legacy field name stays on the wire.  These tests pin that
    behaviour.
    """

    def test_handler_uses_legacy_max_tokens_field(self):
        """The wire body must carry ``max_tokens``, not the new field."""
        from app.agent.schemas.chat import HumanMessage

        p = DeepSeekProvider(
            api_key="ds-test-key", model="deepseek-v4-pro", max_tokens=512
        )
        body = p._completions.build_request(
            [HumanMessage(content="hi")],
            None,
            stream=False,
            merged=p._merged_kwargs(),
        )
        assert body["max_tokens"] == 512
        assert "max_completion_tokens" not in body

    def test_handler_subclass_flag_is_false(self):
        """The class-level flag is what gates the field-name choice."""
        p = DeepSeekProvider(api_key="ds-test-key", model="deepseek-v4-pro")
        assert p._completions.uses_max_completion_tokens is False


# ============================================================================
# Provider factory — deepseek branch
# ============================================================================


class TestDeepSeekProviderFactory:
    """_make_default_provider_factory correctly builds DeepSeekProvider for deepseek: models."""

    def test_factory_calls_deepseek_provider_with_correct_api_key(self):
        from app.agent.providers.factory import build_provider

        mock_provider = MagicMock()
        with patch(
            "app.agent.providers.factory.DeepSeekProvider",
            return_value=mock_provider,
        ) as MockDS:
            with patch("app.core.config.settings") as mock_settings:
                mock_settings.DEEPSEEK_API_KEY = MagicMock()
                mock_settings.DEEPSEEK_API_KEY.get_secret_value.return_value = (
                    "ds-secret"
                )
                build_provider("deepseek:deepseek-v4-flash")

            MockDS.assert_called_once()
            call_kwargs = MockDS.call_args.kwargs
            assert call_kwargs.get("api_key") == "ds-secret"
            assert call_kwargs.get("model") == "deepseek-v4-flash"

    def test_factory_reads_deepseek_api_key_from_settings(self):
        from app.agent.providers.factory import build_provider

        with patch(
            "app.agent.providers.factory.DeepSeekProvider",
            return_value=MagicMock(),
        ) as MockDS:
            with patch("app.core.config.settings") as mock_settings:
                mock_settings.DEEPSEEK_API_KEY = MagicMock()
                mock_settings.DEEPSEEK_API_KEY.get_secret_value.return_value = (
                    "ds-from-settings"
                )
                build_provider("deepseek:deepseek-v4-pro")

            assert MockDS.call_args.kwargs.get("api_key") == "ds-from-settings"

    def test_factory_falls_back_to_env_when_settings_key_is_none(self, monkeypatch):
        from app.agent.providers.factory import build_provider

        monkeypatch.setenv("DEEPSEEK_API_KEY", "ds-from-env")
        with patch(
            "app.agent.providers.factory.DeepSeekProvider",
            return_value=MagicMock(),
        ) as MockDS:
            with patch("app.core.config.settings") as mock_settings:
                mock_settings.DEEPSEEK_API_KEY = None
                build_provider("deepseek:deepseek-v4-flash")

            assert MockDS.call_args.kwargs.get("api_key") == "ds-from-env"

    def test_factory_strips_provider_prefix_from_model(self):
        from app.agent.providers.factory import build_provider

        with patch(
            "app.agent.providers.factory.DeepSeekProvider",
            return_value=MagicMock(),
        ) as MockDS:
            with patch("app.core.config.settings") as mock_settings:
                mock_settings.DEEPSEEK_API_KEY = MagicMock()
                mock_settings.DEEPSEEK_API_KEY.get_secret_value.return_value = "key"
                build_provider("deepseek:deepseek-v4-pro")

            assert MockDS.call_args.kwargs.get("model") == "deepseek-v4-pro"

    def test_factory_unsupported_provider_error_mentions_deepseek(self):
        """deepseek is listed in the supported providers error message."""
        from app.agent.providers.factory import build_provider

        with pytest.raises(ValueError, match="deepseek"):
            build_provider("totally_unknown:model")

    def test_factory_raises_when_deepseek_api_key_missing(self, monkeypatch):
        """Factory raises a clear ValueError when DEEPSEEK_API_KEY is not set."""
        from app.agent.providers.factory import build_provider

        monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
        with patch("app.core.config.settings") as mock_settings:
            mock_settings.DEEPSEEK_API_KEY = None
            with pytest.raises(ValueError, match="DEEPSEEK_API_KEY"):
                build_provider("deepseek:deepseek-v4-flash")


# ============================================================================
# thinking_level → thinking object + reasoning_effort
# ============================================================================


class TestDeepSeekThinking:
    """DeepSeek thinking mode requires both ``thinking`` object and ``reasoning_effort``.

    The base ``CompletionsHandler.customize_thinking`` only sends ``reasoning_effort``.
    DeepSeek needs ``thinking: {type: enabled}`` alongside it.
    When thinking_level is absent, DeepSeek's default thinking mode applies;
    explicit ``none``/``off`` must send the API's disabled toggle.
    """

    def _build_body(self, thinking_level: str | None = None) -> dict:
        from app.agent.schemas.chat import HumanMessage

        kwargs = {}
        if thinking_level is not None:
            kwargs["model_kwargs"] = {"thinking_level": thinking_level}
        p = DeepSeekProvider(api_key="ds-test-key", model="deepseek-v4-flash", **kwargs)
        return p._completions.build_request(
            [HumanMessage(content="hi")],
            None,
            stream=False,
            merged=p._merged_kwargs(),
        )

    def test_thinking_object_sent_when_thinking_level_high(self):
        body = self._build_body("high")
        assert body.get("thinking") == {"type": "enabled"}
        assert body.get("reasoning_effort") == "high"

    def test_thinking_object_sent_when_thinking_level_medium(self):
        body = self._build_body("medium")
        assert body.get("thinking") == {"type": "enabled"}
        assert body.get("reasoning_effort") == "medium"

    def test_thinking_object_sent_when_thinking_level_low(self):
        body = self._build_body("low")
        assert body.get("thinking") == {"type": "enabled"}
        assert body.get("reasoning_effort") == "low"

    def test_thinking_disabled_when_thinking_level_none(self):
        body = self._build_body("none")
        assert body["thinking"] == {"type": "disabled"}
        assert "reasoning_effort" not in body

    def test_thinking_disabled_when_thinking_level_off(self):
        body = self._build_body("off")
        assert body["thinking"] == {"type": "disabled"}
        assert "reasoning_effort" not in body

    def test_thinking_not_sent_when_thinking_level_absent(self):
        body = self._build_body()
        assert "thinking" not in body
        assert "reasoning_effort" not in body


# ============================================================================
# reasoning_content echoed back on tool-call assistant messages
# ============================================================================


class TestDeepSeekReasoningContentEcho:
    """DeepSeek requires reasoning_content to be echoed back when a tool call was made.

    The canonical AssistantMessage has reasoning_content marked exclude=True so
    other providers never see it.  The DeepSeek handler re-reads it directly and
    injects it into the wire message for assistant turns that contain tool_calls.
    Without this DeepSeek returns a 400.
    """

    def _make_handler(self) -> object:
        p = DeepSeekProvider(api_key="ds-test-key", model="deepseek-v4-flash")
        return p._completions

    def test_reasoning_content_in_wire_body_on_tool_call_assistant_message(self):
        """reasoning_content must survive model_dump and appear in the request body."""
        from app.agent.schemas.chat import (
            AssistantMessage,
            FunctionCall,
            HumanMessage,
            ToolCall,
            ToolMessage,
        )

        p = DeepSeekProvider(api_key="ds-test-key", model="deepseek-v4-flash")
        tool_call = ToolCall(id="c1", function=FunctionCall(name="f", arguments="{}"))
        messages = [
            HumanMessage(content="hi"),
            AssistantMessage(
                content=None,
                reasoning_content="I should call the tool",
                tool_calls=[tool_call],
            ),
            ToolMessage(content="result", tool_call_id="c1"),
        ]
        body = p._completions.build_request(
            messages, None, stream=False, merged=p._merged_kwargs()
        )
        assistant_msg = body["messages"][1]
        assert assistant_msg.get("reasoning_content") == "I should call the tool"

    def test_reasoning_content_absent_from_wire_body_without_tool_calls(self):
        """reasoning_content must NOT appear on non-tool-call assistant turns."""
        from app.agent.schemas.chat import AssistantMessage

        p = DeepSeekProvider(api_key="ds-test-key", model="deepseek-v4-flash")
        messages = [
            AssistantMessage(content="answer", reasoning_content="some thoughts")
        ]
        body = p._completions.build_request(
            messages, None, stream=False, merged=p._merged_kwargs()
        )
        assert "reasoning_content" not in body["messages"][0]

    def test_reasoning_content_absent_from_wire_body_when_none(self):
        """No reasoning_content field when assistant message has tool_calls but no reasoning."""
        from app.agent.schemas.chat import (
            AssistantMessage,
            FunctionCall,
            HumanMessage,
            ToolCall,
            ToolMessage,
        )

        p = DeepSeekProvider(api_key="ds-test-key", model="deepseek-v4-flash")
        tool_call = ToolCall(id="c1", function=FunctionCall(name="f", arguments="{}"))
        messages = [
            HumanMessage(content="hi"),
            AssistantMessage(
                content=None, reasoning_content=None, tool_calls=[tool_call]
            ),
            ToolMessage(content="result", tool_call_id="c1"),
        ]
        body = p._completions.build_request(
            messages, None, stream=False, merged=p._merged_kwargs()
        )
        assert "reasoning_content" not in body["messages"][1]

    def test_reasoning_content_not_injected_when_absent(self):
        from app.agent.schemas.chat import AssistantMessage
        from app.agent.schemas.chat import FunctionCall, ToolCall

        handler = self._make_handler()
        msg = AssistantMessage(
            content=None,
            reasoning_content=None,
            tool_calls=[
                ToolCall(id="c1", function=FunctionCall(name="f", arguments="{}"))
            ],
        )
        wire = handler.convert_messages([msg])
        assert wire[0].__dict__.get("reasoning_content") is None

    def test_assistant_message_without_tool_calls_coerces_empty_content(self):
        """Sanitized history can strip tool_calls, so DeepSeek still needs content."""
        from app.agent.schemas.chat import AssistantMessage

        handler = self._make_handler()
        wire = handler._convert_messages_deepseek([AssistantMessage(content=None)])
        assert wire[0].content == ""

    def test_sanitized_incomplete_tool_call_turn_keeps_valid_assistant_content(self):
        """Incomplete tool-call turns are stripped to content-only, not null-content."""
        from app.agent.schemas.chat import AssistantMessage, FunctionCall, ToolCall

        p = DeepSeekProvider(api_key="ds-test-key", model="deepseek-v4-flash")
        messages = [
            AssistantMessage(
                content=None,
                tool_calls=[
                    ToolCall(
                        id="c1",
                        function=FunctionCall(name="f", arguments="{}"),
                    )
                ],
            )
        ]
        body = p._completions.build_request(
            messages, None, stream=False, merged=p._merged_kwargs()
        )
        assert body["messages"][0]["content"] == ""
        assert "tool_calls" not in body["messages"][0]


# ============================================================================
# Capabilities — deepseek: prefix
# ============================================================================


class TestDeepSeekCapabilities:
    """deepseek: prefix resolves to vision=False for every model."""

    def test_deepseek_prefix_vision_false(self):
        caps = get_capabilities("deepseek:some-unknown-model")
        assert caps.input.vision is False

    def test_deepseek_v4_flash_vision_false(self):
        caps = get_capabilities("deepseek:deepseek-v4-flash")
        assert caps.input.vision is False

    def test_deepseek_v4_pro_vision_false(self):
        caps = get_capabilities("deepseek:deepseek-v4-pro")
        assert caps.input.vision is False

    def test_deepseek_prefix_document_text_true(self):
        caps = get_capabilities("deepseek:deepseek-v4-flash")
        assert caps.input.document_text is True

    def test_deepseek_prefix_output_text_true(self):
        caps = get_capabilities("deepseek:deepseek-v4-flash")
        assert caps.output.text is True

    def test_deepseek_prefix_output_image_false(self):
        caps = get_capabilities("deepseek:deepseek-v4-flash")
        assert caps.output.image is False

    def test_deepseek_prefix_audio_false(self):
        caps = get_capabilities("deepseek:deepseek-v4-flash")
        assert caps.input.audio is False

    def test_deepseek_prefix_case_insensitive(self):
        caps_lower = get_capabilities("deepseek:deepseek-v4-flash")
        caps_upper = get_capabilities("DEEPSEEK:deepseek-v4-flash")
        assert caps_lower == caps_upper


# ============================================================================
# Settings — DEEPSEEK_API_KEY field
# ============================================================================


class TestDeepSeekSettings:
    """DEEPSEEK_API_KEY is defined in Settings and defaults to None."""

    def test_deepseek_api_key_field_exists(self):
        from app.core.config import Settings

        s = Settings(_env_file=None)  # type: ignore[call-arg]
        assert hasattr(s, "DEEPSEEK_API_KEY")

    def test_deepseek_api_key_defaults_to_none(self, monkeypatch):
        from app.core.config import Settings

        monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
        s = Settings(_env_file=None)  # type: ignore[call-arg]
        assert s.DEEPSEEK_API_KEY is None

    def test_deepseek_api_key_accepts_string_via_env(self, monkeypatch):
        from app.core.config import Settings

        monkeypatch.setenv("DEEPSEEK_API_KEY", "deepseek-test-value")
        s = Settings()
        assert s.DEEPSEEK_API_KEY is not None
        assert s.DEEPSEEK_API_KEY.get_secret_value() == "deepseek-test-value"
