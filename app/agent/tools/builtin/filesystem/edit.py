"""edit_file tool — targeted string replacement with fuzzy matching.

Replacement logic ported from opencode edit.ts (anomalyco/opencode).
Cascade of matchers: exact → line-trimmed → block-anchor →
whitespace-normalised → indentation-flexible → trimmed-boundary → multi-occurrence.
"""

from __future__ import annotations

import json
import re

from loguru import logger
from pydantic import BaseModel, Field, model_validator

from app.agent.sandbox import get_sandbox
from app.agent.tools.builtin.filesystem._config_watch import notify_fs_change
from app.agent.tools.registry import Tool

_DESCRIPTION = (
    "Replace exact text in a file. Use the shortest old_string that uniquely "
    "identifies the location. Only the matched region changes."
)


class EditArgs(BaseModel):
    """Arguments for the edit tool."""

    path: str = Field(description="Relative path to the file to modify.")
    old_string: str = Field(
        description=(
            "Exact text to replace. Use the minimum lines needed to uniquely "
            "identify the location — no more. Must match whitespace/indentation exactly."
        )
    )
    new_string: str = Field(
        description="Replacement text. Omit unchanged lines; only include what changes."
    )
    replace_all: bool = Field(
        default=False,
        description="Replace every occurrence; when false, the match must be unique.",
    )

    @model_validator(mode="after")
    def _validate_diff(self) -> EditArgs:
        if self.old_string == self.new_string:
            raise ValueError(
                "No changes to apply: old_string and new_string are identical."
            )
        return self


def _levenshtein(a: str, b: str) -> int:
    """Me compute edit distance between two strings."""
    if not a:
        return len(b)
    if not b:
        return len(a)
    matrix = [
        [j if i == 0 else i if j == 0 else 0 for j in range(len(b) + 1)]
        for i in range(len(a) + 1)
    ]
    for i in range(1, len(a) + 1):
        for j in range(1, len(b) + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            matrix[i][j] = min(
                matrix[i - 1][j] + 1,
                matrix[i][j - 1] + 1,
                matrix[i - 1][j - 1] + cost,
            )
    return matrix[len(a)][len(b)]


def replace_content_with_meta(
    content: str, old_string: str, new_string: str, replace_all: bool = False
) -> tuple[str, int | None]:
    """Apply old_string → new_string using a cascade of fuzzy matchers.

    Raises ValueError if no match found or multiple matches (when replace_all=False).
    """

    def _exact(c: str, find: str):
        if find in c:
            yield find

    def _line_trimmed(c: str, find: str):
        orig_lines = c.split("\n")
        find_lines = find.split("\n")
        if find_lines and find_lines[-1] == "":
            find_lines = find_lines[:-1]
        for i in range(len(orig_lines) - len(find_lines) + 1):
            if all(
                orig_lines[i + j].strip() == find_lines[j].strip()
                for j in range(len(find_lines))
            ):
                start = sum(len(orig_lines[k]) + 1 for k in range(i))
                end = start + sum(
                    len(orig_lines[i + k]) + (0 if k == len(find_lines) - 1 else 1)
                    for k in range(len(find_lines))
                )
                yield c[start:end]

    def _block_anchor(c: str, find: str):
        orig = c.split("\n")
        find_lines = find.split("\n")
        if len(find_lines) < 3:
            return
        if find_lines[-1] == "":
            find_lines = find_lines[:-1]
        first, last = find_lines[0].strip(), find_lines[-1].strip()
        candidates = []
        for i, line in enumerate(orig):
            if line.strip() != first:
                continue
            for j in range(i + 2, len(orig)):
                if orig[j].strip() == last:
                    candidates.append((i, j))
                    break
        if not candidates:
            return
        if len(candidates) == 1:
            si, ei = candidates[0]
            start = sum(len(orig[k]) + 1 for k in range(si))
            end = start + sum(
                len(orig[si + k]) + (0 if si + k == ei else 1)
                for k in range(ei - si + 1)
            )
            yield c[start:end]
        else:
            best, best_sim = None, -1.0
            for si, ei in candidates:
                block = orig[si : ei + 1]
                middle = min(len(find_lines) - 2, len(block) - 2)
                sim = 0.0
                if middle > 0:
                    for k in range(1, min(len(find_lines) - 1, len(block) - 1)):
                        a, b = orig[si + k].strip(), find_lines[k].strip()
                        max_len = max(len(a), len(b))
                        if max_len:
                            sim += (1 - _levenshtein(a, b) / max_len) / middle
                else:
                    sim = 1.0
                if sim > best_sim:
                    best_sim, best = sim, (si, ei)
            if best and best_sim >= 0.3:
                si, ei = best
                start = sum(len(orig[k]) + 1 for k in range(si))
                end = start + sum(
                    len(orig[si + k]) + (0 if si + k == ei else 1)
                    for k in range(ei - si + 1)
                )
                yield c[start:end]

    def _whitespace_normalized(c: str, find: str):
        def _norm(t: str) -> str:
            return re.sub(r"\s+", " ", t).strip()

        find_lines = find.split("\n")
        orig_lines = c.split("\n")
        for i in range(len(orig_lines) - len(find_lines) + 1):
            block = "\n".join(orig_lines[i : i + len(find_lines)])
            if _norm(block) == _norm(find):
                yield block

    def _indentation_flexible(c: str, find: str):
        def _strip_indent(t: str) -> str:
            lines = t.split("\n")
            non_empty = [ln for ln in lines if ln.strip()]
            if not non_empty:
                return t
            min_indent = min(len(ln) - len(ln.lstrip()) for ln in non_empty)
            return "\n".join(ln[min_indent:] if ln.strip() else ln for ln in lines)

        norm_find = _strip_indent(find)
        find_lines = find.split("\n")
        orig_lines = c.split("\n")
        for i in range(len(orig_lines) - len(find_lines) + 1):
            block = "\n".join(orig_lines[i : i + len(find_lines)])
            if _strip_indent(block) == norm_find:
                yield block

    def _trimmed_boundary(c: str, find: str):
        trimmed = find.strip()
        if trimmed == find:
            return
        if trimmed in c:
            yield trimmed
        find_lines = find.split("\n")
        orig_lines = c.split("\n")
        for i in range(len(orig_lines) - len(find_lines) + 1):
            block = "\n".join(orig_lines[i : i + len(find_lines)])
            if block.strip() == trimmed:
                yield block

    def _multi_occurrence(c: str, find: str):
        start = 0
        while True:
            idx = c.find(find, start)
            if idx == -1:
                break
            yield find
            start = idx + len(find)

    not_found = True
    for matcher in [
        _exact,
        _line_trimmed,
        _block_anchor,
        _whitespace_normalized,
        _indentation_flexible,
        _trimmed_boundary,
        _multi_occurrence,
    ]:
        for search in matcher(content, old_string):
            idx = content.find(search)
            if idx == -1:
                continue
            not_found = False
            if replace_all:
                first_idx = content.find(search)
                start_line = content.count("\n", 0, first_idx) + 1
                return content.replace(search, new_string), start_line
            last_idx = content.rfind(search)
            if idx != last_idx:
                continue
            start_line = content.count("\n", 0, idx) + 1
            return content[:idx] + new_string + content[idx + len(search) :], start_line

    if not_found:
        raise ValueError(
            "Could not find oldString in the file. "
            "It must match exactly (including whitespace and indentation)."
        )
    raise ValueError(
        "Found multiple matches for oldString. "
        "Provide more surrounding context to make the match unique, or set replaceAll=true."
    )


def replace_content(
    content: str, old_string: str, new_string: str, replace_all: bool = False
) -> str:
    """Backward-compatible wrapper returning only the updated content."""
    updated, _start_line = replace_content_with_meta(
        content, old_string, new_string, replace_all
    )
    return updated


async def _edit_file(
    path: str,
    old_string: str,
    new_string: str,
    replace_all: bool = False,
) -> str:
    """Edit a file by replacing an exact string with new content.

    Safer than write_file for targeted changes — only the matched region changes.
    Uses fuzzy matching to handle minor whitespace/indentation variations.
    Fails if the match is ambiguous (multiple occurrences) unless replace_all=true.
    """
    sandbox = get_sandbox()
    resolved = sandbox.validate_path(path)
    rel = sandbox.display_path(resolved)

    if not resolved.exists():
        raise FileNotFoundError(f"File not found: {rel}")
    if not resolved.is_file():
        raise IsADirectoryError(f"Path is a directory: {rel}")

    if old_string == new_string:
        raise ValueError(
            "No changes to apply: old_string and new_string are identical."
        )

    content = resolved.read_text(encoding="utf-8")
    new_content, start_line = replace_content_with_meta(
        content, old_string, new_string, replace_all
    )

    encoded = new_content.encode("utf-8")
    resolved.write_bytes(encoded)
    logger.info("file_edited path={} bytes={}", resolved, len(encoded))
    notify_fs_change(resolved)
    meta = json.dumps(
        {
            "path": path,
            "old_start": start_line,
            "new_start": start_line,
        },
        separators=(",", ":"),
    )
    return (
        f"@@ openagentd-diff-meta {meta}\n"
        f"Edit applied successfully to {rel}\nResolved path: {resolved}"
    )


edit_file = Tool(
    _edit_file,
    name="edit",
    description=_DESCRIPTION,
    args_schema=EditArgs,
)
