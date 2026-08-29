"""Single-agent lifecycle and session manager.

Sessions are loaded lazily on first use and evicted after an idle window.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import TYPE_CHECKING

from loguru import logger

from app.agent.loader import (
    load_agent_from_dir,
    validate_canonical_code_profile,
)
from app.core.config import settings

if TYPE_CHECKING:
    from app.agent.session import AgentSession

# ── Module-level state ───────────────────────────────────────────────────────

_sessions: dict[tuple[str, str], AgentSession] = {}
_session_last_used: dict[tuple[str, str], float] = {}
_session_start_locks: dict[tuple[str, str], asyncio.Lock] = {}
_SESSION_IDLE_SECONDS = 30 * 60
_lock = asyncio.Lock()

_AgentsDirSignature = tuple[tuple[str, int, int], ...] | None
_agents_dir_validation: dict[
    Path, tuple[_AgentsDirSignature | _UnstableSignature, bool]
] = {}


class _UnstableSignature:
    pass


_UNSTABLE = _UnstableSignature()


def _agents_dir_signature(agents_dir: Path) -> _AgentsDirSignature | _UnstableSignature:
    if not agents_dir.is_dir():
        return None
    entries: list[tuple[str, int, int]] = []
    for path in sorted(agents_dir.glob("*.md")):
        try:
            st = path.stat()
        except OSError:
            return _UNSTABLE
        entries.append((path.name, st.st_mtime_ns, st.st_size))
    return tuple(entries)


def reset_agents_dir_validation_cache() -> None:
    _agents_dir_validation.clear()


def _resolve_agents_dir() -> Path:
    path = Path(settings.AGENTS_DIR)
    return path if path.is_absolute() else Path.cwd() / path


def _resolve_workspace(workspace: str) -> Path:
    return Path(workspace).expanduser().resolve()


def _session_is_evictable(session: AgentSession) -> bool:
    """Return whether a session can be stopped without interrupting a turn."""
    return session.state not in {"working", "waiting_input"} and not session.is_busy()


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
    """Resolve and validate a workspace path."""
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
            if "restricted system directory" in str(exc):
                raise
    return str(resolved)


def validate_agents_dir(agents_dir: str | Path | None = None) -> bool:
    """Check that agents directory contains a valid canonical code profile."""
    resolved = Path(agents_dir).resolve() if agents_dir else _resolve_agents_dir()
    sig = _agents_dir_signature(resolved)
    if sig is not _UNSTABLE and sig in _agents_dir_validation.get(resolved, ()):
        return _agents_dir_validation[resolved][1]

    if not resolved.is_dir():
        if sig is not _UNSTABLE:
            _agents_dir_validation[resolved] = (sig, False)
        return False

    canonical = resolved / "code.md"
    if not canonical.is_file():
        result = False
    else:
        # Keep malformed canonical profiles visible to startup/health callers.
        validate_canonical_code_profile(canonical)
        result = True
    if sig is not _UNSTABLE:
        _agents_dir_validation[resolved] = (sig, result)
    return result


async def evict_idle_sessions(*, now: float | None = None) -> None:
    """Evict sessions idle past the timeout, without interrupting active turns."""
    cutoff = (time.monotonic() if now is None else now) - _SESSION_IDLE_SECONDS
    async with _lock:
        to_evict = sorted(
            (
                (key, session)
                for key, session in _sessions.items()
                if (last_used := _session_last_used.get(key)) is not None
                and last_used <= cutoff
                and _session_is_evictable(session)
            ),
            key=lambda item: item[0],
        )
        for key, _ in to_evict:
            _sessions.pop(key, None)
            _session_last_used.pop(key, None)
            _session_start_locks.pop(key, None)
    for _, session in to_evict:
        try:
            await session.stop()
        except Exception as exc:
            logger.warning("evict_idle_session_stop_failed error={}", exc)


def find_live_session(
    workspace: str, session_id: str | None = None
) -> AgentSession | None:
    """Find active session by workspace and session_id."""
    try:
        resolved = validate_workspace(workspace, require_exists=False)
    except ValueError:
        return None

    if session_id:
        return _sessions.get((resolved, session_id))

    for (ws, _), sess in _sessions.items():
        if ws == resolved:
            return sess
    return None


def find_live_session_serving_session(session_id: str) -> AgentSession | None:
    """Find live session serving session_id."""
    for (_, sid), sess in _sessions.items():
        if sid == session_id:
            return sess
    return None


def current_agent_session() -> AgentSession | None:
    """Return any active session or None."""
    for sess in _sessions.values():
        return sess
    return None


async def get_or_start_agent_session(
    workspace: str, session_id: str | None = None
) -> AgentSession | None:
    """Get or start a single-agent session for a workspace."""
    resolved = validate_workspace(workspace)
    key = (resolved, session_id or "")

    async with _lock:
        if key not in _session_start_locks:
            _session_start_locks[key] = asyncio.Lock()
        start_lock = _session_start_locks[key]

    async with start_lock:
        now = time.monotonic()
        await evict_idle_sessions(now=now)
        if key in _sessions:
            _session_last_used[key] = now
            return _sessions[key]

        session = load_agent_from_dir(
            _resolve_agents_dir(),
            workspace=resolved,
        )
        if session is None:
            return None

        if session_id:
            await session.attach_to_session(session_id)
        await session.start()

        _sessions[key] = session
        _session_last_used[key] = now
        return session


def set_agent_session(session: AgentSession | None) -> None:
    """Test helper to seed or clear cached session."""
    global _sessions
    if session is None:
        _sessions.clear()
    else:
        ws = session.workspace or ""
        sid = session.session_id or ""
        _sessions[(ws, sid)] = session
        try:
            resolved_cwd = validate_workspace(str(Path.cwd()), require_exists=False)
            _sessions[(resolved_cwd, sid)] = session
            _sessions[(resolved_cwd, "")] = session
            _sessions[(resolved_cwd, "__agents__")] = session
        except Exception:
            pass


async def evict_sessions(session_ids: set[str]) -> None:
    async with _lock:
        to_evict = [
            (k, sess)
            for k, sess in _sessions.items()
            if (k[1] in session_ids or sess.session_id in session_ids)
            and _session_is_evictable(sess)
        ]
        for k, _ in to_evict:
            _sessions.pop(k, None)
            _session_last_used.pop(k, None)
            _session_start_locks.pop(k, None)
    for _, sess in to_evict:
        try:
            await sess.stop()
        except Exception as exc:
            logger.warning("evict_session_stop_failed error={}", exc)


async def stop() -> None:
    """Stop all active sessions."""
    async with _lock:
        sessions_to_stop = list(set(_sessions.values()))
        _sessions.clear()
        _session_last_used.clear()
        _session_start_locks.clear()

    for sess in sessions_to_stop:
        try:
            await sess.stop()
        except Exception as exc:
            logger.warning("agent_session_stop_failed error={}", exc)
