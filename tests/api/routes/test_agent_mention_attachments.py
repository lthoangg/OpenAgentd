"""Tests for @-mention path parsing and best-effort file helper behavior.

Mentioned paths are parsed against the session workspace. File mentions can be
converted into ephemeral inline context blocks for the model, but they are not
persisted as uploads or attachment metadata. Folder mentions stay references at
parse time and are expanded only by the explicit mention-context builder.
"""

from __future__ import annotations

import pytest

from app.api.routes.agent._helpers import (
    _build_directory_listing_block,
    _build_mention_text_block,
    _maybe_truncate_inline,
    build_mention_context_blocks,
)
from app.services.agent_service import RawAttachment


@pytest.mark.asyncio
async def test_build_mention_context_blocks_inlines_file_content(tmp_path):
    (tmp_path / "README.md").write_text("# project", encoding="utf-8")
    out = await build_mention_context_blocks(
        message="read @README.md",
        session_id="sid",
        workspace=str(tmp_path),
        existing_total_bytes=0,
        mentions=["README.md"],
    )
    assert len(out) == 1
    assert out[0].startswith("[File: README.md]")
    assert "# project" in out[0]


@pytest.mark.asyncio
async def test_build_mention_context_blocks_lists_directory(tmp_path):
    (tmp_path / "manual").mkdir()
    (tmp_path / "manual" / "a.txt").write_text("a", encoding="utf-8")
    (tmp_path / "manual" / "sub").mkdir()
    out = await build_mention_context_blocks(
        message="inspect @manual/",
        session_id="sid",
        workspace=str(tmp_path),
        existing_total_bytes=0,
        mentions=["manual/"],
    )
    assert len(out) == 1
    assert out[0].startswith("[Directory: manual/]")
    assert "- sub/" in out[0]
    assert "- a.txt" in out[0]


def test_build_directory_listing_block_marks_empty_directory(tmp_path):
    (tmp_path / "empty").mkdir()
    block = _build_directory_listing_block("empty/", tmp_path / "empty")
    assert block == "[Directory: empty/]\n[Empty directory]\n[End directory: empty/]"


# ── _build_mention_text_block ─────────────────────────────────────────────────


def test_build_mention_text_block_utf8():
    att = RawAttachment(filename="notes.txt", content_type="text/plain", data=b"hello")
    out = _build_mention_text_block(att, "notes.txt")
    assert out == "[File: notes.txt]\nhello\n[End file: notes.txt]"


def test_build_mention_text_block_latin1_fallback():
    att = RawAttachment(
        filename="latin.txt", content_type="text/plain", data="café".encode("latin-1")
    )
    out = _build_mention_text_block(att, "latin.txt")
    assert "café" in out
    assert out.startswith("[File: latin.txt]")


def test_build_mention_text_block_decode_failure():
    class Undecodable(bytes):
        def decode(self, encoding="utf-8", errors="strict"):
            raise UnicodeDecodeError(encoding, b"x", 0, 1, "boom")

    att = RawAttachment(
        filename="bad.bin",
        content_type="application/octet-stream",
        data=Undecodable(b"x"),
    )
    out = _build_mention_text_block(att, "bad.bin")
    assert out == "[Unable to read file bad.bin.]"


def test_build_mention_text_block_line_ref_label():
    att = RawAttachment(
        filename="app.py#L10-L20", content_type="text/plain", data=b"print('x')"
    )
    out = _build_mention_text_block(att, "app.py#L10-L20")
    assert "selected lines already loaded" in out
    assert "use this block directly" in out
    assert "print('x')" in out


def test_build_mention_text_block_respects_truncate_inline_to():
    body = ("A" * 500) + ("B" * 500)
    att = RawAttachment(
        filename="big.txt",
        content_type="text/plain",
        data=body.encode(),
        truncate_inline_to=200,
    )
    out = _build_mention_text_block(att, "big.txt")
    assert "A" * 100 in out
    assert "B" * 100 in out
    assert "Middle truncated" in out
    assert "800 chars elided" in out
    assert "Read tool" in out


def test_build_mention_text_block_no_truncation_when_under_cap():
    body = "short"
    att = RawAttachment(
        filename="s.txt",
        content_type="text/plain",
        data=body.encode(),
        truncate_inline_to=1000,
    )
    out = _build_mention_text_block(att, "s.txt")
    assert body in out
    assert "truncated" not in out.lower()


# ── _maybe_truncate_inline ────────────────────────────────────────────────────


def test_maybe_truncate_inline_passthrough_when_no_cap():
    text = "x" * 1000
    assert _maybe_truncate_inline(text, None) == text


def test_maybe_truncate_inline_passthrough_when_under_cap():
    text = "hello"
    assert _maybe_truncate_inline(text, 100) == text


def test_maybe_truncate_inline_head_tail_and_marker():
    out = _maybe_truncate_inline("0123456789", 4)
    assert out.startswith("01")
    assert out.endswith("89")
    assert "6 chars elided" in out
    assert "Read tool" in out
