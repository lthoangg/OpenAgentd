"""Team chat, SSE stream, agent listing, session CRUD, and history."""

from __future__ import annotations

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
from app.agent.tools.builtin.skill import discover_skills
from app.api.deps import ChatFormDep, DbSession, TeamDep
from app.api.routes.team._helpers import (
    _message_response,
    _read_upload_as_attachment,
    _require_team,
)
from app.api.schemas.sessions import (
    SessionDetailResponse,
    SessionPageResponse,
    SessionResponse,
)
from app.api.schemas.team import TeamHistoryMember, TeamHistoryResponse
from app.models.chat import ChatSession
from app.services import (
    agent_service,
    memory_stream_store as stream_store,
    team_manager,
)
from app.services.agent_service import AttachmentError, RawAttachment
from app.services.chat_service import (
    cleanup_reverted_tail,
    delete_session,
    get_team_history,
    list_sessions_page,
)

router = APIRouter()


# ── Helpers ───────────────────────────────────────────────────────────────────


def _serialize_agent(agent: Agent, *, is_lead: bool = False) -> dict:
    """Serialize an Agent into the /team/agents response shape."""
    skill_names: list[str] = agent.skills or []
    skills: list[dict] = []
    if skill_names:
        try:
            available = discover_skills()
        except Exception:
            available = {}
        skills = [
            {"name": n, "description": available.get(n, {}).get("description", "")}
            for n in skill_names
        ]

    return {
        "name": agent.name,
        "description": agent.description or "",
        "model": agent.model_id,
        "tools": [
            {"name": t.name, "description": t.description or ""}
            for t in agent._tools.values()
        ],
        # MCP servers configured on the agent. The UI groups tools by name
        # prefix (`mcp_<server>_<tool>`) using this list. Includes servers that
        # exist in config but aren't ready (zero tools), so the UI can show
        # them as "not ready" instead of silently hiding the section.
        "mcp_servers": list(agent.mcp_servers),
        "skills": skills,
        "is_lead": is_lead,
        "capabilities": agent.capabilities.to_dict(),
    }


def _serialize_blueprint(team_obj, bp) -> dict:
    from app.agent.loader import rebuild_agent_from_disk

    agent = rebuild_agent_from_disk(
        bp.source_path,
        provider_factory=team_obj._provider_factory,
        extra_tools=team_obj._extra_tools,
    )
    payload = _serialize_agent(agent)
    payload["live_instances"] = team_obj.live_instances_for_blueprint(bp.name)
    return payload


def _validate_workspace_or_422(workspace: str) -> str:
    try:
        return team_manager.validate_workspace(workspace)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


# ── Routes ────────────────────────────────────────────────────────────────────


@router.post("/chat", status_code=202)
async def team_chat(
    team: TeamDep,
    db: DbSession,
    body: ChatFormDep,
    files: list[UploadFile] = File(default=[]),
) -> dict:
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
    session_id = body.session_id
    interrupt = body.interrupt
    mode = body.mode
    workspace = body.workspace
    existing: ChatSession | None = None
    session_uuid: UUID | None = None

    if session_id:
        try:
            session_uuid = UUID(session_id)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="Invalid session id.") from exc
        async with db.begin():
            existing = await db.get(ChatSession, session_uuid)

    if existing and existing.mode == "coding" and existing.workspace:
        persisted_workspace = _validate_workspace_or_422(existing.workspace)
        if mode == "coding" and workspace is not None:
            requested_workspace = _validate_workspace_or_422(workspace)
            if requested_workspace != persisted_workspace:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "Session belongs to a different coding workspace: "
                        f"{persisted_workspace}"
                    ),
                )
        mode = "coding"
        workspace = persisted_workspace
        try:
            team_obj = await team_manager.get_or_start_coding_team(workspace)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    elif mode == "coding":
        assert workspace is not None
        workspace = _validate_workspace_or_422(workspace)
        try:
            team_obj = await team_manager.get_or_start_coding_team(workspace)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    else:
        team_obj = _require_team(team)

    # ── Interrupt (mutually exclusive with message) ─────────────────────────
    if interrupt:
        await agent_service.interrupt_team(team_obj, session_id)
        return {"status": "interrupted", "session_id": session_id}

    # At this point message is guaranteed non-None by ChatForm validator
    assert message is not None

    if session_uuid is not None:
        async with db.begin():
            await cleanup_reverted_tail(db, session_uuid)

    # Materialise the multipart uploads into transport-neutral attachments
    # so agent_service can validate + persist them without knowing about
    # FastAPI ``UploadFile``.
    attachments: list[RawAttachment] = []
    for file in files:
        raw = await _read_upload_as_attachment(file)
        if raw is not None:
            attachments.append(raw)

    try:
        sid, n_attachments = await agent_service.dispatch_user_message(
            team_obj,
            content=message,
            session_id=session_id,
            attachments=attachments,
            mode=mode,
            workspace=workspace,
        )
    except AttachmentError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc

    logger.info(
        "team_chat_received session_id={} attachments={}",
        sid,
        n_attachments,
    )
    return {"status": "accepted", "session_id": sid}


class CommandRequest(BaseModel):
    """Request body for ``POST /team/commands``."""

    command: Literal["continue", "compact", "undo", "redo"]
    session_id: str


@router.post("/commands", status_code=202)
async def team_command(
    team: TeamDep,
    body: CommandRequest,
) -> dict:
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
    team_obj = _require_team(team)

    if body.command == "continue":
        try:
            sid = await team_obj.handle_continue(body.session_id)
        except ContinuePreconditionError as exc:
            raise HTTPException(status_code=exc.status, detail=exc.reason) from exc
        logger.info("team_command_continue session_id={}", sid)
        return {"status": "accepted", "session_id": sid, "command": "continue"}

    if body.command == "compact":
        try:
            sid = await team_obj.handle_compact(body.session_id)
        except ContinuePreconditionError as exc:
            raise HTTPException(status_code=exc.status, detail=exc.reason) from exc
        logger.info("team_command_compact session_id={}", sid)
        return {"status": "accepted", "session_id": sid, "command": "compact"}

    if body.command == "undo":
        try:
            sid, message = await team_obj.handle_undo(body.session_id)
        except ContinuePreconditionError as exc:
            raise HTTPException(status_code=exc.status, detail=exc.reason) from exc
        logger.info("team_command_undo session_id={}", sid)
        return {
            "status": "accepted",
            "session_id": sid,
            "command": "undo",
            "message": _message_response(message).model_dump(mode="json"),
        }

    if body.command == "redo":
        try:
            sid = await team_obj.handle_redo(body.session_id)
        except ContinuePreconditionError as exc:
            raise HTTPException(status_code=exc.status, detail=exc.reason) from exc
        logger.info("team_command_redo session_id={}", sid)
        return {"status": "accepted", "session_id": sid, "command": "redo"}

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
) -> dict:
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
            team_obj = await team_manager.get_or_start_coding_team(workspace)
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
    return {
        "agents": [
            _serialize_agent(m.agent, is_lead=(m is team_obj.lead)) for m in all_members
        ],
        "blueprints": blueprints,
        "mode": team_obj.mode,
        "workspace": team_obj.workspace,
    }


@router.get("/workspace/validate")
async def validate_coding_workspace(
    workspace: str = Query(..., description="Coding workspace directory."),
) -> dict:
    try:
        resolved = team_manager.validate_workspace(workspace)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"workspace": resolved}


@router.get("/workspace/browse")
async def browse_coding_workspace(
    path: str | None = Query(None, description="Directory to list."),
) -> dict:
    root = Path(path).expanduser().resolve() if path else Path.home().resolve()
    if not root.is_dir():
        raise HTTPException(status_code=422, detail=f"Not a directory: {root}")

    directories: list[dict[str, str]] = []
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
                directories.append({"name": entry.name, "path": str(entry.resolve())})
        except OSError:
            continue

    return {
        "path": str(root),
        "parent": str(root.parent) if root.parent != root else None,
        "directories": directories,
    }


@router.get("/sessions")
async def list_team_sessions(
    db: DbSession,
    before: str | None = Query(
        None,
        description="ISO 8601 created_at cursor — return sessions older than this.",
    ),
    limit: int = Query(20, ge=1, le=100),
) -> SessionPageResponse:
    """List team lead sessions newest-first, cursor-paginated by created_at.

    Pass ``before=<created_at_iso>`` (the ``next_cursor`` from the previous
    page) to retrieve the next batch.  Omit to start from the newest.
    """
    try:
        sessions, next_cursor, has_more = await list_sessions_page(
            db, before=before, limit=limit
        )
    except ValueError:
        raise HTTPException(
            status_code=422,
            detail="Invalid 'before' cursor — expected ISO 8601 datetime.",
        )

    return SessionPageResponse(
        data=[SessionResponse.model_validate(s) for s in sessions],
        next_cursor=next_cursor,
        has_more=has_more,
    )


@router.get("/sessions/{session_id}", response_model=SessionDetailResponse)
async def get_team_session_detail(
    session_id: UUID, db: DbSession
) -> SessionDetailResponse:
    """Return one team lead session with its most recent messages."""
    history = await get_team_history(db, session_id)
    if history is None:
        raise HTTPException(status_code=404, detail="Session not found.")

    lead_resp = SessionResponse.model_validate(history.lead_session)
    return SessionDetailResponse(
        **lead_resp.model_dump(),
        messages=[_message_response(m) for m in history.lead_messages],
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
            await team_manager.get_or_start_coding_team(history.lead_session.workspace)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    else:
        _require_team(team)

    lead_resp = SessionResponse.model_validate(history.lead_session)
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
