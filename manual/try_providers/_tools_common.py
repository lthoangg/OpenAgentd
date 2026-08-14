"""Shared tool-testing helpers for provider test scripts.

Provides simple test tools, real agent tool loading, and a generic
run_stream_with_tools() that works across all providers.
"""

from __future__ import annotations

import json
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.agent.providers.base import LLMProviderBase

from app.agent.schemas.chat import HumanMessage

# Minimal hand-crafted tools for quick testing
SIMPLE_TEST_TOOLS = [
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


def get_real_tool_defs() -> list[dict]:
    """Load actual tool definitions from the registry (same schemas the agent sends).

    produced $ref in their schemas — useful for regression testing.
    """
    from app.agent.tools import (
        glob_files,
        grep_files,
        load_skill,
        patch_file,
        read_file,
        shell_tool,
        web_fetch,
        web_search,
    )

    tools = [
        read_file,
        load_skill,
        web_search,
        web_fetch,
        glob_files,
        grep_files,
        shell_tool,
        patch_file,
    ]

    return [t.definition for t in tools]


async def run_stream_with_tools(
    provider: "LLMProviderBase",
    prompt: str,
    tools: list[dict],
    *,
    label: str = "",
):
    """Stream with tools enabled — prints tool calls and content."""
    print(f"\n{'=' * 60}")
    print(f"[{label}] model={provider.model} tools={len(tools)}")
    print(f"{'=' * 60}")

    # Print tool names and flag any that still have $ref
    for t in tools:
        name = t["function"]["name"]
        params = json.dumps(t["function"].get("parameters", {}))
        has_ref = "$ref" in params
        marker = " *** HAS $ref ***" if has_ref else ""
        print(f"  tool: {name}{marker}")

    messages = [HumanMessage(content=prompt)]
    content_len = 0
    reasoning_len = 0
    tool_calls_count = 0
    usage = None
    chunk_count = 0
    start = time.monotonic()

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
                        fn_args = tc.function.arguments if tc.function else None
                        print(
                            f"\n  [tool_call] index={tc.index} id={tc.id} "
                            f"fn={fn_name} args={fn_args}"
                        )
            if chunk.usage:
                usage = chunk.usage
    except Exception as e:
        print(f"\n  [ERROR] {type(e).__name__}: {e}")
        import traceback

        traceback.print_exc()
        return

    elapsed = time.monotonic() - start
    print("\n\n  --- results ---")
    print(f"  chunks received: {chunk_count}")
    print(f"  reasoning chars: {reasoning_len}")
    print(f"  content chars:   {content_len}")
    print(f"  tool call deltas:{tool_calls_count}")
    print(f"  elapsed:         {elapsed:.1f}s")
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
    else:
        print("  usage: (none)")
