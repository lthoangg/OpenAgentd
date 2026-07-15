from __future__ import annotations

from unittest.mock import MagicMock, patch

from pydantic.types import SecretStr

from app.agent.providers.catalog import find
from app.agent.providers.openai import ChatCompletionsOnlyProvider, OpenAIProvider
from app.agent.providers.router9 import Router9Provider


def _make_provider(model_kwargs: dict[str, object] | None = None) -> Router9Provider:
    with patch("app.agent.providers.openai.openai.CompletionsHandler"):
        with patch("app.agent.providers.openai.openai.ResponsesHandler"):
            return Router9Provider(
                api_key="sk_9router",
                model="cc/claude-sonnet-4-5",
                base_url="http://localhost:20128/v1",
                model_kwargs=model_kwargs,
            )


def test_router9_provider_subclasses_openai_provider() -> None:
    assert issubclass(Router9Provider, OpenAIProvider)
    assert issubclass(Router9Provider, ChatCompletionsOnlyProvider)


def test_router9_catalog_links_to_official_repository() -> None:
    assert find("router9")["docs_url"] == "https://github.com/decolua/9router"


def test_router9_never_uses_responses_with_thinking_level() -> None:
    provider = _make_provider(model_kwargs={"thinking_level": "high"})

    assert provider._use_responses is False


def test_router9_never_uses_responses_with_explicit_responses_api() -> None:
    provider = _make_provider(model_kwargs={"responses_api": True})

    assert provider._use_responses is False


def test_factory_builds_router9_provider() -> None:
    from app.agent.providers.factory import build_provider

    with patch(
        "app.agent.providers.factory.Router9Provider", return_value=MagicMock()
    ) as mock_router9:
        with patch("app.core.config.settings") as mock_settings:
            mock_settings.ROUTER9_API_KEY = SecretStr("sk_9router")
            mock_settings.ROUTER9_BASE_URL = "http://localhost:20128/v1"
            build_provider(
                "router9:cc/claude-sonnet-4-5",
                model_kwargs={"thinking_level": "high"},
            )

    mock_router9.assert_called_once()
    call_kwargs = mock_router9.call_args.kwargs
    assert call_kwargs["model"] == "cc/claude-sonnet-4-5"
    assert call_kwargs["base_url"] == "http://localhost:20128/v1"
    assert call_kwargs["model_kwargs"] == {"thinking_level": "high"}


def test_factory_respects_router9_base_url_env_override(monkeypatch) -> None:
    from app.agent.providers.factory import build_provider

    monkeypatch.setenv("ROUTER9_BASE_URL", "http://127.0.0.1:20128/v1")
    with patch(
        "app.agent.providers.factory.Router9Provider", return_value=MagicMock()
    ) as mock_router9:
        with patch("app.core.config.settings") as mock_settings:
            mock_settings.ROUTER9_API_KEY = SecretStr("sk_9router")
            mock_settings.ROUTER9_BASE_URL = "http://localhost:20128/v1"
            build_provider("router9:cc/claude-sonnet-4-5")

    assert mock_router9.call_args.kwargs["base_url"] == "http://127.0.0.1:20128/v1"
