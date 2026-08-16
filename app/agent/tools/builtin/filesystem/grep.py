"""grep_files tool — search file contents by regex."""

from __future__ import annotations

import asyncio
import fnmatch
import io
import os
import re
from pathlib import Path

from pydantic import BaseModel, Field, field_validator

from app.agent.denied_paths import get_denied_paths
from app.agent.tools.builtin.filesystem._ignore import (
    NOISE_DIR_NAMES,
    is_gitignored,
    load_gitignore_rules,
)
from app.agent.tools.registry import Tool

# Me cap regex pattern length — prevents catastrophically complex patterns
_MAX_PATTERN_LEN = 500
# Me timeout for the entire scan in seconds
_SCAN_TIMEOUT_S = 10
# Bytes sampled from the head of a file to decide whether it is binary
_BINARY_SNIFF_BYTES = 4096
# Bytes per read when ruling a file out by literal content
_LITERAL_SCAN_CHUNK = 262144
# Characters that give a pattern meaning beyond a plain substring
_REGEX_META = frozenset(".^$*+?{}[]()|\\")

_DESCRIPTION = (
    "Search file contents by regex. Returns 'file:line: content'. Use glob to "
    "find files by name instead, or lsp to follow a symbol's definitions and "
    "references."
)


def _compile_pattern(pattern: str) -> re.Pattern[str]:
    """Validate and compile *pattern*, rejecting ReDoS-sized inputs.

    Shared by the Pydantic validator and the tool body so the length limit and
    the error wording cannot drift apart, and so direct internal callers get
    the same guarantees as schema-validated ones.
    """
    if len(pattern) > _MAX_PATTERN_LEN:
        raise ValueError(
            f"Pattern too long ({len(pattern)} chars, max {_MAX_PATTERN_LEN})"
        )
    try:
        return re.compile(pattern)
    except re.error as exc:
        raise ValueError(f"Invalid regex: {exc}") from exc


def _required_literals(pattern: str) -> tuple[bytes, ...]:
    """Substrings a file must contain for *pattern* to match anything.

    Two thirds of recorded patterns are a bare literal (25%) or an alternation
    of literals (41%), and most files contain neither — so a byte scan rules
    them out before they are decoded and matched line by line.

    Returns ``()`` for anything carrying regex syntax, including ``(?i)``,
    which would make the byte comparison wrong. This is an optimisation: being
    unsure is free, being wrong would silently lose matches.
    """
    branches = pattern.split("|")
    if not all(branch and not (_REGEX_META & set(branch)) for branch in branches):
        return ()
    return tuple(branch.encode("utf-8") for branch in branches)


def _stream_contains_literal(
    raw: io.BufferedReader, literals: tuple[bytes, ...]
) -> bool:
    """True when the stream holds any of *literals*, reading bounded chunks.

    Reads overlap by the longest literal minus one byte, so a needle straddling
    a chunk boundary is still found. Streaming keeps the memory profile the
    line scan already promised: a multi-megabyte file costs a chunk, not all
    of it.
    """
    overlap = max(len(literal) for literal in literals) - 1
    tail = b""
    while True:
        block = raw.read(_LITERAL_SCAN_CHUNK)
        if not block:
            return False
        window = tail + block
        if any(literal in window for literal in literals):
            return True
        tail = window[-overlap:] if overlap else b""


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
        _compile_pattern(v)
        return v


async def _grep_files(
    pattern: str,
    directory: str = ".",
    include: str = "*",
    max_results: int = 100,
) -> str:
    """Search file contents by regex within the workspace."""
    denied_paths = get_denied_paths()
    resolved = denied_paths.validate_path(directory)
    if not resolved.exists():
        raise FileNotFoundError(
            f"File or directory not found: {denied_paths.display_path(resolved)}"
        )

    compiled = _compile_pattern(pattern)
    literals = _required_literals(pattern)

    def _scan_file(fpath: Path, hits: list[str]) -> bool:
        """Append matches from *fpath*; return True once ``max_results`` is hit.

        Lines are streamed rather than read whole: a multi-megabyte file costs
        one line of memory instead of all of it, and a decode error partway
        through keeps the matches already found above it.
        """
        display_path = denied_paths.display_path(fpath)
        try:
            with fpath.open("rb") as raw:
                # A NUL in the first block is the standard binary heuristic —
                # the same one grep and ripgrep use. Cheaper and far more
                # reliable than waiting for a decode error, which fires on an
                # arbitrary buffer boundary and would otherwise hide an entire
                # text file because of one stray byte.
                if b"\x00" in raw.read(_BINARY_SNIFF_BYTES):
                    return False
                if literals:
                    raw.seek(0)
                    if not _stream_contains_literal(raw, literals):
                        return False
                raw.seek(0)
                stream = io.TextIOWrapper(raw, encoding="utf-8", errors="replace")
                for lineno, line in enumerate(stream, start=1):
                    if compiled.search(line):
                        hits.append(f"{display_path}:{lineno}: {line.rstrip()[:200]}")
                        if len(hits) >= max_results:
                            return True
        except OSError:
            return False
        return False

    if resolved.is_file():

        def _scan_single_file() -> list[str]:
            hits: list[str] = []
            _scan_file(resolved, hits)
            return hits

        matches = await asyncio.to_thread(_scan_single_file)
        if not matches:
            return f"No matches for pattern '{pattern}' in {denied_paths.display_path(resolved)} (include={include})"
        return "\n".join(matches)

    gitignore_rules = load_gitignore_rules(resolved)

    def _scan() -> list[str]:
        hits: list[str] = []
        for root, dirs, files in os.walk(resolved):
            current = Path(root)
            # Dot-prefixed entries are searched: `.github/workflows`,
            # `.openagentd/skills` and `.eslintrc.json` are things users ask
            # about. Only generated trees (`.git`, caches, dependencies) are
            # pruned outright; `.gitignore` decides the rest.
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
            for fname in files:
                if not fnmatch.fnmatch(fname, include):
                    continue
                fpath = current / fname
                rel = fpath.relative_to(resolved).as_posix()
                if is_gitignored(rel, is_dir=False, rules=gitignore_rules):
                    continue
                # Secrets stay secret: with dotfiles in scope, the sandbox
                # denylist is the only thing standing between `**/.env` and the
                # model's context.
                if denied_paths.is_denied_path(fpath):
                    continue
                if _scan_file(fpath, hits):
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
        return f"No matches for pattern '{pattern}' in {denied_paths.display_path(resolved)} (include={include})"
    return "\n".join(matches)


grep_files = Tool(
    _grep_files,
    name="grep",
    description=_DESCRIPTION,
    args_schema=GrepArgs,
)
