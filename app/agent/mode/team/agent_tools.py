"""Tools for session-per-agent multi-agent lifecycle and delegation."""

from __future__ import annotations

import json
from typing import Annotated, Any, TYPE_CHECKING
from uuid import UUID

from pydantic import AliasChoices, BaseModel, Field
from sqlmodel import col, select

import app.core.db as db_module
from app.agent.tools.registry import InjectedArg, Tool
from app.models.chat import ChatSession, CodingWorkspace
from app.services import team_manager
from app.services.agent_spawn_service import (
    send_agent_message,
    spawn_agent_session,
)
from app.services.worktree_service import merge_worktree_to_source
from app.services.worktree_service import current_managed_worktree_branch

if TYPE_CHECKING:
    from app.agent.mode.team.runtime import SessionRuntime


class AgentSpawnArgs(BaseModel):
    task: str = Field(
        description="Task description and instructions for the spawned agent."
    )
    name: str | None = Field(
        default=None,
        description="Optional short name for the agent branch/worktree (e.g. 'explore-auth').",
    )


class AgentSendArgs(BaseModel):
    session_id: str = Field(description="Target session ID (parent or child session).")
    content: str = Field(
        validation_alias=AliasChoices("content", "message", "text", "body"),
        description="Message content to deliver to the target agent.",
    )


class AgentStopArgs(BaseModel):
    session_id: str = Field(description="Child session ID to interrupt and stop.")


class AgentMergeArgs(BaseModel):
    delete_on_success: bool = Field(
        default=True,
        description="Automatically remove the temporary worktree and branch after a clean merge.",
    )


def make_agent_spawn_tool(
    runtime: "SessionRuntime", db_factory: db_module.DbFactory | None = None
) -> Tool:
    """Create the agent_spawn tool for delegating tasks into isolated worktrees."""

    async def agent_spawn(
        task: str,
        name: str | None = None,
        _state: Annotated[Any, InjectedArg()] = None,
        _workspace: Annotated[str, InjectedArg()] = "",
    ) -> str:
        parent_session_id = _state.session_id if _state else runtime.session_id
        parent_workspace = _workspace or runtime.workspace or ""
        db_maker = db_factory or getattr(runtime, "db_factory", None)
        try:
            res = await spawn_agent_session(
                parent_session_id=parent_session_id,
                parent_workspace=parent_workspace,
                task=task,
                name=name,
                db_factory=db_maker,
            )
            return json.dumps(
                {
                    "status": "spawned",
                    "session_id": res.session_id,
                    "worktree": res.worktree,
                    "branch": res.branch,
                    "name": res.name,
                    "message": (
                        f"Agent '{res.name}' spawned in worktree '{res.worktree}' "
                        f"on branch '{res.branch}'. Result will arrive asynchronously."
                    ),
                }
            )
        except Exception as exc:
            return f"Failed to spawn agent: {exc}"

    return Tool(
        agent_spawn,
        name="agent_spawn",
        description=(
            "Spawn a new independent agent session in an isolated git worktree "
            "to work on a task in parallel. Returns immediately."
        ),
        args_schema=AgentSpawnArgs,
    )


def make_agent_send_tool(
    runtime: "SessionRuntime", db_factory: db_module.DbFactory | None = None
) -> Tool:
    """Create the agent_send tool for parent-child communication."""

    async def agent_send(
        session_id: str,
        content: str,
        _state: Annotated[Any, InjectedArg()] = None,
    ) -> str:
        sender_session_id = _state.session_id if _state else runtime.session_id
        sender_name = runtime.name
        db_maker = db_factory or getattr(runtime, "db_factory", None)
        try:
            await send_agent_message(
                sender_session_id=sender_session_id,
                target_session_id=session_id,
                sender_name=sender_name,
                content=content,
                db_factory=db_maker,
            )
            return f"Message successfully sent to session '{session_id}'."
        except Exception as exc:
            return f"Failed to send message: {exc}"

    return Tool(
        agent_send,
        name="agent_send",
        description="Send a message to a parent or child agent session.",
        args_schema=AgentSendArgs,
    )


def make_agent_list_tool(
    runtime: "SessionRuntime", db_factory: db_module.DbFactory | None = None
) -> Tool:
    """Create the agent_list tool for querying child sessions."""
    db_maker = db_factory or db_module.async_session_factory

    async def agent_list(
        _state: Annotated[Any, InjectedArg()] = None,
    ) -> str:
        session_id = _state.session_id if _state else runtime.session_id
        try:
            session_uuid = UUID(session_id)
            async with db_maker() as db:
                result = await db.exec(
                    select(ChatSession)
                    .join(
                        CodingWorkspace,
                        col(ChatSession.workspace) == col(CodingWorkspace.path),
                    )
                    .where(col(ChatSession.parent_session_id) == session_uuid)
                    .where(col(CodingWorkspace.kind) == "worktree")
                )
                children = result.all()
        except Exception as exc:
            return f"Failed to list child agents: {exc}"

        if not children:
            return "No spawned child agents."

        items = []
        for c in children:
            live_t = team_manager.find_live_team_serving_session(str(c.id))
            state = getattr(live_t, "state", "idle") if live_t else "offline"
            items.append(
                {
                    "session_id": str(c.id),
                    "name": c.title or str(c.id),
                    "workspace": c.workspace,
                    "branch": await current_managed_worktree_branch(c.workspace or ""),
                    "state": state,
                }
            )
        return json.dumps(items, indent=2)

    return Tool(
        agent_list,
        name="agent_list",
        description="List spawned child agent sessions and their current status.",
    )


def make_agent_stop_tool(
    runtime: "SessionRuntime", db_factory: db_module.DbFactory | None = None
) -> Tool:
    """Create the agent_stop tool for stopping a child session."""
    db_maker = db_factory or db_module.async_session_factory

    async def agent_stop(
        session_id: str,
        _state: Annotated[Any, InjectedArg()] = None,
    ) -> str:
        parent_id = _state.session_id if _state else runtime.session_id
        try:
            async with db_maker() as db:
                row = await db.get(ChatSession, UUID(session_id))
                if row is None or str(row.parent_session_id) != parent_id:
                    return f"Session '{session_id}' is not a child of this session."
        except Exception as exc:
            return f"Failed to verify child session: {exc}"

        live_t = team_manager.find_live_team_serving_session(session_id)
        if live_t is not None:
            from app.services import agent_service

            await agent_service.interrupt_team(live_t, session_id)
            return f"Agent in session '{session_id}' was stopped."
        return f"Agent in session '{session_id}' is not running."

    return Tool(
        agent_stop,
        name="agent_stop",
        description="Stop an active spawned child agent session.",
        args_schema=AgentStopArgs,
    )


def make_agent_merge_tool(
    runtime: "SessionRuntime", db_factory: db_module.DbFactory | None = None
) -> Tool:
    """Create the agent_merge tool for merging a worktree branch into source."""

    async def agent_merge(
        delete_on_success: bool = True,
        _workspace: Annotated[str, InjectedArg()] = "",
    ) -> str:
        worktree_path = _workspace or runtime.workspace
        if not worktree_path:
            return "No workspace context available for merge."
        db_maker = db_factory or getattr(runtime, "db_factory", None)
        res = await merge_worktree_to_source(
            worktree=worktree_path,
            delete_on_success=delete_on_success,
            db_factory=db_maker,
        )
        return json.dumps(
            {
                "status": res.status,
                "detail": res.detail,
                "source_branch": res.source_branch,
                "conflicting_paths": res.conflicting_paths,
            }
        )

    return Tool(
        agent_merge,
        name="agent_merge",
        description=(
            "Merge the current worktree branch back into the parent repository. "
            "Preconditions: clean working tree in worktree and parent repository."
        ),
        args_schema=AgentMergeArgs,
    )
