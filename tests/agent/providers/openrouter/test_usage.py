"""Tests for app/agent/providers/openrouter/usage.py."""

from __future__ import annotations

import pytest

from app.agent.providers.openrouter import usage


class _FakeResponse:
    def __init__(self, status_code: int, payload: object):
        self.status_code = status_code
        self._payload = payload

    def json(self) -> object:
        return self._payload


class _FakeClient:
    credits_payload: object = {
        "data": {
            "total_credits": 25.5,
            "total_usage": 5.2,
        }
    }
    auth_key_payload: object = {
        "data": {
            "label": "My OpenRouter Key",
            "usage": 5.2,
            "limit": 50.0,
            "is_free_tier": False,
        }
    }
    credits_status: int = 200
    auth_key_status: int = 200

    def __init__(self, *_args, **_kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def get(self, url: str, *, headers: dict[str, str]):
        assert headers["Authorization"] == "Bearer test-sk-or-key"
        if "credits" in url:
            return _FakeResponse(self.credits_status, self.credits_payload)
        if "auth/key" in url:
            return _FakeResponse(self.auth_key_status, self.auth_key_payload)
        raise ValueError(f"Unexpected url {url}")


async def test_get_usage_with_explicit_key_and_credits_and_spend_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _FakeClient.credits_status = 200
    _FakeClient.auth_key_status = 200
    _FakeClient.credits_payload = {
        "data": {
            "total_credits": 100.0,
            "total_usage": 15.5,
        }
    }
    _FakeClient.auth_key_payload = {
        "data": {
            "label": "Production Key",
            "usage": 15.5,
            "limit": 50.0,
            "is_free_tier": False,
        }
    }
    monkeypatch.setattr(usage.httpx2, "AsyncClient", _FakeClient)

    result = await usage.get_usage(api_key="test-sk-or-key")

    assert result.provider == "openrouter"
    assert len(result.limits) == 1
    limit = result.limits[0]
    assert limit.limit_id == "openrouter"
    assert limit.limit_name == "OpenRouter (Production Key)"
    assert limit.plan_type == "Production Key"
    assert limit.credits is not None
    assert limit.credits.has_credits is True
    assert limit.credits.balance == "$84.50"
    assert limit.spend is not None
    assert limit.spend.reached is False
    assert limit.spend.limit == 50.0
    assert limit.spend.used == 15.5
    assert limit.spend.remaining == 34.5
    assert limit.spend.used_percent == 31.0


async def test_get_usage_free_tier_no_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _FakeClient.credits_status = 200
    _FakeClient.auth_key_status = 200
    _FakeClient.credits_payload = {
        "data": {
            "total_credits": 0.0,
            "total_usage": 0.0,
        }
    }
    _FakeClient.auth_key_payload = {
        "data": {
            "label": "",
            "usage": 0.0,
            "limit": None,
            "is_free_tier": True,
        }
    }
    monkeypatch.setattr(usage.httpx2, "AsyncClient", _FakeClient)

    result = await usage.get_usage(api_key="test-sk-or-key")

    assert result.provider == "openrouter"
    limit = result.limits[0]
    assert limit.plan_type == "Free tier"
    assert limit.credits is not None
    assert limit.credits.balance == "$0.00"
    assert limit.spend is None


async def test_get_usage_with_standard_api_key_403_credits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Standard OpenRouter API keys return 403 on /credits but 200 on /auth/key."""
    _FakeClient.credits_status = 403
    _FakeClient.auth_key_status = 200
    _FakeClient.credits_payload = {
        "error": {
            "code": 403,
            "message": "Only management keys can perform this operation",
        }
    }
    _FakeClient.auth_key_payload = {
        "data": {
            "label": "Standard Inference Key",
            "usage": 1.25,
            "limit": None,
            "limit_remaining": None,
            "is_free_tier": False,
            "rate_limit": {"requests": 40, "interval": "10s"},
        }
    }
    monkeypatch.setattr(usage.httpx2, "AsyncClient", _FakeClient)

    result = await usage.get_usage(api_key="test-sk-or-key")

    assert result.provider == "openrouter"
    assert len(result.limits) == 1
    limit = result.limits[0]
    assert limit.limit_name == "OpenRouter (Standard Inference Key)"
    assert limit.plan_type == "Standard Inference Key"
    assert limit.credits is not None
    assert limit.credits.has_credits is True
    assert limit.credits.unlimited is True
    assert limit.credits.balance == "$1.25 used"
    assert limit.spend is None


async def test_get_usage_with_key_limit_and_limit_remaining(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Key with spend limit and limit_remaining."""
    _FakeClient.credits_status = 403
    _FakeClient.auth_key_status = 200
    _FakeClient.auth_key_payload = {
        "data": {
            "label": "Limited Key",
            "usage": 2.50,
            "limit": 10.0,
            "limit_remaining": 7.50,
            "is_free_tier": False,
        }
    }
    monkeypatch.setattr(usage.httpx2, "AsyncClient", _FakeClient)

    result = await usage.get_usage(api_key="test-sk-or-key")

    assert result.provider == "openrouter"
    limit = result.limits[0]
    assert limit.spend is not None
    assert limit.spend.limit == 10.0
    assert limit.spend.used == 2.50
    assert limit.spend.remaining == 7.50
    assert limit.spend.used_percent == 25.0
    assert limit.credits is not None
    assert limit.credits.balance == "$7.50"


async def test_get_usage_raises_credentials_error_on_401(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _FakeClient.credits_status = 401
    _FakeClient.auth_key_status = 401
    monkeypatch.setattr(usage.httpx2, "AsyncClient", _FakeClient)

    with pytest.raises(usage.OpenRouterUsageCredentialsError):
        await usage.get_usage(api_key="test-sk-or-key")


async def test_get_usage_raises_credentials_error_when_no_key_found(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.agent.providers.plugin_registry.ProviderCredentialStore.get",
        lambda _self, _name: "",
    )
    with pytest.raises(usage.OpenRouterUsageCredentialsError):
        await usage.get_usage(api_key=None)
