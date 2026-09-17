"""Dynamic memory catalog compilation, budget packing, and deterministic search."""

from __future__ import annotations

import html
import re
from pathlib import Path

from app.services.memory.models import (
    GlobalMemorySnapshot,
    MemoryScope,
    WorkspaceMemorySnapshot,
)
from app.services.memory.store import (
    MAX_MEMORY_PAGE_BYTES,
    parse_frontmatter,
)

MAX_TOTAL_CATALOG_CHARS = 1500
MAX_PREFERENCES_CHARS = 400
MAX_COMPONENT_CATALOG_CHARS = 1100
MAX_CATALOG_ENTRY_CHARS = 200
MIN_WORKSPACE_RESERVE_CHARS = 500


def normalize_text(text: str) -> str:
    """Normalize line endings and strip non-printing control characters except LF and TAB."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    # Strip control characters (ASCII 0-31 except \t and \n, plus 127 DEL)
    cleaned = "".join(
        ch for ch in text if ch in ("\n", "\t") or (ord(ch) >= 32 and ord(ch) != 127)
    )
    return cleaned


def xml_escape(text: str) -> str:
    """Escape &, <, > for safe XML prompt injection."""
    return html.escape(text, quote=False)


def _extract_summary(content: str, fallback_title: str) -> tuple[str, str]:
    """Extract page title and first meaningful text line summary."""
    frontmatter, body = parse_frontmatter(content)
    title = frontmatter.title if (frontmatter and frontmatter.title) else ""
    summary_line = ""

    lines = [normalize_text(line).strip() for line in body.splitlines()]
    for line in lines:
        if not line:
            continue
        if line.startswith("# ") and not title:
            title = line[2:].strip()
            continue
        if line.startswith("## ") and not title:
            title = line[3:].strip()
            continue
        if not line.startswith("#"):
            summary_line = line
            break

    final_title = title or fallback_title
    # Truncate summary cleanly
    if len(summary_line) > MAX_CATALOG_ENTRY_CHARS:
        summary_line = summary_line[: MAX_CATALOG_ENTRY_CHARS - 3] + "..."
    return final_title, summary_line


def _iter_markdown_files(root: Path) -> list[Path]:
    """Enumerate all valid .md files under root sorted deterministically by POSIX relative path."""
    if not root.is_dir():
        return []
    paths: list[Path] = []
    for path in root.rglob("*.md"):
        if path.is_file() and not any(
            part.startswith(".") for part in path.relative_to(root).parts
        ):
            try:
                if path.stat().st_size <= MAX_MEMORY_PAGE_BYTES:
                    paths.append(path)
            except OSError:
                pass
    paths.sort(key=lambda p: p.relative_to(root).as_posix())
    return paths


def compile_global_snapshot(scope: MemoryScope) -> GlobalMemorySnapshot:
    """Compile Global memory into bounded preferences and catalog."""
    pref_file = scope.root / "preferences.md"
    pref_text = ""
    if pref_file.is_file():
        try:
            raw = pref_file.read_text(encoding="utf-8", errors="replace")
            _, body = parse_frontmatter(raw)
            normalized = normalize_text(body).strip()
            if len(normalized) > MAX_PREFERENCES_CHARS:
                normalized = normalized[: MAX_PREFERENCES_CHARS - 3] + "..."
            pref_text = normalized
        except OSError:
            pass

    entries: list[str] = []
    total_chars = 0
    for path in _iter_markdown_files(scope.root):
        rel_posix = path.relative_to(scope.root).as_posix()
        if rel_posix == "preferences.md":
            continue
        try:
            raw = path.read_text(encoding="utf-8", errors="replace")
            title, summary = _extract_summary(raw, path.stem)
            topic_id = rel_posix[:-3] if rel_posix.endswith(".md") else rel_posix
            entry = f"- [[global:{topic_id}]]: {title}"
            if summary and summary != title:
                entry += f" — {summary}"
            escaped_entry = xml_escape(entry)
            if total_chars + len(escaped_entry) + 1 > MAX_COMPONENT_CATALOG_CHARS:
                entries.append(
                    "... [additional global pages available via /memory search]"
                )
                break
            entries.append(escaped_entry)
            total_chars += len(escaped_entry) + 1
        except OSError:
            continue

    return GlobalMemorySnapshot(
        preferences_content=pref_text,
        knowledge_catalog="\n".join(entries),
    )


def compile_workspace_snapshot(scope: MemoryScope) -> WorkspaceMemorySnapshot:
    """Compile Workspace memory into bounded catalog."""
    entries: list[str] = []
    total_chars = 0
    for path in _iter_markdown_files(scope.root):
        rel_posix = path.relative_to(scope.root).as_posix()
        try:
            raw = path.read_text(encoding="utf-8", errors="replace")
            title, summary = _extract_summary(raw, path.stem)
            topic_id = rel_posix[:-3] if rel_posix.endswith(".md") else rel_posix
            entry = f"- [[{topic_id}]]: {title}"
            if summary and summary != title:
                entry += f" — {summary}"
            escaped_entry = xml_escape(entry)
            if total_chars + len(escaped_entry) + 1 > MAX_COMPONENT_CATALOG_CHARS:
                entries.append(
                    "... [additional workspace pages available via /memory search]"
                )
                break
            entries.append(escaped_entry)
            total_chars += len(escaped_entry) + 1
        except OSError:
            continue

    return WorkspaceMemorySnapshot(
        knowledge_catalog="\n".join(entries),
    )


def compose_memory_context(
    global_snap: GlobalMemorySnapshot,
    workspace_snap: WorkspaceMemorySnapshot | None,
    *,
    is_chat: bool,
    global_root: Path,
    workspace_root: Path | None,
) -> str:
    """Compose bounded prompt context (< 1500 chars total) with exact budget accounting."""
    root_hints = [f"  <global_root>{global_root.as_posix()}</global_root>"]
    if workspace_root and not is_chat:
        root_hints.append(
            f"  <workspace_root>{workspace_root.as_posix()}</workspace_root>"
        )
    roots_xml = "  <memory_roots>\n  " + "\n  ".join(root_hints) + "\n  </memory_roots>"

    xml_prefix = "<openagentd_memory>\n" + roots_xml + "\n"
    xml_suffix = "</openagentd_memory>"

    static_overhead = len(xml_prefix) + len(xml_suffix)
    pref_xml = ""
    if global_snap.preferences_content:
        escaped_pref = xml_escape(global_snap.preferences_content)
        pref_xml = f"  <global_preferences>\n{escaped_pref}\n  </global_preferences>\n"

    available_content_budget = MAX_TOTAL_CATALOG_CHARS - static_overhead - len(pref_xml)
    if available_content_budget < 0:
        available_content_budget = 0

    global_lines = [line for line in global_snap.knowledge_catalog.splitlines() if line]
    ws_lines = (
        [line for line in workspace_snap.knowledge_catalog.splitlines() if line]
        if (workspace_snap and not is_chat)
        else []
    )

    if is_chat or not workspace_snap:
        # Chat mode: Global knowledge gets full remaining budget
        packed_global: list[str] = []
        g_budget = available_content_budget - len(
            "  <global_knowledge>\n\n  </global_knowledge>\n"
        )
        curr = 0
        for line in global_lines:
            if curr + len(line) + 1 <= g_budget:
                packed_global.append("    " + line)
                curr += len(line) + 5
            else:
                packed_global.append("    ... [more global pages via /memory search]")
                break
        g_xml = (
            "  <global_knowledge>\n"
            + "\n".join(packed_global)
            + "\n  </global_knowledge>\n"
            if packed_global
            else ""
        )
        result = xml_prefix + pref_xml + g_xml + xml_suffix
        return result

    # Coding mode: Allocate budget with workspace reservation and reclaim
    ws_raw_len = sum(len(line) + 5 for line in ws_lines) + len(
        "  <workspace_knowledge>\n\n  </workspace_knowledge>\n"
    )
    ws_reserve = min(MIN_WORKSPACE_RESERVE_CHARS, ws_raw_len)
    g_budget = (
        available_content_budget
        - ws_reserve
        - len("  <global_knowledge>\n\n  </global_knowledge>\n")
    )

    packed_global = []
    g_used = 0
    for line in global_lines:
        if g_used + len(line) + 5 <= g_budget:
            packed_global.append("    " + line)
            g_used += len(line) + 5
        else:
            packed_global.append("    ... [more global pages via /memory search]")
            g_used += 45
            break

    g_xml = (
        "  <global_knowledge>\n"
        + "\n".join(packed_global)
        + "\n  </global_knowledge>\n"
        if packed_global
        else ""
    )

    # Workspace gets reserved budget + any unused global budget
    ws_budget = (
        available_content_budget
        - (len(g_xml))
        - len("  <workspace_knowledge>\n\n  </workspace_knowledge>\n")
    )
    packed_ws = []
    ws_used = 0
    for line in ws_lines:
        if ws_used + len(line) + 5 <= ws_budget:
            packed_ws.append("    " + line)
            ws_used += len(line) + 5
        else:
            packed_ws.append("    ... [more workspace pages via /memory search]")
            break

    ws_xml = (
        "  <workspace_knowledge>\n"
        + "\n".join(packed_ws)
        + "\n  </workspace_knowledge>\n"
        if packed_ws
        else ""
    )
    result = xml_prefix + pref_xml + g_xml + ws_xml + xml_suffix
    return result


def search_memory(
    scopes: list[MemoryScope],
    query: str,
) -> list[dict[str, str]]:
    """Deterministic multi-field search across memory scopes."""
    tokens = [t.lower() for t in re.split(r"\s+", query.strip()) if t]
    if not tokens:
        return []

    results: list[dict[str, str]] = []
    for scope in scopes:
        for path in _iter_markdown_files(scope.root):
            rel_posix = path.relative_to(scope.root).as_posix()
            try:
                raw = path.read_text(encoding="utf-8", errors="replace")
                title, summary = _extract_summary(raw, path.stem)
                search_blob = f"{rel_posix} {title} {summary} {raw}".lower()
                if all(token in search_blob for token in tokens):
                    results.append(
                        {
                            "scope": scope.kind,
                            "path": rel_posix,
                            "title": title,
                        }
                    )
            except OSError:
                continue
    return results
