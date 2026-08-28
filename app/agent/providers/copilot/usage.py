"""GitHub Copilot usage snapshot support."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from datetime import datetime
from typing import Any, cast

import httpx2
from loguru import logger

from app.api.schemas.settings import (
    ProviderUsageCredits,
    ProviderUsageLimit,
    ProviderUsageResponse,
    ProviderUsageWindow,
)
from app.core.version import VERSION


_PREMIUM_INTERACTIONS_QUOTA = "premium_interactions"
_RESTRICTED_TO_PLAN_ALIASES: dict[str, set[str]] = {
    "free": {"free", "student", "education", "edu"},
    "student": {"student", "education", "edu", "free"},
    "education": {"education", "edu", "student", "free"},
    "edu": {"edu", "education", "student", "free"},
    "business": {"business", "enterprise", "team"},
    "enterprise": {"enterprise", "business", "team"},
    "team": {"team", "business", "enterprise"},
}


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

    token: str | None = None
    oauth = CopilotOAuth.load()
    if oauth is not None:
        token = oauth.github_token.get_secret_value()
    else:
        import os

        token = (
            os.getenv("COPILOT_GITHUB_TOKEN")
            or os.getenv("GH_TOKEN")
            or os.getenv("GITHUB_TOKEN")
            or os.getenv("GITHUB_COPILOT_TOKEN")
        )
    if not token:
        raise CopilotUsageCredentialsError("Copilot OAuth credentials not found.")
    return {
        "Authorization": f"token {token}",
        "Accept": "application/json",
        # Keep this aligned with the runtime Copilot provider headers.
        # Compare against opencode's GitHub Copilot plugin when updating.
        "User-Agent": f"opencode/{VERSION}",
    }


def _normalize_plan(plan: object) -> str | None:
    if not isinstance(plan, str):
        return None
    normalized = plan.strip().lower().replace("-", "_").replace(" ", "_")
    return normalized or None


def _allowed_restricted_to_values(plan_type: str | None) -> set[str]:
    if plan_type is None:
        return set()
    normalized = _normalize_plan(plan_type)
    if normalized is None:
        return set()
    return {normalized, *_RESTRICTED_TO_PLAN_ALIASES.get(normalized, set())}


def model_allowed_for_plan(
    restricted_to: list[str] | tuple[str, ...] | set[str],
    plan_type: str | None,
) -> bool | None:
    """Return whether ``restricted_to`` permits ``plan_type``.

    ``None`` means the current plan is unknown, so the caller should not hard-gate.
    Empty ``restricted_to`` means unrestricted.
    """
    allowed = {value for value in (_normalize_plan(v) for v in restricted_to) if value}
    if not allowed:
        return True
    plan_values = _allowed_restricted_to_values(plan_type)
    if not plan_values:
        return None
    return bool(allowed & plan_values)


def model_plan_type() -> str | None:
    """Return the live Copilot plan type when usage data is reachable."""
    try:
        payload = _usage_payload()
    except (CopilotUsageCredentialsError, CopilotUsageUnavailableError):
        return None
    return _extract_plan_type(payload)


def _extract_plan_type(payload: Mapping[str, Any]) -> str | None:
    plan = payload.get("copilot_plan") or payload.get("access_type_sku")
    return _normalize_plan(plan)


def _usage_payload() -> Mapping[str, Any]:
    try:
        with httpx2.Client(timeout=5.0) as client:
            response = client.get(
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
    return cast("dict[str, Any]", payload)


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
    # ``_usage_payload`` blocks on a sync httpx2 call (up to 5s timeout).
    # Run it off-loop — this coroutine is awaited from request handlers on
    # the single-worker event loop, where a blocking call stalls every
    # in-flight SSE stream and request.
    payload = await asyncio.to_thread(_usage_payload)

    values = cast("dict[str, object]", payload)
    plan_type = _extract_plan_type(values)
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
