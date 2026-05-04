"""Tests for the wiki_search built-in tool."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.agent.errors import ToolArgumentError
from app.agent.tools.builtin.wiki_search import wiki_search
from app.agent.tools.builtin.wiki_search import _wiki_search
from app.services.wiki import write_file


@pytest.fixture(autouse=True)
def _wiki_dir(tmp_path: Path, monkeypatch):
    from app.core.config import settings

    target = tmp_path / "wiki"
    monkeypatch.setattr(settings, "OPENAGENTD_WIKI_DIR", str(target))
    (target / "topics").mkdir(parents=True, exist_ok=True)
    (target / "notes").mkdir(parents=True, exist_ok=True)
    yield target


# ── No wiki dir ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_no_wiki_dir_returns_message(tmp_path: Path, monkeypatch):
    """When the wiki directory doesn't exist, return a clear message."""
    nonexistent = tmp_path / "does_not_exist"
    original = _wiki_search.__globals__["wiki_root"]
    _wiki_search.__globals__["wiki_root"] = lambda: nonexistent
    try:
        result = await _wiki_search(query="anything", top_k=5)
    finally:
        _wiki_search.__globals__["wiki_root"] = original
    assert result == "No wiki directory found."


# ── No topics ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_no_topics_returns_message(_wiki_dir: Path):
    """Empty topics dir should return a descriptive message."""
    result = await _wiki_search(query="jwt auth", top_k=5)
    assert result == "No topic files in wiki yet."


# ── Matching topic ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_matching_topic_returned(_wiki_dir: Path):
    """A topic with keyword overlap should appear in the result."""
    write_file(
        "topics/auth-strategy.md",
        "---\ndescription: JWT authentication strategy for the API\ntags: [auth, jwt]\nupdated: 2026-04-17\n---\n\n# Auth Strategy\nWe use JWTs for all endpoints.\n",
    )
    result = await _wiki_search(query="jwt authentication", top_k=5)
    assert "We use JWTs for all endpoints." in result
    assert "auth-strategy.md" in result


# ── No match ──────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_no_match_returns_no_results_message(_wiki_dir: Path):
    """Query with zero token overlap with any topic returns a no-match message."""
    write_file(
        "topics/deploy.md",
        "---\ndescription: Deployment pipeline for staging and prod\ntags: [deploy, ci]\nupdated: 2026-04-17\n---\n\nDeploy content.\n",
    )
    result = await _wiki_search(query="xyzzy quux frobnicate", top_k=5)
    assert "No wiki topics matched" in result


# ── top_k limit ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_top_k_limits_results(_wiki_dir: Path):
    """With 10 matching topics and top_k=3, only 3 are returned."""
    for i in range(10):
        write_file(
            f"topics/auth-{i}.md",
            f"---\ndescription: JWT auth topic {i} for the API\ntags: [auth, jwt]\nupdated: 2026-04-17\n---\n\n# Auth {i}\nContent {i}.\n",
        )
    result = await _wiki_search(query="jwt auth api", top_k=3)
    full_injected = sum(f"Content {i}." in result for i in range(10))
    assert full_injected == 3


# ── Score in output ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_result_includes_score(_wiki_dir: Path):
    """Output for matched topics must include 'score:' so callers can inspect relevance."""
    write_file(
        "topics/jwt-auth.md",
        "---\ndescription: JWT authentication strategy\ntags: [auth, jwt]\nupdated: 2026-04-17\n---\n\n# JWT Auth\nBody content.\n",
    )
    result = await _wiki_search(query="jwt auth", top_k=5)
    assert "score:" in result


# ── Unsupported methods rejected by schema ────────────────────────────────────


@pytest.mark.asyncio
async def test_meaning_method_rejected_by_tool_schema(_wiki_dir: Path):
    """Semantic search is not exposed until it is implemented."""
    with pytest.raises(ToolArgumentError) as exc_info:
        await wiki_search.arun(query="anything", methods=["meaning"], top_k=5)

    assert "Input should be 'text'" in str(exc_info.value)
