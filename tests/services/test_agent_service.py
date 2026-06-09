"""Tests for app.services.agent_service — attachment validation + dispatch."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.agent_service import (
    GLOBAL_SIZE_LIMIT,
    AttachmentError,
    NoTeamConfigured,
    RawAttachment,
    _default_ext,
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
    assert meta["converted_text"] == "hello world"
    assert meta["original_name"] == "notes.txt"
    # The saved file should exist on disk
    saved = tmp_path / meta["filename"]
    assert saved.is_file()
    assert saved.read_bytes() == content
    # ``path`` is the absolute on-disk location persisted for rehydration —
    # see ``app/agent/multimodal.py`` ``build_parts_from_metas``.
    assert meta["path"] == str(saved)
    assert meta["workspace_path"] == str(saved)
    assert Path(meta["path"]).is_file()


@pytest.mark.asyncio
async def test_validate_and_persist_mints_sid_when_session_id_none(tmp_path):
    team = _make_team()
    att = RawAttachment(filename="a.txt", content_type="text/plain", data=b"hi")
    with patch("app.services.agent_service._uploads_dir", return_value=tmp_path):
        sid, metas = await validate_and_persist_attachments(team, [att])
    # Should be a non-empty UUID-like string
    assert sid and len(sid) > 10
    # Meta carries the absolute on-disk path — rehydration relies on it
    # (no longer derived from message ``session_id``).
    assert len(metas) == 1
    assert "path" in metas[0]
    assert Path(metas[0]["path"]).is_file()


@pytest.mark.asyncio
async def test_validate_and_persist_uses_provided_session_id(tmp_path):
    """When ``session_id`` is supplied the function reuses it verbatim
    instead of minting a fresh one — uploads land under the chat
    session's workspace."""
    team = _make_team()
    att = RawAttachment(filename="a.txt", content_type="text/plain", data=b"hi")
    with patch("app.services.agent_service._uploads_dir", return_value=tmp_path):
        sid, metas = await validate_and_persist_attachments(
            team, [att], session_id="existing-sid-xyz"
        )
    assert sid == "existing-sid-xyz"
    assert len(metas) == 1


# ── _maybe_truncate_inline (head + tail window) ───────────────────────────────


@pytest.mark.asyncio
async def test_paperclip_upload_text_is_not_truncated(tmp_path):
    """Explicit uploads leave ``truncate_inline_to`` ``None`` — the full
    body reaches the prompt regardless of size."""
    team = _make_team()
    long_text = "x" * 50_000
    att = RawAttachment(
        filename="big.txt", content_type="text/plain", data=long_text.encode()
    )
    with patch("app.services.agent_service._uploads_dir", return_value=tmp_path):
        _, metas = await validate_and_persist_attachments(team, [att])
    assert metas[0]["converted_text"] == long_text
    assert "Middle truncated" not in metas[0]["converted_text"]


@pytest.mark.asyncio
async def test_mention_text_is_head_tail_truncated_at_cap(tmp_path):
    """A mention-sourced attachment passes ``truncate_inline_to`` so the
    persistence step caps the inlined text with a head + tail window."""
    team = _make_team()
    # Use a distinguishable body so we can verify head/tail slices land
    # on the right characters. 1000 chars total, cap 200 → 100 head + 100 tail.
    body = ("A" * 500) + ("B" * 500)
    att = RawAttachment(
        filename="m.txt",
        content_type="text/plain",
        data=body.encode(),
        truncate_inline_to=200,
    )
    with patch("app.services.agent_service._uploads_dir", return_value=tmp_path):
        _, metas = await validate_and_persist_attachments(team, [att])
    out = metas[0]["converted_text"]
    # Head: first 100 chars (all 'A'). Tail: last 100 chars (all 'B').
    assert out.startswith("A" * 100)
    assert out.endswith("B" * 100)
    # Middle marker reports the omitted char count and points at Read.
    assert "Middle truncated" in out
    assert "800 chars elided" in out
    assert "Read tool" in out


@pytest.mark.asyncio
async def test_mention_text_below_cap_is_unchanged(tmp_path):
    """The cap is only applied when the body exceeds it — short
    mentions pass through verbatim."""
    team = _make_team()
    body = "short content"
    att = RawAttachment(
        filename="m.txt",
        content_type="text/plain",
        data=body.encode(),
        truncate_inline_to=1000,
    )
    with patch("app.services.agent_service._uploads_dir", return_value=tmp_path):
        _, metas = await validate_and_persist_attachments(team, [att])
    assert metas[0]["converted_text"] == body


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
