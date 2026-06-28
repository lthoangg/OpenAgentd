"""Centralised path helpers for session-scoped on-disk resources.

Single root per session — uploads live *inside* the workspace:

- ``workspace_dir(session_id)`` → ``{OPENAGENTD_WORKSPACE_DIR}/{session_id}``
  Agent workspace — where write/shell tools produce files.  Bounded by
  the sandbox.  Served publicly via the ``/media/`` proxy so the web UI
  can render images the assistant references in markdown.

- ``uploads_dir(session_id)`` → ``{workspace_dir(session_id)}/uploads``
  User-uploaded attachment files (UUID-named, validated at upload).
  Fed to the LLM via curated multimodal rehydration
  (``build_parts_from_metas``) and *also* reachable by the agent's
  filesystem tools as the relative path ``uploads/<filename>``.  This
  is intentional: it lets the agent pass user-uploaded images into
  workspace-bound tools (image/video generation, etc.) without a
  staging step.

  The absolute file path is persisted in the attachment meta dict
  (``att["path"]``) so rehydration is a pure path lookup — no derivation
  from the message's session id.
"""

from __future__ import annotations

from pathlib import Path

from app.core.config import settings


def workspace_dir(session_id: str) -> Path:
    """Return the per-session agent workspace root (team sandbox)."""
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

    Normal mode stores uploads under the app-managed per-session workspace.
    Coding mode stores uploads under the selected workspace so the agent can
    reach them directly as ``uploads/<filename>`` from its sandbox root.
    """
    return session_workspace_dir(session_id, workspace) / "uploads"
