"""Python source analyzer built on the stdlib ``ast`` module.

Computes per-file metrics and resolves ``import`` / ``from ... import``
statements to repo-relative module keys so the dependency graph only contains
intra-project edges (third-party + stdlib imports are dropped).
"""

from __future__ import annotations

import ast
from pathlib import Path

from scripts.codehealth.model import FileReport

# Branch-introducing nodes for a McCabe-style cyclomatic complexity count.
_BRANCH_NODES = (
    ast.If,
    ast.For,
    ast.AsyncFor,
    ast.While,
    ast.ExceptHandler,
    ast.With,
    ast.AsyncWith,
    ast.Assert,
    ast.comprehension,
    ast.BoolOp,
    ast.IfExp,
    ast.Match,
)


def _count_loc(source: str) -> tuple[int, int]:
    """Return ``(loc, raw_lines)`` — code lines vs total physical lines."""
    raw = source.splitlines()
    loc = 0
    in_docstring = False
    for line in raw:
        stripped = line.strip()
        if not stripped:
            continue
        # Cheap full-line comment filter (block strings handled approximately).
        if stripped.startswith("#"):
            continue
        triple = stripped.count('"""') + stripped.count("'''")
        if in_docstring:
            if triple:
                in_docstring = False
            continue
        if triple == 1:
            in_docstring = True
            continue
        loc += 1
    return loc, len(raw)


def _complexity(node: ast.AST) -> int:
    """McCabe cyclomatic complexity for a single function node (base 1)."""
    score = 1
    for child in ast.walk(node):
        if isinstance(child, ast.BoolOp):
            # Each extra boolean operand adds a branch.
            score += max(0, len(child.values) - 1)
        elif isinstance(child, ast.Match):
            score += max(0, len(child.cases))
        elif isinstance(child, _BRANCH_NODES):
            score += 1
    return score


def _function_loc(node: ast.AST) -> int:
    end = getattr(node, "end_lineno", None)
    start = getattr(node, "lineno", None)
    if end is None or start is None:
        return 0
    return end - start + 1


def _module_key_for_path(path: Path, roots: list[Path]) -> str | None:
    """Map a file path to a dotted/relative module key used in the graph.

    Python files become dotted ``app.x.y`` keys (matching import statements).
    """
    for root in roots:
        try:
            rel = path.relative_to(root)
        except ValueError:
            continue
        parts = list(rel.with_suffix("").parts)
        if parts and parts[-1] == "__init__":
            parts.pop()
        return (
            ".".join([root.name, *parts]) if root.name not in ("",) else ".".join(parts)
        )
    return None


def _resolve_relative(
    module: str | None, level: int, current_pkg: list[str]
) -> str | None:
    """Resolve a ``from . import x`` relative import to an absolute module key."""
    if level == 0:
        return module
    base = (
        current_pkg[: len(current_pkg) - (level - 1)]
        if level - 1 <= len(current_pkg)
        else []
    )
    if module:
        return ".".join([*base, module])
    return ".".join(base) if base else None


def analyze_python_file(
    path: Path,
    repo_root: Path,
    package_prefixes: tuple[str, ...] = ("app",),
) -> FileReport:
    """Analyze one ``.py`` file into a :class:`FileReport`."""
    source = path.read_text(encoding="utf-8", errors="replace")
    rel = path.relative_to(repo_root).as_posix()
    report = FileReport(path=rel, language="python")
    report.loc, report.raw_lines = _count_loc(source)

    try:
        tree = ast.parse(source, filename=str(path))
    except SyntaxError:
        # Still record LOC; skip structural metrics on parse failure.
        return report

    # Package path of the current module, e.g. app.agent.
    current_pkg = path.relative_to(repo_root).with_suffix("").parts
    current_pkg = (
        list(current_pkg[:-1]) if current_pkg[-1] == "__init__" else list(current_pkg)
    )

    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            report.num_classes += 1
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            report.num_functions += 1
            cx = _complexity(node)
            report.total_complexity += cx
            report.max_complexity = max(report.max_complexity, cx)
            report.max_function_loc = max(report.max_function_loc, _function_loc(node))
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.startswith(package_prefixes):
                    report.imports.add(alias.name)
        elif isinstance(node, ast.ImportFrom):
            resolved = _resolve_relative(node.module, node.level, current_pkg)
            if resolved and resolved.startswith(package_prefixes):
                report.imports.add(resolved)

    return report


def collect_python_files(roots: list[Path]) -> list[Path]:
    files: list[Path] = []
    for root in roots:
        if not root.exists():
            continue
        for p in root.rglob("*.py"):
            if "__pycache__" in p.parts or ".venv" in p.parts:
                continue
            files.append(p)
    return files
