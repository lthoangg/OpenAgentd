"""Response models for chat sessions and their messages."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field

from app.api.schemas.base import _ExcludeNoneModel


class SessionCreate(BaseModel):
    title: str | None = None
    agent_name: str | None = None


class TeamSessionResolveRequest(BaseModel):
    mode: str = "normal"
    workspace: str | None = None
    model: str | None = None
    thinking_level: str | None = None
    create: bool = False
    worktree_from: str | None = None
    worktree_name: str | None = None
    worktree_branch: str | None = None


class TeamSessionUpdateRequest(BaseModel):
    title: str = Field(min_length=1, max_length=255)


class TeamWorkspaceVisibilityRequest(BaseModel):
    workspace: str
    hidden: bool


class CodingWorkspaceVisibilityResponse(BaseModel):
    workspace: str
    hidden: bool


class CodingWorkspaceTreeWorktree(BaseModel):
    path: str
    name: str
    managed: bool = False


class CodingWorkspaceTreeRepository(BaseModel):
    path: str
    name: str
    worktrees: list[CodingWorkspaceTreeWorktree] = Field(default_factory=list)


class CodingWorkspaceTreeResponse(BaseModel):
    repositories: list[CodingWorkspaceTreeRepository]


class SessionResponse(_ExcludeNoneModel):
    id: UUID
    title: str | None = None
    agent_name: str | None = None
    scheduled_task_name: str | None = None
    mode: str = "normal"
    workspace: str | None = None
    model: str | None = None
    thinking_level: str | None = None
    revert: dict | None = None
    running: bool = False
    created_at: datetime | None = None
    updated_at: datetime | None = None


class TeamSessionResolveResponse(SessionResponse):
    created: bool


class SessionListResponse(BaseModel):
    data: list[SessionResponse]
    total: int
    offset: int
    limit: int


class SessionPageResponse(BaseModel):
    """Cursor-paginated session list (created_at-based, newest-first).

    ``next_cursor`` is the ISO 8601 ``created_at`` of the last item returned.
    Pass it as ``?before=<next_cursor>`` to fetch the next page.
    ``None`` means this is the last page.
    """

    data: list[SessionResponse]
    next_cursor: str | None = None
    has_more: bool


class MessageResponse(_ExcludeNoneModel):
    id: UUID
    session_id: UUID
    role: str
    content: str | None = None
    reasoning_content: str | None = None
    tool_calls: list[dict] | None = None
    tool_call_id: str | None = None
    name: str | None = None
    is_summary: bool = False
    exclude_from_context: bool = False
    extra: dict | None = None
    created_at: datetime | None = None
    # Attachment metadata (path/workspace_path stripped — see _message_response)
    attachments: list[dict] | None = None
    # True when this message has file attachments — frontend shows file cards
    file_message: bool = False


class SessionDetailResponse(SessionResponse):
    messages: list[MessageResponse]
