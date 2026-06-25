"""Code-health analysis toolkit.

Dependency-free (stdlib-only) analyzers for ranking "god files", mapping
intra-project import dependencies, and detecting circular imports across the
Python backend (``app/``) and the TypeScript/React frontend (``web/src``).

Run via ``uv run python -m scripts.codehealth --help``.
"""

from __future__ import annotations

__all__ = ["FileReport", "RANK_VERSION"]

# Bump when the scoring formula changes so saved baselines can be invalidated.
RANK_VERSION = 1

from scripts.codehealth.model import FileReport  # noqa: E402
