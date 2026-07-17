"""Tests for app/agent/providers/copilot/usage.py."""

from __future__ import annotations

import pytest
from pydantic import SecretStr

from app.agent.providers.copilot import usage
from app.agent.providers.copilot.oauth import CopilotOAuth


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

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def get(self, _url, *, headers):  # type: ignore[no-untyped-def]
        assert headers["Authorization"] == "token github-token"
        return _FakeResponse(self.payload)


@pytest.mark.asyncio
async def test_get_usage_returns_only_premium_interactions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.agent.providers.copilot.oauth.CopilotOAuth.load",
        lambda: CopilotOAuth(github_token=SecretStr("github-token")),
    )
    _FakeClient.payload = {
        "copilot_plan": "individual",
        "quota_reset_date_utc": "2026-06-01T00:00:00.000Z",
        "quota_snapshots": {
            "chat": {
                "quota_id": "chat",
                "percent_remaining": 1,
                "remaining": 1,
                "entitlement": 100,
            },
            "completions": {
                "quota_id": "completions",
                "percent_remaining": 2,
                "remaining": 2,
                "entitlement": 100,
            },
            "premium_interactions": {
                "quota_id": "premium_interactions",
                "percent_remaining": 25,
                "remaining": 75,
                "entitlement": 100,
                "quota_reset_at": "2026-06-02T00:00:00.000Z",
            },
        },
    }
    monkeypatch.setattr(usage.httpx, "Client", _FakeClient)

    result = await usage.get_usage()

    assert [limit.limit_id for limit in result.limits] == ["premium_interactions"]
    premium = result.limits[0]
    assert premium.limit_name == "Premium requests"
    assert premium.primary is not None
    assert premium.primary.used_percent == 75.0
    assert premium.primary.resets_at == 1780358400
    assert premium.credits is not None
    assert premium.credits.balance == "75/100"


@pytest.mark.asyncio
async def test_get_usage_missing_premium_snapshot_returns_empty_limits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.agent.providers.copilot.oauth.CopilotOAuth.load",
        lambda: CopilotOAuth(github_token=SecretStr("github-token")),
    )
    _FakeClient.payload = {
        "copilot_plan": "individual",
        "quota_snapshots": {
            "chat": {"quota_id": "chat", "percent_remaining": 10},
        },
    }
    monkeypatch.setattr(usage.httpx, "Client", _FakeClient)

    result = await usage.get_usage()

    assert result.provider == "copilot"
    assert result.limits == []


@pytest.mark.asyncio
async def test_get_usage_requires_saved_oauth_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.agent.providers.copilot.oauth.CopilotOAuth.load",
        lambda: None,
    )

    with pytest.raises(usage.CopilotUsageCredentialsError):
        await usage.get_usage()


@pytest.mark.asyncio
async def test_get_usage_rejects_invalid_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.agent.providers.copilot.oauth.CopilotOAuth.load",
        lambda: CopilotOAuth(github_token=SecretStr("github-token")),
    )
    _FakeClient.payload = ["not", "an", "object"]
    monkeypatch.setattr(usage.httpx, "Client", _FakeClient)

    with pytest.raises(usage.CopilotUsageUnavailableError):
        await usage.get_usage()


@pytest.mark.asyncio
async def test_get_usage_does_not_block_the_event_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A slow usage endpoint must not starve other coroutines.

    The GitHub request runs over a sync httpx.Client with a 5s timeout;
    if it executes directly on the event loop, every other coroutine
    (SSE streams, request handlers) freezes for the duration. Simulate a
    slow network with a sync sleep and assert a concurrent heartbeat
    keeps ticking while ``get_usage`` is in flight.
    """
    import asyncio
    import time

    monkeypatch.setattr(
        "app.agent.providers.copilot.oauth.CopilotOAuth.load",
        lambda: CopilotOAuth(github_token=SecretStr("github-token")),
    )

    class _SlowClient(_FakeClient):
        def get(self, _url, *, headers):  # type: ignore[no-untyped-def]
            time.sleep(0.3)  # sync sleep — models a slow network read
            return super().get(_url, headers=headers)

    _SlowClient.payload = {"copilot_plan": "individual", "quota_snapshots": {}}
    monkeypatch.setattr(usage.httpx, "Client", _SlowClient)

    ticks = 0

    async def _heartbeat() -> None:
        nonlocal ticks
        while True:
            await asyncio.sleep(0.01)
            ticks += 1

    hb = asyncio.create_task(_heartbeat())
    try:
        await usage.get_usage()
    finally:
        hb.cancel()

    # With a responsive loop the heartbeat fires ~30 times during the
    # 0.3s call; a blocked loop yields 0-1 ticks. Threshold of 5 keeps
    # the assertion robust on slow CI machines.
    assert ticks >= 5, f"event loop starved during get_usage (ticks={ticks})"


def test_model_allowed_for_plan_uses_restricted_to_aliases() -> None:
    assert usage.model_allowed_for_plan(["edu"], "student") is True
    assert usage.model_allowed_for_plan(["business"], "student") is False
    assert usage.model_allowed_for_plan([], "student") is True
    assert usage.model_allowed_for_plan(["pro"], None) is None


def test_model_allowed_for_plan_does_not_promote_individual_to_pro() -> None:
    assert usage.model_allowed_for_plan(["pro"], "individual") is False
    assert usage.model_allowed_for_plan(["individual"], "individual") is True
    assert usage.model_allowed_for_plan(["max"], "individual") is False
    assert usage.model_allowed_for_plan(["business"], "team") is True


def test_model_plan_type_reads_live_usage_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        usage,
        "_usage_payload",
        lambda: {"copilot_plan": "Individual Trial"},
    )

    assert usage.model_plan_type() == "individual_trial"
