"""read_file tool — read file contents with optional pagination.

Supports multimodal file types:

- **Images** (.png, .jpg, .gif, .webp, ...): base64-encoded and returned as
  ``ToolResult`` with ``ImageDataBlock`` parts for vision-capable models.
  Non-vision models receive a text notice instead.
- **Documents** (.pdf, .docx): converted to markdown text via
  markitdown. If conversion fails, PDFs are sent as raw bytes to vision models.
- **Text** (everything else, including .html/.htm and other markup): read as
  UTF-8/Latin-1 text verbatim (original behaviour).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Annotated

from loguru import logger
from pydantic import BaseModel, Field

from app.agent.schemas.chat import ToolResult
from app.agent.denied_paths import get_denied_paths
from app.agent.tools.builtin.filesystem.handlers import (
    classify_file,
    handle_document,
    handle_image,
)
from app.agent.tools.registry import InjectedArg, Tool

_MAX_READ_BYTES = 5_242_880  # 5 MB read cap
_MAX_CONTEXT_CHARS = 20_000  # keep read results within typical LLM context budgets
_MAX_LINE_CHARS = 2_000  # one minified line must not eat the whole budget

_DESCRIPTION = (
    "Read a file, or list a directory's immediate children. Text comes back "
    "verbatim (including HTML) with each line numbered 'N: content', "
    "PNG/JPG/GIF/WebP images as vision input, and PDF/DOCX as extracted text. "
    "Call this in parallel when you already know several files you need."
)


class ReadArgs(BaseModel):
    """Arguments for the read tool."""

    path: str = Field(
        description=(
            "Workspace-relative or permitted absolute path — a file to read, "
            "or a directory to list."
        )
    )
    offset: int = Field(
        default=1,
        ge=1,
        description="1-indexed starting line. Ignored when path is a directory.",
    )
    limit: int | None = Field(
        default=None,
        ge=1,
        description=(
            "Maximum lines to return; omit for all remaining lines. Ignored "
            "when path is a directory."
        ),
    )


def _format_directory(resolved: Path) -> str:
    """List a directory's immediate children, directories first."""
    entries = sorted(resolved.iterdir(), key=lambda p: (p.is_file(), p.name))
    lines = [
        f"[f] {entry.name}  ({entry.stat().st_size} bytes)"
        if entry.is_file()
        else f"[d] {entry.name}/"
        for entry in entries
    ]
    return "\n".join(lines) if lines else "(empty directory)"


def _number_lines(text: str, start_line: int) -> str:
    """Prefix each line with its 1-indexed number as ``N: content``.

    Numbering makes locations citable — the model can hand a line straight to
    the ``lsp`` tool or name it in a report instead of counting. ``patch``
    strips a leading ``N: `` from hunk context, so numbered output can still be
    copied into an envelope verbatim.

    The trailing newline is preserved and never numbered, so a file ending in
    ``\\n`` does not gain a phantom final line.
    """
    if not text:
        return text

    trailing_newline = text.endswith("\n")
    body = text[:-1] if trailing_newline else text

    numbered = []
    for offset, line in enumerate(body.split("\n")):
        if len(line) > _MAX_LINE_CHARS:
            line = (
                f"{line[:_MAX_LINE_CHARS]}… (line truncated to {_MAX_LINE_CHARS} chars)"
            )
        numbered.append(f"{start_line + offset}: {line}")

    return "\n".join(numbered) + ("\n" if trailing_newline else "")


def _cap_text_for_context(text: str, rel: object) -> str:
    """Return a context-safe preview for unpaginated text reads."""
    if len(text) <= _MAX_CONTEXT_CHARS:
        return text

    preview = text[:_MAX_CONTEXT_CHARS].rstrip()
    return (
        f"{preview}\n\n"
        f"[read output truncated for LLM context: {rel} is {len(text):,} characters; "
        f"shown first {_MAX_CONTEXT_CHARS:,}. Use offset and limit to read a smaller "
        f"line range, or shell tools such as grep/sed/head/tail for targeted inspection.]"
    )


async def _read_file(
    path: str,
    offset: int = 1,
    limit: int | None = None,
    _state: Annotated[Any, InjectedArg()] = None,
) -> str | ToolResult:
    """Read a file, dispatching by kind (text, image, document).

    For text files, prepends "[X-Y/N]" header when offset/limit active. Max 5 MB.
    For images, returns base64-encoded image data for visual analysis.
    For documents (PDF, DOCX), extracts text content.
    """
    denied_paths = get_denied_paths()
    resolved = denied_paths.validate_path(path)
    rel = denied_paths.display_path(resolved)
    if not resolved.exists():
        raise FileNotFoundError(f"File not found: {rel}")

    # Directories list their children — `classify_file` keys off the suffix and
    # would misread a directory as text, so this must precede it.
    if resolved.is_dir():
        logger.info("read_directory path={}", rel)
        return _format_directory(resolved)

    if not resolved.is_file():
        raise IsADirectoryError(f"Path is not a regular file: {rel}")

    category = classify_file(resolved)

    # ── Image files ───────────────────────────────────────────────────────
    if category == "image":
        size = resolved.stat().st_size
        logger.info("read_image path={} size={}", rel, size)
        return handle_image(resolved, rel)

    # ── Document files → markitdown conversion ────────────────────────────
    if category == "document":
        logger.info("read_document path={} size={}", rel, resolved.stat().st_size)
        return handle_document(resolved, rel)

    # ── Text files → existing behaviour ───────────────────────────────────
    with resolved.open("rb") as file:
        raw = file.read(_MAX_READ_BYTES + 1)
    truncated = len(raw) > _MAX_READ_BYTES
    if truncated:
        logger.warning("file_read_truncated path={} size={}", resolved, len(raw))
        raw = raw[:_MAX_READ_BYTES]

    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")

    if offset == 1 and limit is None:
        return _cap_text_for_context(_number_lines(text, 1), rel)

    lines = text.splitlines(keepends=True)
    total = len(lines)
    start = max(0, offset - 1)
    if start >= total:
        # Without this the header reads "[99-2/2]", which is nonsense the
        # model has to guess at. Say what happened instead.
        return f"[no content: offset {offset} is past the end of {rel}, which has {total} lines]"

    end = total if limit is None else min(total, start + limit)
    slice_lines = lines[start:end]

    header = f"[{start + 1}-{end}/{total}]\n"
    body = _number_lines("".join(slice_lines), start + 1)
    return _cap_text_for_context(header + body, rel)


read_file = Tool(
    _read_file,
    name="read",
    description=_DESCRIPTION,
    args_schema=ReadArgs,
)
