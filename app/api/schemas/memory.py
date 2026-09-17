"""Request and response schemas for /api/agent/memory endpoints."""

from __future__ import annotations

from typing import Literal
from pydantic import BaseModel, Field


class MemoryPageSummary(BaseModel):
    """Lightweight metadata for a memory page in the tree view."""

    path: str
    title: str
    type: str = "general"
    scope: Literal["global", "workspace"]


class MemoryTreeResponse(BaseModel):
    """List of memory pages across queried scope(s)."""

    pages: list[MemoryPageSummary]


class MemoryFileResponse(BaseModel):
    """Authoritative memory file content and metadata."""

    path: str
    content: str
    etag: str
    scope: Literal["global", "workspace"]
    frontmatter: dict[str, str | None] | None = None


class MemoryWriteRequest(BaseModel):
    """Write request for updating or creating a memory page."""

    content: str = Field(description="Full Markdown file contents.")


class MemorySearchResult(BaseModel):
    """Result of a keyword/title search over memory pages."""

    scope: Literal["global", "workspace"]
    path: str
    title: str


class MemorySearchResponse(BaseModel):
    """List of search results."""

    results: list[MemorySearchResult]


class MemoryFindingItem(BaseModel):
    """A single finding from the memory linter."""

    code: str
    path: str
    message: str


class MemoryLintReport(BaseModel):
    """Report produced by the deterministic memory linter."""

    findings: list[MemoryFindingItem]
