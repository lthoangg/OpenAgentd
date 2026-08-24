"""DeepSeek API key balance and usage snapshot support."""

from __future__ import annotations

import httpx2
from loguru import logger

from app.api.schemas.settings import (
    ProviderUsageCredits,
    ProviderUsageLimit,
    ProviderUsageResponse,
)


class DeepSeekUsageCredentialsError(ValueError):
    """Raised when DeepSeek API key credentials are missing or invalid."""


class DeepSeekUsageUnavailableError(RuntimeError):
    """Raised when DeepSeek balance endpoint cannot be reached or parsed."""


def _resolve_api_key(api_key: str | None = None) -> str:
    if api_key and api_key.strip():
        return api_key.strip()
    from app.agent.providers.plugin_registry import ProviderCredentialStore

    key = ProviderCredentialStore("deepseek").get("DEEPSEEK_API_KEY")
    if not key:
        raise DeepSeekUsageCredentialsError("DeepSeek API key not configured.")
    return key


def _format_currency(amount_str: str | float | int, currency: str) -> str:
    try:
        val = float(amount_str)
    except (ValueError, TypeError):
        return f"{amount_str} {currency}"
    if currency.upper() == "USD":
        return f"${val:.2f}"
    if currency.upper() == "CNY":
        return f"¥{val:.2f}"
    return f"{val:.2f} {currency}"


async def get_usage(api_key: str | None = None) -> ProviderUsageResponse:
    key = _resolve_api_key(api_key)
    headers = {
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
    }

    try:
        async with httpx2.AsyncClient(timeout=5.0) as client:
            response = await client.get(
                "https://api.deepseek.com/user/balance", headers=headers
            )
            if response.status_code in (401, 403):
                raise DeepSeekUsageCredentialsError("Invalid DeepSeek API key.")
            if response.status_code != 200:
                raise DeepSeekUsageUnavailableError(
                    f"DeepSeek balance API returned HTTP {response.status_code}"
                )
            data = response.json()
    except (DeepSeekUsageCredentialsError, DeepSeekUsageUnavailableError):
        raise
    except httpx2.HTTPError as exc:
        logger.info("deepseek_balance_unavailable error={}", exc)
        raise DeepSeekUsageUnavailableError(str(exc)) from exc
    except Exception as exc:
        logger.info("deepseek_balance_parse_failed error={}", exc)
        raise DeepSeekUsageUnavailableError(str(exc)) from exc

    if not isinstance(data, dict):
        raise DeepSeekUsageUnavailableError("Malformed DeepSeek balance response")

    is_available = bool(data.get("is_available", False))
    raw_balance_infos = data.get("balance_infos")
    balance_infos = raw_balance_infos if isinstance(raw_balance_infos, list) else []

    formatted_balances: list[str] = []
    has_positive = False

    for item in balance_infos:
        if not isinstance(item, dict):
            continue
        currency = str(item.get("currency", "USD"))
        total = item.get("total_balance", "0.00")
        try:
            num = float(total)
        except (ValueError, TypeError):
            num = 0.0
        if num > 0:
            has_positive = True
            formatted_balances.append(_format_currency(total, currency))

    if formatted_balances:
        balance_str = " / ".join(formatted_balances)
    elif balance_infos:
        first = balance_infos[0]
        curr = str(first.get("currency", "USD")) if isinstance(first, dict) else "USD"
        tot = first.get("total_balance", "0.00") if isinstance(first, dict) else "0.00"
        balance_str = _format_currency(tot, curr)
    else:
        balance_str = "$0.00"

    credits_obj = ProviderUsageCredits(
        has_credits=is_available or has_positive,
        unlimited=False,
        balance=balance_str,
    )

    limit = ProviderUsageLimit(
        limit_id="deepseek",
        limit_name="DeepSeek Balance",
        credits=credits_obj,
        plan_type="Pay-as-you-go",
    )

    return ProviderUsageResponse(
        provider="deepseek",
        limits=[limit],
    )
