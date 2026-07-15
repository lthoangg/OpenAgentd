"""add index for member-session restore

Revision ID: 00000015
Revises: 00000014
Create Date: 2026-07-15
"""

from typing import Sequence, Union

from alembic import op

revision: str = "00000015"
down_revision: Union[str, Sequence[str], None] = "00000014"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "CREATE INDEX ix_chat_sessions_parent_agent_created "
        "ON chat_sessions (parent_session_id, agent_name, created_at DESC)"
    )


def downgrade() -> None:
    op.drop_index("ix_chat_sessions_parent_agent_created", table_name="chat_sessions")
