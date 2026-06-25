"""Shared data model for code-health reports.

A single ``FileReport`` describes one source file across both ecosystems.
Language-specific analyzers (``py_analyzer``, ``ts_analyzer``) populate the
fields they can compute; everything downstream (scoring, reporting, cycle
detection) is language-agnostic and consumes ``FileReport`` only.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(slots=True)
class FileReport:
    """Per-file metrics used for god-file ranking and dependency mapping."""

    path: str
    """Repo-relative POSIX path, e.g. ``app/agent/mode/team/team.py``."""

    language: str
    """``python`` or ``typescript``."""

    loc: int = 0
    """Non-blank, non-comment lines of code."""

    raw_lines: int = 0
    """Total physical lines (including blanks/comments)."""

    num_classes: int = 0
    num_functions: int = 0
    """Top-level + nested functions/methods."""

    max_function_loc: int = 0
    """LOC of the single largest function/method — long functions hide here."""

    max_complexity: int = 0
    """Highest cyclomatic complexity of any function in the file."""

    total_complexity: int = 0
    """Sum of cyclomatic complexity over all functions."""

    num_hooks: int = 0
    """Frontend only: count of React hook call sites (useState/useEffect/...)."""

    # --- Dependency graph (intra-project only) ---------------------------
    imports: set[str] = field(default_factory=set)
    """Repo-relative module keys this file imports (resolved, intra-project)."""

    # --- Derived, filled by the scorer -----------------------------------
    fan_out: int = 0
    """Number of intra-project modules this file imports."""

    fan_in: int = 0
    """Number of intra-project modules that import this file."""

    score: float = 0.0
    """Composite god-file score (higher = more urgent to refactor)."""

    reasons: list[str] = field(default_factory=list)
    """Human-readable drivers behind the score (for the report)."""

    def to_dict(self) -> dict:
        return {
            "path": self.path,
            "language": self.language,
            "loc": self.loc,
            "raw_lines": self.raw_lines,
            "num_classes": self.num_classes,
            "num_functions": self.num_functions,
            "max_function_loc": self.max_function_loc,
            "max_complexity": self.max_complexity,
            "total_complexity": self.total_complexity,
            "num_hooks": self.num_hooks,
            "fan_in": self.fan_in,
            "fan_out": self.fan_out,
            "score": round(self.score, 2),
            "reasons": self.reasons,
        }
