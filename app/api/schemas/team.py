"""Response/request models for /team endpoints.

Covers: history, workspace files, todos, and permission requests.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from app.api.schemas.sessions import MessageResponse, SessionDetailResponse


# ── History ──────────────────────────────────────────────────────────────────


class TeamHistoryMember(BaseModel):
    name: str
    session_id: str
    messages: list[MessageResponse]


class TeamHistoryResponse(BaseModel):
    lead: SessionDetailResponse
    members: list[TeamHistoryMember]
    has_more: bool = False
    next_cursor: str | None = None


# ── Workspace files ──────────────────────────────────────────────────────────


class WorkspaceFileInfo(BaseModel):
    """One file in the agent workspace."""

    path: str  # Relative, POSIX-separated (e.g. "output/chart.png")
    name: str  # Basename (e.g. "chart.png")
    size: int  # Bytes
    mtime: float  # Seconds since epoch
    mime: str  # Guessed MIME type


class WorkspaceFilesResponse(BaseModel):
    """Flat recursive listing of a session's agent workspace."""

    session_id: str
    files: list[WorkspaceFileInfo]
    truncated: bool = False  # True when the walk hit the max-files cap


class CodingWorkspaceFilesResponse(BaseModel):
    """Flat recursive listing of a coding workspace."""

    workspace: str
    files: list[WorkspaceFileInfo]
    truncated: bool = False


# ── Todos ────────────────────────────────────────────────────────────────────


class TodoItemResponse(BaseModel):
    task_id: str
    content: str
    status: str
    priority: str
    dependencies: list[str] = Field(default_factory=list)
    assigned_to: str | None = None
    claimed_by: str | None = None


class TodosResponse(BaseModel):
    todos: list[TodoItemResponse]


# ── Git history and commits ──────────────────────────────────────────────────


class GitCommit(BaseModel):
    """One git commit representation."""

    sha: str
    short_sha: str
    author_name: str
    author_email: str
    timestamp: int
    subject: str
    body: str | None = None
    refs: str | None = None


class WorkspaceGitHistoryResponse(BaseModel):
    """Git history and graph tree representation."""

    workspace: str
    is_git_repo: bool
    commits: list[GitCommit]
    next_cursor: str | None = None
    graph: str


class WorkspaceCommitDiffResponse(BaseModel):
    """Raw diff of a specific git commit."""

    sha: str
    diff: str


# ── Permissions ──────────────────────────────────────────────────────────────


class PermissionReplyRequest(BaseModel):
    """Body for replying to a pending permission request."""

    reply: str = Field(description="'once', 'always', or 'reject'")
    message: str | None = Field(
        default=None, description="Optional feedback message when rejecting."
    )


class PermissionRequestResponse(BaseModel):
    """Serialised form of a pending PermissionRequest."""

    id: str
    session_id: str
    tool: str
    patterns: list[str]
    metadata: dict


class PermissionListResponse(BaseModel):
    permissions: list[PermissionRequestResponse]


class PermissionReplyResponse(BaseModel):
    status: str
    request_id: str
    reply: str


class CodingWorkspaceGitDiffResponse(BaseModel):
    workspace: str
    is_git_repo: bool
    diff: str
    untracked: list[str] = Field(default_factory=list)
    truncated: bool = False


class CodingWorkspaceStatusDirty(BaseModel):
    staged: int
    unstaged: int
    untracked: int


class CodingWorkspaceStatusHead(BaseModel):
    sha: str
    subject: str
    timestamp: int


class CodingWorkspaceStatusResponse(BaseModel):
    workspace: str
    name: str
    is_git_repo: bool
    branch: str | None = None
    dirty: CodingWorkspaceStatusDirty | None = None
    head: CodingWorkspaceStatusHead | None = None
    commits_ahead: int | None = None
    """Local commits not yet pushed to origin/upstream."""
    commits_behind: int | None = None
    """Remote commits not yet pulled locally."""
    upstream: str | None = None
    """Origin or upstream reference used for commit counts (e.g. origin/main or origin/branch-A)."""


class DiscardWorkspaceFileRequest(BaseModel):
    workspace: str
    path: str
    status: str


class DiscardWorkspaceFileResponse(BaseModel):
    workspace: str
    path: str
    status: str


class GitUndoRequest(BaseModel):
    workspace: str


class GitUndoResponse(BaseModel):
    workspace: str
    success: bool


class GitRevertRequest(BaseModel):
    workspace: str
    sha: str


class GitRevertResponse(BaseModel):
    workspace: str
    sha: str
    success: bool


class AgentToolInfo(BaseModel):
    name: str
    description: str


class AgentInfoResponse(BaseModel):
    name: str
    description: str
    model: str | None = None
    summary_trigger_tokens: int
    tools: list[AgentToolInfo]
    mcp_servers: list[str]
    is_lead: bool
    capabilities: dict


class BlueprintInfoResponse(BaseModel):
    name: str
    description: str
    model: str | None = None
    summary_trigger_tokens: int
    tools: list[AgentToolInfo]
    mcp_servers: list[str]
    is_lead: bool
    capabilities: dict
    live_instances: list[str]


class TeamAgentsResponse(BaseModel):
    agents: list[AgentInfoResponse]
    blueprints: list[BlueprintInfoResponse]
    mode: str
    workspace: str | None = None


class CodingWorkspaceValidateResponse(BaseModel):
    workspace: str


class CodingWorkspaceFolder(BaseModel):
    name: str
    path: str


class CodingWorkspaceBrowseResponse(BaseModel):
    path: str
    parent: str | None = None
    directories: list[CodingWorkspaceFolder]


class TeamChatResponse(BaseModel):
    status: str
    session_id: str
    message_id: str | None = None


class ChangedPathsPayload(BaseModel):
    added: list[str]
    modified: list[str]
    removed: list[str]


class TeamCommandResponse(BaseModel):
    status: str
    session_id: str
    command: str
    message: MessageResponse | None = None
    changed_paths: ChangedPathsPayload | None = None
