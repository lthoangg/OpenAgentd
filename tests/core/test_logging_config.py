"""Tests for app/core/logging_config.py."""

import logging
from pathlib import Path
from unittest.mock import patch, MagicMock

from app.core.logging_config import setup_logging, LOGS_DIR


def test_logs_dir_is_path():
    assert isinstance(LOGS_DIR, Path)


def test_setup_logging_creates_logs_dir(tmp_path):
    with (
        patch("app.core.logging_config.LOGS_DIR", tmp_path),
        patch("app.core.logging_config.logger") as mock_logger,
    ):
        mock_logger.remove = MagicMock()
        mock_logger.add = MagicMock()

        setup_logging("INFO")

        assert tmp_path.exists()
        mock_logger.remove.assert_called_once()
        assert mock_logger.add.call_count == 3  # stderr + app.log + app-error.log


def test_setup_logging_uses_level(tmp_path):
    calls = []
    with (
        patch("app.core.logging_config.LOGS_DIR", tmp_path),
        patch("app.core.logging_config.logger") as mock_logger,
    ):
        mock_logger.remove = MagicMock()

        def capture_add(*args, **kwargs):
            calls.append(kwargs)

        mock_logger.add = capture_add
        setup_logging("DEBUG")

    # First sink is stderr — level should be "DEBUG"
    assert calls[0]["level"] == "DEBUG"


def test_setup_logging_silences_noisy_loggers(tmp_path):
    with (
        patch("app.core.logging_config.LOGS_DIR", tmp_path),
        patch("app.core.logging_config.logger") as mock_logger,
    ):
        mock_logger.remove = MagicMock()
        mock_logger.add = MagicMock()
        setup_logging()

    for name in ("httpx", "httpcore", "httpx2", "httpcore2", "uvicorn.access"):
        assert logging.getLogger(name).level == logging.WARNING


def test_setup_logging_disables_oauth_traceback_logger(tmp_path):
    with (
        patch("app.core.logging_config.LOGS_DIR", tmp_path),
        patch("app.core.logging_config.logger") as mock_logger,
    ):
        mock_logger.remove = MagicMock()
        mock_logger.add = MagicMock()
        setup_logging()

    oauth_logger = logging.getLogger("mcp.client.auth.oauth2")
    assert oauth_logger.propagate is False
    assert len(oauth_logger.handlers) == 1
    assert isinstance(oauth_logger.handlers[0], logging.NullHandler)


def test_setup_logging_default_level_is_info(tmp_path):
    calls = []
    with (
        patch("app.core.logging_config.LOGS_DIR", tmp_path),
        patch("app.core.logging_config.logger") as mock_logger,
    ):
        mock_logger.remove = MagicMock()

        def capture_add(*args, **kwargs):
            calls.append(kwargs)

        mock_logger.add = capture_add
        setup_logging()  # default

    assert calls[0]["level"] == "INFO"


# ---------------------------------------------------------------------------
# File-sink level is configurable independently of the console
#
# app.log was hardcoded to DEBUG, so LOG_LEVEL only ever affected stderr and
# there was no way to reduce on-disk volume without a code change (DEBUG was
# ~55% of 83k lines / 2 days in production).  The default stays DEBUG so
# postmortem detail is unchanged unless an operator opts out.
# ---------------------------------------------------------------------------


def _capture_sink_kwargs(tmp_path, *args, **kwargs) -> list[dict]:
    calls: list[dict] = []
    with (
        patch("app.core.logging_config.LOGS_DIR", tmp_path),
        patch("app.core.logging_config.logger") as mock_logger,
    ):
        mock_logger.remove = MagicMock()
        mock_logger.add = lambda *a, **kw: calls.append(kw)
        setup_logging(*args, **kwargs)
    return calls


def test_file_sink_level_defaults_to_debug(tmp_path):
    """Unchanged default: app.log still captures DEBUG for postmortems."""
    calls = _capture_sink_kwargs(tmp_path, "INFO")
    assert calls[1]["level"] == "DEBUG"


def test_file_sink_level_is_configurable(tmp_path):
    """An operator can turn app.log down without touching console output."""
    calls = _capture_sink_kwargs(tmp_path, "INFO", file_log_level="WARNING")
    assert calls[0]["level"] == "INFO"  # console unaffected
    assert calls[1]["level"] == "WARNING"  # app.log turned down


def test_file_sink_level_is_normalised(tmp_path):
    """Lowercase config values are accepted, matching console behaviour."""
    calls = _capture_sink_kwargs(tmp_path, "INFO", file_log_level="warning")
    assert calls[1]["level"] == "WARNING"


def test_error_sink_stays_error_regardless_of_file_level(tmp_path):
    """app-error.log must remain the ERROR+ postmortem sink."""
    calls = _capture_sink_kwargs(tmp_path, "INFO", file_log_level="WARNING")
    assert calls[2]["level"] == "ERROR"
