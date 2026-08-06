"""Team lifecycle manager.

Teams are loaded lazily on first use and evicted after an idle window.

Usage::

    team_manager.validate_agents_dir()               # startup (parse-only)
    team = await team_manager.get_or_start_team()    # on demand
    await team_manager.stop()                        # shutdown

Lazy lifecycle
--------------

The default team (and per-workspace coding teams) are not built on
server startup.  ``get_or_start_team()`` and ``get_or_start_coding_team()``
build them on the first incoming request (chat, scheduler fire,
``/team/agents``, etc.) and cache them in module state.

After an idle window with no working members, teams are evicted on the
next ``get_or_start_*`` call:

* Default team — ``_DEFAULT_TEAM_IDLE_SECONDS`` (1 hour)
* Coding teams — ``_CODING_TEAM_IDLE_SECONDS`` (30 minutes)

Eviction is opportunistic (no background timer); the cost of an
evicted-then-re-requested team is one ``load_team_from_dir`` + ``team.start()``
on the next request (~10–100 ms), which is below user-perceptible
latency on a chat send.

Live-config refresh — no team reload
------------------------------------

Agents now refresh themselves at the start of their next turn when
their tracked config files (their own ``.md``, ``mcp.json``, referenced
``SKILL.md``) change on disk.  See ``app.agent.loader.stamp_agent_files``
and ``TeamMemberBase._detect_config_drift``.  Production code paths
(``/api/mcp``, ``/api/skills``, ``/api/agents``) therefore do **not**
call :func:`reload`.

:func:`reload` is retained as a legacy admin tool for operational forced
rebuilds and as a hook for tests; do not call it from request handlers.
It rebuilds the entire team — stopping in-flight agents and rotating
session IDs — which is exactly what the live-config mechanism was
introduced to avoid.
"""

from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from loguru import logger

from app.agent.loader import load_team_from_dir
from app.agent.mode.team.member import is_busy
from app.core.config import settings

if TYPE_CHECKING:
    from app.agent.loader import AgentConfig
    from app.agent.mode.team.team import AgentTeam


# ── Diff dataclass ───────────────────────────────────────────────────────────


@dataclass
class TeamDiff:
    """Difference between the previous and new team after a reload."""

    added: list[str]  # agent names added
    removed: list[str]  # agent names removed
    changed: list[str]  # agent names where model / tools / skills changed
    lead: str  # name of the new lead
    members: list[str]  # names of all members (excluding lead)

    def to_dict(self) -> dict:
        return {
            "added": self.added,
            "removed": self.removed,
            "changed": self.changed,
            "lead": self.lead,
            "members": self.members,
        }


# ── Module-level state ───────────────────────────────────────────────────────

_team: "AgentTeam | None" = None
_team_last_used: float = 0.0
_session_teams: dict[str, "AgentTeam"] = {}
_session_team_last_used: dict[str, float] = {}
_coding_teams: dict[tuple[str, str], "AgentTeam"] = {}
_coding_team_last_used: dict[tuple[str, str], float] = {}
_DEFAULT_TEAM_IDLE_SECONDS = 60 * 60
_CODING_TEAM_IDLE_SECONDS = 30 * 60
_lock = asyncio.Lock()
_BLUEPRINT_CONFIG_CACHE_LIMIT = 256
_blueprint_config_cache: OrderedDict[
    Path, tuple[tuple[int, int, int, int], AgentConfig]
] = OrderedDict()

# ``validate_agents_dir`` result cache, keyed by resolved agents dir.  Stores
# ``(signature, result)`` where *signature* is a cheap stat fingerprint of the
# directory's top-level ``*.md`` files.  ``/health/ready`` polls this on every
# request; without the cache each poll re-globbed and re-parsed every agent
# file.  Only definitive answers are cached — parse failures are not, so a
# broken config keeps surfacing instead of being masked.
_AgentsDirSignature = tuple[tuple[str, int, int], ...] | None
_agents_dir_validation: dict[Path, tuple[_AgentsDirSignature, bool]] = {}


class _UnstableSignature:
    """Marker for "the directory changed while being fingerprinted".

    It must not be a plain value like ``()``: an empty tuple is the legitimate
    signature of an *existing but empty* agents dir, so reusing it would let a
    result captured mid-race be served later for a genuinely empty directory.
    Results computed under this marker are never cached.
    """


_UNSTABLE = _UnstableSignature()


def _agents_dir_signature(agents_dir: Path) -> _AgentsDirSignature | _UnstableSignature:
    """Return a stat fingerprint of the agent ``.md`` files, or None if absent.

    Mirrors exactly what :func:`~app.agent.loader.load_team_from_dir` reads:
    the non-recursive ``*.md`` glob of *agents_dir*.  Name, mtime and size
    together detect edits, additions, removals and renames without opening a
    single file.  ``None`` means the directory does not exist, which is itself
    a cacheable state.
    """
    if not agents_dir.is_dir():
        return None
    entries: list[tuple[str, int, int]] = []
    for path in sorted(agents_dir.glob("*.md")):
        try:
            st = path.stat()
        except OSError:
            # Racing deletion — the directory is mid-change, so refuse to
            # fingerprint it at all rather than emit a value that could later
            # collide with a stable state.
            return _UNSTABLE
        entries.append((path.name, st.st_mtime_ns, st.st_size))
    return tuple(entries)


def reset_agents_dir_validation_cache() -> None:
    """Drop all cached ``validate_agents_dir`` results.

    Exposed for tests: the cache is module-level state and the suite runs in
    random order across parallel workers.
    """
    _agents_dir_validation.clear()


def _resolve_agents_dir() -> Path:
    path = Path(settings.AGENTS_DIR)
    return path if path.is_absolute() else Path.cwd() / path


def _resolve_coding_agents_dir() -> Path:
    return _resolve_agents_dir() / "coding"


def _resolve_workspace(workspace: str) -> Path:
    return Path(workspace).expanduser().resolve()


# Directories that should never be used as a coding workspace — they are
# OS-level system trees whose contents are never legitimate project roots.
# Blocking them prevents accidental (or crafted) requests from listing or
# reading sensitive system paths through the workspace file/snippet/command
# endpoints.
_BLOCKED_WORKSPACE_ROOTS: tuple[Path, ...] = (
    Path("/etc"),
    Path("/proc"),
    Path("/sys"),
    Path("/dev"),
    Path("/run"),
    Path("/boot"),
    Path("/sbin"),
    Path("/bin"),
    Path("/usr/bin"),
    Path("/usr/sbin"),
    Path("/private/etc"),  # macOS
)


def validate_workspace(workspace: str) -> str:
    resolved = _resolve_workspace(workspace)
    if not resolved.is_dir():
        raise ValueError(f"Workspace does not exist or is not a directory: {resolved}")
    for blocked in _BLOCKED_WORKSPACE_ROOTS:
        try:
            resolved.relative_to(blocked)
            raise ValueError(
                f"Workspace '{resolved}' is inside a restricted system directory."
            )
        except ValueError as exc:
            # relative_to raises ValueError when the path is NOT under blocked —
            # that's the normal (safe) case.  Re-raise only our own message.
            if "restricted system directory" in str(exc):
                raise
    return str(resolved)


def _team_is_idle(team: "AgentTeam") -> bool:
    return all(not is_busy(member.state) for member in team.all_members)


# Back-compat alias — older call sites (tests) may import the coding-specific name.
_coding_team_is_idle = _team_is_idle


def _maybe_pop_idle_default_team_locked(
    now: float,
) -> "AgentTeam | None":
    """Return the default team for eviction, or ``None`` if it should stay.

    Caller must release the lock before stopping the returned team to avoid
    holding ``_lock`` across the team's shutdown work.
    """
    global _team, _team_last_used
    if _team is None:
        return None
    if now - _team_last_used <= _DEFAULT_TEAM_IDLE_SECONDS:
        return None
    if not _team_is_idle(_team):
        return None
    expired = _team
    _team = None
    _team_last_used = 0.0
    return expired


def _pop_idle_session_teams_locked(now: float) -> list[tuple[str, "AgentTeam"]]:
    expired = [
        session_id
        for session_id, last_used in _session_team_last_used.items()
        if now - last_used > _DEFAULT_TEAM_IDLE_SECONDS
        and (team := _session_teams.get(session_id)) is not None
        and _team_is_idle(team)
    ]
    popped: list[tuple[str, "AgentTeam"]] = []
    for session_id in expired:
        team = _session_teams.pop(session_id, None)
        _session_team_last_used.pop(session_id, None)
        if team is not None:
            popped.append((session_id, team))
    return popped


def _pop_idle_coding_teams_locked(
    now: float,
) -> list[tuple[tuple[str, str], "AgentTeam"]]:
    expired = [
        key
        for key, last_used in _coding_team_last_used.items()
        if now - last_used > _CODING_TEAM_IDLE_SECONDS
        and (team := _coding_teams.get(key)) is not None
        and _coding_team_is_idle(team)
    ]
    popped: list[tuple[tuple[str, str], "AgentTeam"]] = []
    for key in expired:
        team = _coding_teams.pop(key, None)
        _coding_team_last_used.pop(key, None)
        if team is not None:
            popped.append((key, team))
    return popped


async def _stop_coding_teams(
    teams: list[tuple[tuple[str, str], "AgentTeam"]],
) -> None:
    for (workspace, session_id), team in teams:
        try:
            await team.stop()
        except Exception:
            logger.exception(
                "coding_team_idle_stop_error workspace={} session_id={}",
                workspace,
                session_id,
            )
        else:
            logger.info(
                "coding_team_idle_stopped workspace={} session_id={}",
                workspace,
                session_id,
            )


async def _stop_session_teams(teams: list[tuple[str, "AgentTeam"]]) -> None:
    for session_id, team in teams:
        try:
            await team.stop()
        except Exception:
            logger.exception("team_session_idle_stop_error session_id={}", session_id)
        else:
            logger.info("team_session_idle_stopped session_id={}", session_id)


async def evict_session_teams(session_ids: set[str]) -> None:
    """Stop and evict normal and coding teams for deleted sessions.

    This deliberately only removes cached team instances; it never touches a
    coding workspace on disk.
    """
    async with _lock:
        normal = [
            (session_id, _session_teams.pop(session_id))
            for session_id in session_ids
            if session_id in _session_teams
        ]
        for session_id in session_ids:
            _session_team_last_used.pop(session_id, None)
        coding = [
            (key, _coding_teams.pop(key))
            for key in list(_coding_teams)
            if key[1] in session_ids
        ]
        for key, _team in coding:
            _coding_team_last_used.pop(key, None)
    await _stop_session_teams(normal)
    await _stop_coding_teams(coding)


def current_team() -> "AgentTeam | None":
    return _team


def set_team(team: "AgentTeam | None") -> None:
    """Replace the current team reference without running the lifecycle.

    Intended for tests that need to inject a pre-built ``AgentTeam`` into
    the FastAPI dependency without starting the real team.  Production
    code should use :func:`get_or_start_team` / :func:`reload` / :func:`stop`.
    """
    global _team, _team_last_used
    _team = team
    _team_last_used = time.monotonic() if team is not None else 0.0


# ── Lifecycle ────────────────────────────────────────────────────────────────


def validate_agents_dir() -> bool:
    """Parse-only check that the agents directory is loadable.

    Called from the FastAPI lifespan at startup so a malformed config
    surfaces immediately (server fails to boot) instead of on the first
    chat request.  Does **not** build or cache an ``AgentTeam`` — that
    happens lazily on the first call to :func:`get_or_start_team`.

    Returns ``True`` when the directory contains a valid lead, ``False``
    when it is empty or missing.  Re-raises ``ValueError`` from the loader
    on parse errors.

    ``/health/ready`` calls this on every poll, so the result is memoised
    against a stat fingerprint of the agents directory (see
    :func:`_agents_dir_signature`).  An unchanged config costs one glob plus a
    stat per file instead of a full YAML parse of every agent; any real edit
    changes the fingerprint and forces a re-parse on the next call.
    """
    agents_dir = _resolve_agents_dir()
    raw_signature = _agents_dir_signature(agents_dir)
    # ``None`` here means "do not cache this round" — distinct from a signature
    # of ``None``, which legitimately means "directory does not exist".
    signature = (
        None if isinstance(raw_signature, _UnstableSignature) else (raw_signature,)
    )
    cached = _agents_dir_validation.get(agents_dir)
    if signature is not None and cached is not None and cached[0] == signature[0]:
        return cached[1]

    try:
        team = load_team_from_dir(agents_dir)
    except ValueError:
        # Never cache a failure: the operator needs it to keep surfacing until
        # the config is actually fixed.
        _agents_dir_validation.pop(agents_dir, None)
        raise
    if team is None:
        if signature is not None:
            _agents_dir_validation[agents_dir] = (signature[0], False)
        logger.warning("team_manager_agents_dir_empty path={}", agents_dir)
        return False
    # Success on a readiness probe is not newsworthy — the failure paths
    # (``_agents_dir_empty`` above, and the ``ValueError`` the caller logs)
    # are what an operator needs to see.
    logger.debug(
        "team_manager_agents_dir_validated path={} lead={}", agents_dir, team.lead.name
    )
    if signature is not None:
        _agents_dir_validation[agents_dir] = (signature[0], True)
    return True


async def get_or_start_team() -> "AgentTeam | None":
    """Return the cached default team, building it on first use.

    Evicts the cached team if it has been idle for longer than
    ``_DEFAULT_TEAM_IDLE_SECONDS`` and has no working members.  Returns
    ``None`` when the agents directory is empty or missing (mirroring
    the legacy ``start()`` behaviour so callers can render a friendly
    "no agents configured" response).
    """
    global _team, _team_last_used

    async with _lock:
        now = time.monotonic()
        expired = _maybe_pop_idle_default_team_locked(now)

        if _team is not None:
            _team_last_used = now
            result: "AgentTeam | None" = _team
        else:
            agents_dir = _resolve_agents_dir()
            candidate = load_team_from_dir(agents_dir)
            if candidate is None:
                logger.warning("team_manager_no_agents path={}", agents_dir)
                result = None
            else:
                await candidate.start()
                _team = candidate
                _team_last_used = now
                logger.info("team_manager_started lead={}", candidate.lead.name)
                result = candidate

    if expired is not None:
        try:
            await expired.stop()
        except Exception:
            logger.exception("team_manager_idle_stop_error")
        else:
            logger.info("team_manager_idle_stopped")

    return result


async def get_or_start_team_for_session(session_id: str) -> "AgentTeam | None":
    """Return the default-mode team instance dedicated to one chat session."""
    global _team_last_used

    async with _lock:
        now = time.monotonic()
        expired_default = _maybe_pop_idle_default_team_locked(now)
        expired_sessions = _pop_idle_session_teams_locked(now)

        existing = _session_teams.get(session_id)
        if existing is not None:
            _session_team_last_used[session_id] = now
            result: "AgentTeam | None" = existing
        else:
            agents_dir = _resolve_agents_dir()
            candidate = load_team_from_dir(agents_dir)
            if candidate is None:
                logger.warning("team_manager_no_agents path={}", agents_dir)
                result = None
            else:
                await candidate.start()
                _session_teams[session_id] = candidate
                _session_team_last_used[session_id] = now
                _team_last_used = now
                logger.info(
                    "team_manager_session_started session_id={} lead={}",
                    session_id,
                    candidate.lead.name,
                )
                result = candidate

    if expired_default is not None:
        try:
            await expired_default.stop()
        except Exception:
            logger.exception("team_manager_idle_stop_error")
        else:
            logger.info("team_manager_idle_stopped")
    await _stop_session_teams(expired_sessions)

    return result


async def stop() -> None:
    """Stop the current team (if any) on server shutdown."""
    global _team, _team_last_used
    async with _lock:
        if _team is not None:
            try:
                await _team.stop()
            except Exception:
                logger.exception("team_manager_stop_error")
            _team = None
            _team_last_used = 0.0
        for session_id, team in list(_session_teams.items()):
            try:
                await team.stop()
            except Exception:
                logger.exception(
                    "team_session_manager_stop_error session_id={}", session_id
                )
        _session_teams.clear()
        _session_team_last_used.clear()
        for (workspace, session_id), team in list(_coding_teams.items()):
            try:
                await team.stop()
            except Exception:
                logger.exception(
                    "coding_team_manager_stop_error workspace={} session_id={}",
                    workspace,
                    session_id,
                )
        _coding_teams.clear()
        _coding_team_last_used.clear()


def find_live_team_for_lead_session(session_id: str) -> "AgentTeam | None":
    """Return an already-running team whose lead owns *session_id*.

    Never starts one.  Used by endpoints that act on an in-flight turn (e.g.
    answering a suspended question): booting a fresh team there would produce a
    lead with no suspended turn to resume, and pay a cold start to do it.

    Both registries hold a handful of live teams, and the session-keyed one is
    a direct hit, so the coding scan is a short fallback rather than the norm.
    """
    direct = _session_teams.get(session_id)
    if direct is not None:
        return direct
    for (_workspace, owner_session), team in _coding_teams.items():
        if owner_session == session_id or team.lead.session_id == session_id:
            return team
    return None


async def get_or_start_coding_team(workspace: str, session_id: str) -> "AgentTeam":
    resolved_workspace = validate_workspace(workspace)
    key = (resolved_workspace, session_id)
    async with _lock:
        now = time.monotonic()
        expired = _pop_idle_coding_teams_locked(now)
        existing = _coding_teams.get(key)
        if existing is not None:
            _coding_team_last_used[key] = now
            team = existing
        else:
            agents_dir = _resolve_coding_agents_dir()
            team = load_team_from_dir(
                agents_dir, mode="coding", workspace=resolved_workspace
            )
            if team is None:
                raise ValueError(
                    f"No coding agents found in '{agents_dir}'. "
                    "Create at least one .md file with 'role: lead'."
                )
            await team.start()
            _coding_teams[key] = team
            _coding_team_last_used[key] = now
            logger.info(
                "coding_team_started workspace={} session_id={} lead={}",
                resolved_workspace,
                session_id,
                team.lead.name,
            )

    await _stop_coding_teams(expired)
    return team


# ── Hot reload ───────────────────────────────────────────────────────────────


def _team_snapshot(team: "AgentTeam") -> dict[str, dict]:
    """Capture per-agent fingerprint used to compute the diff."""
    snapshot: dict[str, dict] = {}
    members = [team.lead, *team.members.values()]
    for m in members:
        agent = m.agent
        snapshot[agent.name] = {
            "description": agent.description or "",
            "model": agent.model_id,
            "tools": sorted(t.name for t in agent._tools.values()),
            "system_prompt": agent.system_prompt,
        }
    return snapshot


def _compute_diff(before: dict[str, dict] | None, team: "AgentTeam") -> TeamDiff:
    after = _team_snapshot(team)
    before = before or {}

    before_names = set(before.keys())
    after_names = set(after.keys())

    added = sorted(after_names - before_names)
    removed = sorted(before_names - after_names)
    changed = sorted(
        name for name in before_names & after_names if before[name] != after[name]
    )

    members = sorted(team.members.keys())
    return TeamDiff(
        added=added,
        removed=removed,
        changed=changed,
        lead=team.lead.name,
        members=members,
    )


async def reload() -> TeamDiff:
    """Rebuild the team from ``AGENTS_DIR`` and atomically swap it in.

    .. warning::
        Legacy admin path.  Calling this stops every agent (cancelling
        any in-flight tool execution, rotating session IDs, emitting a
        premature ``done`` event for the active turn).  Production code
        should rely on the live-config refresh mechanism instead — see
        the module docstring.

    Raises ``ValueError`` (from :func:`load_team_from_dir`) on any validation
    failure — the running team is untouched in that case.
    """
    global _team, _team_last_used
    async with _lock:
        agents_dir = _resolve_agents_dir()

        # 1. Build candidate first — throws on validation failure, running
        #    team stays live.
        candidate = load_team_from_dir(agents_dir)
        if candidate is None:
            raise ValueError(
                f"No agents found in '{agents_dir}'. "
                "Create at least one .md file with 'role: lead' before reloading."
            )

        # 2. Snapshot the old team (for diff) and stop it.
        before_snapshot = _team_snapshot(_team) if _team is not None else None
        old_team = _team
        if old_team is not None:
            try:
                await old_team.stop()
            except Exception:
                logger.exception("team_manager_reload_stop_error")

        # 3. Start the new one.  ``app.api.deps.get_team`` will pick it up
        #    via :func:`current_team` on the next request.
        await candidate.start()
        _team = candidate
        _team_last_used = time.monotonic()

        diff = _compute_diff(before_snapshot, candidate)
        logger.info(
            "team_manager_reloaded lead={} added={} removed={} changed={}",
            diff.lead,
            diff.added,
            diff.removed,
            diff.changed,
        )
        return diff


# ── Live-config refresh ──────────────────────────────────────────────────────


def refresh_idle_agents(team: "AgentTeam") -> None:
    """Detect and apply config drift for all idle (non-working) agents.

    This is the same mechanism agents use at start-of-turn, hoisted into
    a service function so the ``GET /team/agents`` route can serve fresh
    frontmatter without knowing about ``TeamMemberBase`` internals.

    Working agents are skipped — refreshing them would race ``agent.run()``
    swapping ``self.agent`` mid-execution.

    Errors are swallowed and logged so a single bad agent config never
    breaks the listing endpoint.
    """
    for member in [team.lead, *team.members.values()]:
        if is_busy(member.state):
            continue
        try:
            member.refresh_if_dirty()
        except Exception as exc:
            logger.warning(
                "team_agents_refresh_failed name={} error={}", member.name, exc
            )


def refresh_blueprints(team: "AgentTeam") -> None:
    """Rediscover member ``.md`` files for *team* and update its blueprint
    registry in place.

    The source directory is derived from ``team.mode`` so callers
    (currently just ``GET /team/agents``) don't need to know whether they
    hold a default or a coding team. Without this, a user who creates a
    new member through the Settings → Agents page wouldn't see it appear
    in the spawnable roster until the team object is evicted and rebuilt
    — typically a server restart.

    Behaviour:

    * **New file** → register a fresh :class:`MemberBlueprint`. The lead
      will see it on its next ``team_manage`` listing.
    * **Removed file** → drop the blueprint *only if* no live instances
      reference it; otherwise leave it alone so an in-flight conversation
      can still address the agent by handle.
    * **Edited file** → no-op here. The blueprint's ``source_path`` is
      unchanged and existing instances pick up the edit via the regular
      drift mechanism on their next turn.
    * **Lead changed** → no-op. Lead lifecycle is owned by :func:`reload`,
      not by this hot-path service.
    * **Parse error in a new file** → logged and skipped; the rest of the
      directory is still processed.
    """
    from app.agent.loader import member_model_is_configured, parse_agent_md
    from app.agent.mode.team.team import MemberBlueprint

    agents_dir = (
        _resolve_coding_agents_dir() if team.mode == "coding" else _resolve_agents_dir()
    )
    if not agents_dir.exists():
        return

    md_files = sorted(agents_dir.glob("*.md"))
    resolved_agents_dir = agents_dir.absolute()
    active_paths = {path.absolute() for path in md_files}
    for cached_path in tuple(_blueprint_config_cache):
        if (
            cached_path.parent == resolved_agents_dir
            and cached_path not in active_paths
        ):
            del _blueprint_config_cache[cached_path]

    seen: set[str] = set()
    for md_path in md_files:
        resolved_path = md_path.absolute()
        try:
            stat = md_path.stat()
        except Exception as exc:
            logger.warning(
                "blueprint_refresh_parse_failed path={} error={}", md_path.name, exc
            )
            continue
        signature = (stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
        cached = _blueprint_config_cache.get(resolved_path)
        if cached is not None and cached[0] == signature:
            result = cached[1]
            _blueprint_config_cache.move_to_end(resolved_path)
        else:
            try:
                result = parse_agent_md(md_path)
            except Exception as exc:
                logger.warning(
                    "blueprint_refresh_parse_failed path={} error={}",
                    md_path.name,
                    exc,
                )
                continue
            _blueprint_config_cache[resolved_path] = (signature, result)
            _blueprint_config_cache.move_to_end(resolved_path)
            while len(_blueprint_config_cache) > _BLUEPRINT_CONFIG_CACHE_LIMIT:
                _blueprint_config_cache.popitem(last=False)
        cfg = result
        # Skip the lead — its file lives in the same directory but is owned
        # by :func:`reload`, not by this hot-path discovery.
        if cfg.role != "member" or not member_model_is_configured(cfg.model):
            continue
        if "#" in cfg.name or cfg.name == team.lead.name:
            # Same invariants ``load_team_from_dir`` enforces; silently
            # drop the bad file rather than 500 the listing endpoint.
            continue
        seen.add(cfg.name)
        existing = team.blueprints.get(cfg.name)
        if existing is None:
            team.blueprints[cfg.name] = MemberBlueprint(
                name=cfg.name,
                description=cfg.description or cfg.name,
                source_path=md_path,
            )
            logger.info("blueprint_added name={} path={}", cfg.name, md_path.name)
        elif existing.source_path != md_path:
            # File renamed but ``name:`` kept — repoint so the next spawn
            # reads from the new location.
            existing.source_path = md_path

    for name in list(team.blueprints.keys()):
        if name in seen:
            continue
        # Don't pull the rug out from under a live conversation: if any
        # instance of this blueprint is still in the roster, leave the
        # blueprint in place so its handle still resolves.
        if team.live_instances_for_blueprint(name):
            continue
        team.blueprints.pop(name, None)
        logger.info("blueprint_removed name={}", name)


# ── Skill cache invalidation ─────────────────────────────────────────────────


def invalidate_skill_cache() -> None:
    """Clear the ``discover_skills`` lru_cache so the next tool call
    picks up edits to ``{SKILLS_DIR}/*/SKILL.md``.  No team reload needed.
    """
    from app.agent.tools.builtin.skill import _discover_skills_cached

    _discover_skills_cached.cache_clear()
    logger.info("team_manager_skill_cache_invalidated")
