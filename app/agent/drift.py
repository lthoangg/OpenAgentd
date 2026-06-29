"""Per-agent config-file mtime stamping and drift detection.

Lives in its own leaf module so that both ``app.agent.loader`` (which builds
agents and stamps their files) and ``app.agent.mode.team.member`` (which
checks for drift each turn) can import it directly without a cycle.

A ``ConfigStamp`` is a dict of ``{absolute_path: mtime_ns | None}``.
``None`` means *tracked but absent*; the file appearing later still counts
as drift.  Calls to :func:`_stamp_path` swallow :class:`FileNotFoundError`
and log other :class:`OSError`s, so drift detection never fails the turn.
"""

from __future__ import annotations

from pathlib import Path

from loguru import logger

# {path: mtime_ns}.  ``None`` = tracked but absent; the file appearing later
# still counts as drift.
ConfigStamp = dict[str, int | None]


def _stamp_path(path: Path) -> int | None:
    try:
        return path.stat().st_mtime_ns
    except FileNotFoundError:
        return None
    except OSError as exc:
        logger.warning("config_stamp_stat_failed path={} error={}", path, exc)
        return None


def stamp_agent_files(
    agent_md_path: Path,
    mcp_config_path: Path,
) -> ConfigStamp:
    """Snapshot mtimes for the files an agent depends on."""
    return {
        str(agent_md_path): _stamp_path(agent_md_path),
        str(mcp_config_path): _stamp_path(mcp_config_path),
    }


def detect_drift(stamp: ConfigStamp) -> list[str]:
    """Return paths whose mtime changed since the stamp (empty = clean)."""
    return [
        path_str
        for path_str, recorded in stamp.items()
        if _stamp_path(Path(path_str)) != recorded
    ]
