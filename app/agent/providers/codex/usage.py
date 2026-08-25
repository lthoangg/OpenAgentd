"""OpenAI Codex usage snapshot support."""

from __future__ import annotations

from typing import cast

import httpx2
from loguru import logger

from app.api.schemas.settings import (
    ProviderUsageCredits,
    ProviderUsageLimit,
    ProviderUsageResponse,
    ProviderUsageSpend,
    ProviderUsageWindow,
)


class CodexUsageCredentialsError(ValueError):
    """Raised when Codex OAuth credentials are missing."""


class CodexUsageUnavailableError(RuntimeError):
    """Raised when the upstream usage endpoint cannot be reached or parsed."""


def _usage_window(data: object) -> ProviderUsageWindow | None:
    if not isinstance(data, dict):
        return None
    values = cast("dict[str, object]", data)
    used = values.get("used_percent")
    if not isinstance(used, int | float):
        return None
    seconds = values.get("limit_window_seconds")
    minutes = (seconds + 59) // 60 if isinstance(seconds, int) and seconds > 0 else None
    reset_at = values.get("reset_at")
    return ProviderUsageWindow(
        used_percent=float(used),
        window_minutes=minutes,
        resets_at=reset_at if isinstance(reset_at, int) else None,
    )


def _usage_credits(data: object) -> ProviderUsageCredits | None:
    if not isinstance(data, dict):
        return None
    values = cast("dict[str, object]", data)
    has_credits = values.get("has_credits")
    unlimited = values.get("unlimited")
    if not isinstance(has_credits, bool) or not isinstance(unlimited, bool):
        return None
    balance = values.get("balance")
    return ProviderUsageCredits(
        has_credits=has_credits,
        unlimited=unlimited,
        balance=balance if isinstance(balance, str) else None,
    )


def _as_float(value: object) -> float | None:
    """Coerce an upstream number to float — amounts arrive as strings."""
    # bool is an int subclass; it must not become 1.0.
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def _usage_spend(data: object) -> ProviderUsageSpend | None:
    if not isinstance(data, dict):
        return None
    values = cast("dict[str, object]", data)
    reached = values.get("reached")
    if not isinstance(reached, bool):
        return None
    raw_limit = values.get("individual_limit")
    if not isinstance(raw_limit, dict):
        # No cap configured — keep the flag.
        return ProviderUsageSpend(reached=reached)
    limit_values = cast("dict[str, object]", raw_limit)
    source = limit_values.get("source")
    resets_at = limit_values.get("reset_at")
    return ProviderUsageSpend(
        reached=reached,
        source=source if isinstance(source, str) else None,
        limit=_as_float(limit_values.get("limit")),
        used=_as_float(limit_values.get("used")),
        remaining=_as_float(limit_values.get("remaining")),
        used_percent=_as_float(limit_values.get("used_percent")),
        resets_at=resets_at if isinstance(resets_at, int) else None,
    )


def _usage_limit(
    data: object,
    *,
    limit_id: str | None,
    limit_name: str | None = None,
    plan_type: str | None = None,
    rate_limit_reached_type: str | None = None,
    spend: ProviderUsageSpend | None = None,
    reset_credits_available: int | None = None,
) -> ProviderUsageLimit | None:
    if not isinstance(data, dict):
        return None
    values = cast("dict[str, object]", data)
    raw_rate_limit = values.get("rate_limit")
    rate_limit_values = (
        cast("dict[str, object]", raw_rate_limit)
        if isinstance(raw_rate_limit, dict)
        else values
    )
    primary = _usage_window(rate_limit_values.get("primary_window"))
    secondary = _usage_window(rate_limit_values.get("secondary_window"))
    credits = _usage_credits(values.get("credits"))
    if (
        primary is None
        and secondary is None
        and credits is None
        and spend is None
        and reset_credits_available is None
    ):
        return None
    return ProviderUsageLimit(
        limit_id=limit_id,
        limit_name=limit_name,
        primary=primary,
        secondary=secondary,
        credits=credits,
        spend=spend,
        plan_type=plan_type,
        rate_limit_reached_type=rate_limit_reached_type,
        reset_credits_available=reset_credits_available,
    )


def _usage_headers() -> dict[str, str]:
    from app.agent.providers.codex.oauth import CodexOAuth

    oauth = CodexOAuth.load()
    if oauth is None:
        raise CodexUsageCredentialsError("Codex OAuth credentials not found.")
    if oauth.is_expired():
        oauth = oauth.refresh()
    headers = {
        "Authorization": f"Bearer {oauth.access_token.get_secret_value()}",
        "Accept": "application/json",
        "User-Agent": "openagentd/1.0.0",
        "originator": "openagentd",
    }
    if oauth.account_id:
        headers["ChatGPT-Account-Id"] = oauth.account_id
    return headers


async def get_usage() -> ProviderUsageResponse:
    try:
        async with httpx2.AsyncClient(timeout=5.0) as client:
            response = await client.get(
                "https://chatgpt.com/backend-api/wham/usage",
                headers=_usage_headers(),
            )
            response.raise_for_status()
        payload = response.json()
    except CodexUsageCredentialsError:
        raise
    except Exception as exc:
        logger.info("provider_usage_unavailable provider=codex error={}", exc)
        raise CodexUsageUnavailableError("Provider usage unavailable.") from exc

    if not isinstance(payload, dict):
        raise CodexUsageUnavailableError("Provider usage response was invalid.")

    values = cast("dict[str, object]", payload)
    plan_type = values.get("plan_type")
    reached = values.get("rate_limit_reached_type")
    reached_type = None
    if isinstance(reached, dict):
        reached_values = cast("dict[str, object]", reached)
        type_value = reached_values.get("type")
        reached_type = type_value if isinstance(type_value, str) else None
    elif isinstance(reached, str):
        reached_type = reached

    raw_reset_credits = values.get("rate_limit_reset_credits")
    reset_credits_available = None
    if isinstance(raw_reset_credits, dict):
        count = cast("dict[str, object]", raw_reset_credits).get("available_count")
        if isinstance(count, int) and not isinstance(count, bool):
            reset_credits_available = count

    common_plan = plan_type if isinstance(plan_type, str) else None
    limits: list[ProviderUsageLimit] = []
    # Spend control and reset credits are account-wide, not per-metered-feature.
    primary = _usage_limit(
        values,
        limit_id="codex",
        plan_type=common_plan,
        rate_limit_reached_type=reached_type,
        spend=_usage_spend(values.get("spend_control")),
        reset_credits_available=reset_credits_available,
    )
    if primary is not None:
        limits.append(primary)
    additional = values.get("additional_rate_limits")
    if isinstance(additional, list):
        for item in additional:
            if not isinstance(item, dict):
                continue
            item_values = cast("dict[str, object]", item)
            metered = item_values.get("metered_feature")
            name = item_values.get("limit_name")
            limit = _usage_limit(
                item_values,
                limit_id=metered if isinstance(metered, str) else None,
                limit_name=name if isinstance(name, str) else None,
                plan_type=common_plan,
            )
            if limit is not None:
                limits.append(limit)
    return ProviderUsageResponse(provider="codex", limits=limits)
