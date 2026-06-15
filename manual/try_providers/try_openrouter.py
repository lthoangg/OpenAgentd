"""Test OpenRouter provider through the retry/error-classification layer.

Uses OPENROUTER_API_KEY from .env via settings.

Usage:
  uv run python -m manual.try_providers.try_openrouter
  uv run python -m manual.try_providers.try_openrouter --model openai/gpt-4o-mini
  uv run python -m manual.try_providers.try_openrouter --model anthropic/claude-3.5-haiku
"""

from __future__ import annotations

import argparse
import asyncio

from app.agent.agent_loop.retry import stream_with_retry
from app.agent.errors import (
    ProviderAuthenticationError,
    ProviderConnectionError,
    ProviderRateLimitError,
    ProviderRequestError,
)
from app.agent.providers.factory import build_provider
from app.agent.schemas.chat import HumanMessage
from manual.try_providers._common import SIMPLE_PROMPT


async def main() -> int:
    parser = argparse.ArgumentParser(description="Test OpenRouter provider")
    parser.add_argument(
        "--model",
        default="openai/gpt-4o-mini",
        help="OpenRouter model id without provider prefix (default: openai/gpt-4o-mini)",
    )
    parser.add_argument(
        "--prompt",
        default=SIMPLE_PROMPT,
        help="Prompt to send (default: simple haiku prompt)",
    )
    args = parser.parse_args()

    model_id = f"openrouter:{args.model}"
    provider = build_provider(model_id)

    print(f"\n{'=' * 60}")
    print(f"[openrouter] model={provider.model} via stream_with_retry")
    print(f"{'=' * 60}")

    content_len = 0
    try:
        async for chunk in stream_with_retry(
            primary_provider=provider,
            primary_label=model_id,
            fallback_provider=None,
            fallback_label="fallback",
            agent_name="manual-openrouter",
            ctx=None,
            state=None,
            hooks=None,
            messages=[HumanMessage(content=args.prompt)],
            tools=None,
        ):
            for choice in chunk.choices:
                if choice.delta.content:
                    if content_len == 0:
                        print("\n  [content]  ", end="", flush=True)
                    print(choice.delta.content, end="", flush=True)
                    content_len += len(choice.delta.content)
    except (
        ProviderAuthenticationError,
        ProviderRequestError,
        ProviderRateLimitError,
        ProviderConnectionError,
    ) as exc:
        print(f"\n  [EXPECTED PROVIDER ERROR] {type(exc).__name__}: {exc}")
        return 2
    except Exception as exc:
        print(f"\n  [UNEXPECTED ERROR] {type(exc).__name__}: {exc}")
        return 1

    print("\n\n  --- results ---")
    print(f"  content chars: {content_len}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
