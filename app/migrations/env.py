import asyncio
import re
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from sqlalchemy import pool
from sqlalchemy.ext.asyncio import async_engine_from_config
from sqlmodel import SQLModel

# Import models to populate SQLModel.metadata
from app.core.config import settings
from app.models import ChatSession, SessionMessage  # noqa: F401
from app.models.chat import TZDateTime  # noqa: F401 — used by render_item
from app.scheduler.models import ScheduledTask  # noqa: F401

# this is the Alembic Config object, which provides
# access to the values within the .ini file in use.
config = context.config

# Interpret the config file for Python logging.
# This line sets up loggers basically.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# add your model's MetaData object here
# for 'autogenerate' support
target_metadata = SQLModel.metadata

# set the sqlalchemy.url dynamically
config.set_main_option("sqlalchemy.url", settings.DATABASE_URL.get_secret_value())

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
        for f in versions_dir.iterdir():
            m = _SEQ_RE.match(f.name)
            if m:
                highest = max(highest, int(m.group(1)))
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

    # Fall back to default rendering
    return False


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode."""
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


def do_run_migrations(connection):
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        render_as_batch=True,
        process_revision_directives=_process_revision_directives,
        render_item=_render_item,
    )

    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    """Run migrations in 'online' mode."""
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)

    await connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
