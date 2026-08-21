from __future__ import annotations

import json
from collections.abc import Sequence
from typing import cast
from uuid import UUID

from loguru import logger
from pydantic import TypeAdapter

from app.agent.schemas.chat import (
    AssistantMessage,
    ChatMessage,
    ContentBlock,
    HumanMessage,
    SystemMessage,
    TextBlock,
    ToolCall,
    ToolMessage,
)
from app.models.chat import SessionMessage

_content_block_adapter: TypeAdapter[ContentBlock] = TypeAdapter(ContentBlock)
_tool_calls_adapter: TypeAdapter[list[ToolCall]] = TypeAdapter(list[ToolCall])


def _attachment_hint_parts(message: str, attachments: list[dict]) -> list[TextBlock]:
    """Build path-hint TextBlocks for every attachment.

    Every file is saved to disk at upload time.  The agent uses its Read
    or shell tools to inspect the content — no inlining happens here.
    """
    parts: list[TextBlock] = []
    for att in attachments:
        category = att.get("category", "file")
        original_name = att.get("original_name", att.get("filename", "file"))
        filename = att.get("filename", "")
        path_hint = f"./uploads/{filename}" if filename else original_name
        parts.append(
            TextBlock(
                text=f"[Attached {category}: {original_name} — available at {path_hint}]"
            )
        )
    parts.append(TextBlock(text=message))
    return parts


def _chat_message_from_row(row: SessionMessage) -> ChatMessage:
    """Project one trusted persistence row into the canonical runtime union.

    This role dispatch is intentionally explicit.  A generic ``row.model_dump()``
    serializes database-only fields (session id, ordering, timestamps) and then
    asks Pydantic's discriminated union to inspect and discard them.  Selecting
    the fields owned by each runtime model avoids that duplicate work and makes
    the persistence → runtime boundary reviewable in one place.
    """
    if row.role == "system":
        return SystemMessage(
            content=row.content,
            kind=row.kind,
            pinned=row.pinned,
            extra=row.extra,
            db_id=row.id,
        )
    if row.role == "user":
        return HumanMessage(
            content=row.content,
            kind=row.kind,
            pinned=row.pinned,
            extra=row.extra,
            db_id=row.id,
        )
    if row.role == "assistant":
        extra = row.extra or {}
        signature = extra.get("reasoning_signature")
        redacted = extra.get("redacted_thinking_blocks")
        raw_blocks = extra.get("raw_content_blocks")
        encrypted = extra.get("reasoning_encrypted_content")
        item_id = extra.get("reasoning_item_id")
        return AssistantMessage(
            content=row.content,
            kind=row.kind,
            pinned=row.pinned,
            extra=row.extra,
            db_id=row.id,
            reasoning_content=row.reasoning_content,
            reasoning_signature=(
                signature if isinstance(signature, str) and signature else None
            ),
            redacted_thinking_blocks=(
                cast(list[dict], redacted)
                if isinstance(redacted, list) and redacted
                else None
            ),
            raw_content_blocks=(
                cast(list[dict], raw_blocks)
                if isinstance(raw_blocks, list) and raw_blocks
                else None
            ),
            reasoning_item_id=(
                item_id
                if isinstance(encrypted, str)
                and encrypted
                and isinstance(item_id, str)
                and item_id
                else None
            ),
            reasoning_encrypted_content=(
                encrypted if isinstance(encrypted, str) and encrypted else None
            ),
            tool_calls=(
                _tool_calls_adapter.validate_python(row.tool_calls)
                if row.tool_calls is not None
                else None
            ),
        )
    if row.role == "tool":
        raw_parts = (row.extra or {}).get("parts")
        parts = (
            [_content_block_adapter.validate_python(part) for part in raw_parts]
            if isinstance(raw_parts, list)
            else None
        )
        return ToolMessage(
            content=row.content,
            kind=row.kind,
            pinned=row.pinned,
            extra=row.extra,
            db_id=row.id,
            tool_call_id=row.tool_call_id or "",
            name=row.name,
            parts=parts,
        )
    raise ValueError(f"unsupported message role: {row.role}")


def deserialize_messages(
    db_messages: Sequence[SessionMessage], *, sanitize_tool_pairs: bool = False
) -> list[ChatMessage]:
    result: list[ChatMessage] = []
    for m in db_messages:
        try:
            result.append(_chat_message_from_row(m))
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
        clean: list[ToolCall] = []
        for tc in msg.tool_calls:
            try:
                json.loads(tc.function.arguments)
                clean.append(tc)
            except (json.JSONDecodeError, ValueError):
                bad_tool_call_ids.add(tc.id)
                finish_reason = (
                    (msg.extra or {}).get("finish_reason") if msg.extra else None
                )
                logger.warning(
                    "deserialize_drop_partial_tool_call tool={} id={} finish_reason={} args_len={} args_prefix={!r}",
                    tc.function.name,
                    tc.id,
                    finish_reason,
                    len(tc.function.arguments),
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
    out: list[ChatMessage] = []
    for msg in messages:
        if isinstance(msg, HumanMessage) and msg.extra:
            if msg.extra.get("attachment_for_message_id") and not msg.extra.get(
                "mention_context"
            ):
                # Synthetic attachment rows stay in the DB for queue/history
                # bookkeeping, but the LLM should consume the canonical
                # attachment hint from the parent user row instead.
                continue
            attachments = msg.extra.get("attachments")
            if isinstance(attachments, list) and attachments:
                msg = msg.model_copy(
                    update={
                        "parts": _attachment_hint_parts(msg.content or "", attachments)
                    }
                )
        out.append(msg)
    return out


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
            # Index-based scan, not ``messages[idx + 1:]``: the loop breaks at
            # the first non-tool message (so it reads a handful of entries),
            # but slicing copied the whole remaining history first, making the
            # enclosing loop O(n^2) over session length.
            for next_idx in range(idx + 1, len(messages)):
                next_msg = messages[next_idx]
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
                logger.debug(
                    "deserialize_strip_incomplete_assistant_tool_calls session_id={} message_id={} missing_ids=[{}]",
                    row.session_id if row else None,
                    msg.db_id,
                    ", ".join(sorted(missing or tool_call_ids)),
                )
                stripped = msg.model_copy(update={"tool_calls": None})
                if stripped.content:
                    result.append(stripped)
                else:
                    logger.debug(
                        "deserialize_drop_empty_assistant_after_tool_strip session_id={} message_id={}",
                        row.session_id if row else None,
                        msg.db_id,
                    )
            continue

        if isinstance(msg, ToolMessage):
            if msg.tool_call_id and msg.tool_call_id in expected_tool_ids:
                result.append(msg)
                expected_tool_ids.remove(msg.tool_call_id)
            else:
                row = rows_by_id.get(msg.db_id)
                logger.debug(
                    "deserialize_drop_orphan_tool_message session_id={} message_id={} tool_call_id={}",
                    row.session_id if row else None,
                    msg.db_id,
                    msg.tool_call_id,
                )
            continue

        expected_tool_ids.clear()
        result.append(msg)

    return result
