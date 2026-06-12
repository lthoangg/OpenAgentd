"""Test AWS Bedrock provider directly — streaming, chat, and tools.

Auth: profile (AWS_BEDROCK_PROFILE from .env or --profile) or default boto3 chain.
Region: AWS_BEDROCK_REGION from .env or --region, falls back to us-east-1.

Usage:
  uv run python -m manual.try_providers.try_bedrock
  uv run python -m manual.try_providers.try_bedrock --profile fyc
  uv run python -m manual.try_providers.try_bedrock --model global.anthropic.claude-opus-4-7
  uv run python -m manual.try_providers.try_bedrock --model amazon.nova-pro-v1:0
  uv run python -m manual.try_providers.try_bedrock --tools
  uv run python -m manual.try_providers.try_bedrock --real-tools
  uv run python -m manual.try_providers.try_bedrock --list-models
  uv run python -m manual.try_providers.try_bedrock --no-stream
  uv run python -m manual.try_providers.try_bedrock --simple
"""

from __future__ import annotations

import argparse
import asyncio

from app.agent.providers.bedrock import BedrockProvider
from app.agent.providers.model_discovery import _bedrock_models
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
    p = argparse.ArgumentParser(description="Test AWS Bedrock provider")
    p.add_argument(
        "--model",
        default="global.anthropic.claude-sonnet-4-6",
        help="Bedrock model ID (default: global.anthropic.claude-sonnet-4-6)",
    )
    p.add_argument(
        "--profile",
        default=None,
        help="AWS profile name (overrides AWS_BEDROCK_PROFILE from .env)",
    )
    p.add_argument(
        "--region",
        default=None,
        help="AWS region (overrides AWS_BEDROCK_REGION from .env)",
    )
    p.add_argument("--tools", action="store_true", help="Test with simple tools")
    p.add_argument(
        "--real-tools",
        action="store_true",
        help="Test with actual agent tool schemas (includes memory tools)",
    )
    p.add_argument(
        "--list-models",
        action="store_true",
        help="List Bedrock foundation models and inference profiles, then exit",
    )
    p.add_argument("--no-stream", action="store_true", help="Non-streaming chat()")
    p.add_argument(
        "--simple", action="store_true", help="Use simple prompt instead of reasoning"
    )
    args = p.parse_args()

    profile = args.profile or settings.AWS_BEDROCK_PROFILE
    region = args.region or settings.AWS_BEDROCK_REGION

    if args.list_models:
        overrides = {}
        if profile:
            overrides["AWS_BEDROCK_PROFILE"] = profile
        if region:
            overrides["AWS_BEDROCK_REGION"] = region
        for model in await _bedrock_models(overrides):
            print(model)
        return

    provider = BedrockProvider(
        model=args.model,
        profile_name=profile,
        region_name=region,
    )

    prompt = SIMPLE_PROMPT if args.simple else REASONING_PROMPT
    label = f"bedrock model={args.model}"
    if profile:
        label += f" profile={profile}"

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
