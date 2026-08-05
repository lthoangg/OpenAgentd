"""patch tool - apply file-oriented patch envelopes."""

from __future__ import annotations

from dataclasses import dataclass, field
import json
from pathlib import Path
from typing import Literal

from loguru import logger
from pydantic import AliasChoices, BaseModel, Field, field_validator

from app.agent.sandbox import get_sandbox
from app.agent.tools.builtin.filesystem._config_watch import notify_fs_change
from app.agent.tools.registry import Tool

PatchKind = Literal["add", "update", "delete"]

_DESCRIPTION = (
    "Apply a stripped-down file patch envelope with add, update, delete, "
    "and move operations."
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
        elif line.startswith("-"):
            chunk.old.append(line[1:])
        elif line.startswith(" "):
            text = line[1:]
            chunk.old.append(text)
            chunk.new.append(text)
        elif line == "":
            chunk.old.append("")
            chunk.new.append("")
        else:
            chunk.old.append(line)
            chunk.new.append(line)

    finish_chunk()
    if not patches:
        raise ValueError("Patch contains no file operations.")
    return patches


def _lines_to_text(lines: list[str]) -> str:
    if not lines:
        return ""
    return "\n".join(lines) + "\n"


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

        starts = _find_line_matches(content_lines, chunk.old, trimmed=False)
        if not starts:
            starts = _find_line_matches(content_lines, chunk.old, trimmed=True)

        if not starts:
            raise ValueError(f"Could not find patch context in {path}.")
        if len(starts) > 1:
            raise ValueError(f"Patch context is ambiguous in {path}.")

        start = starts[0]
        new_start = start + 1
        old_start = new_start - line_delta
        hunks.append({"old_start": old_start, "new_start": new_start})
        line_delta += len(chunk.new) - len(chunk.old)
        content_lines[start : start + len(chunk.old)] = chunk.new

    next_content = "\n".join(content_lines)
    if has_trailing_newline and content_lines:
        next_content += "\n"
    if uses_crlf:
        next_content = next_content.replace("\n", "\r\n")
    return next_content, hunks


async def _patch_file(patch_text: str) -> str:
    """Apply a parsed patch envelope to the workspace."""
    sandbox = get_sandbox()
    patches = _parse_patch(patch_text)
    planned: list[
        tuple[FilePatch, Path, Path | None, bytes | None, dict[str, object] | None]
    ] = []

    for patch in patches:
        resolved = sandbox.validate_path(patch.path)
        target = sandbox.validate_path(patch.move_to) if patch.move_to else None

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
                    f"File not found: {sandbox.display_path(resolved)}"
                )
            if not resolved.is_file():
                raise IsADirectoryError(
                    f"Path is a directory: {sandbox.display_path(resolved)}"
                )
            planned.append((patch, resolved, None, None, None))
            continue

        if not resolved.exists():
            raise FileNotFoundError(f"File not found: {sandbox.display_path(resolved)}")
        if not resolved.is_file():
            raise IsADirectoryError(
                f"Path is a directory: {sandbox.display_path(resolved)}"
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
            resolved.parent.mkdir(parents=True, exist_ok=True)
            resolved.write_bytes(data if data is not None else b"")
            changed.append(resolved)
        else:
            write_path = target or resolved
            write_path.parent.mkdir(parents=True, exist_ok=True)
            write_path.write_bytes(data if data is not None else b"")
            changed.append(write_path)
            if target is not None and resolved != write_path and resolved.exists():
                resolved.unlink()
                changed.append(resolved)

    for path in changed:
        notify_fs_change(path)
    logger.info("patch_applied files={}", len(changed))
    summary = "\n".join(sandbox.display_path(path) for path in changed)
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


patch_file = Tool(
    _patch_file,
    name="patch",
    description=_DESCRIPTION,
    args_schema=PatchArgs,
)
