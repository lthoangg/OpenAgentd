from __future__ import annotations

import json
from uuid import uuid7

import pytest
from loguru import logger

from app.agent.schemas.chat import AssistantMessage, HumanMessage
from app.models.chat import SessionMessage
from app.services.chat_service_messages import (
    USER_SHELL_LLM_CONTENT,
    apply_llm_content_overrides,
    deserialize_messages,
)


@pytest.fixture
def session_id():
    return uuid7()


@pytest.fixture
def caplog_loguru(caplog):
    handler_id = logger.add(caplog.handler, format="{message}", level="DEBUG")
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


def test_deserialize_messages_keeps_valid_tool_call_json(session_id, caplog_loguru):
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
        )
    ]

    result = deserialize_messages(db_messages)

    assert len(result) == 1
    assert isinstance(result[0], AssistantMessage)
    assert result[0].tool_calls is not None
    assert result[0].tool_calls[0].id == "call_1"


def test_deserialize_messages_strips_partial_tool_calls_and_orphans(
    session_id, caplog_loguru
):
    db_messages = [
        make_session_message(
            role="assistant",
            content="working",
            tool_calls=[
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "search",
                        "arguments": '{"query": ',
                    },
                }
            ],
            session_id=session_id,
        ),
        make_session_message(
            role="tool",
            content="orphan",
            tool_call_id="call_1",
            name="search",
            session_id=session_id,
        ),
    ]

    result = deserialize_messages(db_messages)

    assert len(result) == 1
    assert isinstance(result[0], AssistantMessage)
    assert result[0].tool_calls is None


def test_apply_llm_content_overrides_builds_path_hint_for_text_attachment():
    """Text (and all non-image) attachments emit a path hint — no inlining."""
    msg = HumanMessage(
        content="check this",
        extra={
            "attachments": [
                {
                    "filename": "notes.txt",
                    "original_name": "notes.txt",
                    "category": "text",
                    "url": "/api/team/sid/uploads/notes.txt",
                }
            ]
        },
    )

    result = apply_llm_content_overrides([msg])

    assert len(result) == 1
    parts = result[0].parts
    assert parts is not None
    # First part is the path hint; last part is the user message text
    hint_text = parts[0].text
    assert "notes.txt" in hint_text
    assert "./uploads/notes.txt" in hint_text
    assert "read tool" not in hint_text.lower()
    assert parts[-1].text == "check this"


def test_apply_llm_content_overrides_builds_path_hint_for_image_attachment():
    """Image attachments get the same uniform path hint."""
    msg = HumanMessage(
        content="what's in this?",
        extra={
            "attachments": [
                {
                    "filename": "photo.png",
                    "original_name": "photo.png",
                    "category": "image",
                    "url": "/api/team/sid/uploads/photo.png",
                }
            ]
        },
    )

    result = apply_llm_content_overrides([msg])

    parts = result[0].parts
    assert parts is not None
    hint_text = parts[0].text
    assert "photo.png" in hint_text
    assert "./uploads/photo.png" in hint_text
    assert "read tool" not in hint_text.lower()


def test_apply_llm_content_overrides_path_hint_covers_unknown_category():
    """Files with 'file' category (zip, exe, etc.) also get a path hint."""
    msg = HumanMessage(
        content="process this",
        extra={
            "attachments": [
                {
                    "filename": "data.zip",
                    "original_name": "data.zip",
                    "category": "file",
                    "url": "/api/team/sid/uploads/data.zip",
                }
            ]
        },
    )

    result = apply_llm_content_overrides([msg])

    parts = result[0].parts
    assert parts is not None
    hint_text = parts[0].text
    assert "data.zip" in hint_text
    assert "read tool" not in hint_text.lower()


def test_apply_llm_content_overrides_multiple_attachments():
    """One hint per attachment, user message always last."""
    msg = HumanMessage(
        content="go",
        extra={
            "attachments": [
                {"filename": "a.py", "original_name": "a.py", "category": "text"},
                {"filename": "b.png", "original_name": "b.png", "category": "image"},
            ]
        },
    )

    result = apply_llm_content_overrides([msg])

    parts = result[0].parts
    assert parts is not None
    assert len(parts) == 3  # hint-a, hint-b, user text
    assert "a.py" in parts[0].text
    assert "b.png" in parts[1].text
    assert parts[2].text == "go"


def test_apply_llm_content_overrides_marks_shell_messages():
    messages = [
        HumanMessage(content="rm -rf", extra={"kind": "user_shell"}),
        HumanMessage(content="keep me", extra={"kind": "plain"}),
    ]

    result = apply_llm_content_overrides(messages)

    assert result[0].content == USER_SHELL_LLM_CONTENT
    assert result[1].content == "keep me"


def test_deserialize_messages_with_sanitize_tool_pairs_drops_orphan_tool(
    session_id, caplog_loguru
):
    db_messages = [
        make_session_message(
            role="assistant",
            content="tool call",
            tool_calls=[
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "search",
                        "arguments": json.dumps({"query": "python"}),
                    },
                }
            ],
            session_id=session_id,
        ),
        make_session_message(
            role="user",
            content="interrupt",
            session_id=session_id,
        ),
        make_session_message(
            role="tool",
            content="late result",
            tool_call_id="call_1",
            name="search",
            session_id=session_id,
        ),
    ]

    result = deserialize_messages(db_messages, sanitize_tool_pairs=True)

    assert len(result) == 2
    assert isinstance(result[0], AssistantMessage)
    assert result[0].tool_calls is None
    assert isinstance(result[1], HumanMessage)


def test_deserialize_messages_restores_reasoning_signature_from_extra(
    session_id,
) -> None:
    """reasoning_signature stored in extra must be restored onto AssistantMessage
    after deserialization so _split_messages can round-trip it to Anthropic."""
    db_messages = [
        SessionMessage(
            id=uuid7(),
            session_id=session_id,
            role="assistant",
            content="Here is my answer.",
            reasoning_content="Let me think.",
            extra={
                "reasoning_signature": "sig-opaque-token",
                "finish_reason": "end_turn",
            },
        ),
    ]

    result = deserialize_messages(db_messages)

    assert len(result) == 1
    msg = result[0]
    assert isinstance(msg, AssistantMessage)
    assert msg.reasoning_content == "Let me think."
    assert msg.reasoning_signature == "sig-opaque-token"


def test_deserialize_messages_reasoning_signature_absent_when_extra_missing(
    session_id,
) -> None:
    """Pre-fix rows with no reasoning_signature in extra must deserialize cleanly
    with reasoning_signature=None — no KeyError or attribute error."""
    db_messages = [
        SessionMessage(
            id=uuid7(),
            session_id=session_id,
            role="assistant",
            content="answer",
            reasoning_content="thoughts",
            extra={"finish_reason": "end_turn"},  # no reasoning_signature key
        ),
    ]

    result = deserialize_messages(db_messages)

    assert len(result) == 1
    msg = result[0]
    assert isinstance(msg, AssistantMessage)
    assert msg.reasoning_content == "thoughts"
    assert msg.reasoning_signature is None
