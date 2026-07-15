"""Settings validation tests."""

from __future__ import annotations

import pytest

from app.core.config import Settings


@pytest.mark.parametrize(
    "database_url",
    [
        "postgresql+asyncpg://localhost/openagentd",
        "sqlite:///openagentd.db",
    ],
)
def test_settings_rejects_unsupported_database_url(database_url: str) -> None:
    """Only the async SQLite driver used by the database layer is supported."""
    with pytest.raises(ValueError, match=r"sqlite\+aiosqlite"):
        Settings(DATABASE_URL=database_url)
