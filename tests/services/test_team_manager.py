"""Tests for app.services.team_manager — lifecycle: start, stop, reload."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services import team_manager


# ── Helpers ───────────────────────────────────────────────────────────────────


def _make_team(name: str = "lead") -> MagicMock:
    team = MagicMock()
    team.start = AsyncMock()
    team.stop = AsyncMock()
    team.lead = MagicMock()
    team.lead.name = name
    team.lead.state = "idle"
    team.members = {}
    # ``all_members`` is consumed by ``_team_is_idle`` during eviction sweeps.
    team.all_members = [team.lead]
    # Snapshot helpers used by _team_snapshot
    agent = MagicMock()
    agent.name = name
    agent.description = "desc"
    agent.model_id = "zai:glm"
    agent._tools = {}
    agent.skills = []
    agent.system_prompt = "sys"
    team.lead.agent = agent
    return team


@pytest.fixture(autouse=True)
async def reset_team_manager():
    """Ensure team_manager._team is None before and after each test."""
    await team_manager.stop()
    yield
    await team_manager.stop()


# ── get_or_start_team() ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_or_start_team_returns_none_when_no_agents(tmp_path, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "AGENTS_DIR", str(tmp_path / "empty"))
    result = await team_manager.get_or_start_team()
    assert result is None
    assert team_manager.current_team() is None


@pytest.mark.asyncio
async def test_get_or_start_team_loads_and_starts_team(monkeypatch):
    fake_team = _make_team()

    monkeypatch.setattr(
        "app.services.team_manager.load_team_from_dir", lambda _: fake_team
    )

    result = await team_manager.get_or_start_team()

    assert result is fake_team
    fake_team.start.assert_awaited_once()
    assert team_manager.current_team() is fake_team


@pytest.mark.asyncio
async def test_get_or_start_team_is_idempotent(monkeypatch):
    """Second call returns the same cached team and does not re-load."""
    fake_team = _make_team()
    monkeypatch.setattr(
        "app.services.team_manager.load_team_from_dir", lambda _: fake_team
    )

    first = await team_manager.get_or_start_team()
    second = await team_manager.get_or_start_team()

    assert first is second
    # start() on the underlying team should only have been called once
    fake_team.start.assert_awaited_once()


@pytest.mark.asyncio
async def test_get_or_start_team_for_session_is_idempotent(monkeypatch):
    fake_team = _make_team()
    monkeypatch.setattr(
        "app.services.team_manager.load_team_from_dir", lambda _: fake_team
    )

    first = await team_manager.get_or_start_team_for_session("session-a")
    second = await team_manager.get_or_start_team_for_session("session-a")

    assert first is second
    assert team_manager._session_teams.get("session-a") is fake_team
    fake_team.start.assert_awaited_once()


@pytest.mark.asyncio
async def test_get_or_start_team_for_session_isolated_by_session(monkeypatch):
    first_team = _make_team("lead-a")
    second_team = _make_team("lead-b")
    teams = iter([first_team, second_team])
    monkeypatch.setattr(
        "app.services.team_manager.load_team_from_dir", lambda _: next(teams)
    )

    first = await team_manager.get_or_start_team_for_session("session-a")
    second = await team_manager.get_or_start_team_for_session("session-b")

    assert first is first_team
    assert second is second_team
    assert first is not second
    first_team.start.assert_awaited_once()
    second_team.start.assert_awaited_once()


@pytest.mark.asyncio
async def test_get_or_start_team_evicts_after_idle(monkeypatch):
    """Team evicts when idle for longer than _DEFAULT_TEAM_IDLE_SECONDS."""
    fake_team = _make_team()
    new_team = _make_team("new-lead")

    teams = iter([fake_team, new_team])
    monkeypatch.setattr(
        "app.services.team_manager.load_team_from_dir", lambda _: next(teams)
    )
    # Force an aggressive eviction window so the test runs instantly.
    monkeypatch.setattr(team_manager, "_DEFAULT_TEAM_IDLE_SECONDS", 0)

    first = await team_manager.get_or_start_team()
    assert first is fake_team

    # Idle eviction applies on the next call (opportunistic sweep).
    second = await team_manager.get_or_start_team()
    fake_team.stop.assert_awaited_once()
    assert second is new_team


@pytest.mark.asyncio
async def test_get_or_start_team_skips_eviction_when_working(monkeypatch):
    """Working teams are not evicted even past the idle window."""
    fake_team = _make_team()
    fake_team.lead.state = "working"

    monkeypatch.setattr(
        "app.services.team_manager.load_team_from_dir", lambda _: fake_team
    )
    monkeypatch.setattr(team_manager, "_DEFAULT_TEAM_IDLE_SECONDS", 0)

    first = await team_manager.get_or_start_team()
    second = await team_manager.get_or_start_team()
    assert first is second
    fake_team.stop.assert_not_called()


# ── validate_agents_dir() ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_validate_agents_dir_false_when_empty(tmp_path, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "AGENTS_DIR", str(tmp_path / "empty"))
    monkeypatch.setattr("app.services.team_manager.load_team_from_dir", lambda _: None)

    assert team_manager.validate_agents_dir() is False
    # Does not cache a team.
    assert team_manager.current_team() is None


@pytest.mark.asyncio
async def test_validate_agents_dir_true_when_loadable(monkeypatch):
    fake_team = _make_team()
    monkeypatch.setattr(
        "app.services.team_manager.load_team_from_dir", lambda _: fake_team
    )

    assert team_manager.validate_agents_dir() is True
    # Validation does NOT start the team — that happens lazily on first request.
    fake_team.start.assert_not_called()
    assert team_manager.current_team() is None


@pytest.mark.asyncio
async def test_validate_agents_dir_raises_on_parse_error(monkeypatch):
    def fail(_):
        raise ValueError("malformed agent.md")

    monkeypatch.setattr("app.services.team_manager.load_team_from_dir", fail)

    with pytest.raises(ValueError, match="malformed agent.md"):
        team_manager.validate_agents_dir()


# ── stop() ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_stop_clears_team(monkeypatch):
    fake_team = _make_team()
    monkeypatch.setattr(
        "app.services.team_manager.load_team_from_dir", lambda _: fake_team
    )

    await team_manager.get_or_start_team()
    assert team_manager.current_team() is not None

    await team_manager.stop()
    assert team_manager.current_team() is None
    fake_team.stop.assert_awaited_once()


@pytest.mark.asyncio
async def test_stop_when_no_team_is_noop():
    # No exception should be raised when called with no active team
    await team_manager.stop()
    assert team_manager.current_team() is None


@pytest.mark.asyncio
async def test_evict_session_teams_stops_normal_and_coding_teams(tmp_path):
    normal = _make_team("normal")
    coding = _make_team("coding")
    session_id = "deleted-session"
    team_manager._session_teams[session_id] = normal
    team_manager._session_team_last_used[session_id] = 1
    team_manager._coding_teams[(str(tmp_path), session_id)] = coding
    team_manager._coding_team_last_used[(str(tmp_path), session_id)] = 1

    await team_manager.evict_session_teams({session_id})

    normal.stop.assert_awaited_once()
    coding.stop.assert_awaited_once()
    assert team_manager._session_teams.get(session_id) is None
    assert team_manager._coding_teams.get((str(tmp_path), session_id)) is None


@pytest.mark.asyncio
async def test_stop_clears_coding_teams_without_normal_team(tmp_path, monkeypatch):
    from app.core.config import settings

    workspace = tmp_path / "project"
    workspace.mkdir()
    monkeypatch.setattr(settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path / "config"))
    fake_team = _make_team("coding-lead")
    monkeypatch.setattr(
        "app.services.team_manager.load_team_from_dir",
        lambda *args, **kwargs: fake_team,
    )

    await team_manager.get_or_start_coding_team(str(workspace), "session-a")
    await team_manager.stop()

    fake_team.stop.assert_awaited_once()
    assert not any(
        stored_workspace == str(workspace.resolve())
        for stored_workspace, _session_id in team_manager._coding_teams
    )


@pytest.mark.asyncio
async def test_stop_swallows_exception_from_team_stop(monkeypatch):
    """stop() logs the exception but still clears the team reference."""
    fake_team = _make_team()
    fake_team.stop = AsyncMock(side_effect=RuntimeError("teardown failed"))

    monkeypatch.setattr(
        "app.services.team_manager.load_team_from_dir", lambda _: fake_team
    )
    await team_manager.get_or_start_team()

    # Should not raise even though team.stop() blows up
    await team_manager.stop()

    # Team reference must be cleared despite the error
    assert team_manager.current_team() is None


# ── reload() ──────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_reload_raises_when_no_agents_found(tmp_path, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "AGENTS_DIR", str(tmp_path / "empty"))
    monkeypatch.setattr("app.services.team_manager.load_team_from_dir", lambda _: None)

    with pytest.raises(ValueError, match="No agents found"):
        await team_manager.reload()


@pytest.mark.asyncio
async def test_reload_swaps_in_new_team(monkeypatch):
    old_team = _make_team("old-lead")
    new_team = _make_team("new-lead")

    call_count = 0

    def fake_load(_):
        nonlocal call_count
        call_count += 1
        return old_team if call_count == 1 else new_team

    monkeypatch.setattr("app.services.team_manager.load_team_from_dir", fake_load)

    await team_manager.get_or_start_team()
    assert team_manager.current_team() is old_team

    diff = await team_manager.reload()

    assert team_manager.current_team() is new_team
    old_team.stop.assert_awaited_once()
    new_team.start.assert_awaited_once()
    assert diff.lead == "new-lead"


@pytest.mark.asyncio
async def test_reload_keeps_new_team_even_when_old_stop_raises(monkeypatch):
    """Old team's stop() error must not prevent new team from going live."""
    old_team = _make_team("old-lead")
    old_team.stop = AsyncMock(side_effect=RuntimeError("stop error"))
    new_team = _make_team("new-lead")

    call_count = 0

    def fake_load(_):
        nonlocal call_count
        call_count += 1
        return old_team if call_count == 1 else new_team

    monkeypatch.setattr("app.services.team_manager.load_team_from_dir", fake_load)

    await team_manager.get_or_start_team()

    # Should not raise; new team should be live
    diff = await team_manager.reload()

    assert team_manager.current_team() is new_team
    assert diff.lead == "new-lead"


@pytest.mark.asyncio
async def test_reload_leaves_old_team_on_validation_failure(monkeypatch):
    """If load_team_from_dir raises, the running team is untouched."""
    old_team = _make_team("old-lead")

    call_count = 0

    def fake_load(_):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return old_team
        raise ValueError("bad config file")

    monkeypatch.setattr("app.services.team_manager.load_team_from_dir", fake_load)

    await team_manager.get_or_start_team()

    with pytest.raises(ValueError, match="bad config file"):
        await team_manager.reload()

    # Old team must still be running
    assert team_manager.current_team() is old_team
    old_team.stop.assert_not_awaited()


@pytest.mark.asyncio
async def test_get_or_start_coding_team_uses_agents_dir_coding_agents(
    tmp_path, monkeypatch
):
    from app.core.config import settings

    workspace = tmp_path / "project"
    workspace.mkdir()
    agents_dir = tmp_path / "custom-agents"
    monkeypatch.setattr(settings, "AGENTS_DIR", str(agents_dir))
    fake_team = _make_team("coding-lead")

    seen: dict[str, object] = {}

    def fake_load(path, **kwargs):
        seen["path"] = path
        seen.update(kwargs)
        return fake_team

    monkeypatch.setattr("app.services.team_manager.load_team_from_dir", fake_load)

    result = await team_manager.get_or_start_coding_team(str(workspace), "session-a")

    assert result is fake_team
    assert seen["path"] == agents_dir / "coding"
    assert seen["mode"] == "coding"
    assert seen["workspace"] == str(workspace.resolve())


@pytest.mark.asyncio
async def test_get_or_start_coding_team_isolated_by_session(tmp_path, monkeypatch):
    workspace = tmp_path / "project"
    workspace.mkdir()
    first_team = _make_team("coding-a")
    second_team = _make_team("coding-b")
    teams = iter([first_team, second_team])
    monkeypatch.setattr(
        "app.services.team_manager.load_team_from_dir",
        lambda *args, **kwargs: next(teams),
    )

    first = await team_manager.get_or_start_coding_team(str(workspace), "session-a")
    second = await team_manager.get_or_start_coding_team(str(workspace), "session-b")

    assert first is first_team
    assert second is second_team
    assert first is not second
    assert (
        team_manager._coding_teams.get((str(workspace.resolve()), "session-a"))
        is first_team
    )
    assert (
        team_manager._coding_teams.get((str(workspace.resolve()), "session-b"))
        is second_team
    )


# ── refresh_blueprints() ──────────────────────────────────────────────────────
#
# Without this rediscovery step, a member ``.md`` file created via Settings →
# Agents wouldn't appear in the spawnable roster until the team object is
# evicted (typically a server restart) because ``team.blueprints`` is frozen
# at ``load_team_from_dir`` time.  These tests pin the contract.


def _write_member_md(path, name: str) -> None:
    path.write_text(
        f"---\nname: {name}\nrole: member\nmodel: zai:glm-5-turbo\n"
        f"description: {name} agent\n---\nbody\n",
        encoding="utf-8",
    )


def _make_real_team(lead_name: str = "lead"):
    """Build a real (not mock) ``AgentTeam`` so ``refresh_blueprints`` can
    mutate ``team.blueprints`` and we can read it back."""
    from app.agent.agent_loop import Agent
    from app.agent.mode.team.member import TeamLead
    from app.agent.mode.team.team import AgentTeam
    from tests.api.routes.test_team_routes_extra import MockProvider

    lead = TeamLead(
        Agent(name=lead_name, llm_provider=MockProvider(), system_prompt="Lead")
    )
    return AgentTeam(lead=lead)


def test_refresh_blueprints_adds_new_member_file(tmp_path, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "AGENTS_DIR", str(tmp_path))
    team = _make_real_team()
    assert team.blueprints == {}

    _write_member_md(tmp_path / "executor.md", "executor")
    team_manager.refresh_blueprints(team)

    assert "executor" in team.blueprints
    assert team.blueprints["executor"].source_path == tmp_path / "executor.md"
    assert team.blueprints["executor"].description == "executor agent"


def test_refresh_blueprints_reuses_unchanged_parsed_configs_and_invalidates_changes(
    tmp_path, monkeypatch
):
    """Unchanged files are parsed once; file mutations still refresh discovery."""
    from app.agent import loader
    from app.core.config import settings

    monkeypatch.setattr(settings, "AGENTS_DIR", str(tmp_path))
    team = _make_real_team()
    member = tmp_path / "executor.md"
    _write_member_md(member, "executor")
    parse_calls = 0
    original_parse = loader.parse_agent_md

    def count_parse(path: Path):
        nonlocal parse_calls
        parse_calls += 1
        return original_parse(path)

    monkeypatch.setattr(loader, "parse_agent_md", count_parse)

    team_manager.refresh_blueprints(team)
    team_manager.refresh_blueprints(team)
    assert parse_calls == 1

    member.write_text(
        member.read_text(encoding="utf-8").replace("executor agent", "updated agent"),
        encoding="utf-8",
    )
    team_manager.refresh_blueprints(team)
    assert parse_calls == 2
    assert "executor" in team.blueprints  # existing edited blueprints stay stable

    renamed = tmp_path / "renamed.md"
    member.rename(renamed)
    team_manager.refresh_blueprints(team)
    assert parse_calls == 3
    assert team.blueprints["executor"].source_path == renamed

    renamed.unlink()
    team_manager.refresh_blueprints(team)
    assert "executor" not in team.blueprints

    _write_member_md(tmp_path / "new.md", "new")
    team_manager.refresh_blueprints(team)
    assert parse_calls == 4
    assert "new" in team.blueprints


def test_refresh_blueprints_removes_blueprint_when_file_deleted(tmp_path, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "AGENTS_DIR", str(tmp_path))
    team = _make_real_team()
    _write_member_md(tmp_path / "executor.md", "executor")
    team_manager.refresh_blueprints(team)
    assert "executor" in team.blueprints

    (tmp_path / "executor.md").unlink()
    team_manager.refresh_blueprints(team)

    assert "executor" not in team.blueprints


def test_refresh_blueprints_keeps_removed_blueprint_with_live_instance(
    tmp_path, monkeypatch
):
    """A blueprint with a still-running instance must survive removal so
    the in-flight conversation can keep addressing the agent by handle."""
    from app.agent.agent_loop import Agent
    from app.agent.mode.team.member import TeamMember
    from app.core.config import settings
    from tests.api.routes.test_team_routes_extra import MockProvider

    monkeypatch.setattr(settings, "AGENTS_DIR", str(tmp_path))
    team = _make_real_team()
    _write_member_md(tmp_path / "executor.md", "executor")
    team_manager.refresh_blueprints(team)

    # Simulate a live instance spawned from the blueprint.
    instance = TeamMember(
        Agent(name="executor#1", llm_provider=MockProvider(), system_prompt="Worker")
    )
    team.members["executor#1"] = instance
    team._members_by_name["executor#1"] = instance

    (tmp_path / "executor.md").unlink()
    team_manager.refresh_blueprints(team)

    assert "executor" in team.blueprints  # kept because instance is live


def test_refresh_blueprints_skips_lead_file(tmp_path, monkeypatch):
    """The lead's lifecycle is owned by ``reload``; ``refresh_blueprints``
    must never register the lead as a member blueprint."""
    from app.core.config import settings

    monkeypatch.setattr(settings, "AGENTS_DIR", str(tmp_path))
    team = _make_real_team()
    (tmp_path / "lead.md").write_text(
        "---\nname: some-lead\nrole: lead\n---\nbody\n", encoding="utf-8"
    )

    team_manager.refresh_blueprints(team)

    assert team.blueprints == {}


def test_refresh_blueprints_skips_unconfigured_members(tmp_path, monkeypatch):
    from app.core.config import PROVIDER_MODEL_TOKEN
    from app.core.config import settings

    monkeypatch.setattr(settings, "AGENTS_DIR", str(tmp_path))
    team = _make_real_team()
    _write_member_md(tmp_path / "configured.md", "configured")
    (tmp_path / "placeholder.md").write_text(
        f"---\nname: placeholder\nrole: member\nmodel: {PROVIDER_MODEL_TOKEN}\n---\nbody\n",
        encoding="utf-8",
    )
    (tmp_path / "blank.md").write_text(
        '---\nname: blank\nrole: member\nmodel: ""\n---\nbody\n',
        encoding="utf-8",
    )
    (tmp_path / "missing.md").write_text(
        "---\nname: missing\nrole: member\n---\nbody\n",
        encoding="utf-8",
    )

    team_manager.refresh_blueprints(team)

    assert set(team.blueprints) == {"configured"}


def test_refresh_blueprints_swallows_parse_errors(tmp_path, monkeypatch):
    """A malformed new file must not 500 the listing endpoint — log and
    skip, processing the rest of the directory."""
    from app.core.config import settings

    monkeypatch.setattr(settings, "AGENTS_DIR", str(tmp_path))
    team = _make_real_team()
    # Missing frontmatter → ``parse_agent_md`` raises.
    (tmp_path / "broken.md").write_text("no frontmatter here", encoding="utf-8")
    _write_member_md(tmp_path / "good.md", "good")

    team_manager.refresh_blueprints(team)  # must not raise

    assert "good" in team.blueprints
    assert "broken" not in team.blueprints


def test_refresh_blueprints_noop_when_agents_dir_missing(tmp_path, monkeypatch):
    """Missing dir is a valid state (fresh checkout, dev environment) —
    must not raise."""
    from app.core.config import settings

    monkeypatch.setattr(settings, "AGENTS_DIR", str(tmp_path / "does-not-exist"))
    team = _make_real_team()

    team_manager.refresh_blueprints(team)  # must not raise

    assert team.blueprints == {}


# ── validate_workspace security denylist ─────────────────────────────────────


def test_validate_workspace_accepts_regular_directory(tmp_path):
    """A normal directory that exists is accepted and returned as a string."""
    result = team_manager.validate_workspace(str(tmp_path))
    assert result == str(tmp_path.resolve())


def test_validate_workspace_rejects_missing_directory(tmp_path):
    """A path that does not exist raises ValueError."""
    with pytest.raises(ValueError, match="does not exist"):
        team_manager.validate_workspace(str(tmp_path / "missing"))


def test_validate_workspace_rejects_file_path(tmp_path):
    """A path that points to a file (not a directory) raises ValueError."""
    f = tmp_path / "file.txt"
    f.write_text("x")
    with pytest.raises(ValueError, match="does not exist or is not a directory"):
        team_manager.validate_workspace(str(f))


@pytest.mark.parametrize(
    "blocked",
    [
        "/etc",
        "/proc",
        "/sys",
        "/dev",
        "/run",
        "/boot",
        "/sbin",
        "/bin",
        "/usr/bin",
        "/usr/sbin",
        "/private/etc",  # macOS symlink for /etc
    ],
)
def test_validate_workspace_rejects_blocked_system_paths(blocked):
    """Paths inside well-known system directories are rejected even if they exist."""
    blocked_path = Path(blocked)
    # Only test paths that actually exist on this OS — skip others silently.
    if not blocked_path.is_dir():
        pytest.skip(f"{blocked} is not a directory on this system")

    with pytest.raises(ValueError, match="restricted system directory"):
        team_manager.validate_workspace(blocked)


def test_validate_workspace_expands_home_tilde(tmp_path):
    """~-prefixed paths are expanded to absolute before validation."""
    # We can't easily override Path.home() for expanduser, so test that a
    # tilde path resolves without error when the target exists — the resolved
    # path must be absolute and a directory.
    home = Path.home()
    if not home.is_dir():
        pytest.skip("home directory not available")
    result = team_manager.validate_workspace("~")
    assert Path(result).is_absolute()
    assert Path(result).is_dir()
