"""read-path cursor indexes

Turn-completion reconciliation uses ``id`` as a creation cursor. ``seq`` is
the logical display order and cannot serve as a global team watermark because
each member has its own sequence space; newly anchored summaries may also
have a ``seq`` below the previous watermark. The uuid7 primary key is globally
creation-ordered, while this composite index makes the per-session delta a
bounded range scan.

Session-list pagination also adds uuid7 ``id`` as the timestamp tie-break to
both top-level composite indexes, preventing equal-created_at rows from being
skipped between pages.

Revision ID: 00000020
Revises: 00000019
Create Date: 2026-08-20
"""

from collections.abc import Sequence

from alembic import op

revision: str = "00000020"
down_revision: str | None = "00000019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index(
        "ix_session_messages_session_id",
        "session_messages",
        ["session_id", "id"],
        unique=False,
    )
    op.drop_index("ix_chat_sessions_top_mode_created", table_name="chat_sessions")
    op.drop_index(
        "ix_chat_sessions_top_mode_workspace_created", table_name="chat_sessions"
    )
    op.drop_index("ix_chat_sessions_parent_created", table_name="chat_sessions")
    op.create_index(
        "ix_chat_sessions_top_mode_created",
        "chat_sessions",
        ["parent_session_id", "mode", "created_at", "id"],
        unique=False,
    )
    op.create_index(
        "ix_chat_sessions_top_mode_workspace_created",
        "chat_sessions",
        ["parent_session_id", "mode", "workspace", "created_at", "id"],
        unique=False,
    )
    op.create_index(
        "ix_chat_sessions_parent_created",
        "chat_sessions",
        ["parent_session_id", "created_at", "id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_chat_sessions_parent_created", table_name="chat_sessions")
    op.drop_index(
        "ix_chat_sessions_top_mode_workspace_created", table_name="chat_sessions"
    )
    op.drop_index("ix_chat_sessions_top_mode_created", table_name="chat_sessions")
    op.create_index(
        "ix_chat_sessions_top_mode_workspace_created",
        "chat_sessions",
        ["parent_session_id", "mode", "workspace", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_chat_sessions_top_mode_created",
        "chat_sessions",
        ["parent_session_id", "mode", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_chat_sessions_parent_created",
        "chat_sessions",
        ["parent_session_id", "created_at"],
        unique=False,
    )
    op.drop_index("ix_session_messages_session_id", table_name="session_messages")
