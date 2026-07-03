"""Prompt-snippet discovery and rendering for the coding composer."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

from app.api.schemas.snippets import (
    SnippetListResponse,
    SnippetRenderResponse,
    SnippetSummary,
)
from app.services import team_manager
from app.services.snippets import discover_snippets

router = APIRouter()


def _workspace_path(workspace: str | None) -> Path:
    if workspace is None:
        raise HTTPException(status_code=422, detail="Snippet workspace is required.")
    try:
        resolved = team_manager.validate_workspace(workspace)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return Path(resolved)


@router.get("")
async def list_snippets(
    workspace: str | None = Query(None, description="Coding workspace directory."),
) -> SnippetListResponse:
    workspace_path = _workspace_path(workspace)
    rows = [
        SnippetSummary(name=item.name, description=item.description, source=item.source)
        for item in discover_snippets(workspace_path).values()
    ]
    rows.sort(key=lambda r: r.name)
    return SnippetListResponse(snippets=rows)


@router.post("/{name:path}/render")
async def render_snippet(
    name: str,
    workspace: str | None = Query(None, description="Coding workspace directory."),
) -> SnippetRenderResponse:
    workspace_path = _workspace_path(workspace)
    snippet = discover_snippets(workspace_path).get(name)
    if snippet is None:
        raise HTTPException(status_code=404, detail=f"Snippet '{name}' not found.")
    return SnippetRenderResponse(name=snippet.name, content=snippet.body)
