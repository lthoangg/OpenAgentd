"""Tests for app.services.agent_manager."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services import agent_manager


def _make_session(name: str = "openagentd") -> MagicMock:
    session = MagicMock()
    session.start = AsyncMock()
    session.stop = AsyncMock()
    session.attach_to_session = AsyncMock()
    session.name = name
    session.state = "idle"
    session.is_busy = MagicMock(return_value=False)
    session.workspace = "/tmp/test"
    session.session_id = "test-session"
    return session


@pytest.fixture(autouse=True)
async def reset_agent_manager():
    await agent_manager.stop()
    agent_manager.reset_agents_dir_validation_cache()
    yield
    agent_manager.reset_agents_dir_validation_cache()
    await agent_manager.stop()


# ── validate_workspace() ──────────────────────────────────────────────────────


def test_validate_workspace_resolves_valid_directory(tmp_path):
    res = agent_manager.validate_workspace(str(tmp_path))
    assert res == str(tmp_path.resolve())


def test_validate_workspace_raises_for_missing_dir(tmp_path):
    with pytest.raises(ValueError, match="does not exist"):
        agent_manager.validate_workspace(str(tmp_path / "missing"))


def test_validate_workspace_allows_nonexistent_when_require_exists_false(tmp_path):
    missing = tmp_path / "missing"
    res = agent_manager.validate_workspace(str(missing), require_exists=False)
    assert res == str(missing.resolve())


def test_validate_workspace_rejects_restricted_system_directories():
    with pytest.raises(ValueError, match="restricted system directory"):
        agent_manager.validate_workspace("/etc", require_exists=False)


# ── validate_agents_dir() ────────────────────────────────────────────────────


def test_validate_agents_dir_returns_false_for_missing_dir(tmp_path):
    assert agent_manager.validate_agents_dir(tmp_path / "missing") is False


def test_validate_agents_dir_returns_false_for_empty_dir(tmp_path):
    empty = tmp_path / "empty"
    empty.mkdir()
    assert agent_manager.validate_agents_dir(empty) is False


def test_validate_agents_dir_returns_true_when_md_present(tmp_path):
    agents = tmp_path / "agents"
    agents.mkdir()
    (agents / "code.md").write_text("---\nname: code\n---\nPrompt", encoding="utf-8")
    assert agent_manager.validate_agents_dir(agents) is True


def test_validate_agents_dir_requires_valid_canonical_code_profile(tmp_path):
    agents = tmp_path / "agents"
    agents.mkdir()
    (agents / "other.md").write_text("---\nname: other\n---\nPrompt", encoding="utf-8")
    assert agent_manager.validate_agents_dir(agents) is False

    (agents / "code.md").write_text("not frontmatter", encoding="utf-8")
    with pytest.raises(ValueError, match="missing frontmatter"):
        agent_manager.validate_agents_dir(agents)

    (agents / "code.md").write_text(
        "---\nmodel: zai:glm-5-turbo\n---\nPrompt", encoding="utf-8"
    )
    with pytest.raises(ValueError, match="must declare name 'code'"):
        agent_manager.validate_agents_dir(agents)


@pytest.mark.asyncio
async def test_evict_idle_sessions_skips_busy_and_waiting(tmp_path, monkeypatch):
    idle = _make_session()
    idle.session_id = "idle"
    idle.workspace = str(tmp_path.resolve())
    busy = _make_session()
    busy.session_id = "busy"
    busy.workspace = str(tmp_path.resolve())
    busy.is_busy.return_value = True
    waiting = _make_session()
    waiting.session_id = "waiting"
    waiting.state = "waiting_input"
    waiting.workspace = str(tmp_path.resolve())
    agent_manager.set_agent_session(None)
    agent_manager._sessions[("/idle", "idle")] = idle
    agent_manager._sessions[("/busy", "busy")] = busy
    agent_manager._sessions[("/waiting", "waiting")] = waiting
    agent_manager._session_last_used[("/idle", "idle")] = 1
    agent_manager._session_last_used[("/busy", "busy")] = 1
    agent_manager._session_last_used[("/waiting", "waiting")] = 1
    monkeypatch.setattr(agent_manager, "_SESSION_IDLE_SECONDS", 10)

    await agent_manager.evict_idle_sessions(now=20)

    assert ("/idle", "idle") not in agent_manager._sessions
    assert ("/busy", "busy") in agent_manager._sessions
    assert ("/waiting", "waiting") in agent_manager._sessions
    idle.stop.assert_awaited_once()
    busy.stop.assert_not_awaited()
    waiting.stop.assert_not_awaited()


# ── get_or_start_agent_session() ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_or_start_agent_session_starts_and_caches_session(
    tmp_path, monkeypatch
):
    fake_session = _make_session()
    fake_session.workspace = str(tmp_path.resolve())
    fake_session.session_id = "sess-1"

    monkeypatch.setattr(
        "app.services.agent_manager.load_agent_from_dir",
        lambda *args, **kwargs: fake_session,
    )
    agent_manager.set_agent_session(None)

    res = await agent_manager.get_or_start_agent_session(str(tmp_path), "sess-1")
    assert res is fake_session
    fake_session.start.assert_awaited_once()

    # Second call returns cached session
    res2 = await agent_manager.get_or_start_agent_session(str(tmp_path), "sess-1")
    assert res2 is fake_session


@pytest.mark.asyncio
async def test_find_live_session(tmp_path):
    session = _make_session()
    session.workspace = str(tmp_path.resolve())
    session.session_id = "sess-1"

    agent_manager.set_agent_session(session)
    found = agent_manager.find_live_session(str(tmp_path), "sess-1")
    assert found is session


@pytest.mark.asyncio
async def test_stop_stops_all_sessions(tmp_path):
    session = _make_session()
    session.workspace = str(tmp_path.resolve())
    session.session_id = "sess-1"

    agent_manager.set_agent_session(session)
    await agent_manager.stop()
    session.stop.assert_awaited_once()
