"""Quote of the day — fetched from API Ninjas, cached for the entire day.

The quote is persisted to ``{CACHE_DIR}/quoteoftheday.json``::

    {"date": "YYYY-MM-DD", "quote": "...", "author": "..."}

If the cached date matches today, the file is reused without hitting the API.
The cache directory is safe to delete — a missing file just triggers a refetch.
"""

from __future__ import annotations

import datetime
import json
from pathlib import Path

import httpx2
from loguru import logger
from pydantic import BaseModel

from app.core.config import settings

# ── Schema ────────────────────────────────────────────────────────────────────


class Quote(BaseModel):
    quote: str
    author: str


# ── Defaults ──────────────────────────────────────────────────────────────────

_FALLBACK = Quote(
    quote="First, solve the problem. Then, write the code.",
    author="John Johnson",
)

_CACHE_FILENAME = "quoteoftheday.json"
_API_URL = "https://api.api-ninjas.com/v2/quoteoftheday"
_TIMEOUT = 10  # seconds


# ── Helpers ───────────────────────────────────────────────────────────────────


def _cache_path() -> Path:
    return Path(settings.OPENAGENTD_CACHE_DIR) / _CACHE_FILENAME


def _read_cache() -> Quote | None:
    """Return the cached quote if it was saved today, else ``None``."""
    path = _cache_path()
    if not path.exists():
        return None
    try:
        text = path.read_text(encoding="utf-8").strip()
        if not text:
            return None
        data = json.loads(text)
        if (
            data.get("date")
            != datetime.datetime.now(datetime.timezone.utc).date().isoformat()
        ):
            return None
        return Quote(quote=data["quote"], author=data["author"])
    except Exception:
        logger.opt(exception=True).debug("quote_cache_read_failed")
        return None


def _write_cache(q: Quote) -> None:
    """Persist today's quote to disk."""
    path = _cache_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "date": datetime.datetime.now(datetime.timezone.utc).date().isoformat(),
            "quote": q.quote,
            "author": q.author,
        }
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    except Exception:
        logger.opt(exception=True).warning("quote_cache_write_failed")


# ── Public API ────────────────────────────────────────────────────────────────


async def get_quote_of_the_day() -> Quote:
    """Return today's quote, using cache when available."""
    # 1. Try cache first
    cached = _read_cache()
    if cached is not None:
        logger.debug("quote_of_the_day cache_hit")
        return cached

    # 2. Need API key
    api_key = settings.NINJA_API_KEY
    if api_key is None:
        logger.debug("quote_of_the_day no_api_key, using fallback")
        return _FALLBACK

    # 3. Fetch from API Ninjas
    try:
        async with httpx2.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.get(
                _API_URL,
                headers={"X-Api-Key": api_key.get_secret_value()},
            )
            resp.raise_for_status()
            data = resp.json()

            # v2 returns [{"quote": "...", "author": "..."}]
            if isinstance(data, list):
                data = data[0] if data else {}
            quote_text = data.get("quote", "")
            author = data.get("author", "Unknown")

            if not quote_text:
                logger.warning("quote_of_the_day empty_response, using fallback")
                return _FALLBACK

            q = Quote(quote=quote_text, author=author)
            _write_cache(q)
            logger.info("quote_of_the_day fetched author={}", author)
            return q

    except Exception:
        logger.opt(exception=True).warning(
            "quote_of_the_day fetch_failed, using fallback"
        )
        return _FALLBACK
