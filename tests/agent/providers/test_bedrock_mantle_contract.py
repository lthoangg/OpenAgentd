"""Bedrock Mantle settings and provider-catalog contract tests."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from pydantic import SecretStr

from app.agent.providers.catalog import find


def test_bedrock_catalog_offers_bearer_key_not_legacy_access_keys() -> None:
    entry = find("bedrock")

    assert entry is not None
    credential_names = {field["name"] for field in entry["credentials"]}
    assert credential_names == {
        "AWS_BEDROCK_REGION",
        "AWS_BEDROCK_PROFILE",
        "AWS_BEARER_TOKEN_BEDROCK",
    }


def test_bedrock_bearer_token_is_a_secret_setting(monkeypatch) -> None:
    from app.core.config import Settings

    monkeypatch.setenv("AWS_BEARER_TOKEN_BEDROCK", "bedrock-api-key-test")

    settings = Settings(_env_file=None)  # type: ignore[call-arg]

    assert (
        settings.AWS_BEARER_TOKEN_BEDROCK.get_secret_value() == "bedrock-api-key-test"
    )


def test_bedrock_factory_forwards_mantle_credentials() -> None:
    from app.agent.providers.factory import build_provider

    with patch(
        "app.agent.providers.factory.BedrockProvider", return_value=MagicMock()
    ) as provider:
        with patch("app.core.config.settings") as settings:
            settings.AWS_BEDROCK_REGION = "eu-west-1"
            settings.AWS_BEDROCK_PROFILE = "production"
            settings.AWS_BEARER_TOKEN_BEDROCK = SecretStr("bedrock-api-key-test")

            build_provider("bedrock:openai.gpt-oss-20b")

    assert provider.call_args.kwargs == {
        "model": "openai.gpt-oss-20b",
        "region_name": "eu-west-1",
        "profile_name": "production",
        "bearer_token": "bedrock-api-key-test",
        "model_kwargs": {},
    }
