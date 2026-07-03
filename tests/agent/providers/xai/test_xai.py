"""Tests for the xAI (Grok) provider.

Covers:
- XAIProvider.__init__: inherits OpenAIProvider, sets correct base_url
- XAIProvider class hierarchy
- _make_default_provider_factory: xai branch reads XAI_API_KEY, passes base_url
- Capabilities: xai: prefix fallback → vision=True
- app/core/config.py: XAI_API_KEY field present
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from app.agent.providers.xai import XAIProvider
from app.agent.providers.xai.xai import XAI_API_BASE
from app.agent.providers.openai import OpenAIProvider
from app.agent.providers.capabilities import get_capabilities


# ============================================================================
# XAIProvider class hierarchy
# ============================================================================


class TestXAIProviderInheritance:
    """XAIProvider must be a subclass of OpenAIProvider."""

    def test_xai_provider_is_subclass_of_openai_provider(self):
        assert issubclass(XAIProvider, OpenAIProvider)

    def test_xai_api_base_constant(self):
        assert XAI_API_BASE == "https://api.x.ai/v1"


# ============================================================================
# XAIProvider.__init__
# ============================================================================


class TestXAIProviderInit:
    """XAIProvider constructor wires base_url and delegates to OpenAIProvider."""

    def _make_provider(self, **kwargs) -> XAIProvider:
        """Helper — patch httpx so no real network calls are made."""
        with patch("app.agent.providers.openai.openai.CompletionsHandler"):
            with patch("app.agent.providers.openai.openai.ResponsesHandler"):
                return XAIProvider(api_key="xai-test-key", model="grok-4", **kwargs)

    def test_base_url_is_xai(self):
        p = self._make_provider()
        assert p.base_url == XAI_API_BASE

    def test_model_stored(self):
        p = self._make_provider()
        assert p.model == "grok-4"

    def test_api_key_stored(self):
        p = self._make_provider()
        assert p.api_key == "xai-test-key"

    def test_custom_model(self):
        with patch("app.agent.providers.openai.openai.CompletionsHandler"):
            with patch("app.agent.providers.openai.openai.ResponsesHandler"):
                p = XAIProvider(api_key="xai-test-key", model="grok-3-mini")
        assert p.model == "grok-3-mini"

    def test_empty_api_key_raises(self):
        with pytest.raises(ValueError, match="API key"):
            XAIProvider(api_key="", model="grok-4")

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
# Provider factory — xai branch
# ============================================================================


class TestXAIProviderFactory:
    """_make_default_provider_factory correctly builds XAIProvider for xai: models."""

    def test_factory_calls_xai_provider_with_correct_base_url(self):
        from app.agent.providers.factory import build_provider

        mock_provider = MagicMock()
        with patch(
            "app.agent.providers.factory.XAIProvider", return_value=mock_provider
        ) as MockXAI:
            with patch("app.core.config.settings") as mock_settings:
                mock_settings.XAI_API_KEY = MagicMock()
                mock_settings.XAI_API_KEY.get_secret_value.return_value = "xai-secret"
                build_provider("xai:grok-4")

            MockXAI.assert_called_once()
            call_kwargs = MockXAI.call_args.kwargs
            assert call_kwargs.get("api_key") == "xai-secret"
            assert call_kwargs.get("model") == "grok-4"

    def test_factory_reads_xai_api_key_from_settings(self):
        from app.agent.providers.factory import build_provider

        with patch(
            "app.agent.providers.factory.XAIProvider", return_value=MagicMock()
        ) as MockXAI:
            with patch("app.core.config.settings") as mock_settings:
                mock_settings.XAI_API_KEY = MagicMock()
                mock_settings.XAI_API_KEY.get_secret_value.return_value = (
                    "xai-from-settings"
                )
                build_provider("xai:grok-3-mini")

            assert MockXAI.call_args.kwargs.get("api_key") == "xai-from-settings"

    def test_factory_falls_back_to_env_when_settings_key_is_none(self, monkeypatch):
        from app.agent.providers.factory import build_provider

        monkeypatch.setenv("XAI_API_KEY", "xai-from-env")
        with patch(
            "app.agent.providers.factory.XAIProvider", return_value=MagicMock()
        ) as MockXAI:
            with patch("app.core.config.settings") as mock_settings:
                mock_settings.XAI_API_KEY = None
                build_provider("xai:grok-4")

            assert MockXAI.call_args.kwargs.get("api_key") == "xai-from-env"

    def test_factory_strips_provider_prefix_from_model(self):
        from app.agent.providers.factory import build_provider

        with patch(
            "app.agent.providers.factory.XAIProvider", return_value=MagicMock()
        ) as MockXAI:
            with patch("app.core.config.settings") as mock_settings:
                mock_settings.XAI_API_KEY = MagicMock()
                mock_settings.XAI_API_KEY.get_secret_value.return_value = "key"
                build_provider("xai:grok-4-heavy")

            assert MockXAI.call_args.kwargs.get("model") == "grok-4-heavy"

    def test_factory_unsupported_provider_error_mentions_xai(self):
        """xai is listed in the supported providers error message."""
        from app.agent.providers.factory import build_provider

        with pytest.raises(ValueError, match="xai"):
            build_provider("totally_unknown:model")

    def test_factory_raises_when_xai_api_key_missing(self, monkeypatch):
        """Factory raises a clear ValueError when XAI_API_KEY is not set."""
        from app.agent.providers.factory import build_provider

        monkeypatch.delenv("XAI_API_KEY", raising=False)
        with patch("app.core.config.settings") as mock_settings:
            mock_settings.XAI_API_KEY = None
            with pytest.raises(ValueError, match="XAI_API_KEY"):
                build_provider("xai:grok-4")


# ============================================================================
# Capabilities — xai: exact-match resolution
# ============================================================================


class TestXAICapabilities:
    """``xai:`` capabilities come from the bundled YAML registry.

    Grok-4 / Grok-4.3 are listed with vision=true. Older or unlisted
    Grok IDs fall through to the all-false defaults (the resolver no
    longer matches by provider prefix).
    """

    def test_grok_4_listed_with_vision(self):
        caps = get_capabilities("xai:grok-4")
        assert caps.input.vision is True

    def test_unlisted_grok_defaults_no_vision(self):
        # grok-3-mini is not in the model registry — falls through to
        # all-false defaults. Image attachments will be rejected at the
        # gate, which is the safe behaviour for an un-curated model.
        caps = get_capabilities("xai:grok-3-mini")
        assert caps.input.vision is False

    def test_document_text_true(self):
        caps = get_capabilities("xai:grok-4")
        assert caps.input.document_text is True

    def test_output_text_true(self):
        caps = get_capabilities("xai:grok-4")
        assert caps.output.text is True

    def test_output_image_false(self):
        caps = get_capabilities("xai:grok-4")
        assert caps.output.image is False

    def test_audio_false(self):
        caps = get_capabilities("xai:grok-4")
        assert caps.input.audio is False

    def test_case_insensitive_lookup(self):
        caps_lower = get_capabilities("xai:grok-4")
        caps_upper = get_capabilities("XAI:grok-4")
        assert caps_lower == caps_upper


# ============================================================================
# Settings — XAI_API_KEY field
# ============================================================================


class TestXAISettings:
    """XAI_API_KEY is defined in Settings and defaults to None."""

    def test_xai_api_key_field_exists(self):
        from app.core.config import Settings

        s = Settings()
        assert hasattr(s, "XAI_API_KEY")

    def test_xai_api_key_defaults_to_none(self):
        from app.core.config import Settings

        s = Settings()
        assert s.XAI_API_KEY is None

    def test_xai_api_key_accepts_string_via_env(self, monkeypatch):
        from app.core.config import Settings

        monkeypatch.setenv("XAI_API_KEY", "xai-test-value")
        s = Settings()
        assert s.XAI_API_KEY is not None
        assert s.XAI_API_KEY.get_secret_value() == "xai-test-value"
