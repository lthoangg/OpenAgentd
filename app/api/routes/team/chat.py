"""Team chat, SSE stream, agent listing, session CRUD, and history."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import AsyncGenerator, Literal
from uuid import UUID

from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from loguru import logger
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from app.agent.agent_loop import Agent
from app.agent.mode.team.member import TeamMemberBase
from app.agent.mode.team.team import ContinuePreconditionError
from app.api.deps import ChatFormDep, DbSession, TeamDep
from app.api.routes.team._helpers import (
    _message_response,
    _read_upload_as_attachment,
    _require_team,
    _validate_workspace_or_422,
    build_mention_context_blocks,
    persist_queued_user_message,
    resolve_chat_team,
    validate_model_settings,
)
from app.api.routes.agents import is_registered_model_id
from app.api.schemas.sessions import (
    CodingWorkspaceTreeRepository,
    CodingWorkspaceTreeResponse,
    CodingWorkspaceTreeWorktree,
    SessionDetailResponse,
    SessionPageResponse,
    SessionResponse,
    TeamSessionResolveRequest,
    TeamSessionResolveResponse,
    TeamSessionUpdateRequest,
    TeamWorkspaceVisibilityRequest,
    CodingWorkspaceVisibilityResponse,
)
from app.api.schemas.team import (
    AgentInfoResponse,
    BlueprintInfoResponse,
    ChangedPathsPayload,
    CodingWorkspaceBrowseResponse,
    CodingWorkspaceFolder,
    CodingWorkspaceValidateResponse,
    TeamAgentsResponse,
    TeamChatResponse,
    TeamCommandResponse,
    TeamHistoryMember,
    TeamHistoryResponse,
)
from app.api.routes.team.worktrees import (
    WorktreeCreateRequest,
    create_coding_workspace_worktree,
    find_managed_worktree_source,
)
from app.models.chat import ChatSession
from app.services import (
    agent_service,
    memory_stream_store as stream_store,
    team_manager,
)
from app.services.agent_service import AttachmentError, RawAttachment
from app.services.coding_workspace_service import (
    hide_coding_workspace,
    list_visible_coding_workspaces,
    upsert_coding_workspace,
)
from app.services.chat_service import (
    BoundaryShift,
    cancel_queued_user_message,
    cleanup_reverted_tail,
    delete_session,
    get_team_history,
    get_latest_top_level_session,
    list_sessions_page,
    save_message,
    save_queued_user_message,
    update_session_title,
)

router = APIRouter()


# ── Helpers ───────────────────────────────────────────────────────────────────


def _serialize_agent(
    agent: Agent, *, is_lead: bool = False, workspace: str | None = None
) -> dict:
    """Serialize an Agent into the /team/agents response shape.

    ``workspace``, when given, binds the sandbox for the duration of tool
    description computation only. Some tool descriptions are dynamic — the
    ``skill`` tool in particular lists available skills by walking
    ``get_sandbox().workspace_root``. Outside of an actual agent run there is
    no sandbox bound to this coding workspace (it falls back to a process-
    global temp-dir sandbox), so project-local skills under
    ``{workspace}/.openagentd/skills`` would silently never appear in this
    listing without this override.
    """
    from app.agent.hooks.summarization import resolve_prompt_token_threshold
    from app.agent.mcp import mcp_manager
    from app.agent.sandbox import SandboxConfig, _sandbox_ctx, set_sandbox
    from app.core.runtime_settings import load_runtime_settings

    try:
        _custom = load_runtime_settings().summarization.prompt_token_threshold
    except Exception:
        _custom = None

    tools_by_name = {t.name: t for t in agent._tools.values()}
    for server_name in agent.mcp_servers:
        server_tools = mcp_manager.get_tools_for_server(server_name) or []
        for tool in server_tools:
            tools_by_name.setdefault(tool.name, tool)

    sandbox_token = (
        set_sandbox(SandboxConfig(workspace=workspace)) if workspace else None
    )
    try:
        tools_payload = [
            {"name": t.name, "description": t.description or ""}
            for t in tools_by_name.values()
        ]
    finally:
        if sandbox_token is not None:
            _sandbox_ctx.reset(sandbox_token)

    return {
        "name": agent.name,
        "description": agent.description or "",
        "model": agent.model_id,
        "summary_trigger_tokens": resolve_prompt_token_threshold(
            agent.model_id, _custom
        ),
        "tools": tools_payload,
        # MCP servers configured on the agent. The UI groups tools by name
        # prefix (`<server>_<tool>`) using this list. Includes servers that
        # exist in config but aren't ready (zero tools), so the UI can show
        # them as "not ready" instead of silently hiding the section.
        "mcp_servers": list(agent.mcp_servers),
        "is_lead": is_lead,
        "capabilities": agent.capabilities.to_dict(),
    }


def _serialize_blueprint(team_obj, bp) -> dict:
    from app.agent.loader import rebuild_agent_from_disk

    agent = rebuild_agent_from_disk(
        bp.source_path,
        provider_factory=team_obj._provider_factory,
        extra_tools=team_obj._extra_tools,
        mode=team_obj.mode,
    )
    payload = _serialize_agent(agent, workspace=team_obj.workspace)
    payload["live_instances"] = team_obj.live_instances_for_blueprint(bp.name)
    return payload


def _changed_paths_payload(shift: BoundaryShift) -> dict:
    """Serialise the A/M/D path partition from a /undo or /redo restore.

    The client uses this to splice the cached Coding Workspace git
    diff for just these paths instead of refetching the whole sidebar.
    Empty lists are valid and meaningful — "no paths changed" still
    tells the client to skip invalidation entirely.
    """
    return {
        "added": shift.added,
        "modified": shift.modified,
        "removed": shift.removed,
    }


# ── Routes ────────────────────────────────────────────────────────────────────


@router.post("/chat", status_code=202)
async def team_chat(
    request: Request,
    db: DbSession,
    body: ChatFormDep,
    files: list[UploadFile] = File(default=[]),
) -> TeamChatResponse:
    """Deliver a message to the team lead (202). Accepts multipart/form-data.

    Modes:
    - **Normal send** (``interrupt=false``, ``message`` required):
      Deliver message to team lead and start a new turn.
    - **Interrupt-only** (``interrupt=true``, ``message`` omitted):
      Cancel all working members. Partial output already saved by checkpointer.
    - **Interrupt + follow-up** (``interrupt=true``, ``message`` provided):
      Cancel working members, then deliver new message to the team lead.

    Returns the session_id. Subscribe to GET /team/stream/{session_id} to
    receive the SSE event stream (supports reconnect + replay).
    """
    message = body.message
    interrupt = body.interrupt
    raw_form = await request.form()
    model_provided = "model" in raw_form
    thinking_level_provided = "thinking_level" in raw_form
    model, thinking_level = await validate_model_settings(
        body.model,
        body.thinking_level,
        is_registered_model_id=is_registered_model_id,
    )

    resolved = await resolve_chat_team(
        db, session_id=body.session_id, mode=body.mode, workspace=body.workspace
    )
    team_obj = resolved.team
    session_id = resolved.session_id
    session_uuid = resolved.session_uuid
    mode = resolved.mode
    workspace = resolved.workspace

    fast_mode_service_tier = "fast" if body.fast_mode else None

    # ── Interrupt (mutually exclusive with message) ─────────────────────────
    if interrupt:
        await agent_service.interrupt_team(team_obj, session_id)
        return TeamChatResponse(status="interrupted", session_id=session_id)

    assert message is not None
    if body.shell:
        if files:
            raise HTTPException(
                status_code=422,
                detail="Shell commands cannot include file uploads.",
            )
        command = message.strip()
        if command.startswith("!"):
            command = command[1:].strip()
        if not command:
            raise HTTPException(status_code=422, detail="Shell command is required.")
        sid = await agent_service.dispatch_user_shell_command(
            team_obj,
            command=command,
            session_id=session_id,
            mode=mode,
            workspace=workspace,
            model=model,
            model_provided=model_provided,
            thinking_level=thinking_level,
            thinking_level_provided=thinking_level_provided,
            service_tier=fast_mode_service_tier,
        )
        logger.info("team_chat_shell_received session_id={}", sid)
        return TeamChatResponse(status="accepted", session_id=sid)

    # Materialise the multipart uploads into transport-neutral attachments
    # so agent_service can validate + persist them without knowing about
    # FastAPI ``UploadFile``.
    attachments: list[RawAttachment] = []
    for file in files:
        raw = await _read_upload_as_attachment(file)
        if raw is not None:
            attachments.append(raw)
    mention_context_blocks = await build_mention_context_blocks(
        message=message,
        team=team_obj,
        session_id=session_id,
        workspace=workspace,
        existing_total_bytes=sum(len(a.data) for a in attachments),
        mentions=body.mentions,
    )
    async with team_obj.user_message_lock:
        if session_uuid is not None:
            async with db.begin():
                await cleanup_reverted_tail(db, session_uuid)

        if session_uuid is not None and team_obj.has_active_user_turn():
            queued_result = await persist_queued_user_message(
                db,
                team=team_obj,
                session_id=session_id,
                session_uuid=session_uuid,
                workspace=workspace,
                message=message,
                attachments=attachments,
                mention_context_blocks=mention_context_blocks,
                mentions=body.mentions,
                model=model,
                model_provided=model_provided,
                thinking_level=thinking_level,
                thinking_level_provided=thinking_level_provided,
                fast_mode_service_tier=fast_mode_service_tier,
                save_queued_user_message=save_queued_user_message,
                save_message=save_message,
            )
            if not team_obj.has_active_user_turn():
                await team_obj._activate_queued_user_messages(session_id)
            return TeamChatResponse(
                status="queued",
                session_id=session_id,
                message_id=queued_result.message_id,
            )

        try:
            sid, n_attachments = await agent_service.dispatch_user_message(
                team_obj,
                content=message,
                session_id=session_id,
                attachments=attachments,
                mention_context_blocks=mention_context_blocks,
                mode=mode,
                workspace=workspace,
                model=model,
                model_provided=model_provided,
                thinking_level=thinking_level,
                thinking_level_provided=thinking_level_provided,
                service_tier=fast_mode_service_tier,
                mentions=body.mentions,
            )
        except AttachmentError as exc:
            raise HTTPException(status_code=exc.status, detail=str(exc)) from exc

        logger.info(
            "team_chat_received session_id={} attachments={}",
            sid,
            n_attachments,
        )
        return TeamChatResponse(status="accepted", session_id=sid)


@router.delete("/sessions/{session_id}/queued-messages/{message_id}", status_code=204)
async def cancel_queued_message(
    db: DbSession,
    session_id: UUID,
    message_id: UUID,
) -> None:
    async with db.begin():
        cancelled = await cancel_queued_user_message(db, session_id, message_id)
    if not cancelled:
        raise HTTPException(status_code=404, detail="Queued message not found.")


class CommandRequest(BaseModel):
    """Request body for ``POST /team/commands``."""

    command: Literal["continue", "compact", "undo", "redo"]
    session_id: str


@router.post("/commands", status_code=202)
async def team_command(
    body: CommandRequest,
    db: DbSession,
) -> TeamCommandResponse:
    """Run a slash-command on a session — no new user message persisted.

    Currently supported:

    * ``continue`` — resume from the last assistant turn.  The provider
      sees the existing history (ending in the prior assistant message)
      and keeps generating; the resulting first assistant row is flagged
      ``extra["is_continuation"] = True`` so the UI can render it tight
      against the prior bubble.
    * ``compact`` — force the existing summariser before the next model call
      without adding a visible user message.
    * ``undo`` / ``redo`` — move the visible conversation boundary backward or
      forward without adding a user message.

    Returns 202 with the session_id.  Subscribe to
    ``GET /team/stream/{session_id}`` for the SSE feed.

    Returns 409 with a human-readable ``detail`` when the session can't
    be continued (no assistant message, last message has unfinished tool
    calls, lead is already working, etc.).
    """
    team_obj = await team_manager.get_or_start_team_for_session(body.session_id)
    team_obj = _require_team(team_obj)

    if body.command == "compact":
        try:
            session_uuid = UUID(body.session_id)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="Invalid session id.") from exc
        async with db.begin():
            existing = await db.get(ChatSession, session_uuid)
        if existing and existing.mode == "coding" and existing.workspace:
            try:
                team_obj = await team_manager.get_or_start_coding_team(
                    _validate_workspace_or_422(existing.workspace), body.session_id
                )
            except ValueError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc

    if body.command == "continue":
        try:
            sid = await team_obj.handle_continue(body.session_id)
        except ContinuePreconditionError as exc:
            raise HTTPException(status_code=exc.status, detail=exc.reason) from exc
        logger.info("team_command_continue session_id={}", sid)
        return TeamCommandResponse(
            status="accepted", session_id=sid, command="continue"
        )

    if body.command == "compact":
        try:
            sid = await team_obj.handle_compact(body.session_id)
        except ContinuePreconditionError as exc:
            raise HTTPException(status_code=exc.status, detail=exc.reason) from exc
        logger.info("team_command_compact session_id={}", sid)
        return TeamCommandResponse(status="accepted", session_id=sid, command="compact")

    if body.command == "undo":
        try:
            sid, shift = await team_obj.handle_undo(body.session_id)
        except ContinuePreconditionError as exc:
            raise HTTPException(status_code=exc.status, detail=exc.reason) from exc
        logger.info("team_command_undo session_id={}", sid)
        assert shift.target is not None
        return TeamCommandResponse(
            status="accepted",
            session_id=sid,
            command="undo",
            message=_message_response(shift.target),
            changed_paths=ChangedPathsPayload(**_changed_paths_payload(shift)),
        )

    if body.command == "redo":
        try:
            sid, shift = await team_obj.handle_redo(body.session_id)
        except ContinuePreconditionError as exc:
            raise HTTPException(status_code=exc.status, detail=exc.reason) from exc
        logger.info("team_command_redo session_id={}", sid)
        return TeamCommandResponse(
            status="accepted",
            session_id=sid,
            command="redo",
            message=(
                _message_response(shift.target) if shift.target is not None else None
            ),
            changed_paths=ChangedPathsPayload(**_changed_paths_payload(shift)),
        )

    # Defensive — the Literal makes this unreachable, but pyright/ty wants it.
    raise HTTPException(status_code=400, detail=f"Unknown command: {body.command}")


@router.get("/{session_id}/stream")
async def team_stream(session_id: str, request: Request):
    """SSE stream for all team agent events.

    Replays buffered events from the current turn then delivers live events.
    Safe to reconnect — resumes from where you left off within the TTL window.
    """

    async def _gen() -> AsyncGenerator[dict, None]:
        try:
            async for event in stream_store.attach(session_id):
                if await request.is_disconnected():
                    break
                yield {
                    "event": event.get("event", "message"),
                    "data": event.get("data", "{}"),
                }
        except Exception as exc:
            logger.exception("team_stream_error type={}", type(exc).__name__)
            yield {
                "event": "error",
                "data": f'{{"type":"error","message":"stream_error:{type(exc).__name__}"}}',
            }

    return EventSourceResponse(_gen())


@router.get("/agents")
async def list_team_agents(
    team: TeamDep,
    workspace: str | None = Query(None, description="Coding workspace directory."),
) -> TeamAgentsResponse:
    """Return info on the lead, all live member instances, and spawnable blueprints.

    Refreshes drifted-but-idle agents from disk before serializing so the
    capabilities panel reflects what the *next* turn will use, not the
    config that was loaded the last time the agent woke up.  Without this
    nudge the UI keeps showing the previously-active model after the user
    edits ``model:`` / ``tools:`` / ``skills:`` in the settings page until
    they happen to send another message.

    Working agents are skipped — refreshing them would race ``agent.run()``
    swapping ``self.agent`` mid-execution.  Those will pick up their edits
    via the regular start-of-turn path.

    Response shape::

        {
          "agents": [<lead>, <live members>...],
          "blueprints": [
            {"name": "executor", "description": "...",
             "live_instances": ["executor#1", "executor#2"]},
            ...
          ]
        }
    """
    if workspace:
        try:
            team_obj = await team_manager.get_or_start_coding_team(
                workspace, "__agents__"
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    else:
        team_obj = _require_team(team)
    # Rediscover blueprint files from disk before serializing so newly
    # created members (Settings → Agents) appear without a server restart.
    team_manager.refresh_blueprints(team_obj)
    team_manager.refresh_idle_agents(team_obj)
    all_members: list[TeamMemberBase] = [team_obj.lead, *team_obj.members.values()]
    blueprints = [
        _serialize_blueprint(team_obj, bp) for bp in team_obj.blueprints.values()
    ]
    return TeamAgentsResponse(
        agents=[
            AgentInfoResponse(
                **_serialize_agent(
                    m.agent, is_lead=(m is team_obj.lead), workspace=team_obj.workspace
                )
            )
            for m in all_members
        ],
        blueprints=[BlueprintInfoResponse(**bp) for bp in blueprints],
        mode=team_obj.mode,
        workspace=team_obj.workspace,
    )


@router.get("/workspace/validate")
async def validate_coding_workspace(
    workspace: str = Query(..., description="Coding workspace directory."),
) -> CodingWorkspaceValidateResponse:
    try:
        resolved = team_manager.validate_workspace(workspace)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return CodingWorkspaceValidateResponse(workspace=resolved)


@router.get("/workspace/browse")
async def browse_coding_workspace(
    path: str | None = Query(None, description="Directory to list."),
) -> CodingWorkspaceBrowseResponse:
    return await asyncio.to_thread(_browse_coding_workspace, path)


def _browse_coding_workspace(path: str | None) -> CodingWorkspaceBrowseResponse:
    root = Path(path).expanduser().resolve() if path else Path.home().resolve()
    if not root.is_dir():
        raise HTTPException(status_code=422, detail=f"Not a directory: {root}")

    directories: list[CodingWorkspaceFolder] = []
    try:
        entries = sorted(root.iterdir(), key=lambda entry: entry.name.lower())
    except OSError as exc:
        raise HTTPException(
            status_code=403, detail=f"Cannot read directory: {root}"
        ) from exc

    for entry in entries:
        if entry.name.startswith("."):
            continue
        try:
            if entry.is_dir():
                directories.append(
                    CodingWorkspaceFolder(name=entry.name, path=str(entry.resolve()))
                )
        except OSError:
            continue

    return CodingWorkspaceBrowseResponse(
        path=str(root),
        parent=str(root.parent) if root.parent != root else None,
        directories=directories,
    )


@router.get("/sessions")
async def list_team_sessions(
    db: DbSession,
    before: str | None = Query(
        None,
        description="ISO 8601 created_at cursor — return sessions older than this.",
    ),
    limit: int = Query(20, ge=1, le=100),
    mode: str | None = Query(None),
    workspace: str | None = Query(None),
) -> SessionPageResponse:
    """List team lead sessions newest-first, cursor-paginated by created_at.

    Pass ``before=<created_at_iso>`` (the ``next_cursor`` from the previous
    page) to retrieve the next batch.  Omit to start from the newest.
    """
    if mode is not None and mode not in {"normal", "coding"}:
        raise HTTPException(status_code=422, detail="Invalid mode")
    if workspace is not None and mode != "coding":
        raise HTTPException(status_code=422, detail="workspace requires mode=coding")

    try:
        sessions, next_cursor, has_more = await list_sessions_page(
            db,
            before=before,
            limit=limit,
            mode=mode,
            workspace=workspace,
        )
    except ValueError:
        raise HTTPException(
            status_code=422,
            detail="Invalid 'before' cursor — expected ISO 8601 datetime.",
        )

    running_session_ids = stream_store.running_session_ids()
    return SessionPageResponse(
        data=[
            SessionResponse.model_validate(s).model_copy(
                update={"running": str(s.id) in running_session_ids}
            )
            for s in sessions
        ],
        next_cursor=next_cursor,
        has_more=has_more,
    )


@router.post("/sessions/resolve")
async def resolve_team_session(
    body: TeamSessionResolveRequest, db: DbSession
) -> TeamSessionResolveResponse:
    """Return the newest matching top-level session, creating one if absent."""
    if body.mode not in {"normal", "coding"}:
        raise HTTPException(
            status_code=422, detail="mode must be 'normal' or 'coding'."
        )
    model, thinking_level = await validate_model_settings(
        body.model,
        body.thinking_level,
        is_registered_model_id=is_registered_model_id,
    )

    workspace = body.workspace
    if body.mode == "normal":
        workspace = None
        if body.worktree_from or body.worktree_name or body.worktree_branch:
            raise HTTPException(
                status_code=422, detail="worktree options require mode='coding'."
            )
    elif body.worktree_from or body.worktree_name or body.worktree_branch:
        if not body.worktree_from or not body.worktree_name:
            raise HTTPException(
                status_code=422,
                detail="worktree_from and worktree_name are required for worktree sessions.",
            )
        created_worktree = await create_coding_workspace_worktree(
            WorktreeCreateRequest(
                source_workspace=body.worktree_from,
                name=body.worktree_name,
                branch=body.worktree_branch,
            )
        )
        workspace = created_worktree.directory
        # A worktree request always represents a new coding workspace/session,
        # even if the caller omitted create=true.
        body.create = True
    elif not workspace:
        raise HTTPException(
            status_code=422, detail="workspace is required when mode='coding'."
        )
    else:
        workspace = _validate_workspace_or_422(workspace)

    async with db.begin():
        session = None
        if not body.create:
            session = await get_latest_top_level_session(
                db, mode=body.mode, workspace=workspace
            )
        created = session is None
        if session is None:
            session = ChatSession(
                mode=body.mode,
                workspace=workspace,
                model=model,
                thinking_level=thinking_level,
            )
            db.add(session)
        if body.mode == "coding" and workspace:
            managed_source = find_managed_worktree_source(Path(workspace))
            if managed_source:
                await upsert_coding_workspace(
                    db,
                    path=managed_source,
                    kind="repo",
                    hidden=False,
                )
                await upsert_coding_workspace(
                    db,
                    path=workspace,
                    kind="worktree",
                    source_path=managed_source,
                    managed=True,
                    hidden=False,
                )
            else:
                await upsert_coding_workspace(
                    db, path=workspace, kind="repo", hidden=False
                )
        await db.flush()
        await db.refresh(session)

    data = SessionResponse.model_validate(session).model_dump()
    return TeamSessionResolveResponse(**data, created=created)


@router.patch("/workspace/visibility")
async def update_coding_workspace_visibility(
    body: TeamWorkspaceVisibilityRequest, db: DbSession
) -> CodingWorkspaceVisibilityResponse:
    workspace = (
        str(Path(body.workspace).expanduser().resolve())
        if body.hidden
        else _validate_workspace_or_422(body.workspace)
    )
    async with db.begin():
        if body.hidden:
            await hide_coding_workspace(db, workspace)
        else:
            await upsert_coding_workspace(db, path=workspace, kind="repo", hidden=False)
    return CodingWorkspaceVisibilityResponse(workspace=workspace, hidden=body.hidden)


@router.get("/workspace/tree")
async def list_coding_workspace_tree(db: DbSession) -> CodingWorkspaceTreeResponse:
    rows = await list_visible_coding_workspaces(db)
    repositories: dict[str, CodingWorkspaceTreeRepository] = {}
    pending_worktrees = []
    for row in rows:
        if row.kind == "worktree":
            pending_worktrees.append(row)
            continue
        repositories[row.path] = CodingWorkspaceTreeRepository(
            path=row.path,
            name=row.name or Path(row.path).name,
            worktrees=[],
        )
    for row in pending_worktrees:
        source = row.source_path
        if not source:
            continue
        if source not in repositories:
            repositories[source] = CodingWorkspaceTreeRepository(
                path=source,
                name=Path(source).name,
                worktrees=[],
            )
        repositories[source].worktrees.append(
            CodingWorkspaceTreeWorktree(
                path=row.path,
                name=row.name or Path(row.path).name,
                managed=row.managed,
            )
        )
    return CodingWorkspaceTreeResponse(repositories=list(repositories.values()))


@router.get("/sessions/{session_id}")
async def get_team_session_detail(
    session_id: UUID, db: DbSession
) -> SessionDetailResponse:
    """Return one team lead session with its most recent messages."""
    history = await get_team_history(db, session_id)
    if history is None:
        raise HTTPException(status_code=404, detail="Session not found.")

    lead_resp = SessionResponse.model_validate(history.lead_session).model_copy(
        update={
            "running": str(history.lead_session.id)
            in stream_store.running_session_ids()
        }
    )
    return SessionDetailResponse(
        **lead_resp.model_dump(),
        messages=[_message_response(m) for m in history.lead_messages],
    )


@router.patch("/sessions/{session_id}")
async def update_team_session(
    session_id: UUID, body: TeamSessionUpdateRequest, db: DbSession
) -> SessionResponse:
    """Update editable metadata for a top-level team session."""
    title = body.title.strip()
    if not title:
        raise HTTPException(status_code=422, detail="Title cannot be empty.")
    session = await update_session_title(db, session_id, title)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found.")
    return SessionResponse.model_validate(session).model_copy(
        update={"running": str(session.id) in stream_store.running_session_ids()}
    )


@router.delete("/sessions/{session_id}", status_code=204)
async def delete_team_session(session_id: UUID, db: DbSession) -> None:
    """Delete a team session, all its messages, and uploaded files."""
    found = await delete_session(db, session_id)
    if not found:
        raise HTTPException(status_code=404, detail="Session not found.")


@router.get("/{session_id}/history")
async def team_history(
    db: DbSession,
    team: TeamDep,
    session_id: UUID,
    before: str | None = Query(default=None),
) -> TeamHistoryResponse:
    """Return the latest page of turn history (cursor-based, newest-first page).

    Pass ``before`` (ISO 8601 ``created_at`` of the oldest message from the
    previous response) to load an older page.
    """
    from datetime import datetime

    before_dt: datetime | None = None
    if before is not None:
        try:
            before_dt = datetime.fromisoformat(before)
        except ValueError as exc:
            raise HTTPException(
                status_code=422, detail=f"Invalid before cursor: {before}"
            ) from exc

    history = await get_team_history(db, session_id, before=before_dt)
    if history is None:
        raise HTTPException(status_code=404, detail="Lead session not found.")
    if history.lead_session.mode == "coding" and history.lead_session.workspace:
        try:
            await team_manager.get_or_start_coding_team(
                history.lead_session.workspace, str(history.lead_session.id)
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    else:
        _require_team(team)

    lead_resp = SessionResponse.model_validate(history.lead_session).model_copy(
        update={
            "running": str(history.lead_session.id)
            in stream_store.running_session_ids()
        }
    )
    lead_detail = SessionDetailResponse(
        **lead_resp.model_dump(),
        messages=[_message_response(m) for m in history.lead_messages],
    )

    member_histories = [
        TeamHistoryMember(
            name=member.session.agent_name or str(member.session.id),
            session_id=str(member.session.id),
            messages=[_message_response(m) for m in member.messages],
        )
        for member in history.members
    ]

    next_cursor = history.next_cursor.isoformat() if history.next_cursor else None
    return TeamHistoryResponse(
        lead=lead_detail,
        members=member_histories,
        has_more=history.has_more,
        next_cursor=next_cursor,
    )
