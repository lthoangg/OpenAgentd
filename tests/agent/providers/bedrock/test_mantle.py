"""Bedrock Mantle delegation contract."""

from __future__ import annotations

from unittest.mock import patch

import pytest

from app.agent.providers.bedrock.bedrock import BedrockProvider
from app.agent.schemas.chat import HumanMessage


def test_region_rejects_values_that_could_change_the_mantle_host() -> None:
    with pytest.raises(ValueError, match="AWS Bedrock region"):
        BedrockProvider(
            model="openai.gpt-oss-20b",
            region_name="us-east-1@attacker.example",
            bearer_token="token",
        )


def test_direct_bearer_token_is_used_without_generation() -> None:
    provider = BedrockProvider(model="amazon.nova-pro-v1:0", bearer_token="token")

    with patch(
        "app.agent.providers.bedrock.bedrock._generate_profile_token"
    ) as generate:
        assert provider._fresh_bearer_token() == "token"

    generate.assert_not_called()


def test_profile_token_is_generated_fresh_for_each_request() -> None:
    provider = BedrockProvider(model="amazon.nova-pro-v1:0", profile_name="work")

    with patch(
        "app.agent.providers.bedrock.bedrock._generate_profile_token",
        side_effect=["one", "two"],
    ) as generate:
        assert provider._fresh_bearer_token() == "one"
        assert provider._fresh_bearer_token() == "two"

    assert generate.call_args_list == [
        (("us-east-1", "work"),),
        (("us-east-1", "work"),),
    ]


def test_anthropic_models_use_anthropic_mantle_path() -> None:
    provider = BedrockProvider(
        model="anthropic.claude-sonnet-4-6", bearer_token="token"
    )

    delegate = provider._delegate()

    assert delegate.base_url == "https://bedrock-mantle.us-east-1.api.aws/anthropic"
    assert delegate.headers["x-api-key"] == "token"
    assert "Authorization" not in delegate.headers


def test_anthropic_mantle_model_uses_current_adaptive_thinking_contract() -> None:
    provider = BedrockProvider(
        model="anthropic.claude-sonnet-5",
        bearer_token="token",
        model_kwargs={"thinking_level": "high"},
    )

    delegate = provider._delegate()
    payload = delegate._payload(
        [HumanMessage(content="hello")], None, delegate._merged_kwargs()
    )

    assert payload["thinking"] == {"type": "adaptive", "display": "summarized"}
    assert payload["output_config"] == {"effort": "high"}


def test_anthropic_delegate_uses_bedrock_max_completion_limit() -> None:
    provider = BedrockProvider(
        model="anthropic.claude-sonnet-4-6", bearer_token="token"
    )

    with patch(
        "app.agent.providers.model_metadata.get_model_limits",
        return_value=type("Limits", (), {"max_completion_tokens": 8192})(),
    ):
        delegate = provider._delegate()

    assert delegate.max_tokens == 8192


def test_openai_default_variant_uses_chat_completions() -> None:
    provider = BedrockProvider(model="amazon.nova-pro-v1:0", bearer_token="token")

    with patch(
        "app.agent.providers.bedrock.bedrock.get_model_transport", return_value=None
    ):
        delegate = provider._delegate()

    assert delegate.base_url == "https://bedrock-mantle.us-east-1.api.aws/v1"
    assert delegate._use_responses is False


def test_responses_transport_uses_stateless_reasoning_replay() -> None:
    provider = BedrockProvider(model="amazon.nova-pro-v1:0", bearer_token="token")

    with patch(
        "app.agent.providers.bedrock.bedrock.get_model_transport",
        return_value=type(
            "Transport", (), {"endpoint_variant": "default", "api_family": "responses"}
        )(),
    ):
        delegate = provider._delegate()

    assert delegate._use_responses is True
    body = delegate._responses.build_request(
        [HumanMessage(content="hello")], None, False, delegate._merged_kwargs()
    )
    assert body["store"] is False
    assert body["include"] == ["reasoning.encrypted_content"]


def test_explicit_responses_api_false_overrides_mantle_responses_default() -> None:
    provider = BedrockProvider(
        model="amazon.nova-pro-v1:0",
        bearer_token="token",
        model_kwargs={"responses_api": False},
    )

    assert provider._delegate()._use_responses is False


@pytest.mark.asyncio
async def test_expired_profile_credentials_raise_without_leaking_token() -> None:
    provider = BedrockProvider(model="amazon.nova-pro-v1:0")
    with patch(
        "app.agent.providers.bedrock.bedrock._generate_profile_token",
        side_effect=RuntimeError("expired credentials token-secret"),
    ):
        with pytest.raises(
            RuntimeError, match="Bedrock bearer token generation failed"
        ) as error:
            await provider.chat([HumanMessage(content="hello")])

    assert "token-secret" not in str(error.value)
