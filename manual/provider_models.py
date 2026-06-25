"""Smoke-test provider model discovery.

Usage:
  uv run python -m manual.provider_models
  uv run python -m manual.provider_models openai googlegenai openrouter nvidia copilot codex
"""

from __future__ import annotations

import argparse
import asyncio

from app.agent.providers.catalog import find
from app.agent.providers.model_discovery import discover_provider_models


DEFAULT_PROVIDERS = [
    "openai",
    "googlegenai",
    "openrouter",
    "nvidia",
    "copilot",
    "codex",
]


async def _check(provider_id: str, limit: int) -> None:
    entry = find(provider_id)
    if entry is None:
        print(f"{provider_id}: unknown provider")
        return

    discovered = await discover_provider_models(entry)
    models = discovered
    source = "provider" if models else "none"

    print(f"\n{provider_id}: {len(models)} models ({source})")
    for model in models[:limit]:
        print(f"  - {model}")
    if len(models) > limit:
        print(f"  ... {len(models) - limit} more")


async def _main() -> None:
    parser = argparse.ArgumentParser(description="List provider models")
    parser.add_argument("providers", nargs="*", default=DEFAULT_PROVIDERS)
    parser.add_argument("--limit", type=int, default=20)
    args = parser.parse_args()

    for provider_id in args.providers:
        await _check(provider_id, args.limit)


def main() -> None:
    asyncio.run(_main())


if __name__ == "__main__":
    main()
