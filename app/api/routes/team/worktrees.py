"""Git worktree endpoints for coding workspaces."""

from __future__ import annotations


from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from app.core.config import settings

from app.services.worktree_service import (
    InvalidBranchNameError,
    InvalidWorktreeNameError,
    NonGitWorkspaceError,
    UnmanagedWorktreeError,
    WorktreeError,
    WorktreeNameConflictError,
    WorktreePathError,
    create_worktree,
    find_managed_worktree_source,
    list_worktrees,
    remove_worktree,
    rename_worktree,
)

router = APIRouter()

__all__ = ["find_managed_worktree_source", "router", "settings"]


class WorktreeRemoveRequest(BaseModel):
    source_workspace: str = Field(
        description="Primary git repository that owns the worktree."
    )
    directory: str = Field(description="Worktree directory to remove.")


class WorktreeRenameRequest(BaseModel):
    directory: str = Field(description="Worktree directory to rename in the sidebar.")
    name: str = Field(min_length=1, max_length=255)


class WorktreeCreateRequest(BaseModel):
    source_workspace: str = Field(
        description="Existing git repository to create the worktree from."
    )
    name: str | None = Field(
        default=None,
        max_length=80,
        description="Optional worktree name. Defaults to a generated name.",
    )
    branch: str | None = Field(
        default=None,
        max_length=255,
        description="Optional branch name. Defaults to openagentd/<name>.",
    )
    detached: bool = Field(
        default=False,
        description="Create a detached worktree at HEAD instead of creating a branch.",
    )


class WorktreeInfo(BaseModel):
    name: str
    directory: str
    branch: str | None = None
    managed: bool = False


class WorktreeCreateResponse(WorktreeInfo):
    source_workspace: str


class WorktreeRemoveResponse(BaseModel):
    removed: bool


@router.get("/workspace/worktrees")
async def list_coding_workspace_worktrees(source_workspace: str) -> list[WorktreeInfo]:
    try:
        items = await list_worktrees(source_workspace)
        return [
            WorktreeInfo(
                name=item.name,
                directory=item.directory,
                branch=item.branch,
                managed=item.managed,
            )
            for item in items
        ]
    except NonGitWorkspaceError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except WorktreeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.delete("/workspace/worktrees")
async def remove_coding_workspace_worktree(
    body: WorktreeRemoveRequest,
) -> WorktreeRemoveResponse:
    try:
        removed = await remove_worktree(body.source_workspace, body.directory)
        return WorktreeRemoveResponse(removed=removed)
    except NonGitWorkspaceError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except UnmanagedWorktreeError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except WorktreeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.patch("/workspace/worktrees")
async def rename_coding_workspace_worktree(
    body: WorktreeRenameRequest,
) -> WorktreeInfo:
    try:
        info = await rename_worktree(body.directory, body.name)
        return WorktreeInfo(
            name=info.name,
            directory=info.directory,
            managed=info.managed,
        )
    except InvalidWorktreeNameError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except WorktreeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/workspace/worktrees")
async def create_coding_workspace_worktree(
    body: WorktreeCreateRequest,
) -> WorktreeCreateResponse:
    try:
        result = await create_worktree(
            source_workspace=body.source_workspace,
            name=body.name,
            branch=body.branch,
            detached=body.detached,
        )
        return WorktreeCreateResponse(
            name=result.name,
            directory=result.directory,
            branch=result.branch,
            managed=result.managed,
            source_workspace=result.source_workspace,
        )
    except (
        NonGitWorkspaceError,
        InvalidWorktreeNameError,
        InvalidBranchNameError,
        WorktreePathError,
    ) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except WorktreeNameConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except WorktreeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
