"""The prebuilt Chat ("cockpit") workspace.

Chat runs on the same screen as coding workspaces with the same agent profile,
tools, and prompt. The only difference is *scope*: a chat session's root is the
user's home directory, and that root is not treated as a project — no
workspace ``AGENTS.md``, no ``{root}/.openagentd|.agents|.opencode``
skills, commands, or snippets. Global and bundled context is still loaded.

The root lives in ``CHAT_WORKSPACE_DIR`` (default: the user's home). Everything
else derives from it, so chat mode has a single definition that the API, agent
runtime, and services share. Deriving rather than persisting keeps the
``workspace`` contract intact: a chat session is an ordinary session whose
workspace happens to be the chat root, so sandboxing, uploads, mentions, the
terminal, and the agent-session cache all keep working unchanged.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

CHAT_WORKSPACE_NAME = "Chat"

#: Session mode derived from the workspace root.
SessionMode = Literal["chat", "coding"]


def chat_workspace_root() -> Path:
    """Return the resolved chat root: ``CHAT_WORKSPACE_DIR`` or the home dir."""
    from app.core.config import settings

    configured = (settings.CHAT_WORKSPACE_DIR or "").strip()
    if not configured or configured.rstrip("/") == "~":
        # ``Path.home()`` is read at call time so callers (and tests) can
        # redirect it; ``expanduser`` would consult ``$HOME`` directly instead.
        return Path.home().resolve()
    if configured.startswith("~/"):
        return (Path.home() / configured[2:]).resolve()
    return Path(configured).expanduser().resolve()


def is_chat_workspace(workspace: str | Path | None) -> bool:
    """Return whether *workspace* is the chat root.

    Never raises: an empty, missing, or unreadable path is simply "not chat".
    """
    if workspace is None:
        return False
    raw = str(workspace).strip()
    if not raw:
        return False
    try:
        resolved = Path(raw).expanduser().resolve()
    except (OSError, RuntimeError, ValueError):
        return False
    return resolved == chat_workspace_root()


def workspace_mode(workspace: str | Path | None) -> SessionMode:
    """Return the session mode for *workspace* — ``"chat"`` or ``"coding"``."""
    return "chat" if is_chat_workspace(workspace) else "coding"
