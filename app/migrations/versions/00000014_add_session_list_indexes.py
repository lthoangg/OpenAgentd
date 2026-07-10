"""add indexes for recent session lists

Revision ID: 00000014
Revises: 00000013
Create Date: 2026-07-09
"""

from typing import Sequence, Union

from alembic import op

revision: str = "00000014"
down_revision: Union[str, Sequence[str], None] = "00000013"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("chat_sessions", schema=None) as batch_op:
        batch_op.create_index(
            "ix_chat_sessions_top_mode_created",
            ["parent_session_id", "mode", "created_at"],
            unique=False,
        )
        batch_op.create_index(
            "ix_chat_sessions_top_mode_workspace_created",
            ["parent_session_id", "mode", "workspace", "created_at"],
            unique=False,
        )


def downgrade() -> None:
    with op.batch_alter_table("chat_sessions", schema=None) as batch_op:
        batch_op.drop_index("ix_chat_sessions_top_mode_workspace_created")
        batch_op.drop_index("ix_chat_sessions_top_mode_created")
