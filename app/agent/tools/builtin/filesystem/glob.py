"""glob tool — find files by glob pattern (full-path or filename-only)."""

from __future__ import annotations

import asyncio
import fnmatch
import os
from pathlib import Path

from pydantic import BaseModel, Field

from app.agent.sandbox import get_sandbox
from app.agent.tools.builtin.filesystem._ignore import (
    _SKIPPED_DIR_NAMES,
    is_gitignored,
    load_gitignore_rules,
)
from app.agent.tools.registry import Tool

_DESCRIPTION = (
    "Find files by glob pattern. Use match='path' (default) for full-path patterns "
    "like 'src/**/*.ts', or match='name' for filename-only like '*.py'."
)


class GlobArgs(BaseModel):
    """Arguments for the glob tool."""

    pattern: str = Field(
        description=(
            "Glob pattern. Use '**/*.py' or 'src/**/*.ts' to match by full path, "
            "or '*.py' with match='name' to match filename only."
        )
    )
    directory: str = Field(
        default=".", description="Search root (default '.' = workspace root)."
    )
    match: str = Field(
        default="path",
        description="Match against 'path' (default) or 'name' (filename only).",
    )
    max_results: int = Field(
        default=200, description="Maximum number of results to return (default 200)."
    )


async def _glob_files(
    pattern: str,
    directory: str = ".",
    match: str = "path",
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
                    rel = (current / fname).relative_to(resolved).as_posix()
                    if is_gitignored(rel, is_dir=False, rules=gitignore_rules):
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
            for m in sorted(resolved.glob(pattern)):
                if not m.is_file():
                    continue
                rel = m.relative_to(resolved)
                if any(part.startswith(".") for part in rel.parts):
                    continue
                if any(part in _SKIPPED_DIR_NAMES for part in rel.parts[:-1]):
                    continue
                if is_gitignored(rel.as_posix(), is_dir=False, rules=gitignore_rules):
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
