"""Shared helpers for the /team route package.

File upload and team-dispatch logic live in ``app.services.agent_service``
(transport-neutral, shared with future channel adapters).  The route
modules only handle HTTP concerns.
"""

from __future__ import annotations

import mimetypes
import re
from pathlib import Path

from fastapi import HTTPException, UploadFile
from loguru import logger

from app.agent.mode.team.team import AgentTeam
from app.api.schemas.sessions import MessageResponse
from app.core.paths import session_workspace_dir
from app.services import agent_service
from app.services.agent_service import (
    GLOBAL_SIZE_LIMIT,
    SIZE_LIMITS,
    NoTeamConfigured,
    RawAttachment,
    categorize,
)


# Server-internal attachment fields that must never leak to clients:
# - ``converted_text``: extracted document body, sent to the LLM only.
# - ``path`` / ``workspace_path``: absolute on-disk paths, used for rehydration;
#   clients fetch
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
# Mirrors the frontend's `findCommittedMentions` semantics:
#
#   - ``@`` must be at the start of the message or after whitespace
#   - the token runs from the ``@`` to the next whitespace
#   - trailing sentence punctuation ``,.;:!?)`` is stripped
#
# Tokens are resolved against the session workspace (normal session
# sandbox, or the coding workspace root if `workspace` is provided).
# File mentions can be turned into hidden inline context blocks; folder
# mentions can be turned into hidden directory-listing context blocks.
# Neither path is treated as an uploaded attachment or persisted into
# ``uploads/``.

# Anchored at start-of-string or after a whitespace / opening-bracket /
# quote / comma character. Users routinely write quoted or parenthesised
# mentions — `"@foo.txt"`, `(@foo.txt)`, `,@bar.md` — and we'd rather
# pick those up than silently lose them.
_MENTION_RE = re.compile(r"(?:^|(?<=[\s\"'(\[{,]))@(\S+)")
# Trailing punctuation stripped before resolution. Includes closing
# brackets / quotes that mirror the boundary chars above so paired
# wrappers like `(@foo.txt)` resolve to `foo.txt`.
_TRAILING_PUNCT = ",.;:!?)\"']}>"

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


def _extract_mention_paths(message: str) -> list[str]:
    """Return the unique, ordered list of @file tokens from ``message``.

    Directory mentions are not auto-expanded — only explicit file mentions are
    converted into implicit attachments. The bare ``@`` is dropped. Trailing
    sentence punctuation is stripped before deduplication so
    "see @a.ts, please" yields ``["a.ts"]``.
    """
    seen: set[str] = set()
    out: list[str] = []
    for match in _MENTION_RE.finditer(message):
        token = match.group(1)
        # Strip trailing punctuation in a loop — handles `@x?!`.
        while token and token[-1] in _TRAILING_PUNCT:
            token = token[:-1]
        if not token:
            continue
        if token.endswith("/"):
            continue
        if token in seen:
            continue
        seen.add(token)
        out.append(token)
        if len(out) >= _MAX_MENTION_ATTACHMENTS:
            break
    return out


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


async def _read_mention_as_attachment(
    rel_path: str,
    abs_path: Path,
    capabilities,
    *,
    line_start: int | None = None,
    line_end: int | None = None,
) -> RawAttachment | None:
    """Read one mentioned file as a ``RawAttachment`` when the lead can use it.

    Only text categories auto-attach. Images and documents are skipped
    intentionally — they are file references, and the agent's ``Read``
    tool can fetch/convert them on demand. Auto-attaching non-text mentions
    would force conversion or base64 payloads into context even when the
    agent never needs to inspect them.

    Returns ``None`` (and logs at debug level) when the file fails any of
    the soft constraints — non-text category, capability mismatch,
    unsupported type, oversize. Hard read failures (``OSError``) also
    return ``None``. Mentions are an implicit attachment surface; we
    never surface a 4xx to the user just because they typed
    ``@somefile.png`` against a non-vision model.
    """
    filename = rel_path
    mime, _ = mimetypes.guess_type(str(abs_path))
    category = categorize(filename, mime)
    if category is None and line_start is not None:
        mime = "text/plain"
        category = "text"
    if category is None:
        return None
    if category != "text":
        # Non-text mentions are reference-only. The agent uses ``Read``
        # to convert documents or inspect images on demand.
        return None
    try:
        data = await _read_bytes(abs_path)
    except OSError as exc:
        logger.debug("mention_read_failed path={} error={}", rel_path, exc)
        return None
    if line_start is not None:
        try:
            data = _slice_lines(data, line_start, line_end)
        except UnicodeDecodeError:
            return None
    if not data:
        return None
    if len(data) > SIZE_LIMITS[category]:
        logger.debug(
            "mention_oversize path={} category={} size={}",
            rel_path,
            category,
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


async def collect_mention_attachments(
    *,
    message: str,
    team: AgentTeam,
    session_id: str,
    workspace: str | None,
    existing_total_bytes: int,
) -> list[RawAttachment]:
    """Resolve ``@path`` mentions in ``message`` to ``RawAttachment`` objects.

    Implicit attachments — surface only files that pass every check. Any
    failure (missing file, path escape, unsupported type, oversize,
    capability mismatch, would-exceed-global-cap) is silently dropped.
    Explicit paperclip uploads remain the authoritative way to force a
    file in regardless of these soft rules.

    ``existing_total_bytes`` is the cumulative size of the message's
    explicit attachments so far. We deduct it from the global budget so
    a mention can't push the message over the limit on its own.

    This helper is used to build ephemeral inline context for explicit file
    mentions without treating them as persisted uploads.
    """
    paths = _extract_mention_paths(message)
    if not paths:
        return []

    root = session_workspace_dir(session_id, workspace)
    out: list[RawAttachment] = []
    running_total = existing_total_bytes
    for rel in paths:
        file_rel, label, line_start, line_end = _parse_line_ref(rel)
        abs_path = _safe_join(root, file_rel)
        if abs_path is None:
            continue
        att = await _read_mention_as_attachment(
            label,
            abs_path,
            team.lead.agent.capabilities,
            line_start=line_start,
            line_end=line_end,
        )
        if att is None:
            continue
        running_total += len(att.data)
        if running_total > GLOBAL_SIZE_LIMIT:
            # Stop accumulating — the rest would push us over the cap.
            logger.debug(
                "mention_global_cap_reached session_id={} dropped_from={}",
                session_id,
                rel,
            )
            break
        out.append(att)
    if out:
        logger.info(
            "mention_attachments_collected session_id={} count={} bytes={}",
            session_id,
            len(out),
            sum(len(a.data) for a in out),
        )
    return out


async def build_mention_context_blocks(
    *,
    message: str,
    team: AgentTeam,
    session_id: str,
    workspace: str | None,
    existing_total_bytes: int,
) -> list[str]:
    """Return hidden inline context blocks for ``@file`` / ``@folder/`` mentions.

    File mentions inline their text content using the same fenced format as
    synthetic attachment rows, but without writing anything into ``uploads/`` or
    ``extra.attachments``. Folder mentions inject a lightweight directory listing
    so the model can see the subtree shape without pre-running tools.
    """
    root = session_workspace_dir(session_id, workspace)
    raw_paths = []
    seen: set[str] = set()
    for match in _MENTION_RE.finditer(message):
        token = match.group(1)
        while token and token[-1] in _TRAILING_PUNCT:
            token = token[:-1]
        if not token or token in seen:
            continue
        seen.add(token)
        raw_paths.append(token)
        if len(raw_paths) >= _MAX_MENTION_ATTACHMENTS:
            break
    if not raw_paths:
        return []

    out: list[str] = []
    running_total = existing_total_bytes
    for rel in raw_paths:
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
            continue
        att = await _read_mention_as_attachment(
            label,
            abs_path,
            team.lead.agent.capabilities,
            line_start=line_start,
            line_end=line_end,
        )
        if att is None:
            continue
        synthetic = agent_service._build_synthetic_content(
            att,
            "text",
            label,
            att.content_type or "text/plain",
        )
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
