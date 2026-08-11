"""glob tool — find files by glob pattern (full-path or filename-only)."""

from __future__ import annotations

import asyncio
import fnmatch
import os
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from app.agent.sandbox import get_sandbox
from app.agent.tools.builtin.filesystem._ignore import (
    NOISE_DIR_NAMES,
    is_gitignored,
    load_gitignore_rules,
)
from app.agent.tools.registry import Tool

_DESCRIPTION = (
    "Find files by glob pattern. Use match='path' for full paths or match='name' "
    "for filenames only."
)


def _rank(rel: str) -> tuple[int, str]:
    """Sort key placing dot-prefixed paths last.

    Dot directories are searchable (`.github/`, `.openagentd/skills/`), but a
    plain alphabetical sort put them ahead of everything — `**/*.py` filled its
    whole result cap with tooling before reaching `app/`. Ordinary paths first,
    alphabetical within each group.
    """
    return (1 if any(part.startswith(".") for part in rel.split("/")) else 0, rel)


class GlobArgs(BaseModel):
    """Arguments for the glob tool."""

    pattern: str = Field(
        description=(
            "Glob pattern. Use '**/*.py' or 'src/**/*.ts' to match by full path, "
            "or '*.py' with match='name' to match filename only."
        )
    )
    directory: str = Field(
        default=".", description="Search root; '.' is the workspace root."
    )
    match: Literal["path", "name"] = Field(
        default="path",
        description="Match against full 'path' or filename 'name'.",
    )
    max_results: int = Field(
        default=200,
        ge=1,
        description="Maximum number of results to return.",
    )


async def _glob_files(
    pattern: str,
    directory: str = ".",
    match: Literal["path", "name"] = "path",
    max_results: int = 200,
) -> str:
    """Find files by glob pattern, honouring gitignore and skip rules."""
    sandbox = get_sandbox()
    resolved = sandbox.validate_path(directory)
    if not resolved.is_dir():
        raise NotADirectoryError(f"Not a directory: {sandbox.display_path(resolved)}")
    gitignore_rules = load_gitignore_rules(resolved)

    if match == "name":

        def _scan_name() -> list[str]:
            hits: list[str] = []
            for root, dirs, files in os.walk(resolved):
                current = Path(root)
                # See grep: dot entries are in scope, generated trees are not.
                # Walking ordinary directories first keeps `_rank`'s ordering
                # intact under the early exit at `max_results`.
                dirs[:] = [
                    d
                    for d in dirs
                    if d not in NOISE_DIR_NAMES
                    and not is_gitignored(
                        (current / d).relative_to(resolved).as_posix(),
                        is_dir=True,
                        rules=gitignore_rules,
                    )
                ]
                dirs.sort(key=lambda d: (d.startswith("."), d))
                for fname in sorted(files, key=lambda f: (f.startswith("."), f)):
                    rel = (current / fname).relative_to(resolved).as_posix()
                    if is_gitignored(rel, is_dir=False, rules=gitignore_rules):
                        continue
                    if sandbox.is_denied_path(current / fname):
                        continue
                    if fnmatch.fnmatch(fname, pattern):
                        hits.append(sandbox.display_path(current / fname))
                        if len(hits) >= max_results:
                            return hits
            return hits

        matches = await asyncio.to_thread(_scan_name)
    else:

        def _scan_path() -> list[str]:
            hits: list[str] = []
            for m in sorted(
                resolved.glob(pattern),
                key=lambda p: _rank(p.relative_to(resolved).as_posix()),
            ):
                if not m.is_file():
                    continue
                rel = m.relative_to(resolved)
                if any(part in NOISE_DIR_NAMES for part in rel.parts[:-1]):
                    continue
                if is_gitignored(rel.as_posix(), is_dir=False, rules=gitignore_rules):
                    continue
                if sandbox.is_denied_path(m):
                    continue
                hits.append(sandbox.display_path(m))
                if len(hits) >= max_results:
                    break
            return hits

        matches = await asyncio.to_thread(_scan_path)

    if not matches:
        return f"No files matching '{pattern}' in {sandbox.display_path(resolved)}"
    return "\n".join(matches)


glob_files = Tool(
    _glob_files,
    name="glob",
    description=_DESCRIPTION,
    args_schema=GlobArgs,
)
