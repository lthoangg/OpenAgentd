"""Path-denylist and validation utilities for filesystem and computer tools.

Tools use a **denylist** model: agent filesystem operations may touch
any path on disk *except* paths that resolve under one of the denied roots or
match a user-defined glob pattern in ``denied_paths.yaml``.

By default the denied roots are:

- ``OPENAGENTD_DATA_DIR``    — openagentd's SQLite DB and other internal data.
- ``OPENAGENTD_STATE_DIR``   — logs, telemetry, OTEL rollups
- ``OPENAGENTD_CACHE_DIR``   — regeneratable cache including OAuth tokens

Self-diagnostic carve-outs
--------------------------
A few subtrees of those roots are re-allowed so an agent can inspect its
own runtime (logs, OTEL rollups, context-window dumps, and this session's
artifacts) — see :func:`_allowed_internal_roots` for the exact list and the
rationale for what stays denied. Credentials (``CACHE_DIR``), the SQLite
DB, undo/redo snapshots, and other sessions' artifacts are **not** in that
carve-out.

User uploads live *inside* the per-session workspace
(``{workspace}/<sid>/uploads/``) and are therefore reachable by the
agent's fs tools as the relative path ``uploads/<filename>``.

All relative paths resolve under ``workspace_root`` (the implicit "current
directory" for the agent). Absolute paths anywhere on the filesystem are
accepted as long as they don't fall under a denied root.

Symlink rejection
-----------------
Symlinks whose target lands inside a denied root are rejected.

Tilde expansion
---------------
Tilde paths (``~/...``) are rejected at the API surface.

Command validation
------------------
Shell-command validation lives in :class:`PermissionService`
(``app.agent.permission``). The path guard additionally provides
:meth:`DeniedPathsConfig.check_command` — a best-effort scanner that walks
shell-tokenised commands looking for path arguments inside denied roots
or matching deny-patterns.
"""

from __future__ import annotations

import contextvars
import fnmatch
import os
import shlex
import stat as stat_module
from pathlib import Path

from loguru import logger

from app.core.config import settings
from app.core.paths import session_artifacts_dir

# ── Module-level defaults (no env-var overrides) ──────────────────────────
DEFAULT_MAX_EXECUTION_SECONDS = 120
DEFAULT_MAX_OUTPUT_BYTES = 131072
DEFAULT_ALLOW_NETWORK = True

# ── Context-aware Path Denylist ──────────────────────────────────────────

_denied_paths_ctx: contextvars.ContextVar["DeniedPathsConfig"] = contextvars.ContextVar(
    "denied_paths_ctx"
)
_sandbox_ctx = _denied_paths_ctx


def get_denied_paths() -> "DeniedPathsConfig":
    """Return the active DeniedPathsConfig for the current context."""
    try:
        return _denied_paths_ctx.get()
    except LookupError:
        return _get_default_denied_paths()


get_sandbox = get_denied_paths


def set_denied_paths(
    denied_paths: "DeniedPathsConfig",
) -> contextvars.Token:
    """Set the active DeniedPathsConfig for the current context."""
    return _denied_paths_ctx.set(denied_paths)


set_sandbox = set_denied_paths


class DeniedPathsConfig:
    """Denylist-based path guard for the agent's filesystem tools.

    All relative paths resolve under ``workspace_root``.
    Absolute paths are accepted as-is, subject to the denylist check.
    """

    def __init__(
        self,
        workspace: str | None = None,
        session_id: str | None = None,
        denied_roots: list[Path] | None = None,
        denied_patterns: list[str] | None = None,
        max_execution_seconds: int | None = None,
        max_output_bytes: int | None = None,
        allow_network: bool | None = None,
        # Kept for backward compatibility — ignored.
        memory: str | None = None,
    ):
        if not workspace:
            raise ValueError(
                "DeniedPathsConfig requires an explicit workspace path; "
                "no implicit default is provided."
            )
        self.workspace_root: Path = Path(workspace).resolve()
        self.session_id = session_id
        self.workspace_root.mkdir(parents=True, exist_ok=True)

        if denied_roots is None:
            denied_roots = [
                Path(settings.OPENAGENTD_DATA_DIR).resolve(),
                Path(settings.OPENAGENTD_STATE_DIR).resolve(),
                Path(settings.OPENAGENTD_CACHE_DIR).resolve(),
            ]
        self.denied_roots: list[Path] = list(denied_roots)

        if denied_patterns is None:
            try:
                from app.agent.denied_paths_config import load_config

                denied_patterns = list(load_config().denied_patterns)
            except (ValueError, OSError) as exc:
                logger.warning("denied_paths_patterns_load_failed err={}", exc)
                denied_patterns = []
        self.denied_patterns: list[str] = list(denied_patterns)

        self.max_execution_seconds: int = (
            max_execution_seconds or DEFAULT_MAX_EXECUTION_SECONDS
        )
        self.max_output_bytes: int = max_output_bytes or DEFAULT_MAX_OUTPUT_BYTES
        self.allow_network: bool = (
            allow_network if allow_network is not None else DEFAULT_ALLOW_NETWORK
        )

    def metadata_path(self, name: str) -> Path:
        """Return a path under ``.openagentd`` for this context."""
        return session_artifacts_dir(self.session_id) / name

    # ── Path validation ───────────────────────────────────────────────────

    def _is_denied(self, resolved: Path) -> Path | str | None:
        """Return the denied root or glob pattern that matched, or None.

        Precedence: an allowed root (workspace + the self-diagnostic
        carve-outs) beats a denied *root*, but **user deny-patterns always
        win** — a pattern like ``**/*.log`` intentionally shadows the log
        carve-out, because patterns are hand-authored user config.
        """
        allowed = [self.workspace_root, *_allowed_internal_roots(self.session_id)]
        for denied in self.denied_roots:
            if any(
                _path_is_under(resolved, allowed_root)
                for allowed_root in allowed
                if _path_is_under(allowed_root, denied)
            ):
                continue
            if _path_is_under(resolved, denied):
                return denied
        resolved_str = str(resolved)
        for pattern in self.denied_patterns:
            if fnmatch.fnmatchcase(resolved_str, pattern):
                return pattern
        return None

    def validate_path(self, path: str | Path) -> Path:
        """Resolve *path* and verify it's not inside a denied root or pattern.

        Raises:
            PermissionError: if the resolved path falls under a denied
                root, contains a symlink whose target is denied, or uses
                tilde expansion.
        """
        if str(path).startswith("~"):
            raise PermissionError(f"Tilde paths are not allowed: {path}")

        p = Path(path)
        candidate = p if p.is_absolute() else self.workspace_root / p

        # Walk every component looking for symlinks BEFORE resolve() follows them.
        check = candidate
        while True:
            try:
                st = os.lstat(check)
                if stat_module.S_ISLNK(st.st_mode):
                    target = Path(os.readlink(check))
                    if not target.is_absolute():
                        target = check.parent / target
                    target_resolved = target.resolve()
                    denied = self._is_denied(target_resolved)
                    if denied is not None:
                        logger.warning(
                            "path_symlink_to_denied path={} target={} denied_root={}",
                            candidate,
                            target_resolved,
                            denied,
                        )
                        raise PermissionError(
                            f"Symlink target is inside a denied root: "
                            f"{candidate} -> {target_resolved} (denied: {denied})"
                        )
            except (FileNotFoundError, NotADirectoryError):
                pass
            parent = check.parent
            if parent == check:
                break
            check = parent

        resolved = candidate.resolve()

        denied = self._is_denied(resolved)
        if denied is not None:
            logger.warning(
                "path_denied path={} denied_root={}",
                resolved,
                denied,
            )
            raise PermissionError(
                f"Path '{resolved}' is inside a denied root: {denied}"
            )

        return resolved

    def is_denied_path(self, path: Path) -> bool:
        """True when ``path`` is off-limits (denied root or deny-pattern).

        The cheap, non-raising counterpart to :meth:`validate_path`, for callers
        that enumerate many paths and must filter rather than fail: ``grep`` and
        ``glob`` walk whole trees, and without this a file the user protected
        with ``**/.env`` would have its contents echoed straight back into the
        transcript.

        Symlinks are judged by their target as well as their own name, so an
        innocuous-looking ``notes.txt -> .env`` cannot smuggle a denied file
        past a pattern. Only one ``lstat`` is spent per call, and only for the
        link case is the target resolved — callers are about to read or stat the
        file anyway.
        """
        if self._is_denied(path) is not None:
            return True
        try:
            if not path.is_symlink():
                return False
            return self._is_denied(path.resolve()) is not None
        except OSError:
            # Broken or unreadable link: refuse rather than guess.
            return True

    def display_path(self, resolved: Path) -> str:
        """Format an absolute path for human-facing output.

        Paths inside ``workspace_root`` become relative (e.g. ``src/main.py``).
        Paths outside stay absolute.
        """
        try:
            return str(resolved.relative_to(self.workspace_root))
        except ValueError:
            return str(resolved)

    def check_command(self, command_line: str) -> Path | str | None:
        """Best-effort scan of a shell command line for path arguments in denied roots.

        Tokenises *command_line* using POSIX or Windows rules, resolves any
        token that looks like a path against *workspace_root*, and checks it
        with :meth:`_is_denied`. Returns the denied root/pattern if a hit is
        found, or None if clean.
        """
        posix_mode = os.name != "nt"
        try:
            tokens = shlex.split(command_line, posix=posix_mode)
        except ValueError:
            return None

        for token in tokens:
            if not _looks_path_like(token):
                continue
            p = Path(token)
            candidate = p if p.is_absolute() else self.workspace_root / p
            try:
                resolved = candidate.resolve()
            except OSError:
                continue

            hit = self._is_denied(resolved)
            if hit is not None:
                logger.warning(
                    "path_command_denied token={} resolved={} denied={}",
                    token,
                    resolved,
                    hit,
                )
                return hit

        return None


# Backward-compatibility alias
SandboxConfig = DeniedPathsConfig


def _path_is_under(path: Path, parent: Path) -> bool:
    """Return True if *path* equals *parent* or lives inside it."""
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _allowed_internal_roots(session_id: str | None) -> tuple[Path, ...]:
    """Subtrees of denied state/data roots re-allowed for self-diagnostics.

    Agents need to read their own runtime logs and telemetry (OTEL rollups,
    context-window dumps) to support self-healing / oad/debug-prod commands,
    and their active session artifact dir to read/write workspace state.
    Credentials (CACHE_DIR), the SQLite DB, and other sessions stay denied.
    """
    state_root = Path(settings.OPENAGENTD_STATE_DIR).resolve()
    allowed: list[Path] = [
        state_root / "logs",
        state_root / "otel",
        state_root / "telemetry",
    ]
    if session_id:
        allowed.append(session_artifacts_dir(session_id).resolve())
    return tuple(allowed)


def _looks_path_like(token: str) -> bool:
    """True if *token* contains path separators, file extensions, dotfiles, or tilde."""
    if not token or token.startswith("-"):
        return False
    if token.startswith("~") or token.startswith("."):
        return True
    if "/" in token or "\\" in token:
        return True
    p = Path(token)
    return bool(p.suffix) and len(p.suffix) > 1


_default_denied_paths_instance: DeniedPathsConfig | None = None


def _get_default_denied_paths() -> DeniedPathsConfig:
    global _default_denied_paths_instance
    if _default_denied_paths_instance is None:
        import tempfile

        _default_denied_paths_instance = DeniedPathsConfig(
            workspace=str(Path(tempfile.gettempdir()) / "openagentd-default-workspace"),
        )
    return _default_denied_paths_instance


_get_default_sandbox = _get_default_denied_paths
