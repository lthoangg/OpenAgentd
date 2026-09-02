"""Index shape for the chat tables, and migration/model drift.

Index choices here are load-bearing: ``session_messages`` is the highest-write
table in the schema, so every index costs a B-tree insert on every persisted
message.
"""

import os
import sqlite3
import subprocess
import sys
import uuid

from app.models.chat import ChatSession, SessionMessage


def _index_map(model) -> dict[str, tuple[str, ...]]:
    return {
        index.name: tuple(column.name for column in index.columns)
        for index in model.__table__.indexes
    }


def test_chat_session_recent_list_indexes_cover_workspace() -> None:
    indexes = _index_map(ChatSession)

    assert indexes["ix_chat_sessions_top_created"] == (
        "parent_session_id",
        "created_at",
        "id",
    )
    assert indexes["ix_chat_sessions_top_workspace_created"] == (
        "parent_session_id",
        "workspace",
        "created_at",
        "id",
    )


def test_session_messages_index_shape() -> None:
    """Logical-order, creation-delta, and active-summary indexes only.

    Every query filters ``session_id`` then orders by ``seq, id``
    (``history_messages_stmt``, ``llm_window_stmt``, and the team-history
    window functions), so ``(session_id, seq, id)`` satisfies both the
    filter and the sort — no temp B-tree. ``kind`` predicates apply as
    residual filters.

    The uuid7 delta lookup has a separate ``(session_id, id)`` index because
    ``seq`` is per-session logical position: it cannot discover newly anchored
    summaries or serve as one global watermark across imported child sessions.

    The other exception is the active-summary lookup (``kind='summary'
    ORDER BY id DESC LIMIT 1``), which the covering index cannot serve
    without walking the whole session: it gets a *partial* index over the
    rare summary rows, costing an index write only when a compaction runs.

    The summary index this replaced was dead weight:

    * ``ix_session_messages_session_summary`` — ``is_summary`` queries also
      constrain ``session_id`` and range/order on ``created_at``, so the
      planner preferred the composite and applied ``is_summary`` as a residual
      filter. Checked against a production database: chosen for no query,
      while costing an index write per message.
    """
    assert _index_map(SessionMessage) == {
        "ix_session_messages_session_seq_id": ("session_id", "seq", "id"),
        "ix_session_messages_session_id": ("session_id", "id"),
        "ix_session_messages_active_summary": ("session_id", "id"),
    }
    partial = next(
        idx
        for idx in SessionMessage.__table__.indexes
        if idx.name == "ix_session_messages_active_summary"
    )
    assert str(partial.dialect_options["sqlite"]["where"]) == "kind = 'summary'"


def test_chat_sessions_parent_index_orders_by_created_at() -> None:
    """Sub-session lookups must not re-sort.

    ``get_agent_history`` and ``get_agent_history_since`` both run
    ``WHERE parent_session_id = ? ORDER BY created_at`` on every team-history
    load. A bare ``parent_session_id`` index forced a temp B-tree; the
    composite serves the ordering directly and still covers plain
    ``parent_session_id`` lookups, including the ``ON DELETE CASCADE`` child
    scan.
    """
    indexes = _index_map(ChatSession)

    assert indexes["ix_chat_sessions_parent_created"] == (
        "parent_session_id",
        "created_at",
        "id",
    )
    assert "ix_chat_sessions_parent_session_id" not in indexes


def test_member_restore_index_is_comparable_by_autogenerate() -> None:
    """The member-restore index must be a plain column index.

    Declaring it with ``sa.desc("created_at")`` made it an *expression* index,
    which Alembic cannot render or compare on SQLite — it reported a phantom
    drop/add on every ``alembic check`` run, which is what made real drift easy
    to miss. The ``DESC`` bought nothing: SQLite walks an ASC index backwards to
    satisfy ``ORDER BY created_at DESC`` (see
    the single-agent session runtime handle resolution).
    """
    index = next(
        idx
        for idx in ChatSession.__table__.indexes
        if idx.name == "ix_chat_sessions_parent_agent_created"
    )

    assert tuple(c.name for c in index.columns) == (
        "parent_session_id",
        "agent_name",
        "created_at",
    )
    assert not list(index.expressions or []) or all(
        hasattr(expr, "name") for expr in index.expressions
    )


def test_coding_only_migration_removes_legacy_rows_and_mode_columns(tmp_path) -> None:
    """The irreversible migration must not retain workspace-less runtime rows."""
    db_path = tmp_path / "coding-only.db"
    env = {**os.environ, "DATABASE_URL": f"sqlite+aiosqlite:///{db_path}"}

    def alembic(*args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-m", "alembic", "-c", "app/alembic.ini", *args],
            env=env,
            capture_output=True,
            text=True,
        )

    assert alembic("upgrade", "00000020").returncode == 0
    legacy_session = uuid.uuid4().hex
    workspace_less_session = uuid.uuid4().hex
    coding_session = uuid.uuid4().hex
    legacy_task = uuid.uuid4().hex
    workspace_less_task = uuid.uuid4().hex
    coding_task = uuid.uuid4().hex
    timestamp = "2026-08-24 00:00:00"
    with sqlite3.connect(db_path) as db:
        db.executemany(
            """
            INSERT INTO chat_sessions
                (id, agent_name, created_at, updated_at, mode, workspace)
            VALUES (?, 'lead', ?, ?, ?, ?)
            """,
            [
                (legacy_session, timestamp, timestamp, "normal", None),
                (workspace_less_session, timestamp, timestamp, "coding", None),
                (coding_session, timestamp, timestamp, "coding", "/workspace"),
            ],
        )
        db.executemany(
            """
            INSERT INTO scheduled_task
                (id, name, slug, workspace, mode, schedule_type, every_seconds,
                 prompt, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'every', 60, 'run', ?, ?)
            """,
            [
                (legacy_task, "legacy", "legacy", None, "normal", timestamp, timestamp),
                (
                    workspace_less_task,
                    "missing",
                    "missing",
                    None,
                    "coding",
                    timestamp,
                    timestamp,
                ),
                (
                    coding_task,
                    "coding",
                    "coding",
                    "/workspace",
                    "coding",
                    timestamp,
                    timestamp,
                ),
            ],
        )

    upgrade = alembic("upgrade", "head")
    assert upgrade.returncode == 0, upgrade.stderr

    with sqlite3.connect(db_path) as db:
        assert db.execute("SELECT id FROM chat_sessions").fetchall() == [
            (coding_session,)
        ]
        assert db.execute("SELECT id FROM scheduled_task").fetchall() == [
            (coding_task,)
        ]
        assert "mode" not in {
            row[1] for row in db.execute("PRAGMA table_info(chat_sessions)")
        }
        assert "mode" not in {
            row[1] for row in db.execute("PRAGMA table_info(scheduled_task)")
        }
        assert next(
            row
            for row in db.execute("PRAGMA table_info(chat_sessions)")
            if row[1] == "workspace"
        )[3]
        assert next(
            row
            for row in db.execute("PRAGMA table_info(scheduled_task)")
            if row[1] == "workspace"
        )[3]


def test_migrations_match_the_models(tmp_path) -> None:
    """``alembic check`` — migrations at head must match SQLModel metadata.

    The suite builds its schema with ``SQLModel.metadata.create_all`` while
    production runs Alembic, so an index added to a model without a migration
    (or vice versa) stays invisible until it reaches a real database. This
    caught two live drifts: ``ix_scheduled_task_enabled`` existed only in
    migrations, and the member-restore index only in the models.
    """
    # Run out-of-process: ``migrations/env.py`` resolves the URL from the
    # ``settings`` singleton and overwrites whatever the Config carries, so the
    # only way to point Alembic at a scratch database is a fresh interpreter
    # with ``DATABASE_URL`` set. This is also exactly how CI invokes it.
    env = {
        **os.environ,
        "DATABASE_URL": f"sqlite+aiosqlite:///{tmp_path / 'head.db'}",
    }

    def alembic(*args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-m", "alembic", "-c", "app/alembic.ini", *args],
            env=env,
            capture_output=True,
            text=True,
        )

    upgrade = alembic("upgrade", "head")
    assert upgrade.returncode == 0, f"alembic upgrade failed:\n{upgrade.stderr}"

    check = alembic("check")
    assert check.returncode == 0, (
        "models and migrations have drifted — run "
        "`make revision MSG=...` or fix the model:\n" + check.stderr
    )
