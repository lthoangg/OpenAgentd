"""patch tool - apply file-oriented patch envelopes."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
import json
import os
import re
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
    "applies cleanly. To replace a file wholesale, delete and re-add it in the "
    "same envelope. Directories cannot be deleted — use shell for that."
)

_PATCH_TEXT_DESCRIPTION = """\
The full patch text. Must start with '*** Begin Patch' and end with '*** End Patch'.

Each file section starts with one of:
  *** Add File: <path>      — create a new file; every content line starts with +
  *** Update File: <path>   — patch an existing file; optionally followed by:
      *** Move to: <path>   — rename/move the file after patching
  *** Delete File: <path>   — remove a file; no content follows

Update hunks start with @@ and use +/- prefixes (space = context):
  @@
  -old line
  +new line
   context line

Context and removed lines must match the file exactly, whole lines only —
copy them from a read rather than retyping. A hunk that matches nothing, or
matches in more than one place, fails the whole envelope; add surrounding
context lines to make it unique.
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


@dataclass
class FilePatch:
    kind: PatchKind
    path: str
    move_to: str | None = None
    contents: list[str] = field(default_factory=list)
    chunks: list[Chunk] = field(default_factory=list)


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
        if line.startswith("@@"):
            finish_chunk()
            chunk = Chunk()
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
            chunk.old.append(text)
            chunk.new.append(text)
            chunk.raw_old.append(line)
            chunk.raw_new.append(line)
        elif line == "":
            chunk.old.append("")
            chunk.new.append("")
            chunk.raw_old.append("")
            chunk.raw_new.append("")
        else:
            chunk.old.append(line)
            chunk.new.append(line)
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
        if [line.strip() for line in window] == stripped_target:
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
    hunks: list[dict[str, int]] = []

    for chunk in chunks:
        if chunk.old == chunk.new:
            continue

        old_lines, new_lines = chunk.old, chunk.new

        # 1. Exact match
        starts = _find_line_matches(content_lines, old_lines, trimmed=False)
        # 2. Trailing whitespace tolerant match
        if not starts:
            starts = _find_line_matches(content_lines, old_lines, trimmed=True)

        # 3. Fallback: unstripped context lines (lines copied verbatim from source)
        if not starts and chunk.raw_old != chunk.old:
            starts = _find_line_matches(
                content_lines, chunk.raw_old, trimmed=False
            ) or _find_line_matches(content_lines, chunk.raw_old, trimmed=True)
            if starts:
                old_lines = chunk.raw_old
                new_lines = chunk.raw_new

        # 4. Fallback: line-number prefixes stripped (e.g. from read tool output "12:   foo")
        if not starts:
            bare_old = _strip_line_number_prefixes(old_lines)
            if bare_old is not None:
                bare_starts = _find_line_matches(
                    content_lines, bare_old, trimmed=False
                ) or _find_line_matches(content_lines, bare_old, trimmed=True)
                if bare_starts:
                    starts = bare_starts
                    old_lines = bare_old
                    new_lines = _strip_line_number_prefixes(new_lines) or new_lines

        # 5. Fallback: uniform indentation shift
        if not starts:
            indent_starts = _find_indentation_tolerant_matches(content_lines, old_lines)
            if len(indent_starts) == 1:
                starts = indent_starts
                window = content_lines[starts[0] : starts[0] + len(old_lines)]
                new_lines = _adjust_new_lines_indentation(window, old_lines, new_lines)
                old_lines = window

        if not starts:
            raise ValueError(_format_context_miss_error(path, content_lines, chunk.old))
        if len(starts) > 1:
            raise ValueError(_format_ambiguous_context_error(path, starts, chunk.old))

        start = starts[0]
        new_start = start + 1
        old_start = new_start - line_delta
        hunks.append({"old_start": old_start, "new_start": new_start})
        line_delta += len(new_lines) - len(old_lines)
        content_lines[start : start + len(old_lines)] = new_lines

    next_content = "\n".join(content_lines)
    if has_trailing_newline and content_lines:
        next_content += "\n"
    if uses_crlf:
        next_content = next_content.replace("\n", "\r\n")
    return next_content, hunks


def _atomic_write(path: Path, data: bytes) -> None:
    """Write *data* to *path* via a same-directory temp file and ``os.replace``.

    A direct ``write_bytes`` that fails partway leaves a truncated file, which
    for the only file-mutation tool in the toolset means a half-patched source
    file. ``os.replace`` is atomic on POSIX and Windows, so a reader either
    sees the old content or the new content, never a partial write.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, path)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise


def _apply_patch(patch_text: str) -> str:
    """Apply a parsed patch envelope to the workspace. Synchronous.

    Read-modify-write with no locking of its own — the caller serialises it.
    """
    denied_paths = get_denied_paths()
    patches = _parse_patch(patch_text)
    planned: list[
        tuple[FilePatch, Path, Path | None, bytes | None, dict[str, object] | None]
    ] = []

    for patch in patches:
        resolved = denied_paths.validate_path(patch.path)
        target = denied_paths.validate_path(patch.move_to) if patch.move_to else None

        if patch.kind == "add":
            planned.append(
                (
                    patch,
                    resolved,
                    None,
                    _lines_to_text(patch.contents).encode("utf-8"),
                    {"path": patch.path, "hunks": [{"old_start": 1, "new_start": 1}]},
                )
            )
            continue
        if patch.kind == "delete":
            if not resolved.exists():
                raise FileNotFoundError(
                    f"File not found: {denied_paths.display_path(resolved)}"
                )
            if not resolved.is_file():
                raise IsADirectoryError(
                    f"Path is a directory: {denied_paths.display_path(resolved)}"
                )
            planned.append((patch, resolved, None, None, None))
            continue

        if not resolved.exists():
            raise FileNotFoundError(
                f"File not found: {denied_paths.display_path(resolved)}"
            )
        if not resolved.is_file():
            raise IsADirectoryError(
                f"Path is a directory: {denied_paths.display_path(resolved)}"
            )
        content = resolved.read_bytes().decode("utf-8")
        new_content, hunks = _apply_chunks_with_meta(content, patch.chunks, patch.path)
        planned.append(
            (
                patch,
                resolved,
                target,
                new_content.encode("utf-8"),
                {"path": patch.path, "hunks": hunks},
            )
        )

    changed: list[Path] = []
    for patch, resolved, target, data, _meta in planned:
        if patch.kind == "delete":
            resolved.unlink()
            changed.append(resolved)
        elif patch.kind == "add":
            _atomic_write(resolved, data if data is not None else b"")
            changed.append(resolved)
        else:
            write_path = target or resolved
            _atomic_write(write_path, data if data is not None else b"")
            changed.append(write_path)
            if target is not None and resolved != write_path and resolved.exists():
                resolved.unlink()
                changed.append(resolved)

    for path in changed:
        notify_fs_change(path)
    logger.info("patch_applied files={}", len(changed))
    summary = "\n".join(denied_paths.display_path(path) for path in changed)
    diff_meta = json.dumps(
        {
            "files": [meta for *_rest, meta in planned if meta is not None],
        },
        separators=(",", ":"),
    )
    return (
        f"@@ openagentd-diff-meta {diff_meta}\n"
        f"Patch applied successfully. Updated paths:\n{summary}"
    )


# Applying a patch reads a file, matches context, and writes it back. That was
# safe to run inline only because it contained no `await`: the event loop could
# not interleave two of them. Running it in a worker thread removes that
# accidental guarantee, so serialise explicitly. Patches are milliseconds long,
# and this preserves exactly the ordering callers already relied on.
_patch_lock = asyncio.Lock()


async def _patch_file(patch_text: str) -> str:
    """Apply a patch envelope without stalling the shared event loop.

    One daemon serves every session, so the read/match/write — 28 ms on a
    2.3 MB file — must not run on the loop thread.
    """
    async with _patch_lock:
        return await asyncio.to_thread(_apply_patch, patch_text)


patch_file = Tool(
    _patch_file,
    name="patch",
    description=_DESCRIPTION,
    args_schema=PatchArgs,
)
