"""TypeScript / TSX analyzer (regex-based, dependency-free).

There is no stdlib TS parser, so this uses conservative line + regex
heuristics. It is intentionally approximate: the goal is *ranking* god files
and mapping intra-project imports, not perfect AST fidelity.

Import resolution handles:
  * relative imports (``./x``, ``../y``)
  * the ``@/`` alias → ``web/src/`` (common Vite/tsconfig convention)
Everything else (bare ``react``, ``zustand``, ...) is treated as external and
dropped from the graph.
"""

from __future__ import annotations

import re
from pathlib import Path

from scripts.codehealth.model import FileReport

_IMPORT_RE = re.compile(
    r"""(?:import|export)\s(?!type\s)
        (?:[^'"]*?\sfrom\s)?      # optional binding list + 'from'
        ['"](?P<spec>[^'"]+)['"]""",
    re.VERBOSE,
)
_HOOK_RE = re.compile(r"\buse[A-Z]\w*\s*\(")
_FUNC_RE = re.compile(
    r"(?:function\s+\w+\s*\()"
    r"|(?:const\s+\w+\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>)"
    r"|(?:const\s+\w+\s*=\s*(?:async\s*)?\w+\s*=>)"
)
_CLASS_RE = re.compile(r"\bclass\s+\w+")

_RESOLVE_EXTS = (".ts", ".tsx", ".js", ".jsx")


def _count_loc(source: str) -> tuple[int, int]:
    raw = source.splitlines()
    loc = 0
    in_block = False
    for line in raw:
        s = line.strip()
        if not s:
            continue
        if in_block:
            if "*/" in s:
                in_block = False
                tail = s.split("*/", 1)[1].strip()
                if tail and not tail.startswith("//"):
                    loc += 1
            continue
        if s.startswith("//"):
            continue
        if s.startswith("/*"):
            if "*/" not in s:
                in_block = True
            continue
        loc += 1
    return loc, len(raw)


def _resolve_import(spec: str, current: Path, src_root: Path) -> Path | None:
    """Resolve a relative or ``@/`` aliased import to a concrete file path."""
    if spec.startswith("@/"):
        base = src_root / spec[2:]
    elif spec.startswith("."):
        base = (current.parent / spec).resolve()
    else:
        return None  # external package

    candidates: list[Path] = []
    if base.suffix in _RESOLVE_EXTS:
        candidates.append(base)
    else:
        for ext in _RESOLVE_EXTS:
            candidates.append(base.with_suffix(ext))
        for ext in _RESOLVE_EXTS:
            candidates.append(base / f"index{ext}")
    for cand in candidates:
        if cand.exists():
            return cand
    return None


def analyze_ts_file(path: Path, repo_root: Path, src_root: Path) -> FileReport:
    source = path.read_text(encoding="utf-8", errors="replace")
    rel = path.relative_to(repo_root).as_posix()
    report = FileReport(path=rel, language="typescript")
    report.loc, report.raw_lines = _count_loc(source)
    report.num_hooks = len(_HOOK_RE.findall(source))
    report.num_functions = len(_FUNC_RE.findall(source))
    report.num_classes = len(_CLASS_RE.findall(source))

    # Only import-time edges count toward coupling and cycles: ``import type``
    # is erased at compile time and a dynamic ``import()`` is deferred (it is
    # how a cycle is *broken*, and how the bundle is code-split).
    specs: list[str] = [m.group("spec") for m in _IMPORT_RE.finditer(source)]
    for spec in specs:
        resolved = _resolve_import(spec, path, src_root)
        if resolved is not None:
            try:
                report.imports.add(resolved.relative_to(repo_root).as_posix())
            except ValueError:
                continue
    return report


def collect_ts_files(src_root: Path) -> list[Path]:
    files: list[Path] = []
    if not src_root.exists():
        return files
    for p in src_root.rglob("*"):
        if p.suffix not in (".ts", ".tsx"):
            continue
        parts = set(p.parts)
        if "node_modules" in parts or "dist" in parts:
            continue
        if "__tests__" in parts or p.name.endswith((".test.ts", ".test.tsx", ".d.ts")):
            continue
        files.append(p)
    return files
