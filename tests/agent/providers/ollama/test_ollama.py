"""Tests for the Ollama provider.

Covers:
- OllamaProvider: inherits OpenAIProvider, sets correct base_url
- OllamaProvider: empty API key falls back to "ollama" placeholder (daemon ignores auth)
- OllamaProvider: cloud-suffixed model names pass through verbatim
- Factory: ollama branch reads settings, respects OLLAMA_BASE_URL override
- Capabilities: ollama: prefix fallback → vision=False
- Settings: OLLAMA_API_KEY (optional), OLLAMA_BASE_URL
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from app.agent.providers.capabilities import get_capabilities
from app.agent.providers.ollama import OllamaProvider
from app.agent.providers.ollama.ollama import OLLAMA_LOCAL_API_BASE
from app.agent.providers.openai import OpenAIProvider


# ============================================================================
# Class hierarchy
# ============================================================================


class TestOllamaProviderInheritance:
    """OllamaProvider must subclass OpenAIProvider."""

    def test_is_subclass_of_openai_provider(self):
        assert issubclass(OllamaProvider, OpenAIProvider)

    def test_local_api_base_constant(self):
        assert OLLAMA_LOCAL_API_BASE == "http://localhost:11434/v1"


# ============================================================================
# OllamaProvider — __init__
# ============================================================================


class TestOllamaProviderInit:
    """OllamaProvider wires the local URL by default and tolerates empty keys."""

    def _make_provider(self, **kwargs) -> OllamaProvider:
        with patch("app.agent.providers.openai.openai.CompletionsHandler"):
            with patch("app.agent.providers.openai.openai.ResponsesHandler"):
                return OllamaProvider(model="llama3.2", **kwargs)

    def test_default_base_url_is_local(self):
        p = self._make_provider()
        assert p.base_url == OLLAMA_LOCAL_API_BASE

    def test_default_api_key_is_placeholder(self):
        p = self._make_provider()
        assert p.api_key == "ollama"

    def test_empty_api_key_falls_back_to_placeholder(self):
        # The daemon ignores auth, but OpenAIProvider rejects empty keys —
        # OllamaProvider must substitute the documented placeholder.
        p = self._make_provider(api_key="")
        assert p.api_key == "ollama"

    def test_explicit_api_key_is_respected(self):
        p = self._make_provider(api_key="custom-key")
        assert p.api_key == "custom-key"

    def test_custom_base_url_overrides_default(self):
        p = self._make_provider(base_url="http://gpu-box:11434/v1")
        assert p.base_url == "http://gpu-box:11434/v1"

    def test_model_stored(self):
        p = self._make_provider()
        assert p.model == "llama3.2"

    def test_model_with_tag(self):
        with patch("app.agent.providers.openai.openai.CompletionsHandler"):
            with patch("app.agent.providers.openai.openai.ResponsesHandler"):
                p = OllamaProvider(model="qwen2.5-coder:7b")
        assert p.model == "qwen2.5-coder:7b"

    def test_cloud_suffixed_model_is_passed_through_verbatim(self):
        # Cloud models are routed through the local daemon by appending
        # "-cloud" to the model name; the provider must not transform it.
        with patch("app.agent.providers.openai.openai.CompletionsHandler"):
            with patch("app.agent.providers.openai.openai.ResponsesHandler"):
                p = OllamaProvider(model="kimi-k2.6-cloud")
        assert p.model == "kimi-k2.6-cloud"

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


# ============================================================================
# Provider factory — ollama branch
# ============================================================================


class TestOllamaProviderFactory:
    """build_provider routes ollama: → OllamaProvider with the configured URL."""

    def test_factory_builds_provider_with_default_base_url(self):
        from app.agent.providers.factory import build_provider

        with patch(
            "app.agent.providers.factory.OllamaProvider", return_value=MagicMock()
        ) as MockOllama:
            with patch("app.core.config.settings") as mock_settings:
                mock_settings.OLLAMA_API_KEY = None
                mock_settings.OLLAMA_BASE_URL = "http://localhost:11434/v1"
                build_provider("ollama:llama3.2")

            MockOllama.assert_called_once()
            call_kwargs = MockOllama.call_args.kwargs
            assert call_kwargs.get("api_key") is None
            assert call_kwargs.get("model") == "llama3.2"
            assert call_kwargs.get("base_url") == "http://localhost:11434/v1"

    def test_factory_strips_provider_prefix_from_model_with_tag(self):
        # Model names can contain ':' (e.g. 'qwen2.5-coder:7b'); the factory
        # must split on the *first* ':' only.
        from app.agent.providers.factory import build_provider

        with patch(
            "app.agent.providers.factory.OllamaProvider", return_value=MagicMock()
        ) as MockOllama:
            with patch("app.core.config.settings") as mock_settings:
                mock_settings.OLLAMA_API_KEY = None
                mock_settings.OLLAMA_BASE_URL = "http://localhost:11434/v1"
                build_provider("ollama:qwen2.5-coder:7b")

            assert MockOllama.call_args.kwargs.get("model") == "qwen2.5-coder:7b"

    def test_factory_passes_cloud_suffixed_model_verbatim(self):
        # Cloud models reach the daemon as e.g. "kimi-k2.6-cloud" — same
        # routing as local models, the suffix stays in the model name.
        from app.agent.providers.factory import build_provider

        with patch(
            "app.agent.providers.factory.OllamaProvider", return_value=MagicMock()
        ) as MockOllama:
            with patch("app.core.config.settings") as mock_settings:
                mock_settings.OLLAMA_API_KEY = None
                mock_settings.OLLAMA_BASE_URL = "http://localhost:11434/v1"
                build_provider("ollama:kimi-k2.6-cloud")

            assert MockOllama.call_args.kwargs.get("model") == "kimi-k2.6-cloud"

    def test_factory_respects_ollama_base_url_env_override(self, monkeypatch):
        from app.agent.providers.factory import build_provider

        monkeypatch.setenv("OLLAMA_BASE_URL", "http://gpu-box:11434/v1")
        with patch(
            "app.agent.providers.factory.OllamaProvider", return_value=MagicMock()
        ) as MockOllama:
            with patch("app.core.config.settings") as mock_settings:
                mock_settings.OLLAMA_API_KEY = None
                mock_settings.OLLAMA_BASE_URL = "http://localhost:11434/v1"
                build_provider("ollama:llama3.2")

            assert (
                MockOllama.call_args.kwargs.get("base_url") == "http://gpu-box:11434/v1"
            )

    def test_factory_lists_ollama_in_supported_providers(self):
        from app.agent.providers.factory import SUPPORTED_PROVIDERS

        assert "ollama" in SUPPORTED_PROVIDERS

    def test_factory_unsupported_provider_error_mentions_ollama(self):
        from app.agent.providers.factory import build_provider

        with pytest.raises(ValueError, match="ollama"):
            build_provider("totally_unknown:model")


# ============================================================================
# Capabilities — ollama: prefix fallback
# ============================================================================


class TestOllamaCapabilities:
    """ollama: prefix defaults to vision=False (catalog is too varied)."""

    def test_ollama_prefix_vision_false(self):
        caps = get_capabilities("ollama:llama3.2")
        assert caps.input.vision is False

    def test_ollama_prefix_output_text_true(self):
        caps = get_capabilities("ollama:llama3.2")
        assert caps.output.text is True

    def test_ollama_prefix_output_image_false(self):
        caps = get_capabilities("ollama:llama3.2")
        assert caps.output.image is False

    def test_ollama_prefix_case_insensitive(self):
        caps_lower = get_capabilities("ollama:llama3.2")
        caps_upper = get_capabilities("OLLAMA:llama3.2")
        assert caps_lower == caps_upper


# ============================================================================
# Settings — OLLAMA_API_KEY / OLLAMA_BASE_URL
# ============================================================================


class TestOllamaSettings:
    """Ollama-related fields exist in Settings with documented defaults."""

    def test_ollama_api_key_defaults_to_none(self, monkeypatch):
        from app.core.config import Settings

        monkeypatch.delenv("OLLAMA_API_KEY", raising=False)
        s = Settings()
        assert s.OLLAMA_API_KEY is None

    def test_ollama_base_url_default_is_localhost(self, monkeypatch):
        from app.core.config import Settings

        monkeypatch.delenv("OLLAMA_BASE_URL", raising=False)
        s = Settings()
        assert s.OLLAMA_BASE_URL == "http://localhost:11434/v1"

    def test_ollama_api_key_accepts_string_via_env(self, monkeypatch):
        from app.core.config import Settings

        monkeypatch.setenv("OLLAMA_API_KEY", "custom-key")
        s = Settings()
        assert s.OLLAMA_API_KEY.get_secret_value() == "custom-key"
