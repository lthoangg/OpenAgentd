"""Tests for app/agent/providers/grok/usage.py."""

from __future__ import annotations

import pytest
from pydantic import SecretStr

from app.agent.providers.grok import usage
from app.agent.providers.grok.oauth import GrokOAuth


class _FakeResponse:
    def __init__(self, payload: object):
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> object:
        return self._payload


class _FakeClient:
    payload: object = {}

    def __init__(self, *_args, **_kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def get(self, url, *, headers):  # type: ignore[no-untyped-def]
        assert url == "https://cli-chat-proxy.grok.com/v1/billing?format=credits"
        assert headers["Authorization"] == "Bearer access-token"
        return _FakeResponse(self.payload)


def _oauth() -> GrokOAuth:
    return GrokOAuth(
        access_token=SecretStr("access-token"),
        refresh_token=SecretStr("refresh-token"),
        expires_at=4_102_444_800,
    )


@pytest.mark.asyncio
async def test_get_usage_preserves_unmetered_weekly_period_without_inventing_quota(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.agent.providers.grok.oauth.GrokOAuth.load", _oauth)
    _FakeClient.payload = {
        "config": {
            "currentPeriod": {
                "type": "USAGE_PERIOD_TYPE_WEEKLY",
                "start": "2026-07-15T00:00:00+00:00",
                "end": "2026-07-22T00:00:00+00:00",
            },
            "isUnifiedBillingUser": True,
            "onDemandCap": {"val": 0},
            "onDemandUsed": {"val": 0},
            "prepaidBalance": {"val": 0},
        }
    }
    monkeypatch.setattr(usage.httpx, "AsyncClient", _FakeClient)

    result = await usage.get_usage()

    assert result.provider == "grok"
    assert len(result.limits) == 1
    period = result.limits[0]
    assert period.limit_id == "grok_build"
    assert period.limit_name == "Weekly usage period"
    assert period.primary is None
    assert period.credits is None
    assert period.period_start_at == 1_784_073_600
    assert period.period_end_at == 1_784_678_400


@pytest.mark.asyncio
async def test_get_usage_maps_reported_credit_and_on_demand_percentages(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.agent.providers.grok.oauth.GrokOAuth.load", _oauth)
    _FakeClient.payload = {
        "config": {
            "currentPeriod": {
                "type": "USAGE_PERIOD_TYPE_MONTHLY",
                "start": "2026-07-01T00:00:00+00:00",
                "end": "2026-08-01T00:00:00+00:00",
            },
            "creditUsagePercent": 12.5,
            "onDemandCap": {"val": 100},
            "onDemandUsed": {"val": 25},
            "prepaidBalance": {"val": 30},
        }
    }
    monkeypatch.setattr(usage.httpx, "AsyncClient", _FakeClient)

    result = await usage.get_usage()

    assert [limit.limit_id for limit in result.limits] == [
        "grok_build",
        "grok_on_demand",
        "grok_prepaid",
    ]
    included = result.limits[0]
    assert included.primary is not None
    assert included.primary.used_percent == 12.5
    assert included.primary.window_minutes == 44_640
    assert included.primary.resets_at == 1_785_542_400
    on_demand = result.limits[1]
    assert on_demand.primary is not None
    assert on_demand.primary.used_percent == 25.0
    prepaid = result.limits[2]
    assert prepaid.credits is not None
    assert prepaid.credits.has_credits is True
    assert prepaid.credits.unlimited is False
    assert prepaid.credits.balance == "30 credits"


@pytest.mark.asyncio
async def test_get_usage_requires_saved_oauth_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.agent.providers.grok.oauth.GrokOAuth.load", lambda: None)

    with pytest.raises(usage.GrokUsageCredentialsError):
        await usage.get_usage()


@pytest.mark.asyncio
async def test_get_usage_rejects_invalid_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.agent.providers.grok.oauth.GrokOAuth.load", _oauth)
    _FakeClient.payload = ["not", "an", "object"]
    monkeypatch.setattr(usage.httpx, "AsyncClient", _FakeClient)

    with pytest.raises(usage.GrokUsageUnavailableError):
        await usage.get_usage()
