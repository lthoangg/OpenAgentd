"""Tests for app.services.team_manager — lifecycle: start, stop, reload."""

from __future__ import annotations

import asyncio
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
    """Ensure team_manager._team is None before and after each test.

    Also clears the ``validate_agents_dir`` signature cache — it is
    module-level state, and tests run in random order across parallel
    workers, so a cached result must never leak between them.
    """
    await team_manager.stop()
    team_manager.reset_agents_dir_validation_cache()
    yield
    team_manager.reset_agents_dir_validation_cache()
    await team_manager.stop()


@pytest.fixture(autouse=True)
def coding_workspace_agents_dir(monkeypatch):
    """Use each test's real temporary AGENTS_DIR as coding config root."""
    from app.core.config import settings

    monkeypatch.setattr(
        team_manager,
        "_resolve_coding_agents_dir",
        lambda: Path(settings.AGENTS_DIR).expanduser().resolve(),
    )


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


async def test_coding_team_eviction_removes_start_lock(tmp_path):
    key = (str(tmp_path), "expired-session")
    team_manager._coding_teams[key] = _make_team()
    team_manager._coding_team_last_used[key] = 0
    team_manager._coding_start_locks[key] = asyncio.Lock()

    expired = team_manager._pop_idle_coding_teams_locked(float("inf"))

    assert expired
    assert key not in team_manager._coding_start_locks


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
async def test_evict_session_teams_stops_coding_teams(tmp_path):
    coding = _make_team("coding")
    session_id = "deleted-session"
    team_manager._coding_teams[(str(tmp_path), session_id)] = coding
    team_manager._coding_team_last_used[(str(tmp_path), session_id)] = 1

    await team_manager.evict_session_teams({session_id})

    coding.stop.assert_awaited_once()
    assert team_manager._coding_teams.get((str(tmp_path), session_id)) is None


@pytest.mark.asyncio
async def test_stop_clears_coding_teams(tmp_path, monkeypatch):
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
    assert seen["path"] == agents_dir
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


# ── find_live_coding_team() ──────────────────────────────────────────────────
#
# `GET /team/agents?session_id=...` resolves the live team for a session. A
# brand-new session (e.g. one created by "/new") has no team yet and must NOT
# be served another session's team — otherwise its transient members leak into
# the new session's roster until a reload. The exact-match path (reloading a
# session that already owns a team) must still resolve that team so running
# members survive a refresh.


def test_find_live_coding_team_does_not_leak_other_session_members(tmp_path):
    workspace = tmp_path / "project"
    workspace.mkdir()
    team_a = _make_team("lead-a")
    team_a.members = {"coder#1": MagicMock(), "explorer#1": MagicMock()}
    team_manager._coding_teams[(str(workspace.resolve()), "session-a")] = team_a

    # A brand-new session has never started a team; it must not inherit
    # session-a's transient member instances.
    assert team_manager.find_live_coding_team(str(workspace), "session-b") is None


def test_find_live_coding_team_exact_match_still_resolves_owner(tmp_path):
    workspace = tmp_path / "project"
    workspace.mkdir()
    team_a = _make_team("lead-a")
    team_manager._coding_teams[(str(workspace.resolve()), "session-a")] = team_a

    assert team_manager.find_live_coding_team(str(workspace), "session-a") is team_a


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

    _write_member_md(tmp_path / "coder.md", "coder")
    team_manager.refresh_blueprints(team)

    assert "coder" in team.blueprints
    assert team.blueprints["coder"].source_path == tmp_path / "coder.md"
    assert team.blueprints["coder"].description == "coder agent"


def test_refresh_blueprints_reuses_unchanged_parsed_configs_and_invalidates_changes(
    tmp_path, monkeypatch
):
    """Unchanged files are parsed once; file mutations still refresh discovery."""
    from app.agent import loader
    from app.core.config import settings

    monkeypatch.setattr(settings, "AGENTS_DIR", str(tmp_path))
    team = _make_real_team()
    member = tmp_path / "coder.md"
    _write_member_md(member, "coder")
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
        member.read_text(encoding="utf-8").replace("coder agent", "updated agent"),
        encoding="utf-8",
    )
    team_manager.refresh_blueprints(team)
    assert parse_calls == 2
    assert "coder" in team.blueprints  # existing edited blueprints stay stable

    renamed = tmp_path / "renamed.md"
    member.rename(renamed)
    team_manager.refresh_blueprints(team)
    assert parse_calls == 3
    assert team.blueprints["coder"].source_path == renamed

    renamed.unlink()
    team_manager.refresh_blueprints(team)
    assert "coder" not in team.blueprints

    _write_member_md(tmp_path / "new.md", "new")
    team_manager.refresh_blueprints(team)
    assert parse_calls == 4
    assert "new" in team.blueprints


def test_refresh_blueprints_removes_blueprint_when_file_deleted(tmp_path, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "AGENTS_DIR", str(tmp_path))
    team = _make_real_team()
    _write_member_md(tmp_path / "coder.md", "coder")
    team_manager.refresh_blueprints(team)
    assert "coder" in team.blueprints

    (tmp_path / "coder.md").unlink()
    team_manager.refresh_blueprints(team)

    assert "coder" not in team.blueprints


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
    _write_member_md(tmp_path / "coder.md", "coder")
    team_manager.refresh_blueprints(team)

    # Simulate a live instance spawned from the blueprint.
    instance = TeamMember(
        Agent(name="coder#1", llm_provider=MockProvider(), system_prompt="Worker")
    )
    team.members["coder#1"] = instance
    team._members_by_name["coder#1"] = instance

    (tmp_path / "coder.md").unlink()
    team_manager.refresh_blueprints(team)

    assert "coder" in team.blueprints  # kept because instance is live


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
    """A regular coding workspace that exists is accepted and returned as a string."""
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


# ── validate_agents_dir() caching ─────────────────────────────────────────────
#
# ``/health/ready`` calls validate_agents_dir() on every poll, and each call ran
# a full load_team_from_dir() — directory glob + YAML parse of every agent .md.
# In production that was ~3,346 full config parses per 2 days (~1/min) and about
# 25% of all log volume. The result is cached against a cheap stat signature of
# the agents dir so an unchanged config costs stats instead of parses, while any
# real config edit is still picked up immediately.


def _write_agents_dir(tmp_path, *, body: str = "role: lead\n") -> Path:
    agents = tmp_path / "agents"
    agents.mkdir()
    (agents / "lead.md").write_text(f"---\nname: lead\n{body}---\n")
    return agents


def _count_loads(monkeypatch, result):
    """Patch load_team_from_dir with a call counter; return the counter list."""
    calls: list[Path] = []

    def fake_load(path, **kwargs):
        calls.append(path)
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr("app.services.team_manager.load_team_from_dir", fake_load)
    return calls


async def test_validate_agents_dir_parses_once_when_config_unchanged(
    tmp_path, monkeypatch
):
    """The hot path: repeated polls with an untouched config parse only once."""
    from app.core.config import settings

    agents = _write_agents_dir(tmp_path)
    monkeypatch.setattr(settings, "AGENTS_DIR", str(agents))
    calls = _count_loads(monkeypatch, _make_team())

    assert team_manager.validate_agents_dir() is True
    assert team_manager.validate_agents_dir() is True
    assert team_manager.validate_agents_dir() is True
    assert len(calls) == 1, "unchanged config must not be re-parsed"


async def test_validate_agents_dir_reparses_when_file_edited(tmp_path, monkeypatch):
    """A content edit must invalidate the cache immediately."""
    import os

    from app.core.config import settings

    agents = _write_agents_dir(tmp_path)
    monkeypatch.setattr(settings, "AGENTS_DIR", str(agents))
    calls = _count_loads(monkeypatch, _make_team())

    assert team_manager.validate_agents_dir() is True
    lead = agents / "lead.md"
    lead.write_text("---\nname: lead\nrole: lead\ndescription: changed\n---\n")
    os.utime(lead, (1_000_000, 1_000_000))  # deterministic mtime change

    assert team_manager.validate_agents_dir() is True
    assert len(calls) == 2, "an edited agent file must trigger a re-parse"


async def test_validate_agents_dir_reparses_when_file_added(tmp_path, monkeypatch):
    """A newly added agent file must invalidate the cache."""
    from app.core.config import settings

    agents = _write_agents_dir(tmp_path)
    monkeypatch.setattr(settings, "AGENTS_DIR", str(agents))
    calls = _count_loads(monkeypatch, _make_team())

    assert team_manager.validate_agents_dir() is True
    (agents / "member.md").write_text("---\nname: member\nrole: member\n---\n")

    assert team_manager.validate_agents_dir() is True
    assert len(calls) == 2, "a new agent file must trigger a re-parse"


async def test_validate_agents_dir_does_not_cache_parse_errors(tmp_path, monkeypatch):
    """A broken config must keep raising, not be masked by a cached result."""
    from app.core.config import settings

    agents = _write_agents_dir(tmp_path)
    monkeypatch.setattr(settings, "AGENTS_DIR", str(agents))
    calls = _count_loads(monkeypatch, ValueError("bad config"))

    for _ in range(3):
        with pytest.raises(ValueError):
            team_manager.validate_agents_dir()
    assert len(calls) == 3, "parse failures must not be cached"


async def test_validate_agents_dir_caches_false_result(tmp_path, monkeypatch):
    """A missing/empty agents dir is a stable answer and is also cached."""
    from app.core.config import settings

    agents = _write_agents_dir(tmp_path)
    monkeypatch.setattr(settings, "AGENTS_DIR", str(agents))
    calls = _count_loads(monkeypatch, None)

    assert team_manager.validate_agents_dir() is False
    assert team_manager.validate_agents_dir() is False
    assert len(calls) == 1


async def test_validate_agents_dir_cache_converges_when_loader_creates_files(
    tmp_path, monkeypatch
):
    """load_team_from_dir() writes builtin blueprints on first run.

    That mutates the directory *after* the fingerprint was taken, so the next
    call legitimately misses.  What must not happen is permanent thrashing —
    creation is idempotent, so the cache has to settle.
    """
    from app.core.config import settings

    agents = _write_agents_dir(tmp_path)
    monkeypatch.setattr(settings, "AGENTS_DIR", str(agents))

    calls: list[Path] = []
    team = _make_team()

    def fake_load(path, **kwargs):
        calls.append(path)
        # Mimic ensure_builtin_agent_blueprints(): idempotent file creation.
        created = agents / "builtin.md"
        if not created.exists():
            created.write_text("---\nname: builtin\nrole: member\n---\n")
        return team

    monkeypatch.setattr("app.services.team_manager.load_team_from_dir", fake_load)

    assert team_manager.validate_agents_dir() is True  # parses, creates file
    assert team_manager.validate_agents_dir() is True  # fingerprint moved once
    assert team_manager.validate_agents_dir() is True  # must be a cache hit now
    assert team_manager.validate_agents_dir() is True
    assert len(calls) == 2, f"cache must settle after creation, got {len(calls)} parses"


async def test_validate_agents_dir_does_not_cache_unstable_fingerprint(
    tmp_path, monkeypatch
):
    """A file vanishing mid-fingerprint must not produce a cacheable signature.

    An empty agents dir legitimately fingerprints as ``()``.  If a racing
    deletion also produced ``()``, the result captured during the race would
    later be served for a genuinely empty directory — reporting the config
    loadable when it is not.  Such rounds must simply not be cached.
    """
    from pathlib import Path as _Path

    from app.core.config import settings

    agents = _write_agents_dir(tmp_path)
    monkeypatch.setattr(settings, "AGENTS_DIR", str(agents))
    calls = _count_loads(monkeypatch, _make_team())

    real_stat = _Path.stat
    boom = {"n": 2}

    def flaky_stat(self, *a, **kw):
        if self.suffix == ".md" and boom["n"] > 0:
            boom["n"] -= 1
            raise OSError("vanished mid-scan")
        return real_stat(self, *a, **kw)

    monkeypatch.setattr(_Path, "stat", flaky_stat)

    # Two racing rounds — neither may be cached.
    assert team_manager.validate_agents_dir() is True
    assert team_manager.validate_agents_dir() is True
    assert len(calls) == 2, "unstable fingerprints must never be cached"

    # Directory settles: one more parse, then the cache engages normally.
    assert team_manager.validate_agents_dir() is True
    assert team_manager.validate_agents_dir() is True
    assert len(calls) == 3, "cache must engage once the fingerprint is stable"
