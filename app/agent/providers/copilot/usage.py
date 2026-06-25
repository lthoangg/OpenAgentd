"""GitHub Copilot usage snapshot support."""

from __future__ import annotations

from datetime import datetime
from typing import cast

import httpx
from loguru import logger

from app.api.schemas.settings import (
    ProviderUsageCredits,
    ProviderUsageLimit,
    ProviderUsageResponse,
    ProviderUsageWindow,
)
from app.core.version import VERSION


_PREMIUM_INTERACTIONS_QUOTA = "premium_interactions"


class CopilotUsageCredentialsError(ValueError):
    """Raised when Copilot OAuth credentials are missing."""


class CopilotUsageUnavailableError(RuntimeError):
    """Raised when the upstream usage endpoint cannot be reached or parsed."""


def _parse_timestamp(value: object) -> int | None:
    if isinstance(value, int) and value > 0:
        return value
    if not isinstance(value, str) or not value:
        return None
    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())
    except ValueError:
        return None


def _usage_headers() -> dict[str, str]:
    from app.agent.providers.copilot.oauth import CopilotOAuth

    oauth = CopilotOAuth.load()
    if oauth is None:
        raise CopilotUsageCredentialsError("Copilot OAuth credentials not found.")
    return {
        "Authorization": f"token {oauth.github_token.get_secret_value()}",
        "Accept": "application/json",
        # Keep this aligned with the runtime Copilot provider headers.
        # Compare against opencode's GitHub Copilot plugin when updating.
        "User-Agent": f"opencode/{VERSION}",
    }


def _usage_limit(
    name: str,
    data: object,
    *,
    plan_type: str | None,
    fallback_reset_at: int | None,
) -> ProviderUsageLimit | None:
    if not isinstance(data, dict):
        return None
    values = cast("dict[str, object]", data)
    percent_remaining = values.get("percent_remaining")
    primary = None
    if isinstance(percent_remaining, int | float):
        reset_at = _parse_timestamp(values.get("quota_reset_at")) or fallback_reset_at
        primary = ProviderUsageWindow(
            used_percent=max(0.0, min(100.0, 100.0 - float(percent_remaining))),
            resets_at=reset_at,
        )
    unlimited = values.get("unlimited") is True
    remaining = values.get("remaining")
    entitlement = values.get("entitlement")
    balance = None
    if (
        isinstance(remaining, int | float)
        and isinstance(entitlement, int | float)
        and entitlement > 0
    ):
        balance = f"{int(remaining)}/{int(entitlement)}"
    credits = ProviderUsageCredits(
        has_credits=unlimited
        or bool(isinstance(remaining, int | float) and remaining > 0),
        unlimited=unlimited,
        balance=balance,
    )
    quota_id = values.get("quota_id")
    return ProviderUsageLimit(
        limit_id=quota_id if isinstance(quota_id, str) else name,
        limit_name="Premium requests",
        primary=primary,
        credits=credits,
        plan_type=plan_type,
    )


async def get_usage() -> ProviderUsageResponse:
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(
                "https://api.github.com/copilot_internal/user",
                headers=_usage_headers(),
            )
            response.raise_for_status()
        payload = response.json()
    except CopilotUsageCredentialsError:
        raise
    except Exception as exc:
        logger.info("provider_usage_unavailable provider=copilot error={}", exc)
        raise CopilotUsageUnavailableError("Provider usage unavailable.") from exc

    if not isinstance(payload, dict):
        raise CopilotUsageUnavailableError("Provider usage response was invalid.")

    values = cast("dict[str, object]", payload)
    plan = values.get("copilot_plan") or values.get("access_type_sku")
    plan_type = plan if isinstance(plan, str) else None
    reset_at = _parse_timestamp(values.get("quota_reset_date_utc"))
    snapshots = values.get("quota_snapshots")
    limits: list[ProviderUsageLimit] = []
    if isinstance(snapshots, dict):
        quota_snapshots = cast("dict[str, object]", snapshots)
        item = quota_snapshots.get(_PREMIUM_INTERACTIONS_QUOTA)
        if item is not None:
            limit = _usage_limit(
                _PREMIUM_INTERACTIONS_QUOTA,
                item,
                plan_type=plan_type,
                fallback_reset_at=reset_at,
            )
            if limit is not None:
                limits.append(limit)
    return ProviderUsageResponse(provider="copilot", limits=limits)
