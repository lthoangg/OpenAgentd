"""Tests for the @-mention auto-attachment helper.

``collect_mention_attachments`` turns ``@<path>`` tokens in user messages
into ``RawAttachment`` objects sourced from the session workspace. The
helper must be forgiving (no exceptions for bad paths), capability-aware
(images skipped if the lead has no vision), and bounded (per-message
ceiling + global byte cap).
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from app.api.routes.team._helpers import (
    _extract_mention_paths,
    _safe_join,
    collect_mention_attachments,
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


# ── _extract_mention_paths ───────────────────────────────────────────────────


class TestExtractMentionPaths:
    def test_returns_empty_for_messages_without_at(self):
        assert _extract_mention_paths("plain text") == []
        assert _extract_mention_paths("") == []

    def test_extracts_single_mention(self):
        assert _extract_mention_paths("look at @README.md") == ["README.md"]

    def test_extracts_multiple_distinct_mentions(self):
        out = _extract_mention_paths("compare @a.ts and @b/c.ts please")
        assert out == ["a.ts", "b/c.ts"]

    def test_deduplicates_repeated_mentions(self):
        out = _extract_mention_paths("see @x.ts and again @x.ts")
        assert out == ["x.ts"]

    def test_strips_trailing_punctuation(self):
        # ``,``, ``.``, ``?!`` etc are prose, not path.
        assert _extract_mention_paths("see @README.md, please") == ["README.md"]
        assert _extract_mention_paths("@a.ts?! @b.ts.") == ["a.ts", "b.ts"]

    def test_ignores_email_like(self):
        # ``@`` not preceded by whitespace or string-start → not a mention.
        assert _extract_mention_paths("ping user@host.com") == []

    def test_folder_mentions_resolve_to_agents_md(self):
        assert _extract_mention_paths("look in @src/") == ["src/AGENTS.md"]

    def test_ignores_bare_at(self):
        assert _extract_mention_paths("type @ here") == []

    def test_matches_after_quotes_and_brackets(self):
        # Users routinely write `"@foo.txt"` or `(@foo.txt)`; trailing
        # mirror chars must be stripped so the path resolves cleanly.
        assert _extract_mention_paths('see "@a.ts"') == ["a.ts"]
        assert _extract_mention_paths("(@a.ts)") == ["a.ts"]
        assert _extract_mention_paths("[@a.ts]") == ["a.ts"]
        assert _extract_mention_paths("{@a.ts}") == ["a.ts"]
        assert _extract_mention_paths("'@a.ts'") == ["a.ts"]
        assert _extract_mention_paths(",@a.ts") == ["a.ts"]

    def test_caps_at_max_results(self):
        # 20 mentions max; the 21st must be dropped.
        many = " ".join(f"@f{i}.ts" for i in range(25))
        assert len(_extract_mention_paths(many)) == 20


# ── _safe_join ───────────────────────────────────────────────────────────────


class TestSafeJoin:
    def test_resolves_existing_file(self, tmp_path: Path):
        target = tmp_path / "hello.txt"
        target.write_text("hi", encoding="utf-8")
        assert _safe_join(tmp_path, "hello.txt") == target.resolve()

    def test_rejects_traversal(self, tmp_path: Path):
        # ``../escape.txt`` resolves outside tmp_path → rejected.
        outside = tmp_path.parent / "escape.txt"
        outside.write_text("nope", encoding="utf-8")
        try:
            assert _safe_join(tmp_path, "../escape.txt") is None
        finally:
            outside.unlink(missing_ok=True)

    def test_rejects_absolute_path(self, tmp_path: Path):
        target = tmp_path / "x.txt"
        target.write_text("x", encoding="utf-8")
        # An absolute path is rejected regardless of where it points —
        # mentions are always workspace-relative.
        assert _safe_join(tmp_path, str(target)) is None

    def test_rejects_missing_file(self, tmp_path: Path):
        assert _safe_join(tmp_path, "does-not-exist.txt") is None

    def test_rejects_directory(self, tmp_path: Path):
        (tmp_path / "sub").mkdir()
        # Folders are visual references only — ``_safe_join`` returns
        # ``None`` for directories so ``collect_mention_attachments``
        # silently skips them in its loop.
        assert _safe_join(tmp_path, "sub") is None

    def test_rejects_empty(self, tmp_path: Path):
        assert _safe_join(tmp_path, "") is None


# ── collect_mention_attachments ──────────────────────────────────────────────


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    # Populate a small workspace fixture: two text files and one PNG.
    (tmp_path / "README.md").write_text("# project\n", encoding="utf-8")
    (tmp_path / "notes.txt").write_text("hello", encoding="utf-8")
    (tmp_path / "code.py").write_text("one\ntwo\nthree\nfour\n", encoding="utf-8")
    (tmp_path / "img.png").write_bytes(b"\x89PNG\r\n\x1a\nfake")
    return tmp_path


@pytest.mark.asyncio
async def test_returns_empty_when_no_mentions(workspace):
    team = _make_team()
    out = await collect_mention_attachments(
        message="plain message with no at-symbols",
        team=team,
        session_id="sid",
        workspace=str(workspace),
        existing_total_bytes=0,
    )
    assert out == []


@pytest.mark.asyncio
async def test_attaches_text_file(workspace):
    team = _make_team()
    out = await collect_mention_attachments(
        message="please read @README.md",
        team=team,
        session_id="sid",
        workspace=str(workspace),
        existing_total_bytes=0,
    )
    assert len(out) == 1
    assert out[0].filename == "README.md"
    assert out[0].data == b"# project\n"


@pytest.mark.asyncio
async def test_skips_missing_paths_silently(workspace):
    team = _make_team()
    out = await collect_mention_attachments(
        message="check @does-not-exist.txt and @README.md",
        team=team,
        session_id="sid",
        workspace=str(workspace),
        existing_total_bytes=0,
    )
    # Missing path dropped; existing one still attached.
    assert [a.filename for a in out] == ["README.md"]


@pytest.mark.asyncio
async def test_image_mention_is_never_auto_attached(workspace):
    # Image mentions are visual references only — the agent's vision-aware
    # ``Read`` tool fetches pixels on demand. This keeps base64 image
    # payloads out of every history rehydration.
    team = _make_team(vision=True)
    out = await collect_mention_attachments(
        message="see @img.png and @notes.txt",
        team=team,
        session_id="sid",
        workspace=str(workspace),
        existing_total_bytes=0,
    )
    # PNG dropped regardless of vision capability; text file kept.
    assert [a.filename for a in out] == ["notes.txt"]


@pytest.mark.asyncio
async def test_image_mention_is_skipped_even_without_vision(workspace):
    team = _make_team(vision=False)
    out = await collect_mention_attachments(
        message="see @img.png",
        team=team,
        session_id="sid",
        workspace=str(workspace),
        existing_total_bytes=0,
    )
    assert out == []


@pytest.mark.asyncio
async def test_rejects_path_escape_silently(workspace):
    team = _make_team()
    out = await collect_mention_attachments(
        message="leak @../etc/passwd",
        team=team,
        session_id="sid",
        workspace=str(workspace),
        existing_total_bytes=0,
    )
    assert out == []


@pytest.mark.asyncio
async def test_global_byte_cap_truncates_attachments(workspace, monkeypatch):
    # Force a tiny global cap so a single text file already exceeds it.
    import app.api.routes.team._helpers as helpers

    monkeypatch.setattr(helpers, "GLOBAL_SIZE_LIMIT", 1)
    team = _make_team()
    out = await collect_mention_attachments(
        message="@README.md @notes.txt",
        team=team,
        session_id="sid",
        workspace=str(workspace),
        existing_total_bytes=0,
    )
    # First mention would already exceed the cap → both dropped.
    assert out == []


@pytest.mark.asyncio
async def test_deduplicates_repeated_mentions(workspace):
    team = _make_team()
    out = await collect_mention_attachments(
        message="@README.md and again @README.md",
        team=team,
        session_id="sid",
        workspace=str(workspace),
        existing_total_bytes=0,
    )
    assert len(out) == 1


@pytest.mark.asyncio
async def test_text_mention_carries_truncation_cap(workspace, monkeypatch):
    # Mention pipeline tags its ``RawAttachment``s with the inline cap so
    # the persistence step (in ``agent_service``) can truncate the
    # ``converted_text`` before it reaches the prompt.
    import app.api.routes.team._helpers as helpers

    monkeypatch.setattr(helpers, "_MENTION_INLINE_MAX_CHARS", 1234)
    team = _make_team()
    out = await collect_mention_attachments(
        message="see @notes.txt",
        team=team,
        session_id="sid",
        workspace=str(workspace),
        existing_total_bytes=0,
    )
    assert len(out) == 1
    assert out[0].truncate_inline_to == 1234
    assert out[0].source == "mention"


@pytest.mark.asyncio
async def test_line_mention_attaches_only_selected_lines(workspace):
    team = _make_team()
    out = await collect_mention_attachments(
        message="comment on @code.py#L2-L3",
        team=team,
        session_id="sid",
        workspace=str(workspace),
        existing_total_bytes=0,
    )
    assert len(out) == 1
    assert out[0].filename == "code.py#L2-L3"
    assert out[0].data == b"two\nthree\n"


@pytest.mark.asyncio
async def test_line_mention_supports_extensionless_source_files(tmp_path):
    (tmp_path / "Makefile").write_text("build:\n\ttest\n", encoding="utf-8")
    team = _make_team()
    out = await collect_mention_attachments(
        message="comment on @Makefile#L2",
        team=team,
        session_id="sid",
        workspace=str(tmp_path),
        existing_total_bytes=0,
    )
    assert len(out) == 1
    assert out[0].filename == "Makefile#L2"
    assert out[0].data == b"\ttest\n"


@pytest.mark.asyncio
async def test_folder_mention_attaches_agents_md(tmp_path):
    (tmp_path / "manual").mkdir()
    (tmp_path / "manual" / "AGENTS.md").write_text("docs", encoding="utf-8")
    team = _make_team()
    out = await collect_mention_attachments(
        message="use @manual/ check this",
        team=team,
        session_id="sid",
        workspace=str(tmp_path),
        existing_total_bytes=0,
    )
    assert len(out) == 1
    assert out[0].filename == "manual/AGENTS.md"
    assert out[0].data == b"docs"


@pytest.mark.asyncio
async def test_folder_mention_without_agents_md_is_skipped(tmp_path):
    (tmp_path / "manual").mkdir()
    team = _make_team()
    out = await collect_mention_attachments(
        message="use @manual/ check this",
        team=team,
        session_id="sid",
        workspace=str(tmp_path),
        existing_total_bytes=0,
    )
    assert out == []
