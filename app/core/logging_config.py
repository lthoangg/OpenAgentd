"""Logging configuration — thin setup around loguru.

Sinks
-----
- **stderr** — human-readable, colourised, respects ``log_level``
- ``{STATE_DIR}/logs/app/app.log`` — JSON, ``FILE_LOG_LEVEL``+ (default DEBUG),
  rotated at 10 MB, 7-day retention
- ``{STATE_DIR}/logs/app/app-error.log`` — JSON, ERROR+, rotated at 10 MB, 14-day retention

All log paths are under ``LOGS_DIR`` which is ``{OPENAGENTD_STATE_DIR}/logs``.
Configurable via the ``OPENAGENTD_STATE_DIR`` env var.

Usage::

    from loguru import logger

    logger.info("server_start host={} port={}", "0.0.0.0", 4082)
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

from loguru import logger

from app.core.config import settings

# Logs live under STATE_DIR per XDG convention — safe to prune, not backed up
LOGS_DIR = Path(settings.OPENAGENTD_STATE_DIR) / "logs"
APP_LOG_DIR = LOGS_DIR / "app"
SESSION_LOG_DIR = LOGS_DIR / "sessions"


def setup_logging(log_level: str = "INFO", file_log_level: str = "DEBUG") -> None:
    """Configure loguru sinks.  Call once at application startup.

    Args:
        log_level: Threshold for the human-readable stderr sink.
        file_log_level: Threshold for the JSON ``app.log`` sink.  Defaults to
            ``DEBUG`` so postmortem detail is unchanged, but can be raised to
            cut on-disk volume — DEBUG records alone accounted for roughly
            half of all log lines in production.  ``app-error.log`` is always
            ERROR+ regardless, so raising this never costs crash visibility.
    """
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

    # app.log: JSON, rotated.  Level is configurable (default DEBUG).
    logger.add(
        APP_LOG_DIR / "app.log",
        level=file_log_level.upper(),
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
