from __future__ import annotations

import pytest
import respx
from httpx import Response

from app.agent.providers.model_discovery import (
    _bedrock_models,
    _codex_models,
    _copilot_models,
)


@respx.mock
async def test_bedrock_models_use_mantle_with_a_direct_bearer_token() -> None:
    route = respx.get("https://bedrock-mantle.us-east-1.api.aws/v1/models").mock(
        return_value=Response(
            200,
            json={
                "data": [
                    {"id": "anthropic.claude-sonnet-4-6"},
                    {"id": "openai.gpt-oss-20b"},
                ]
            },
        )
    )

    models = await _bedrock_models(
        {
            "AWS_BEDROCK_REGION": "us-east-1",
            "AWS_BEARER_TOKEN_BEDROCK": "bedrock-api-key-test",
        }
    )

    assert models == ["anthropic.claude-sonnet-4-6", "openai.gpt-oss-20b"]
    assert route.calls[0].request.headers["Authorization"] == (
        "Bearer bedrock-api-key-test"
    )


@respx.mock
async def test_bedrock_models_generate_a_mantle_bearer_token_from_profile(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    credentials = object()

    class _Session:
        def __init__(self, *, profile: str) -> None:
            assert profile == "production"

        def get_credentials(self) -> object:
            return credentials

    def _provide_token(*, region: str, aws_credentials_provider: object) -> str:
        assert region == "eu-west-1"
        assert aws_credentials_provider.load() is credentials
        return "generated-bedrock-token"

    monkeypatch.setattr("botocore.session.Session", _Session)
    monkeypatch.setattr("aws_bedrock_token_generator.provide_token", _provide_token)
    route = respx.get("https://bedrock-mantle.eu-west-1.api.aws/v1/models").mock(
        return_value=Response(200, json={"data": [{"id": "openai.gpt-oss-20b"}]})
    )

    models = await _bedrock_models(
        {"AWS_BEDROCK_REGION": "eu-west-1", "AWS_BEDROCK_PROFILE": "production"}
    )

    assert models == ["openai.gpt-oss-20b"]
    assert route.calls[0].request.headers["Authorization"] == (
        "Bearer generated-bedrock-token"
    )


@pytest.mark.asyncio
async def test_copilot_models_filter_by_plan_and_policy_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.agent.providers.copilot.copilot.copilot_model_catalog",
        lambda: {
            "gpt-4.1": {
                "limits": {"input": 1, "output": 1},
                "supports": {"tool_calls": True},
                "policy_state": "active",
                "restricted_to": ["edu"],
            },
            "gpt-4o": {
                "limits": {"input": 1, "output": 1},
                "supports": {"tool_calls": True},
                "policy_state": "active",
                "restricted_to": [],
            },
            "gpt-4o-mini": {
                "limits": {"input": 1, "output": 1},
                "supports": {"tool_calls": True},
                "policy_state": "disabled",
                "restricted_to": [],
            },
            "gpt-5.4-mini": {
                "limits": {"input": 1, "output": 1},
                "supports": {"tool_calls": True},
                "policy_state": "active",
                "restricted_to": ["pro"],
            },
            "claude-sonnet-4.5": {
                "limits": {"input": 1, "output": 1},
                "supports": {"tool_calls": True},
                "policy_state": "active",
                "restricted_to": ["business"],
            },
            "gpt-5-mini": {
                "limits": {"input": 1, "output": 1},
                "supports": {"tool_calls": True},
                "policy_state": "active",
                "restricted_to": ["individual"],
            },
        },
    )
    monkeypatch.setattr(
        "app.agent.providers.copilot.usage.model_plan_type",
        lambda: "student",
    )

    assert await _copilot_models() == ["gpt-4.1", "gpt-4o"]


@pytest.mark.asyncio
async def test_copilot_models_keep_plan_restricted_models_when_plan_unknown(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.agent.providers.copilot.copilot.copilot_model_catalog",
        lambda: {
            "gpt-4.1": {
                "limits": {"input": 1, "output": 1},
                "supports": {"tool_calls": True},
                "policy_state": "active",
                "restricted_to": ["pro"],
            },
            "gpt-4o-mini": {
                "limits": {"input": 1, "output": 1},
                "supports": {"tool_calls": True},
                "policy_state": "active",
                "restricted_to": [],
            },
            "gpt-5.4-mini": {
                "limits": {"input": 1, "output": 1},
                "supports": {"tool_calls": True},
                "policy_state": "active",
                "restricted_to": ["edu"],
            },
        },
    )
    monkeypatch.setattr(
        "app.agent.providers.copilot.usage.model_plan_type",
        lambda: None,
    )

    assert await _copilot_models() == ["gpt-4.1", "gpt-4o-mini", "gpt-5.4-mini"]


async def test_codex_models_use_the_shared_live_catalog_cache(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.agent.providers.codex.catalog.load_codex_catalog",
        lambda: {
            "models": [
                {"slug": "gpt-5.6-sol", "context_window": 272_000},
                {"slug": "gpt-5.6-terra", "context_window": 272_000},
                {"context_window": 272_000},
            ]
        },
    )

    assert await _codex_models() == ["gpt-5.6-sol", "gpt-5.6-terra"]
