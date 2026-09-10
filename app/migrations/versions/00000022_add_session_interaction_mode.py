"""Add the Plan/Code interaction-mode projection to sessions."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "00000022"
down_revision: str | None = "00000021"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("chat_sessions") as batch:
        batch.add_column(
            sa.Column(
                "interaction_mode",
                sa.String(length=16),
                nullable=False,
                server_default="code",
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("chat_sessions") as batch:
        batch.drop_column("interaction_mode")
