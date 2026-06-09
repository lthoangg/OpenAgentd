"""Direct shell-command dispatch for user-entered ``!`` messages."""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from typing import TYPE_CHECKING
from uuid import UUID, uuid4

from loguru import logger

from app.agent.sandbox import SandboxConfig, _sandbox_ctx, set_sandbox
from app.agent.schemas.chat import (
    AssistantMessage,
    FunctionCall,
    HumanMessage,
    ToolCall,
    ToolMessage,
)
from app.agent.schemas.events import (
    DoneEvent,
    ToolCallEvent,
    ToolEndEvent,
    ToolOutputDeltaEvent,
    ToolStartEvent,
)
from app.agent.tools.builtin.shell import shell_tool
from app.core.db import resolve_db_factory
from app.core.paths import session_workspace_dir
from app.models.chat import ChatSession
from app.services import memory_stream_store as stream_store
from app.services.chat_service import heal_orphaned_tool_calls, save_message
from app.services import snapshot_service
from app.services.stream_envelope import StreamEnvelope

if TYPE_CHECKING:
    from app.agent.mode.team.team import AgentTeam


async def dispatch_shell_command(
    team: "AgentTeam",
    *,
    command: str,
    session_id: str,
    mode: str = "normal",
    workspace: str | None = None,
    model: str | None = None,
    model_provided: bool = False,
    thinking_level: str | None = None,
    thinking_level_provided: bool = False,
    service_tier: str | None = None,
) -> None:
    """Run *command* as a shell tool call and persist it in chat history.

    Matches opencode's user-facing convention: a message beginning with ``!``
    sends the remainder directly to the shell instead of asking the model to
    decide whether to run a tool.
    """
    command = command.strip()
    if not command:
        raise ValueError("Shell command must not be blank.")

    if mode is not None:
        team.mode = mode
    if workspace is not None:
        team.workspace = workspace

    lead_session_changed = team.lead.session_id != session_id
    if lead_session_changed:
        team.lead.session_id = session_id
        await team.lead._ensure_db_session(
            title=f"!{command}"[:100],
            mode=team.mode,
            workspace=team.workspace,
        )
        for bp in team.blueprints.values():
            bp.counter_reconciled_for = None
        await team._restore_or_drop_members_for_lead(session_id)

    lead_uuid = UUID(session_id)
    db_factory = resolve_db_factory(team.lead.db_factory)
    workspace_path = session_workspace_dir(session_id, team.workspace)
    await stream_store.init_turn(session_id, keep_subscribers=True)

    started_at = datetime.now(timezone.utc)
    tool_call_id = f"user_shell_{uuid4().hex[:12]}"
    shell_args = json.dumps(
        {
            "command": command,
            "description": "Run user shell command",
        }
    )
    result: str | None = None
    error: Exception | None = None

    await team._emit(team.lead.name, "agent_status", status="working")
    await stream_store.push_event(
        session_id,
        StreamEnvelope.from_event(
            ToolCallEvent(
                agent=team.lead.name,
                tool_call_id=tool_call_id,
                name="shell",
            )
        ),
    )
    await stream_store.push_event(
        session_id,
        StreamEnvelope.from_event(
            ToolStartEvent(
                agent=team.lead.name,
                tool_call_id=tool_call_id,
                name="shell",
                arguments=shell_args,
            )
        ),
    )

    sequence = 0

    async def emit_output(text: str) -> None:
        nonlocal sequence
        if not text:
            return
        sequence += 1
        await stream_store.push_event(
            session_id,
            StreamEnvelope.from_event(
                ToolOutputDeltaEvent(
                    agent=team.lead.name,
                    tool_call_id=tool_call_id,
                    name="shell",
                    text=text,
                    sequence=sequence,
                )
            ),
        )

    started = time.monotonic()
    sandbox = SandboxConfig(workspace=str(workspace_path), session_id=session_id)
    token = set_sandbox(sandbox)
    try:
        result = await shell_tool.arun(
            command=command,
            description="Run user shell command",
            _injected={"_tool_output": emit_output},
        )
    except Exception as exc:
        error = exc
        result = f"[Failed]\n\n{exc}"
    finally:
        _sandbox_ctx.reset(token)

    duration_ms = round((time.monotonic() - started) * 1000, 3)

    await stream_store.push_event(
        session_id,
        StreamEnvelope.from_event(
            ToolEndEvent(
                agent=team.lead.name,
                tool_call_id=tool_call_id,
                name="shell",
                result=result,
                metadata={"duration_ms": duration_ms},
            )
        ),
    )

    msg_extra: dict[str, object] = {}
    snapshot_hash = await snapshot_service.track(session_id, workspace_path)
    if snapshot_hash:
        msg_extra["snapshot"] = snapshot_hash
    effective_model = model if model_provided else None
    effective_thinking_level = thinking_level if thinking_level_provided else None

    async with db_factory() as db:
        await heal_orphaned_tool_calls(db, lead_uuid)
        lead_row = await db.get(ChatSession, lead_uuid)
        if lead_row is not None:
            lead_row.mode = team.mode
            lead_row.workspace = team.workspace
            if model_provided:
                lead_row.model = model
            if thinking_level_provided:
                lead_row.thinking_level = thinking_level
            effective_model = lead_row.model or team.lead.agent.model_id
            effective_thinking_level = lead_row.thinking_level
            db.add(lead_row)
        else:
            effective_model = model or team.lead.agent.model_id

        if effective_model:
            msg_extra["model"] = effective_model
        if effective_thinking_level:
            msg_extra["thinking_level"] = effective_thinking_level
        if service_tier:
            msg_extra["service_tier"] = service_tier
        msg_extra["kind"] = "user_shell"
        msg_extra["command"] = command

        await save_message(
            db,
            lead_uuid,
            HumanMessage(content=f"!{command}"),
            extra=msg_extra or None,
            created_at=started_at,
        )
        await save_message(
            db,
            lead_uuid,
            AssistantMessage(
                content=None,
                tool_calls=[
                    ToolCall(
                        id=tool_call_id,
                        function=FunctionCall(name="shell", arguments=shell_args),
                    )
                ],
            ),
            created_at=started_at,
        )
        await save_message(
            db,
            lead_uuid,
            ToolMessage(content=result, tool_call_id=tool_call_id, name="shell"),
            extra={"duration_ms": duration_ms},
        )
        await db.commit()

    if error is not None:
        logger.warning(
            "user_shell_command_failed session_id={} error={}", session_id, error
        )

    await team._emit(team.lead.name, "agent_status", status="idle")
    await stream_store.push_event(session_id, StreamEnvelope.from_event(DoneEvent()))
    await stream_store.mark_done(session_id)
