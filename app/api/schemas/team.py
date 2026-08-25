"""Response/request models for /team endpoints.

Covers: history, workspace files, todos, and permission requests.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from pydantic import BaseModel, Field

from app.api.schemas.sessions import MessageResponse, SessionDetailResponse

if TYPE_CHECKING:
    from app.models.chat import PendingQuestion


# ── History ──────────────────────────────────────────────────────────────────


class TeamHistoryMember(BaseModel):
    name: str
    session_id: str
    messages: list[MessageResponse]
    running: bool = False


class TeamHistoryResponse(BaseModel):
    lead: SessionDetailResponse
    members: list[TeamHistoryMember]
    has_more: bool = False
    #: Opaque pagination cursor — echo it back as ``?before=`` verbatim. Encodes
    #: ``"<seq>|<message-id>"``; do not parse or reconstruct it.
    next_cursor: str | None = None
    #: Delta responses (``?since=``) only: the delta hit the row cap, so the
    #: caller must fall back to a full page instead of stitching an incomplete
    #: tail onto its local state.  Always ``False`` for full pages.
    truncated: bool = False
    #: The question the lead is suspended on, if any.  Lets a cold load render
    #: the card and mark the lead ``waiting_input`` in one pass — the SSE replay
    #: buffer is in-memory, so it no longer carries ``question_asked`` after a
    #: daemon restart even though the row is still open.  Always ``None`` on a
    #: delta response (``?since=``), which callers only issue for a finished
    #: turn; absence there does not mean the question was resolved.
    pending_question: "PendingQuestionResponse | None" = None


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
    instructions: str | None = None
    result: str | None = None


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


# ── Questions (ask_user) ─────────────────────────────────────────────

#: Cap on a single free-text answer. Answers land in the transcript and in the
#: model's context, so an unbounded paste is both a cost and a context problem.
MAX_ANSWER_CHARS = 2000


class QuestionAnswerRequest(BaseModel):
    """Body for answering a pending question.

    ``answers`` is index-matched to the question list that was asked. Each entry
    holds the labels selected for that question — empty means "skipped", which
    is a legitimate reply. Values are validated against the stored question
    payload by the route, since anything else is client-supplied text.
    """

    answers: list[list[str]] = Field(
        description=(
            "Selected labels per question, in the order the questions were "
            "asked. Use an empty list to skip a question."
        )
    )


class PendingQuestionResponse(BaseModel):
    """A question awaiting the user's reply."""

    id: str
    session_id: str
    tool_call_id: str
    questions: list[dict]
    created_at: str

    @classmethod
    def from_row(cls, row: "PendingQuestion") -> "PendingQuestionResponse":
        """Serialise a ``pending_questions`` row.

        Shared by the dedicated question endpoint and the history response so
        the two never drift into different shapes for the same card.
        """
        return cls(
            id=str(row.id),
            session_id=str(row.session_id),
            tool_call_id=row.tool_call_id,
            questions=row.payload.get("questions", []),
            created_at=row.created_at.isoformat(),
        )


# ``TeamHistoryResponse`` references ``PendingQuestionResponse`` before it is
# defined (history is the first section in this module). Resolve the forward ref
# now rather than leaving the model to be completed lazily on first validation.
TeamHistoryResponse.model_rebuild()


class PendingQuestionEnvelope(BaseModel):
    """``question`` is ``None`` when the session is not waiting on anything."""

    question: PendingQuestionResponse | None = None


class QuestionResolveResponse(BaseModel):
    """Outcome of answering or dismissing a question.

    ``resumed`` reports whether the suspended turn actually restarted. The
    answer is saved either way — a ``False`` here means the client should offer
    a manual resume rather than assume the agent is working.
    """

    status: str
    resumed: bool


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
