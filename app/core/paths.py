"""Centralised path helpers for session-scoped on-disk resources.

Single root per session — uploads live *inside* the workspace:

- ``workspace_dir(session_id)`` → ``{OPENAGENTD_WORKSPACE_DIR}/{session_id}``
  Agent workspace — where write/shell tools produce files.  Bounded by
  the sandbox.  Served publicly via the ``/media/`` proxy so the web UI
  can render images the assistant references in markdown.

- ``uploads_dir(session_id)`` → ``{workspace_dir(session_id)}/uploads``
  User-uploaded attachment files (UUID-named, validated at upload).
  Reachable by the agent's filesystem tools as the relative path
  ``uploads/<filename>`` from the workspace root.  The agent receives a
  path hint at dispatch time and uses its Read / shell tools to inspect
  the file.  Absolute path persisted in ``att["path"]`` for reference.
"""

from __future__ import annotations

from pathlib import Path

from app.core.config import settings


#: Directory name under OPENAGENTD_DATA_DIR holding per-session artifacts.
SESSIONS_DIR = "sessions"


def sessions_root() -> Path:
    """Return the root directory for all session artifact dirs."""
    return Path(settings.OPENAGENTD_DATA_DIR) / SESSIONS_DIR


def session_artifacts_dir(session_id: str | None) -> Path:
    """Return the app-managed metadata directory for *session_id*.

    Pure path computation — no contextvar lookups. The
    context-aware default lives in :func:`app.agent.artifacts.session_artifact_dir`;
    this lower-level helper exists so ``app.agent.denied_paths`` can compute the
    path without importing ``app.agent.artifacts`` (which imports denied_paths
    back — a module-level cycle).
    """
    root = sessions_root()
    return root / session_id if session_id else root


def workspace_dir(session_id: str) -> Path:
    """Return the per-session agent workspace root (agent sandbox)."""
    return Path(settings.OPENAGENTD_WORKSPACE_DIR) / session_id


def session_workspace_dir(session_id: str, workspace: str | None = None) -> Path:
    """Return the session workspace or exact coding workspace."""
    if workspace:
        return Path(workspace).resolve()
    return workspace_dir(session_id)


def uploads_dir(session_id: str) -> Path:
    """Return the per-session directory for user-uploaded attachments.

    Lives under the session workspace so the agent's filesystem tools
    can reach it as ``uploads/<filename>``.
    """
    return workspace_dir(session_id) / "uploads"


def session_uploads_dir(session_id: str, workspace: str | None = None) -> Path:
    """Return uploads storage for the session or coding workspace.

    Interactive uploads are stored under the app-managed per-session workspace.
    Coding mode stores uploads under the selected workspace so the agent can
    reach them directly as ``uploads/<filename>`` from its sandbox root.
    """
    return session_workspace_dir(session_id, workspace) / "uploads"
