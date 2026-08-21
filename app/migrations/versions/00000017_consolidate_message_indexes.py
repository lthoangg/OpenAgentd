"""consolidate session_messages indexes and align schema with the models

Three changes, all index-only — no table or column is touched.

1. ``session_messages`` collapses three indexes into one.
   ``(session_id, created_at, id)`` satisfies both the filter and the
   ``ORDER BY created_at, id`` of every read path, so the temp B-tree those
   queries used for the final sort term disappears. The two indexes it
   replaces were verified unused against a production database:
   ``ix_session_messages_session_id`` is a strict prefix of the composite,
   and ``ix_session_messages_session_summary`` lost to the composite on
   every ``is_summary`` query. This is the highest-write table in the
   schema, so each removed index is one fewer B-tree insert per message.

2. ``chat_sessions`` replaces the bare ``parent_session_id`` index with
   ``(parent_session_id, created_at)``. Sub-session lookups order by
   ``created_at`` on every team-history load and were re-sorting; the
   leading column still serves plain lookups and the ``ON DELETE CASCADE``
   child scan.

3. Two drifts between the models and the migration history are closed so
   ``alembic check`` passes: ``ix_chat_sessions_parent_agent_created`` is
   rebuilt as a plain column index (the ``DESC`` expression form was
   invisible to Alembic's SQLite comparison, and SQLite scans an ASC index
   backwards anyway), and ``ix_scheduled_task_enabled`` — created in
   00000003 but never declared on the model — is dropped. It indexed a
   low-cardinality boolean on a table that holds a handful of rows.

Revision ID: 00000017
Revises: 00000016
Create Date: 2026-08-15
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "00000017"
down_revision: Union[str, Sequence[str], None] = "00000016"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _index_names(table: str) -> set[str]:
    inspector = sa.inspect(op.get_bind())
    return {name for idx in inspector.get_indexes(table) if (name := idx["name"])}


def upgrade() -> None:
    existing = _index_names("session_messages")
    op.create_index(
        "ix_session_messages_session_created_id",
        "session_messages",
        ["session_id", "created_at", "id"],
        unique=False,
    )
    for name in (
        "ix_session_messages_session_created",
        "ix_session_messages_session_summary",
        "ix_session_messages_session_id",
    ):
        if name in existing:
            op.drop_index(name, table_name="session_messages")

    existing = _index_names("chat_sessions")
    op.create_index(
        "ix_chat_sessions_parent_created",
        "chat_sessions",
        ["parent_session_id", "created_at"],
        unique=False,
    )
    if "ix_chat_sessions_parent_session_id" in existing:
        op.drop_index("ix_chat_sessions_parent_session_id", table_name="chat_sessions")

    # Rebuild as a plain column index — 00000015 created it with a raw
    # ``created_at DESC`` expression.
    if "ix_chat_sessions_parent_agent_created" in existing:
        op.drop_index(
            "ix_chat_sessions_parent_agent_created", table_name="chat_sessions"
        )
    op.create_index(
        "ix_chat_sessions_parent_agent_created",
        "chat_sessions",
        ["parent_session_id", "agent_name", "created_at"],
        unique=False,
    )

    if "ix_scheduled_task_enabled" in _index_names("scheduled_task"):
        op.drop_index("ix_scheduled_task_enabled", table_name="scheduled_task")


def downgrade() -> None:
    op.create_index(
        "ix_scheduled_task_enabled", "scheduled_task", ["enabled"], unique=False
    )

    op.drop_index("ix_chat_sessions_parent_agent_created", table_name="chat_sessions")
    op.execute(
        "CREATE INDEX ix_chat_sessions_parent_agent_created "
        "ON chat_sessions (parent_session_id, agent_name, created_at DESC)"
    )

    op.create_index(
        "ix_chat_sessions_parent_session_id",
        "chat_sessions",
        ["parent_session_id"],
        unique=False,
    )
    op.drop_index("ix_chat_sessions_parent_created", table_name="chat_sessions")

    op.create_index(
        "ix_session_messages_session_id", "session_messages", ["session_id"]
    )
    op.create_index(
        "ix_session_messages_session_summary",
        "session_messages",
        ["session_id", "is_summary"],
    )
    op.create_index(
        "ix_session_messages_session_created",
        "session_messages",
        ["session_id", "created_at"],
    )
    op.drop_index(
        "ix_session_messages_session_created_id", table_name="session_messages"
    )
