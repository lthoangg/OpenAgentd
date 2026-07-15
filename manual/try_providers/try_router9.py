"""Test a local 9Router instance directly — streaming, chat, and tools.

Uses ROUTER9_API_KEY and ROUTER9_BASE_URL from .env via settings.

Usage:
  uv run python -m manual.try_providers.try_router9 --model provider/model
  uv run python -m manual.try_providers.try_router9 --model provider/model --tools
  uv run python -m manual.try_providers.try_router9 --model provider/model --no-stream
"""

from __future__ import annotations

import argparse
import asyncio

from app.agent.providers.router9 import Router9Provider
from app.core.config import settings
from manual.try_providers._common import SIMPLE_PROMPT, run_chat, run_stream
from manual.try_providers._tools_common import (
    PROMPT_WITH_TOOLS,
    SIMPLE_TEST_TOOLS,
    run_stream_with_tools,
)


async def main() -> None:
    parser = argparse.ArgumentParser(description="Test 9Router provider")
    parser.add_argument(
        "--model",
        required=True,
        help="Model ID exposed by 9Router (for example provider/model)",
    )
    parser.add_argument("--tools", action="store_true", help="Test with simple tools")
    parser.add_argument("--no-stream", action="store_true", help="Non-streaming chat()")
    args = parser.parse_args()

    provider = Router9Provider(
        api_key=settings.ROUTER9_API_KEY,
        model=args.model,
        base_url=settings.ROUTER9_BASE_URL,
    )
    label = f"router9 base_url={settings.ROUTER9_BASE_URL}"

    if args.tools:
        await run_stream_with_tools(
            provider, PROMPT_WITH_TOOLS, SIMPLE_TEST_TOOLS, label=f"{label} tools"
        )
    elif args.no_stream:
        await run_chat(provider, SIMPLE_PROMPT, label=label)
    else:
        await run_stream(provider, SIMPLE_PROMPT, label=label)


if __name__ == "__main__":
    asyncio.run(main())
