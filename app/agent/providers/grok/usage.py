"""Grok Build billing usage support."""

from __future__ import annotations

import asyncio
from datetime import datetime
from typing import cast

import httpx2
from loguru import logger

from app.agent.providers.grok.oauth import (
    GROK_BUILD_API_BASE,
    GrokOAuth,
    session_headers,
)
from app.api.schemas.settings import (
    ProviderUsageCredits,
    ProviderUsageLimit,
    ProviderUsageResponse,
    ProviderUsageWindow,
)


class GrokUsageCredentialsError(ValueError):
    """Raised when Grok Build OAuth credentials are missing."""


class GrokUsageUnavailableError(RuntimeError):
    """Raised when Grok Build billing cannot be reached or parsed."""


def _parse_timestamp(value: object) -> int | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())
    except ValueError:
        return None


def _number(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value)


def _wrapped_number(values: dict[str, object], key: str) -> float | None:
    wrapped = values.get(key)
    if not isinstance(wrapped, dict):
        return None
    return _number(cast("dict[str, object]", wrapped).get("val"))


def _period(values: dict[str, object]) -> tuple[str, int | None, int | None]:
    current = values.get("currentPeriod")
    period = cast("dict[str, object]", current) if isinstance(current, dict) else {}
    period_type = period.get("type")
    names = {
        "USAGE_PERIOD_TYPE_WEEKLY": "Weekly usage period",
        "USAGE_PERIOD_TYPE_MONTHLY": "Monthly usage period",
    }
    name = names.get(period_type, "Usage period")
    start_at = _parse_timestamp(period.get("start") or values.get("billingPeriodStart"))
    end_at = _parse_timestamp(period.get("end") or values.get("billingPeriodEnd"))
    return name, start_at, end_at


def _window(
    used_percent: float,
    *,
    start_at: int | None,
    end_at: int | None,
) -> ProviderUsageWindow:
    window_minutes = None
    if start_at is not None and end_at is not None and end_at > start_at:
        window_minutes = (end_at - start_at) // 60
    return ProviderUsageWindow(
        used_percent=max(0.0, min(100.0, used_percent)),
        window_minutes=window_minutes,
        resets_at=end_at,
    )


def _limits(values: dict[str, object]) -> list[ProviderUsageLimit]:
    period_name, start_at, end_at = _period(values)
    reported_percent = _number(values.get("creditUsagePercent"))
    has_period = start_at is not None or end_at is not None
    limits: list[ProviderUsageLimit] = []
    if has_period or reported_percent is not None:
        limits.append(
            ProviderUsageLimit(
                limit_id="grok_build",
                limit_name=period_name,
                primary=(
                    _window(
                        reported_percent,
                        start_at=start_at,
                        end_at=end_at,
                    )
                    if reported_percent is not None
                    else None
                ),
                period_start_at=start_at,
                period_end_at=end_at,
            )
        )

    on_demand_cap = _wrapped_number(values, "onDemandCap")
    on_demand_used = _wrapped_number(values, "onDemandUsed")
    if on_demand_cap is not None and on_demand_cap > 0 and on_demand_used is not None:
        limits.append(
            ProviderUsageLimit(
                limit_id="grok_on_demand",
                limit_name="On-demand cap",
                primary=_window(
                    100.0 * on_demand_used / on_demand_cap,
                    start_at=start_at,
                    end_at=end_at,
                ),
                period_start_at=start_at,
                period_end_at=end_at,
            )
        )

    prepaid_balance = _wrapped_number(values, "prepaidBalance")
    if prepaid_balance is not None and prepaid_balance > 0:
        limits.append(
            ProviderUsageLimit(
                limit_id="grok_prepaid",
                limit_name="Prepaid credits",
                credits=ProviderUsageCredits(
                    has_credits=True,
                    unlimited=False,
                    balance=f"{prepaid_balance:g} credits",
                ),
            )
        )
    return limits


async def get_usage() -> ProviderUsageResponse:
    oauth = GrokOAuth.load()
    if oauth is None:
        raise GrokUsageCredentialsError("Grok Build OAuth credentials not found.")
    try:
        if oauth.is_expired():
            oauth = await asyncio.to_thread(oauth.refresh)
        async with httpx2.AsyncClient(timeout=5.0) as client:
            response = await client.get(
                f"{GROK_BUILD_API_BASE}/billing?format=credits",
                headers=session_headers(oauth.access_token.get_secret_value()),
            )
            response.raise_for_status()
        payload = response.json()
    except GrokUsageCredentialsError:
        raise
    except Exception as exc:
        logger.info("provider_usage_unavailable provider=grok error={}", exc)
        raise GrokUsageUnavailableError("Provider usage unavailable.") from exc

    if not isinstance(payload, dict):
        raise GrokUsageUnavailableError("Provider usage response was invalid.")
    config = cast("dict[str, object]", payload).get("config")
    if not isinstance(config, dict):
        raise GrokUsageUnavailableError("Provider usage response was invalid.")
    return ProviderUsageResponse(
        provider="grok",
        limits=_limits(cast("dict[str, object]", config)),
    )
