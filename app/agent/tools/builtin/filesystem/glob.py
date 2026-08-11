"""glob tool — find files by glob pattern (full-path or filename-only)."""

from __future__ import annotations

import asyncio
import fnmatch
import os
from pathlib import Path, PurePosixPath
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


def _validate_pattern(pattern: str) -> None:
    """Reject patterns the traversal cannot honour, with an actionable message.

    ``Path.glob`` accepted ``../outside/*`` and happily reported matches from
    outside the search root; the walk below simply cannot see them, and silently
    returning "no files" would be a worse answer than saying why.
    """
    if os.path.isabs(pattern) or PurePosixPath(pattern).is_absolute():
        raise ValueError(
            f"Pattern must be relative to the search directory: {pattern!r}"
        )
    if ".." in PurePosixPath(pattern).parts:
        raise ValueError(
            f"'..' is not allowed in a pattern: {pattern!r} — pass the "
            "'directory' argument to search somewhere else."
        )


def _visible_files(root: Path, rules: list[tuple[str, bool]]) -> list[tuple[str, Path]]:
    """Every file under ``root`` this tool may report, as ``(rel_posix, path)``.

    Pruning happens *during* traversal, which is the whole point of not using
    ``Path.glob``: pathlib has no way to skip a subtree, so it enumerated
    ``node_modules``, ``.venv`` and ``.git`` in full and then threw the results
    away in a post-filter — ~3s at this repo's root, most of it wasted.

    Directories are visited with ordinary names before dot-prefixed ones so the
    natural traversal order already approximates :func:`_rank`.
    """
    found: list[tuple[str, Path]] = []
    for dirpath, dirnames, filenames in os.walk(root):
        current = Path(dirpath)
        rel_dir = current.relative_to(root)
        dirnames[:] = sorted(
            (
                name
                for name in dirnames
                if name not in NOISE_DIR_NAMES
                and not is_gitignored(
                    (rel_dir / name).as_posix(), is_dir=True, rules=rules
                )
            ),
            key=lambda name: (name.startswith("."), name),
        )
        for fname in sorted(filenames):
            rel = (rel_dir / fname).as_posix()
            if is_gitignored(rel, is_dir=False, rules=rules):
                continue
            found.append((rel, current / fname))
    return found


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
    if match == "path":
        _validate_pattern(pattern)
    gitignore_rules = load_gitignore_rules(resolved)

    def _scan() -> list[str]:
        candidates = _visible_files(resolved, gitignore_rules)
        # Match on cheap string operations first; stat only what matched.
        #
        # ``PurePath.full_match`` is pathlib's own glob matcher, so ``*`` stays
        # within a path component, ``**`` spans directories, and character
        # classes keep working — the semantics callers already rely on.
        if match == "name":
            matched = [
                (rel, path)
                for rel, path in candidates
                if fnmatch.fnmatchcase(path.name, pattern)
            ]
        elif pattern.endswith("/"):
            # A trailing slash restricts the pattern to directories, and this
            # tool reports files. ``PurePath`` normalises the slash away, which
            # would turn ``**/`` into ``**`` and match the entire tree.
            matched = []
        else:
            matched = [
                (rel, path)
                for rel, path in candidates
                if PurePosixPath(rel).full_match(pattern)
            ]
        matched.sort(key=lambda item: _rank(item[0]))

        hits: list[str] = []
        for _rel, path in matched:
            # Symlinks to directories and dangling links are not results, and a
            # sandbox-denied file must never be named in the output.
            if not path.is_file() or sandbox.is_denied_path(path):
                continue
            hits.append(sandbox.display_path(path))
            if len(hits) >= max_results:
                break
        return hits

    matches = await asyncio.to_thread(_scan)

    if not matches:
        return f"No files matching '{pattern}' in {sandbox.display_path(resolved)}"
    return "\n".join(matches)


glob_files = Tool(
    _glob_files,
    name="glob",
    description=_DESCRIPTION,
    args_schema=GlobArgs,
)
