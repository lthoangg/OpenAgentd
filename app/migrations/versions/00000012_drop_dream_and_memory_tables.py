"""drop dream and memory tables

Revision ID: 00000012
Revises: 00000011
Create Date: 2026-07-01

Removes the dream_log, dream_notes_log, and memory_processed_sources
tables. The dream/wiki/memory feature has been removed from the codebase.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "00000012"
down_revision: Union[str, Sequence[str], None] = "00000011"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Drop dream_log, dream_notes_log, and memory_processed_sources tables."""
    with op.batch_alter_table("dream_notes_log", schema=None) as batch_op:
        batch_op.drop_index("ix_dream_notes_log_filename")
    op.drop_table("dream_notes_log")

    with op.batch_alter_table("dream_log", schema=None) as batch_op:
        batch_op.drop_index("ix_dream_log_session_id")
    op.drop_table("dream_log")

    with op.batch_alter_table("memory_processed_sources", schema=None) as batch_op:
        batch_op.drop_index("ix_memory_processed_sources_source_id")
        batch_op.drop_index("ix_memory_processed_sources_source_type")
    op.drop_table("memory_processed_sources")


def downgrade() -> None:
    """Re-create dream_log, dream_notes_log, and memory_processed_sources tables."""
    from app.models.chat import TZDateTime

    op.create_table(
        "dream_log",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("session_id", sa.Text(), nullable=False),
        sa.Column("processed_at", TZDateTime(timezone=True), nullable=False),
        sa.Column("agent_name", sa.Text(), nullable=True),
        sa.Column("topics_written", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("session_id"),
    )
    with op.batch_alter_table("dream_log", schema=None) as batch_op:
        batch_op.create_index("ix_dream_log_session_id", ["session_id"], unique=True)

    op.create_table(
        "dream_notes_log",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("filename", sa.Text(), nullable=False),
        sa.Column("processed_at", TZDateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("filename"),
    )
    with op.batch_alter_table("dream_notes_log", schema=None) as batch_op:
        batch_op.create_index("ix_dream_notes_log_filename", ["filename"], unique=True)

    op.create_table(
        "memory_processed_sources",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("source_type", sa.String(length=50), nullable=False),
        sa.Column("source_id", sa.String(length=255), nullable=False),
        sa.Column("content_hash", sa.String(length=64), nullable=False),
        sa.Column("processed_at", TZDateTime(timezone=True), nullable=False),
        sa.Column("pages_changed", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "source_type",
            "source_id",
            name="uq_memory_processed_sources_source",
        ),
    )
    with op.batch_alter_table("memory_processed_sources", schema=None) as batch_op:
        batch_op.create_index(
            "ix_memory_processed_sources_source_type", ["source_type"], unique=False
        )
        batch_op.create_index(
            "ix_memory_processed_sources_source_id", ["source_id"], unique=False
        )
