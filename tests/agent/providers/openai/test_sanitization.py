"""Tests for ``sanitize_openai_tool_pairs``.

This runs on every OpenAI-compatible provider request, so its neighbour scan
(assistant -> immediately following tool messages) has to stay exact. The scan
walks forward by index and stops at the first non-tool message; these tests pin
that boundary behaviour.
"""

from __future__ import annotations

from app.agent.providers.openai.sanitization import sanitize_openai_tool_pairs
from app.agent.schemas.chat import (
    AssistantMessage,
    ChatMessage,
    FunctionCall,
    HumanMessage,
    ToolMessage,
)
from app.agent.schemas.chat import ToolCall as ChatToolCall


def _assistant(*call_ids: str, content: str = "") -> AssistantMessage:
    return AssistantMessage(
        content=content,
        tool_calls=[
            ChatToolCall(
                id=cid,
                type="function",
                function=FunctionCall(name="read", arguments='{"path":"a.py"}'),
            )
            for cid in call_ids
        ],
    )


def _tool(call_id: str) -> ToolMessage:
    return ToolMessage(content="ok", tool_call_id=call_id)


def test_keeps_complete_assistant_tool_pairs() -> None:
    messages: list[ChatMessage] = [
        HumanMessage(content="hi"),
        _assistant("c1", "c2"),
        _tool("c1"),
        _tool("c2"),
    ]

    result = sanitize_openai_tool_pairs(messages)

    assert len(result) == 4
    assistant = result[1]
    assert isinstance(assistant, AssistantMessage)
    assert assistant.tool_calls is not None
    assert [tc.id for tc in assistant.tool_calls] == ["c1", "c2"]


def test_strips_tool_calls_when_a_result_is_missing() -> None:
    messages: list[ChatMessage] = [
        _assistant("c1", "c2", content="partial"),
        _tool("c1"),
    ]

    result = sanitize_openai_tool_pairs(messages)

    assistant = result[0]
    assert isinstance(assistant, AssistantMessage)
    assert assistant.tool_calls is None
    # The orphaned result is dropped because its assistant no longer claims it.
    assert len(result) == 1


def test_drops_orphan_tool_message_with_no_preceding_assistant() -> None:
    messages: list[ChatMessage] = [HumanMessage(content="hi"), _tool("nope")]

    result = sanitize_openai_tool_pairs(messages)

    assert [type(m) for m in result] == [HumanMessage]


def test_scan_stops_at_the_first_non_tool_message() -> None:
    """A later turn's tool results must not satisfy an earlier assistant.

    ``c2`` belongs to the second assistant. The forward scan for the first
    assistant must stop at the intervening ``HumanMessage`` rather than reaching
    ahead and treating ``c2`` as its own — otherwise the first assistant would
    be wrongly considered complete.
    """
    messages: list[ChatMessage] = [
        _assistant("c1", "c2", content="first"),
        HumanMessage(content="interrupt"),
        _assistant("c2", content="second"),
        _tool("c2"),
    ]

    result = sanitize_openai_tool_pairs(messages)

    first = result[0]
    assert isinstance(first, AssistantMessage)
    assert first.tool_calls is None, "must not borrow c2 from the later turn"

    second = result[2]
    assert isinstance(second, AssistantMessage)
    assert second.tool_calls is not None
    assert [tc.id for tc in second.tool_calls] == ["c2"]


def test_assistant_at_end_of_history_with_pending_tool_calls() -> None:
    """No following messages at all — the forward scan must not run off the end."""
    messages: list[ChatMessage] = [_assistant("c1", content="tail")]

    result = sanitize_openai_tool_pairs(messages)

    assistant = result[0]
    assert isinstance(assistant, AssistantMessage)
    assert assistant.tool_calls is None


def test_duplicate_tool_result_for_same_call_id_is_dropped() -> None:
    messages: list[ChatMessage] = [
        _assistant("c1"),
        _tool("c1"),
        _tool("c1"),
    ]

    result = sanitize_openai_tool_pairs(messages)

    tool_messages = [m for m in result if isinstance(m, ToolMessage)]
    assert len(tool_messages) == 1


def test_assistant_without_tool_calls_is_untouched() -> None:
    messages: list[ChatMessage] = [
        HumanMessage(content="hi"),
        AssistantMessage(content="plain answer"),
    ]

    result = sanitize_openai_tool_pairs(messages)

    assert len(result) == 2
    assert result[1].content == "plain answer"


def test_long_history_is_preserved_exactly() -> None:
    """Guards the index-based scan against off-by-one across many turns."""
    messages: list[ChatMessage] = []
    for turn in range(50):
        messages.append(HumanMessage(content=f"u{turn}"))
        messages.append(_assistant(f"c{turn}a", f"c{turn}b"))
        messages.append(_tool(f"c{turn}a"))
        messages.append(_tool(f"c{turn}b"))

    result = sanitize_openai_tool_pairs(messages)

    assert len(result) == len(messages)
    for original, sanitized in zip(messages, result, strict=True):
        assert type(original) is type(sanitized)
        if isinstance(original, AssistantMessage):
            assert isinstance(sanitized, AssistantMessage)
            assert sanitized.tool_calls is not None
