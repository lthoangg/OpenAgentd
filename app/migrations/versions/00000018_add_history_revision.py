"""track effective session history mutations

Revision ID: 00000018
Revises: 00000017
Create Date: 2026-08-16
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "00000018"
down_revision: Union[str, Sequence[str], None] = "00000017"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "chat_sessions",
        sa.Column("history_revision", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "chat_sessions",
        sa.Column(
            "history_structure_revision",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )


def downgrade() -> None:
    op.drop_column("chat_sessions", "history_structure_revision")
    op.drop_column("chat_sessions", "history_revision")
