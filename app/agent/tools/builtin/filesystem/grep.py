"""grep_files tool — search file contents by regex."""

from __future__ import annotations

import asyncio
import fnmatch
import os
import re
from pathlib import Path

from pydantic import BaseModel, Field, field_validator

from app.agent.sandbox import get_sandbox
from app.agent.tools.builtin.filesystem._ignore import (
    _SKIPPED_DIR_NAMES,
    is_gitignored,
    load_gitignore_rules,
)
from app.agent.tools.registry import Tool

# Me cap regex pattern length — prevents catastrophically complex patterns
_MAX_PATTERN_LEN = 500
# Me timeout for the entire scan in seconds
_SCAN_TIMEOUT_S = 10

_DESCRIPTION = "Search file contents by regex. Returns 'file:line: content'."


class GrepArgs(BaseModel):
    """Arguments for the grep tool."""

    pattern: str = Field(
        description="Regex to match per line (e.g. 'def main', 'TODO|FIXME')."
    )
    directory: str = Field(
        default=".", description="Search root; '.' is the workspace root."
    )
    include: str = Field(
        default="*",
        description="Filename glob to filter files (e.g. '*.py').",
    )
    max_results: int = Field(
        default=100, ge=1, description="Maximum matching lines to return."
    )

    @field_validator("pattern")
    @classmethod
    def validate_pattern(cls, v: str) -> str:
        if len(v) > _MAX_PATTERN_LEN:
            raise ValueError(
                f"Pattern too long ({len(v)} chars, max {_MAX_PATTERN_LEN})"
            )
        try:
            re.compile(v)
        except re.error as exc:
            raise ValueError(f"Invalid regex: {exc}")
        return v


async def _grep_files(
    pattern: str,
    directory: str = ".",
    include: str = "*",
    max_results: int = 100,
) -> str:
    """Search file contents by regex within the workspace."""
    sandbox = get_sandbox()
    resolved = sandbox.validate_path(directory)
    if not resolved.is_dir():
        raise NotADirectoryError(f"Not a directory: {sandbox.display_path(resolved)}")
    gitignore_rules = load_gitignore_rules(resolved)

    # Me reject patterns that are too long — prevents crafted ReDoS payloads
    if len(pattern) > _MAX_PATTERN_LEN:
        raise ValueError(
            f"Pattern too long ({len(pattern)} chars, max {_MAX_PATTERN_LEN})"
        )

    try:
        compiled = re.compile(pattern)
    except re.error as exc:
        raise ValueError(f"Invalid regex: {exc}") from exc

    def _scan() -> list[str]:
        hits: list[str] = []
        for root, dirs, files in os.walk(resolved):
            current = Path(root)
            dirs[:] = [
                d
                for d in dirs
                if not d.startswith(".")
                and d not in _SKIPPED_DIR_NAMES
                and not is_gitignored(
                    (current / d).relative_to(resolved).as_posix(),
                    is_dir=True,
                    rules=gitignore_rules,
                )
            ]
            for fname in files:
                if fname.startswith("."):
                    continue
                if not fnmatch.fnmatch(fname, include):
                    continue
                fpath = current / fname
                rel = fpath.relative_to(resolved).as_posix()
                if is_gitignored(rel, is_dir=False, rules=gitignore_rules):
                    continue
                try:
                    text = fpath.read_text(encoding="utf-8")
                except (UnicodeDecodeError, OSError):
                    continue
                display_path = sandbox.display_path(fpath)
                for lineno, line in enumerate(text.splitlines(), start=1):
                    if compiled.search(line):
                        hits.append(f"{display_path}:{lineno}: {line[:200]}")
                        if len(hits) >= max_results:
                            return hits
        return hits

    # Me run scan with timeout to prevent ReDoS from locking the thread pool
    try:
        matches = await asyncio.wait_for(
            asyncio.to_thread(_scan), timeout=_SCAN_TIMEOUT_S
        )
    except asyncio.TimeoutError:
        raise TimeoutError(
            f"grep_files scan timed out after {_SCAN_TIMEOUT_S}s — "
            "pattern may be too complex or directory too large"
        )
    if not matches:
        return f"No matches for pattern '{pattern}' in {sandbox.display_path(resolved)} (include={include})"
    return "\n".join(matches)


grep_files = Tool(
    _grep_files,
    name="grep",
    description=_DESCRIPTION,
    args_schema=GrepArgs,
)
