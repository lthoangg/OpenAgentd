"""Pydantic request/response schemas for the scheduler API."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

_NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$")

TaskMode = Literal["normal", "coding"]


class ScheduledTaskCreate(BaseModel):
    """Payload for POST /scheduler/tasks."""

    name: str = Field(description="Unique task name.")
    mode: TaskMode = Field(
        default="normal",
        description="'normal' delivers to the default team lead; "
        "'coding' delivers to the lead of the coding team for ``workspace``.",
    )
    workspace: str | None = Field(
        default=None,
        description="Absolute path to a workspace directory. "
        "Required when mode='coding'.",
    )

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

        if self.mode == "coding" and not self.workspace:
            raise ValueError("workspace is required when mode='coding'")
        if self.mode == "normal" and self.workspace:
            raise ValueError("workspace must be empty when mode='normal'")

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
    """Payload for PUT /scheduler/tasks/{task_id} — all fields optional."""

    mode: TaskMode | None = None
    workspace: str | None = None
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
        # Cross-field validation for mode/workspace: only enforce when both
        # parts of the pair are present in the payload.  Otherwise the
        # service layer validates against the merged row state.
        if self.mode == "coding" and self.workspace == "":
            raise ValueError("workspace is required when mode='coding'")
        if self.mode == "normal" and self.workspace:
            raise ValueError("workspace must be empty when mode='normal'")

        st = self.schedule_type
        if st is None:
            return self  # partial update — schedule fields validated at service layer

        if st == "at":
            if self.every_seconds is not None or self.cron_expression is not None:
                raise ValueError("Only at_datetime may be set for schedule_type='at'")
        elif st == "every":
            if self.at_datetime is not None or self.cron_expression is not None:
                raise ValueError(
                    "Only every_seconds may be set for schedule_type='every'"
                )
        elif st == "cron":
            if self.at_datetime is not None or self.every_seconds is not None:
                raise ValueError(
                    "Only cron_expression may be set for schedule_type='cron'"
                )
            if self.cron_expression is not None:
                from app.scheduler.cron import validate_cron

                if not validate_cron(self.cron_expression):
                    raise ValueError(
                        f"Invalid cron expression: '{self.cron_expression}'"
                    )
        else:
            raise ValueError(
                f"schedule_type must be 'at', 'every', or 'cron'; got '{st}'"
            )

        return self


class ScheduledTaskResponse(BaseModel):
    """Response schema for a single task."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    mode: TaskMode
    workspace: str | None
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
