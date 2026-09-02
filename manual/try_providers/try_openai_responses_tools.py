"""Test OpenAI Responses API with tools — manually verify tool handling.

Uses OPENAI_API_KEY from .env via settings.

Usage:
  uv run python -m manual.try_providers.try_openai_responses_tools
  uv run python -m manual.try_providers.try_openai_responses_tools --model gpt-5.4 --level high
  uv run python -m manual.try_providers.try_openai_responses_tools --no-stream
"""

import argparse
import asyncio

from app.core.config import settings
from app.agent.providers.openai import OpenAIProvider
from app.agent.schemas.chat import HumanMessage


# Simple test tools
TEST_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_current_time",
            "description": "Get the current time",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "add_numbers",
            "description": "Add two numbers",
            "parameters": {
                "type": "object",
                "properties": {
                    "a": {"type": "number", "description": "First number"},
                    "b": {"type": "number", "description": "Second number"},
                },
                "required": ["a", "b"],
            },
        },
    },
]

PROMPT_WITH_TOOLS = (
    "What is 5 + 3? Use the add_numbers tool to calculate it. "
    "Then tell me what time it is using get_current_time."
)


async def run_stream_with_tools(provider, prompt, tools):
    """Stream with tools enabled."""
    print(f"\n{'=' * 60}")
    print(f"[streaming] model={provider.model} endpoint=responses")
    print(f"{'=' * 60}")

    messages = [HumanMessage(content=prompt)]
    reasoning_len = 0
    content_len = 0
    tool_calls_count = 0
    usage = None
    chunk_count = 0

    try:
        async for chunk in provider.stream(messages, tools=tools):
            chunk_count += 1
            for choice in chunk.choices:
                delta = choice.delta
                if delta.reasoning_content:
                    if reasoning_len == 0:
                        print("\n  [thinking] ", end="", flush=True)
                    print(delta.reasoning_content, end="", flush=True)
                    reasoning_len += len(delta.reasoning_content)
                if delta.content:
                    if content_len == 0:
                        if reasoning_len > 0:
                            print(f"\n  [thinking done] {reasoning_len} chars")
                        print("\n  [content]  ", end="", flush=True)
                    print(delta.content, end="", flush=True)
                    content_len += len(delta.content)
                if delta.tool_calls:
                    for tc in delta.tool_calls:
                        tool_calls_count += 1
                        fn_name = tc.function.name if tc.function else None
                        print(
                            f"\n  [tool_delta] index={tc.index} id={tc.id} fn_name={fn_name}"
                        )
            if chunk.usage:
                usage = chunk.usage
    except Exception as e:
        print(f"\n  [ERROR] {type(e).__name__}: {e}")
        import traceback

        traceback.print_exc()
        return

    print("\n\n  --- results ---")
    print(f"  chunks received: {chunk_count}")
    print(f"  reasoning chars: {reasoning_len}")
    print(f"  content chars:   {content_len}")
    print(f"  tool calls:      {tool_calls_count}")
    if usage:
        parts = [
            f"in={usage.prompt_tokens}",
            f"out={usage.completion_tokens}",
            f"total={usage.total_tokens}",
        ]
        if usage.cached_tokens:
            parts.append(f"cached={usage.cached_tokens}")
        if usage.thoughts_tokens:
            parts.append(f"thoughts={usage.thoughts_tokens}")
        print(f"  usage: {' '.join(parts)}")


async def run_chat_with_tools(provider, prompt, tools):
    """Non-streaming chat with tools."""
    print(f"\n{'=' * 60}")
    print(f"[chat] model={provider.model} endpoint=responses (non-streaming)")
    print(f"{'=' * 60}")

    messages = [HumanMessage(content=prompt)]

    try:
        result = await provider.chat(messages, tools=tools)
    except Exception as e:
        print(f"\n  [ERROR] {type(e).__name__}: {e}")
        import traceback

        traceback.print_exc()
        return

    reasoning = result.reasoning_content or ""
    content = result.content or ""
    tool_calls = result.tool_calls or []

    if reasoning:
        preview = reasoning[:200] + ("..." if len(reasoning) > 200 else "")
        print(f"\n  [thinking] {preview}")
    preview = content[:300] + ("..." if len(content) > 300 else "")
    print(f"\n  [content]  {preview}")
    if tool_calls:
        print(f"\n  [tool_calls] {len(tool_calls)} calls:")
        for tc in tool_calls:
            print(f"    - {tc.function.name} (id={tc.id})")

    print("\n  --- results ---")
    print(f"  reasoning chars: {len(reasoning)}")
    print(f"  content chars:   {len(content)}")
    print(f"  tool calls:      {len(tool_calls)}")


async def main():
    p = argparse.ArgumentParser(description="Test OpenAI Responses API with tools")
    p.add_argument("--model", default="gpt-5.4", help="Model (default: gpt-5.4)")
    p.add_argument("--level", default="high", help="Thinking level: low|medium|high")
    p.add_argument("--no-stream", action="store_true", help="Non-streaming chat()")
    args = p.parse_args()

    api_key = (
        settings.OPENAI_API_KEY.get_secret_value() if settings.OPENAI_API_KEY else None
    )
    if not api_key:
        print("ERROR: OPENAI_API_KEY not set in .env")
        return

    model_kwargs = {
        "thinking_level": args.level,
        "responses_api": True,  # Explicitly request Responses API
    }

    provider = OpenAIProvider(
        api_key=api_key,
        model=args.model,
        model_kwargs=model_kwargs,
    )

    if args.no_stream:
        await run_chat_with_tools(provider, PROMPT_WITH_TOOLS, TEST_TOOLS)
    else:
        await run_stream_with_tools(provider, PROMPT_WITH_TOOLS, TEST_TOOLS)

    print(f"\n{'=' * 60}")
    print("done")


if __name__ == "__main__":
    asyncio.run(main())
