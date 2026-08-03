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
import re
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


_user_shell_tasks: dict[str, set[asyncio.Task[None]]] = {}


def _uploads_dir(session_id: str, workspace: str | None = None) -> Path:
    return session_uploads_dir(session_id, workspace)


if TYPE_CHECKING:
    from app.agent.mode.team.team import AgentTeam


# ── Attachment-validation rules (transport-neutral) ──────────────────────────

SIZE_LIMITS: dict[str, int] = {
    "text": 500 * 1024,  # 500 KB
    "image": 10 * 1024 * 1024,  # 10 MB
    "document": 5 * 1024 * 1024,  # 5 MB
    "audio": 20 * 1024 * 1024,  # 20 MB
    "video": 20 * 1024 * 1024,  # 20 MB
    # Catch-all for any file type not covered above (zip, exe, bin, …).
    # Saved to disk as-is; the agent can use shell tools to inspect it.
    "file": 20 * 1024 * 1024,  # 20 MB
}
GLOBAL_SIZE_LIMIT = 20 * 1024 * 1024  # 20 MB total across all files per message

MIME_CATEGORY: dict[str, str] = {
    # ── Plain text / data ──────────────────────────────────────────────────
    "text/plain": "text",
    "text/csv": "text",
    "text/tab-separated-values": "text",
    "text/markdown": "text",
    "application/json": "text",
    "application/x-ndjson": "text",
    # ── Source code MIME types sent by browsers / editors ──────────────────
    "text/javascript": "text",
    "application/javascript": "text",
    "text/typescript": "text",
    "application/typescript": "text",
    "text/x-python": "text",
    "text/x-python-script": "text",
    "text/x-go": "text",
    "text/x-rustsrc": "text",
    "text/x-ruby": "text",
    "text/x-java-source": "text",
    "text/x-csrc": "text",
    "text/x-c++src": "text",
    "text/x-chdr": "text",
    "text/x-csharp": "text",
    "text/x-sh": "text",
    "application/x-sh": "text",
    "text/x-shellscript": "text",
    "application/x-shellscript": "text",
    "application/x-yaml": "text",
    "text/yaml": "text",
    "text/x-yaml": "text",
    "application/toml": "text",
    "text/x-toml": "text",
    "application/xml": "text",
    "text/xml": "text",
    "text/css": "text",
    "text/x-sql": "text",
    "application/x-sql": "text",
    "text/x-rsrc": "text",
    "text/x-scala": "text",
    "text/x-swift": "text",
    "text/x-kotlin": "text",
    "text/x-php": "text",
    "application/x-httpd-php": "text",
    "image/svg+xml": "text",
    # ── Document MIME types ────────────────────────────────────────────────
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
    "audio/mpeg": "audio",
    "audio/mp4": "audio",
    "audio/wav": "audio",
    "audio/webm": "audio",
    "audio/ogg": "audio",
    "audio/flac": "audio",
    "video/mp4": "video",
    "video/webm": "video",
    "video/ogg": "video",
    "video/quicktime": "video",
}
EXT_CATEGORY: dict[str, str] = {
    # ── Plain text / data ──────────────────────────────────────────────────
    ".txt": "text",
    ".csv": "text",
    ".tsv": "text",
    ".md": "text",
    ".markdown": "text",
    ".json": "text",
    ".ndjson": "text",
    ".jsonl": "text",
    # ── Source code ────────────────────────────────────────────────────────
    ".py": "text",
    ".pyi": "text",
    ".js": "text",
    ".mjs": "text",
    ".cjs": "text",
    ".jsx": "text",
    ".ts": "text",
    ".tsx": "text",
    ".go": "text",
    ".rs": "text",
    ".rb": "text",
    ".java": "text",
    ".kt": "text",
    ".kts": "text",
    ".swift": "text",
    ".c": "text",
    ".cpp": "text",
    ".cc": "text",
    ".cxx": "text",
    ".h": "text",
    ".hpp": "text",
    ".cs": "text",
    ".php": "text",
    ".sh": "text",
    ".bash": "text",
    ".zsh": "text",
    ".fish": "text",
    ".ps1": "text",
    ".sql": "text",
    ".graphql": "text",
    ".gql": "text",
    ".proto": "text",
    ".tf": "text",
    ".tfvars": "text",
    ".scala": "text",
    ".clj": "text",
    ".ex": "text",
    ".exs": "text",
    ".lua": "text",
    ".r": "text",
    ".R": "text",
    ".jl": "text",
    ".dart": "text",
    ".vim": "text",
    # ── Config / markup ────────────────────────────────────────────────────
    ".yaml": "text",
    ".yml": "text",
    ".toml": "text",
    ".ini": "text",
    ".cfg": "text",
    ".conf": "text",
    ".env": "text",
    ".xml": "text",
    ".svg": "text",
    ".css": "text",
    ".scss": "text",
    ".sass": "text",
    ".less": "text",
    ".mdx": "text",
    ".rst": "text",
    ".tex": "text",
    ".log": "text",
    ".diff": "text",
    ".patch": "text",
    # ── Images ────────────────────────────────────────────────────────────
    ".jpg": "image",
    ".jpeg": "image",
    ".png": "image",
    ".gif": "image",
    ".webp": "image",
    ".bmp": "image",
    ".tif": "image",
    ".tiff": "image",
    # ── Documents ─────────────────────────────────────────────────────────
    ".pdf": "document",
    ".docx": "document",
    ".html": "document",
    ".htm": "document",
    # ── Audio ─────────────────────────────────────────────────────────────
    ".mp3": "audio",
    ".m4a": "audio",
    ".wav": "audio",
    ".ogg": "audio",
    ".flac": "audio",
    # ── Video ─────────────────────────────────────────────────────────────
    ".mp4": "video",
    ".webm": "video",
    ".mov": "video",
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
_FILENAME_STEM_MAX_LEN = 160
_FILENAME_RE = re.compile(r"[\x00-\x1f\x7f/\\]+")


def _sanitize_upload_filename(raw_name: str, category: str) -> str:
    """Return a filesystem-safe upload filename preserving the extension.

    - strips path components
    - removes control chars and path separators
    - trims surrounding whitespace/dots
    - preserves extension when possible
    - falls back to ``upload.<ext>`` when the name becomes empty
    """
    leaf = Path(raw_name or "upload").name
    cleaned = _FILENAME_RE.sub("_", leaf).strip().strip(".")
    if not cleaned:
        cleaned = f"upload{_default_ext(category)}"

    ext_source = cleaned.split("#L", 1)[0]
    ext = Path(ext_source).suffix or _default_ext(category)
    stem = Path(ext_source).stem or "upload"
    stem = stem[:_FILENAME_STEM_MAX_LEN].rstrip()
    if not stem:
        stem = "upload"

    candidate = f"{stem}{ext}"
    if len(candidate) <= MAX_FILENAME_LEN:
        return candidate

    allowed_stem = max(1, MAX_FILENAME_LEN - len(ext))
    return f"{stem[:allowed_stem].rstrip()}{ext}"


def _dedupe_upload_filename(uploads_dir: Path, filename: str) -> str:
    """Return ``filename`` or the first available ``name (n).ext`` variant."""
    candidate = filename
    stem = Path(filename).stem or "upload"
    ext = Path(filename).suffix
    index = 1
    while (uploads_dir / candidate).exists():
        suffix = f" ({index})"
        allowed_stem = max(1, MAX_FILENAME_LEN - len(ext) - len(suffix))
        trimmed_stem = stem[:allowed_stem].rstrip() or "upload"
        candidate = f"{trimmed_stem}{suffix}{ext}"
        index += 1
    return candidate


# ── Transport-neutral attachment input ───────────────────────────────────────


@dataclass
class RawAttachment:
    """One inbound file, already read into memory.

    Transport adapters (HTTP route, channel adapter) build this from their
    native representation (``UploadFile``, Telegram ``Document``, etc.) and
    hand it to :func:`dispatch_user_message`.

    ``truncate_inline_to`` caps inline text length for ``@mention`` auto-attach
    — bounds prompt growth for large workspace files. Explicit uploads leave
    this ``None`` (unused by the upload path; mention helpers read it).
    """

    filename: str
    content_type: str | None
    data: bytes
    truncate_inline_to: int | None = None
    source: str | None = None


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
    return {
        "text": ".txt",
        "image": ".jpg",
        "document": ".pdf",
        "audio": ".mp3",
        "video": ".mp4",
        "file": ".bin",
    }.get(category, ".bin")


async def _persist_attachment(
    att: RawAttachment,
    category: str,
    uploads_dir: Path,
    session_id: str,
) -> dict:
    """Validate and save one attachment to disk.

    Returns the UI-facing metadata dict stored in ``extra.attachments``.
    The agent receives a path hint at dispatch time and uses its Read /
    shell tools to inspect the file — no inlining, no conversion here.
    """
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
    safe_storage_name = _sanitize_upload_filename(original_name, category)
    safe_original_name = html.escape(safe_storage_name)
    if not _validate_magic_bytes(data, mime):
        raise AttachmentError(
            f"'{safe_original_name}' content does not match its declared type '{mime}'.",
            status=422,
        )
    if not _validate_ext_mime_consistency(safe_storage_name, mime):
        raise AttachmentError(
            f"'{safe_original_name}' extension does not match its content type '{mime}'.",
            status=422,
        )
    uploads_dir.mkdir(parents=True, exist_ok=True)
    filename = _dedupe_upload_filename(uploads_dir, safe_storage_name)
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
        "path": str(dest),
        "workspace_path": str(dest),
        "original_name": safe_original_name,
        "media_type": mime,
        "category": category,
        "url": f"/api/team/{session_id}/uploads/{filename}",
    }
    if att.source:
        meta["source"] = att.source
    return meta


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
    workspace: str | None = None,
) -> tuple[str, list[dict]]:
    """Validate attachments and save them to disk.

    If ``session_id`` is ``None`` a fresh UUIDv7 is minted; otherwise the
    provided id is used so uploads land under the same workspace as the
    chat session that owns them.

    Returns ``(session_id, attachment_metas)`` where ``attachment_metas``
    are the UI-facing dicts stored in ``extra.attachments``.  The agent
    receives a path hint at dispatch time and uses its Read / shell tools
    to inspect each file — no inlining or pre-conversion happens here.

    Raises :class:`AttachmentError` on the first invalid attachment.
    """
    valid: list[tuple[RawAttachment, str]] = []
    total_size = 0
    for att in attachments:
        if not att.filename:
            continue
        category = categorize(att.filename, att.content_type) or "file"
        total_size += len(att.data)
        if total_size > GLOBAL_SIZE_LIMIT:
            raise AttachmentError(
                "Total upload size exceeds the global limit.", status=413
            )
        valid.append((att, category))

    sid = session_id or str(uuid7())
    session_uploads = _uploads_dir(sid, workspace)

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
    mention_context_blocks: list[str] | None = None,
    mode: str = "normal",
    workspace: str | None = None,
    model: str | None = None,
    model_provided: bool = False,
    thinking_level: str | None = None,
    thinking_level_provided: bool = False,
    service_tier: str | None = None,
    mentions: list[str] | None = None,
) -> tuple[str, int, str]:
    """Send a user message through the team.

    Handles the full ingress path:

    1. Resolve the session id (use the caller's or mint a fresh UUIDv7).
    2. Validate attachments against the lead's capabilities + size caps.
    3. Persist attachments to the app-managed session uploads directory.
    4. Initialise stream store and deliver to the team.

    Returns ``(session_id, n_attachments, message_id)`` — ``message_id`` is
    the persisted user message's id, surfaced so the caller's HTTP response
    can hand it back to the frontend for its optimistic bubble.

    Raises :class:`AttachmentError` on invalid attachments; callers translate
    ``AttachmentError.status`` to their transport's error shape.
    """
    atts = attachments or []
    sid = session_id or str(uuid7())

    if atts:
        _, metas = await validate_and_persist_attachments(team, atts, sid, workspace)
    else:
        metas = []

    _, message_id = await team.handle_user_message(
        content=content,
        session_id=sid,
        interrupt=False,
        attachment_metas=metas or None,
        mention_context_blocks=mention_context_blocks
        if mention_context_blocks
        else None,
        mode=mode,
        workspace=workspace,
        model=model,
        model_provided=model_provided or model is not None,
        thinking_level=thinking_level,
        thinking_level_provided=thinking_level_provided or thinking_level is not None,
        service_tier=service_tier,
        mentions=mentions,
    )
    logger.info(
        "agent_service_dispatched session_id={} attachments={}",
        sid,
        len(metas),
    )
    return sid, len(metas), message_id


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
            try:
                from app.services import event_broadcaster

                await event_broadcaster.publish(
                    "session_turn_completed",
                    {
                        "session_id": sid,
                        "status": "completed",
                    },
                )
            except Exception as publish_exc:
                logger.warning(
                    "agent_service_shell_publish_failed error={}", publish_exc
                )

    task = asyncio.create_task(_run_shell(), name=f"user_shell:{sid}")
    session_tasks = _user_shell_tasks.setdefault(sid, set())
    session_tasks.add(task)

    def _discard_finished_shell(finished: asyncio.Task[None]) -> None:
        tasks = _user_shell_tasks.get(sid)
        if tasks is None:
            return
        tasks.discard(finished)
        if not tasks:
            _user_shell_tasks.pop(sid, None)

    task.add_done_callback(_discard_finished_shell)
    logger.info("agent_service_shell_dispatched session_id={}", sid)
    return sid


async def interrupt_team(team: "AgentTeam", session_id: str | None) -> list[str]:
    """Cancel all working team members. Returns the cancelled member names."""
    from app.agent.schemas.chat import HumanMessage
    from app.agent.tools.builtin.shell import stop_background_processes_for_session
    from app.agent.tools.builtin.todo import release_in_progress_for_actor
    from app.core.db import resolve_db_factory
    from app.core.paths import session_workspace_dir
    from app.services.chat_service import release_queued_user_messages, save_message

    effective_session_id = session_id or getattr(team.lead, "session_id", None)
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

    working_members = [m for m in team.all_members if m.state == "working"]
    working_ids = {id(member) for member in working_members}
    names = [member.name for member in working_members]
    active_tasks = [
        task
        for member in working_members
        if (task := getattr(member, "_active_task", None)) is not None
        and not task.done()
    ]

    direct_shell_tasks = (
        list(_user_shell_tasks.pop(effective_session_id, ()))
        if effective_session_id
        else []
    )

    # Issue every cancellation before waiting for cleanup, so one slow task
    # cannot delay cancellation of the others.
    for member in working_members:
        member.interrupt()
    for task in direct_shell_tasks:
        task.cancel()
    background_cleanup = (
        asyncio.create_task(stop_background_processes_for_session(effective_session_id))
        if effective_session_id
        else None
    )
    cleanup_tasks = [*active_tasks, *direct_shell_tasks]
    if background_cleanup is not None:
        cleanup_tasks.append(background_cleanup)
    if cleanup_tasks:
        await asyncio.gather(*cleanup_tasks, return_exceptions=True)

    if direct_shell_tasks:
        logger.info(
            "team_interrupt_user_shells session_id={} cancelled={}",
            effective_session_id,
            len(direct_shell_tasks),
        )
    if background_cleanup is not None:
        try:
            stopped_background = background_cleanup.result()
        except Exception as exc:
            logger.warning(
                "team_interrupt_background_shells_failed session_id={} error={}",
                effective_session_id,
                exc,
            )
        else:
            if stopped_background:
                logger.info(
                    "team_interrupt_background_shells session_id={} stopped={}",
                    effective_session_id,
                    stopped_background,
                )

    live_members = getattr(team, "members", {})
    if isinstance(live_members, dict):
        for handle, member in list(live_members.items()):
            if id(member) not in working_ids:
                continue
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
    if effective_session_id:
        await stream_store.push_event(
            effective_session_id,
            StreamEnvelope.from_parts(event="done", data={}),
        )
        await stream_store.mark_done(effective_session_id)
        try:
            from app.services import event_broadcaster

            await event_broadcaster.publish(
                "session_turn_completed",
                {
                    "session_id": effective_session_id,
                    "status": "stopped",
                },
            )
        except Exception as exc:
            logger.warning("team_interrupt_publish_failed error={}", exc)
    logger.info("team_interrupt session_id={} cancelled={}", session_id, names)
    return names
