"""Additional tests for app.core.db — WAL pragmas and run_migrations()."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


# ── WAL pragma listener ───────────────────────────────────────────────────────


def test_sqlite_wal_pragma_is_applied(tmp_path):
    """The WAL pragma listener must set journal_mode=WAL on each new connection.

    WAL mode is not supported for in-memory SQLite databases, so we use a
    temporary file-based database.
    """
    from app.core.db import _set_sqlite_pragmas
    import sqlite3

    db_file = str(tmp_path / "test.db")
    conn = sqlite3.connect(db_file)
    try:
        _set_sqlite_pragmas(conn, None)
        cursor = conn.cursor()
        cursor.execute("PRAGMA journal_mode")
        mode = cursor.fetchone()[0]
        cursor.close()
        assert mode == "wal"
    finally:
        conn.close()


def test_sqlite_wal_sets_synchronous_normal(tmp_path):
    from app.core.db import _set_sqlite_pragmas
    import sqlite3

    db_file = str(tmp_path / "test2.db")
    conn = sqlite3.connect(db_file)
    try:
        _set_sqlite_pragmas(conn, None)
        cursor = conn.cursor()
        cursor.execute("PRAGMA synchronous")
        # 1 = NORMAL (see https://www.sqlite.org/pragma.html#pragma_synchronous)
        value = cursor.fetchone()[0]
        cursor.close()
        assert value == 1
    finally:
        conn.close()


def test_sqlite_pragmas_enable_foreign_keys(tmp_path):
    """Every production SQLite connection enforces declared foreign keys."""
    from app.core.db import _set_sqlite_pragmas
    import sqlite3

    conn = sqlite3.connect(tmp_path / "foreign-keys.db")
    try:
        _set_sqlite_pragmas(conn, None)
        assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    finally:
        conn.close()


# ── run_migrations() ──────────────────────────────────────────────────────────


def test_run_migrations_raises_when_ini_not_found(tmp_path):
    """If alembic.ini is absent, run_migrations raises a clear error.

    Silent skip used to leave users with an empty DB and a confusing 500 on
    the first chat message — the contract is now to fail loudly.
    """
    import app.core.db as db_module

    with patch("app.core.db.Path") as mock_path_cls:
        mock_ini = MagicMock(spec=Path)
        mock_ini.is_file.return_value = False
        # run_migrations does: Path(__file__).resolve().parent.parent / "alembic.ini"
        (
            mock_path_cls.return_value.resolve.return_value.parent.parent.__truediv__.return_value
        ) = mock_ini

        with pytest.raises(RuntimeError, match="alembic.ini not found"):
            db_module.run_migrations()

    mock_ini.is_file.assert_called_once()


def test_run_migrations_upgrade_error_is_reraised(tmp_path):
    """If alembic upgrade raises, run_migrations must re-raise (not swallow)."""
    import app.core.db as db_module

    ini = tmp_path / "alembic.ini"
    ini.write_text("[alembic]\nscript_location = migrations\n")

    # Patch Path.is_file to report ini found, and patch command.upgrade to raise
    with (
        patch("app.core.db.Path") as mock_path_cls,
        patch("alembic.command.upgrade", side_effect=RuntimeError("migrate failed")),
        patch("alembic.config.Config", return_value=MagicMock()),
    ):
        mock_ini = MagicMock(spec=Path)
        mock_ini.is_file.return_value = True
        mock_ini.__str__ = lambda s: str(ini)
        mock_path_cls.return_value.resolve.return_value.parent.parent.__truediv__.return_value = mock_ini

        with pytest.raises(RuntimeError, match="migrate failed"):
            db_module.run_migrations()
