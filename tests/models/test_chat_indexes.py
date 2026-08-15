"""Index shape for the chat tables, and migration/model drift.

Index choices here are load-bearing: ``session_messages`` is the highest-write
table in the schema, so every index costs a B-tree insert on every persisted
message.
"""

import os
import subprocess
import sys

from app.models.chat import ChatSession, SessionMessage


def _index_map(model) -> dict[str, tuple[str, ...]]:
    return {
        index.name: tuple(column.name for column in index.columns)
        for index in model.__table__.indexes
    }


def test_chat_session_recent_list_indexes_cover_mode_and_workspace() -> None:
    indexes = _index_map(ChatSession)

    assert indexes["ix_chat_sessions_top_mode_created"] == (
        "parent_session_id",
        "mode",
        "created_at",
    )
    assert indexes["ix_chat_sessions_top_mode_workspace_created"] == (
        "parent_session_id",
        "mode",
        "workspace",
        "created_at",
    )


def test_session_messages_has_a_single_covering_history_index() -> None:
    """One index serves every ``session_messages`` read path.

    Every query filters ``session_id`` then orders by ``created_at, id``
    (``history_messages_stmt``, ``llm_history_messages_stmt``, and the
    team-history window functions), so ``(session_id, created_at, id)``
    satisfies both the filter and the sort — no temp B-tree.

    The two indexes it replaced were dead weight:

    * ``ix_session_messages_session_id`` — a strict prefix of the composite,
      so SQLite never chose it;
    * ``ix_session_messages_session_summary`` — ``is_summary`` queries also
      constrain ``session_id`` and range/order on ``created_at``, so the
      planner preferred the composite and applied ``is_summary`` as a residual
      filter. Checked against a production database: chosen for no query,
      while costing an index write per message.
    """
    assert _index_map(SessionMessage) == {
        "ix_session_messages_session_created_id": ("session_id", "created_at", "id"),
    }


def test_chat_sessions_parent_index_orders_by_created_at() -> None:
    """Sub-session lookups must not re-sort.

    ``get_team_history`` and ``get_team_history_since`` both run
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
    )
    assert "ix_chat_sessions_parent_session_id" not in indexes


def test_member_restore_index_is_comparable_by_autogenerate() -> None:
    """The member-restore index must be a plain column index.

    Declaring it with ``sa.desc("created_at")`` made it an *expression* index,
    which Alembic cannot render or compare on SQLite — it reported a phantom
    drop/add on every ``alembic check`` run, which is what made real drift easy
    to miss. The ``DESC`` bought nothing: SQLite walks an ASC index backwards to
    satisfy ``ORDER BY created_at DESC`` (see
    ``app/agent/mode/team/team.py`` handle resolution).
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
