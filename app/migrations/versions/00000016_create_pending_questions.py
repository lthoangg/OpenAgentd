"""create pending questions table for ask_user_question

Revision ID: 00000016
Revises: 00000015
Create Date: 2026-07-22
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

from app.models.chat import TZDateTime

# revision identifiers, used by Alembic.
revision: str = "00000016"
down_revision: Union[str, Sequence[str], None] = "00000015"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "pending_questions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("session_id", sa.Uuid(), nullable=False),
        sa.Column("tool_call_id", sa.String(length=100), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column(
            "status", sa.String(length=20), server_default="pending", nullable=False
        ),
        sa.Column("answers", sa.JSON(), nullable=True),
        sa.Column("created_at", TZDateTime(timezone=True), nullable=False),
        sa.Column("answered_at", TZDateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["session_id"], ["chat_sessions.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("tool_call_id", name="uq_pending_questions_tool_call_id"),
    )
    with op.batch_alter_table("pending_questions", schema=None) as batch_op:
        batch_op.create_index(
            "ix_pending_questions_session_id", ["session_id"], unique=False
        )
        batch_op.create_index("ix_pending_questions_status", ["status"], unique=False)
        # Partial unique index — at most one open question per session.
        batch_op.create_index(
            "uq_pending_questions_open_per_session",
            ["session_id"],
            unique=True,
            sqlite_where=sa.text("status = 'pending'"),
        )


def downgrade() -> None:
    with op.batch_alter_table("pending_questions", schema=None) as batch_op:
        batch_op.drop_index("uq_pending_questions_open_per_session")
        batch_op.drop_index("ix_pending_questions_status")
        batch_op.drop_index("ix_pending_questions_session_id")
    op.drop_table("pending_questions")
