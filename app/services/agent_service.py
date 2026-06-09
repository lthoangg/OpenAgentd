"""Agent orchestration service — transport-neutral entry points.

Routes and (future) channel adapters hand a message off here. The service
validates attachments against the team lead's capabilities, persists file
bytes to the session uploads directory, initialises the stream store, and
delegates to ``team.handle_user_message``.

This module deliberately knows nothing about HTTP, multipart/form-data, or
FastAPI ``UploadFile`` — inputs are bytes + filename + MIME. That keeps the
channel abstraction clean when adapters land in Phase 3.
"""

from __future__ import annotations

import asyncio
import html
import io
import threading
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING
from uuid import uuid7

from loguru import logger

from app.core.paths import session_uploads_dir
from app.agent.schemas.events import DoneEvent, ErrorEvent
from app.services import memory_stream_store as stream_store
from app.services.shell_service import dispatch_shell_command
from app.services.stream_envelope import StreamEnvelope


def _uploads_dir(session_id: str) -> Path:
    return session_uploads_dir(session_id)


if TYPE_CHECKING:
    from app.agent.mode.team.team import AgentTeam


# ── Attachment-validation rules (transport-neutral) ──────────────────────────

SIZE_LIMITS: dict[str, int] = {
    "text": 500 * 1024,  # 500 KB
    "image": 10 * 1024 * 1024,  # 10 MB
    "document": 5 * 1024 * 1024,  # 5 MB
}
GLOBAL_SIZE_LIMIT = 20 * 1024 * 1024  # 20 MB total across all files per message

MIME_CATEGORY: dict[str, str] = {
    "text/plain": "text",
    "text/csv": "text",
    "text/tab-separated-values": "text",
    "text/markdown": "text",
    "application/json": "text",
    "application/x-ndjson": "text",
    "text/html": "document",
    "application/xhtml+xml": "document",
    "image/jpeg": "image",
    "image/png": "image",
    "image/gif": "image",
    "image/webp": "image",
    "image/bmp": "image",
    "image/tiff": "image",
    "application/pdf": "document",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "document",
}
EXT_CATEGORY: dict[str, str] = {
    ".txt": "text",
    ".csv": "text",
    ".tsv": "text",
    ".md": "text",
    ".markdown": "text",
    ".json": "text",
    ".ndjson": "text",
    ".jsonl": "text",
    ".jpg": "image",
    ".jpeg": "image",
    ".png": "image",
    ".gif": "image",
    ".webp": "image",
    ".bmp": "image",
    ".tif": "image",
    ".tiff": "image",
    ".pdf": "document",
    ".docx": "document",
    ".html": "document",
    ".htm": "document",
}
# First N bytes must match at least one signature for the declared MIME.
MAGIC_BYTES: dict[str, list[tuple[bytes, int]]] = {
    "image/jpeg": [(b"\xff\xd8\xff", 0)],
    "image/png": [(b"\x89PNG\r\n\x1a\n", 0)],
    "image/gif": [(b"GIF87a", 0), (b"GIF89a", 0)],
    "image/webp": [(b"RIFF", 0)],
    "image/bmp": [(b"BM", 0)],
    "application/pdf": [(b"%PDF", 0)],
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [
        (b"PK", 0)
    ],
}
MAX_FILENAME_LEN = 200
MARKITDOWN_TIMEOUT_SECS = 30


# ── Transport-neutral attachment input ───────────────────────────────────────


@dataclass
class RawAttachment:
    """One inbound file, already read into memory.

    Transport adapters (HTTP route, channel adapter) build this from their
    native representation (``UploadFile``, Telegram ``Document``, etc.) and
    hand it to :func:`dispatch_user_message`.

    ``truncate_inline_to`` caps the ``converted_text`` length when set —
    used by implicit attachment surfaces (e.g. ``@mention`` auto-attach)
    to bound prompt growth for large files. Explicit uploads leave this
    ``None`` so the full content reaches the model.
    """

    filename: str
    content_type: str | None
    data: bytes
    truncate_inline_to: int | None = None


class AttachmentError(Exception):
    """Raised when an attachment fails validation.

    ``status`` mirrors the HTTP status the route would return; channel
    adapters translate it to their own error surface.
    """

    def __init__(self, message: str, *, status: int) -> None:
        super().__init__(message)
        self.status = status


class NoTeamConfigured(Exception):
    """Raised when the service is called without a configured team."""


# ── Attachment categorisation + magic-byte validation ────────────────────────


def categorize(filename: str, content_type: str | None) -> str | None:
    mime = (content_type or "").split(";")[0].strip().lower()
    if mime and mime in MIME_CATEGORY:
        return MIME_CATEGORY[mime]
    ext = Path(filename or "").suffix.lower()
    return EXT_CATEGORY.get(ext)


def _validate_magic_bytes(data: bytes, mime: str) -> bool:
    sigs = MAGIC_BYTES.get(mime)
    if not sigs:
        return True
    return any(
        data[offset : offset + len(sig)] == sig
        for sig, offset in sigs
        if len(data) > offset
    )


def _validate_ext_mime_consistency(filename: str, mime: str) -> bool:
    ext = Path(filename).suffix.lower()
    ext_cat = EXT_CATEGORY.get(ext)
    mime_cat = MIME_CATEGORY.get(mime)
    if ext_cat is None or mime_cat is None:
        return True
    return ext_cat == mime_cat


def _default_ext(category: str) -> str:
    return {"text": ".txt", "image": ".jpg", "document": ".pdf"}.get(category, ".bin")


def _convert_with_markitdown(data: bytes, mime: str, filename: str) -> str | None:
    """Convert a document to markdown in a bounded-time thread."""
    result_holder: list[str | None] = [None]
    error_holder: list[Exception | None] = [None]

    def _run() -> None:
        try:
            from markitdown import MarkItDown, StreamInfo

            md = MarkItDown()
            result = md.convert_stream(
                io.BytesIO(data),
                stream_info=StreamInfo(mimetype=mime, filename=filename),
            )
            text = (result.text_content or "").strip()
            result_holder[0] = text if text else None
        except Exception as exc:
            error_holder[0] = exc

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    t.join(timeout=MARKITDOWN_TIMEOUT_SECS)
    if t.is_alive():
        logger.warning("markitdown_timeout filename={} mime={}", filename, mime)
        return None
    if error_holder[0] is not None:
        logger.debug(
            "markitdown_conversion_failed filename={} error={}",
            filename,
            error_holder[0],
        )
        return None
    return result_holder[0]


async def _persist_attachment(
    att: RawAttachment,
    category: str,
    uploads_dir: Path,
    session_id: str,
) -> dict:
    """Validate + save one attachment; return its metadata dict."""
    data = att.data
    if len(data) == 0:
        raise AttachmentError(f"'{att.filename}' is empty (0 bytes).", status=422)
    limit = SIZE_LIMITS[category]
    if len(data) > limit:
        raise AttachmentError(
            f"'{att.filename}' is {len(data) // 1024} KB — "
            f"exceeds the {limit // 1024} KB limit for {category} files.",
            status=413,
        )
    mime = (att.content_type or "").split(";")[0].strip() or "application/octet-stream"
    original_name = att.filename or "upload"
    if len(original_name) > MAX_FILENAME_LEN:
        ext = Path(original_name).suffix
        original_name = original_name[: MAX_FILENAME_LEN - len(ext)] + ext
    safe_original_name = html.escape(original_name)
    if not _validate_magic_bytes(data, mime):
        raise AttachmentError(
            f"'{safe_original_name}' content does not match its declared type '{mime}'.",
            status=422,
        )
    if not _validate_ext_mime_consistency(original_name, mime):
        raise AttachmentError(
            f"'{safe_original_name}' extension does not match its content type '{mime}'.",
            status=422,
        )
    ext_source = original_name.split("#L", 1)[0]
    ext = Path(ext_source).suffix or _default_ext(category)
    filename = f"{uuid.uuid4().hex}{ext}"
    uploads_dir.mkdir(parents=True, exist_ok=True)
    dest = uploads_dir / filename
    await asyncio.to_thread(dest.write_bytes, data)
    logger.debug(
        "upload_saved filename={} category={} size={} mime={}",
        filename,
        category,
        len(data),
        mime,
    )
    meta: dict = {
        "filename": filename,
        # Absolute on-disk path to the saved bytes.  Stored verbatim so
        # rehydration never has to derive it from the message's
        # ``session_id`` — those diverge whenever a user attaches a file
        # to an existing chat (the upload mints its own sid; the message
        # inherits the chat's).  Single source of truth.
        "path": str(dest),
        "workspace_path": str(dest),
        "original_name": safe_original_name,
        "media_type": mime,
        "category": category,
        "url": f"/api/team/{session_id}/uploads/{filename}",
    }
    if category == "text":
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            try:
                text = data.decode("latin-1")
            except Exception:
                meta["converted_text"] = f"[Unable to read file {safe_original_name}.]"
                return meta
        meta["converted_text"] = _maybe_truncate_inline(text, att.truncate_inline_to)
    elif category == "document":
        converted = await asyncio.to_thread(
            _convert_with_markitdown, data, mime, original_name
        )
        body = (
            converted
            if converted is not None
            else f"[Unable to read file {safe_original_name}.]"
        )
        meta["converted_text"] = _maybe_truncate_inline(body, att.truncate_inline_to)
    return meta


def _maybe_truncate_inline(text: str, cap: int | None) -> str:
    """Cap inlined attachment text with a head + tail window.

    Returns ``text`` unchanged when ``cap`` is ``None`` (explicit upload)
    or the body already fits. Otherwise keeps the first ``cap // 2``
    chars and the last ``cap // 2`` chars, separated by a marker line
    that tells the agent how many chars were elided and that the full
    content is still reachable via its ``Read`` tool. Head + tail
    preserves the highest-signal regions of most files — imports /
    declarations at the top, exports / conclusions at the bottom —
    where a head-only cut would discard the ending entirely.
    """
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


# ── Public entry points ──────────────────────────────────────────────────────


def require_team(team: "AgentTeam | None") -> "AgentTeam":
    """Return the team or raise :class:`NoTeamConfigured`."""
    if team is None:
        raise NoTeamConfigured("No agent team configured.")
    return team


async def validate_and_persist_attachments(
    team: "AgentTeam",
    attachments: list[RawAttachment],
    session_id: str | None = None,
) -> tuple[str, list[dict]]:
    """Validate attachments against lead capabilities and save them to disk.

    If ``session_id`` is ``None`` a fresh UUIDv7 is minted; otherwise the
    provided id is used so uploads land under the same workspace as the
    chat session that owns them.

    Returns ``(session_id, attachment_metas)``.

    Raises :class:`AttachmentError` on the first invalid attachment. On that
    error, previously-persisted files in the batch stay on disk; the caller
    is expected to abort the turn, and a future cleanup task can sweep any
    orphaned uploads that never got referenced.
    """
    caps = team.lead.agent.capabilities

    valid: list[tuple[RawAttachment, str]] = []
    total_size = 0
    for att in attachments:
        if not att.filename:
            continue
        category = categorize(att.filename, att.content_type)
        if category is None:
            ext = Path(att.filename).suffix.lower()
            raise AttachmentError(f"Unsupported file type '{ext}'.", status=415)
        if category == "image" and not caps.input.vision:
            raise AttachmentError(
                "This model does not support image inputs.", status=422
            )
        if category == "document" and not caps.input.document_text:
            raise AttachmentError(
                "This model does not support document inputs.", status=422
            )
        total_size += len(att.data)
        if total_size > GLOBAL_SIZE_LIMIT:
            raise AttachmentError(
                "Total upload size exceeds the global limit.", status=413
            )
        valid.append((att, category))

    sid = session_id or str(uuid7())
    session_uploads = _uploads_dir(sid)

    metas: list[dict] = []
    for att, category in valid:
        meta = await _persist_attachment(att, category, session_uploads, sid)
        metas.append(meta)

    return sid, metas


async def dispatch_user_message(
    team: "AgentTeam",
    *,
    content: str,
    session_id: str | None,
    attachments: list[RawAttachment] | None = None,
    mode: str = "normal",
    workspace: str | None = None,
    model: str | None = None,
    model_provided: bool = False,
    thinking_level: str | None = None,
    thinking_level_provided: bool = False,
    service_tier: str | None = None,
) -> tuple[str, int]:
    """Send a user message through the team.

    Handles the full ingress path:

    1. Resolve the session id (use the caller's or mint a fresh UUIDv7).
    2. Validate attachments against the lead's capabilities + size caps.
    3. Persist attachments to the app-managed session uploads directory.
    4. Initialise stream store and deliver to the team.

    Returns ``(session_id, n_attachments)``.

    Raises :class:`AttachmentError` on invalid attachments; callers translate
    ``AttachmentError.status`` to their transport's error shape.
    """
    atts = attachments or []
    sid = session_id or str(uuid7())

    if atts:
        _, metas = await validate_and_persist_attachments(team, atts, sid)
    else:
        metas = []

    await team.handle_user_message(
        content=content,
        session_id=sid,
        interrupt=False,
        attachment_metas=metas if metas else None,
        mode=mode,
        workspace=workspace,
        model=model,
        model_provided=model_provided or model is not None,
        thinking_level=thinking_level,
        thinking_level_provided=thinking_level_provided or thinking_level is not None,
        service_tier=service_tier,
    )
    logger.info(
        "agent_service_dispatched session_id={} attachments={}",
        sid,
        len(metas),
    )
    return sid, len(metas)


async def dispatch_user_shell_command(
    team: "AgentTeam",
    *,
    command: str,
    session_id: str | None,
    mode: str = "normal",
    workspace: str | None = None,
    model: str | None = None,
    model_provided: bool = False,
    thinking_level: str | None = None,
    thinking_level_provided: bool = False,
    service_tier: str | None = None,
) -> str:
    """Run a user-entered shell command in the session workspace."""
    sid = session_id or str(uuid7())
    await stream_store.init_turn(sid)

    async def _run_shell() -> None:
        try:
            await dispatch_shell_command(
                team,
                command=command,
                session_id=sid,
                mode=mode,
                workspace=workspace,
                model=model,
                model_provided=model_provided,
                thinking_level=thinking_level,
                thinking_level_provided=thinking_level_provided,
                service_tier=service_tier,
            )
        except Exception as exc:
            logger.warning(
                "agent_service_shell_failed session_id={} error={}", sid, exc
            )
            await stream_store.push_event(
                sid,
                StreamEnvelope.from_event(ErrorEvent(message=str(exc))),
            )
            await stream_store.push_event(sid, StreamEnvelope.from_event(DoneEvent()))
            await stream_store.mark_done(sid)

    asyncio.create_task(_run_shell(), name=f"user_shell:{sid}")
    logger.info("agent_service_shell_dispatched session_id={}", sid)
    return sid


async def interrupt_team(team: "AgentTeam", session_id: str | None) -> list[str]:
    """Cancel all working team members. Returns the cancelled member names."""
    from app.agent.schemas.chat import HumanMessage
    from app.agent.tools.builtin.todo import release_in_progress_for_actor
    from app.core.db import resolve_db_factory
    from app.core.paths import session_workspace_dir
    from app.services.chat_service import release_queued_user_messages, save_message

    names: list[str] = []
    effective_session_id = session_id or getattr(team.lead, "session_id", None)

    live_members = getattr(team, "members", {})
    if isinstance(live_members, dict):
        for handle, member in list(live_members.items()):
            if member.state != "working":
                continue
            names.append(member.name)
            sid = effective_session_id
            released = (
                release_in_progress_for_actor(
                    session_workspace_dir(sid, team.workspace), member.name, sid
                )
                if sid
                else []
            )
            suffix = (
                f" In-progress todos reset to pending: {', '.join(released)}."
                if released
                else ""
            )
            content = (
                f"[{member.name}]: Stopped before completing assigned work.{suffix}"
            )
            if sid:
                try:
                    db_factory = resolve_db_factory(team.lead.db_factory)
                    async with db_factory() as db:
                        await save_message(
                            db,
                            uuid.UUID(sid),
                            HumanMessage(content=content),
                            extra={"from_agent": member.name, "interrupted": True},
                        )
                        await db.commit()
                except Exception as exc:
                    logger.warning(
                        "team_interrupt_notice_failed member={} error={}",
                        member.name,
                        exc,
                    )
            try:
                await team._emit(
                    agent=team.lead.name,
                    event="inbox",
                    extra={"content": content, "from_agent": member.name},
                )
            except Exception as exc:
                logger.warning(
                    "team_interrupt_notice_emit_failed member={} error={}",
                    member.name,
                    exc,
                )
            member.interrupt()

    dismissed = set(names)
    cancelled = [
        m for m in team.all_members if m.state == "working" and m.name not in dismissed
    ]
    for member in cancelled:
        member.interrupt()
    names.extend(m.name for m in cancelled)
    if effective_session_id:
        try:
            db_factory = resolve_db_factory(team.lead.db_factory)
            async with db_factory() as db:
                released = await release_queued_user_messages(
                    db, uuid.UUID(effective_session_id)
                )
                await db.commit()
            if released:
                logger.info(
                    "team_interrupt_released_queued session_id={} count={}",
                    effective_session_id,
                    len(released),
                )
        except Exception as exc:
            logger.warning(
                "team_interrupt_release_queue_failed session_id={} error={}",
                effective_session_id,
                exc,
            )
        await stream_store.push_event(
            effective_session_id,
            StreamEnvelope.from_parts(event="done", data={}),
        )
        await stream_store.mark_done(effective_session_id)
    logger.info("team_interrupt session_id={} cancelled={}", session_id, names)
    return names
