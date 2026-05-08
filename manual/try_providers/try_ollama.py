"""Test Ollama provider directly — streaming, chat, and tools.

Talks to the local Ollama daemon (default ``http://localhost:11434/v1``).
The daemon ignores auth, so no API key is required; ``OLLAMA_API_KEY``
defaults to the documented ``"ollama"`` placeholder. Set
``OLLAMA_BASE_URL`` to point at a daemon on another host.

Cloud models work through the same daemon by appending ``-cloud`` to the
model name (e.g. ``--model kimi-k2.6-cloud``); run ``ollama signin``
first.

Usage:
  uv run python -m manual.try_providers.try_ollama
  uv run python -m manual.try_providers.try_ollama --model qwen2.5-coder:7b
  uv run python -m manual.try_providers.try_ollama --model kimi-k2.6-cloud
  uv run python -m manual.try_providers.try_ollama --tools
  uv run python -m manual.try_providers.try_ollama --real-tools
  uv run python -m manual.try_providers.try_ollama --no-stream
  uv run python -m manual.try_providers.try_ollama --simple
"""

from __future__ import annotations

import argparse
import asyncio

from app.agent.providers.ollama import OllamaProvider
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
    get_real_tool_defs,
    run_stream_with_tools,
)


async def main():
    p = argparse.ArgumentParser(description="Test Ollama provider")
    p.add_argument(
        "--model",
        default="llama3.2",
        help="Model (default: llama3.2; append '-cloud' for cloud models)",
    )
    p.add_argument("--tools", action="store_true", help="Test with simple tools")
    p.add_argument(
        "--real-tools",
        action="store_true",
        help="Test with actual agent tool schemas (includes memory tools)",
    )
    p.add_argument("--no-stream", action="store_true", help="Non-streaming chat()")
    p.add_argument(
        "--simple", action="store_true", help="Use simple prompt instead of reasoning"
    )
    args = p.parse_args()

    api_key = settings.OLLAMA_API_KEY.get_secret_value()
    base_url = settings.OLLAMA_BASE_URL

    provider = OllamaProvider(api_key=api_key, model=args.model, base_url=base_url)

    prompt = SIMPLE_PROMPT if args.simple else REASONING_PROMPT
    label = f"ollama model={args.model} base_url={base_url}"

    if args.tools or args.real_tools:
        tools = get_real_tool_defs() if args.real_tools else SIMPLE_TEST_TOOLS
        label += " real-tools" if args.real_tools else " simple-tools"
        await run_stream_with_tools(provider, PROMPT_WITH_TOOLS, tools, label=label)
    elif args.no_stream:
        await run_chat(provider, prompt, label=label)
    else:
        await run_stream(provider, prompt, label=label)

    print(f"\n{'=' * 60}")
    print("done")


if __name__ == "__main__":
    asyncio.run(main())
