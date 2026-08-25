from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
import respx
from httpx import Response
from pydantic import SecretStr

from app.agent.providers.catalog import find
from app.agent.providers.factory import SUPPORTED_PROVIDERS, build_provider
from app.agent.providers.model_discovery import discover_provider_models
from app.agent.providers.model_metadata import ModelCost, ModelTransport
from app.agent.providers.opencode.opencode import OpenCodeProvider
from app.agent.schemas.chat import (
    AssistantMessage,
    FunctionCall,
    HumanMessage,
    ToolCall,
    ToolMessage,
)


@pytest.mark.parametrize(
    (
        "provider_id",
        "label",
        "base_url",
        "docs_url",
        "env_var",
        "public_access",
    ),
    [
        (
            "opencode",
            "OpenCode Zen",
            "https://opencode.ai/zen/v1",
            "https://opencode.ai/docs/zen/",
            "OPENCODE_ZEN_API_KEY",
            True,
        ),
        (
            "opencode-go",
            "OpenCode Go",
            "https://opencode.ai/zen/go/v1",
            "https://opencode.ai/docs/go/",
            "OPENCODE_GO_API_KEY",
            False,
        ),
    ],
)
def test_opencode_provider_is_registered_and_builds_provider(
    provider_id: str,
    label: str,
    base_url: str,
    docs_url: str,
    env_var: str,
    public_access: bool,
) -> None:
    entry = find(provider_id)

    assert entry is not None
    assert entry["label"] == label
    assert entry["kind"] == "api_key"
    assert entry["env_var"] == env_var
    assert entry["models_dev_provider_id"] == provider_id
    assert entry["docs_url"] == docs_url
    assert entry.get("public_access", False) is public_access
    assert provider_id in SUPPORTED_PROVIDERS

    with patch(
        "app.agent.providers.factory.OpenCodeProvider",
        return_value=MagicMock(),
    ) as provider:
        with patch("app.core.config.settings") as settings:
            setattr(settings, env_var, SecretStr(f"{provider_id}-key"))
            built = build_provider(f"{provider_id}:deepseek-v4-flash")

    assert built.provider_name == provider_id
    assert provider.call_args.kwargs == {
        "api_key": f"{provider_id}-key",
        "model": "deepseek-v4-flash",
        "provider_id": provider_id,
        "base_url": base_url,
        "model_kwargs": {},
    }


def test_opencode_zero_cost_model_builds_with_public_credential_without_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("OPENCODE_ZEN_API_KEY", raising=False)

    with patch("app.core.config.settings") as settings:
        settings.OPENCODE_ZEN_API_KEY = None
        with patch(
            "app.agent.providers.model_metadata.get_model_cost",
            return_value=ModelCost(input=0),
        ):
            built = build_provider("opencode:anonymous-model")

    assert isinstance(built, OpenCodeProvider)
    assert built.provider_name == "opencode"
    assert built.api_key == "public"


def test_opencode_nonzero_cost_model_requires_zen_key_even_with_free_suffix(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("OPENCODE_ZEN_API_KEY", raising=False)
    monkeypatch.setenv("OPENCODE_GO_API_KEY", "go-key")

    with patch("app.core.config.settings") as settings:
        settings.OPENCODE_ZEN_API_KEY = None
        with patch(
            "app.agent.providers.model_metadata.get_model_cost",
            return_value=ModelCost(input=1),
        ):
            with pytest.raises(
                ValueError,
                match=(
                    "OpenCode Zen model 'misleading-free' requires OPENCODE_ZEN_API_KEY"
                ),
            ):
                build_provider("opencode:misleading-free")


def test_opencode_go_requires_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENCODE_ZEN_API_KEY", "zen-key")
    monkeypatch.delenv("OPENCODE_GO_API_KEY", raising=False)

    with patch("app.core.config.settings") as settings:
        settings.OPENCODE_GO_API_KEY = None
        with pytest.raises(ValueError, match="OpenCode Go API key is required"):
            build_provider("opencode-go:deepseek-v4-flash")


@pytest.mark.parametrize(
    ("model", "api_family", "delegate_type", "expected_url"),
    [
        (
            "gpt-5.6-sol",
            "responses",
            "OpenCodeResponsesProvider",
            "https://opencode.ai/zen/v1/responses",
        ),
        (
            "claude-sonnet-4-6",
            "messages",
            "AnthropicProvider",
            "https://opencode.ai/zen/v1/messages",
        ),
        (
            "gemini-3.6-flash",
            "generate_content",
            "GoogleGenAIProvider",
            "https://opencode.ai/zen/v1/models/gemini-3.6-flash:generateContent",
        ),
        (
            "deepseek-v4-flash",
            "chat_completions",
            "OpenCodeDeepSeekProvider",
            "https://opencode.ai/zen/v1/chat/completions",
        ),
    ],
)
def test_opencode_provider_uses_each_models_documented_api_family(
    model: str, api_family: str, delegate_type: str, expected_url: str
) -> None:
    provider = OpenCodeProvider(
        api_key="opencode-key",
        model=model,
        provider_id="opencode",
        base_url="https://opencode.ai/zen/v1",
    )

    with patch(
        "app.agent.providers.opencode.opencode.get_model_transport",
        return_value=ModelTransport(endpoint_variant="default", api_family=api_family),
    ):
        delegate = provider._delegate()

    assert type(delegate).__name__ == delegate_type
    if api_family == "responses":
        assert f"{delegate.base_url}/responses" == expected_url
        assert delegate._use_responses is True
    elif api_family == "messages":
        assert f"{delegate.base_url}/v1/messages" == expected_url
        assert delegate.headers["x-api-key"] == "opencode-key"
    elif api_family == "generate_content":
        assert delegate._build_url("generateContent") == expected_url
        assert delegate._auth_headers()["x-goog-api-key"] == "opencode-key"
    else:
        assert f"{delegate.base_url}/chat/completions" == expected_url


def test_opencode_deepseek_replays_reasoning_content_for_tool_calls() -> None:
    provider = OpenCodeProvider(
        api_key="opencode-key",
        model="deepseek-v4-flash-free",
        provider_id="opencode",
        base_url="https://opencode.ai/zen/v1",
    )
    tool_call = ToolCall(
        id="call-1", function=FunctionCall(name="read", arguments='{"path":"a.py"}')
    )
    messages = [
        HumanMessage(content="Read the file"),
        AssistantMessage(
            reasoning_content="I need to inspect the file.",
            tool_calls=[tool_call],
        ),
        ToolMessage(content="contents", tool_call_id="call-1"),
    ]

    with patch(
        "app.agent.providers.opencode.opencode.get_model_transport",
        return_value=ModelTransport(
            endpoint_variant="default", api_family="chat_completions"
        ),
    ):
        delegate = provider._delegate()

    body = delegate._completions.build_request(
        messages, None, False, delegate._merged_kwargs()
    )

    assert body["messages"][1]["reasoning_content"] == "I need to inspect the file."


def test_opencode_responses_provider_preserves_stateless_reasoning() -> None:
    provider = OpenCodeProvider(
        api_key="opencode-key",
        model="gpt-5.6-luna",
        provider_id="opencode-go",
        base_url="https://opencode.ai/zen/go/v1",
    )

    with patch(
        "app.agent.providers.opencode.opencode.get_model_transport",
        return_value=ModelTransport(endpoint_variant="default", api_family="responses"),
    ):
        delegate = provider._delegate()

    body = delegate._responses.build_request(
        [HumanMessage(content="hello")], None, False, delegate._merged_kwargs()
    )
    assert body["store"] is False
    assert body["include"] == ["reasoning.encrypted_content"]


def test_opencode_provider_defaults_unknown_transport_to_chat_completions() -> None:
    provider = OpenCodeProvider(
        api_key="opencode-key",
        model="new-model",
        provider_id="opencode",
        base_url="https://opencode.ai/zen/v1",
        model_kwargs={"thinking_level": "high"},
    )

    with patch(
        "app.agent.providers.opencode.opencode.get_model_transport", return_value=None
    ):
        delegate = provider._delegate()

    assert type(delegate).__name__ == "ChatCompletionsOnlyProvider"
    assert delegate._use_responses is False


def test_opencode_chat_completions_require_a_terminal_sse_frame() -> None:
    """Only free Zen chat-completions streams reject a truncated EOF."""
    provider = OpenCodeProvider(
        api_key="opencode-key",
        model="hy3-free",
        provider_id="opencode",
        base_url="https://opencode.ai/zen/v1",
    )

    with patch(
        "app.agent.providers.opencode.opencode.get_model_transport",
        return_value=ModelTransport(
            endpoint_variant="default", api_family="chat_completions"
        ),
    ):
        delegate = provider._delegate()

    assert delegate._completions.require_sse_sentinel is True
    assert delegate._completions.retryable_finish_reasons == frozenset(
        {"network_error"}
    )


def test_opencode_paid_chat_completions_keep_the_default_eof_compatibility() -> None:
    """The free-model safeguard must not alter paid or other providers."""
    provider = OpenCodeProvider(
        api_key="opencode-key",
        model="deepseek-v4-flash",
        provider_id="opencode",
        base_url="https://opencode.ai/zen/v1",
    )

    with patch(
        "app.agent.providers.opencode.opencode.get_model_transport",
        return_value=ModelTransport(
            endpoint_variant="default", api_family="chat_completions"
        ),
    ):
        delegate = provider._delegate()

    assert delegate._completions.require_sse_sentinel is False
    assert delegate._completions.retryable_finish_reasons == frozenset()


@respx.mock
@pytest.mark.parametrize(
    ("provider_id", "models_url"),
    [
        ("opencode", "https://opencode.ai/zen/v1/models"),
        ("opencode-go", "https://opencode.ai/zen/go/v1/models"),
    ],
)
async def test_opencode_provider_discovers_models_with_its_own_api_key(
    provider_id: str, models_url: str
) -> None:
    route = respx.get(models_url).mock(
        return_value=Response(
            200,
            json={
                "object": "list",
                "data": [
                    {"id": "deepseek-v4-flash"},
                    {"id": "kimi-k3"},
                ],
            },
        )
    )
    entry = find(provider_id)

    assert entry is not None
    models = await discover_provider_models(
        entry, overrides={entry["env_var"]: f"{provider_id}-key"}
    )

    assert models == ["deepseek-v4-flash", "kimi-k3"]
    assert route.calls[0].request.headers["Authorization"] == (
        f"Bearer {provider_id}-key"
    )


@respx.mock
async def test_opencode_provider_discovers_only_public_models_without_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("OPENCODE_ZEN_API_KEY", raising=False)
    route = respx.get("https://opencode.ai/zen/v1/models").mock(
        return_value=Response(
            200,
            json={
                "object": "list",
                "data": [
                    {"id": "anonymous-model"},
                    {"id": "misleading-free"},
                ],
            },
        )
    )
    entry = find("opencode")

    assert entry is not None
    costs = {
        "opencode:anonymous-model": ModelCost(input=0),
        "opencode:misleading-free": ModelCost(input=1),
    }
    with patch(
        "app.agent.providers.model_metadata.get_model_cost",
        side_effect=costs.__getitem__,
    ):
        models = await discover_provider_models(
            entry, overrides={"OPENCODE_ZEN_API_KEY": ""}
        )

    assert models == ["anonymous-model"]
    assert route.calls[0].request.headers["Authorization"] == "Bearer public"


def test_opencode_api_keys_are_separate_secret_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.core.config import Settings

    monkeypatch.setenv("OPENCODE_ZEN_API_KEY", "zen-key")
    monkeypatch.setenv("OPENCODE_GO_API_KEY", "go-key")

    settings = Settings(_env_file=None)  # type: ignore[call-arg]

    assert isinstance(settings.OPENCODE_ZEN_API_KEY, SecretStr)
    assert settings.OPENCODE_ZEN_API_KEY.get_secret_value() == "zen-key"
    assert isinstance(settings.OPENCODE_GO_API_KEY, SecretStr)
    assert settings.OPENCODE_GO_API_KEY.get_secret_value() == "go-key"
    assert not hasattr(settings, "OPENCODE_API_KEY")
