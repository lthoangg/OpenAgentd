"""Remove normal-mode persistence and make workspaces mandatory."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "00000021"
down_revision: str | None = "00000020"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Remove legacy normal rows before enforcing the coding-only contract.
    op.execute(
        sa.text("DELETE FROM scheduled_task WHERE workspace IS NULL OR mode = 'normal'")
    )
    op.execute(
        sa.text("DELETE FROM chat_sessions WHERE workspace IS NULL OR mode = 'normal'")
    )
    with op.batch_alter_table("chat_sessions") as batch:
        batch.drop_index("ix_chat_sessions_top_mode_created")
        batch.drop_index("ix_chat_sessions_top_mode_workspace_created")
        batch.drop_column("mode")
        batch.alter_column("workspace", existing_type=sa.String(), nullable=False)
        batch.create_index(
            "ix_chat_sessions_top_created", ["parent_session_id", "created_at", "id"]
        )
        batch.create_index(
            "ix_chat_sessions_top_workspace_created",
            ["parent_session_id", "workspace", "created_at", "id"],
        )
    with op.batch_alter_table("scheduled_task") as batch:
        batch.drop_column("mode")
        batch.alter_column("workspace", existing_type=sa.String(), nullable=False)


def downgrade() -> None:
    raise NotImplementedError("coding-only migration cannot be downgraded")
