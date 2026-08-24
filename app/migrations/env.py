import re
import logging
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from sqlalchemy import engine_from_config, pool
from sqlmodel import SQLModel

# Import models to populate SQLModel.metadata
from app.core.config import settings
from app.models import ChatSession, SessionMessage  # noqa: F401
from app.models.chat import TZDateTime  # noqa: F401 — used by render_item
from app.scheduler.models import ScheduledTask  # noqa: F401

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)
if config.get_main_option("openagentd.quiet_alembic") == "true":
    logging.getLogger("alembic").setLevel(logging.WARNING)

target_metadata = SQLModel.metadata


# ---------------------------------------------------------------------------
# Alembic intentionally uses synchronous sqlite.
#
# Runtime:
#     sqlite+aiosqlite:///...
#
# Migrations:
#     sqlite:///...
#
# Alembic itself is synchronous, and using sqlite directly here avoids
# asyncio/greenlet/aiosqlite worker-thread interaction during startup.
# ---------------------------------------------------------------------------

database_url = settings.DATABASE_URL.get_secret_value()

if database_url.startswith("sqlite+aiosqlite:"):
    database_url = database_url.replace(
        "sqlite+aiosqlite:",
        "sqlite:",
        1,
    )

config.set_main_option("sqlalchemy.url", database_url)


# ---------------------------------------------------------------------------
# Sequential revision ID generation (00000001, 00000002, ...)
# ---------------------------------------------------------------------------

_SEQ_RE = re.compile(r"^(\d{8})_")
_SEQ_WIDTH = 8


def _next_revision_id() -> str:
    """Scan migrations/versions/ and return the next zero-padded sequence ID."""
    versions_dir = Path(config.get_main_option("script_location") or "") / "versions"

    highest = 0

    if versions_dir.is_dir():
        for file in versions_dir.iterdir():
            match = _SEQ_RE.match(file.name)

            if match:
                highest = max(
                    highest,
                    int(match.group(1)),
                )

    return str(highest + 1).zfill(_SEQ_WIDTH)


def _process_revision_directives(context, revision, directives):
    """Replace the random hex revision ID with a sequential number."""
    for directive in directives:
        directive.rev_id = _next_revision_id()


def _render_item(type_, obj, autogen_context):
    """Render custom column types so migrations use standard sa.* imports."""
    if type_ != "type":
        return False

    if isinstance(obj, TZDateTime):
        autogen_context.imports.add("from app.models.chat import TZDateTime")
        return "TZDateTime(timezone=True)"

    # SQLModel uses AutoString internally — normalise to sa.String()
    from sqlmodel.sql.sqltypes import AutoString

    if isinstance(obj, AutoString):
        if obj.length:
            return f"sa.String(length={obj.length})"

        return "sa.String()"

    return False


def run_migrations_offline() -> None:
    """Run migrations in offline mode."""
    url = config.get_main_option("sqlalchemy.url")

    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=True,
        process_revision_directives=_process_revision_directives,
        render_item=_render_item,
    )

    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        render_as_batch=True,
        process_revision_directives=_process_revision_directives,
        render_item=_render_item,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in online mode."""
    connectable = engine_from_config(
        config.get_section(
            config.config_ini_section,
            {},
        ),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    try:
        with connectable.connect() as connection:
            do_run_migrations(connection)
    finally:
        connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
