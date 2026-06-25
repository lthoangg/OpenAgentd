"""Tests for _deserialize_messages partial tool call sanitisation.

Tests the fix that strips tool calls with invalid JSON arguments and removes
orphaned ToolMessages that reference dropped tool calls.
"""

from __future__ import annotations

import json
from uuid import uuid7

import pytest
from loguru import logger

from app.agent.schemas.chat import (
    AssistantMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from app.models.chat import SessionMessage
from app.services.chat_service import _deserialize_messages


# ─────────────────────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def session_id():
    """Generate a unique session ID for each test."""
    return uuid7()


@pytest.fixture
def caplog_loguru(caplog):
    """Capture loguru logs in caplog for assertion.

    Loguru doesn't use the standard logging module by default, so we need to
    add a handler that writes to caplog's handler.
    """
    handler_id = logger.add(
        caplog.handler,
        format="{message}",
        level="DEBUG",
    )
    yield caplog
    logger.remove(handler_id)


def make_session_message(
    role: str,
    content: str | None = None,
    tool_calls: list[dict] | None = None,
    tool_call_id: str | None = None,
    name: str | None = None,
    session_id=None,
) -> SessionMessage:
    """Factory for creating SessionMessage ORM objects."""
    if session_id is None:
        session_id = uuid7()
    return SessionMessage(
        id=uuid7(),
        session_id=session_id,
        role=role,
        content=content,
        tool_calls=tool_calls,
        tool_call_id=tool_call_id,
        name=name,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Happy Path Tests
# ─────────────────────────────────────────────────────────────────────────────


def test_valid_json_arguments_kept(session_id, caplog_loguru):
    """Valid JSON arguments in tool calls are preserved."""
    db_messages = [
        make_session_message(
            role="assistant",
            content="I'll help",
            tool_calls=[
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "search",
                        "arguments": '{"query": "python"}',
                    },
                }
            ],
            session_id=session_id,
        ),
    ]

    result = _deserialize_messages(db_messages)

    assert len(result) == 1
    assert isinstance(result[0], AssistantMessage)
    assert result[0].tool_calls is not None
    assert len(result[0].tool_calls) == 1
    assert result[0].tool_calls[0].id == "call_1"
    assert result[0].tool_calls[0].function.name == "search"
    assert result[0].tool_calls[0].function.arguments == '{"query": "python"}'


def test_multiple_valid_tool_calls_all_kept(session_id, caplog_loguru):
    """Multiple tool calls with valid JSON are all preserved."""
    db_messages = [
        make_session_message(
            role="assistant",
            content="Multiple tools",
            tool_calls=[
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "search",
                        "arguments": '{"query": "python"}',
                    },
                },
                {
                    "id": "call_2",
                    "type": "function",
                    "function": {
                        "name": "calculate",
                        "arguments": '{"x": 10, "y": 20}',
                    },
                },
            ],
            session_id=session_id,
        ),
    ]

    result = _deserialize_messages(db_messages)

    assert len(result) == 1
    assert isinstance(result[0], AssistantMessage)
    assert len(result[0].tool_calls) == 2
    assert result[0].tool_calls[0].id == "call_1"
    assert result[0].tool_calls[1].id == "call_2"


def test_assistant_message_without_tool_calls_untouched(session_id):
    """AssistantMessage with no tool_calls is not modified."""
    db_messages = [
        make_session_message(
            role="assistant",
            content="Just a response",
            tool_calls=None,
            session_id=session_id,
        ),
    ]

    result = _deserialize_messages(db_messages)

    assert len(result) == 1
    assert isinstance(result[0], AssistantMessage)
    assert result[0].content == "Just a response"
    assert result[0].tool_calls is None


def test_assistant_message_with_empty_tool_calls_untouched(session_id):
    """AssistantMessage with empty tool_calls list is not modified."""
    db_messages = [
        make_session_message(
            role="assistant",
            content="No tools",
            tool_calls=[],
            session_id=session_id,
        ),
    ]

    result = _deserialize_messages(db_messages)

    assert len(result) == 1
    assert isinstance(result[0], AssistantMessage)
    assert result[0].tool_calls == []


def test_non_assistant_messages_untouched(session_id):
    """Non-assistant messages are not processed for tool call validation."""
    db_messages = [
        make_session_message(
            role="system", content="You are helpful", session_id=session_id
        ),
        make_session_message(role="user", content="Hello", session_id=session_id),
        make_session_message(
            role="tool",
            content="result",
            tool_call_id="call_1",
            name="tool_name",
            session_id=session_id,
        ),
    ]

    result = _deserialize_messages(db_messages)

    assert len(result) == 3
    assert isinstance(result[0], SystemMessage)
    assert isinstance(result[1], HumanMessage)
    assert isinstance(result[2], ToolMessage)


# ─────────────────────────────────────────────────────────────────────────────
# Bug Scenario: Partial/Truncated JSON
# ─────────────────────────────────────────────────────────────────────────────


def test_partial_json_arguments_dropped(session_id, caplog_loguru):
    """Tool call with truncated JSON arguments is dropped and warning logged."""
    db_messages = [
        make_session_message(
            role="assistant",
            content="I'll search",
            tool_calls=[
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "search",
                        "arguments": '{"query": "python"',  # Truncated JSON
                    },
                }
            ],
            session_id=session_id,
        ),
    ]

    result = _deserialize_messages(db_messages)

    # Tool call should be dropped
    assert len(result) == 1
    assert isinstance(result[0], AssistantMessage)
    assert result[0].tool_calls is None  # Empty list becomes None

    # Warning should be logged
    assert "deserialize_drop_partial_tool_call" in caplog_loguru.text
    assert "call_1" in caplog_loguru.text
    assert "search" in caplog_loguru.text


def test_partial_json_paired_tool_message_removed(session_id, caplog_loguru):
    """ToolMessage with tool_call_id matching dropped tool call is removed."""
    db_messages = [
        make_session_message(
            role="assistant",
            content="I'll search",
            tool_calls=[
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "search",
                        "arguments": '{"query": "python"',  # Truncated
                    },
                }
            ],
            session_id=session_id,
        ),
        make_session_message(
            role="tool",
            content="Search result",
            tool_call_id="call_1",
            name="search",
            session_id=session_id,
        ),
    ]

    result = _deserialize_messages(db_messages)

    # Both messages should be gone: assistant (tool_calls stripped) and tool (orphaned)
    # Actually, the assistant message is kept but with tool_calls=None
    # The tool message is removed
    assert len(result) == 1
    assert isinstance(result[0], AssistantMessage)
    assert result[0].tool_calls is None


def test_empty_string_arguments_invalid(session_id, caplog_loguru):
    """Empty string arguments are treated as invalid JSON."""
    db_messages = [
        make_session_message(
            role="assistant",
            content="I'll call",
            tool_calls=[
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "tool",
                        "arguments": "",  # Empty string
                    },
                }
            ],
            session_id=session_id,
        ),
    ]

    result = _deserialize_messages(db_messages)

    assert len(result) == 1
    assert isinstance(result[0], AssistantMessage)
    assert result[0].tool_calls is None
    assert "deserialize_drop_partial_tool_call" in caplog_loguru.text


def test_valid_empty_object_kept(session_id):
    """Valid JSON empty object {} is kept."""
    db_messages = [
        make_session_message(
            role="assistant",
            content="I'll call",
            tool_calls=[
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "tool",
                        "arguments": "{}",
                    },
                }
            ],
            session_id=session_id,
        ),
    ]

    result = _deserialize_messages(db_messages)

    assert len(result) == 1
    assert isinstance(result[0], AssistantMessage)
    assert result[0].tool_calls is not None
    assert len(result[0].tool_calls) == 1
    assert result[0].tool_calls[0].function.arguments == "{}"


def test_valid_empty_array_kept(session_id):
    """Valid JSON empty array [] is kept."""
    db_messages = [
        make_session_message(
            role="assistant",
            content="I'll call",
            tool_calls=[
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "tool",
                        "arguments": "[]",
                    },
                }
            ],
            session_id=session_id,
        ),
    ]

    result = _deserialize_messages(db_messages)

    assert len(result) == 1
    assert isinstance(result[0], AssistantMessage)
    assert result[0].tool_calls is not None
    assert len(result[0].tool_calls) == 1
    assert result[0].tool_calls[0].function.arguments == "[]"


# ─────────────────────────────────────────────────────────────────────────────
# Edge Cases
# ─────────────────────────────────────────────────────────────────────────────


def test_mixed_valid_and_invalid_tool_calls(session_id, caplog_loguru):
    """Some tool calls valid, some partial — only bad ones removed."""
    db_messages = [
        make_session_message(
            role="assistant",
            content="Multiple calls",
            tool_calls=[
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "search",
                        "arguments": '{"query": "python"}',  # Valid
                    },
                },
                {
                    "id": "call_2",
                    "type": "function",
                    "function": {
                        "name": "calculate",
                        "arguments": '{"x": 10',  # Truncated
                    },
                },
                {
                    "id": "call_3",
                    "type": "function",
                    "function": {
                        "name": "fetch",
                        "arguments": '{"url": "https://example.com"}',  # Valid
                    },
                },
            ],
            session_id=session_id,
        ),
    ]

    result = _deserialize_messages(db_messages)

    assert len(result) == 1
    assert isinstance(result[0], AssistantMessage)
    assert len(result[0].tool_calls) == 2
    assert result[0].tool_calls[0].id == "call_1"
    assert result[0].tool_calls[1].id == "call_3"
    assert "deserialize_drop_partial_tool_call" in caplog_loguru.text
    assert "call_2" in caplog_loguru.text


def test_mixed_valid_and_invalid_with_orphaned_tool_messages(session_id, caplog_loguru):
    """Only orphaned ToolMessages for dropped calls are removed."""
    db_messages = [
        make_session_message(
            role="assistant",
            content="Multiple calls",
            tool_calls=[
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "search",
                        "arguments": '{"query": "python"}',  # Valid
                    },
                },
                {
                    "id": "call_2",
                    "type": "function",
                    "function": {
                        "name": "calculate",
                        "arguments": '{"x": 10',  # Truncated
                    },
                },
            ],
            session_id=session_id,
        ),
        make_session_message(
            role="tool",
            content="Search result",
            tool_call_id="call_1",
            name="search",
            session_id=session_id,
        ),
        make_session_message(
            role="tool",
            content="Calc result",
            tool_call_id="call_2",
            name="calculate",
            session_id=session_id,
        ),
    ]

    result = _deserialize_messages(db_messages)

    # Should have: assistant (with 1 tool call) + tool message for call_1
    # Should NOT have: tool message for call_2 (orphaned)
    assert len(result) == 2
    assert isinstance(result[0], AssistantMessage)
    assert len(result[0].tool_calls) == 1
    assert result[0].tool_calls[0].id == "call_1"
    assert isinstance(result[1], ToolMessage)
    assert result[1].tool_call_id == "call_1"


def test_partial_tool_call_no_corresponding_tool_message(session_id, caplog_loguru):
    """Partial tool call with no ToolMessage doesn't crash."""
    db_messages = [
        make_session_message(
            role="assistant",
            content="I'll call",
            tool_calls=[
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "search",
                        "arguments": '{"query": "python"',  # Truncated
                    },
                }
            ],
            session_id=session_id,
        ),
    ]

    result = _deserialize_messages(db_messages)

    assert len(result) == 1
    assert isinstance(result[0], AssistantMessage)
    assert result[0].tool_calls is None
    assert "deserialize_drop_partial_tool_call" in caplog_loguru.text


def test_multiple_assistant_messages_independent_sanitisation(
    session_id, caplog_loguru
):
    """Each AssistantMessage is sanitised independently."""
    db_messages = [
        make_session_message(
            role="assistant",
            content="First assistant",
            tool_calls=[
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "search",
                        "arguments": '{"query": "python"}',  # Valid
                    },
                }
            ],
            session_id=session_id,
        ),
        make_session_message(
            role="assistant",
            content="Second assistant",
            tool_calls=[
                {
                    "id": "call_2",
                    "type": "function",
                    "function": {
                        "name": "calculate",
                        "arguments": '{"x": 10',  # Truncated
                    },
                }
            ],
            session_id=session_id,
        ),
    ]

    result = _deserialize_messages(db_messages)

    assert len(result) == 2
    assert isinstance(result[0], AssistantMessage)
    assert len(result[0].tool_calls) == 1
    assert result[0].tool_calls[0].id == "call_1"
    assert isinstance(result[1], AssistantMessage)
    assert result[1].tool_calls is None
    assert "deserialize_drop_partial_tool_call" in caplog_loguru.text


def test_multiple_orphaned_tool_messages_all_removed(session_id, caplog_loguru):
    """All ToolMessages for dropped tool calls are removed."""
    db_messages = [
        make_session_message(
            role="assistant",
            content="Multiple calls",
            tool_calls=[
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "search",
                        "arguments": '{"query": "python"',  # Truncated
                    },
                },
                {
                    "id": "call_2",
                    "type": "function",
                    "function": {
                        "name": "calculate",
                        "arguments": '{"x": 10',  # Truncated
                    },
                },
            ],
            session_id=session_id,
        ),
        make_session_message(
            role="tool",
            content="Search result",
            tool_call_id="call_1",
            name="search",
            session_id=session_id,
        ),
        make_session_message(
            role="tool",
            content="Calc result",
            tool_call_id="call_2",
            name="calculate",
            session_id=session_id,
        ),
    ]

    result = _deserialize_messages(db_messages)

    # Should only have the assistant message (with no tool calls)
    assert len(result) == 1
    assert isinstance(result[0], AssistantMessage)
    assert result[0].tool_calls is None


def test_tool_message_with_non_matching_tool_call_id_kept(session_id):
    """ToolMessage with tool_call_id not in bad set is kept."""
    db_messages = [
        make_session_message(
            role="assistant",
            content="I'll call",
            tool_calls=[
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "search",
                        "arguments": '{"query": "python"',  # Truncated
                    },
                }
            ],
            session_id=session_id,
        ),
        make_session_message(
            role="tool",
            content="Result for different call",
            tool_call_id="call_999",  # Different ID
            name="other_tool",
            session_id=session_id,
        ),
    ]

    result = _deserialize_messages(db_messages)

    # Should have: assistant (no tool calls) + tool message (not orphaned)
    assert len(result) == 2
    assert isinstance(result[0], AssistantMessage)
    assert result[0].tool_calls is None
    assert isinstance(result[1], ToolMessage)
    assert result[1].tool_call_id == "call_999"


def test_sanitize_tool_pairs_drops_orphan_tool_message(session_id, caplog_loguru):
    """LLM sanitization drops ToolMessages with no matching assistant call."""
    db_messages = [
        make_session_message(role="user", content="Hello", session_id=session_id),
        make_session_message(
            role="tool",
            content="orphan result",
            tool_call_id="call_999",
            name="search",
            session_id=session_id,
        ),
    ]

    result = _deserialize_messages(db_messages, sanitize_tool_pairs=True)

    assert len(result) == 1
    assert isinstance(result[0], HumanMessage)
    assert "deserialize_drop_orphan_tool_message" in caplog_loguru.text
    assert "call_999" in caplog_loguru.text


def test_sanitize_tool_pairs_keeps_valid_assistant_tool_pair(session_id):
    """LLM sanitization preserves a complete assistant/tool pair."""
    db_messages = [
        make_session_message(
            role="assistant",
            content="I'll search",
            tool_calls=[
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "search", "arguments": "{}"},
                }
            ],
            session_id=session_id,
        ),
        make_session_message(
            role="tool",
            content="result",
            tool_call_id="call_1",
            name="search",
            session_id=session_id,
        ),
    ]

    result = _deserialize_messages(db_messages, sanitize_tool_pairs=True)

    assert len(result) == 2
    assert isinstance(result[0], AssistantMessage)
    assert result[0].tool_calls is not None
    assert result[0].tool_calls[0].id == "call_1"
    assert isinstance(result[1], ToolMessage)
    assert result[1].tool_call_id == "call_1"


def test_sanitize_tool_pairs_strips_incomplete_assistant_tool_calls(
    session_id, caplog_loguru
):
    """LLM sanitization strips assistant tool_calls missing tool outputs."""
    db_messages = [
        make_session_message(
            role="assistant",
            content="I'll search",
            tool_calls=[
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "search", "arguments": "{}"},
                }
            ],
            session_id=session_id,
        ),
        make_session_message(role="user", content="next", session_id=session_id),
    ]

    result = _deserialize_messages(db_messages, sanitize_tool_pairs=True)

    assert len(result) == 2
    assert isinstance(result[0], AssistantMessage)
    assert result[0].tool_calls is None
    assert isinstance(result[1], HumanMessage)
    assert "deserialize_strip_incomplete_assistant_tool_calls" in caplog_loguru.text
    assert "call_1" in caplog_loguru.text


def test_sanitize_tool_pairs_drops_empty_assistant_after_incomplete_tool_strip(
    session_id, caplog_loguru
):
    """Empty assistant tool stubs are removed to avoid invalid lead history."""
    db_messages = [
        make_session_message(
            role="assistant",
            content="",
            tool_calls=[
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "team_message", "arguments": "{}"},
                }
            ],
            session_id=session_id,
        ),
        make_session_message(
            role="user", content="[executor#1]: result", session_id=session_id
        ),
    ]

    result = _deserialize_messages(db_messages, sanitize_tool_pairs=True)

    assert len(result) == 1
    assert isinstance(result[0], HumanMessage)
    assert result[0].content == "[executor#1]: result"
    assert "deserialize_strip_incomplete_assistant_tool_calls" in caplog_loguru.text
    assert "deserialize_drop_empty_assistant_after_tool_strip" in caplog_loguru.text


def test_sanitize_tool_pairs_drops_tool_output_for_bad_partial_call(
    session_id, caplog_loguru
):
    """Partial tool calls are stripped and matching tool outputs are removed."""
    db_messages = [
        make_session_message(
            role="assistant",
            content="I'll write",
            tool_calls=[
                {
                    "id": "call_bad",
                    "type": "function",
                    "function": {"name": "write", "arguments": '{"path": "x"'},
                }
            ],
            session_id=session_id,
        ),
        make_session_message(
            role="tool",
            content="result",
            tool_call_id="call_bad",
            name="write",
            session_id=session_id,
        ),
    ]

    result = _deserialize_messages(db_messages, sanitize_tool_pairs=True)

    assert len(result) == 1
    assert isinstance(result[0], AssistantMessage)
    assert result[0].tool_calls is None
    assert "deserialize_drop_partial_tool_call" in caplog_loguru.text
    assert "deserialize_drop_orphan_tool_message" in caplog_loguru.text


def test_malformed_json_with_special_characters(session_id, caplog_loguru):
    """Malformed JSON with special characters is dropped."""
    db_messages = [
        make_session_message(
            role="assistant",
            content="I'll call",
            tool_calls=[
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "search",
                        "arguments": '{"query": "python\x00\x01\x02"}',  # Invalid chars
                    },
                }
            ],
            session_id=session_id,
        ),
    ]

    result = _deserialize_messages(db_messages)

    assert len(result) == 1
    assert isinstance(result[0], AssistantMessage)
    assert result[0].tool_calls is None
    assert "deserialize_drop_partial_tool_call" in caplog_loguru.text


def test_complex_valid_json_kept(session_id):
    """Complex but valid JSON is kept."""
    complex_args = json.dumps(
        {
            "query": "python",
            "filters": {
                "language": "en",
                "date_range": ["2020-01-01", "2025-12-31"],
            },
            "options": {
                "limit": 100,
                "offset": 0,
            },
        }
    )
    db_messages = [
        make_session_message(
            role="assistant",
            content="I'll search",
            tool_calls=[
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "search",
                        "arguments": complex_args,
                    },
                }
            ],
            session_id=session_id,
        ),
    ]

    result = _deserialize_messages(db_messages)

    assert len(result) == 1
    assert isinstance(result[0], AssistantMessage)
    assert len(result[0].tool_calls) == 1
    assert result[0].tool_calls[0].function.arguments == complex_args


def test_warning_includes_args_prefix(session_id, caplog_loguru):
    """Warning log includes first 80 chars of truncated arguments."""
    long_truncated = '{"query": "' + "x" * 100  # Truncated, no closing
    db_messages = [
        make_session_message(
            role="assistant",
            content="I'll call",
            tool_calls=[
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "search",
                        "arguments": long_truncated,
                    },
                }
            ],
            session_id=session_id,
        ),
    ]

    _deserialize_messages(db_messages)

    assert "deserialize_drop_partial_tool_call" in caplog_loguru.text
    # The prefix should be in the log (first 80 chars)
    assert long_truncated[:80] in caplog_loguru.text or "query" in caplog_loguru.text


def test_all_message_types_in_sequence(session_id):
    """Full sequence of different message types is handled correctly."""
    db_messages = [
        make_session_message(
            role="system", content="You are helpful", session_id=session_id
        ),
        make_session_message(role="user", content="Hello", session_id=session_id),
        make_session_message(
            role="assistant",
            content="I'll help",
            tool_calls=[
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "search",
                        "arguments": '{"query": "python"}',
                    },
                }
            ],
            session_id=session_id,
        ),
        make_session_message(
            role="tool",
            content="Result",
            tool_call_id="call_1",
            name="search",
            session_id=session_id,
        ),
        make_session_message(role="user", content="Thanks", session_id=session_id),
    ]

    result = _deserialize_messages(db_messages)

    assert len(result) == 5
    assert isinstance(result[0], SystemMessage)
    assert isinstance(result[1], HumanMessage)
    assert isinstance(result[2], AssistantMessage)
    assert isinstance(result[3], ToolMessage)
    assert isinstance(result[4], HumanMessage)
