"""Sandbox configuration and path-validation utilities for computer tools.

The sandbox uses a **denylist** model: agent filesystem operations may touch
any path on disk *except* paths that resolve under one of the denied roots.
By default the denied roots are:

- ``OPENAGENTD_DATA_DIR``    — openagentd's SQLite DB and other internal data.
- ``OPENAGENTD_STATE_DIR``   — logs, telemetry, OTEL rollups
- ``OPENAGENTD_CACHE_DIR``   — regeneratable cache including OAuth tokens

User uploads live *inside* the per-session workspace
(``{workspace}/<sid>/uploads/``) and are therefore reachable by the
agent's fs tools as the relative path ``uploads/<filename>``.

All relative paths resolve under ``workspace_root`` (the implicit "current
directory" for the agent).  Absolute paths anywhere on the filesystem are
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
(``app.agent.permission``).  The sandbox additionally provides
:meth:`SandboxConfig.check_command` — a best-effort scanner that walks
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

# ── Module-level defaults (no env-var overrides) ──────────────────────────
DEFAULT_MAX_EXECUTION_SECONDS = 120
DEFAULT_MAX_OUTPUT_BYTES = 131072
DEFAULT_ALLOW_NETWORK = True

# ── Context-aware Sandbox ───────────────────────────────────────────────

_sandbox_ctx: contextvars.ContextVar["SandboxConfig"] = contextvars.ContextVar(
    "sandbox_ctx"
)


def get_sandbox() -> "SandboxConfig":
    """Return the active SandboxConfig for the current context."""
    try:
        return _sandbox_ctx.get()
    except LookupError:
        return _get_default_sandbox()


def set_sandbox(sandbox: "SandboxConfig") -> contextvars.Token:
    """Set the active SandboxConfig for the current context."""
    return _sandbox_ctx.set(sandbox)


class SandboxConfig:
    """Denylist-based sandbox for the agent's filesystem tools.

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
                "SandboxConfig requires an explicit workspace path; "
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
                from app.agent.sandbox_config import load_config

                denied_patterns = list(load_config().denied_patterns)
            except (ValueError, OSError) as exc:
                logger.warning("sandbox_patterns_load_failed err={}", exc)
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
        """Return a path under ``.openagentd`` for this sandbox context."""
        from app.agent.artifacts import session_artifact_dir

        return session_artifact_dir(self.session_id) / name

    # ── Path validation ───────────────────────────────────────────────────

    def _is_denied(self, resolved: Path) -> Path | str | None:
        """Return the denied root or glob pattern that matched, or None."""
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
        if any(_path_is_under(resolved, root) for root in allowed):
            return None
        return None

    def validate_path(self, path: str | Path) -> Path:
        """Resolve *path* and verify it's not inside a denied root.

        Raises:
            PermissionError: if the resolved path falls under a denied
                root, contains a symlink whose target is denied, or uses
                tilde expansion.
        """
        if str(path).startswith("~"):
            raise PermissionError(
                f"Tilde paths are not allowed inside the sandbox: {path}"
            )

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
                            "sandbox_symlink_to_denied path={} target={} denied_root={}",
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
                "sandbox_path_denied path={} denied_root={}",
                resolved,
                denied,
            )
            raise PermissionError(
                f"Path '{resolved}' is inside a denied sandbox root: {denied}"
            )

        return resolved

    # ── Command validation (best-effort) ─────────────────────────────────

    def check_command(self, command: str) -> tuple[Path, str] | None:
        """Best-effort scan of *command* for arguments inside denied paths."""
        try:
            tokens = shlex.split(command, posix=True)
        except ValueError:
            return None

        for tok in tokens:
            if not _looks_path_like(tok):
                continue
            expanded = os.path.expanduser(tok)
            p = Path(expanded)
            candidate = p if p.is_absolute() else (self.workspace_root / p)
            try:
                resolved = candidate.resolve()
            except OSError:
                continue
            denied = self._is_denied(resolved)
            if denied is not None:
                logger.warning(
                    "sandbox_command_denied token={} resolved={} denied={}",
                    tok,
                    resolved,
                    denied,
                )
                return resolved, str(denied)
        return None

    # ── Display helpers ──────────────────────────────────────────────────

    def display_path(self, resolved: Path) -> str:
        """Return a display path for ``resolved``."""
        if _path_is_under(resolved, self.workspace_root):
            rel = resolved.relative_to(self.workspace_root)
            return str(self.workspace_root) if str(rel) == "." else str(rel)
        return str(resolved)


def _path_is_under(child: Path, parent: Path) -> bool:
    """True if *child* equals or is contained by *parent* (after resolve)."""
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def _allowed_internal_roots(session_id: str | None) -> list[Path]:
    """Return internal OpenAgentd paths agents may inspect."""
    roots = [Path(settings.OPENAGENTD_STATE_DIR).resolve() / "logs"]
    if session_id:
        from app.agent.artifacts import session_artifact_dir

        roots.append(session_artifact_dir(session_id).resolve())
    return roots


def _looks_path_like(token: str) -> bool:
    if not token:
        return False
    if token.startswith("-"):
        return False
    if "/" in token:
        return True
    if token.startswith("~"):
        return True
    if token.startswith("."):
        return True
    return False


_default_sandbox_instance: SandboxConfig | None = None


def _get_default_sandbox() -> SandboxConfig:
    global _default_sandbox_instance
    if _default_sandbox_instance is None:
        import tempfile

        _default_sandbox_instance = SandboxConfig(
            workspace=str(Path(tempfile.gettempdir()) / "openagentd-default-sandbox"),
        )
    return _default_sandbox_instance
