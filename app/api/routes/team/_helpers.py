"""Shared helpers for the /team route package.

File upload and team-dispatch logic live in ``app.services.agent_service``
(transport-neutral, shared with future channel adapters).  The route
modules only handle HTTP concerns.
"""

from __future__ import annotations

import mimetypes
import re
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID
from uuid import uuid7

from fastapi import HTTPException, UploadFile
from loguru import logger
from sqlmodel.ext.asyncio.session import AsyncSession

from app.agent.mode.team.team import AgentTeam
from app.agent.schemas.chat import HumanMessage
from app.api.schemas.sessions import MessageResponse
from app.core.paths import session_workspace_dir
from app.models.chat import ChatSession
from app.services import agent_service, team_manager
from app.services.agent_service import (
    GLOBAL_SIZE_LIMIT,
    MENTION_MAX_BYTES,
    NoTeamConfigured,
    RawAttachment,
    categorize,
)


# Server-internal attachment fields that must never leak to clients:
# - ``path`` / ``workspace_path``: absolute on-disk paths; clients fetch
#   bytes via ``GET /api/team/{sid}/uploads/{filename}`` instead.
_INTERNAL_ATTACHMENT_FIELDS = frozenset({"converted_text", "path", "workspace_path"})


def _message_response(m) -> MessageResponse:
    resp = MessageResponse.model_validate(m)
    if m.extra and m.extra.get("is_continuation"):
        resp.reasoning_content = None
    if m.extra and isinstance(m.extra.get("attachments"), list):
        public_attachments = [
            {k: v for k, v in att.items() if k not in _INTERNAL_ATTACHMENT_FIELDS}
            for att in m.extra["attachments"]
        ]
        resp.attachments = public_attachments
        resp.extra = {**m.extra, "attachments": public_attachments}
        resp.file_message = True
    return resp


def _require_team(team: AgentTeam | None) -> AgentTeam:
    try:
        return agent_service.require_team(team)
    except NoTeamConfigured as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


def _validate_workspace_or_422(workspace: str) -> str:
    """Route ``workspace`` through the single validation authority.

    ``team_manager.validate_workspace`` is the sole authority for workspace
    path validation (see repo AGENTS.md) — this wrapper only translates its
    ``ValueError`` into the route-facing 422. Do not add a parallel
    ``Path(workspace).resolve()`` anywhere else.
    """
    try:
        return team_manager.validate_workspace(workspace)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


async def validate_model_settings(
    model: str | None,
    thinking_level: str | None,
    *,
    is_registered_model_id,
) -> tuple[str | None, str | None]:
    """Strip whitespace from model/thinking_level and validate the model id.

    Shared by ``POST /chat`` and ``POST /sessions/resolve`` — both accept an
    optional per-request model override and must reject unregistered models
    the same way. Returns the stripped ``(model, thinking_level)`` pair.

    ``is_registered_model_id`` is injected (rather than imported here) so
    callers' own module-level reference — and any test patch of it — is
    honoured; see ``app.api.routes.team.chat.is_registered_model_id``.
    """
    stripped_model = model.strip() if model else None
    stripped_thinking_level = thinking_level.strip() if thinking_level else None
    if stripped_model and not await is_registered_model_id(stripped_model):
        raise HTTPException(status_code=422, detail="Choose a model from the registry.")
    return stripped_model, stripped_thinking_level


@dataclass
class ResolvedChatTeam:
    """Result of resolving a ``POST /chat`` request to a team + session.

    ``mode`` and ``workspace`` may differ from the request body — an
    existing coding session's persisted workspace always wins (see
    ``resolve_chat_team``).
    """

    team: AgentTeam
    session_id: str
    session_uuid: UUID | None
    mode: str
    workspace: str | None


async def resolve_chat_team(
    db: AsyncSession,
    *,
    session_id: str | None,
    mode: str,
    workspace: str | None,
) -> ResolvedChatTeam:
    """Resolve the session id, reconcile mode/workspace, and start/attach a team.

    Mirrors the exact branching of the former inline ``team_chat`` body:

    1. If ``session_id`` is given, parse it and look up the persisted
       ``ChatSession`` row.
    2. An existing **coding** session's persisted workspace is always
       authoritative — a mismatched ``workspace`` in the request is a 409,
       never silently overridden (security-relevant: prevents a session id
       from being replayed against a different workspace).
    3. Otherwise, mint a session id if omitted and start/attach the coding
       or normal-mode team per the request's ``mode``.

    Raises :class:`HTTPException` (422 invalid session id / workspace,
    404 no team configured, 409 workspace mismatch) exactly as the inline
    code did.
    """
    existing: ChatSession | None = None
    session_uuid: UUID | None = None

    if session_id:
        try:
            session_uuid = UUID(session_id)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="Invalid session id.") from exc
        async with db.begin():
            existing = await db.get(ChatSession, session_uuid)

    if existing and existing.mode == "coding" and existing.workspace:
        persisted_workspace = _validate_workspace_or_422(existing.workspace)
        if mode == "coding" and workspace is not None:
            requested_workspace = _validate_workspace_or_422(workspace)
            if requested_workspace != persisted_workspace:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "Session belongs to a different coding workspace: "
                        f"{persisted_workspace}"
                    ),
                )
        mode = "coding"
        workspace = persisted_workspace
        assert session_id is not None
        try:
            team_obj = await team_manager.get_or_start_coding_team(
                workspace, session_id
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    elif mode == "coding":
        if session_id is None:
            session_id = str(uuid7())
        assert workspace is not None
        workspace = _validate_workspace_or_422(workspace)
        try:
            team_obj = await team_manager.get_or_start_coding_team(
                workspace, session_id
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    else:
        if session_id is None:
            session_id = str(uuid7())
        team_obj = await team_manager.get_or_start_team_for_session(session_id)
        team_obj = _require_team(team_obj)

    return ResolvedChatTeam(
        team=team_obj,
        session_id=session_id,
        session_uuid=session_uuid,
        mode=mode,
        workspace=workspace,
    )


@dataclass
class QueuedMessageResult:
    """Result of persisting a user message onto the queue.

    Returned by :func:`persist_queued_user_message` when the team lead has
    an active turn — the caller (route) turns this straight into the
    ``status="queued"`` response.
    """

    message_id: str
    attachment_count: int


async def persist_queued_user_message(
    db: AsyncSession,
    *,
    team: AgentTeam,
    session_id: str,
    session_uuid: UUID,
    workspace: str | None,
    message: str,
    attachments: list[RawAttachment],
    mention_context_blocks: list[str],
    mentions: list[str] | None,
    model: str | None,
    model_provided: bool,
    thinking_level: str | None,
    thinking_level_provided: bool,
    fast_mode_service_tier: str | None,
    save_queued_user_message,
    save_message,
) -> QueuedMessageResult:
    """Persist a user message + its attachments/mentions onto the queue.

    Used by ``POST /team/chat`` when the team lead already has an active
    turn — the message is written as a hidden ``queue_status=queued`` row
    instead of being dispatched immediately, and released once the lead
    goes idle. Byte-for-byte move of the former inline ``team_chat`` queue
    branch — no behavior change.

    ``save_queued_user_message`` / ``save_message`` are injected (not
    imported here) so existing test patches of
    ``app.api.routes.team.chat.save_queued_user_message`` /
    ``.save_message`` keep working.

    Raises :class:`HTTPException` (translated from ``AttachmentError``) if
    an explicit upload fails validation.
    """
    # Persist all attachments (explicit uploads + @mentions) now so
    # the queued row carries the same context the user composed.
    # Capability checks run at queue time against the current model;
    # the model may change before dequeue but that is an accepted
    # edge case (documented in the queue design notes).
    queued_attachment_metas: list[dict] = []
    if attachments:
        try:
            (
                _,
                queued_attachment_metas,
            ) = await agent_service.validate_and_persist_attachments(
                team, attachments, session_id, workspace
            )
        except agent_service.AttachmentError as exc:
            raise HTTPException(status_code=exc.status, detail=str(exc)) from exc

    async with db.begin():
        queued_extra: dict[str, object] = {}
        effective_model = model or team.lead.agent.model_id
        if effective_model:
            queued_extra["model"] = effective_model
        if thinking_level:
            queued_extra["thinking_level"] = thinking_level
        if fast_mode_service_tier:
            queued_extra["service_tier"] = "fast"
        if queued_attachment_metas:
            queued_extra["attachments"] = queued_attachment_metas
        if mentions:
            queued_extra["mentions"] = mentions
        existing_row = await db.get(ChatSession, session_uuid)
        if existing_row is not None:
            if model_provided:
                existing_row.model = model
            if thinking_level_provided:
                existing_row.thinking_level = thinking_level
            effective_model = existing_row.model or team.lead.agent.model_id
            if effective_model:
                queued_extra["model"] = effective_model
            if existing_row.thinking_level:
                queued_extra["thinking_level"] = existing_row.thinking_level
            if fast_mode_service_tier:
                queued_extra["service_tier"] = "fast"
            db.add(existing_row)
        queued = await save_queued_user_message(
            db,
            session_uuid,
            message,
            extra=queued_extra,
        )
        # Write synthetic mention context rows (ephemeral, no uploads/).
        for synthetic_content in mention_context_blocks:
            await save_message(
                db,
                session_uuid,
                HumanMessage(content=synthetic_content),
                extra={
                    "hidden_from_user": True,
                    "hidden_from_summary": True,
                    "attachment_for_message_id": str(queued.id),
                    "mention_context": True,
                },
            )

    logger.info(
        "team_chat_queued session_id={} message_id={} attachments={}",
        session_id,
        queued.id,
        len(queued_attachment_metas),
    )
    return QueuedMessageResult(
        message_id=str(queued.id), attachment_count=len(queued_attachment_metas)
    )


async def _read_upload_as_attachment(file: UploadFile) -> RawAttachment | None:
    """Materialise an ``UploadFile`` into a transport-neutral ``RawAttachment``.

    Returns ``None`` for files with no filename (skipped, matches prior
    behaviour).
    """
    if not file.filename:
        return None
    data = await file.read()
    return RawAttachment(
        filename=file.filename,
        content_type=file.content_type,
        data=data,
    )


# ── @-mention context helpers ────────────────────────────────────────────────
#
# Tokens are resolved against the session workspace (normal session
# sandbox, or the coding workspace root if `workspace` is provided).
# File mentions can be turned into hidden inline context blocks; folder
# mentions can be turned into hidden directory-listing context blocks.
# Neither path is treated as an uploaded attachment or persisted into
# ``uploads/``.

# Per-message ceiling on mention-derived context blocks. Defensive — a user
# pasting a wall of `@paths` shouldn't trigger an unbounded read storm.
_MAX_MENTION_ATTACHMENTS = 20

# Cap on inlined text per mention attachment. Mentions are implicit
# context — a 500 KB file shouldn't blow up the prompt on every history
# rehydration. The agent gets the head of the file (enough for a quick
# reference) plus a marker telling it the full content is still reachable
# via its ``Read`` tool. 32 K chars ≈ 8 K tokens ≈ 10 PDF pages.
_MENTION_INLINE_MAX_CHARS = 32_000
_LINE_REF_RE = re.compile(r"^(?P<path>.+)#L(?P<start>\d+)(?:-L?(?P<end>\d+))?$")


def _safe_join(root: Path, rel: str) -> Path | None:
    """Resolve ``rel`` under ``root``; ``None`` if it escapes or is bad.

    Files only — directory paths return ``None`` so the caller's loop
    silently skips them. Mirrors ``app.api.routes.team.files._safe_resolve``
    semantics but returns ``None`` on every failure (no exceptions).
    """
    if not rel:
        return None
    candidate = Path(rel)
    if candidate.is_absolute() or (len(rel) >= 2 and rel[1] == ":"):
        return None
    try:
        resolved = (root / candidate).resolve(strict=False)
        root_resolved = root.resolve(strict=False)
    except (OSError, RuntimeError):
        return None
    try:
        resolved.relative_to(root_resolved)
    except ValueError:
        return None
    if not resolved.exists() or not resolved.is_file():
        return None
    return resolved


def _parse_line_ref(rel_path: str) -> tuple[str, str, int | None, int | None]:
    """Split an optional ``#Lx-Ly`` suffix from a mention path."""
    match = _LINE_REF_RE.match(rel_path)
    if match is None:
        return rel_path, rel_path, None, None
    path = match.group("path")
    start = int(match.group("start"))
    end = int(match.group("end") or start)
    if start < 1 or end < start:
        return rel_path, rel_path, None, None
    label = f"{path}#L{start}" if start == end else f"{path}#L{start}-L{end}"
    return path, label, start, end


def _slice_lines(data: bytes, start: int | None, end: int | None) -> bytes:
    if start is None or end is None:
        return data
    text = data.decode("utf-8")
    lines = text.splitlines(keepends=True)
    if start > len(lines):
        return b""
    return "".join(lines[start - 1 : end]).encode("utf-8")


def _is_likely_binary(data: bytes) -> bool:
    """Return True when ``data`` looks like a binary file, not readable text.

    Null bytes are the primary signal — they never appear in UTF-8 text and
    are common in images, executables, and compiled assets. A secondary check
    on control-character density handles non-null binary formats.
    """
    if b"\x00" in data:
        return True
    sample = data[:8192]
    if not sample:
        return False
    # ASCII control chars below 0x20, excluding TAB (9), LF (10), CR (13)
    control = sum(1 for b in sample if b < 32 and b not in (9, 10, 13))
    return control / len(sample) > 0.30


async def _read_mention_as_attachment(
    rel_path: str,
    abs_path: Path,
    *,
    line_start: int | None = None,
    line_end: int | None = None,
) -> RawAttachment | None:
    """Read one mentioned file as a ``RawAttachment``.

    Only text categories are inlined. Images and documents are skipped —
    they are file references, and the agent's ``Read`` tool can fetch/convert
    them on demand. Auto-attaching non-text mentions would force conversion or
    base64 payloads into context even when the agent never needs them.

    Returns ``None`` (and logs at debug level) when the file fails any of the
    soft constraints — non-text category, unsupported type, oversize. Hard
    read failures (``OSError``) also return ``None``. Mentions are an implicit
    context surface; we never surface a 4xx to the user for a bad mention.
    """
    filename = rel_path
    mime, _ = mimetypes.guess_type(str(abs_path))
    category = categorize(filename, mime)

    # ``categorize`` only knows about a small set of registered upload types.
    # For mentions, any file the agent can read as text is fair game — code
    # files (.ts, .py, .go, .css, .yaml, …) are the primary use-case and
    # none of them are in the upload category map. Treat an unknown category
    # as "text" and let the decode step below filter out true binary files.
    if category is None:
        category = "text"
        mime = mime or "text/plain"

    if category != "text":
        # Non-text mentions (images, documents) are reference-only — the
        # agent uses the ``read`` tool to convert/view them on demand.
        return None

    try:
        data = await _read_bytes(abs_path)
    except OSError as exc:
        logger.debug("mention_read_failed path={} error={}", rel_path, exc)
        return None

    # Reject binary files. Null bytes are a reliable signal — they never
    # appear in UTF-8 text and indicate binary content (images, executables,
    # compiled assets). Fall back to a control-character density check for
    # non-null binary formats.
    if _is_likely_binary(data):
        logger.debug("mention_binary_skip path={}", rel_path)
        return None

    if line_start is not None:
        try:
            data = _slice_lines(data, line_start, line_end)
        except UnicodeDecodeError:
            return None
    if not data:
        return None
    if len(data) > MENTION_MAX_BYTES:
        logger.debug(
            "mention_oversize path={} size={}",
            rel_path,
            len(data),
        )
        return None
    return RawAttachment(
        filename=filename,
        content_type=mime,
        data=data,
        truncate_inline_to=_MENTION_INLINE_MAX_CHARS,
        source="mention",
    )


async def _read_bytes(path: Path) -> bytes:
    """Off-thread file read so we don't block the event loop."""
    import asyncio

    return await asyncio.to_thread(path.read_bytes)


def _maybe_truncate_inline(text: str, cap: int | None) -> str:
    """Head + tail truncation for large mention-inlined files."""
    if cap is None or len(text) <= cap:
        return text
    half = cap // 2
    head = text[:half]
    tail = text[-half:]
    omitted = len(text) - len(head) - len(tail)
    return (
        f"{head}\n\n"
        f"... [Middle truncated — {omitted:,} chars elided. "
        f"Use the Read tool for full content.] ...\n\n"
        f"{tail}"
    )


def _build_mention_text_block(att: RawAttachment, label: str) -> str:
    """Inline a text mention as a fenced block for the LLM context."""
    try:
        text = att.data.decode("utf-8")
    except UnicodeDecodeError:
        try:
            text = att.data.decode("latin-1")
        except Exception:
            return f"[Unable to read file {label}.]"
    body = _maybe_truncate_inline(text, att.truncate_inline_to)
    if "#L" in label:
        return (
            f"[File: {label} — selected lines already loaded; "
            f"use this block directly instead of reading the same range]\n"
            f"{body}\n"
            f"[End file: {label}]"
        )
    return f"[File: {label}]\n{body}\n[End file: {label}]"


async def build_mention_context_blocks(
    *,
    message: str,
    team: AgentTeam,
    session_id: str,
    workspace: str | None,
    existing_total_bytes: int,
    mentions: list[str] | None = None,
) -> list[str]:
    """Return hidden inline context blocks for ``@file`` / ``@folder/`` mentions.

    File mentions inline their text content as fenced ``[File: …]`` blocks
    without writing anything into ``uploads/`` or ``extra.attachments``.
    Folder mentions inject a lightweight directory listing so the model can
    see the subtree shape without pre-running tools.
    """
    if not mentions:
        return []

    root = session_workspace_dir(session_id, workspace)
    raw_paths = []
    seen: set[str] = set()
    for path in mentions:
        if not path or path in seen:
            continue
        seen.add(path)
        raw_paths.append(path)
        if len(raw_paths) >= _MAX_MENTION_ATTACHMENTS:
            break

    out: list[str] = []
    running_total = existing_total_bytes
    for rel in raw_paths:
        # Safety check: ensure the mention is still present in the text as @path or @path/
        if f"@{rel}" not in message and f"@{rel}/" not in message:
            continue

        if rel.endswith("/"):
            abs_dir = _safe_join_dir(root, rel[:-1])
            if abs_dir is None:
                continue
            block = _build_directory_listing_block(rel, abs_dir)
            running_total += len(block.encode("utf-8"))
            if running_total > GLOBAL_SIZE_LIMIT:
                break
            out.append(block)
            continue

        file_rel, label, line_start, line_end = _parse_line_ref(rel)
        abs_path = _safe_join(root, file_rel)
        if abs_path is None:
            # Path didn't resolve as a file. Check if it's a directory —
            # insertMention stores the path without a trailing slash in
            # ``mentions`` even for directories (only the textarea text
            # gets ``@path/``). Fall back to a directory listing.
            abs_dir = _safe_join_dir(root, file_rel)
            if abs_dir is not None:
                dir_label = file_rel + "/"
                block = _build_directory_listing_block(dir_label, abs_dir)
                running_total += len(block.encode("utf-8"))
                if running_total > GLOBAL_SIZE_LIMIT:
                    break
                out.append(block)
            continue
        att = await _read_mention_as_attachment(
            label,
            abs_path,
            line_start=line_start,
            line_end=line_end,
        )
        if att is None:
            # File exists but is non-text (image, document). Inject a short
            # hint so the model knows the user referenced this file and can
            # call the ``read`` tool to inspect it rather than silently
            # ignoring the mention.
            mime, _ = mimetypes.guess_type(str(abs_path))
            category = categorize(file_rel, mime)
            if category in ("image", "document"):
                kind = "image" if category == "image" else "document"
                block = (
                    f"[Mentioned {kind}: {label} — use the read tool to view this file]"
                )
                running_total += len(block.encode("utf-8"))
                if running_total > GLOBAL_SIZE_LIMIT:
                    break
                out.append(block)
            continue
        synthetic = _build_mention_text_block(att, label)
        running_total += len(att.data)
        if running_total > GLOBAL_SIZE_LIMIT:
            break
        out.append(synthetic)
    return out


def _safe_join_dir(root: Path, rel: str) -> Path | None:
    if not rel:
        return None
    candidate = Path(rel)
    if candidate.is_absolute() or (len(rel) >= 2 and rel[1] == ":"):
        return None
    try:
        resolved = (root / candidate).resolve(strict=False)
        root_resolved = root.resolve(strict=False)
    except (OSError, RuntimeError):
        return None
    try:
        resolved.relative_to(root_resolved)
    except ValueError:
        return None
    if not resolved.exists() or not resolved.is_dir():
        return None
    return resolved


def _build_directory_listing_block(rel: str, abs_dir: Path) -> str:
    entries: list[str] = []
    try:
        children = sorted(abs_dir.iterdir(), key=lambda p: (not p.is_dir(), p.name))
    except OSError:
        return (
            f"[Directory: {rel}]\n[Unable to list directory.]\n[End directory: {rel}]"
        )
    for child in children[:50]:
        suffix = "/" if child.is_dir() else ""
        entries.append(f"- {child.name}{suffix}")
    if len(children) > 50:
        entries.append(f"... ({len(children) - 50} more entries)")
    body = "\n".join(entries) if entries else "[Empty directory]"
    return f"[Directory: {rel}]\n{body}\n[End directory: {rel}]"
