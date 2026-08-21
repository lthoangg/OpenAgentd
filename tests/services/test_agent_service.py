"""Tests for app.services.agent_service — attachment validation + dispatch."""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.agent_service import (
    GLOBAL_SIZE_LIMIT,
    SIZE_LIMITS,
    AttachmentError,
    NoTeamConfigured,
    RawAttachment,
    _default_ext,
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
    team.handle_user_message = AsyncMock(
        return_value=("stub-session-id", "stub-message-id")
    )
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
        # Code / config extensions → text
        ("main.py", None, "text"),
        ("app.ts", None, "text"),
        ("app.tsx", None, "text"),
        ("index.js", None, "text"),
        ("main.go", None, "text"),
        ("lib.rs", None, "text"),
        ("build.sh", None, "text"),
        ("schema.sql", None, "text"),
        ("config.yaml", None, "text"),
        ("config.toml", None, "text"),
        ("settings.env", None, "text"),
        ("main.tf", None, "text"),
        ("styles.css", None, "text"),
        ("icon.svg", None, "text"),
        # Code MIME types sent by browsers → text
        ("script.py", "text/x-python", "text"),
        ("app.js", "text/javascript", "text"),
        ("app.js", "application/javascript", "text"),
        ("config.yaml", "application/x-yaml", "text"),
        ("run.sh", "application/x-sh", "text"),
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


def test_default_ext_known_categories_audio_video():
    assert _default_ext("audio") == ".mp3"
    assert _default_ext("video") == ".mp4"


def test_default_ext_file_category_returns_bin():
    assert _default_ext("file") == ".bin"


def test_default_ext_unknown_category_returns_bin():
    assert _default_ext("") == ".bin"
    assert _default_ext("binary") == ".bin"


# ── validate_and_persist_attachments ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_unknown_extension_accepted_as_file_category(tmp_path):
    """Files with no recognised extension are saved as 'file' — not rejected."""
    team = _make_team()
    att = RawAttachment(
        filename="archive.zip", content_type=None, data=b"PK" + b"\x00" * 20
    )
    with patch("app.services.agent_service._uploads_dir", return_value=tmp_path):
        sid, metas = await validate_and_persist_attachments(team, [att])
    assert len(metas) == 1
    assert metas[0]["category"] == "file"
    assert (tmp_path / metas[0]["filename"]).is_file()


@pytest.mark.asyncio
async def test_exe_accepted_as_file_category(tmp_path):
    team = _make_team()
    att = RawAttachment(filename="app.exe", content_type=None, data=b"\x4d\x5a" * 10)
    with patch("app.services.agent_service._uploads_dir", return_value=tmp_path):
        sid, metas = await validate_and_persist_attachments(team, [att])
    assert metas[0]["category"] == "file"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "filename,content_type,body",
    [
        ("main.py", None, b"print('hello')"),
        ("app.ts", None, b"const x: number = 1"),
        ("app.tsx", None, b"export default function App() {}"),
        ("index.js", "text/javascript", b"console.log('hi')"),
        ("main.go", None, b"package main"),
        ("lib.rs", None, b"fn main() {}"),
        ("run.sh", "application/x-sh", b"#!/bin/bash\necho hi"),
        ("schema.sql", None, b"SELECT 1;"),
        ("config.yaml", "application/x-yaml", b"key: value"),
        ("pyproject.toml", None, b"[tool.ruff]"),
        ("styles.css", None, b"body { margin: 0; }"),
        ("main.tf", None, b'resource "aws_s3_bucket" "b" {}'),
        ("icon.svg", None, b"<svg></svg>"),
    ],
)
async def test_validate_code_and_config_files_accepted(
    tmp_path, filename, content_type, body
):
    """Code and config file types are accepted and categorised as text."""
    team = _make_team()
    att = RawAttachment(filename=filename, content_type=content_type, data=body)
    with patch("app.services.agent_service._uploads_dir", return_value=tmp_path):
        sid, metas = await validate_and_persist_attachments(team, [att])
    assert len(metas) == 1
    assert metas[0]["category"] == "text", (
        f"{filename} should be 'text', got {metas[0]['category']!r}"
    )


@pytest.mark.asyncio
async def test_validate_image_not_rejected_when_no_vision(tmp_path):
    team = _make_team(vision=False)
    data = b"\x89PNG\r\n\x1a\n" + b"\x00" * 50
    att = RawAttachment(filename="img.png", content_type="image/png", data=data)
    sid, metas = await validate_and_persist_attachments(team, [att])
    assert len(metas) == 1
    assert metas[0]["category"] == "image"


@pytest.mark.asyncio
async def test_validate_document_not_rejected_when_no_document_text(tmp_path):
    team = _make_team(document_text=False)
    data = b"%PDF-1.4" + b"\x00" * 50
    att = RawAttachment(filename="doc.pdf", content_type="application/pdf", data=data)
    sid, metas = await validate_and_persist_attachments(team, [att])
    assert len(metas) == 1
    assert metas[0]["category"] == "document"


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
        sid, metas = await validate_and_persist_attachments(
            team,
            [RawAttachment(filename="", content_type="text/plain", data=b"hello")],
        )
    assert metas == []


@pytest.mark.asyncio
async def test_validate_and_persist_text_file(tmp_path):
    team = _make_team()
    content = b"hello world"
    att = RawAttachment(filename="notes.txt", content_type="text/plain", data=content)
    with patch("app.services.agent_service._uploads_dir", return_value=tmp_path):
        sid, metas = await validate_and_persist_attachments(team, [att])
    assert len(metas) == 1
    meta = metas[0]
    assert meta["category"] == "text"
    assert meta["original_name"] == "notes.txt"
    saved = tmp_path / meta["filename"]
    assert saved.is_file()
    assert saved.read_bytes() == content
    assert meta["path"] == str(saved)
    assert meta["workspace_path"] == str(saved)


@pytest.mark.asyncio
async def test_validate_and_persist_mints_sid_when_session_id_none(tmp_path):
    team = _make_team()
    att = RawAttachment(filename="a.txt", content_type="text/plain", data=b"hi")
    with patch("app.services.agent_service._uploads_dir", return_value=tmp_path):
        sid, metas = await validate_and_persist_attachments(team, [att])
    assert sid and len(sid) > 10
    assert len(metas) == 1
    assert Path(metas[0]["path"]).is_file()


@pytest.mark.asyncio
async def test_validate_and_persist_uses_provided_session_id(tmp_path):
    team = _make_team()
    att = RawAttachment(filename="a.txt", content_type="text/plain", data=b"hi")
    with patch("app.services.agent_service._uploads_dir", return_value=tmp_path):
        sid, metas = await validate_and_persist_attachments(
            team, [att], session_id="existing-sid-xyz"
        )
    assert sid == "existing-sid-xyz"
    assert len(metas) == 1


@pytest.mark.asyncio
async def test_validate_and_persist_uses_coding_workspace_uploads_dir(tmp_path):
    team = _make_team()
    workspace = tmp_path / "repo"
    att = RawAttachment(
        filename="image.png", content_type="image/png", data=b"\x89PNG\r\n\x1a\n"
    )

    sid, metas = await validate_and_persist_attachments(
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

    meta = await _persist_attachment(att, "text", tmp_path, "sid")

    assert len(meta["filename"]) <= 200
    assert len(meta["original_name"]) <= 200
    assert meta["filename"].endswith(".txt")
    assert meta["original_name"].endswith(".txt")


@pytest.mark.asyncio
async def test_persist_attachment_preserves_source_field(tmp_path):
    att = RawAttachment(
        filename="mentioned.txt",
        content_type="text/plain",
        data=b"hello",
        source="mention",
    )

    meta = await _persist_attachment(att, "text", tmp_path, "sid")

    assert meta["source"] == "mention"


@pytest.mark.asyncio
async def test_persist_attachment_image_category(tmp_path):
    data = b"\x89PNG\r\n\x1a\n" + b"\x00"
    att = RawAttachment(filename="pic.png", content_type="image/png", data=data)

    meta = await _persist_attachment(att, "image", tmp_path, "sid")

    assert meta["category"] == "image"
    assert meta["media_type"] == "image/png"


@pytest.mark.asyncio
async def test_persist_attachment_document_category(tmp_path):
    att = RawAttachment(
        filename="doc.pdf", content_type="application/pdf", data=b"%PDF-1.4"
    )

    meta = await _persist_attachment(att, "document", tmp_path, "sid")

    assert meta["category"] == "document"


@pytest.mark.asyncio
async def test_persist_attachment_line_ref_filename_uses_real_extension(tmp_path):
    att = RawAttachment(
        filename="app.py#L1-L2", content_type="text/plain", data=b"x = 1"
    )

    meta = await _persist_attachment(att, "text", tmp_path, "sid")

    assert meta["filename"].endswith(".py")
    assert meta["filename"] == "app.py"


@pytest.mark.asyncio
async def test_persist_attachment_uses_sanitized_original_filename(tmp_path):
    att = RawAttachment(
        filename="Screenshot 2026-06-28 at 19.59.23.png",
        content_type="image/png",
        data=b"\x89PNG\r\n\x1a\n",
    )

    meta = await _persist_attachment(att, "image", tmp_path, "sid")

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

    meta1 = await _persist_attachment(att1, "image", tmp_path, "sid")
    meta2 = await _persist_attachment(att2, "image", tmp_path, "sid")

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

    meta = await _persist_attachment(att, "image", tmp_path, "sid")

    assert meta["filename"] == "evil.png"
    assert meta["original_name"] == "evil.png"
    assert (tmp_path / "evil.png").is_file()


@pytest.mark.asyncio
async def test_validate_and_persist_multiple_files(tmp_path):
    team = _make_team()
    atts = [
        RawAttachment(filename="a.txt", content_type="text/plain", data=b"alpha"),
        RawAttachment(filename="b.md", content_type="text/markdown", data=b"# beta"),
    ]

    with patch("app.services.agent_service._uploads_dir", return_value=tmp_path):
        sid, metas = await validate_and_persist_attachments(
            team, atts, session_id="sid"
        )

    assert sid == "sid"
    assert [m["original_name"] for m in metas] == ["a.txt", "b.md"]
    assert all((tmp_path / meta["filename"]).exists() for meta in metas)


@pytest.mark.asyncio
async def test_validate_and_persist_escapes_html_in_original_name(tmp_path):
    team = _make_team()
    att = RawAttachment(
        filename="<script>.txt", content_type="text/plain", data=b"safe"
    )

    with patch("app.services.agent_service._uploads_dir", return_value=tmp_path):
        _, metas = await validate_and_persist_attachments(team, [att], session_id="sid")

    assert metas[0]["original_name"] == "&lt;script&gt;.txt"


@pytest.mark.asyncio
async def test_validate_and_persist_no_content_type_falls_back_to_extension(tmp_path):
    team = _make_team()
    att = RawAttachment(filename="notes.txt", content_type=None, data=b"hello")

    with patch("app.services.agent_service._uploads_dir", return_value=tmp_path):
        _, metas = await validate_and_persist_attachments(team, [att], session_id="sid")

    assert metas[0]["media_type"] == "application/octet-stream"
    assert metas[0]["category"] == "text"


# ── dispatch_user_message ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_dispatch_generates_sid_when_none():
    team = _make_team()
    sid, n, message_id = await dispatch_user_message(
        team, content="hello", session_id=None
    )
    assert sid and len(sid) > 8
    assert n == 0
    assert message_id == "stub-message-id"
    team.handle_user_message.assert_awaited_once()


@pytest.mark.asyncio
async def test_dispatch_reuses_provided_sid():
    team = _make_team()
    sid, n, message_id = await dispatch_user_message(
        team, content="hi", session_id="my-sid-123"
    )
    assert sid == "my-sid-123"
    assert n == 0
    assert message_id == "stub-message-id"


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
        mention_context_blocks=None,
        mode="normal",
        workspace=None,
        model="openai:gpt-5.5",
        model_provided=True,
        thinking_level="high",
        thinking_level_provided=True,
        service_tier=None,
        mentions=None,
        origin="user",
    )


@pytest.mark.asyncio
async def test_dispatch_with_attachments_uses_fresh_sid_when_session_id_none(tmp_path):
    team = _make_team()
    att = RawAttachment(filename="f.txt", content_type="text/plain", data=b"content")
    with patch("app.services.agent_service._uploads_dir", return_value=tmp_path):
        sid, n, message_id = await dispatch_user_message(
            team, content="hi", session_id=None, attachments=[att]
        )
    assert n == 1
    assert sid and len(sid) > 8
    assert message_id == "stub-message-id"


@pytest.mark.asyncio
async def test_dispatch_with_attachments_prefers_provided_session_id(tmp_path):
    team = _make_team()
    att = RawAttachment(filename="f.txt", content_type="text/plain", data=b"x")
    with patch("app.services.agent_service._uploads_dir", return_value=tmp_path):
        sid, n, message_id = await dispatch_user_message(
            team, content="hi", session_id="existing-123", attachments=[att]
        )
    assert sid == "existing-123"
    assert n == 1
    assert message_id == "stub-message-id"


# ── interrupt_team ────────────────────────────────────────────────────────────


async def test_interrupt_team_waits_for_cancelled_activation_cleanup():
    cleaned_up = asyncio.Event()

    async def active_turn():
        try:
            await asyncio.Event().wait()
        finally:
            cleaned_up.set()

    active_task = asyncio.create_task(active_turn())
    await asyncio.sleep(0)

    working = MagicMock()
    working.state = "working"
    working.name = "worker-a"
    working._active_task = active_task
    working.interrupt.side_effect = active_task.cancel

    team = MagicMock()
    team.members = {}
    team.all_members = [working]
    team.lead.session_id = None

    await interrupt_team(team, session_id=None)

    assert cleaned_up.is_set()
    assert active_task.done()


async def test_interrupt_team_dismisses_an_open_question():
    """Stop outranks a question the lead is parked on.

    Interrupt-only requests never reach ``handle_user_message``, so this is the
    only place a Stop can close the question. Leaving the row open would badge
    the session "needs input" forever with no turn left to resume it, and the
    lead would stay ``waiting_input`` — busy to every caller that asks.
    """
    team = MagicMock()
    team.members = {}
    team.all_members = []
    # The lead is bound to a *different* session than the one being stopped.
    # A coding team is cached per (workspace, session) and rebuilt after the
    # idle window with a freshly minted lead session id; only
    # ``handle_user_message`` rebinds it, and an interrupt-only request returns
    # before that runs. Dismissing "the lead's" question would search a session
    # that has no questions and silently close nothing.
    team.lead.session_id = "019fd000-0000-7000-8000-00000000dead"
    team.dismiss_pending_question = AsyncMock(return_value=True)

    await interrupt_team(team, session_id="019fd791-93ed-753d-8615-799b456708b7")

    team.dismiss_pending_question.assert_awaited_once_with(
        reason="dismissed", session_id="019fd791-93ed-753d-8615-799b456708b7"
    )


async def test_interrupt_team_delivers_done_when_the_turn_state_expired():
    """Stopping a long-suspended question still has to close the turn.

    ``ask_user`` made this reachable: the stream store's TTL slides on every
    event, and a turn parked on a question emits none, so waiting an hour to
    press Stop expires the state while the team is still very much alive.
    ``push_event`` no-ops without it, so the ``done`` would be dropped and the
    pane would stay live with nothing left to end it.
    """
    from app.services.memory_stream_store import _turns

    session_id = "019fd791-93ed-753d-8615-799b456708b7"
    _turns.clear()
    team = MagicMock()
    team.members = {}
    team.all_members = []
    team.lead.session_id = session_id
    team.dismiss_pending_question = AsyncMock(return_value=True)

    try:
        await interrupt_team(team, session_id=session_id)

        assert session_id in _turns
        assert _turns[session_id].is_streaming is False
    finally:
        _turns.clear()


async def test_interrupt_team_survives_a_failed_question_dismissal():
    """Cancelling the run matters more than closing the card."""
    working = MagicMock()
    working.state = "working"
    working.name = "worker-a"
    working._active_task = None

    team = MagicMock()
    team.members = {}
    team.all_members = [working]
    team.lead.session_id = None
    team.dismiss_pending_question = AsyncMock(side_effect=RuntimeError("db gone"))

    names = await interrupt_team(team, session_id=None)

    assert names == ["worker-a"]
    working.interrupt.assert_called_once()


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


@pytest.mark.asyncio
async def test_interrupt_team_publishes_stopped_event():
    idle = MagicMock()
    idle.state = "idle"
    idle.name = "idler"

    team = MagicMock()
    team.members = {}
    team.all_members = [idle]
    team.lead.session_id = None

    with (
        patch("app.services.agent_service.stream_store.push_event", new=AsyncMock()),
        patch("app.services.agent_service.stream_store.mark_done", new=AsyncMock()),
        patch("app.services.event_broadcaster.publish", new=AsyncMock()) as publish,
    ):
        await interrupt_team(team, session_id="sess-1")

    publish.assert_awaited_once_with(
        "session_turn_completed",
        {
            "session_id": "sess-1",
            "status": "stopped",
        },
    )
