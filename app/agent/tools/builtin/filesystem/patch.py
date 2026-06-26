"""patch tool - apply file-oriented patch envelopes."""

from __future__ import annotations

from dataclasses import dataclass, field
import json
from pathlib import Path
from typing import Literal

from loguru import logger
from pydantic import BaseModel, Field, field_validator

from app.agent.sandbox import get_sandbox
from app.agent.tools.builtin.filesystem._config_watch import notify_fs_change
from app.agent.tools.registry import Tool


PatchKind = Literal["add", "update", "delete"]

_DESCRIPTION = (
    "Apply a stripped-down file patch envelope with add, update, delete, "
    "and move operations."
)


class PatchArgs(BaseModel):
    """Arguments for the patch tool."""

    patch_text: str = Field(
        description="The full patch text describing all file changes to apply."
    )

    @field_validator("patch_text")
    @classmethod
    def validate_patch_text(cls, v: str) -> str:
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


def _parse_patch(patch_text: str) -> list[FilePatch]:
    lines = patch_text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    if not lines or lines[0] != "*** Begin Patch" or lines[-1] != "*** End Patch":
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
            if not line.startswith("+"):
                raise ValueError("Add file contents must be prefixed with '+'.")
            current.contents.append(line[1:])
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


def _apply_chunks(content: str, chunks: list[Chunk], path: str) -> str:
    return _apply_chunks_with_meta(content, chunks, path)[0]


def _apply_chunks_with_meta(
    content: str, chunks: list[Chunk], path: str
) -> tuple[str, list[dict[str, int]]]:
    next_content = content
    line_delta = 0
    hunks: list[dict[str, int]] = []
    for chunk in chunks:
        old = _lines_to_text(chunk.old)
        new = _lines_to_text(chunk.new)
        if old == new:
            continue
        count = next_content.count(old)
        if count == 0:
            raise ValueError(f"Could not find patch context in {path}.")
        if count > 1:
            raise ValueError(f"Patch context is ambiguous in {path}.")
        idx = next_content.find(old)
        new_start = next_content.count("\n", 0, idx) + 1
        old_start = new_start - line_delta
        hunks.append({"old_start": old_start, "new_start": new_start})
        line_delta += len(chunk.new) - len(chunk.old)
        next_content = next_content.replace(old, new, 1)
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
        content = resolved.read_text(encoding="utf-8")
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
            resolved.write_bytes(data or b"")
            changed.append(resolved)
        else:
            write_path = target or resolved
            write_path.parent.mkdir(parents=True, exist_ok=True)
            write_path.write_bytes(data or b"")
            changed.append(write_path)
            if target is not None:
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
