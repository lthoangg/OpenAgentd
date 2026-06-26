"""Scheduler REST API — CRUD + lifecycle actions for ScheduledTask.

Endpoints
---------
POST   /scheduler/tasks                  — create
GET    /scheduler/tasks                  — list
GET    /scheduler/tasks/{slug}           — get detail
PUT    /scheduler/tasks/{slug}           — full update
DELETE /scheduler/tasks/{slug}           — delete
POST   /scheduler/tasks/{slug}/pause     — pause
POST   /scheduler/tasks/{slug}/resume    — resume
POST   /scheduler/tasks/{slug}/trigger   — fire immediately
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError

from app.scheduler.models import ScheduledTask
from app.scheduler.schemas import (
    ScheduledTaskCreate,
    ScheduledTaskListResponse,
    ScheduledTaskResponse,
    ScheduledTaskUpdate,
)
from app.scheduler.scheduler import (
    InvalidTaskTargetError,
    TaskNotFoundError,
    TaskScheduler,
    task_scheduler,
)

router = APIRouter()


# ── Dependency ────────────────────────────────────────────────────────────────


def get_scheduler() -> TaskScheduler:
    return task_scheduler


# ── Helpers ───────────────────────────────────────────────────────────────────


def _task_or_404(task: ScheduledTask | None) -> ScheduledTask:
    if task is None:
        raise HTTPException(status_code=404, detail="Scheduled task not found.")
    return task


# ── Routes ────────────────────────────────────────────────────────────────────


@router.post(
    "/tasks",
    response_model=ScheduledTaskResponse,
    status_code=201,
    summary="Create a scheduled task",
)
async def create_task(
    body: ScheduledTaskCreate,
    scheduler: TaskScheduler = Depends(get_scheduler),
) -> ScheduledTaskResponse:
    try:
        saved = await scheduler.create(body)
    except InvalidTaskTargetError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except IntegrityError as exc:
        raise HTTPException(
            status_code=409,
            detail=f"A task named '{body.name}' already exists.",
        ) from exc

    return ScheduledTaskResponse.model_validate(saved)


@router.get(
    "/tasks",
    response_model=ScheduledTaskListResponse,
    summary="List all scheduled tasks",
)
async def list_tasks(
    scheduler: TaskScheduler = Depends(get_scheduler),
) -> ScheduledTaskListResponse:
    tasks = await scheduler.list_tasks()
    return ScheduledTaskListResponse(
        tasks=[ScheduledTaskResponse.model_validate(t) for t in tasks]
    )


@router.get(
    "/tasks/{slug}",
    response_model=ScheduledTaskResponse,
    summary="Get a scheduled task",
)
async def get_task(
    slug: str,
    scheduler: TaskScheduler = Depends(get_scheduler),
) -> ScheduledTaskResponse:
    task = _task_or_404(await scheduler.get_task(slug))
    return ScheduledTaskResponse.model_validate(task)


@router.put(
    "/tasks/{slug}",
    response_model=ScheduledTaskResponse,
    summary="Update a scheduled task",
)
async def update_task(
    slug: str,
    body: ScheduledTaskUpdate,
    scheduler: TaskScheduler = Depends(get_scheduler),
) -> ScheduledTaskResponse:
    try:
        task = await scheduler.apply_update(slug, body)
    except TaskNotFoundError as exc:
        raise HTTPException(
            status_code=404, detail="Scheduled task not found."
        ) from exc
    except InvalidTaskTargetError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return ScheduledTaskResponse.model_validate(task)


@router.delete(
    "/tasks/{slug}",
    status_code=204,
    summary="Delete a scheduled task",
)
async def delete_task(
    slug: str,
    scheduler: TaskScheduler = Depends(get_scheduler),
) -> None:
    _task_or_404(await scheduler.get_task(slug))
    await scheduler.remove(slug)


@router.post(
    "/tasks/{slug}/pause",
    response_model=ScheduledTaskResponse,
    summary="Pause a scheduled task",
)
async def pause_task(
    slug: str,
    scheduler: TaskScheduler = Depends(get_scheduler),
) -> ScheduledTaskResponse:
    _task_or_404(await scheduler.get_task(slug))
    task = await scheduler.pause(slug)
    return ScheduledTaskResponse.model_validate(task)


@router.post(
    "/tasks/{slug}/resume",
    response_model=ScheduledTaskResponse,
    summary="Resume a paused scheduled task",
)
async def resume_task(
    slug: str,
    scheduler: TaskScheduler = Depends(get_scheduler),
) -> ScheduledTaskResponse:
    _task_or_404(await scheduler.get_task(slug))
    task = await scheduler.resume(slug)
    return ScheduledTaskResponse.model_validate(task)


@router.post(
    "/tasks/{slug}/trigger",
    status_code=202,
    summary="Fire a task immediately",
)
async def trigger_task(
    slug: str,
    scheduler: TaskScheduler = Depends(get_scheduler),
) -> dict[str, str]:
    _task_or_404(await scheduler.get_task(slug))
    await scheduler.trigger(slug)
    return {"status": "dispatched"}
