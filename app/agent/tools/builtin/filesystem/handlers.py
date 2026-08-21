"""Multimodal file handlers for the ``read`` tool.

Detects file type by extension and dispatches to the appropriate handler:

- **Image** (.png, .jpg, .jpeg, .gif, .webp, .bmp, .svg): base64-encode → ImageDataBlock
- **Document** (.pdf, .docx): anydoc conversion → TextBlock
- **Text** (everything else, including .html/.htm markup): read as UTF-8/Latin-1
  text verbatim (existing behaviour)

Each handler returns a :class:`~app.agent.schemas.chat.ToolResult` whose
``parts`` list is set directly on ``ToolMessage.parts``.
"""

from __future__ import annotations

import base64
import mimetypes
from pathlib import Path

import anydoc
from loguru import logger

from app.agent.schemas.chat import ImageDataBlock, TextBlock, ToolResult

# ── Constants ─────────────────────────────────────────────────────────────────

_MAX_IMAGE_BYTES = 10_485_760  # 10 MB — reasonable limit for vision APIs
_MAX_READ_BYTES = 5_242_880  # 5 MB — text read cap (matches existing read tool)

# ── Extension → category mapping ─────────────────────────────────────────────

_IMAGE_EXTENSIONS: frozenset[str] = frozenset(
    {
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".webp",
        ".bmp",
        ".svg",
        ".ico",
        ".tiff",
        ".tif",
    }
)

# Binary/packaged formats only. Markup such as .html/.htm is source code, not a
# document: document conversion throws away the tags, attributes, and
# structure an agent needs in order to edit the file, so markup falls through to
# the verbatim text path (which also keeps offset/limit pagination).
_DOCUMENT_EXTENSIONS: frozenset[str] = frozenset(
    {
        ".pdf",
        ".docx",
    }
)

# Fallback MIME types for common image extensions when mimetypes module fails
_IMAGE_MIME_FALLBACK: dict[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".tiff": "image/tiff",
    ".tif": "image/tiff",
}


# ── Public API ────────────────────────────────────────────────────────────────


def classify_file(path: Path) -> str:
    """Return ``"image"``, ``"document"``, or ``"text"`` based on file extension."""
    ext = path.suffix.lower()
    if ext in _IMAGE_EXTENSIONS:
        return "image"
    if ext in _DOCUMENT_EXTENSIONS:
        return "document"
    return "text"


def handle_image(resolved: Path, rel: Path | str) -> ToolResult:
    """Read an image file and return a ToolResult with base64-encoded ImageDataBlock.

    Args:
        resolved: Absolute resolved path to the file.
        rel: Display-relative path (string or Path) used only in labels.

    Raises:
        ValueError: If the file exceeds the image size limit.
    """
    size = resolved.stat().st_size
    if size > _MAX_IMAGE_BYTES:
        raise ValueError(
            f"Image '{rel}' is {size // 1024} KB — "
            f"exceeds the {_MAX_IMAGE_BYTES // 1024} KB limit for vision input."
        )
    raw = resolved.read_bytes()

    ext = resolved.suffix.lower()
    media_type = mimetypes.guess_type(str(resolved))[0] or _IMAGE_MIME_FALLBACK.get(
        ext, "application/octet-stream"
    )

    b64 = base64.b64encode(raw).decode("ascii")

    return ToolResult(
        parts=[
            TextBlock(text=f"[Image: {rel}]"),
            ImageDataBlock(data=b64, media_type=media_type),
        ],
    )


def handle_document(resolved: Path, rel: Path | str) -> ToolResult:
    """Convert a document (PDF, DOCX) to text via anydoc.

    A PDF with no extractable text layer — a scan — is reported by anydoc as
    unsupported; the raw bytes then go to a vision model instead. Encryption is
    reported as itself, because neither a retry nor a vision model can read a
    password-protected file.

    Args:
        resolved: Absolute resolved path to the file.
        rel: Display-relative path (string or Path) used only in labels.
    """
    ext = resolved.suffix.lower()
    media_type = mimetypes.guess_type(str(resolved))[0] or "application/octet-stream"
    size = resolved.stat().st_size
    if size > _MAX_IMAGE_BYTES:
        return ToolResult(
            parts=[
                TextBlock(
                    text=(
                        f"[Document: {rel}] ({media_type}, {size:,} bytes)\n"
                        f"File exceeds the {_MAX_IMAGE_BYTES // 1024} KB limit for processing."
                    )
                )
            ],
        )

    raw = resolved.read_bytes()

    try:
        converted = _convert_document(raw)
    except anydoc.EncryptedError:
        logger.info("document_encrypted path={} size={}", rel, len(raw))
        return ToolResult(
            parts=[
                TextBlock(
                    text=(
                        f"[Document: {rel}] ({media_type}, {len(raw):,} bytes)\n"
                        f"The document is encrypted or password-protected, so its "
                        f"text cannot be extracted."
                    )
                )
            ],
        )
    except (anydoc.ConvertError, OSError) as exc:
        logger.debug("document_conversion_failed path={} error={!r}", rel, exc)
        converted = None

    if converted:
        return ToolResult(
            parts=[TextBlock(text=f"[Document: {rel}]\n{converted}")],
        )

    # No text layer — for PDFs the raw bytes still carry the content, so hand
    # them to a vision-capable model rather than giving up.
    if ext == ".pdf":
        logger.info("document_pdf_vision_fallback path={} size={}", rel, len(raw))
        b64 = base64.b64encode(raw).decode("ascii")
        return ToolResult(
            parts=[
                TextBlock(
                    text=f"[Document: {rel}] (PDF — raw, text extraction failed)"
                ),
                ImageDataBlock(data=b64, media_type="application/pdf"),
            ],
        )

    # All fallbacks exhausted
    return ToolResult(
        parts=[
            TextBlock(
                text=(
                    f"[Document: {rel}] ({media_type}, {len(raw):,} bytes)\n"
                    f"Unable to extract text. File may be corrupted or in an unsupported format."
                )
            ),
        ],
    )


# ── Internal helpers ──────────────────────────────────────────────────────────


def _convert_document(data: bytes) -> str:
    """Convert document bytes to Markdown, or raise an ``anydoc`` error.

    The format is detected from the bytes themselves — the PDF header, the ZIP
    package mimetype — rather than the file extension, so a mislabelled file
    still converts. Callers translate the typed errors into a user-facing
    result; see :func:`handle_document`.
    """
    return anydoc.to_markdown_bytes(data).strip()
