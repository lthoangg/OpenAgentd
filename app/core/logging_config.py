"""Logging configuration — thin setup around loguru.

Sinks
-----
- **stderr** — human-readable, colourised, respects ``log_level``
- ``{STATE_DIR}/logs/app/app.log`` — JSON, DEBUG+, rotated at 10 MB, 7-day retention
- ``{STATE_DIR}/logs/app/app-error.log`` — JSON, ERROR+, rotated at 10 MB, 14-day retention

Per-session sinks are created on demand via :func:`add_session_sink` and write
to ``{STATE_DIR}/logs/sessions/{session_id}/session.log`` (human-readable, DEBUG+).

All log paths are under ``LOGS_DIR`` which is ``{OPENAGENTD_STATE_DIR}/logs``.
Configurable via the ``OPENAGENTD_STATE_DIR`` env var.

Usage::

    from loguru import logger

    logger.info("server_start host={} port={}", "0.0.0.0", 4082)

Per-session filtering::

    from app.core.logging_config import add_session_sink, remove_session_sink

    sink_id = add_session_sink(session_id)   # starts capturing
    remove_session_sink(sink_id)             # stops capturing
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import TYPE_CHECKING

from loguru import logger

if TYPE_CHECKING:
    from loguru import Record

from app.core.config import settings

# Logs live under STATE_DIR per XDG convention — safe to prune, not backed up
LOGS_DIR = Path(settings.OPENAGENTD_STATE_DIR) / "logs"
APP_LOG_DIR = LOGS_DIR / "app"
SESSION_LOG_DIR = LOGS_DIR / "sessions"

# Track per-session sink IDs for cleanup
_session_sinks: dict[str, int] = {}  # session_id → loguru sink id


def setup_logging(log_level: str = "INFO") -> None:
    """Configure loguru sinks.  Call once at application startup."""
    APP_LOG_DIR.mkdir(parents=True, exist_ok=True)

    # Remove loguru's default stderr handler
    logger.remove()

    # Console: human-readable, colourised, respects log_level
    logger.add(
        sys.stderr,
        level=log_level.upper(),
        format=(
            "<green>{time:HH:mm:ss.SSS}</green> | "
            "<level>{level:<8}</level> | "
            "<cyan>{name}</cyan>:<cyan>{function}</cyan>:<cyan>{line}</cyan> | "
            "{message}"
        ),
        colorize=True,
    )

    # app.log: JSON, all levels, rotated
    logger.add(
        APP_LOG_DIR / "app.log",
        level="DEBUG",
        serialize=True,
        rotation="10 MB",
        retention="7 days",
        encoding="utf-8",
    )

    # app-error.log: JSON, errors only, retained longer for postmortems
    logger.add(
        APP_LOG_DIR / "app-error.log",
        level="ERROR",
        serialize=True,
        rotation="10 MB",
        retention="14 days",
        encoding="utf-8",
    )

    # Silence noisy third-party stdlib loggers
    for noisy in ("httpx", "httpcore", "httpx2", "httpcore2", "uvicorn.access"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    # The MCP OAuth client logs full exception tracebacks for expected
    # interactive-auth prompts; keep it from propagating into uvicorn/root logs.
    oauth_logger = logging.getLogger("mcp.client.auth.oauth2")
    oauth_logger.handlers.clear()
    oauth_logger.addHandler(logging.NullHandler())
    oauth_logger.propagate = False


def add_session_sink(session_id: str) -> int:
    """Add a human-readable loguru sink for a specific session.

    Writes to ``{STATE_DIR}/logs/sessions/{session_id}/session.log``.
    Only captures log records whose message contains ``session_id``.
    Returns the loguru sink ID (use with :func:`remove_session_sink`).
    """
    log_dir = SESSION_LOG_DIR / session_id
    log_dir.mkdir(parents=True, exist_ok=True)

    # Me only keep records that mention this session — no cross-session noise
    def _session_filter(record: "Record") -> bool:
        return session_id in record["message"]

    sink_id = logger.add(
        log_dir / "session.log",
        level="DEBUG",
        format=(
            "{time:YYYY-MM-DD HH:mm:ss.SSS} | "
            "{level:<8} | "
            "{name}:{function}:{line} | "
            "{message}"
        ),
        filter=_session_filter,
        rotation="5 MB",
        retention="3 days",
        encoding="utf-8",
    )
    _session_sinks[session_id] = sink_id
    return sink_id


def remove_session_sink(session_id: str) -> None:
    """Remove a previously added per-session sink."""
    sink_id = _session_sinks.pop(session_id, None)
    if sink_id is not None:
        logger.remove(sink_id)
