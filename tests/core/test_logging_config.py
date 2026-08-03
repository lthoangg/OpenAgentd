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
