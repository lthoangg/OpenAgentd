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
            "or '*.py' with match='name' to match filename only. Brace "
            "alternation works: 'src/**/*.{ts,tsx}'. A pattern with no '/' is "
            "retried at any depth if nothing matches at the top level."
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


_MAX_BRACE_VARIANTS = 64


def expand_braces(pattern: str) -> list[str]:
    """Expand shell-style ``{a,b}`` alternations into concrete patterns.

    Neither ``Path.glob`` nor ``PurePath.full_match`` understands braces, so
    ``web/src/**/*.{ts,tsx}`` used to return "no files" for a pattern every shell
    accepts. Production telemetry had these as the largest attributable share of
    `glob`'s 31% no-hit rate.

    Handles nesting (``{a,{b,c}}``) and empty alternatives (``b{.py,}``). A stray
    or unbalanced brace is left alone and matched literally, and the expansion is
    capped so a pathological pattern cannot explode combinatorially.
    """
    start = pattern.find("{")
    if start == -1:
        return [pattern]

    depth = 0
    for index in range(start, len(pattern)):
        char = pattern[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                break
    else:
        return [pattern]  # unbalanced — treat literally

    prefix, body, suffix = (
        pattern[:start],
        pattern[start + 1 : index],
        pattern[index + 1 :],
    )

    # Split on top-level commas only, so nested braces stay intact.
    options: list[str] = []
    current: list[str] = []
    depth = 0
    for char in body:
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
        if char == "," and depth == 0:
            options.append("".join(current))
            current = []
            continue
        current.append(char)
    options.append("".join(current))

    if len(options) == 1:
        # `{foo}` carries no alternation; keep the braces literal.
        return [pattern]

    out: list[str] = []
    for option in options:
        for expanded in expand_braces(f"{prefix}{option}{suffix}"):
            if expanded not in out:
                out.append(expanded)
            if len(out) >= _MAX_BRACE_VARIANTS:
                return out
    return out


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

    variants = expand_braces(pattern)

    def _select(
        candidates: list[tuple[str, Path]], patterns: list[str]
    ) -> list[tuple[str, Path]]:
        """Candidates matching any of ``patterns``, deduplicated, rank-ordered.

        Match on cheap string operations only; ``stat`` is left to the caller so
        it is paid per hit rather than per file in the tree.

        ``PurePath.full_match`` is pathlib's own glob matcher, so ``*`` stays
        within a path component, ``**`` spans directories, and character classes
        keep working: the semantics callers already rely on.
        """
        if match == "name":
            hit = [
                (rel, path)
                for rel, path in candidates
                if any(fnmatch.fnmatchcase(path.name, p) for p in patterns)
            ]
        elif any(p.endswith("/") for p in patterns):
            # A trailing slash restricts the pattern to directories, and this
            # tool reports files. ``PurePath`` normalises the slash away, which
            # would turn ``**/`` into ``**`` and match the entire tree.
            hit = []
        else:
            hit = [
                (rel, path)
                for rel, path in candidates
                if any(PurePosixPath(rel).full_match(p) for p in patterns)
            ]
        hit.sort(key=lambda item: _rank(item[0]))
        return hit

    def _scan() -> list[str]:
        candidates = _visible_files(resolved, gitignore_rules)
        matched = _select(candidates, variants)

        # A pattern with no separator only matches the top level, so `*title*`
        # answered "no files" while the file sat two directories down. Retry once
        # at any depth rather than reporting a miss. Anchored patterns are left
        # alone: the caller was explicit about where to look.
        if not matched:
            widened = [
                f"**/{p}" for p in variants if "/" not in p and not p.startswith("**")
            ]
            if widened:
                matched = _select(candidates, widened)

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
