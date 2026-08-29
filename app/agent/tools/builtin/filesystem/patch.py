"""patch tool - apply file-oriented patch envelopes."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
import hashlib
import json
import os
import re
import stat
import tempfile
from pathlib import Path
from typing import Literal

from loguru import logger
from pydantic import AliasChoices, BaseModel, Field, field_validator

from app.agent.denied_paths import get_denied_paths
from app.agent.tools.builtin.filesystem._config_watch import notify_fs_change
from app.agent.tools.registry import Tool

PatchKind = Literal["add", "update", "delete"]

_DESCRIPTION = (
    "The only tool that creates, edits, deletes, or moves files. One envelope "
    "may change several files, and nothing is written unless every section "
    "applies cleanly. Changes are staged and rolled back on commit failure when "
    "possible. Add and move destinations must not already exist unless they "
    "were deleted earlier in the same envelope. To replace a file wholesale, "
    "delete and re-add it in the same envelope. Directories cannot be deleted "
    "— use shell for that."
)

_PATCH_TEXT_DESCRIPTION = """\
The full patch text. Must start with '*** Begin Patch' and end with '*** End Patch'.

Each file section starts with one of:
  *** Add File: <path>      — create a new file; every content line starts with +
  *** Update File: <path>   — patch an existing file; optionally followed by:
      *** Move to: <path>   — rename/move the file after patching
  *** Delete File: <path>   — remove a file; no content follows

Update hunks start with @@ (optionally followed by a class or function context
header) and use +/- prefixes (space = context):
  @@
  @@ def target_function():
  -old line
  +new line
   context line

To scope a hunk after a unique literal line, '@@ in: <anchor>' is supported
as a backwards-compatible alias:
  @@ in: def target_function():
  -old line
  +new line

Context and removed lines are matched as whole lines. Exact matches are tried
first, followed by narrowly guarded trailing-whitespace, line-number, and
uniform-indentation repairs; unchanged context bytes are preserved. A hunk
that matches nothing, or matches in more than one place, fails the whole
envelope; add surrounding context lines to make it unique. Context-only hunks
act as sequential locators for the following hunk.
Each update section needs at least one '-' or '+' line; a section of pure
context changes nothing and is rejected rather than silently applied. To
delete lines, prefix every line you want gone with '-' — pasting them bare
reads as unchanged context and removes nothing.

Example:
*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch\
"""


class PatchArgs(BaseModel):
    """Arguments for the patch tool."""

    patch_text: str = Field(
        description=_PATCH_TEXT_DESCRIPTION,
        validation_alias=AliasChoices("patch_text", "patch", "text", "content", "diff"),
    )

    @field_validator("patch_text", mode="before")
    @classmethod
    def validate_patch_text(cls, v: object) -> str:
        if not isinstance(v, str):
            raise ValueError("patch_text must be a string.")
        _parse_patch(v)
        return v


@dataclass
class Chunk:
    old: list[str] = field(default_factory=list)
    new: list[str] = field(default_factory=list)
    raw_old: list[str] = field(default_factory=list)
    raw_new: list[str] = field(default_factory=list)
    scope_anchor: str | None = None
    scope_is_literal: bool = False
    context_pairs: list[tuple[int, int]] = field(default_factory=list)


@dataclass
class FilePatch:
    kind: PatchKind
    path: str
    move_to: str | None = None
    contents: list[str] = field(default_factory=list)
    chunks: list[Chunk] = field(default_factory=list)


@dataclass(frozen=True)
class FileSnapshot:
    content: bytes
    mode: int
    digest: bytes


@dataclass
class VirtualFile:
    content: bytes
    mode: int


DEFAULT_FILE_MODE = 0o644


class PatchConflict(ValueError):
    """Raised when a file changes between patch planning and commit."""


def _clean_patch_text(patch_text: str) -> str:
    """Clean markdown code fences, leading/trailing whitespace, and extract patch envelope."""
    text = patch_text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        text = "\n".join(lines).strip()

    begin_marker = "*** Begin Patch"
    end_marker = "*** End Patch"
    begin_idx = text.find(begin_marker)
    end_idx = text.rfind(end_marker)
    if begin_idx != -1 and end_idx != -1 and end_idx >= begin_idx:
        text = text[begin_idx : end_idx + len(end_marker)]

    return text


def _parse_patch(patch_text: str) -> list[FilePatch]:
    cleaned = _clean_patch_text(patch_text)
    lines = cleaned.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    if (
        not lines
        or lines[0].strip() != "*** Begin Patch"
        or lines[-1].strip() != "*** End Patch"
    ):
        raise ValueError(
            "Patch must start with '*** Begin Patch' and end with '*** End Patch'."
        )

    patches: list[FilePatch] = []
    current: FilePatch | None = None
    chunk: Chunk | None = None

    def finish_chunk() -> None:
        nonlocal chunk
        if current is not None and chunk is not None:
            current.chunks.append(chunk)
        chunk = None

    for line in lines[1:-1]:
        if line.startswith("*** Add File: "):
            finish_chunk()
            current = FilePatch("add", line.removeprefix("*** Add File: ").strip())
            patches.append(current)
            continue
        if line.startswith("*** Update File: "):
            finish_chunk()
            current = FilePatch(
                "update", line.removeprefix("*** Update File: ").strip()
            )
            patches.append(current)
            continue
        if line.startswith("*** Delete File: "):
            finish_chunk()
            current = FilePatch(
                "delete", line.removeprefix("*** Delete File: ").strip()
            )
            patches.append(current)
            continue
        if current is None:
            raise ValueError("Patch content must follow a file operation header.")
        if line.startswith("*** Move to: "):
            if current.kind != "update":
                raise ValueError("Move is only valid inside an update operation.")
            current.move_to = line.removeprefix("*** Move to: ").strip()
            continue
        if line.startswith("@@ in:"):
            finish_chunk()
            scope_anchor = line.removeprefix("@@ in:").strip()
            if not scope_anchor:
                raise ValueError("A scoped hunk must include an anchor after '@@ in:'.")
            chunk = Chunk(scope_anchor=scope_anchor, scope_is_literal=True)
            continue
        if line.startswith("@@"):
            finish_chunk()
            scope_anchor = line[2:]
            if scope_anchor.startswith(" "):
                scope_anchor = scope_anchor[1:]
            chunk = Chunk(scope_anchor=scope_anchor.strip() or None)
            continue
        if current.kind == "add":
            if line.startswith("+"):
                current.contents.append(line[1:])
            elif line.startswith("*"):
                raise ValueError(
                    "Unexpected '*'-prefixed line inside an Add File section "
                    f"(malformed header?): {line!r}. Prefix content lines with '+'."
                )
            else:
                current.contents.append(line)
            continue
        if current.kind == "delete":
            raise ValueError("Delete file operations must not include content.")
        if chunk is None:
            raise ValueError(
                "Update operations must include an '@@' hunk before changes."
            )
        if line.startswith("+"):
            chunk.new.append(line[1:])
            chunk.raw_new.append(line[1:])
        elif line.startswith("-"):
            chunk.old.append(line[1:])
            chunk.raw_old.append(line[1:])
        elif line.startswith(" "):
            text = line[1:]
            old_index = len(chunk.old)
            new_index = len(chunk.new)
            chunk.old.append(text)
            chunk.new.append(text)
            chunk.context_pairs.append((old_index, new_index))
            chunk.raw_old.append(line)
            chunk.raw_new.append(line)
        elif line == "":
            old_index = len(chunk.old)
            new_index = len(chunk.new)
            chunk.old.append("")
            chunk.new.append("")
            chunk.context_pairs.append((old_index, new_index))
            chunk.raw_old.append("")
            chunk.raw_new.append("")
        else:
            old_index = len(chunk.old)
            new_index = len(chunk.new)
            chunk.old.append(line)
            chunk.new.append(line)
            chunk.context_pairs.append((old_index, new_index))
            chunk.raw_old.append(line)
            chunk.raw_new.append(line)

    finish_chunk()
    if not patches:
        raise ValueError("Patch contains no file operations.")
    for patch in patches:
        _reject_no_op_update(patch)
    return patches


def _reject_no_op_update(patch: FilePatch) -> None:
    """Reject an update section that would write the file back unchanged.

    A no-op section used to report "Patch applied successfully" while touching
    nothing, so the model re-read the file, saw the original content, and
    resent the identical envelope — an endless retry loop that only ended when
    it gave up and deleted/recreated the file. Failing at parse time instead
    means the caller learns *why* the envelope was empty before anything
    reaches the disk.

    Scope is deliberately the *section*, not the chunk. A context-only chunk
    beside a real one is the widely-used locator idiom (a bare ``@@`` block
    naming the enclosing function, then the hunk that changes it) — 493 of
    them across 18% of recorded envelopes. Rejecting those would break far
    more than it fixed; a section with no marked line anywhere is unambiguous.
    """
    if patch.kind != "update":
        return
    # A rename is a real change, even with no hunks at all.
    if patch.move_to is not None:
        return
    if any(chunk.old != chunk.new for chunk in patch.chunks):
        return

    detail = (
        "it has no '@@' hunk"
        if not patch.chunks
        else "no hunk line starts with '-' or '+', so every line reads as "
        "unchanged context"
    )
    raise ValueError(
        f"Update section for {patch.path} would change nothing: {detail}. "
        "Prefix every line you want removed with '-' and every line you want "
        "added with '+', or use '*** Move to: <path>' to rename the file."
    )


def _lines_to_text(lines: list[str]) -> str:
    if not lines:
        return ""
    return "\n".join(lines) + "\n"


_LINE_NUMBER_PREFIX_RE = re.compile(r"^\s*\d+:\s?")


def _strip_line_number_prefixes(lines: list[str]) -> list[str] | None:
    """Drop a leading ``N: `` prefix from every line, or ``None`` if not uniform.

    ``read`` numbers its output, so a model that copies context straight out of
    a read hands us ``12:     return 1`` instead of ``    return 1``. Requiring
    *every* line to carry a prefix keeps this unambiguous: a hunk that mixes
    prefixed and bare lines is not numbered output and is left alone.
    """
    if not lines:
        return None
    stripped = []
    for line in lines:
        match = _LINE_NUMBER_PREFIX_RE.match(line)
        if not match:
            return None
        stripped.append(line[match.end() :])
    return stripped


def _find_line_matches(
    content_lines: list[str], old_lines: list[str], *, trimmed: bool
) -> list[int]:
    """Return start line indices where old_lines match a window of content_lines.

    With trimmed=True, lines are compared after rstrip() to tolerate trailing
    whitespace differences.
    """
    if not old_lines:
        return []
    target = [line.rstrip() for line in old_lines] if trimmed else old_lines
    matches: list[int] = []
    for i in range(len(content_lines) - len(old_lines) + 1):
        window = content_lines[i : i + len(old_lines)]
        if trimmed:
            window = [line.rstrip() for line in window]
        if window == target:
            matches.append(i)
    return matches


def _find_indentation_tolerant_matches(
    content_lines: list[str], old_lines: list[str]
) -> list[int]:
    """Return match indices where stripped lines match and relative indentation matches."""
    if not old_lines or len(old_lines) > len(content_lines):
        return []
    stripped_target = [line.strip() for line in old_lines]
    if not any(stripped_target):
        return []
    matches: list[int] = []
    for i in range(len(content_lines) - len(old_lines) + 1):
        window = content_lines[i : i + len(old_lines)]
        if [line.strip() for line in window] != stripped_target:
            continue
        deltas = {
            (len(candidate) - len(candidate.lstrip()))
            - (len(expected) - len(expected.lstrip()))
            for candidate, expected in zip(window, old_lines)
            if candidate.strip() and expected.strip()
        }
        if len(deltas) == 1:
            matches.append(i)
    return matches


def _adjust_new_lines_indentation(
    content_window: list[str], old_lines: list[str], new_lines: list[str]
) -> list[str]:
    """Adjust indentation of new_lines when matching against a shifted window."""
    for c_line, o_line in zip(content_window, old_lines):
        if c_line.strip() and o_line.strip():
            c_indent = len(c_line) - len(c_line.lstrip())
            o_indent = len(o_line) - len(o_line.lstrip())
            delta = c_indent - o_indent
            if delta > 0:
                return [
                    (" " * delta) + line if line.strip() else line for line in new_lines
                ]
            if delta < 0:
                trim = -delta
                return [
                    line[trim:] if line.startswith(" " * trim) else line
                    for line in new_lines
                ]
            break
    return new_lines


def _find_header_anchor(
    content_lines: list[str], anchor: str, path: str, scope_start: int
) -> int:
    """Find a contextual ``@@ header`` after the current search cursor."""
    starts = _find_line_matches(content_lines, [anchor], trimmed=False)
    starts = [start for start in starts if start >= scope_start]
    if not starts:
        starts = [
            idx
            for idx, line in enumerate(content_lines)
            if idx >= scope_start and line.rstrip() == anchor.rstrip()
        ]
    if not starts:
        # Context headers commonly omit punctuation, e.g. ``@@ class Foo`` for
        # a source line ``class Foo:``. Require a token boundary after
        # stripping indentation so unrelated lines cannot become anchors.
        needle = anchor.strip()
        starts = [
            idx
            for idx, line in enumerate(content_lines)
            if idx >= scope_start
            and line.strip().startswith(needle)
            and (
                len(line.strip()) == len(needle)
                or not line.strip()[len(needle)].isalnum()
                and line.strip()[len(needle)] != "_"
            )
        ]
    if not starts:
        raise ValueError(
            f"Could not find scope anchor in {path}: {anchor!r}. "
            "Check that it matches a unique line in the current file."
        )
    if len(starts) > 1:
        lines_str = ", ".join(f"line {idx + 1}" for idx in starts[:5])
        if len(starts) > 5:
            lines_str += f" (and {len(starts) - 5} more)"
        raise ValueError(
            f"Scope anchor is ambiguous in {path}. "
            f"Found {len(starts)} matching locations at {lines_str}. "
            "Use a unique literal anchor after '@@'."
        )
    return starts[0]


def _find_scope_anchor(
    content_lines: list[str], anchor: str, path: str, scope_start: int = 0
) -> int:
    """Find one literal scope anchor, tolerating trailing whitespace only."""
    starts = [
        start
        for start in _find_line_matches(content_lines, [anchor], trimmed=False)
        if start >= scope_start
    ]
    if not starts:
        starts = [
            start
            for start in _find_line_matches(content_lines, [anchor], trimmed=True)
            if start >= scope_start
        ]
    if not starts:
        raise ValueError(
            f"Could not find scope anchor in {path}: {anchor!r}. "
            "Check that it matches a unique line in the current file."
        )
    if len(starts) > 1:
        lines_str = ", ".join(f"line {idx + 1}" for idx in starts[:5])
        if len(starts) > 5:
            lines_str += f" (and {len(starts) - 5} more)"
        raise ValueError(
            f"Scope anchor is ambiguous in {path}. "
            f"Found {len(starts)} matching locations at {lines_str}. "
            "Use a unique literal anchor after '@@ in:'."
        )
    return starts[0]


def _format_context_miss_error(
    path: str, content_lines: list[str], old_lines: list[str]
) -> str:
    """Build a helpful diagnostic error message when patch context is not found."""
    preview_len = min(5, len(old_lines))
    expected_sample = "\n".join(f"  | {line}" for line in old_lines[:preview_len])
    if len(old_lines) > preview_len:
        expected_sample += f"\n  | ... ({len(old_lines) - preview_len} more lines)"

    first_non_empty = next((line.strip() for line in old_lines if line.strip()), None)
    hint = ""
    if first_non_empty and content_lines:
        candidates = [
            (idx + 1, line)
            for idx, line in enumerate(content_lines)
            if first_non_empty in line
        ]
        if candidates:
            sample_candidates = ", ".join(f"line {idx}" for idx, _ in candidates[:3])
            hint = f"\nNote: Similar text found at {sample_candidates} in {path}, but surrounding context differed."

    return (
        f"Could not find patch context in {path}.\n"
        f"The patch was looking for this block:\n{expected_sample}{hint}\n"
        f"Check that context lines match the current file contents exactly."
    )


def _format_ambiguous_context_error(
    path: str, starts: list[int], old_lines: list[str]
) -> str:
    """Build a helpful diagnostic error message when patch context matches multiple locations."""
    preview_len = min(5, len(old_lines))
    expected_sample = "\n".join(f"  | {line}" for line in old_lines[:preview_len])
    if len(old_lines) > preview_len:
        expected_sample += f"\n  | ... ({len(old_lines) - preview_len} more lines)"

    lines_str = ", ".join(f"line {idx + 1}" for idx in starts[:5])
    if len(starts) > 5:
        lines_str += f" (and {len(starts) - 5} more)"

    return (
        f"Patch context is ambiguous in {path}.\n"
        f"Found {len(starts)} matching locations at {lines_str}.\n"
        f"The ambiguous block was:\n{expected_sample}\n"
        f"Add more surrounding context lines above or below this block to uniquely identify the target location."
    )


def _apply_chunks_with_meta(
    content: str, chunks: list[Chunk], path: str
) -> tuple[str, list[dict[str, int]]]:
    uses_crlf = "\r\n" in content
    normalized_content = content.replace("\r\n", "\n").replace("\r", "\n")
    has_trailing_newline = normalized_content.endswith("\n") or normalized_content == ""

    content_lines = normalized_content.split("\n")
    if has_trailing_newline and content_lines and content_lines[-1] == "":
        content_lines.pop()

    line_delta = 0
    cursor = 0
    hunks: list[dict[str, int]] = []

    for chunk in chunks:
        old_lines, new_lines = chunk.old, chunk.new
        scope_start = cursor
        if chunk.scope_anchor is not None:
            if chunk.scope_is_literal:
                anchor_start = _find_scope_anchor(
                    content_lines, chunk.scope_anchor, path, cursor
                )
            else:
                anchor_start = _find_header_anchor(
                    content_lines, chunk.scope_anchor, path, cursor
                )
            scope_start = anchor_start + 1

        def in_scope(matches: list[int]) -> list[int]:
            return [start for start in matches if start >= scope_start]

        # A context-only hunk is a real locator. It advances the cursor so a
        # following hunk is matched after that block rather than globally.
        if old_lines == new_lines:
            if not old_lines:
                cursor = scope_start
                continue
            starts = in_scope(
                _find_line_matches(content_lines, old_lines, trimmed=False)
            ) or in_scope(_find_line_matches(content_lines, old_lines, trimmed=True))
            if not starts and chunk.raw_old != chunk.old:
                starts = in_scope(
                    _find_line_matches(content_lines, chunk.raw_old, trimmed=False)
                ) or in_scope(
                    _find_line_matches(content_lines, chunk.raw_old, trimmed=True)
                )
            if not starts:
                raise ValueError(
                    _format_context_miss_error(path, content_lines, old_lines)
                )
            if len(starts) > 1:
                raise ValueError(
                    _format_ambiguous_context_error(path, starts, old_lines)
                )
            cursor = starts[0] + len(old_lines)
            continue

        if not old_lines:
            start = scope_start
            matched_window: list[str] = []
            actual_new_lines = new_lines
        else:
            # 1. Exact match
            starts = in_scope(
                _find_line_matches(content_lines, old_lines, trimmed=False)
            )
            # 2. Trailing whitespace tolerant match
            if not starts:
                starts = in_scope(
                    _find_line_matches(content_lines, old_lines, trimmed=True)
                )

            # 3. Fallback: unstripped context lines (lines copied verbatim from source)
            if not starts and chunk.raw_old != chunk.old:
                starts = in_scope(
                    _find_line_matches(content_lines, chunk.raw_old, trimmed=False)
                ) or in_scope(
                    _find_line_matches(content_lines, chunk.raw_old, trimmed=True)
                )
                if starts:
                    old_lines = chunk.raw_old
                    new_lines = chunk.raw_new

            # 4. Fallback: line-number prefixes stripped (e.g. from read output)
            if not starts:
                bare_old = _strip_line_number_prefixes(old_lines)
                if bare_old is not None:
                    bare_starts = in_scope(
                        _find_line_matches(content_lines, bare_old, trimmed=False)
                    ) or in_scope(
                        _find_line_matches(content_lines, bare_old, trimmed=True)
                    )
                    if bare_starts:
                        starts = bare_starts
                        old_lines = bare_old
                        new_lines = _strip_line_number_prefixes(new_lines) or new_lines

            # 5. Fallback: uniform indentation shift
            if not starts:
                indent_starts = in_scope(
                    _find_indentation_tolerant_matches(content_lines, old_lines)
                )
                if len(indent_starts) == 1:
                    starts = indent_starts
                    old_lines = content_lines[starts[0] : starts[0] + len(old_lines)]
                    new_lines = _adjust_new_lines_indentation(
                        old_lines, chunk.old, new_lines
                    )

            if not starts:
                raise ValueError(
                    _format_context_miss_error(path, content_lines, chunk.old)
                )
            if len(starts) > 1:
                raise ValueError(
                    _format_ambiguous_context_error(path, starts, chunk.old)
                )
            start = starts[0]
            matched_window = content_lines[start : start + len(old_lines)]

            # Preserve actual source lines for context, even when matching
            # succeeded only after trimming whitespace or repairing prefixes.
            actual_new_lines = list(new_lines)
            for old_index, new_index in chunk.context_pairs:
                if old_index < len(matched_window) and new_index < len(
                    actual_new_lines
                ):
                    actual_new_lines[new_index] = matched_window[old_index]

        new_start = start + 1
        old_start = new_start - line_delta
        hunks.append({"old_start": old_start, "new_start": new_start})
        line_delta += len(actual_new_lines) - len(old_lines)
        content_lines[start : start + len(old_lines)] = actual_new_lines
        cursor = start + len(actual_new_lines)

    next_content = "\n".join(content_lines)
    if has_trailing_newline and content_lines:
        next_content += "\n"
    if uses_crlf:
        next_content = next_content.replace("\n", "\r\n")
    return next_content, hunks


def _stage_file(path: Path, data: bytes, mode: int) -> Path:
    """Stage a fully flushed file beside its destination, preserving its mode."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as handle:
            os.fchmod(handle.fileno(), mode)
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        return tmp_path
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise


def _atomic_write(path: Path, data: bytes, mode: int = DEFAULT_FILE_MODE) -> None:
    """Write *data* atomically, using an explicit destination file mode."""
    tmp_path = _stage_file(path, data, mode)
    try:
        os.replace(tmp_path, path)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise


def _digest(data: bytes) -> bytes:
    return hashlib.blake2b(data, digest_size=32).digest()


def _snapshot(path: Path) -> FileSnapshot | None:
    if not path.exists():
        return None
    if not path.is_file():
        raise IsADirectoryError(f"Path is a directory: {path}")
    content = path.read_bytes()
    return FileSnapshot(
        content=content,
        mode=stat.S_IMODE(path.stat().st_mode),
        digest=_digest(content),
    )


def _assert_snapshot(path: Path, expected: FileSnapshot | None) -> None:
    """Reject an external change made after preflight."""
    if expected is None:
        if path.exists():
            raise PatchConflict(f"Path changed during patch: {path} was created")
        return
    if not path.exists() or not path.is_file():
        raise PatchConflict(f"Path changed during patch: {path} was removed")
    content = path.read_bytes()
    mode = stat.S_IMODE(path.stat().st_mode)
    if _digest(content) != expected.digest or mode != expected.mode:
        raise PatchConflict(f"Path changed during patch: {path}")


def _cleanup_paths(paths: list[Path]) -> None:
    for path in paths:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            logger.warning("patch_cleanup_failed path={}", path)


def _cleanup_empty_dirs(paths: list[Path]) -> None:
    for path in sorted(paths, key=lambda value: len(value.parts), reverse=True):
        try:
            path.rmdir()
        except OSError:
            pass


def _ensure_parent(path: Path, created_dirs: list[Path]) -> None:
    missing: list[Path] = []
    parent = path.parent
    while not parent.exists():
        missing.append(parent)
        parent = parent.parent
    path.parent.mkdir(parents=True, exist_ok=True)
    created_dirs.extend(missing)


def _apply_patch(patch_text: str) -> str:
    """Apply a parsed patch envelope to the workspace. Synchronous.

    Read-modify-write with no locking of its own — the caller serialises it.
    """
    denied_paths = get_denied_paths()
    patches = _parse_patch(patch_text)
    original: dict[Path, FileSnapshot | None] = {}
    virtual: dict[Path, VirtualFile | None] = {}
    touched: list[Path] = []
    metadata: list[dict[str, object]] = []

    def load(path: Path) -> VirtualFile | None:
        if path not in virtual:
            snapshot = _snapshot(path)
            original[path] = snapshot
            virtual[path] = (
                VirtualFile(snapshot.content, snapshot.mode) if snapshot else None
            )
            touched.append(path)
        return virtual[path]

    for patch in patches:
        resolved = denied_paths.validate_path(patch.path)
        target = denied_paths.validate_path(patch.move_to) if patch.move_to else None
        current = load(resolved)

        if patch.kind == "add":
            if current is not None:
                raise FileExistsError(
                    f"Path already exists: {denied_paths.display_path(resolved)}"
                )
            virtual[resolved] = VirtualFile(
                _lines_to_text(patch.contents).encode("utf-8"), DEFAULT_FILE_MODE
            )
            metadata.append(
                {"path": patch.path, "hunks": [{"old_start": 1, "new_start": 1}]}
            )
            continue

        if patch.kind == "delete":
            if current is None:
                raise FileNotFoundError(
                    f"File not found: {denied_paths.display_path(resolved)}"
                )
            virtual[resolved] = None
            continue

        if current is None:
            raise FileNotFoundError(
                f"File not found: {denied_paths.display_path(resolved)}"
            )
        content = current.content.decode("utf-8")
        new_content, hunks = _apply_chunks_with_meta(content, patch.chunks, patch.path)
        updated = VirtualFile(new_content.encode("utf-8"), current.mode)

        if target is None:
            virtual[resolved] = updated
        elif target == resolved:
            if updated.content == current.content:
                raise ValueError(
                    f"Move for {patch.path} has the same path and no content change"
                )
            virtual[resolved] = updated
        else:
            destination = load(target)
            if destination is not None:
                raise FileExistsError(
                    f"Move destination already exists: "
                    f"{denied_paths.display_path(target)}"
                )
            virtual[resolved] = None
            virtual[target] = updated
            if target not in touched:
                touched.append(target)
        metadata.append({"path": patch.path, "hunks": hunks})

    final_paths = [path for path in touched if virtual[path] is not None]
    deleted_paths = [path for path in touched if virtual[path] is None]

    def is_changed(path: Path) -> bool:
        before = original[path]
        after = virtual[path]
        if before is None or after is None:
            return before is not after
        return before.content != after.content or before.mode != after.mode

    changed = [path for path in touched if is_changed(path)]

    staged: dict[Path, Path] = {}
    created_dirs: list[Path] = []
    applied: list[Path] = []
    try:
        for path in final_paths:
            if path not in changed:
                continue
            _ensure_parent(path, created_dirs)
            final = virtual[path]
            assert final is not None
            staged[path] = _stage_file(path, final.content, final.mode)

        # Recheck every path observed during planning, including paths that
        # were later deleted or replaced by another operation in this envelope.
        for path, snapshot in original.items():
            _assert_snapshot(path, snapshot)

        # Remove old names before installing new destinations. This supports
        # delete-then-add and delete-destination-then-move without replacement
        # ordering accidentally violating the virtual state.
        for path in deleted_paths:
            if path in changed and path.exists():
                path.unlink()
                applied.append(path)
        for path, tmp_path in staged.items():
            os.replace(tmp_path, path)
            applied.append(path)
    except BaseException:
        _cleanup_paths(list(staged.values()))
        for path in reversed(applied):
            snapshot = original[path]
            try:
                if snapshot is None:
                    path.unlink(missing_ok=True)
                else:
                    _atomic_write(path, snapshot.content, snapshot.mode)
            except OSError:
                logger.warning("patch_rollback_failed path={}", path)
        _cleanup_empty_dirs(created_dirs)
        raise

    for path in changed:
        notify_fs_change(path)
    logger.info("patch_applied files={}", len(changed))
    summary = "\n".join(denied_paths.display_path(path) for path in changed)
    diff_meta = json.dumps(
        {
            "files": metadata,
        },
        separators=(",", ":"),
    )
    return (
        f"@@ openagentd-diff-meta {diff_meta}\n"
        f"Patch applied successfully. Updated paths:\n{summary}"
    )


# Locks are per canonical path so unrelated agents can patch concurrently.
# Sources and move destinations are both locked, and acquisition is sorted to
# avoid deadlocks when two envelopes touch overlapping sets of paths.
_path_locks: dict[Path, asyncio.Lock] = {}


def _patch_paths(patch_text: str) -> list[Path]:
    denied_paths = get_denied_paths()
    paths: list[Path] = []
    for patch in _parse_patch(patch_text):
        paths.append(denied_paths.validate_path(patch.path))
        if patch.move_to is not None:
            paths.append(denied_paths.validate_path(patch.move_to))
    return sorted(set(paths))


async def _patch_file(patch_text: str) -> str:
    """Apply a patch envelope without stalling the shared event loop.

    One daemon serves every session, so the read/match/write — 28 ms on a
    2.3 MB file — must not run on the loop thread.
    """
    locks = [
        _path_locks.setdefault(path, asyncio.Lock())
        for path in _patch_paths(patch_text)
    ]
    for lock in locks:
        await lock.acquire()
    try:
        return await asyncio.to_thread(_apply_patch, patch_text)
    finally:
        for lock in reversed(locks):
            lock.release()


patch_file = Tool(
    _patch_file,
    name="patch",
    description=_DESCRIPTION,
    args_schema=PatchArgs,
)
