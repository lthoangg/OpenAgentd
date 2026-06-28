"""Tests for app.services.agent_service — attachment validation + dispatch."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.agent_service import (
    GLOBAL_SIZE_LIMIT,
    SIZE_LIMITS,
    AttachmentError,
    NoTeamConfigured,
    RawAttachment,
    _build_synthetic_content,
    _default_ext,
    _maybe_truncate_inline,
    _persist_attachment,
    _validate_ext_mime_consistency,
    _validate_magic_bytes,
    categorize,
    dispatch_user_message,
    interrupt_team,
    require_team,
    validate_and_persist_attachments,
)


# ── Helpers ───────────────────────────────────────────────────────────────────


def _make_team(*, vision: bool = True, document_text: bool = True) -> MagicMock:
    """Build a minimal AgentTeam stub."""
    caps = MagicMock()
    caps.input.vision = vision
    caps.input.document_text = document_text

    agent = MagicMock()
    agent.capabilities = caps

    lead = MagicMock()
    lead.agent = agent

    team = MagicMock()
    team.lead = lead
    team.handle_user_message = AsyncMock()
    return team


# ── AttachmentError ───────────────────────────────────────────────────────────


def test_attachment_error_stores_status():
    err = AttachmentError("too big", status=413)
    assert str(err) == "too big"
    assert err.status == 413


def test_attachment_error_default_is_not_overridden():
    # Each status is an explicit choice by the caller — make sure it round-trips.
    for code in (400, 413, 415, 422):
        assert AttachmentError("x", status=code).status == code


# ── require_team ──────────────────────────────────────────────────────────────


def test_require_team_returns_team():
    team = _make_team()
    assert require_team(team) is team


def test_require_team_raises_when_none():
    with pytest.raises(NoTeamConfigured):
        require_team(None)


# ── categorize ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "filename,content_type,expected",
    [
        ("photo.jpg", "image/jpeg", "image"),
        ("doc.pdf", "application/pdf", "document"),
        ("page.html", "text/html", "document"),
        ("notes.txt", "text/plain", "text"),
        # Extension fallback when MIME is absent
        ("data.csv", None, "text"),
        ("report.docx", None, "document"),
        ("page.htm", None, "document"),
        ("pic.png", None, "image"),
        # Extension fallback when MIME is unrecognised
        ("file.md", "application/octet-stream", "text"),
        # Unknown extension → None
        ("binary.exe", None, None),
        ("noext", "application/octet-stream", None),
    ],
)
def test_categorize(filename, content_type, expected):
    assert categorize(filename, content_type) == expected


def test_categorize_mime_wins_over_extension():
    # MIME takes priority when recognised
    assert categorize("file.txt", "image/png") == "image"


# ── _validate_magic_bytes ─────────────────────────────────────────────────────


def test_magic_bytes_jpeg_valid():
    data = b"\xff\xd8\xff" + b"\x00" * 100
    assert _validate_magic_bytes(data, "image/jpeg") is True


def test_magic_bytes_jpeg_invalid():
    data = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100  # PNG header, claimed as JPEG
    assert _validate_magic_bytes(data, "image/jpeg") is False


def test_magic_bytes_png_valid():
    data = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100
    assert _validate_magic_bytes(data, "image/png") is True


def test_magic_bytes_pdf_valid():
    data = b"%PDF-1.4 ..." + b"\x00" * 50
    assert _validate_magic_bytes(data, "application/pdf") is True


def test_magic_bytes_unknown_mime_passes():
    # No signatures registered → always passes (don't block unknown types)
    assert _validate_magic_bytes(b"\x00\x01\x02", "text/plain") is True


def test_magic_bytes_gif_valid():
    data = b"GIF89a" + b"\x00" * 20
    assert _validate_magic_bytes(data, "image/gif") is True


# ── _validate_ext_mime_consistency ────────────────────────────────────────────


def test_ext_mime_consistent():
    assert _validate_ext_mime_consistency("photo.jpg", "image/jpeg") is True


def test_ext_mime_inconsistent():
    # .jpg extension but PDF MIME
    assert _validate_ext_mime_consistency("photo.jpg", "application/pdf") is False


def test_ext_mime_unknown_ext_passes():
    # Unknown extension → we can't validate, so pass through
    assert _validate_ext_mime_consistency("file.xyz", "image/png") is True


def test_ext_mime_unknown_mime_passes():
    assert _validate_ext_mime_consistency("file.jpg", "application/unknown") is True


# ── _default_ext ─────────────────────────────────────────────────────────────


def test_default_ext_known_categories():
    assert _default_ext("text") == ".txt"
    assert _default_ext("image") == ".jpg"
    assert _default_ext("document") == ".pdf"


def test_default_ext_unknown_category_returns_bin():
    assert _default_ext("video") == ".bin"
    assert _default_ext("audio") == ".bin"
    assert _default_ext("") == ".bin"


# ── validate_and_persist_attachments ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_validate_unsupported_extension(tmp_path):
    team = _make_team()
    att = RawAttachment(filename="virus.exe", content_type=None, data=b"\x4d\x5a" * 10)
    with pytest.raises(AttachmentError) as exc_info:
        await validate_and_persist_attachments(team, [att])
    assert exc_info.value.status == 415
    assert ".exe" in str(exc_info.value)


@pytest.mark.asyncio
async def test_validate_image_rejected_when_no_vision(tmp_path):
    team = _make_team(vision=False)
    data = b"\x89PNG\r\n\x1a\n" + b"\x00" * 50
    att = RawAttachment(filename="img.png", content_type="image/png", data=data)
    with pytest.raises(AttachmentError) as exc_info:
        await validate_and_persist_attachments(team, [att])
    assert exc_info.value.status == 422
    assert "image" in str(exc_info.value).lower()


@pytest.mark.asyncio
async def test_validate_document_rejected_when_no_document_text(tmp_path):
    team = _make_team(document_text=False)
    data = b"%PDF-1.4" + b"\x00" * 50
    att = RawAttachment(filename="doc.pdf", content_type="application/pdf", data=data)
    with pytest.raises(AttachmentError) as exc_info:
        await validate_and_persist_attachments(team, [att])
    assert exc_info.value.status == 422
    assert "document" in str(exc_info.value).lower()


@pytest.mark.asyncio
async def test_validate_global_size_limit_exceeded():
    team = _make_team()
    # Two text files, each just over half the global limit
    chunk = b"a" * (GLOBAL_SIZE_LIMIT // 2 + 1)
    att1 = RawAttachment(filename="big1.txt", content_type="text/plain", data=chunk)
    att2 = RawAttachment(filename="big2.txt", content_type="text/plain", data=chunk)
    with pytest.raises(AttachmentError) as exc_info:
        await validate_and_persist_attachments(team, [att1, att2])
    assert exc_info.value.status == 413
    assert "global" in str(exc_info.value).lower()


@pytest.mark.asyncio
async def test_validate_empty_filename_skipped(tmp_path):
    """Attachments with empty filenames are silently skipped."""
    team = _make_team()
    with patch("app.services.agent_service._uploads_dir", return_value=tmp_path):
        sid, metas, synthetics = await validate_and_persist_attachments(
            team,
            [RawAttachment(filename="", content_type="text/plain", data=b"hello")],
        )
    assert metas == []
    assert synthetics == []


@pytest.mark.asyncio
async def test_validate_and_persist_text_file(tmp_path):
    team = _make_team()
    content = b"hello world"
    att = RawAttachment(filename="notes.txt", content_type="text/plain", data=content)
    with patch("app.services.agent_service._uploads_dir", return_value=tmp_path):
        sid, metas, synthetics = await validate_and_persist_attachments(team, [att])
    assert len(metas) == 1
    assert len(synthetics) == 1
    meta = metas[0]
    assert meta["category"] == "text"
    assert "converted_text" not in meta
    assert meta["original_name"] == "notes.txt"
    # The saved file should exist on disk
    saved = tmp_path / meta["filename"]
    assert saved.is_file()
    assert saved.read_bytes() == content
    assert meta["path"] == str(saved)
    assert meta["workspace_path"] == str(saved)
    assert Path(meta["path"]).is_file()
    # File content is now in the synthetic row string, not in meta
    assert "hello world" in synthetics[0]
    assert "[File: notes.txt]" in synthetics[0]


@pytest.mark.asyncio
async def test_validate_and_persist_mints_sid_when_session_id_none(tmp_path):
    team = _make_team()
    att = RawAttachment(filename="a.txt", content_type="text/plain", data=b"hi")
    with patch("app.services.agent_service._uploads_dir", return_value=tmp_path):
        sid, metas, synthetics = await validate_and_persist_attachments(team, [att])
    assert sid and len(sid) > 10
    assert len(metas) == 1
    assert "path" in metas[0]
    assert Path(metas[0]["path"]).is_file()
    assert len(synthetics) == 1


@pytest.mark.asyncio
async def test_validate_and_persist_uses_provided_session_id(tmp_path):
    """When ``session_id`` is supplied the function reuses it verbatim
    instead of minting a fresh one — uploads land under the chat
    session's workspace."""
    team = _make_team()
    att = RawAttachment(filename="a.txt", content_type="text/plain", data=b"hi")
    with patch("app.services.agent_service._uploads_dir", return_value=tmp_path):
        sid, metas, synthetics = await validate_and_persist_attachments(
            team, [att], session_id="existing-sid-xyz"
        )
    assert sid == "existing-sid-xyz"
    assert len(metas) == 1
    assert len(synthetics) == 1


@pytest.mark.asyncio
async def test_validate_and_persist_uses_coding_workspace_uploads_dir(tmp_path):
    team = _make_team()
    workspace = tmp_path / "repo"
    att = RawAttachment(
        filename="image.png", content_type="image/png", data=b"\x89PNG\r\n\x1a\n"
    )

    sid, metas, synthetics = await validate_and_persist_attachments(
        team,
        [att],
        session_id="existing-sid-xyz",
        workspace=str(workspace),
    )

    assert sid == "existing-sid-xyz"
    assert len(metas) == 1
    saved = workspace / "uploads" / metas[0]["filename"]
    assert saved.is_file()
    assert metas[0]["path"] == str(saved)
    assert metas[0]["workspace_path"] == str(saved)
    assert metas[0]["url"] == "/api/team/existing-sid-xyz/uploads/image.png"
    assert synthetics == ["[Attached image: image.png]"]


# ── _build_synthetic_content / _maybe_truncate_inline ────────────────────────


@pytest.mark.asyncio
async def test_paperclip_upload_text_is_not_truncated(tmp_path):
    """Explicit uploads leave ``truncate_inline_to`` ``None`` — the full
    body reaches the synthetic row regardless of size."""
    team = _make_team()
    long_text = "x" * 50_000
    att = RawAttachment(
        filename="big.txt", content_type="text/plain", data=long_text.encode()
    )
    with patch("app.services.agent_service._uploads_dir", return_value=tmp_path):
        _, _, synthetics = await validate_and_persist_attachments(team, [att])
    assert long_text in synthetics[0]
    assert "Middle truncated" not in synthetics[0]


@pytest.mark.asyncio
async def test_mention_text_is_head_tail_truncated_at_cap(tmp_path):
    """A mention-sourced attachment passes ``truncate_inline_to`` so the
    synthetic content is capped with a head + tail window."""
    team = _make_team()
    body = ("A" * 500) + ("B" * 500)
    att = RawAttachment(
        filename="m.txt",
        content_type="text/plain",
        data=body.encode(),
        truncate_inline_to=200,
    )
    with patch("app.services.agent_service._uploads_dir", return_value=tmp_path):
        _, _, synthetics = await validate_and_persist_attachments(team, [att])
    out = synthetics[0]
    assert "A" * 100 in out
    assert "B" * 100 in out
    assert "Middle truncated" in out
    assert "800 chars elided" in out
    assert "Read tool" in out


@pytest.mark.asyncio
async def test_mention_text_below_cap_is_unchanged(tmp_path):
    """The cap is only applied when the body exceeds it."""
    team = _make_team()
    body = "short content"
    att = RawAttachment(
        filename="m.txt",
        content_type="text/plain",
        data=body.encode(),
        truncate_inline_to=1000,
    )
    with patch("app.services.agent_service._uploads_dir", return_value=tmp_path):
        _, _, synthetics = await validate_and_persist_attachments(team, [att])
    assert body in synthetics[0]


def test_build_synthetic_content_text_utf8():
    att = RawAttachment(
        filename="notes.txt", content_type="text/plain", data="héllo".encode()
    )

    out = _build_synthetic_content(att, "text", "notes.txt", "text/plain")

    assert out == "[File: notes.txt]\nhéllo\n[End file: notes.txt]"


def test_build_synthetic_content_text_latin1_fallback():
    att = RawAttachment(
        filename="latin.txt", content_type="text/plain", data="café".encode("latin-1")
    )

    out = _build_synthetic_content(att, "text", "latin.txt", "text/plain")

    assert "café" in out
    assert out.startswith("[File: latin.txt]")


def test_build_synthetic_content_text_decode_failure(monkeypatch):
    class Undecodable(bytes):
        def decode(self, encoding="utf-8", errors="strict"):
            raise UnicodeDecodeError(encoding, b"x", 0, 1, "boom")

    att = RawAttachment(
        filename="bad.txt", content_type="text/plain", data=Undecodable(b"x")
    )

    out = _build_synthetic_content(att, "text", "bad.txt", "text/plain")

    assert out == "[Unable to read file bad.txt.]"


def test_build_synthetic_content_document_success(monkeypatch):
    att = RawAttachment(
        filename="doc.pdf", content_type="application/pdf", data=b"%PDF"
    )
    monkeypatch.setattr(
        "app.services.agent_service._convert_with_markitdown",
        lambda data, mime, filename: "converted markdown",
    )

    out = _build_synthetic_content(att, "document", "doc.pdf", "application/pdf")

    assert out == "[Document: doc.pdf]\nconverted markdown\n[End document: doc.pdf]"


def test_build_synthetic_content_document_markitdown_failure(monkeypatch):
    att = RawAttachment(
        filename="doc.pdf", content_type="application/pdf", data=b"%PDF"
    )
    monkeypatch.setattr(
        "app.services.agent_service._convert_with_markitdown",
        lambda data, mime, filename: None,
    )

    out = _build_synthetic_content(att, "document", "doc.pdf", "application/pdf")

    assert "[Unable to read file doc.pdf.]" in out
    assert out.startswith("[Document: doc.pdf]")


def test_build_synthetic_content_image_path_hint_only():
    att = RawAttachment(
        filename="pic.png", content_type="image/png", data=b"\x89PNG\r\n\x1a\n"
    )

    out = _build_synthetic_content(att, "image", "pic.png", "image/png")

    assert out == "[Attached image: pic.png]"


def test_build_synthetic_content_unknown_category_fallback():
    att = RawAttachment(
        filename="archive.bin", content_type="application/octet-stream", data=b"abc"
    )

    out = _build_synthetic_content(
        att, "unknown", "archive.bin", "application/octet-stream"
    )

    assert out == "[Attached file: archive.bin]"


def test_build_synthetic_content_line_ref_label():
    att = RawAttachment(
        filename="app.py#L10-L20", content_type="text/plain", data=b"print('x')"
    )

    out = _build_synthetic_content(att, "text", "app.py#L10-L20", "text/plain")

    assert "selected lines already loaded" in out
    assert "use this block directly" in out
    assert "print('x')" in out


def test_maybe_truncate_inline_odd_cap_preserves_head_and_tail():
    out = _maybe_truncate_inline("0123456789", 5)

    assert out.startswith("01")
    assert out.endswith("89")
    assert "6 chars elided" in out


@pytest.mark.asyncio
async def test_persist_attachment_rejects_empty_data(tmp_path):
    att = RawAttachment(filename="empty.txt", content_type="text/plain", data=b"")

    with pytest.raises(AttachmentError) as exc_info:
        await _persist_attachment(att, "text", tmp_path, "sid")

    assert exc_info.value.status == 422
    assert "empty" in str(exc_info.value)


@pytest.mark.asyncio
async def test_persist_attachment_rejects_oversize_category_limit(tmp_path):
    att = RawAttachment(
        filename="too-big.txt",
        content_type="text/plain",
        data=b"x" * (SIZE_LIMITS["text"] + 1),
    )

    with pytest.raises(AttachmentError) as exc_info:
        await _persist_attachment(att, "text", tmp_path, "sid")

    assert exc_info.value.status == 413
    assert "exceeds" in str(exc_info.value)


@pytest.mark.asyncio
async def test_persist_attachment_rejects_bad_magic_bytes(tmp_path):
    att = RawAttachment(
        filename="fake.png", content_type="image/png", data=b"not a png"
    )

    with pytest.raises(AttachmentError) as exc_info:
        await _persist_attachment(att, "image", tmp_path, "sid")

    assert exc_info.value.status == 422
    assert "declared type" in str(exc_info.value)


@pytest.mark.asyncio
async def test_persist_attachment_truncates_long_filename_preserving_extension(
    tmp_path,
):
    long_name = f"{'a' * 260}.txt"
    att = RawAttachment(filename=long_name, content_type="text/plain", data=b"hello")

    meta, synthetic = await _persist_attachment(att, "text", tmp_path, "sid")

    assert len(meta["filename"]) <= 200
    assert len(meta["original_name"]) <= 200
    assert meta["filename"].endswith(".txt")
    assert meta["original_name"].endswith(".txt")
    assert synthetic.startswith(f"[File: {meta['original_name']}]")


@pytest.mark.asyncio
async def test_persist_attachment_preserves_source_field(tmp_path):
    att = RawAttachment(
        filename="mentioned.txt",
        content_type="text/plain",
        data=b"hello",
        source="mention",
    )

    meta, _ = await _persist_attachment(att, "text", tmp_path, "sid")

    assert meta["source"] == "mention"


@pytest.mark.asyncio
async def test_persist_attachment_image_category(tmp_path):
    data = b"\x89PNG\r\n\x1a\n" + b"\x00"
    att = RawAttachment(filename="pic.png", content_type="image/png", data=data)

    meta, synthetic = await _persist_attachment(att, "image", tmp_path, "sid")

    assert meta["category"] == "image"
    assert meta["media_type"] == "image/png"
    assert synthetic == "[Attached image: pic.png]"


@pytest.mark.asyncio
async def test_persist_attachment_document_category_markitdown_failure(
    tmp_path, monkeypatch
):
    att = RawAttachment(
        filename="doc.pdf", content_type="application/pdf", data=b"%PDF-1.4"
    )
    monkeypatch.setattr(
        "app.services.agent_service._convert_with_markitdown",
        lambda data, mime, filename: None,
    )

    meta, synthetic = await _persist_attachment(att, "document", tmp_path, "sid")

    assert meta["category"] == "document"
    assert "[Unable to read file doc.pdf.]" in synthetic


@pytest.mark.asyncio
async def test_persist_attachment_line_ref_filename_uses_real_extension(tmp_path):
    att = RawAttachment(
        filename="app.py#L1-L2", content_type="text/plain", data=b"x = 1"
    )

    meta, synthetic = await _persist_attachment(att, "text", tmp_path, "sid")

    assert meta["filename"].endswith(".py")
    assert meta["filename"] == "app.py"
    assert synthetic.startswith("[File: app.py]")


@pytest.mark.asyncio
async def test_persist_attachment_uses_sanitized_original_filename(tmp_path):
    att = RawAttachment(
        filename="Screenshot 2026-06-28 at 19.59.23.png",
        content_type="image/png",
        data=b"\x89PNG\r\n\x1a\n",
    )

    meta, _ = await _persist_attachment(att, "image", tmp_path, "sid")

    assert meta["filename"] == "Screenshot 2026-06-28 at 19.59.23.png"
    assert meta["original_name"] == "Screenshot 2026-06-28 at 19.59.23.png"
    assert (tmp_path / "Screenshot 2026-06-28 at 19.59.23.png").is_file()


@pytest.mark.asyncio
async def test_persist_attachment_dedupes_duplicate_names(tmp_path):
    att1 = RawAttachment(
        filename="image.png", content_type="image/png", data=b"\x89PNG\r\n\x1a\n"
    )
    att2 = RawAttachment(
        filename="image.png", content_type="image/png", data=b"\x89PNG\r\n\x1a\n"
    )

    meta1, _ = await _persist_attachment(att1, "image", tmp_path, "sid")
    meta2, _ = await _persist_attachment(att2, "image", tmp_path, "sid")

    assert meta1["filename"] == "image.png"
    assert meta2["filename"] == "image (1).png"
    assert (tmp_path / "image.png").is_file()
    assert (tmp_path / "image (1).png").is_file()


@pytest.mark.asyncio
async def test_persist_attachment_strips_path_components(tmp_path):
    att = RawAttachment(
        filename="../../nested/evil.png",
        content_type="image/png",
        data=b"\x89PNG\r\n\x1a\n",
    )

    meta, _ = await _persist_attachment(att, "image", tmp_path, "sid")

    assert meta["filename"] == "evil.png"
    assert meta["original_name"] == "evil.png"
    assert (tmp_path / "evil.png").is_file()


@pytest.mark.asyncio
async def test_validate_and_persist_multiple_files_and_synthetics(tmp_path):
    team = _make_team()
    atts = [
        RawAttachment(filename="a.txt", content_type="text/plain", data=b"alpha"),
        RawAttachment(filename="b.md", content_type="text/markdown", data=b"# beta"),
    ]

    with patch("app.services.agent_service._uploads_dir", return_value=tmp_path):
        sid, metas, synthetics = await validate_and_persist_attachments(
            team, atts, session_id="sid"
        )

    assert sid == "sid"
    assert [m["original_name"] for m in metas] == ["a.txt", "b.md"]
    assert "alpha" in synthetics[0]
    assert "# beta" in synthetics[1]
    assert all((tmp_path / meta["filename"]).exists() for meta in metas)


@pytest.mark.asyncio
async def test_validate_and_persist_escapes_html_in_original_name_and_synthetic(
    tmp_path,
):
    team = _make_team()
    att = RawAttachment(
        filename="<script>.txt", content_type="text/plain", data=b"safe"
    )

    with patch("app.services.agent_service._uploads_dir", return_value=tmp_path):
        _, metas, synthetics = await validate_and_persist_attachments(
            team, [att], session_id="sid"
        )

    assert metas[0]["original_name"] == "&lt;script&gt;.txt"
    assert "[File: &lt;script&gt;.txt]" in synthetics[0]


@pytest.mark.asyncio
async def test_validate_and_persist_no_content_type_falls_back_to_extension(tmp_path):
    team = _make_team()
    att = RawAttachment(filename="notes.txt", content_type=None, data=b"hello")

    with patch("app.services.agent_service._uploads_dir", return_value=tmp_path):
        _, metas, synthetics = await validate_and_persist_attachments(
            team, [att], session_id="sid"
        )

    assert metas[0]["media_type"] == "application/octet-stream"
    assert metas[0]["category"] == "text"
    assert "hello" in synthetics[0]


# ── dispatch_user_message ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_dispatch_generates_sid_when_none():
    team = _make_team()
    sid, n = await dispatch_user_message(team, content="hello", session_id=None)
    assert sid and len(sid) > 8
    assert n == 0
    team.handle_user_message.assert_awaited_once()


@pytest.mark.asyncio
async def test_dispatch_reuses_provided_sid():
    team = _make_team()
    sid, n = await dispatch_user_message(team, content="hi", session_id="my-sid-123")
    assert sid == "my-sid-123"
    assert n == 0


@pytest.mark.asyncio
async def test_dispatch_passes_session_model_settings():
    team = _make_team()
    await dispatch_user_message(
        team,
        content="hi",
        session_id="my-sid-123",
        model="openai:gpt-5.5",
        thinking_level="high",
    )
    team.handle_user_message.assert_awaited_once_with(
        content="hi",
        session_id="my-sid-123",
        interrupt=False,
        attachment_metas=None,
        attachment_synthetics=None,
        mode="normal",
        workspace=None,
        model="openai:gpt-5.5",
        model_provided=True,
        thinking_level="high",
        thinking_level_provided=True,
        service_tier=None,
    )


@pytest.mark.asyncio
async def test_dispatch_with_attachments_uses_fresh_sid_when_session_id_none(tmp_path):
    team = _make_team()
    att = RawAttachment(filename="f.txt", content_type="text/plain", data=b"content")
    with patch("app.services.agent_service._uploads_dir", return_value=tmp_path):
        sid, n = await dispatch_user_message(
            team, content="hi", session_id=None, attachments=[att]
        )
    assert n == 1
    assert sid and len(sid) > 8


@pytest.mark.asyncio
async def test_dispatch_with_attachments_prefers_provided_session_id(tmp_path):
    team = _make_team()
    att = RawAttachment(filename="f.txt", content_type="text/plain", data=b"x")
    with patch("app.services.agent_service._uploads_dir", return_value=tmp_path):
        sid, n = await dispatch_user_message(
            team, content="hi", session_id="existing-123", attachments=[att]
        )
    assert sid == "existing-123"
    assert n == 1


# ── interrupt_team ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_interrupt_team_cancels_working_members():
    working = MagicMock()
    working.state = "working"
    working.name = "worker-a"

    idle = MagicMock()
    idle.state = "idle"
    idle.name = "idler"

    team = MagicMock()
    team.members = {}
    team.all_members = [working, idle]

    with (
        patch(
            "app.services.agent_service.stream_store.push_event", new=AsyncMock()
        ) as push,
        patch(
            "app.services.agent_service.stream_store.mark_done", new=AsyncMock()
        ) as mark_done,
    ):
        names = await interrupt_team(team, session_id="sess-1")

    assert names == ["worker-a"]
    working.interrupt.assert_called_once()
    push.assert_awaited_once()
    mark_done.assert_awaited_once_with("sess-1")


@pytest.mark.asyncio
async def test_interrupt_team_releases_queued_messages_before_stopping_stream():
    idle = MagicMock()
    idle.state = "idle"
    idle.name = "idler"

    team = MagicMock()
    team.members = {}
    team.all_members = [idle]
    team.lead.session_id = None

    with (
        patch(
            "app.services.chat_service.release_queued_user_messages",
            new=AsyncMock(return_value=[object()]),
        ) as release_queued,
        patch(
            "app.services.agent_service.stream_store.push_event", new=AsyncMock()
        ) as push,
        patch(
            "app.services.agent_service.stream_store.mark_done", new=AsyncMock()
        ) as mark_done,
    ):
        names = await interrupt_team(
            team, session_id="018f0000-0000-7000-8000-000000000001"
        )

    assert names == []
    release_queued.assert_awaited_once()
    push.assert_awaited_once()
    mark_done.assert_awaited_once_with("018f0000-0000-7000-8000-000000000001")


async def test_interrupt_team_marks_stream_done_even_when_no_members_working():
    idle = MagicMock()
    idle.state = "idle"
    idle.name = "idler"

    team = MagicMock()
    team.members = {}
    team.all_members = [idle]
    team.lead.session_id = None

    with (
        patch(
            "app.services.agent_service.stream_store.push_event", new=AsyncMock()
        ) as push,
        patch(
            "app.services.agent_service.stream_store.mark_done", new=AsyncMock()
        ) as mark_done,
    ):
        names = await interrupt_team(team, session_id="sess-1")

    assert names == []
    push.assert_awaited_once()
    mark_done.assert_awaited_once_with("sess-1")


@pytest.mark.asyncio
async def test_interrupt_team_cancels_working_live_members_without_dismissing():
    working = MagicMock()
    working.state = "working"
    working.name = "executor#1"

    idle = MagicMock()
    idle.state = "idle"
    idle.name = "executor#2"

    team = MagicMock()
    team.members = {"executor#1": working, "executor#2": idle}
    team.all_members = [working, idle]
    team.dismiss = AsyncMock()
    team._emit = AsyncMock()
    team.lead.name = "lead"
    team.lead.session_id = None

    with (
        patch("app.services.agent_service.stream_store.push_event", new=AsyncMock()),
        patch("app.services.agent_service.stream_store.mark_done", new=AsyncMock()),
    ):
        names = await interrupt_team(team, session_id=None)
    assert names == ["executor#1"]
    team._emit.assert_awaited_once_with(
        agent="lead",
        event="inbox",
        extra={
            "content": "[executor#1]: Stopped before completing assigned work.",
            "from_agent": "executor#1",
        },
    )
    working.interrupt.assert_called_once()
    team.dismiss.assert_not_awaited()


@pytest.mark.asyncio
async def test_interrupt_team_no_working_members():
    idle = MagicMock()
    idle.state = "idle"
    idle.name = "idler"

    team = MagicMock()
    team.members = {}
    team.all_members = [idle]
    team.lead.session_id = None

    with (
        patch(
            "app.services.agent_service.stream_store.push_event", new=AsyncMock()
        ) as push,
        patch(
            "app.services.agent_service.stream_store.mark_done", new=AsyncMock()
        ) as mark_done,
    ):
        names = await interrupt_team(team, session_id=None)

    assert names == []
    push.assert_not_awaited()
    mark_done.assert_not_awaited()
