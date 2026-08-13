"""LSP navigation tool for coding-mode agents."""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field

from app.agent.sandbox import get_sandbox
from app.agent.tools.registry import InjectedArg, Tool
from app.services.lsp import lsp_manager

_MAX_RESULTS = 50


def _relative_location(item: dict, workspace: Path) -> tuple[str, str] | None:
    location = item.get("location", item)
    if "targetUri" in item:
        location = {
            "uri": item["targetUri"],
            "range": item.get("targetSelectionRange", item.get("targetRange", {})),
        }
    if not isinstance(location, dict):
        return None
    uri = location.get("uri")
    position = location.get("range", {}).get("start", {})
    if not isinstance(uri, str) or not uri.startswith("file:"):
        return None
    sandbox = get_sandbox()
    try:
        unresolved = Path.from_uri(uri)
        path = unresolved.resolve()
    except ValueError:
        return None
    if (
        not path.is_relative_to(workspace)
        or sandbox.is_denied_path(unresolved)
        or sandbox.is_denied_path(path)
    ):
        return None
    if not isinstance(position, dict):
        return None
    line, character = position.get("line"), position.get("character")
    if not isinstance(line, int) or not isinstance(character, int):
        return None
    return path.relative_to(workspace).as_posix(), f"{line + 1}:{character + 1}"


async def _lsp_navigation(
    operation: Annotated[
        Literal[
            "go_to_definition",
            "find_references",
            "document_symbol",
            "workspace_symbol",
        ],
        Field(description="Semantic navigation operation."),
    ],
    path: Annotated[
        str,
        Field(
            description=(
                "Required workspace-relative source file used to select a language "
                "server, including for workspace_symbol."
            )
        ),
    ],
    line: Annotated[int, Field(ge=1, description="One-based source line.")] = 1,
    character: Annotated[
        int, Field(ge=1, description="One-based character offset.")
    ] = 1,
    query: Annotated[str, Field(description="Symbol query for workspace_symbol.")] = "",
    _mode: Annotated[Literal["normal", "coding"], InjectedArg()] = "normal",
    _workspace: Annotated[str | None, InjectedArg()] = None,
) -> str:
    """Navigate code with the workspace language server."""
    if _mode != "coding" or not _workspace:
        raise PermissionError("LSP navigation is only available in coding mode")
    workspace = get_sandbox().workspace_root.resolve()
    if Path(_workspace).resolve() != workspace:
        raise PermissionError("coding workspace is unavailable")
    if not path:
        raise ValueError(f"path is required for {operation}")
    candidate = Path(path)
    if candidate.is_absolute() or "~" in candidate.parts:
        raise PermissionError("path is outside the coding workspace")
    sandbox = get_sandbox()
    unresolved_source = sandbox.workspace_root / candidate
    if sandbox.is_denied_path(unresolved_source):
        raise PermissionError(f"Path '{path}' is inside a denied sandbox path")
    source = sandbox.validate_path(path)
    if not source.is_relative_to(workspace):
        raise PermissionError("path is outside the coding workspace")
    if not source.is_file():
        raise FileNotFoundError(f"File not found: {path}")

    results = await lsp_manager.navigation(
        operation,
        workspace,
        file_path=source,
        line=line - 1,
        character=character - 1,
        query=query,
    )
    formatted: set[str] = set()
    for item in results:
        parsed = _relative_location(item, workspace)
        if parsed is None:
            continue
        display_path, position = parsed
        name = item.get("name") if isinstance(item, dict) else None
        formatted.add(
            f"{name} | {display_path}:{position}"
            if isinstance(name, str)
            else f"{display_path}:{position}"
        )
    if not formatted:
        return "No results."
    return "\n".join(sorted(formatted)[:_MAX_RESULTS])


lsp_navigation = Tool(
    _lsp_navigation,
    name="lsp",
    description=(
        "Coding mode only. Use LSP for code definitions, references, and symbols; "
        "use grep/glob for text or filename patterns. Returns up to 50 compact "
        "workspace-relative locations."
    ),
)
