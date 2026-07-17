"""Test Grok Build directly through saved OAuth credentials.

Requires prior login:
  uv run openagentd auth grok

Development checkouts read ``.openagentd/dev/cache/grok_oauth.json``.

Usage:
  uv run python -m manual.try_providers.try_grok
  uv run python -m manual.try_providers.try_grok --list-models
  uv run python -m manual.try_providers.try_grok --level low
  uv run python -m manual.try_providers.try_grok --tools
  uv run python -m manual.try_providers.try_grok --real-tools
  uv run python -m manual.try_providers.try_grok --no-stream --simple
"""

from __future__ import annotations

import argparse
import asyncio

from app.agent.providers.catalog import find
from app.agent.providers.grok import GrokBuildProvider
from app.agent.providers.grok.usage import get_usage
from app.agent.providers.model_discovery import discover_provider_models
from manual.try_providers._common import (
    REASONING_PROMPT,
    SIMPLE_PROMPT,
    run_chat,
    run_stream,
)
from manual.try_providers._tools_common import (
    PROMPT_WITH_TOOLS,
    SIMPLE_TEST_TOOLS,
    get_real_tool_defs,
    run_stream_with_tools,
)


async def main() -> int:
    parser = argparse.ArgumentParser(description="Test Grok Build OAuth provider")
    parser.add_argument("--model", default="grok-4.5", help="Model (default: grok-4.5)")
    parser.add_argument("--level", default=None, help="Thinking level: low|medium|high")
    parser.add_argument("--tools", action="store_true", help="Test with simple tools")
    parser.add_argument(
        "--real-tools",
        action="store_true",
        help="Test with actual agent tool schemas",
    )
    parser.add_argument("--no-stream", action="store_true", help="Non-streaming chat()")
    parser.add_argument(
        "--simple", action="store_true", help="Use simple prompt instead of reasoning"
    )
    parser.add_argument(
        "--list-models",
        action="store_true",
        help="List models available to the authenticated account and exit",
    )
    parser.add_argument(
        "--usage",
        action="store_true",
        help="Show the current Grok Build billing period and measurable usage",
    )
    args = parser.parse_args()

    model_kwargs = {"thinking_level": args.level} if args.level else None
    try:
        provider = GrokBuildProvider(
            model=args.model,
            model_kwargs=model_kwargs,
        )
    except Exception as exc:
        print(f"ERROR: {type(exc).__name__}: {exc}")
        print("Run: uv run openagentd auth grok")
        return 1

    try:
        if args.list_models:
            entry = find("grok")
            assert entry is not None
            models = await discover_provider_models(entry)
            print(f"Grok Build models: {len(models)}")
            for model in models:
                print(f"  {model}")
            return 0 if models else 1

        if args.usage:
            usage = await get_usage()
            print(usage.model_dump_json(indent=2, exclude_none=True))
            return 0

        prompt = SIMPLE_PROMPT if args.simple else REASONING_PROMPT
        label = "grok-build"
        if args.level:
            label += f" thinking={args.level}"

        if args.tools or args.real_tools:
            tools = get_real_tool_defs() if args.real_tools else SIMPLE_TEST_TOOLS
            label += " real-tools" if args.real_tools else " simple-tools"
            await run_stream_with_tools(
                provider,
                PROMPT_WITH_TOOLS,
                tools,
                label=label,
            )
        elif args.no_stream:
            await run_chat(provider, prompt, label=label)
        else:
            await run_stream(provider, prompt, label=label)

        print(f"\n{'=' * 60}")
        print("done")
        return 0
    finally:
        await provider.aclose()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
