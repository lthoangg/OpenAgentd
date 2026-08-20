from __future__ import annotations

from collections.abc import AsyncGenerator, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import TYPE_CHECKING

from loguru import logger
from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlmodel.ext.asyncio.session import AsyncSession

from app.core.config import settings

if TYPE_CHECKING:
    from alembic.config import Config

_db_url = settings.DATABASE_URL.get_secret_value()
# ``sqlite+aiosqlite:///<abs-path>`` → strip the scheme. The path is used by
# ``run_migrations`` to take a sibling file lock so concurrent processes do
# not race on ``CREATE TABLE alembic_version``.
_db_path = _db_url.split("///", 1)[-1]

# SQLite cannot create the parent directory itself — without this, a fresh
# install fails on first start with ``sqlite3.OperationalError: unable to open
# database file``. Keep in-memory SQLite unchanged.
if _db_path and _db_path != ":memory:":
    Path(_db_path).expanduser().parent.mkdir(parents=True, exist_ok=True)

# WAL permits concurrent reads while SQLite serialises writes. This pool covers
# ordinary sessions and bursty member activity.
_pool_kwargs = {"pool_size": 5, "max_overflow": 10}

# ``pool_pre_ping`` is deliberately absent: it issues a liveness probe on
# every pool checkout, which guards against dropped *network* connections —
# a failure mode local SQLite file handles don't have. Measured overhead of
# the probe on this engine: ~148µs per checkout (~30% of checkout cost).
engine = create_async_engine(
    _db_url,
    echo=False,
    pool_recycle=3600,
    **_pool_kwargs,
)


# Enable WAL mode — concurrent reads continue while writes are in progress.
@event.listens_for(engine.sync_engine, "connect")
def _set_sqlite_pragmas(dbapi_conn, connection_record):
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA synchronous=NORMAL")
    cursor.execute("PRAGMA foreign_keys=ON")
    # Explicit busy handler — do not rely on the sqlite3 driver's implicit
    # ``timeout=5.0`` connect default. Under bursty team writes a writer
    # waits for the lock instead of failing fast with "database is locked".
    # Mirrors the test engine hook in tests/conftest.py.
    cursor.execute("PRAGMA busy_timeout=5000")
    cursor.close()


async_session_factory = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)

# Type alias for a session factory callable.
# async_sessionmaker[AsyncSession] satisfies this; so do @asynccontextmanager
# helpers used in tests — both are callable async context managers.
DbFactory = async_sessionmaker[AsyncSession]


def resolve_db_factory(factory: DbFactory | None) -> DbFactory:
    """Return *factory* if not ``None``, else the module-level default.

    Centralises the ``factory or async_session_factory`` fallback that
    was repeated across team-member, team, scheduler-tool, and loader
    call sites.  Production code generally passes a factory explicitly;
    tests sometimes pass ``None`` and expect to get the real one.
    """
    return factory if factory is not None else async_session_factory


def run_migrations() -> None:
    """Run pending Alembic migrations (upgrade head).

    Called once during server startup so users never need a separate
    ``openagentd migrate`` step.  ``alembic.ini`` ships inside the ``app``
    package so it is reachable from both source checkouts and installed
    wheels.

    Concurrent invocations on SQLite are serialised with an advisory file
    lock alongside the database file. Without this, two processes (e.g.
    a daemon wrapper and the actual uvicorn worker) can race on
    ``CREATE TABLE alembic_version`` and one ends up logging a noisy
    ``OperationalError: table … already exists`` even though both end up
    in the correct state.
    """
    from alembic.config import Config

    # Locate alembic.ini — packaged inside app/ so wheel installs find it.
    ini_path = Path(__file__).resolve().parent.parent / "alembic.ini"
    if not ini_path.is_file():
        # Treat as a hard error — silently skipping leaves users with an
        # empty DB and a confusing 500 on the first chat message.
        raise RuntimeError(
            f"alembic.ini not found at {ini_path}. "
            "The package is broken — reinstall openagentd."
        )

    cfg = Config(str(ini_path))
    # Override the DB URL so it always matches the runtime settings,
    # regardless of what alembic.ini has hardcoded.
    cfg.set_main_option("sqlalchemy.url", settings.DATABASE_URL.get_secret_value())

    if _db_path and _db_path != ":memory:":
        with _sqlite_migration_lock(Path(_db_path).expanduser()):
            _run_alembic_upgrade(cfg)
        _optimize_sqlite(Path(_db_path).expanduser())
    else:
        _run_alembic_upgrade(cfg)


def _optimize_sqlite(db_path: Path) -> None:
    """Materialise/refresh query-planner statistics (best-effort).

    Without ``ANALYZE`` statistics SQLite plans every join and index choice
    from fixed heuristics. ``PRAGMA optimize=0x10002`` runs a bounded ANALYZE
    over all tables (``analysis_limit`` caps the rows sampled, so this stays
    cheap even on multi-GB databases) and is a no-op when stats are already
    fresh. Runs once per startup, right after migrations; failures are
    swallowed — stale or missing stats degrade plans, not correctness.
    """
    import sqlite3

    try:
        conn = sqlite3.connect(db_path)
        try:
            conn.execute("PRAGMA analysis_limit=1000")
            conn.execute("PRAGMA optimize=0x10002")
            conn.commit()
        finally:
            conn.close()
    except sqlite3.Error as exc:
        logger.debug("sqlite_optimize_skipped error={}", exc)


def _run_alembic_upgrade(cfg: Config) -> None:
    """Invoke ``alembic upgrade head`` and log the outcome.

    SQLite raises ``OperationalError: table alembic_version already exists``
    when two processes race on the very first migration (e.g. a daemon wrapper
    and the uvicorn worker both hit startup before the lock serialises them).
    That race means the schema is already in the correct state, so we treat it
    as a no-op rather than an error.
    """
    from alembic import command
    from sqlalchemy.exc import OperationalError

    try:
        command.upgrade(cfg, "head")
        logger.info("auto_migrate_complete")
    except OperationalError as exc:
        msg = str(exc).lower()
        if "already exists" in msg:
            # Schema was created by a concurrent process — we are at head.
            logger.debug("auto_migrate_skipped reason=already_exists")
        else:
            logger.error("auto_migrate_failed error={}", exc)
            raise
    except Exception as exc:
        logger.error("auto_migrate_failed error={}", exc)
        raise


@contextmanager
def _sqlite_migration_lock(db_path: Path) -> Iterator[None]:
    """Serialise concurrent ``run_migrations`` calls on the same SQLite DB.

    Uses ``fcntl.flock`` (POSIX) on a sibling ``.migrate.lock`` file. The
    lock file lives alongside the DB so it shares the DB's filesystem —
    important because ``flock`` is a no-op across NFS on some platforms.
    On Windows ``fcntl`` is unavailable; we fall back to SQLite's own
    write serialization. The desktop shell's single-instance guard prevents
    the normal bundled-sidecar path from running concurrent migrations.
    """
    try:
        import fcntl
    except ImportError:  # pragma: no cover — Windows
        yield
        return

    lock_path = db_path.parent / f"{db_path.name}.migrate.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, "w") as fh:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async with async_session_factory() as session:
        try:
            yield session
            await session.commit()
        except BaseException:
            await session.rollback()
            raise
