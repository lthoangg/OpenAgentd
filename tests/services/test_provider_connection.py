"""Provider credential-state tests."""

from __future__ import annotations

from app.agent.providers.catalog import find
from app.services.provider_connection import provider_is_configured


def test_bedrock_is_configured_with_direct_bearer_token(monkeypatch) -> None:
    entry = find("bedrock")
    assert entry is not None
    monkeypatch.setenv("AWS_BEARER_TOKEN_BEDROCK", "bedrock-api-key-test")

    assert provider_is_configured(entry) is True


def test_bedrock_is_configured_with_a_named_profile(monkeypatch) -> None:
    entry = find("bedrock")
    assert entry is not None
    monkeypatch.setenv("AWS_BEDROCK_PROFILE", "company")

    assert provider_is_configured(entry) is True
