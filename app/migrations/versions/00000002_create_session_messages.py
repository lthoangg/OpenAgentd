"""create session_messages table

Revision ID: 00000002
Revises: 00000001
Create Date: 2026-04-27

Domain: SessionMessage.  Captures the table in its final shape with
``extra`` as a JSON blob and ``exclude_from_context`` (formerly
``is_hidden``) for summarized turns.  Composite indexes cover the hot
read paths used by ``get_messages`` and ``get_messages_for_llm``.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

from app.models.chat import TZDateTime

# revision identifiers, used by Alembic.
revision: str = "00000002"
down_revision: Union[str, Sequence[str], None] = "00000001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create session_messages table."""
    op.create_table(
        "session_messages",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("session_id", sa.Uuid(), nullable=False),
        sa.Column("role", sa.String(length=50), nullable=False),
        sa.Column("content", sa.String(), nullable=True),
        sa.Column("reasoning_content", sa.String(), nullable=True),
        sa.Column("tool_calls", sa.JSON(), nullable=True),
        sa.Column("tool_call_id", sa.String(length=100), nullable=True),
        sa.Column("name", sa.String(length=100), nullable=True),
        sa.Column("extra", sa.JSON(), nullable=True),
        sa.Column(
            "is_summary",
            sa.Boolean(),
            server_default=sa.text("0"),
            nullable=False,
        ),
        sa.Column(
            "exclude_from_context",
            sa.Boolean(),
            server_default=sa.text("0"),
            nullable=False,
        ),
        sa.Column("created_at", TZDateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["session_id"], ["chat_sessions.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("session_messages", schema=None) as batch_op:
        # Single-column index for session_id lookups.
        batch_op.create_index(
            batch_op.f("ix_session_messages_session_id"),
            ["session_id"],
            unique=False,
        )
        # Composite index for ORDER BY created_at queries (get_messages,
        # get_messages_for_llm).
        batch_op.create_index(
            "ix_session_messages_session_created",
            ["session_id", "created_at"],
            unique=False,
        )
        # Composite index for is_summary lookup (get_messages_for_llm
        # summary query).
        batch_op.create_index(
            "ix_session_messages_session_summary",
            ["session_id", "is_summary"],
            unique=False,
        )


def downgrade() -> None:
    """Drop session_messages table."""
    with op.batch_alter_table("session_messages", schema=None) as batch_op:
        batch_op.drop_index("ix_session_messages_session_summary")
        batch_op.drop_index("ix_session_messages_session_created")
        batch_op.drop_index(batch_op.f("ix_session_messages_session_id"))
    op.drop_table("session_messages")
