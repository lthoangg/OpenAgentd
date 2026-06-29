"""Tests for @-mention path parsing and best-effort file helper behavior.

Mentioned paths are parsed against the session workspace. File mentions can be
converted into ephemeral inline context blocks for the model, but they are not
persisted as uploads or attachment metadata. Folder mentions stay references at
parse time and are expanded only by the explicit mention-context builder.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from app.api.routes.team._helpers import (
    _build_directory_listing_block,
    build_mention_context_blocks,
)


def _make_team(*, vision: bool = True, document_text: bool = True) -> MagicMock:
    caps = MagicMock()
    caps.input.vision = vision
    caps.input.document_text = document_text
    agent = MagicMock()
    agent.capabilities = caps
    lead = MagicMock()
    lead.agent = agent
    team = MagicMock()
    team.lead = lead
    return team


@pytest.mark.asyncio
async def test_build_mention_context_blocks_inlines_file_content(tmp_path):
    (tmp_path / "README.md").write_text("# project", encoding="utf-8")
    team = _make_team()
    out = await build_mention_context_blocks(
        message="read @README.md",
        team=team,
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
    team = _make_team()
    out = await build_mention_context_blocks(
        message="inspect @manual/",
        team=team,
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
