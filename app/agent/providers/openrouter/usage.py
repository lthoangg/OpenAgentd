"""OpenRouter API key usage and credits snapshot support."""

from __future__ import annotations

import httpx2
from loguru import logger

from app.api.schemas.settings import (
    ProviderUsageCredits,
    ProviderUsageLimit,
    ProviderUsageResponse,
    ProviderUsageSpend,
)


class OpenRouterUsageCredentialsError(ValueError):
    """Raised when OpenRouter API key credentials are missing or invalid."""


class OpenRouterUsageUnavailableError(RuntimeError):
    """Raised when OpenRouter usage endpoints cannot be reached or parsed."""


def _resolve_api_key(api_key: str | None = None) -> str:
    if api_key and api_key.strip():
        return api_key.strip()
    from app.agent.providers.plugin_registry import ProviderCredentialStore

    key = ProviderCredentialStore("openrouter").get("OPENROUTER_API_KEY")
    if not key:
        raise OpenRouterUsageCredentialsError("OpenRouter API key not configured.")
    return key


def _format_balance(amount: float) -> str:
    if 0 < amount < 0.01:
        return f"${amount:.4f}"
    return f"${amount:.2f}"


async def get_usage(api_key: str | None = None) -> ProviderUsageResponse:
    key = _resolve_api_key(api_key)
    headers = {
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
    }

    credits_data: dict[str, object] | None = None
    auth_key_data: dict[str, object] | None = None

    async with httpx2.AsyncClient(timeout=5.0) as client:
        # Fetch account credits (only available with management/provisioning keys;
        # regular inference keys return 403 which we ignore gracefully).
        try:
            credits_resp = await client.get(
                "https://openrouter.ai/api/v1/credits", headers=headers
            )
            if credits_resp.status_code == 200:
                body = credits_resp.json()
                if isinstance(body, dict) and isinstance(body.get("data"), dict):
                    credits_data = body["data"]
            else:
                logger.debug(
                    "openrouter_credits_skipped status={}", credits_resp.status_code
                )
        except httpx2.HTTPError as exc:
            logger.debug("openrouter_credits_fetch_failed error={}", exc)
        except Exception as exc:
            logger.debug("openrouter_credits_parse_failed error={}", exc)

        # Fetch key details (works with ALL API keys: regular and management)
        try:
            key_resp = await client.get(
                "https://openrouter.ai/api/v1/auth/key", headers=headers
            )
            if key_resp.status_code in (401, 403):
                raise OpenRouterUsageCredentialsError("Invalid OpenRouter API key.")
            if key_resp.status_code == 200:
                body = key_resp.json()
                if isinstance(body, dict) and isinstance(body.get("data"), dict):
                    auth_key_data = body["data"]
            elif key_resp.status_code >= 500:
                raise OpenRouterUsageUnavailableError(
                    f"OpenRouter key API returned HTTP {key_resp.status_code}"
                )
        except httpx2.HTTPError as exc:
            logger.info("openrouter_auth_key_fetch_failed error={}", exc)
            raise OpenRouterUsageUnavailableError(str(exc)) from exc
        except OpenRouterUsageCredentialsError:
            raise
        except OpenRouterUsageUnavailableError:
            raise
        except Exception as exc:
            logger.info("openrouter_auth_key_parse_failed error={}", exc)
            raise OpenRouterUsageUnavailableError(str(exc)) from exc

    if credits_data is None and auth_key_data is None:
        raise OpenRouterUsageUnavailableError("Unable to reach OpenRouter usage API.")

    total_credits: float | None = None
    total_usage: float | None = None
    remaining_credits: float | None = None
    balance_str: str | None = None
    has_credits = True
    unlimited = False

    if credits_data is not None:
        tc = credits_data.get("total_credits")
        tu = credits_data.get("total_usage")
        if isinstance(tc, (int, float)):
            total_credits = float(tc)
        if isinstance(tu, (int, float)):
            total_usage = float(tu)
        if total_credits is not None:
            usage_amt = total_usage or 0.0
            remaining_credits = max(0.0, total_credits - usage_amt)
            balance_str = _format_balance(remaining_credits)
            has_credits = remaining_credits > 0 or total_credits > usage_amt

    spend: ProviderUsageSpend | None = None
    label: str | None = None
    is_free_tier = False

    if auth_key_data is not None:
        raw_label = auth_key_data.get("label")
        if isinstance(raw_label, str) and raw_label.strip():
            label = raw_label.strip()
        is_free_tier = bool(auth_key_data.get("is_free_tier", False))

        limit_val = auth_key_data.get("limit")
        usage_val = auth_key_data.get("usage")
        limit_remaining_val = auth_key_data.get("limit_remaining")
        key_limit = float(limit_val) if isinstance(limit_val, (int, float)) else None
        key_usage = float(usage_val) if isinstance(usage_val, (int, float)) else 0.0
        limit_remaining = (
            float(limit_remaining_val)
            if isinstance(limit_remaining_val, (int, float))
            else None
        )

        if key_limit is not None and key_limit > 0:
            remaining_spend = (
                limit_remaining
                if limit_remaining is not None
                else max(0.0, key_limit - key_usage)
            )
            used_pct = (key_usage / key_limit) * 100.0
            reached = key_usage >= key_limit or (
                limit_remaining is not None and limit_remaining <= 0
            )
            spend = ProviderUsageSpend(
                reached=reached,
                limit=key_limit,
                used=key_usage,
                remaining=remaining_spend,
                used_percent=used_pct,
            )
        elif key_limit is not None and key_limit == 0:
            spend = ProviderUsageSpend(
                reached=True,
                limit=0.0,
                used=key_usage,
                remaining=0.0,
                used_percent=100.0,
            )

        if balance_str is None:
            if limit_remaining is not None:
                balance_str = _format_balance(limit_remaining)
                has_credits = limit_remaining > 0
                unlimited = False
            elif key_limit is None:
                has_credits = True
                unlimited = True
                if key_usage > 0:
                    balance_str = f"{_format_balance(key_usage)} used"
            else:
                has_credits = True
                unlimited = False

    credits_obj = ProviderUsageCredits(
        has_credits=has_credits,
        unlimited=unlimited,
        balance=balance_str,
    )

    plan_type = "Free tier" if is_free_tier else (label or "Pay-as-you-go")
    limit_name = f"OpenRouter ({label})" if label else "OpenRouter Credits"

    limit = ProviderUsageLimit(
        limit_id="openrouter",
        limit_name=limit_name,
        credits=credits_obj,
        spend=spend,
        plan_type=plan_type,
    )

    return ProviderUsageResponse(
        provider="openrouter",
        limits=[limit],
    )
