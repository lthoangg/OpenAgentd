"""Shared helpers for tool call state matching in the stream store.

Matches ``tool_start`` and ``tool_end`` events to previously registered
``tool_call`` entries in the accumulated turn state blob.
"""

from __future__ import annotations

from typing import Any


def match_tool_start(
    tool_calls: list[dict[str, Any]],
    tool_call_id: str | None,
    name: str,
    arguments: Any = None,
    agent: str = "",
) -> None:
    """Mark the matching tool_call entry as started with arguments."""
    for tc in reversed(tool_calls):
        if (tool_call_id and tc.get("tool_call_id") == tool_call_id) or (
            not tool_call_id and tc["name"] == name and not tc["started"]
        ):
            tc["arguments"] = arguments
            tc["started"] = True
            if agent and not tc.get("agent"):
                tc["agent"] = agent
            return
    tool_calls.append(
        {
            "tool_call_id": tool_call_id,
            "name": name,
            "arguments": arguments,
            "agent": agent,
            "started": True,
            "done": False,
        }
    )


def match_tool_end(
    tool_calls: list[dict[str, Any]],
    tool_call_id: str | None,
    name: str,
    result: str | None,
    agent: str = "",
) -> None:
    """Mark the matching tool_call entry as done with result."""
    # Me prefer matching by tool_call_id; fall back to name if missing
    if tool_call_id:
        for tc in reversed(tool_calls):
            if tc.get("tool_call_id") == tool_call_id:
                tc["done"] = True
                tc["result"] = result
                if agent and not tc.get("agent"):
                    tc["agent"] = agent
                return
    # Fallback: match last undone entry by name
    for tc in reversed(tool_calls):
        if tc["name"] == name and not tc["done"]:
            tc["done"] = True
            tc["result"] = result
            if agent and not tc.get("agent"):
                tc["agent"] = agent
            return
    tool_calls.append(
        {
            "tool_call_id": tool_call_id,
            "name": name,
            "arguments": None,
            "result": result,
            "agent": agent,
            "started": True,
            "done": True,
        }
    )
