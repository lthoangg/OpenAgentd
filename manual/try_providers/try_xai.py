"""Test xAI (Grok) directly — streaming, chat, and tools.

Uses XAI_API_KEY from .env via settings.

Usage:
  uv run python -m manual.try_providers.try_xai
  uv run python -m manual.try_providers.try_xai --model grok-4 --level low
  uv run python -m manual.try_providers.try_xai --tools
  uv run python -m manual.try_providers.try_xai --no-stream --simple
"""

from __future__ import annotations

import argparse
import asyncio

from app.agent.providers.xai import XAIProvider
from app.core.config import settings
from manual.try_providers._common import (
    REASONING_PROMPT,
    SIMPLE_PROMPT,
    run_chat,
    run_stream,
)
from manual.try_providers._tools_common import (
    PROMPT_WITH_TOOLS,
    SIMPLE_TEST_TOOLS,
    run_stream_with_tools,
)


async def main() -> None:
    parser = argparse.ArgumentParser(description="Test xAI (Grok) provider")
    parser.add_argument("--model", default="grok-4", help="Model (default: grok-4)")
    parser.add_argument("--level", default=None, help="Thinking level: low|medium|high")
    parser.add_argument("--tools", action="store_true", help="Test with simple tools")
    parser.add_argument("--no-stream", action="store_true", help="Non-streaming chat()")
    parser.add_argument(
        "--simple", action="store_true", help="Use simple prompt instead of reasoning"
    )
    args = parser.parse_args()

    api_key = settings.XAI_API_KEY.get_secret_value() if settings.XAI_API_KEY else None
    if not api_key:
        print("ERROR: XAI_API_KEY not set in .env")
        return

    model_kwargs = {"thinking_level": args.level} if args.level else None
    provider = XAIProvider(
        api_key=api_key,
        model=args.model,
        model_kwargs=model_kwargs,
    )
    label = "xai" + (f" thinking={args.level}" if args.level else "")

    if args.tools:
        await run_stream_with_tools(
            provider, PROMPT_WITH_TOOLS, SIMPLE_TEST_TOOLS, label=f"{label} tools"
        )
    elif args.no_stream:
        await run_chat(
            provider,
            SIMPLE_PROMPT if args.simple else REASONING_PROMPT,
            label=label,
        )
    else:
        await run_stream(
            provider,
            SIMPLE_PROMPT if args.simple else REASONING_PROMPT,
            label=label,
        )


if __name__ == "__main__":
    asyncio.run(main())
