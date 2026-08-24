"""Tests for app/agent/providers/deepseek/usage.py."""

from __future__ import annotations

import pytest

from app.agent.providers.deepseek import usage


class _FakeResponse:
    def __init__(self, status_code: int, payload: object):
        self.status_code = status_code
        self._payload = payload

    def json(self) -> object:
        return self._payload


class _FakeClient:
    payload: object = {
        "is_available": True,
        "balance_infos": [
            {
                "currency": "USD",
                "total_balance": "15.50",
                "granted_balance": "0.00",
                "topped_up_balance": "15.50",
            },
            {
                "currency": "CNY",
                "total_balance": "0.00",
                "granted_balance": "0.00",
                "topped_up_balance": "0.00",
            },
        ],
    }
    status_code: int = 200

    def __init__(self, *_args, **_kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def get(self, url: str, *, headers: dict[str, str]):
        assert url == "https://api.deepseek.com/user/balance"
        assert headers["Authorization"] == "Bearer test-sk-ds-key"
        return _FakeResponse(self.status_code, self.payload)


async def test_get_usage_with_usd_balance(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _FakeClient.status_code = 200
    _FakeClient.payload = {
        "is_available": True,
        "balance_infos": [
            {
                "currency": "USD",
                "total_balance": "15.50",
                "granted_balance": "0.00",
                "topped_up_balance": "15.50",
            }
        ],
    }
    monkeypatch.setattr(usage.httpx2, "AsyncClient", _FakeClient)

    result = await usage.get_usage(api_key="test-sk-ds-key")

    assert result.provider == "deepseek"
    assert len(result.limits) == 1
    limit = result.limits[0]
    assert limit.limit_id == "deepseek"
    assert limit.limit_name == "DeepSeek Balance"
    assert limit.credits is not None
    assert limit.credits.has_credits is True
    assert limit.credits.balance == "$15.50"
    assert limit.plan_type == "Pay-as-you-go"


async def test_get_usage_with_cny_balance(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _FakeClient.status_code = 200
    _FakeClient.payload = {
        "is_available": True,
        "balance_infos": [
            {
                "currency": "CNY",
                "total_balance": "50.00",
                "granted_balance": "10.00",
                "topped_up_balance": "40.00",
            }
        ],
    }
    monkeypatch.setattr(usage.httpx2, "AsyncClient", _FakeClient)

    result = await usage.get_usage(api_key="test-sk-ds-key")

    assert result.provider == "deepseek"
    limit = result.limits[0]
    assert limit.credits is not None
    assert limit.credits.balance == "¥50.00"


async def test_get_usage_raises_credentials_error_on_401(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _FakeClient.status_code = 401
    _FakeClient.payload = {"error": "Authentication Fails"}
    monkeypatch.setattr(usage.httpx2, "AsyncClient", _FakeClient)

    with pytest.raises(usage.DeepSeekUsageCredentialsError):
        await usage.get_usage(api_key="test-sk-ds-key")


async def test_get_usage_raises_credentials_error_when_no_key_found(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.agent.providers.plugin_registry.ProviderCredentialStore.get",
        lambda _self, _name: "",
    )
    with pytest.raises(usage.DeepSeekUsageCredentialsError):
        await usage.get_usage(api_key=None)
