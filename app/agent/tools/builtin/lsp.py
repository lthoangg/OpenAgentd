"""LSP navigation tool for coding-mode agents."""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field

from app.agent.sandbox import get_sandbox
from app.agent.tools.registry import InjectedArg, Tool
from app.services.lsp import lsp_manager

_MAX_RESULTS = 50

# LSP spec `SymbolKind` enum (textDocument/documentSymbol, workspace/symbol).
# Surfacing this alongside a symbol's name turns "Widget" into "Widget
# (class)" — a same-named function/class/variable ambiguity an agent would
# otherwise have to open the file to resolve.
_SYMBOL_KIND_LABELS: dict[int, str] = {
    1: "file",
    2: "module",
    3: "namespace",
    4: "package",
    5: "class",
    6: "method",
    7: "property",
    8: "field",
    9: "constructor",
    10: "enum",
    11: "interface",
    12: "function",
    13: "variable",
    14: "constant",
    15: "string",
    16: "number",
    17: "boolean",
    18: "array",
    19: "object",
    20: "key",
    21: "null",
    22: "enum member",
    23: "struct",
    24: "event",
    25: "operator",
    26: "type parameter",
}


def _relative_location(item: dict, workspace: Path) -> tuple[str, int, int] | None:
    """Resolve *item* to a sandboxed workspace-relative ``(path, line, character)``.

    ``line``/``character`` are returned 1-based (LSP positions are 0-based).
    """
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
    return path.relative_to(workspace).as_posix(), line + 1, character + 1


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
    # (sort_key, formatted_line); dedup by line text since multiple LSP
    # clients (e.g. Python's ty + ruff) can report the same location twice.
    seen: set[str] = set()
    entries: list[tuple[tuple[int, int] | str, str]] = []
    for item in results:
        parsed = _relative_location(item, workspace)
        if parsed is None:
            continue
        display_path, line_no, char_no = parsed
        name = item.get("name") if isinstance(item, dict) else None
        kind = item.get("kind") if isinstance(item, dict) else None
        kind_label = _SYMBOL_KIND_LABELS.get(kind) if isinstance(kind, int) else None
        if isinstance(name, str):
            label = f"{name} ({kind_label})" if kind_label else name
            line_text = f"{label} | {display_path}:{line_no}:{char_no}"
        else:
            line_text = f"{display_path}:{line_no}:{char_no}"
        if line_text in seen:
            continue
        seen.add(line_text)
        # A single document's symbols read top-to-bottom, so source position
        # is the useful order. workspace_symbol/find_references/
        # go_to_definition span many files with no such natural order —
        # alphabetical keeps those deterministic across LSP clients instead.
        sort_key = (line_no, char_no) if operation == "document_symbol" else line_text
        entries.append((sort_key, line_text))
    if not entries:
        return "No results."
    entries.sort(key=lambda entry: entry[0])
    return "\n".join(line_text for _, line_text in entries[:_MAX_RESULTS])


lsp_navigation = Tool(
    _lsp_navigation,
    name="lsp",
    description=(
        "Semantic code navigation via the workspace language server: jump to a "
        "symbol's definition, find every reference to it, list a file's symbols "
        "in source order, or search symbols by name across the whole workspace. "
        "It understands the language, so it resolves what text search can't — "
        "renamed imports, overridden methods, a symbol name that also appears in "
        "a comment or string elsewhere. Use grep for text search or glob for "
        "filename patterns instead. Returns up to 50 compact, deduplicated "
        "workspace-relative locations."
    ),
)
