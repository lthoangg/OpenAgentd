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
``/session/agents``, etc.) and cache them in module state.

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
and ``SessionRuntime._detect_config_drift``.  Production code paths
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
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from loguru import logger

from app.agent.loader import load_team_from_dir
from app.agent.mode.team.runtime import is_busy
from app.core.config import settings
import app.core.db as db_module

if TYPE_CHECKING:
    from app.agent.mode.team.runtime import SessionRuntime


# ── Diff dataclass ───────────────────────────────────────────────────────────


@dataclass
class TeamDiff:
    """Difference between the previous and new team after a reload."""

    added: list[str]  # agent names added
    removed: list[str]  # agent names removed
    changed: list[str]  # agent names where model / tools / skills changed
    lead: str  # name of the new lead

    def to_dict(self) -> dict:
        return {
            "added": self.added,
            "removed": self.removed,
            "changed": self.changed,
            "lead": self.lead,
        }


# ── Module-level state ───────────────────────────────────────────────────────

_team: "SessionRuntime | None" = None
_team_last_used: float = 0.0
_coding_teams: dict[tuple[str, str], "SessionRuntime"] = {}
_coding_team_last_used: dict[tuple[str, str], float] = {}
_coding_start_locks: dict[tuple[str, str], asyncio.Lock] = {}
_DEFAULT_TEAM_IDLE_SECONDS = 60 * 60
_CODING_TEAM_IDLE_SECONDS = 30 * 60
_lock = asyncio.Lock()

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


def validate_workspace(workspace: str, *, require_exists: bool = True) -> str:
    """Resolve and validate a workspace path.

    Args:
        workspace: The user-supplied workspace path.
        require_exists: When ``False``, a path that is not an existing
            directory is still accepted.  Only for callers that operate on
            bookkeeping rather than the filesystem — hiding a stale sidebar
            entry whose directory was deleted or unmounted outside the app.
            The restricted-root rule is enforced either way.
    """
    resolved = _resolve_workspace(workspace)
    if require_exists and not resolved.is_dir():
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


def _team_is_idle(runtime: "SessionRuntime") -> bool:
    return not is_busy(runtime.state)


# Back-compat alias — older call sites (tests) may import the coding-specific name.
_coding_team_is_idle = _team_is_idle


def _maybe_pop_idle_default_team_locked(
    now: float,
) -> "SessionRuntime | None":
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


def _pop_idle_coding_teams_locked(
    now: float,
) -> list[tuple[tuple[str, str], "SessionRuntime"]]:
    expired = [
        key
        for key, last_used in _coding_team_last_used.items()
        if now - last_used > _CODING_TEAM_IDLE_SECONDS
        and (team := _coding_teams.get(key)) is not None
        and _coding_team_is_idle(team)
    ]
    popped: list[tuple[tuple[str, str], "SessionRuntime"]] = []
    for key in expired:
        team = _coding_teams.pop(key, None)
        _coding_team_last_used.pop(key, None)
        _coding_start_locks.pop(key, None)
        if team is not None:
            popped.append((key, team))
    return popped


async def _stop_coding_teams(
    teams: list[tuple[tuple[str, str], "SessionRuntime"]],
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


async def evict_session_teams(session_ids: set[str]) -> None:
    """Stop and evict coding teams for deleted sessions.

    This deliberately only removes cached team instances; it never touches a
    coding workspace on disk.
    """
    async with _lock:
        coding = [
            (key, _coding_teams.pop(key))
            for key in list(_coding_teams)
            if key[1] in session_ids
        ]
        for key, _team in coding:
            _coding_team_last_used.pop(key, None)
    await _stop_coding_teams(coding)


def current_team() -> "SessionRuntime | None":
    return _team


def set_team(team: "SessionRuntime | None") -> None:
    """Replace the current team reference without running the lifecycle.

    Intended for tests that need to inject a pre-built ``SessionRuntime`` into
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
    chat request.  Does **not** build or cache an ``SessionRuntime`` — that
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
        runtime = load_team_from_dir(agents_dir)
    except ValueError:
        # Never cache a failure: the operator needs it to keep surfacing until
        # the config is actually fixed.
        _agents_dir_validation.pop(agents_dir, None)
        raise
    if runtime is None:
        if signature is not None:
            _agents_dir_validation[agents_dir] = (signature[0], False)
        logger.warning("team_manager_agents_dir_empty path={}", agents_dir)
        return False
    # Success on a readiness probe is not newsworthy — the failure paths
    # (``_agents_dir_empty`` above, and the ``ValueError`` the caller logs)
    # are what an operator needs to see.
    logger.debug("agents_dir_validated path={} agent={}", agents_dir, runtime.name)
    if signature is not None:
        _agents_dir_validation[agents_dir] = (signature[0], True)
    return True


async def get_or_start_team() -> "SessionRuntime | None":
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
            result: "SessionRuntime | None" = _team
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
                logger.info("team_manager_started agent={}", candidate.name)
                result = candidate

    if expired is not None:
        try:
            await expired.stop()
        except Exception:
            logger.exception("team_manager_idle_stop_error")
        else:
            logger.info("team_manager_idle_stopped")

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
        _coding_start_locks.clear()


def find_live_team_serving_session(session_id: str) -> "SessionRuntime | None":
    """Return an already-running team associated with *session_id*.

    Never starts one.  Used by endpoints that act on an in-flight turn (e.g.
    answering a suspended question): booting a fresh team there would produce a
    lead with no suspended turn to resume, and pay a cold start to do it.

    **The returned team's lead is not guaranteed to be bound to *session_id*.**
    The coding registry is keyed by ``(workspace, owner_session)``, and a team
    evicted after the idle window is rebuilt with a freshly minted lead session,
    so a match on that key can carry a lead that is mid-turn on a *different*
    conversation. Anything that then drives the lead — emitting ``done``,
    resuming a turn — must either check ``runtime.session_id`` first or
    re-bind with ``attach_to_session``, or it will act on the wrong stream.
    Hence the deliberately vague "serving": this is the team that *could* serve
    the session, not one that currently owns it.

    Both registries hold a handful of live teams, and the session-keyed one is
    a direct hit, so the coding scan is a short fallback rather than the norm.
    """
    for (_workspace, owner_session), runtime in _coding_teams.items():
        if owner_session == session_id or runtime.session_id == session_id:
            return runtime
    return None


def find_live_coding_team(
    workspace: str, session_id: str | None = None
) -> "SessionRuntime | None":
    """Return an active running coding team for *workspace*, matching *session_id* if provided."""
    try:
        resolved_workspace = validate_workspace(workspace)
    except Exception:
        return None

    if session_id:
        # An explicit session must resolve to the team that owns it. Never
        # fall back to another session's team for the same workspace: a
        # brand-new session (e.g. one just created by "/new") has no team yet,
        # and serving it a different session's team leaks that session's
        # transient member instances into the new roster until a reload.
        return _coding_teams.get((resolved_workspace, session_id))

    # No session requested — a workspace-level lookup. Prefer an active
    # session team over the "__agents__" fallback so reloads can restore a
    # live team's running members.
    for (ws, owner_session), team in _coding_teams.items():
        if ws == resolved_workspace and owner_session != "__agents__":
            return team
    return _coding_teams.get((resolved_workspace, "__agents__"))


async def get_or_start_coding_team(workspace: str, session_id: str) -> "SessionRuntime":
    resolved_workspace = validate_workspace(workspace)
    key = (resolved_workspace, session_id)
    start_lock = _coding_start_locks.setdefault(key, asyncio.Lock())
    async with start_lock:
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

        if existing is None:
            await team.start()
            async with _lock:
                _coding_teams[key] = team
                _coding_team_last_used[key] = now
            logger.info(
                "coding_team_started workspace={} session_id={} agent={}",
                resolved_workspace,
                session_id,
                team.name,
            )

    await _stop_coding_teams(expired)
    return team


async def deliver_agent_report(
    *,
    parent_session_id: str,
    child_session_id: str,
    child_name: str,
    content: str,
    db_factory: db_module.DbFactory | None = None,
) -> None:
    """Deliver a child's report or cross-agent message to the parent session.

    Delivery algorithm:
    1. If parent runtime is live, bound to parent_session_id, and not blocked by
       an open question:
       - Persist HumanMessage with extra={"from_agent": child_name}.
       - If parent is idle, init stream turn and send to mailbox (waking lead).
       - If parent is working, send to mailbox (queued for TeamInboxHook mid-turn).
    2. If parent runtime is busy with another session or has an open question:
       - Persist to queued messages path with extra={"from_agent": child_name}.
    3. If no runtime is live:
       - Persist to queued messages path, boot parent team, and trigger queue drain.
    """
    from uuid import UUID
    from app.agent.schemas.chat import HumanMessage
    from app.agent.mode.team.mailbox import Message
    from app.services import memory_stream_store as stream_store
    from app.models.chat import ChatSession
    from app.services.chat_service import save_message, save_queued_user_message

    db_maker = db_factory or db_module.async_session_factory
    parent_uuid = UUID(parent_session_id)

    live_runtime = find_live_team_serving_session(parent_session_id)
    can_deliver_live = False

    if live_runtime is not None:
        if live_runtime.session_id == parent_session_id:
            can_deliver_live = True
        elif getattr(live_runtime, "state", "idle") == "idle":
            await live_runtime.attach_to_session(parent_session_id)
            can_deliver_live = True

    if can_deliver_live and live_runtime is not None:
        has_question = await live_runtime._has_open_question()

        if not has_question:
            # Step 1: Live delivery
            async with db_maker() as db:
                async with db.begin():
                    saved_message = await save_message(
                        db,
                        parent_uuid,
                        HumanMessage(content=content),
                        extra={"from_agent": child_name},
                    )

            is_idle = getattr(live_runtime, "state", "idle") == "idle"
            if is_idle:
                await stream_store.init_turn(parent_session_id)

            await live_runtime.deliver(
                Message(
                    from_agent=child_name,
                    to_agent=live_runtime.name,
                    content=content,
                    persisted_message_id=str(saved_message.id),
                )
            )
            return

    # Step 2 & 3: Persisted queue fallback
    async with db_maker() as db:
        async with db.begin():
            parent_row = await db.get(ChatSession, parent_uuid)
            await save_queued_user_message(
                db,
                parent_uuid,
                content,
                extra={"from_agent": child_name},
            )
            workspace = parent_row.workspace if parent_row else None

    # If no runtime is live and we have a workspace, start it and drain queue
    if live_runtime is None and workspace:
        try:
            started = await get_or_start_coding_team(workspace, parent_session_id)
            await started.attach_to_session(parent_session_id)
            await started._activate_queued_user_messages(parent_session_id)
        except Exception as exc:
            logger.warning(
                "failed_to_wake_offline_parent session_id={} error={}",
                parent_session_id,
                exc,
            )


# ── Hot reload ───────────────────────────────────────────────────────────────


def _team_snapshot(runtime: "SessionRuntime") -> dict[str, dict]:
    """Capture the agent fingerprint used to compute the diff."""
    agent = runtime.agent
    return {
        agent.name: {
            "description": agent.description or "",
            "model": agent.model_id,
            "tools": sorted(t.name for t in agent._tools.values()),
            "system_prompt": agent.system_prompt,
        }
    }


def _compute_diff(
    before: dict[str, dict] | None, runtime: "SessionRuntime"
) -> TeamDiff:
    after = _team_snapshot(runtime)
    before = before or {}

    before_names = set(before.keys())
    after_names = set(after.keys())

    added = sorted(after_names - before_names)
    removed = sorted(before_names - after_names)
    changed = sorted(
        name for name in before_names & after_names if before[name] != after[name]
    )

    return TeamDiff(
        added=added,
        removed=removed,
        changed=changed,
        lead=runtime.name,
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


def refresh_idle_agents(runtime: "SessionRuntime") -> None:
    """Detect and apply config drift when the agent is idle.

    This is the same mechanism the agent uses at start-of-turn, hoisted into
    a service function so the agents listing route can serve fresh frontmatter
    without reaching into runtime internals.

    A working agent is skipped — refreshing it would race ``agent.run()``
    swapping ``self.agent`` mid-execution.

    Errors are swallowed and logged so a bad agent config never breaks the
    listing endpoint.
    """
    if is_busy(runtime.state):
        return
    try:
        runtime.refresh_if_dirty()
    except Exception as exc:
        logger.warning(
            "session_agents_refresh_failed name={} error={}", runtime.name, exc
        )


def invalidate_skill_cache() -> None:
    """Clear the ``discover_skills`` lru_cache so the next tool call
    picks up edits to ``{SKILLS_DIR}/*/SKILL.md``.  No team reload needed.
    """
    from app.agent.tools.builtin.skill import _discover_skills_cached

    _discover_skills_cached.cache_clear()
    logger.info("team_manager_skill_cache_invalidated")
