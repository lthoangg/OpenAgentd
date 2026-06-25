from __future__ import annotations

import json
from collections.abc import Sequence
from uuid import UUID

from loguru import logger
from pydantic import TypeAdapter

from app.agent.multimodal import build_parts_from_metas
from app.agent.schemas.chat import (
    AssistantMessage,
    ChatMessage,
    HumanMessage,
    ToolMessage,
)
from app.models.chat import SessionMessage

USER_SHELL_LLM_CONTENT = "The following tool was executed by the user"

_chat_message_adapter: TypeAdapter[ChatMessage] = TypeAdapter(ChatMessage)


def deserialize_messages(
    db_messages: Sequence[SessionMessage], *, sanitize_tool_pairs: bool = False
) -> list[ChatMessage]:
    result: list[ChatMessage] = []
    for m in db_messages:
        try:
            d = m.model_dump()
            if d.get("tool_call_id") is None:
                d["tool_call_id"] = ""
            msg = _chat_message_adapter.validate_python(d)
            msg.db_id = m.id

            if isinstance(msg, HumanMessage) and m.extra:
                attachments = m.extra.get("attachments")
                if attachments and isinstance(attachments, list):
                    parts = build_parts(msg.content or "", attachments)
                    if parts:
                        msg.parts = parts

            result.append(msg)
        except Exception:
            logger.warning(
                "deserialize_skip_unknown_role session_id={} message_id={} role={}",
                m.session_id,
                m.id,
                m.role,
            )

    bad_tool_call_ids: set[str] = set()
    for msg in result:
        if not isinstance(msg, AssistantMessage) or not msg.tool_calls:
            continue
        clean: list = []
        for tc in msg.tool_calls:
            try:
                json.loads(tc.function.arguments)
                clean.append(tc)
            except (json.JSONDecodeError, ValueError):
                bad_tool_call_ids.add(tc.id)
                logger.warning(
                    "deserialize_drop_partial_tool_call tool={} id={} args_prefix={!r}",
                    tc.function.name,
                    tc.id,
                    tc.function.arguments[:80],
                )
        if len(clean) != len(msg.tool_calls):
            msg.tool_calls = clean or None

    if bad_tool_call_ids:
        kept: list[ChatMessage] = []
        rows_by_id = message_row_by_id(db_messages)
        for msg in result:
            if isinstance(msg, ToolMessage) and msg.tool_call_id in bad_tool_call_ids:
                row = rows_by_id.get(msg.db_id)
                logger.warning(
                    "deserialize_drop_orphan_tool_message session_id={} message_id={} tool_call_id={}",
                    row.session_id if row else None,
                    msg.db_id,
                    msg.tool_call_id,
                )
                continue
            kept.append(msg)
        result = kept

    if sanitize_tool_pairs:
        result = sanitize_tool_message_pairs(result, db_messages)

    return result


def apply_llm_content_overrides(messages: list[ChatMessage]) -> list[ChatMessage]:
    for msg in messages:
        if not isinstance(msg, HumanMessage) or not msg.extra:
            continue
        if msg.extra.get("kind") == "user_shell":
            msg.content = USER_SHELL_LLM_CONTENT
    return messages


def message_row_by_id(
    db_messages: Sequence[SessionMessage],
) -> dict[UUID | None, SessionMessage]:
    return {m.id: m for m in db_messages}


def sanitize_tool_message_pairs(
    messages: list[ChatMessage], db_messages: Sequence[SessionMessage]
) -> list[ChatMessage]:
    rows_by_id = message_row_by_id(db_messages)
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
            for next_msg in messages[idx + 1 :]:
                if not isinstance(next_msg, ToolMessage):
                    break
                if next_msg.tool_call_id:
                    following_tool_ids.add(next_msg.tool_call_id)

            missing = tool_call_ids - following_tool_ids
            if tool_call_ids and not missing:
                expected_tool_ids = set(tool_call_ids)
                result.append(msg)
            else:
                row = rows_by_id.get(msg.db_id)
                logger.warning(
                    "deserialize_strip_incomplete_assistant_tool_calls session_id={} message_id={} missing_ids=[{}]",
                    row.session_id if row else None,
                    msg.db_id,
                    ", ".join(sorted(missing or tool_call_ids)),
                )
                result.append(msg.model_copy(update={"tool_calls": None}))
            continue

        if isinstance(msg, ToolMessage):
            if msg.tool_call_id and msg.tool_call_id in expected_tool_ids:
                result.append(msg)
                expected_tool_ids.remove(msg.tool_call_id)
            else:
                row = rows_by_id.get(msg.db_id)
                logger.warning(
                    "deserialize_drop_orphan_tool_message session_id={} message_id={} tool_call_id={}",
                    row.session_id if row else None,
                    msg.db_id,
                    msg.tool_call_id,
                )
            continue

        expected_tool_ids.clear()
        result.append(msg)

    return result


def build_parts(text: str, attachments: list[dict]) -> list | None:
    parts = build_parts_from_metas(text, attachments)
    has_file_blocks = any(
        not (hasattr(p, "text") and getattr(p, "text") == text) for p in parts
    )
    return parts if has_file_blocks else None
