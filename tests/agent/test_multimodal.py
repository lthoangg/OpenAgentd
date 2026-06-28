"""Tests for app/agent/multimodal.py — build_parts_from_metas."""

from __future__ import annotations


from app.agent.multimodal import build_parts_from_metas
from app.agent.schemas.chat import ImageDataBlock, TextBlock


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _att_text(text: str, name: str = "file.txt") -> dict:
    return {"converted_text": text, "original_name": name, "category": "text"}


def _att_image(path: str, name: str = "photo.jpg", mime: str = "image/jpeg") -> dict:
    return {
        "path": path,
        "filename": name,
        "original_name": name,
        "category": "image",
        "media_type": mime,
    }


def _att_no_path(name: str = "mystery.jpg") -> dict:
    """Attachment with category=image but no path key (triggers warning path)."""
    return {"original_name": name, "category": "image", "media_type": "image/jpeg"}


# ---------------------------------------------------------------------------
# fast path — converted_text present
# ---------------------------------------------------------------------------


def test_converted_text_produces_text_block():
    parts = build_parts_from_metas("hello", [_att_text("file content")])
    # First part is the file TextBlock, last is the user message
    assert len(parts) == 2
    assert isinstance(parts[0], TextBlock)
    assert "file content" in parts[0].text
    assert isinstance(parts[-1], TextBlock)
    assert parts[-1].text == "hello"


def test_converted_text_label_text_category():
    att = {
        "converted_text": "csv data",
        "original_name": "data.csv",
        "category": "text",
    }
    parts = build_parts_from_metas("msg", [att])
    assert parts[0].text.startswith("[File: data.csv]")


def test_converted_text_label_document_category():
    att = {
        "converted_text": "doc text",
        "original_name": "report.pdf",
        "category": "document",
    }
    parts = build_parts_from_metas("msg", [att])
    assert parts[0].text.startswith("[Document: report.pdf]")


def test_converted_text_block_is_fenced_with_close_tag():
    """Attachment content is wrapped in matched open + close tags so the
    model knows where the file ends and stops re-Reading inlined files."""
    file_att = {
        "converted_text": "hello world",
        "original_name": "notes.txt",
        "category": "text",
    }
    file_parts = build_parts_from_metas("msg", [file_att])
    assert file_parts[0].text == (
        "[File: notes.txt]\nhello world\n[End file: notes.txt]"
    )

    doc_att = {
        "converted_text": "report body",
        "original_name": "spec.pdf",
        "category": "document",
    }
    doc_parts = build_parts_from_metas("msg", [doc_att])
    assert doc_parts[0].text == (
        "[Document: spec.pdf]\nreport body\n[End document: spec.pdf]"
    )


def test_line_reference_attachment_tells_model_not_to_read_again():
    parts = build_parts_from_metas(
        "show me this",
        [_att_text("line 7\nline 8", name="commands/pr.md#L7-L8")],
    )
    assert parts[0].text == (
        "[File: commands/pr.md#L7-L8 — selected lines already loaded; "
        "use this block directly instead of reading the same range]\n"
        "line 7\nline 8\n"
        "[End file: commands/pr.md#L7-L8]"
    )


# ---------------------------------------------------------------------------
# slow path — image read from disk via stored ``path``
# ---------------------------------------------------------------------------


def test_image_read_from_disk(tmp_path):
    img = tmp_path / "photo.jpg"
    img.write_bytes(b"\xff\xd8\xff" + b"\x00" * 10)  # minimal JPEG-like bytes
    parts = build_parts_from_metas("describe", [_att_image(str(img))])
    # [path-hint TextBlock, ImageDataBlock, user-message TextBlock]
    assert len(parts) == 3
    assert isinstance(parts[0], TextBlock)
    assert parts[0].text == (
        f"[Attached image saved at {img}; render in markdown as uploads/photo.jpg]"
    )
    assert isinstance(parts[1], ImageDataBlock)
    assert parts[1].media_type == "image/jpeg"


def test_image_media_type_passed_through(tmp_path):
    img = tmp_path / "image.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\n")
    att = {
        "path": str(img),
        "filename": "image.png",
        "original_name": "image.png",
        "category": "image",
        "media_type": "image/png",
    }
    parts = build_parts_from_metas("x", [att])
    # path-hint precedes the ImageDataBlock
    assert parts[1].media_type == "image/png"


def test_image_path_hint_uses_absolute_path(tmp_path):
    """The path hint must reference the absolute saved path agents can pass
    directly to tools."""
    img = tmp_path / "abc123.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\n")
    att = {
        "path": str(img),
        "filename": "abc123.png",  # stored UUID name
        "original_name": "My Photo (1).png",  # raw user name
        "category": "image",
        "media_type": "image/png",
    }
    parts = build_parts_from_metas("describe", [att])
    hint = parts[0]
    assert isinstance(hint, TextBlock)
    assert hint.text == (
        f"[Attached image saved at {img}; render in markdown as uploads/abc123.png]"
    )
    # The raw user name must NOT leak into the path hint.
    assert "My Photo" not in hint.text


def test_text_attachment_has_no_path_hint():
    """The path hint is image-only — text attachments are inlined as
    ``[File: name]\\ncontent`` in the fast path; adding a path hint there
    would invite the model to re-read the file via ``read``."""
    parts = build_parts_from_metas("msg", [_att_text("hello", name="notes.txt")])
    assert len(parts) == 2  # one TextBlock + trailing user message
    assert "Attached image saved at" not in parts[0].text


def test_document_with_converted_text_has_no_path_hint():
    """Documents that markitdown-converted successfully use the fast path
    and must not get a path hint either."""
    att = {
        "converted_text": "PDF text content",
        "original_name": "report.pdf",
        "category": "document",
    }
    parts = build_parts_from_metas("msg", [att])
    assert len(parts) == 2
    assert "Attached image saved at" not in parts[0].text


# ---------------------------------------------------------------------------
# slow path — missing path key — emits ``[File not found: ...]`` placeholder
# ---------------------------------------------------------------------------


def test_missing_path_emits_file_not_found_placeholder():
    """Attachment with category=image but no path key emits a placeholder
    TextBlock so the LLM sees explicit context loss instead of silent drop."""
    parts = build_parts_from_metas("msg", [_att_no_path("mystery.jpg")])
    assert len(parts) == 2
    assert isinstance(parts[0], TextBlock)
    assert parts[0].text == "[File not found: mystery.jpg]"
    assert parts[-1].text == "msg"


# ---------------------------------------------------------------------------
# slow path — file missing on disk (OSError) — emits placeholder
# ---------------------------------------------------------------------------


def test_missing_file_on_disk_emits_file_not_found_placeholder(tmp_path):
    """If the image file is absent from disk, emit a ``[File not found:
    <name>]`` TextBlock instead of silently dropping the attachment."""
    att = {
        "path": str(tmp_path / "nonexistent.jpg"),
        "filename": "nonexistent.jpg",
        "original_name": "nonexistent.jpg",
        "category": "image",
        "media_type": "image/jpeg",
    }
    parts = build_parts_from_metas("msg", [att])
    assert len(parts) == 2
    assert isinstance(parts[0], TextBlock)
    assert parts[0].text == "[File not found: nonexistent.jpg]"
    assert parts[-1].text == "msg"


# ---------------------------------------------------------------------------
# multiple attachments + user message always last
# ---------------------------------------------------------------------------


def test_user_message_always_last(tmp_path):
    img = tmp_path / "img.jpg"
    img.write_bytes(b"\xff\xd8" + b"\x00" * 8)
    parts = build_parts_from_metas(
        "user question",
        [_att_text("some text"), _att_image(str(img))],
    )
    assert parts[-1].text == "user question"
    assert isinstance(parts[-1], TextBlock)


def test_no_attachments_returns_single_text_block():
    parts = build_parts_from_metas("only message", [])
    assert len(parts) == 1
    assert parts[0].text == "only message"


def test_image_without_filename_field_omits_markdown_render_hint(tmp_path):
    img = tmp_path / "photo.jpg"
    img.write_bytes(b"\xff\xd8\xff" + b"\x00" * 10)
    att = {
        "path": str(img),
        "original_name": "photo.jpg",
        "category": "image",
        "media_type": "image/jpeg",
    }

    parts = build_parts_from_metas("describe", [att])

    assert isinstance(parts[0], TextBlock)
    assert parts[0].text == f"[Attached image saved at {img}]"
    assert isinstance(parts[1], ImageDataBlock)


def test_document_without_converted_text_uses_raw_disk_slow_path(tmp_path):
    doc = tmp_path / "report.pdf"
    doc.write_bytes(b"%PDF-1.4")
    att = {
        "path": str(doc),
        "filename": "report.pdf",
        "original_name": "report.pdf",
        "category": "document",
        "media_type": "application/pdf",
    }

    parts = build_parts_from_metas("summarize", [att])

    assert len(parts) == 2
    assert isinstance(parts[0], ImageDataBlock)
    assert parts[0].media_type == "application/pdf"
    assert isinstance(parts[1], TextBlock)
    assert parts[1].text == "summarize"
