"""SQLModel definition for ScheduledTask."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID, uuid7

import sqlalchemy as sa
from sqlalchemy import Column
from sqlmodel import Field, SQLModel

from app.models.chat import TZDateTime, _utcnow


class ScheduledTask(SQLModel, table=True):
    __tablename__ = "scheduled_task"  # type: ignore[reportIncompatibleVariableOverride]

    id: UUID = Field(default_factory=uuid7, primary_key=True)
    slug: str = Field(
        sa_column=Column(sa.String(100), nullable=False, unique=True, index=True)
    )
    name: str = Field(
        sa_column=Column(sa.String(100), nullable=False, unique=True, index=True)
    )
    # Every task delivers to the agent session for its workspace.
    # API and scheduler validation require a real workspace. Keep direct ORM
    # construction representable with an invalid sentinel until validation.
    workspace: str = Field(default="", sa_column=Column(sa.String, nullable=False))

    # Schedule — exactly one of these must be set
    schedule_type: str = Field(sa_column=Column(sa.String(20), nullable=False))
    at_datetime: datetime | None = Field(
        default=None,
        sa_column=Column(TZDateTime(), nullable=True),
    )
    every_seconds: int | None = Field(
        default=None, sa_column=Column(sa.Integer, nullable=True)
    )
    cron_expression: str | None = Field(
        default=None, sa_column=Column(sa.String(100), nullable=True)
    )
    timezone: str = Field(
        default="UTC",
        sa_column=Column(sa.String(50), nullable=False, server_default="UTC"),
    )

    # Execution
    prompt: str = Field(sa_column=Column(sa.Text, nullable=False))
    session_id: str | None = Field(
        default=None, sa_column=Column(sa.String(200), nullable=True)
    )

    # Lifecycle
    enabled: bool = Field(
        default=True,
        sa_column=Column(sa.Boolean, nullable=False, server_default=sa.true()),
    )
    status: str = Field(
        default="pending",
        sa_column=Column(sa.String(20), nullable=False, server_default="pending"),
    )

    # Stats
    run_count: int = Field(
        default=0, sa_column=Column(sa.Integer, nullable=False, server_default="0")
    )
    max_runs: int | None = Field(
        default=None, sa_column=Column(sa.Integer, nullable=True)
    )
    last_run_at: datetime | None = Field(
        default=None, sa_column=Column(TZDateTime(), nullable=True)
    )
    last_error: str | None = Field(
        default=None, sa_column=Column(sa.Text, nullable=True)
    )
    next_fire_at: datetime | None = Field(
        default=None, sa_column=Column(TZDateTime(), nullable=True)
    )

    created_at: datetime = Field(
        default_factory=_utcnow,
        sa_column=Column(TZDateTime(), nullable=False),
    )
    updated_at: datetime = Field(
        default_factory=_utcnow,
        sa_column=Column(TZDateTime(), nullable=False, onupdate=_utcnow),
    )
