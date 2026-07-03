"""Slash-command discovery and rendering for the chat input picker."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

from app.api.schemas.commands import (
    CommandListResponse,
    CommandRenderRequest,
    CommandRenderResponse,
    CommandSummary,
)
from app.services import team_manager
from app.services.commands import (
    discover_commands,
    get_builtin_command,
    render_command,
)

router = APIRouter()


def _workspace_path(workspace: str | None) -> Path | None:
    if workspace is None:
        return None
    try:
        resolved = team_manager.validate_workspace(workspace)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return Path(resolved)


@router.get("")
async def list_commands(
    workspace: str | None = Query(None, description="Coding workspace directory."),
) -> CommandListResponse:
    workspace_path = _workspace_path(workspace)
    rows = [
        CommandSummary(name=cmd.name, description=cmd.description, source=cmd.source)
        for cmd in discover_commands(workspace_path).values()
    ]
    rows.sort(key=lambda r: r.name)
    return CommandListResponse(commands=rows)


@router.post("/{name:path}/render")
async def render(
    name: str,
    body: CommandRenderRequest,
    workspace: str | None = Query(None, description="Coding workspace directory."),
) -> CommandRenderResponse:
    workspace_path = _workspace_path(workspace)
    # Disk-discovered user commands take precedence so a user can shadow a
    # built-in by dropping their own ``init.md`` into a commands root.
    cmd = discover_commands(workspace_path).get(name) or get_builtin_command(name)
    if cmd is None:
        raise HTTPException(status_code=404, detail=f"Command '{name}' not found.")
    return CommandRenderResponse(
        name=cmd.name, content=render_command(cmd, body.arguments)
    )
