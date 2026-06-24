"""read_file tool — read file contents with optional pagination.

Supports multimodal file types:

- **Images** (.png, .jpg, .gif, .webp, ...): base64-encoded and returned as
  ``ToolResult`` with ``ImageDataBlock`` parts for vision-capable models.
  Non-vision models receive a text notice instead.
- **Documents** (.pdf, .docx, .html): converted to markdown text via
  markitdown. If conversion fails, PDFs are sent as raw bytes to vision models.
- **Text** (everything else): read as UTF-8/Latin-1 text (original behaviour).
"""

from __future__ import annotations

from typing import Any, Annotated

from loguru import logger
from pydantic import Field

from app.agent.schemas.chat import ToolResult
from app.agent.sandbox import get_sandbox
from app.agent.state import AgentState
from app.agent.tools.builtin.filesystem.handlers import (
    classify_file,
    handle_document,
    handle_image,
)
from app.agent.tools.registry import InjectedArg, Tool

_MAX_READ_BYTES = 5_242_880  # 5 MB read cap
_MAX_CONTEXT_CHARS = 20_000  # keep read results within typical LLM context budgets


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


def _has_vision(state: AgentState | None) -> bool:
    """Return True if the current model supports vision."""
    if state is None:
        return False
    return state.capabilities.input.vision


async def _read_file(
    path: Annotated[
        str, Field(description="Relative path to the file inside the workspace.")
    ],
    offset: Annotated[
        int,
        Field(description="Line number to start from, 1-indexed (default 1)."),
    ] = 1,
    limit: Annotated[
        int | None,
        Field(description="Max lines to return. Omit for all lines from offset."),
    ] = None,
    _state: Annotated[Any, InjectedArg()] = None,
) -> str | ToolResult:
    """Read a file from the workspace. Supports text, images, PDFs, and documents.

    For text files, prepends "[X-Y/N]" header when offset/limit active. Max 5 MB.
    For images, returns base64-encoded image data for visual analysis.
    For documents (PDF, DOCX, HTML), extracts text content.
    """
    sandbox = get_sandbox()
    resolved = sandbox.validate_path(path)
    rel = sandbox.display_path(resolved)
    if not resolved.exists():
        raise FileNotFoundError(f"File not found: {rel}")
    if not resolved.is_file():
        raise IsADirectoryError(f"Path is a directory: {rel}")

    category = classify_file(resolved)
    vision = _has_vision(_state)

    # ── Image files ───────────────────────────────────────────────────────
    if category == "image":
        size = resolved.stat().st_size
        logger.info("read_image path={} size={} vision={}", rel, size, vision)
        if not vision:
            return (
                f"[Image: {rel}] ({size:,} bytes)\n"
                f"The file was read successfully but the current model "
                f"does not support vision — image content cannot be displayed. "
                f"Switch to a vision-capable model to analyze this image."
            )
        return handle_image(resolved, rel)

    # ── Document files → markitdown conversion ────────────────────────────
    if category == "document":
        logger.info("read_document path={} size={}", rel, resolved.stat().st_size)
        return handle_document(resolved, rel, vision=vision)

    # ── Text files → existing behaviour ───────────────────────────────────
    raw = resolved.read_bytes()
    truncated = len(raw) > _MAX_READ_BYTES
    if truncated:
        logger.warning("file_read_truncated path={} size={}", resolved, len(raw))
        raw = raw[:_MAX_READ_BYTES]

    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")

    if offset == 1 and limit is None:
        return _cap_text_for_context(text, rel)

    lines = text.splitlines(keepends=True)
    total = len(lines)
    start = max(0, offset - 1)
    end = total if limit is None else min(total, start + limit)
    slice_lines = lines[start:end]

    header = f"[{start + 1}-{end}/{total}]\n"
    return _cap_text_for_context(header + "".join(slice_lines), rel)


read_file = Tool(
    _read_file,
    name="read",
    description=(
        "Read a file from the workspace. Supports text files, images "
        "(PNG, JPG, GIF, WebP), and documents (PDF, DOCX, PPTX, XLSX). "
        "Images and documents are processed for visual/text analysis. "
        "Paths are workspace-relative."
    ),
)
