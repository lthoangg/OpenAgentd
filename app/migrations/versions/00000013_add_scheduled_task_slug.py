"""add scheduled_task slug

Revision ID: 00000013
Revises: 00000012
Create Date: 2026-07-02
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

from app.scheduler.utils import slugify

# revision identifiers, used by Alembic.
revision: str = "00000013"
down_revision: Union[str, Sequence[str], None] = "00000012"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    columns = [col["name"] for col in inspector.get_columns("scheduled_task")]

    # 1. Add the slug column if it doesn't exist
    if "slug" not in columns:
        with op.batch_alter_table("scheduled_task", schema=None) as batch_op:
            batch_op.add_column(sa.Column("slug", sa.String(length=100), nullable=True))

    # 2. Populate slug for existing rows
    metadata = sa.MetaData()
    scheduled_task_table = sa.Table(
        "scheduled_task",
        metadata,
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("name", sa.String()),
        sa.Column("slug", sa.String()),
    )

    # Query all rows
    results = connection.execute(
        sa.select(
            scheduled_task_table.c.id,
            scheduled_task_table.c.name,
            scheduled_task_table.c.slug,
        )
    ).fetchall()
    for row in results:
        row_id, name, current_slug = row
        # Only populate if slug is null or empty
        if not current_slug:
            slug_val = slugify(name)
            connection.execute(
                scheduled_task_table.update()
                .where(scheduled_task_table.c.id == row_id)
                .values(slug=slug_val)
            )

    # 3. Alter the column to be non-nullable, unique, and index it
    indexes = [idx["name"] for idx in inspector.get_indexes("scheduled_task")]

    with op.batch_alter_table("scheduled_task", schema=None) as batch_op:
        batch_op.alter_column(
            "slug", nullable=False, existing_type=sa.String(length=100)
        )
        if "ix_scheduled_task_slug" not in indexes:
            batch_op.create_index("ix_scheduled_task_slug", ["slug"], unique=True)


def downgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    columns = [col["name"] for col in inspector.get_columns("scheduled_task")]
    indexes = [idx["name"] for idx in inspector.get_indexes("scheduled_task")]

    with op.batch_alter_table("scheduled_task", schema=None) as batch_op:
        if "ix_scheduled_task_slug" in indexes:
            batch_op.drop_index("ix_scheduled_task_slug")
        if "slug" in columns:
            batch_op.drop_column("slug")
