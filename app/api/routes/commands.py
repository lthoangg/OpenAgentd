"""Slash-command discovery and rendering for the chat input picker."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.api.schemas.commands import (
    CommandListResponse,
    CommandRenderRequest,
    CommandRenderResponse,
    CommandSummary,
)
from app.services.commands import (
    discover_commands,
    get_builtin_command,
    render_command,
)

router = APIRouter()


@router.get("")
async def list_commands() -> CommandListResponse:
    rows = [
        CommandSummary(name=cmd.name, description=cmd.description, source=cmd.source)
        for cmd in discover_commands().values()
    ]
    rows.sort(key=lambda r: r.name)
    return CommandListResponse(commands=rows)


@router.post("/{name:path}/render")
async def render(name: str, body: CommandRenderRequest) -> CommandRenderResponse:
    # Disk-discovered user commands take precedence so a user can shadow a
    # built-in by dropping their own ``init.md`` into a commands root.
    cmd = discover_commands().get(name) or get_builtin_command(name)
    if cmd is None:
        raise HTTPException(status_code=404, detail=f"Command '{name}' not found.")
    return CommandRenderResponse(
        name=cmd.name, content=render_command(cmd, body.arguments)
    )
