from __future__ import annotations

import json
from collections.abc import Sequence
from uuid import UUID

from loguru import logger
from pydantic import TypeAdapter

from app.agent.schemas.chat import (
    AssistantMessage,
    ChatMessage,
    ContentBlock,
    HumanMessage,
    TextBlock,
    ToolMessage,
)
from app.models.chat import SessionMessage

USER_SHELL_LLM_CONTENT = "The following tool was executed by the user"

_chat_message_adapter: TypeAdapter[ChatMessage] = TypeAdapter(ChatMessage)
_content_block_adapter: TypeAdapter[ContentBlock] = TypeAdapter(ContentBlock)


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
            if isinstance(msg, AssistantMessage) and m.extra:
                sig = m.extra.get("reasoning_signature")
                if isinstance(sig, str) and sig:
                    msg.reasoning_signature = sig
            if (
                isinstance(msg, ToolMessage)
                and m.extra
                and isinstance(m.extra.get("parts"), list)
            ):
                msg.parts = [
                    _content_block_adapter.validate_python(part)
                    for part in m.extra["parts"]
                ]

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
            if msg.extra.get("kind") == "user_shell":
                msg.content = USER_SHELL_LLM_CONTENT
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
                stripped = msg.model_copy(update={"tool_calls": None})
                if stripped.content:
                    result.append(stripped)
                else:
                    logger.warning(
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
