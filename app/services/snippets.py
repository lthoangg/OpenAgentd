"""Prompt-snippet discovery and rendering for coding workspaces.

Snippets are markdown files with optional YAML frontmatter:

    ---
    description: One-line description shown in the picker
    ---

    Body becomes the inserted prompt snippet.

Discovery walks OpenAgentd-native snippet roots in precedence order — first hit
wins on a name collision:

    1. ``{workspace}/.openagentd/snippets/``      (project, OpenAgentd-native; coding mode only)
    2. ``{workspace}/.agents/snippets/``          (project, universal .agents; coding mode only)
    3. ``{OPENAGENTD_CONFIG_DIR}/snippets/``      (global, OpenAgentd)
    4. ``~/.agents/snippets/``                    (global, universal .agents)

Nested folders are honoured one level deep: ``snippets/git/commit.md`` registers
as ``git/commit``.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from app.core.chat_workspace import is_chat_workspace
from app.core.config import settings
from app.services.commands import _iter_md, _parse_frontmatter


@dataclass(frozen=True)
class Snippet:
    """A discovered prompt snippet."""

    name: str
    description: str
    body: str
    path: Path
    source: str  # one of: project-openagentd / project-agents / global-openagentd / global-agents


def _candidate_roots(workspace: Path) -> list[tuple[Path, str]]:
    home = Path.home()
    config = Path(settings.OPENAGENTD_CONFIG_DIR)
    # Project roots are coding-only — a chat workspace (see
    # ``app.core.chat_workspace``) is not a project and sees global snippets
    # only.
    roots: list[tuple[Path, str]] = []
    if not is_chat_workspace(workspace):
        roots.extend(
            [
                (workspace / ".openagentd" / "snippets", "project-openagentd"),
                (workspace / ".agents" / "snippets", "project-agents"),
            ]
        )
    roots.extend(
        [
            (config / "snippets", "global-openagentd"),
            (home / ".agents" / "snippets", "global-agents"),
        ]
    )
    return roots


def discover_snippets(workspace: Path) -> dict[str, Snippet]:
    """Return ``{name: Snippet}`` for snippets available to *workspace*."""
    snippets: dict[str, Snippet] = {}
    for root, source in _candidate_roots(workspace):
        for path, name in _iter_md(root):
            if name in snippets:
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except OSError:
                continue
            meta, body = _parse_frontmatter(text)
            description = meta.get("description", "")
            if not isinstance(description, str):
                description = ""
            snippets[name] = Snippet(
                name=name,
                description=description.strip(),
                body=body,
                path=path,
                source=source,
            )
    return snippets
