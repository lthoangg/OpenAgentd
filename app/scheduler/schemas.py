"""Pydantic request/response schemas for the scheduler API."""

from __future__ import annotations

import re
from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.scheduler.utils import slugify

_NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$")
_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,99}$")


class ScheduledTaskCreate(BaseModel):
    """Payload for POST /scheduler/tasks."""

    name: str = Field(description="Unique task name.")
    slug: str | None = Field(
        default=None,
        description="Unique, URL-friendly identifier. Auto-generated from name if not provided.",
    )
    workspace: str = Field(..., min_length=1, description="Workspace directory.")

    schedule_type: str = Field(description='"at" | "every" | "cron"')
    at_datetime: datetime | None = Field(default=None)
    every_seconds: int | None = Field(default=None, gt=0)
    cron_expression: str | None = Field(default=None)
    timezone: str = Field(default="UTC")

    prompt: str = Field(description="Message to send to the team lead.")
    session_id: str | None = Field(
        default=None,
        description='None=new each time, "auto"=persistent per task name, uuid=continue specific session.',
    )
    max_runs: int | None = Field(default=None, gt=0)
    enabled: bool = Field(default=True)

    @model_validator(mode="after")
    def _validate_schedule(self) -> "ScheduledTaskCreate":
        if not self.name.strip():
            raise ValueError("name cannot be empty or whitespace only")
        if len(self.name) > 100:
            raise ValueError("name must be 100 characters or less")

        if self.slug:
            self.slug = self.slug.strip().lower()
            if not _SLUG_RE.match(self.slug):
                raise ValueError(
                    "slug must consist of lowercase letters, numbers, hyphens, underscores, or dots, and start with a letter or number"
                )
        else:
            self.slug = slugify(self.name)

        st = self.schedule_type
        if st == "at":
            if self.at_datetime is None:
                raise ValueError("at_datetime is required for schedule_type='at'")
            if self.every_seconds is not None or self.cron_expression is not None:
                raise ValueError("Only at_datetime may be set for schedule_type='at'")
        elif st == "every":
            if self.every_seconds is None:
                raise ValueError("every_seconds is required for schedule_type='every'")
            if self.at_datetime is not None or self.cron_expression is not None:
                raise ValueError(
                    "Only every_seconds may be set for schedule_type='every'"
                )
        elif st == "cron":
            if self.cron_expression is None:
                raise ValueError("cron_expression is required for schedule_type='cron'")
            if self.at_datetime is not None or self.every_seconds is not None:
                raise ValueError(
                    "Only cron_expression may be set for schedule_type='cron'"
                )
            from app.scheduler.cron import validate_cron

            if not validate_cron(self.cron_expression):
                raise ValueError(f"Invalid cron expression: '{self.cron_expression}'")
        else:
            raise ValueError(
                f"schedule_type must be 'at', 'every', or 'cron'; got '{st}'"
            )

        return self


class ScheduledTaskUpdate(BaseModel):
    """Payload for PUT /scheduler/tasks/{slug} — all fields optional."""

    slug: str | None = None
    workspace: str | None = Field(default=None, min_length=1)
    schedule_type: str | None = None
    at_datetime: datetime | None = None
    every_seconds: int | None = Field(default=None, gt=0)
    cron_expression: str | None = None
    timezone: str | None = None
    prompt: str | None = None
    session_id: str | None = None
    max_runs: int | None = Field(default=None, gt=0)
    enabled: bool | None = None

    @model_validator(mode="after")
    def _validate_schedule(self) -> "ScheduledTaskUpdate":
        if self.slug is not None:
            self.slug = self.slug.strip().lower()
            if not _SLUG_RE.match(self.slug):
                raise ValueError(
                    "slug must consist of lowercase letters, numbers, hyphens, underscores, or dots, and start with a letter or number"
                )

        st = self.schedule_type
        if st is None:
            return self  # partial update — schedule fields validated at service layer

        if st == "at":
            if self.at_datetime is None:
                raise ValueError("at_datetime is required for schedule_type='at'")
            if self.every_seconds is not None or self.cron_expression is not None:
                raise ValueError("Only at_datetime may be set for schedule_type='at'")
        elif st == "every":
            if self.every_seconds is None:
                raise ValueError("every_seconds is required for schedule_type='every'")
            if self.at_datetime is not None or self.cron_expression is not None:
                raise ValueError(
                    "Only every_seconds may be set for schedule_type='every'"
                )
        elif st == "cron":
            if self.cron_expression is None:
                raise ValueError("cron_expression is required for schedule_type='cron'")
            if self.at_datetime is not None or self.every_seconds is not None:
                raise ValueError(
                    "Only cron_expression may be set for schedule_type='cron'"
                )
            from app.scheduler.cron import validate_cron

            if not validate_cron(self.cron_expression):
                raise ValueError(f"Invalid cron expression: '{self.cron_expression}'")
        else:
            raise ValueError(
                f"schedule_type must be 'at', 'every', or 'cron'; got '{st}'"
            )

        return self


class ScheduledTaskResponse(BaseModel):
    """Response schema for a single task."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    slug: str
    name: str
    workspace: str
    schedule_type: str
    at_datetime: datetime | None
    every_seconds: int | None
    cron_expression: str | None
    timezone: str
    prompt: str
    session_id: str | None
    max_runs: int | None
    enabled: bool
    status: str
    run_count: int
    last_run_at: datetime | None
    last_error: str | None
    next_fire_at: datetime | None
    created_at: datetime
    updated_at: datetime


class ScheduledTaskListResponse(BaseModel):
    tasks: list[ScheduledTaskResponse]


class TaskTriggerResponse(BaseModel):
    status: str
