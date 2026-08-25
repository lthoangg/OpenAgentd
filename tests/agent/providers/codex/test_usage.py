"""Tests for app/agent/providers/codex/usage.py."""

from __future__ import annotations

import time

import pytest
from pydantic import SecretStr

from app.agent.providers.codex import usage
from app.agent.providers.codex.oauth import CodexOAuth

# Real payload from a business account over its spend cap: no rate_limit
# windows at all, and the figures arrive as strings.
_BUSINESS_SPEND_CAPPED_PAYLOAD: dict[str, object] = {
    "plan_type": "business",
    "rate_limit": None,
    "code_review_rate_limit": None,
    "additional_rate_limits": None,
    "credits": {
        "has_credits": True,
        "unlimited": False,
        "overage_limit_reached": False,
        "balance": None,
        "approx_local_messages": None,
        "approx_cloud_messages": None,
    },
    "spend_control": {
        "reached": True,
        "individual_limit": {
            "source": "workspace_spend_controls",
            "limit": "700",
            "used": "1811.965924501419",
            "remaining": "0",
            "used_percent": 259,
            "reset_after_seconds": 2147506,
            "reset_at": 1788220800,
        },
    },
    "rate_limit_reached_type": {
        "type": "workspace_member_usage_limit_reached",
        "details": None,
    },
    "promo": None,
    "rate_limit_reset_credits": {
        "available_count": 0,
        "applicable_available_count": 0,
    },
}


class _FakeResponse:
    def __init__(self, payload: object):
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> object:
        return self._payload


def _fake_client_for(payload: object) -> type:
    class _FakeClient:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, _url, *, headers):  # type: ignore[no-untyped-def]
            return _FakeResponse(payload)

    return _FakeClient


@pytest.fixture
def _codex_oauth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.agent.providers.codex.oauth.CodexOAuth.load",
        lambda: CodexOAuth(
            access_token=SecretStr("chatgpt-token"),
            refresh_token=SecretStr("refresh-token"),
            expires_at=time.time() + 3600,
            account_id="account-123",
        ),
    )


@pytest.mark.usefixtures("_codex_oauth")
async def test_get_usage_exposes_workspace_spend_control_figures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The spend cap is the only real signal on a capped business account."""
    monkeypatch.setattr(
        usage.httpx2,
        "AsyncClient",
        _fake_client_for(_BUSINESS_SPEND_CAPPED_PAYLOAD),
    )

    result = await usage.get_usage()

    assert len(result.limits) == 1
    spend = result.limits[0].spend
    assert spend is not None
    assert spend.reached is True
    assert spend.source == "workspace_spend_controls"
    # Upstream sends these as strings — they must arrive as numbers.
    assert spend.limit == 700.0
    assert spend.used == pytest.approx(1811.965924501419)
    assert spend.remaining == 0.0
    assert spend.used_percent == 259.0
    assert spend.resets_at == 1788220800


@pytest.mark.usefixtures("_codex_oauth")
async def test_get_usage_keeps_capped_account_credits_and_reached_type(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``rate_limit: null`` must not collapse the limit or lose context."""
    monkeypatch.setattr(
        usage.httpx2,
        "AsyncClient",
        _fake_client_for(_BUSINESS_SPEND_CAPPED_PAYLOAD),
    )

    result = await usage.get_usage()

    limit = result.limits[0]
    assert limit.limit_id == "codex"
    assert limit.plan_type == "business"
    assert limit.primary is None
    assert limit.secondary is None
    assert limit.rate_limit_reached_type == "workspace_member_usage_limit_reached"
    assert limit.credits is not None
    assert limit.credits.has_credits is True
    assert limit.credits.balance is None


@pytest.mark.usefixtures("_codex_oauth")
async def test_get_usage_reports_spend_control_below_the_cap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unbreached cap reports reached=False and a real remaining figure."""
    payload = {
        "plan_type": "business",
        "rate_limit": None,
        "credits": {"has_credits": True, "unlimited": False, "balance": None},
        "spend_control": {
            "reached": False,
            "individual_limit": {
                "source": "workspace_spend_controls",
                "limit": "700",
                "used": "250.5",
                "remaining": "449.5",
                "used_percent": 36,
                "reset_at": 1788220800,
            },
        },
    }
    monkeypatch.setattr(usage.httpx2, "AsyncClient", _fake_client_for(payload))

    result = await usage.get_usage()

    spend = result.limits[0].spend
    assert spend is not None
    assert spend.reached is False
    assert spend.remaining == 449.5
    assert spend.used_percent == 36.0


@pytest.mark.usefixtures("_codex_oauth")
async def test_get_usage_survives_a_spend_control_without_individual_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Free accounts send ``individual_limit: null`` — keep the flag only."""
    payload = {
        "plan_type": "free",
        "rate_limit": {
            "primary_window": {
                "used_percent": 52,
                "limit_window_seconds": 2592000,
                "reset_at": 1787411524,
            },
            "secondary_window": None,
        },
        "credits": {"has_credits": False, "unlimited": False, "balance": None},
        "spend_control": {"reached": False, "individual_limit": None},
    }
    monkeypatch.setattr(usage.httpx2, "AsyncClient", _fake_client_for(payload))

    result = await usage.get_usage()

    limit = result.limits[0]
    assert limit.primary is not None
    assert limit.primary.used_percent == 52.0
    assert limit.spend is not None
    assert limit.spend.reached is False
    assert limit.spend.limit is None
    assert limit.spend.remaining is None


@pytest.mark.usefixtures("_codex_oauth")
async def test_get_usage_ignores_unparsable_spend_numerics(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = {
        "plan_type": "business",
        "credits": {"has_credits": True, "unlimited": False, "balance": None},
        "spend_control": {
            "reached": True,
            "individual_limit": {"limit": "n/a", "used": None, "remaining": True},
        },
    }
    monkeypatch.setattr(usage.httpx2, "AsyncClient", _fake_client_for(payload))

    result = await usage.get_usage()

    spend = result.limits[0].spend
    assert spend is not None
    assert spend.limit is None
    assert spend.used is None
    # ``True`` is an int subclass — it must not become 1.0.
    assert spend.remaining is None


@pytest.mark.usefixtures("_codex_oauth")
async def test_get_usage_attaches_spend_control_only_to_the_primary_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Spend control is account-wide, not per-metered-feature."""
    payload = {
        "plan_type": "business",
        "rate_limit": {
            "primary_window": {
                "used_percent": 10,
                "limit_window_seconds": 3600,
                "reset_at": 1788220800,
            }
        },
        "spend_control": {
            "reached": True,
            "individual_limit": {"limit": "700", "used": "700", "remaining": "0"},
        },
        "additional_rate_limits": [
            {
                "limit_name": "Codex Spark",
                "metered_feature": "codex-spark",
                "rate_limit": {
                    "primary_window": {
                        "used_percent": 88,
                        "limit_window_seconds": 1800,
                        "reset_at": 1788220800,
                    }
                },
            }
        ],
    }
    monkeypatch.setattr(usage.httpx2, "AsyncClient", _fake_client_for(payload))

    result = await usage.get_usage()

    assert [limit.limit_id for limit in result.limits] == ["codex", "codex-spark"]
    assert result.limits[0].spend is not None
    assert result.limits[1].spend is None


@pytest.mark.usefixtures("_codex_oauth")
async def test_get_usage_parses_reset_credits_available(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = {
        "plan_type": "plus",
        "rate_limit": {
            "primary_window": {
                "used_percent": 97,
                "limit_window_seconds": 604800,
                "reset_at": 1788150972,
            }
        },
        "rate_limit_reset_credits": {
            "available_count": 1,
            "applicable_available_count": 0,
        },
    }
    monkeypatch.setattr(usage.httpx2, "AsyncClient", _fake_client_for(payload))

    result = await usage.get_usage()

    assert len(result.limits) == 1
    assert result.limits[0].reset_credits_available == 1


@pytest.mark.usefixtures("_codex_oauth")
async def test_consume_reset_redeems_credit_and_returns_fresh_usage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    posted_data: list[dict[str, object]] = []

    credits_payload = {
        "credits": [
            {
                "id": "RateLimitResetCredit_123",
                "status": "available",
                "title": "Full reset",
            }
        ],
        "available_count": 1,
    }
    consume_payload = {"code": "reset", "windows_reset": 1}
    fresh_usage_payload = {
        "plan_type": "plus",
        "rate_limit": {
            "primary_window": {
                "used_percent": 0,
                "limit_window_seconds": 604800,
                "reset_at": 1788150972,
            }
        },
        "rate_limit_reset_credits": {
            "available_count": 0,
        },
    }

    class _MultiClient:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, url, *, headers):  # type: ignore[no-untyped-def]
            if "rate-limit-reset-credits" in url:
                return _FakeResponse(credits_payload)
            return _FakeResponse(fresh_usage_payload)

        async def post(self, url, *, headers, json):  # type: ignore[no-untyped-def]
            posted_data.append({"url": url, "json": json})
            return _FakeResponse(consume_payload)

    monkeypatch.setattr(usage.httpx2, "AsyncClient", _MultiClient)

    result = await usage.consume_reset()

    assert len(posted_data) == 1
    assert posted_data[0]["json"]["credit_id"] == "RateLimitResetCredit_123"
    assert len(result.limits) == 1
    assert result.limits[0].primary.used_percent == 0


@pytest.mark.usefixtures("_codex_oauth")
async def test_consume_reset_raises_when_no_credits_available(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    credits_payload = {
        "credits": [],
        "available_count": 0,
    }

    class _NoCreditsClient:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, _url, *, headers):  # type: ignore[no-untyped-def]
            return _FakeResponse(credits_payload)

    monkeypatch.setattr(usage.httpx2, "AsyncClient", _NoCreditsClient)

    with pytest.raises(
        usage.CodexUsageUnavailableError, match="No available rate limit reset credits"
    ):
        await usage.consume_reset()
