"""Domain models for the persistent Markdown memory subsystem."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from pydantic import BaseModel


@dataclass(frozen=True, slots=True)
class MemoryScope:
    """Identity and filesystem root of an isolated memory scope."""

    kind: Literal["global", "workspace"]
    root: Path

    @property
    def scope_key(self) -> str:
        if self.kind == "global":
            return "global"
        return f"workspace:{self.root.resolve().as_posix()}"


class MemoryFrontmatter(BaseModel):
    """Optional frontmatter parsed from a memory Markdown page."""

    title: str | None = None
    type: str = "general"


@dataclass(frozen=True, slots=True)
class MemoryPage:
    """One authoritative Markdown memory page."""

    path: str  # scope-relative POSIX path (e.g. "auth.md" or "topics/db.md")
    content: str
    frontmatter: MemoryFrontmatter | None
    etag: str  # quoted strong ETag: '"sha256:..."'


@dataclass(frozen=True, slots=True)
class GlobalMemorySnapshot:
    """Bounded compiled snapshot of Global memory."""

    preferences_content: str  # pinned preferences (<= 400 chars)
    knowledge_catalog: str  # global catalog entries (<= 1100 chars)


@dataclass(frozen=True, slots=True)
class WorkspaceMemorySnapshot:
    """Bounded compiled snapshot of Workspace memory."""

    knowledge_catalog: str  # workspace catalog entries (<= 1100 chars)


@dataclass(frozen=True, slots=True)
class MemoryContextSnapshot:
    """Composed immutable prompt-facing snapshot held by an AgentSession."""

    global_snapshot: GlobalMemorySnapshot
    workspace_snapshot: WorkspaceMemorySnapshot | None
    content: str  # final XML-delimited prompt block (<= 1500 chars)
    content_hash: str  # SHA-256 of final rendered content


@dataclass
class ScopeState:
    """Internal race-control and caching state for a single scope."""

    snapshot: GlobalMemorySnapshot | WorkspaceMemorySnapshot | None = None
    compile_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    epoch: int = 0


@dataclass(frozen=True, slots=True)
class LintFinding:
    """A single deterministic finding from the memory linter."""

    code: str  # e.g. "BROKEN_LINK", "INVALID_FRONTMATTER", "PAGE_TOO_LARGE", "INVALID_WIKILINK_TARGET"
    path: str
    message: str
