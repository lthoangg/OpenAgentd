"""LSP navigation tool for coding-mode agents."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import Field

from app.agent.sandbox import get_sandbox
from app.agent.tools.registry import InjectedArg, Tool
from app.services.lsp import lsp_manager
from app.services.lsp.manager import EXTENSION_TO_LANG

_MAX_RESULTS = 50
_MAX_EXCERPT_CHARS = 120
# Operations whose results are positions in code rather than named symbols:
# a source excerpt is what makes them readable without a follow-up read.
_EXCERPT_OPERATIONS = frozenset(
    {"go_to_definition", "find_references", "find_implementations"}
)
_SUPPORTED_EXTENSIONS = sorted(list(EXTENSION_TO_LANG.keys()))

_KEYWORDS = {
    "import",
    "from",
    "def",
    "class",
    "return",
    "async",
    "await",
    "function",
    "const",
    "let",
    "var",
    "export",
    "struct",
    "interface",
    "package",
    "pub",
    "fn",
    "type",
    "alias",
    "try",
    "except",
    "catch",
    "finally",
    "if",
    "else",
    "for",
    "while",
    "with",
    "as",
    "is",
    "in",
    "and",
    "or",
    "not",
    "pass",
    "raise",
    "yield",
    "lambda",
}

# LSP spec `SymbolKind` enum (textDocument/documentSymbol, workspace/symbol).
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
_KIND_LABEL_TO_ID: dict[str, int] = {
    label: kind_id for kind_id, label in _SYMBOL_KIND_LABELS.items()
}


def _parse_kind_filters(kind_str: str) -> set[int] | None:
    """Parse comma-separated or fuzzy kind labels into a set of SymbolKind IDs."""
    if not kind_str:
        return None
    target_ids: set[int] = set()
    parts = [
        p.strip().lower() for p in kind_str.replace("|", ",").split(",") if p.strip()
    ]
    for part in parts:
        if part in _KIND_LABEL_TO_ID:
            target_ids.add(_KIND_LABEL_TO_ID[part])
        else:
            for label, id_ in _KIND_LABEL_TO_ID.items():
                if part in label:
                    target_ids.add(id_)
    return target_ids if target_ids else None


def _hover_text(contents: str | dict[str, Any] | list[Any] | None) -> str:
    """Flatten an LSP ``Hover.contents`` value to plain text/markdown."""
    if contents is None:
        return ""
    if isinstance(contents, str):
        return contents
    if isinstance(contents, dict):
        value = contents.get("value")
        return value if isinstance(value, str) else ""
    if isinstance(contents, list):
        parts = [_hover_text(item) for item in contents]
        return "\n\n".join(part for part in parts if part)
    return ""


def _normalize_hover_blocks(blocks: list[str]) -> list[str]:
    """Deduplicate and normalize overlapping hover content blocks."""
    cleaned: list[str] = [b.strip() for b in blocks if b.strip()]
    if not cleaned:
        return []

    # Filter out redundant fallback blocks containing 'Unknown' when typed signatures exist
    has_concrete = any("Unknown" not in b for b in cleaned)
    if has_concrete:
        cleaned = [b for b in cleaned if "Unknown" not in b or "def " not in b]

    unique: list[str] = []
    for b in cleaned:
        if any(b in existing for existing in unique):
            continue
        unique = [existing for existing in unique if existing not in b]
        unique.append(b)
    return unique


def _extract_reference_role(item: dict) -> str | None:
    """Extract role tag for find_references (e.g. definition, write, read, import)."""
    if not isinstance(item, dict):
        return None
    if item.get("isDefinition"):
        return "definition"
    if item.get("isWrite") or item.get("role") == "write":
        return "write"
    if item.get("isRead") or item.get("role") == "read":
        return "read"
    role = item.get("role")
    if isinstance(role, str) and role:
        return role
    kind = item.get("kind")
    if isinstance(kind, str) and kind:
        return kind
    return None


def _source_excerpt(
    workspace: Path, display_path: str, line_no: int, cache: dict[str, list[str]]
) -> str | None:
    """Return the trimmed source line at *line_no*, or ``None`` when unavailable."""
    lines = cache.get(display_path)
    if lines is None:
        try:
            lines = (
                (workspace / display_path)
                .read_text(encoding="utf-8", errors="replace")
                .splitlines()
            )
        except OSError:
            lines = []
        cache[display_path] = lines
    if not 1 <= line_no <= len(lines):
        return None
    text = lines[line_no - 1].strip()
    if not text:
        return None
    if len(text) > _MAX_EXCERPT_CHARS:
        return text[: _MAX_EXCERPT_CHARS - 1].rstrip() + "…"
    return text


def _match_quality(name: str | None, query: str) -> str | None:
    """Tag how closely a workspace_symbol result matches the query."""
    if not query or not isinstance(name, str):
        return None
    lowered, wanted = name.lower(), query.lower()
    if lowered == wanted:
        return "exact"
    if lowered.startswith(wanted):
        return "prefix"
    return None


def _extract_symbol_at_cursor(source: Path, line: int, character: int) -> str | None:
    """Extract the identifier under the cursor at line:character."""
    try:
        lines = source.read_text(encoding="utf-8").splitlines()
        if 1 <= line <= len(lines):
            line_str = lines[line - 1]
            idx = character - 1
            words = list(re.finditer(r"[A-Za-z_][A-Za-z0-9_]*", line_str))
            for m in words:
                if m.start() <= idx < m.end():
                    return m.group(0)
    except Exception:
        pass
    return None


def _diagnose_empty_location(
    source: Path, line: int, character: int
) -> tuple[str, str] | None:
    """Analyze why an LSP position query produced no results. Returns (reason_code, human_message)."""
    try:
        lines = source.read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    if not lines:
        return ("file_empty", "file is empty")
    if line > len(lines):
        return (
            "out_of_bounds",
            f"line {line} is out of bounds (file has {len(lines)} line{'s' if len(lines) != 1 else ''})",
        )
    line_str = lines[line - 1]
    if character > len(line_str) + 1:
        return (
            "out_of_bounds",
            f"position {line}:{character} is beyond line length ({len(line_str)} chars)",
        )
    idx = character - 1
    if idx >= len(line_str) or line_str[idx].isspace():
        return (
            "whitespace",
            f"cursor at line {line}, character {character} is on whitespace",
        )
    stripped_head = line_str[: idx + 1].lstrip()
    if (
        stripped_head.startswith("#")
        or stripped_head.startswith("//")
        or stripped_head.startswith("/*")
        or "/*" in line_str[:idx]
    ):
        return (
            "comment",
            f"cursor at line {line}, character {character} is inside a comment",
        )

    words = list(re.finditer(r"[A-Za-z_][A-Za-z0-9_]*", line_str))
    for m in words:
        if m.start() <= idx < m.end():
            word = m.group(0)
            if word in _KEYWORDS:
                return (
                    "keyword",
                    f"cursor at line {line}, character {character} is on keyword '{word}'. Place cursor on a symbol identifier.",
                )
            return (
                "unresolved_symbol",
                f"unresolved symbol '{word}' at line {line}, character {character}",
            )

    return (
        "not_symbol",
        f"cursor at line {line}, character {character} is outside a supported symbol construct",
    )


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
            "hover",
            "find_implementations",
        ],
        Field(description="Semantic navigation operation."),
    ],
    path: Annotated[
        str,
        Field(
            description=(
                "Required workspace-relative source file (e.g. 'src/main.py'). Used "
                "to select the language server and workspace context. Must be a file, "
                "not a directory. For workspace_symbol, it selects the language server, "
                "while the query searches across the workspace."
            )
        ),
    ],
    line: Annotated[
        int,
        Field(
            ge=1,
            description=(
                "One-based source line (1-indexed). Landing position must be on the symbol "
                "identifier. Landing on whitespace or comments returns diagnostic feedback."
            ),
        ),
    ] = 1,
    character: Annotated[
        int,
        Field(
            ge=1,
            description=(
                "One-based character offset (1-indexed column). Landing position must be on "
                "the symbol identifier."
            ),
        ),
    ] = 1,
    query: Annotated[
        str,
        Field(
            description=(
                "Symbol query string for workspace_symbol. Passed to the language server "
                "for fuzzy or prefix matching across the workspace."
            )
        ),
    ] = "",
    kind: Annotated[
        str,
        Field(
            description=(
                "Optional symbol kind filter for document_symbol/workspace_symbol "
                "(e.g. 'function', 'class', 'function, method'); case-insensitive, "
                "supports comma-separated kinds or fuzzy matching."
            )
        ),
    ] = "",
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
    if source.is_dir():
        raise ValueError(f"Expected a source file, received a directory: '{path}'")
    if not source.is_file():
        raise FileNotFoundError(
            f"File not found: {path}. Paths are workspace-relative — "
            "use glob or ls to locate the file first."
        )

    lang_id = EXTENSION_TO_LANG.get(source.suffix.lower())
    if lang_id is None:
        return (
            f"No language server support for '{source.suffix}' files. "
            f"Supported extensions: {', '.join(_SUPPORTED_EXTENSIONS)}."
        )

    results = await lsp_manager.navigation(
        operation,
        workspace,
        file_path=source,
        line=line - 1,
        character=character - 1,
        query=query,
    )

    if operation == "hover":
        raw_blocks: list[str] = []
        for item in results:
            text = _hover_text(
                item.get("contents") if isinstance(item, dict) else item
            ).strip()
            if text:
                raw_blocks.append(text)
        hover_blocks = _normalize_hover_blocks(raw_blocks)
        if hover_blocks:
            return "\n\n---\n\n".join(hover_blocks)

        diag_tuple = _diagnose_empty_location(source, line, character)
        human_msg = diag_tuple[1] if diag_tuple else "No hover information available."

        if diag_tuple and "unresolved symbol" not in human_msg:
            return f"No hover information available: {human_msg}."
        return "No hover information available."

    kind_filters = _parse_kind_filters(kind)
    supports_kind_filter = operation in ("document_symbol", "workspace_symbol")
    rel_source = source.relative_to(workspace).as_posix()
    excerpts: dict[str, list[str]] = {}

    seen: set[tuple[str, int, str | int, str | None]] = set()
    entries: list[tuple[tuple[int, int, str], str]] = []
    for item in results:
        parsed = _relative_location(item, workspace)
        if parsed is None:
            continue
        display_path, line_no, char_no = parsed
        name = item.get("name") if isinstance(item, dict) else None
        item_kind = item.get("kind") if isinstance(item, dict) else None
        if (
            supports_kind_filter
            and kind_filters is not None
            and item_kind not in kind_filters
        ):
            continue
        kind_label = (
            _SYMBOL_KIND_LABELS.get(item_kind) if isinstance(item_kind, int) else None
        )

        role: str | None = None
        if operation == "find_references":
            role = _extract_reference_role(item)
        elif operation == "go_to_definition":
            if display_path == rel_source and line_no == line and char_no == character:
                role = "definition"
        elif operation == "workspace_symbol":
            role = _match_quality(name, query)

        role_tag = f" [{role}]" if role else ""
        if isinstance(name, str):
            label = f"{name} ({kind_label})" if kind_label else name
            line_text = f"{label}{role_tag} | {display_path}:{line_no}:{char_no}"
        else:
            line_text = f"{display_path}:{line_no}:{char_no}"
        if operation in _EXCERPT_OPERATIONS:
            excerpt = _source_excerpt(workspace, display_path, line_no, excerpts)
            if excerpt:
                line_text = f"{line_text} | {excerpt}"

        dedup_key = (
            display_path,
            line_no,
            name if isinstance(name, str) else char_no,
            role,
        )
        if dedup_key in seen:
            continue
        seen.add(dedup_key)

        if operation == "document_symbol":
            # A file's own outline reads top-to-bottom.
            sort_key = (line_no, char_no, "")
        elif operation == "workspace_symbol":
            # Exact matches first, then prefix matches, then the rest alphabetically.
            rank = {"exact": 0, "prefix": 1}.get(role or "", 2)
            sort_key = (rank, 0, line_text)
        else:
            sort_key = (0, 0, line_text)
        entries.append((sort_key, line_text))

    # Self-definition check for go_to_definition
    if operation == "go_to_definition" and len(entries) == 1:
        display_path, line_no, char_no = _relative_location(results[0], workspace) or (
            "",
            0,
            0,
        )
        if display_path == rel_source and line_no == line and char_no == character:
            sym = (
                results[0].get("name") if isinstance(results[0], dict) else None
            ) or _extract_symbol_at_cursor(source, line, character)
            sym_str = f"'{sym}' " if sym else ""
            return f"No definition found: Symbol {sym_str}at line {line}, character {character} is already at its definition site."

    if not entries:
        diag_tuple = _diagnose_empty_location(source, line, character)
        human_msg = diag_tuple[1] if diag_tuple else "No results."

        if operation == "find_implementations":
            # Only claim "not overridable" when the cursor really is on a
            # resolvable identifier — otherwise report the position problem.
            if diag_tuple and diag_tuple[0] != "unresolved_symbol":
                return f"No results: {human_msg}."
            sym = _extract_symbol_at_cursor(source, line, character)
            sym_str = f"symbol '{sym}'" if sym else f"position {line}:{character}"
            return (
                f"No results: {sym_str} is not an interface, abstract class, "
                "or overridable member."
            )

        if operation in ("go_to_definition", "find_references") and diag_tuple:
            return f"No results: {human_msg}."
        return "No results."

    entries.sort(key=lambda entry: entry[0])
    shown = [line_text for _, line_text in entries[:_MAX_RESULTS]]
    if len(entries) > _MAX_RESULTS:
        omitted = len(entries) - _MAX_RESULTS
        shown.append(
            f"… truncated: showing {_MAX_RESULTS} of {len(entries)} results "
            f"({omitted} omitted). Narrow the search with 'kind', a more specific "
            "query, or grep."
        )
    return "\n".join(shown)


lsp_navigation = Tool(
    _lsp_navigation,
    name="lsp",
    description=(
        "Semantic code navigation via workspace language servers. Supported operations: "
        "'go_to_definition', 'find_references', 'document_symbol', 'workspace_symbol', "
        "'hover', and 'find_implementations'.\n\n"
        "Requirements & Semantics:\n"
        "- Positions: 1-based line and character offsets (1-indexed). Cursor must land on the target symbol identifier (keywords, whitespace, and comments produce diagnostic feedback).\n"
        "- Path: Workspace-relative source file (e.g. 'app/main.py'). Must be a source file, not a directory. For workspace_symbol, 'path' selects the language server and workspace context while 'query' searches across the workspace.\n"
        "- References: 'find_references' includes the declaration site as well as usages and calls.\n"
        "- Implementations: 'find_implementations' targets interfaces, protocols, abstract classes, and overridable members (ordinary functions report clear non-overridable status).\n"
        "- Filtering: Use 'kind' filter for symbol operations (e.g. 'function', 'class', 'function, method').\n"
        "- Output: one result per line as '[symbol (kind) [tag] | ]path:line:character[ | source line]'; position results carry their source line, so a follow-up read is usually unnecessary. Workspace symbols are tagged '[exact]'/'[prefix]' and ranked by match quality.\n"
        "Use grep for text search or glob for filename patterns instead. Returns up to 50 deduplicated workspace-relative locations, followed by a '… truncated' line when more exist."
    ),
)
