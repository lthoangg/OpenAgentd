import os
import tempfile
from pathlib import Path

# Isolate XDG directories per pytest-xdist worker to prevent concurrent write/lock conflicts.
# pytest-xdist sets the PYTEST_XDIST_WORKER env var in worker processes (e.g., 'gw0', 'gw1').
if worker_id := os.environ.get("PYTEST_XDIST_WORKER"):
    for var in [
        "OPENAGENTD_DATA_DIR",
        "OPENAGENTD_CONFIG_DIR",
        "OPENAGENTD_STATE_DIR",
        "OPENAGENTD_CACHE_DIR",
    ]:
        if val := os.environ.get(var):
            os.environ[var] = f"{val}_{worker_id}"

import pytest
import pytest_asyncio
from sqlmodel import SQLModel
from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from sqlmodel.ext.asyncio.session import AsyncSession

from app.agent.providers.zai.zai import ZAIProvider

# Me on-disk SQLite file in a tempdir for the test session.  ``:memory:``
# databases are per-connection, so any code that opens a fresh connection
# (e.g. async_sessionmaker auto-opening one) sees an empty database with no
# schema.  A file-backed test DB sidesteps that entirely — every connection
# opens the same DB, schema persists for the whole session, and ``clean_db``
# can DELETE between tests without recreating tables.
_test_db_tmpdir: tempfile.TemporaryDirectory | None = None
_TEST_DB_URL: str = ""

# Me keep engine ref so cleanup fixture can access it
_test_engine = None


# ---------------------------------------------------------------------------
# Test fixture config files — .tests/ is gitignored, so the fixture below is
# materialised on-demand the first time the test session runs. pytest.ini pins
# the four XDG dirs to .tests/{data,config,state,cache}.
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session", autouse=True)
def _materialise_openagentd_config(tmp_path_factory):
    """Ensure the test config directory exists."""
    from app.core.config import settings

    # settings already resolved — CONFIG_DIR = .tests/config.
    config_dir = Path(settings.OPENAGENTD_CONFIG_DIR)
    config_dir.mkdir(parents=True, exist_ok=True)

    yield


@pytest.fixture(autouse=True)
def _restore_os_environ():
    """Snapshot ``os.environ`` and restore it after every test.

    Some production code paths intentionally mutate the live process
    environment — e.g. ``PUT /api/settings/providers/{id}`` mirrors saved
    credentials into ``os.environ`` so ``build_provider`` sees them without a
    restart. Tests that exercise those routes would otherwise leak vars like
    ``SAMPLE_KEY`` into later tests, breaking order-independent runs (surfaced
    by ``pytest-randomly``). Restoring the snapshot keeps every test hermetic.
    """
    import os

    snapshot = dict(os.environ)
    yield
    if os.environ != snapshot:
        os.environ.clear()
        os.environ.update(snapshot)


@pytest.fixture(autouse=True)
def _disable_desktop_token_auth(monkeypatch: pytest.MonkeyPatch):
    """Keep API tests independent from a desktop launcher token in the shell."""
    monkeypatch.delenv("OPENAGENTD_DESKTOP_TOKEN", raising=False)


def set_openagentd_dirs(monkeypatch: pytest.MonkeyPatch, root: Path) -> None:
    """Point all four XDG dirs at subdirectories of ``root``.

    Shared by tests that need isolated XDG roots.
    Creates ``{root}/{data,config,state,cache}`` lazily by setting env vars;
    the directories themselves are created by whatever code writes into them.
    """
    monkeypatch.setenv("OPENAGENTD_DATA_DIR", str(root / "data"))
    monkeypatch.setenv("OPENAGENTD_CONFIG_DIR", str(root / "config"))
    monkeypatch.setenv("OPENAGENTD_STATE_DIR", str(root / "state"))
    monkeypatch.setenv("OPENAGENTD_CACHE_DIR", str(root / "cache"))


@pytest.fixture
def api_key():
    return "test_key"


@pytest.fixture
def zai_provider(api_key):
    return ZAIProvider(api_key=api_key, model="m")


@pytest_asyncio.fixture(scope="session", autouse=True)
async def setup_db():
    """Create schema once per session in a file-backed SQLite DB and redirect
    ``app.core.db`` to it."""
    global _test_engine, _test_db_tmpdir, _TEST_DB_URL
    import app.core.db as _db_module

    _test_db_tmpdir = tempfile.TemporaryDirectory(prefix="openagentd-test-db-")
    db_path = Path(_test_db_tmpdir.name) / "test.sqlite"
    _TEST_DB_URL = f"sqlite+aiosqlite:///{db_path}"

    engine = create_async_engine(
        _TEST_DB_URL,
        connect_args={"check_same_thread": False},
    )

    # Mirror production SQLite pragmas (see app/core/db.py) plus a busy_timeout
    # so the brief concurrency window during team teardown — background member
    # tasks still flushing when clean_db runs — waits for the lock instead of
    # raising "database is locked". Without this the test engine uses the
    # default rollback journal and fails intermittently under randomized order.
    @event.listens_for(engine.sync_engine, "connect")
    def _set_test_sqlite_pragmas(dbapi_conn, connection_record):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA busy_timeout=5000")
        cursor.close()

    _test_engine = engine
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.drop_all)
        await conn.run_sync(SQLModel.metadata.create_all)

    # Redirect the shared app engine / session factory to the test DB.
    _orig_engine = _db_module.engine
    _orig_factory = _db_module.async_session_factory
    _db_module.engine = engine
    _db_module.async_session_factory = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False
    )

    yield

    _db_module.engine = _orig_engine
    _db_module.async_session_factory = _orig_factory
    await engine.dispose()
    _test_engine = None
    _test_db_tmpdir.cleanup()
    _test_db_tmpdir = None


@pytest_asyncio.fixture(autouse=True)
async def clean_db(setup_db):
    """Me wipe all rows between tests — keep schema, clear data."""
    yield
    if _test_engine is None:
        return
    async with _test_engine.begin() as conn:
        # Me order matters: messages first (FK child), then sessions (FK parent)
        for table in reversed(SQLModel.metadata.sorted_tables):
            try:
                await conn.execute(text(f"DELETE FROM {table.name}"))
            except Exception:
                # Table might not exist in test database
                pass
