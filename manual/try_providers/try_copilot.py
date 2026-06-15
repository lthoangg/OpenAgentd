"""Test Copilot provider through the retry/error-classification layer.

Requires GitHub OAuth token (run: uv run openagentd auth copilot).

Usage:
  uv run python -m manual.try_providers.try_copilot
  uv run python -m manual.try_providers.try_copilot --model gpt-5.4-mini --level low
  uv run python -m manual.try_providers.try_copilot --model gpt-5-mini --level medium
  uv run python -m manual.try_providers.try_copilot --model gpt-5.5 --simple
  uv run python -m manual.try_providers.try_copilot --no-stream
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
from app.agent.providers.copilot import CopilotProvider
from app.agent.schemas.chat import HumanMessage
from manual.try_providers._common import (
    REASONING_PROMPT,
    SIMPLE_PROMPT,
    run_chat,
)


async def run_stream_with_retry(provider: CopilotProvider, prompt: str, *, label: str):
    print(f"\n{'=' * 60}")
    print(f"[{label}] model={provider.model} endpoint={provider._endpoint_type}")
    print(f"{'=' * 60}")

    content_len = 0
    try:
        async for chunk in stream_with_retry(
            primary_provider=provider,
            primary_label=f"copilot:{provider.model}",
            fallback_provider=None,
            fallback_label="fallback",
            agent_name="manual-copilot",
            ctx=None,
            state=None,
            hooks=None,
            messages=[HumanMessage(content=prompt)],
            tools=None,
        ):
            for choice in chunk.choices:
                delta = choice.delta
                if delta.content:
                    if content_len == 0:
                        print("\n  [content]  ", end="", flush=True)
                    print(delta.content, end="", flush=True)
                    content_len += len(delta.content)
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


async def main() -> int:
    p = argparse.ArgumentParser(description="Test Copilot provider")
    p.add_argument("--model", default="gpt-5-mini", help="Model (default: gpt-5-mini)")
    p.add_argument("--level", default=None, help="Thinking level: low|medium|high")
    p.add_argument("--no-stream", action="store_true", help="Non-streaming chat()")
    p.add_argument(
        "--simple", action="store_true", help="Use simple prompt instead of reasoning"
    )
    args = p.parse_args()

    model_kwargs: dict = {}
    if args.level:
        model_kwargs["thinking_level"] = args.level

    provider = CopilotProvider(
        model=args.model,
        model_kwargs=model_kwargs,
    )

    prompt = SIMPLE_PROMPT if args.simple else REASONING_PROMPT
    label = provider._endpoint_type
    if args.level:
        label += f" thinking={args.level}"

    if args.no_stream:
        await run_chat(provider, prompt, label=label)
        code = 0
    else:
        code = await run_stream_with_retry(provider, prompt, label=label)

    print(f"\n{'=' * 60}")
    print("done")
    return code


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
