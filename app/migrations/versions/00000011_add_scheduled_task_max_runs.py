"""add scheduled_task max_runs

Revision ID: 00000011
Revises: 00000010
Create Date: 2026-06-23
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "00000011"
down_revision: Union[str, Sequence[str], None] = "00000010"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("scheduled_task", schema=None) as batch_op:
        batch_op.add_column(sa.Column("max_runs", sa.Integer(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("scheduled_task", schema=None) as batch_op:
        batch_op.drop_column("max_runs")
