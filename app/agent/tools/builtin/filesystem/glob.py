"""glob tool — find files by glob pattern (full-path or filename-only)."""

from __future__ import annotations

import asyncio
import fnmatch
import os
import re
from pathlib import Path, PurePosixPath
import pathlib
from typing import Callable, Literal

from pydantic import BaseModel, Field

from app.agent.denied_paths import get_denied_paths
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
        description="Match full relative paths or filenames only.",
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


def _compile_glob_matcher(pattern: str) -> Callable[[str], bool]:
    """Precompile a glob pattern into a fast matcher function."""
    globber_cls = getattr(pathlib, "_StringGlobber", None)
    if globber_cls is not None:
        globber = globber_cls("/", True, recursive=True)
        matcher = globber.compile(pattern)
        return lambda s: matcher(s) is not None
    pure = PurePosixPath(pattern)
    return lambda s: PurePosixPath(s).full_match(pure)


def _explicitly_named_noise_dirs(patterns: list[str]) -> frozenset[str]:
    """Generated-directory names the caller wrote literally into the pattern.

    Pruning ``node_modules`` out of ``**/*.ts`` is what makes this tool usable
    at all. Pruning it out of ``web/node_modules/@scope/pkg/**`` answers a
    question nobody asked: reading a dependency's own source is legitimate,
    and the silent refusal was indistinguishable from "no such file".
    A literal path segment is an explicit request, so honour it.
    """
    return frozenset(
        segment
        for pattern in patterns
        for segment in PurePosixPath(pattern).parts
        if segment in NOISE_DIR_NAMES
    )


_WILDCARD_RE = re.compile(r"[*?\[\]]")


def _literal_dir_prefix(pattern: str) -> PurePosixPath:
    """Leading wildcard-free directories of *pattern*.

    Nothing outside this prefix can match, so the walk can start there rather
    than at the search root. That is the difference between enumerating a whole
    repository and enumerating one package directory — the reason
    ``web/node_modules/@scope/pkg/**`` took 10s.
    """
    parts = PurePosixPath(pattern).parts
    literal: list[str] = []
    for segment in parts:
        if _WILDCARD_RE.search(segment):
            break
        literal.append(segment)
    else:
        # No wildcard anywhere, so the last segment is the filename itself.
        literal = literal[:-1]
    return PurePosixPath(*literal)


def _shared_prefix(prefixes: list[PurePosixPath]) -> PurePosixPath:
    """Deepest directory common to every brace variant."""
    if not prefixes:
        return PurePosixPath()
    common = prefixes[0].parts
    for prefix in prefixes[1:]:
        parts = prefix.parts
        limit = min(len(common), len(parts))
        index = 0
        while index < limit and common[index] == parts[index]:
            index += 1
        common = common[:index]
        if not common:
            break
    return PurePosixPath(*common)


def _prefix_is_reachable(
    prefix: PurePosixPath,
    rules: list[tuple[str, bool]],
    allowed_noise: frozenset[str],
) -> bool:
    """True when every directory on the way down to ``prefix`` is visible.

    A walk that starts at the prefix never visits its ancestors, so the prune
    and ``.gitignore`` rules those ancestors would have triggered have to be
    applied here instead — otherwise ``build/**/*.js`` starts reporting files
    from an ignored ``build/``.
    """
    parts = prefix.parts
    for index, name in enumerate(parts):
        if name in NOISE_DIR_NAMES and name not in allowed_noise:
            return False
        if is_gitignored("/".join(parts[: index + 1]), is_dir=True, rules=rules):
            return False
    return True


def _visible_files(
    root: Path,
    rules: list[tuple[str, bool]],
    allowed_noise: frozenset[str] = frozenset(),
    rel_base: Path | None = None,
) -> list[tuple[str, Path]]:
    """Every file under ``root`` this tool may report, as ``(rel_posix, path)``.

    Pruning happens *during* traversal, which is the whole point of not using
    ``Path.glob``: pathlib has no way to skip a subtree, so it enumerated
    ``node_modules``, ``.venv`` and ``.git`` in full and then threw the results
    away in a post-filter — ~3s at this repo's root, most of it wasted.

    Directories are visited with ordinary names before dot-prefixed ones so the
    natural traversal order already approximates :func:`_rank`.

    ``allowed_noise`` names generated directories the caller asked for by name;
    those are walked instead of pruned.

    ``rel_base`` is what returned paths are relative to. It differs from
    ``root`` when the walk is anchored at a pattern's literal prefix: the
    ``.gitignore`` rules were loaded relative to the search root, so reporting
    paths relative to anything else would silently stop matching them.
    """
    base = rel_base or root
    found: list[tuple[str, Path]] = []
    for dirpath, dirnames, filenames in os.walk(root):
        current = Path(dirpath)
        rel_dir = current.relative_to(base).as_posix()
        dirnames[:] = sorted(
            (
                name
                for name in dirnames
                if (name not in NOISE_DIR_NAMES or name in allowed_noise)
                and not is_gitignored(
                    f"{rel_dir}/{name}" if rel_dir != "." else name,
                    is_dir=True,
                    rules=rules,
                )
            ),
            key=lambda name: (name.startswith("."), name),
        )
        for fname in sorted(filenames):
            rel = f"{rel_dir}/{fname}" if rel_dir != "." else fname
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
    denied_paths = get_denied_paths()
    resolved = denied_paths.validate_path(directory)
    if not resolved.is_dir():
        raise NotADirectoryError(
            f"Not a directory: {denied_paths.display_path(resolved)}"
        )
    if match == "path":
        _validate_pattern(pattern)
    gitignore_rules = load_gitignore_rules(resolved)

    variants = expand_braces(pattern)
    # ``.git`` stays pruned regardless: it is an implementation detail of the
    # repository, not source the caller can act on, and walking it is slow.
    allowed_noise = _explicitly_named_noise_dirs(variants) - {".git"}

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
            matchers = [_compile_glob_matcher(p) for p in patterns]
            hit = [
                (rel, path) for rel, path in candidates if any(m(rel) for m in matchers)
            ]
        hit.sort(key=lambda item: _rank(item[0]))
        return hit

    def _matched_dirs(
        candidates: list[tuple[str, Path]], patterns: list[str]
    ) -> list[str]:
        """Visible directories matching ``patterns``, for the miss message only.

        Ancestors of the visible files, so no second walk is needed. Empty
        directories are therefore invisible here — a fair trade for a hint that
        is computed only when there is nothing to report.
        """
        dirs: set[str] = set()
        for rel, _path in candidates:
            for parent in PurePosixPath(rel).parents:
                if parent.name:
                    dirs.add(parent.as_posix())
        if not dirs:
            return []
        matchers = [_compile_glob_matcher(p) for p in patterns]
        return sorted(d for d in dirs if any(m(d) for m in matchers))

    def _scan() -> tuple[list[str], list[str]]:
        # Only files under the pattern's literal prefix can match, so start the
        # walk there. ``match='name'`` compares basenames and has no anchor, and
        # a separator-free pattern may be widened below, so both keep the root.
        prefix = PurePosixPath()
        if match == "path":
            prefix = _shared_prefix([_literal_dir_prefix(p) for p in variants])
        walk_root = resolved / prefix if prefix.parts else resolved
        if prefix.parts and not _prefix_is_reachable(
            prefix, gitignore_rules, allowed_noise
        ):
            return [], []
        if not walk_root.is_dir():
            return [], []

        candidates = _visible_files(
            walk_root, gitignore_rules, allowed_noise, rel_base=resolved
        )
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
            if not path.is_file() or denied_paths.is_denied_path(path):
                continue
            hits.append(denied_paths.display_path(path))
            if len(hits) >= max_results:
                break
        if hits or match == "name":
            return hits, []
        return hits, _matched_dirs(candidates, variants)

    matches, dir_hints = await asyncio.to_thread(_scan)

    if not matches:
        miss = f"No files matching '{pattern}' in {denied_paths.display_path(resolved)}"
        if dir_hints:
            # This tool reports files, so a pattern that names a directory looks
            # identical to a typo. Say which, and how to list it.
            named = ", ".join(dir_hints[:3])
            return f"{miss}; it matches directories ({named}) — use '{dir_hints[0]}/**' to list files inside"
        return miss
    return "\n".join(matches)


glob_files = Tool(
    _glob_files,
    name="glob",
    description=_DESCRIPTION,
    args_schema=GlobArgs,
)
