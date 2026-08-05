"""Defensive message sanitization for OpenAI-compatible providers."""

from __future__ import annotations

from loguru import logger

from app.agent.schemas.chat import AssistantMessage, ChatMessage, ToolMessage


def sanitize_openai_tool_pairs(messages: list[ChatMessage]) -> list[ChatMessage]:
    """Return messages with only OpenAI-valid assistant/tool pairings.

    Persisted history is normally healed before provider calls. This is a last
    line of defence for OpenAI-compatible APIs: drop orphan tool outputs and
    strip assistant ``tool_calls`` when their consecutive tool outputs are not
    present, avoiding provider-side 400s for malformed history.
    """
    result: list[ChatMessage] = []
    expected_tool_ids: set[str] = set()

    for idx, msg in enumerate(messages):
        if isinstance(msg, AssistantMessage):
            expected_tool_ids.clear()
            if not msg.tool_calls:
                result.append(msg)
                continue

            tool_call_ids = {tc.id for tc in msg.tool_calls if tc.id}
            following_tool_ids: set[str] = set()
            # Index-based scan, not ``messages[idx + 1:]``: the loop breaks at
            # the first non-tool message (so it reads a handful of entries),
            # but slicing copied the whole remaining history first, making the
            # enclosing loop O(n^2) over session length. This runs on every
            # provider request, so it re-paid that cost per tool round-trip.
            for next_idx in range(idx + 1, len(messages)):
                next_msg = messages[next_idx]
                if not isinstance(next_msg, ToolMessage):
                    break
                if next_msg.tool_call_id:
                    following_tool_ids.add(next_msg.tool_call_id)

            if tool_call_ids and tool_call_ids.issubset(following_tool_ids):
                expected_tool_ids = set(tool_call_ids)
                result.append(msg)
            else:
                logger.warning(
                    "openai_strip_incomplete_assistant_tool_calls idx={} ids=[{}]",
                    idx,
                    ", ".join(sorted(tool_call_ids)),
                )
                result.append(msg.model_copy(update={"tool_calls": None}))
            continue

        if isinstance(msg, ToolMessage):
            if msg.tool_call_id and msg.tool_call_id in expected_tool_ids:
                result.append(msg)
                expected_tool_ids.remove(msg.tool_call_id)
            else:
                logger.warning(
                    "openai_drop_orphan_tool_message idx={} tool_call_id={}",
                    idx,
                    msg.tool_call_id,
                )
            continue

        expected_tool_ids.clear()
        result.append(msg)

    return result
