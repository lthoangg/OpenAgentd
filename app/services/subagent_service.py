"""Subagent management service for OpenAgentd.

Coordinates member agent lifecycles, instance handle allocation (profile#N),
bidirectional communication, and clean cascade cancellation under a lead session.
"""

from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from uuid import UUID, uuid7

from loguru import logger
from sqlmodel import col, select

from app.agent.agent_loop import Agent
from app.agent.loader import load_member_profiles
from app.agent.session import AgentSession
from app.agent.tools.registry import Tool
from app.agent.providers.factory import ProviderFactory
from app.core.config import DEFAULT_NEW_USER_MODEL, settings
from app.core.db import DbFactory, resolve_db_factory
from app.models.chat import ChatSession, SessionMessage

MAX_CONCURRENT_MEMBERS = 20
MAX_SUBAGENT_OUTPUT_CHARS = 32_000
MAX_MEMBER_ITERATIONS = 30
DEFAULT_MEMBER_TIMEOUT = 180.0


def prune_subagent_output(
    output: str,
    child_session_id: str,
    max_chars: int = MAX_SUBAGENT_OUTPUT_CHARS,
) -> str:
    """Safeguard subagent output length before delivery to lead transcript.

    Preserves head and tail context if the deliverable exceeds *max_chars*,
    pointing to the child session for the unabridged output.
    """
    if len(output) <= max_chars:
        return output
    head_len = max(500, max_chars - 1000)
    tail_len = min(400, max_chars - head_len)
    head = output[:head_len].rstrip()
    tail = output[-tail_len:].lstrip() if tail_len > 0 else ""
    truncated_msg = (
        f"\n\n[... Output truncated: {len(output)} chars total exceeds lead message budget of {max_chars} chars. "
        f"Full deliverable preserved in subagent session {child_session_id} ...]\n\n"
    )
    return f"{head}{truncated_msg}{tail}"


_INSTANCE_HANDLE_RE = re.compile(r"^(?P<profile>[^#]+)#(?P<n>\d+)$")


class SubagentError(Exception):
    """Base exception for subagent errors."""


class AmbiguousMemberError(SubagentError):
    """Raised when a bare profile name matches multiple live instances."""


class MemberNotFoundError(SubagentError):
    """Raised when a target member instance cannot be found."""


class MaxConcurrentMembersError(SubagentError):
    """Raised when maximum concurrent running members cap is exceeded."""


@dataclass
class SubagentInstance:
    """A live subagent instance coordinated by a lead session."""

    handle: str  # e.g. "explorer#1"
    profile_name: str  # e.g. "explorer"
    lead_session_id: str
    session_id: str  # Child ChatSession UUID string
    session: AgentSession
    status: str = "idle"  # "working" | "idle" | "waiting_lead" | "completed" | "error"
    task_handle: asyncio.Task | None = None
    last_result: str | None = None
    pending_lead_question: dict[str, Any] | None = None
    last_error: str | None = None
    created_at: float = field(default_factory=time.monotonic)
    _question_delivered: bool = False
    _result_delivered: bool = False


# Module-level state: lead_session_id -> {handle: SubagentInstance}
_live_instances: dict[str, dict[str, SubagentInstance]] = {}
# Monotonic counter per lead session per profile: lead_session_id -> {profile: next_int}
_instance_counters: dict[str, dict[str, int]] = {}
_reconciled_lead_sessions: set[str] = set()


def parse_instance_handle(handle: str) -> tuple[str, int] | None:
    """Parse ``profile#N`` into ``(profile, N)`` or return None."""
    m = _INSTANCE_HANDLE_RE.match(handle.strip())
    if not m:
        return None
    return m.group("profile"), int(m.group("n"))


async def reconcile_lead_instances(lead_session_id: str, db_factory: DbFactory) -> None:
    """Seed the next instance counter for a lead from the database."""
    if lead_session_id in _reconciled_lead_sessions:
        return

    db_maker = resolve_db_factory(db_factory)
    lead_uuid = UUID(lead_session_id)
    counters = _instance_counters.setdefault(lead_session_id, {})

    async with db_maker() as db:
        stmt = select(ChatSession.agent_name).where(
            col(ChatSession.parent_session_id) == lead_uuid
        )
        rows = (await db.exec(stmt)).all()
        for name in rows:
            if not name:
                continue
            parsed = parse_instance_handle(name)
            if parsed is not None:
                profile, n = parsed
                counters[profile] = max(counters.get(profile, 1), n + 1)

    _reconciled_lead_sessions.add(lead_session_id)


def allocate_instance_handle(
    lead_session_id: str,
    profile: str,
    explicit_name: str | None = None,
) -> str:
    """Return a unique instance handle for this profile under the lead session."""
    if explicit_name and explicit_name.strip():
        name = explicit_name.strip()
        parsed = parse_instance_handle(name)
        if parsed:
            p, n = parsed
            counters = _instance_counters.setdefault(lead_session_id, {})
            counters[p] = max(counters.get(p, 1), n + 1)
        return name

    counters = _instance_counters.setdefault(lead_session_id, {})
    next_id = counters.get(profile, 1)
    counters[profile] = next_id + 1
    return f"{profile}#{next_id}"


def resolve_instance(lead_session_id: str, handle_or_profile: str) -> SubagentInstance:
    """Resolve an exact handle or unique bare profile name to a live instance."""
    instances = _live_instances.get(lead_session_id, {})
    target = handle_or_profile.strip()

    # 1. Exact match on handle (e.g. "explorer#1")
    if target in instances:
        return instances[target]

    # 2. Check if bare profile matches exactly one live instance
    matching = [inst for inst in instances.values() if inst.profile_name == target]
    if len(matching) == 1:
        return matching[0]
    if len(matching) > 1:
        live_handles = [inst.handle for inst in matching]
        raise AmbiguousMemberError(
            f"Multiple live instances for '{target}': {live_handles}. "
            f"Address one explicitly (e.g. '{live_handles[0]}')."
        )

    available = sorted(instances.keys())
    raise MemberNotFoundError(
        f"Member '{target}' not found. Live instances: {available or 'None'}."
    )


def find_instance_by_session_id(
    lead_session_id: str, child_session_id: str
) -> SubagentInstance | None:
    """Find a live subagent instance by its child session UUID string."""
    instances = _live_instances.get(lead_session_id, {})
    for inst in instances.values():
        if inst.session_id == child_session_id:
            return inst
    return None


def _resolve_agents_dir() -> Path:
    p = Path(settings.AGENTS_DIR)
    return p if p.is_absolute() else Path.cwd() / p


def _build_member_tools(
    allowed_tool_names: list[str],
) -> list[Tool]:
    """Build tool registry for the member agent from allowed tool names."""
    from app.agent.tools.builtin import (
        glob_files,
        grep_files,
        patch_file,
        read_file,
        shell_tool,
        web_fetch,
        web_search,
    )

    builtin_map: dict[str, Tool] = {
        "read": read_file,
        "glob": glob_files,
        "grep": grep_files,
        "patch": patch_file,
        "shell": shell_tool,
        "web_search": web_search,
        "web_fetch": web_fetch,
    }

    tools: list[Tool] = []
    seen: set[str] = set()

    # Whitelist from profile
    for name in allowed_tool_names:
        # Strictly disallow lead-only / user tools
        if name in (
            "ask_user",
            "team_spawn",
            "team_send",
            "team_list",
            "team_wait",
            "team_stop",
            "schedule_task",
        ):
            continue
        if name in builtin_map and name not in seen:
            seen.add(name)
            tools.append(builtin_map[name])

    return tools


async def spawn_subagent(
    *,
    lead_session_id: str,
    profile: str,
    task: str,
    name: str | None = None,
    wait: bool = True,
    tools_override: list[str] | None = None,
    model_override: str | None = None,
    workspace: str = "",
    db_factory: DbFactory | None = None,
    provider_factory: ProviderFactory | None = None,
) -> dict[str, Any]:
    """Spawn a member agent instance from a profile under the lead session."""
    db_maker = resolve_db_factory(db_factory)
    await reconcile_lead_instances(lead_session_id, db_maker)

    # Check active concurrent limit
    instances = _live_instances.setdefault(lead_session_id, {})
    active_count = sum(1 for i in instances.values() if i.status == "working")
    if active_count >= MAX_CONCURRENT_MEMBERS:
        raise MaxConcurrentMembersError(
            f"Reached maximum concurrent members limit ({MAX_CONCURRENT_MEMBERS})."
        )

    # Load profile from disk or builtins
    agents_dir = _resolve_agents_dir()
    profiles = load_member_profiles(agents_dir)
    cfg = profiles.get(profile)
    if cfg is None:
        available = sorted(profiles.keys())
        raise SubagentError(
            f"Profile '{profile}' not found. Available member profiles: {available}."
        )

    lead_model: str | None = None
    lead_thinking_level: str | None = None
    lead_interaction_mode: str | None = None
    async with db_maker() as db:
        lead_row = await db.get(ChatSession, UUID(lead_session_id))
        if lead_row is not None:
            lead_model = lead_row.model
            lead_interaction_mode = lead_row.interaction_mode
            lead_thinking_level = lead_row.thinking_level

    handle = allocate_instance_handle(lead_session_id, profile, explicit_name=name)
    child_session_uuid = uuid7()

    from app.core.config import PROVIDER_MODEL_TOKEN

    if model_override:
        effective_model = model_override
    elif cfg.model and cfg.model not in (DEFAULT_NEW_USER_MODEL, PROVIDER_MODEL_TOKEN):
        effective_model = cfg.model
    elif lead_model:
        effective_model = lead_model
    else:
        effective_model = cfg.model or DEFAULT_NEW_USER_MODEL

    effective_thinking_level = cfg.thinking_level or lead_thinking_level

    # Build member agent tools
    allowed_tools = tools_override if tools_override is not None else cfg.tools
    member_tools = _build_member_tools(allowed_tools)

    # Augmented system prompt
    system_prompt = (
        f"{cfg.system_prompt.strip()}\n\n"
        f"## Team Context\n"
        f"You are instance **{handle}** (role: {cfg.role}), working for the lead agent.\n"
        f"Return your final deliverable directly in your assistant response text.\n"
        f"If blocked by ambiguity or needing a decision from the lead, use `ask_lead`.\n"
        f"You do not communicate with any other members or the user."
    )

    if provider_factory is not None:
        provider = provider_factory(
            effective_model,
            model_kwargs=(
                {"thinking_level": effective_thinking_level}
                if effective_thinking_level
                else None
            ),
        )
    else:
        from app.agent.providers.factory import build_provider

        provider = build_provider(
            effective_model,
            model_kwargs=(
                {"thinking_level": effective_thinking_level}
                if effective_thinking_level
                else None
            ),
        )

    agent = Agent(
        llm_provider=provider,
        system_prompt=system_prompt,
        tools=member_tools,
        name=handle,
        description=cfg.description,
        model_id=effective_model,
    )

    # Create child AgentSession
    child_session = AgentSession(
        agent=agent,
        session_id=str(child_session_uuid),
        workspace=workspace,
        db_factory=db_maker,
        provider_factory=provider_factory,
        parent_session_id=lead_session_id,
    )

    # Create ChatSession record in DB
    async with db_maker() as db:
        clean_task = " ".join(task.split())
        row = ChatSession(
            id=child_session_uuid,
            parent_session_id=UUID(lead_session_id),
            agent_name=handle,
            title=f"{handle}: {clean_task[:60]}",
            workspace=workspace,
            model=effective_model,
            thinking_level=effective_thinking_level,
            interaction_mode=lead_interaction_mode or "code",
        )
        db.add(row)
        await db.commit()

    instance = SubagentInstance(
        handle=handle,
        profile_name=profile,
        lead_session_id=lead_session_id,
        session_id=str(child_session_uuid),
        session=child_session,
        status="working",
    )
    instance._question_delivered = False
    instance._result_delivered = False
    instances[handle] = instance

    logger.info(
        "subagent_spawned lead={} handle={} profile={} session_id={}",
        lead_session_id,
        handle,
        profile,
        child_session_uuid,
    )

    spawn_payload = {
        "lead_session_id": lead_session_id,
        "session_id": str(child_session_uuid),
        "handle": handle,
        "profile": profile,
        "workspace": workspace,
        "title": f"{handle}: {clean_task[:60]}",
        "status": "working",
        "running": True,
    }
    try:
        from app.services import event_broadcaster
        from app.services import memory_stream_store as stream_store
        from app.services.stream_envelope import StreamEnvelope

        await event_broadcaster.publish("subagent_spawned", spawn_payload)
        await stream_store.push_event(
            lead_session_id,
            StreamEnvelope.from_parts("subagent_spawned", spawn_payload),
            create_if_missing=True,
        )
    except Exception as exc:
        logger.debug("Failed to publish subagent_spawned: {}", exc)

    # Start the member's turn with the task prompt
    brief = f"[Task from Lead]: {task}"
    await child_session.handle_user_message(
        content=brief,
        session_id=str(child_session_uuid),
        workspace=workspace,
        model=effective_model if model_override else None,
        model_provided=model_override is not None,
        origin="agent",
    )

    if wait:
        # Synchronous execution: await turn completion or suspension
        return await _await_member_turn(instance, db_maker)

    # Asynchronous execution: track task in background
    instance.task_handle = child_session._active_task
    return {
        "status": "spawned",
        "member_id": handle,
        "profile": profile,
        "session_id": str(child_session_uuid),
        "message": f"Subagent '{handle}' spawned in background.",
    }


async def _await_member_turn(
    instance: SubagentInstance, db_factory: DbFactory
) -> dict[str, Any]:
    """Await an active member turn and return the final output or question."""
    active_task = instance.session._active_task
    if active_task and not active_task.done():
        try:
            await asyncio.wait_for(
                asyncio.shield(active_task), timeout=DEFAULT_MEMBER_TIMEOUT
            )
        except asyncio.TimeoutError:
            instance.status = "error"
            instance.last_error = f"Member '{instance.handle}' timed out."
            return {
                "status": "timeout",
                "member_id": instance.handle,
                "message": f"Member '{instance.handle}' timed out after {DEFAULT_MEMBER_TIMEOUT}s.",
            }
        except asyncio.CancelledError:
            instance.status = "error"
            return {
                "status": "cancelled",
                "member_id": instance.handle,
                "message": f"Member '{instance.handle}' was cancelled.",
            }
        except Exception as exc:
            instance.status = "error"
            instance.last_error = str(exc)
            return {
                "status": "error",
                "member_id": instance.handle,
                "error": str(exc),
            }

    # Check if turn suspended on ask_lead
    if instance.pending_lead_question:
        instance.status = "waiting_lead"
        try:
            from app.services import event_broadcaster

            await event_broadcaster.publish(
                "subagent_status",
                {
                    "lead_session_id": instance.lead_session_id,
                    "session_id": instance.session_id,
                    "handle": instance.handle,
                    "status": instance.status,
                    "workspace": getattr(instance.session, "workspace", ""),
                },
            )
        except Exception as exc:
            logger.debug("Failed to publish subagent_status: {}", exc)
        q_text = instance.pending_lead_question.get("question", "")
        opts = instance.pending_lead_question.get("options")
        opts_text = f" (Options: {', '.join(opts)})" if opts else ""
        if not getattr(instance, "_question_delivered", False):
            try:
                from app.services.chat_service import save_message
                from app.agent.schemas.chat import HumanMessage

                async with db_factory() as db:
                    await save_message(
                        db,
                        UUID(instance.lead_session_id),
                        HumanMessage(
                            content=f"Question: {q_text}{opts_text}",
                            extra={"from_agent": instance.handle},
                        ),
                    )
                instance._question_delivered = True
            except Exception as exc:
                logger.debug("Failed to persist subagent question to lead: {}", exc)

        return {
            "status": "waiting_lead",
            "member_id": instance.handle,
            "question": instance.pending_lead_question.get("question"),
            "options": instance.pending_lead_question.get("options"),
            "message": (
                f"Subagent '{instance.handle}' suspended turn with question: "
                f"{instance.pending_lead_question.get('question')}"
            ),
        }

    # Check if turn failed with error
    if instance.session.state == "error":
        instance.status = "error"
        err_msg = (
            getattr(instance.session, "_last_error", None)
            or instance.last_error
            or "Subagent turn failed with error."
        )
        instance.last_error = err_msg
        return {
            "status": "error",
            "member_id": instance.handle,
            "error": err_msg,
            "message": f"Subagent '{instance.handle}' failed: {err_msg}",
        }

    # Turn completed: extract final assistant message
    instance.status = "completed"
    status_payload = {
        "lead_session_id": instance.lead_session_id,
        "session_id": instance.session_id,
        "handle": instance.handle,
        "status": instance.status,
        "workspace": getattr(instance.session, "workspace", ""),
    }
    try:
        from app.services import event_broadcaster
        from app.services import memory_stream_store as stream_store
        from app.services.stream_envelope import StreamEnvelope

        await event_broadcaster.publish("subagent_status", status_payload)
        await stream_store.push_event(
            instance.lead_session_id,
            StreamEnvelope.from_parts("subagent_status", status_payload),
            create_if_missing=True,
        )
    except Exception as exc:
        logger.debug("Failed to publish subagent_status: {}", exc)
    output = instance.last_result
    if not output:
        # Fall back to DB transcript for final assistant message
        async with db_factory() as db:
            stmt = (
                select(SessionMessage)
                .where(col(SessionMessage.session_id) == UUID(instance.session_id))
                .where(col(SessionMessage.role) == "assistant")
                .order_by(
                    col(SessionMessage.seq).desc(),
                    col(SessionMessage.id).desc(),
                )
                .limit(1)
            )
            last_msg = (await db.exec(stmt)).first()
            if last_msg and last_msg.content:
                output = last_msg.content

    instance.last_result = output

    if output and output.strip() and not getattr(instance, "_result_delivered", False):
        try:
            from app.services.chat_service import save_message
            from app.agent.schemas.chat import HumanMessage

            deliverable = prune_subagent_output(output, instance.session_id)
            async with db_factory() as db:
                await save_message(
                    db,
                    UUID(instance.lead_session_id),
                    HumanMessage(
                        content=deliverable,
                        extra={"from_agent": instance.handle},
                    ),
                )
            instance._result_delivered = True
        except Exception as exc:
            logger.debug("Failed to persist subagent message to lead: {}", exc)

    return {
        "status": "completed",
        "member_id": instance.handle,
        "output": output
        or f"Subagent '{instance.handle}' finished with no text output.",
    }


async def deliver_message_to_lead(
    *,
    lead_session_id: str,
    handle: str,
    content: str,
    db_factory: DbFactory | None = None,
) -> None:
    """Persist an inter-agent message to the lead session and activate its turn if idle."""
    from app.models.chat import ChatSession
    from app.services import agent_manager
    from app.services.chat_service import save_message
    from app.services.chat_service_queue import save_queued_user_message

    db_maker = resolve_db_factory(db_factory)
    lead_uuid = UUID(lead_session_id)

    # 1. Persist as queued user message in the lead session
    async with db_maker() as db:
        async with db.begin():
            await save_queued_user_message(
                db,
                lead_uuid,
                content,
                extra={"from_agent": handle},
                save_message=save_message,
            )

    # 2. Resolve live or persisted lead agent session
    lead_session = agent_manager.find_live_session_serving_session(lead_session_id)
    if lead_session is None:
        async with db_maker() as db:
            lead_row = await db.get(ChatSession, lead_uuid)
            if lead_row:
                ws = lead_row.workspace or str(Path.cwd())
                try:
                    lead_session = await agent_manager.get_or_start_agent_session(
                        ws, lead_session_id
                    )
                except Exception as exc:
                    logger.debug(
                        "Failed to get_or_start_agent_session for lead={}: {}",
                        lead_session_id,
                        exc,
                    )

    # 3. If lead session is available and not currently executing a turn, activate!
    if lead_session is not None:
        async with lead_session.user_message_lock:
            if not lead_session.has_active_user_turn():
                if lead_session.session_id != lead_session_id:
                    await lead_session.attach_to_session(lead_session_id)
                await lead_session._activate_queued_user_messages(lead_session_id)


async def on_subagent_turn_completed(
    *,
    lead_session_id: str,
    child_session_id: str,
    status: str,
    workspace: str = "",
    handle: str = "",
    db_factory: DbFactory | None = None,
    cancelled: bool = False,
) -> None:
    """Handle completion of an asynchronous subagent turn."""
    db_maker = resolve_db_factory(db_factory)
    inst = find_instance_by_session_id(lead_session_id, child_session_id)
    if inst is not None:
        inst.status = "completed" if status == "completed" else "error"
        effective_handle = inst.handle
    else:
        effective_handle = handle or f"subagent-{child_session_id[:8]}"

    status_payload = {
        "lead_session_id": lead_session_id,
        "session_id": child_session_id,
        "handle": effective_handle,
        "status": "completed" if status == "completed" else "error",
        "workspace": workspace,
    }
    try:
        from app.services import event_broadcaster
        from app.services import memory_stream_store as stream_store
        from app.services.stream_envelope import StreamEnvelope

        await event_broadcaster.publish("subagent_status", status_payload)
        await stream_store.push_event(
            lead_session_id,
            StreamEnvelope.from_parts("subagent_status", status_payload),
            create_if_missing=True,
        )
    except Exception as exc:
        logger.debug("subagent_status_broadcast_failed: {}", exc)

    if cancelled:
        return

    if inst and (
        inst.status in ("stopped", "cancelled") or inst.last_error == "Stopped by lead"
    ):
        return

    # Extract final output
    output: str | None = None
    if status == "completed":
        if inst and inst.last_result:
            output = inst.last_result
        if not output:
            async with db_maker() as db:
                stmt = (
                    select(SessionMessage)
                    .where(col(SessionMessage.session_id) == UUID(child_session_id))
                    .where(col(SessionMessage.role) == "assistant")
                    .order_by(
                        col(SessionMessage.seq).desc(),
                        col(SessionMessage.id).desc(),
                    )
                    .limit(1)
                )
                last_msg = (await db.exec(stmt)).first()
                if last_msg and last_msg.content:
                    output = last_msg.content
        if not output or not output.strip():
            output = (
                f"Subagent '{effective_handle}' completed task with no text output."
            )
        if inst:
            inst.last_result = output
            inst._result_delivered = True
    else:
        err = (
            getattr(inst, "last_error", None) if inst else None
        ) or "Subagent turn failed with error."
        output = f"Subagent '{effective_handle}' encountered an error: {err}"
        if inst:
            inst._result_delivered = True

    try:
        deliverable = prune_subagent_output(output, child_session_id)
        await deliver_message_to_lead(
            lead_session_id=lead_session_id,
            handle=effective_handle,
            content=deliverable,
            db_factory=db_maker,
        )
    except Exception as exc:
        logger.warning("Failed to deliver subagent result to lead: {}", exc)


async def on_subagent_question_asked(
    *,
    lead_session_id: str,
    child_session_id: str,
    suspended_data: dict[str, Any],
    db_factory: DbFactory | None = None,
) -> None:
    """Handle an ask_lead question suspension from an asynchronous subagent."""
    db_maker = resolve_db_factory(db_factory)
    inst = find_instance_by_session_id(lead_session_id, child_session_id)
    handle = inst.handle if inst else f"subagent-{child_session_id[:8]}"

    q_text = suspended_data.get("question", "")
    opts = suspended_data.get("options")
    opts_text = f" (Options: {', '.join(opts)})" if opts else ""
    content = (
        f"Question from {handle}: {q_text}{opts_text}\n"
        f"To reply, call delegate(profile='{inst.profile_name if inst else 'explorer'}', "
        f"target='{handle}', task='<your answer>')."
    )

    if inst:
        inst._question_delivered = True
        if "tool_call_id" in suspended_data and suspended_data["tool_call_id"]:
            setattr(inst, "_pending_tool_call_id", suspended_data["tool_call_id"])

    try:
        await deliver_message_to_lead(
            lead_session_id=lead_session_id,
            handle=handle,
            content=content,
            db_factory=db_maker,
        )
    except Exception as exc:
        logger.warning("Failed to deliver subagent question to lead: {}", exc)


async def send_subagent_message(
    *,
    lead_session_id: str,
    member_id: str,
    message: str,
    wait: bool = True,
    db_factory: DbFactory | None = None,
) -> dict[str, Any]:
    """Send follow-up instructions or answer a pending question for a member."""
    db_maker = resolve_db_factory(db_factory)
    instance = resolve_instance(lead_session_id, member_id)

    if instance.status == "waiting_lead":
        # Resolving suspended ask_lead turn
        instance.pending_lead_question = None
        instance.status = "working"
        instance._question_delivered = False
        instance._result_delivered = False

        # Write answer as tool result message for ask_lead
        tool_call_id = getattr(instance, "_pending_tool_call_id", None)
        if (
            not tool_call_id
            and hasattr(instance.session, "_lead_suspended")
            and instance.session._lead_suspended
        ):
            tool_call_id = instance.session._lead_suspended.get("tool_call_id")
        if tool_call_id:
            async with db_maker() as db:
                tool_msg = SessionMessage(
                    session_id=UUID(instance.session_id),
                    role="tool",
                    content=f"Lead answered: {message}",
                    tool_call_id=tool_call_id,
                    name="ask_lead",
                )
                db.add(tool_msg)
                await db.commit()

        # Resume the turn
        await instance.session.resume_after_question_answer()
    else:
        # New instruction turn
        instance.status = "working"
        instance._question_delivered = False
        instance._result_delivered = False
        await instance.session.handle_user_message(
            content=f"[Lead]: {message}",
            session_id=instance.session_id,
            origin="agent",
        )

    if wait:
        return await _await_member_turn(instance, db_maker)

    instance.task_handle = instance.session._active_task
    return {
        "status": "sent",
        "member_id": instance.handle,
        "message": f"Message delivered to '{instance.handle}' in background.",
    }


async def list_subagents(
    lead_session_id: str,
    db_factory: DbFactory | None = None,
) -> dict[str, Any]:
    """List available profiles, active instances, and persisted sub-sessions under a lead session."""
    agents_dir = _resolve_agents_dir()
    profiles = load_member_profiles(agents_dir)
    profile_summaries = [
        {"name": name, "description": p.description, "tools": p.tools}
        for name, p in sorted(profiles.items())
    ]

    live_map = _live_instances.get(lead_session_id, {})
    persisted_members: list[dict[str, Any]] = []
    seen_handles: set[str] = set()

    try:
        db_maker = resolve_db_factory(db_factory)
        lead_uuid = UUID(lead_session_id)
        async with db_maker() as db:
            stmt = (
                select(ChatSession)
                .where(col(ChatSession.parent_session_id) == lead_uuid)
                .order_by(col(ChatSession.created_at).asc())
            )
            rows = (await db.exec(stmt)).all()
            for row in rows:
                handle = row.agent_name or str(row.id)
                seen_handles.add(handle)
                live_inst = live_map.get(handle)
                if live_inst is not None:
                    if live_inst.status == "working":
                        active_task = getattr(live_inst.session, "_active_task", None)
                        if active_task is not None and active_task.done():
                            live_inst.status = "completed"
                    status = live_inst.status
                    last_error = live_inst.last_error
                    has_pending_question = live_inst.pending_lead_question is not None
                else:
                    status = "completed"
                    last_error = None
                    has_pending_question = False

                parsed = parse_instance_handle(handle)
                profile_name = parsed[0] if parsed else handle

                persisted_members.append(
                    {
                        "member_id": handle,
                        "profile": profile_name,
                        "title": row.title or handle,
                        "status": status,
                        "session_id": str(row.id),
                        "created_at": (
                            row.created_at.isoformat() if row.created_at else None
                        ),
                        "last_error": last_error,
                        "has_pending_question": has_pending_question,
                    }
                )
    except Exception as exc:
        logger.debug(
            "Database lookup skipped in list_subagents for lead={}: {}",
            lead_session_id,
            exc,
        )

    for inst in sorted(live_map.values(), key=lambda i: i.handle):
        if inst.handle not in seen_handles:
            persisted_members.append(
                {
                    "member_id": inst.handle,
                    "profile": inst.profile_name,
                    "title": inst.handle,
                    "status": inst.status,
                    "session_id": inst.session_id,
                    "created_at": None,
                    "last_error": inst.last_error,
                    "has_pending_question": inst.pending_lead_question is not None,
                }
            )

    return {
        "available_profiles": profile_summaries,
        "live_members": persisted_members,
        "subagents": persisted_members,
    }


async def wait_subagents(
    *,
    lead_session_id: str,
    member_ids: list[str] | None = None,
    timeout: int = 120,
    db_factory: DbFactory | None = None,
) -> dict[str, Any]:
    """Wait for specified or all live members to complete their turns."""
    db_maker = resolve_db_factory(db_factory)
    instances = _live_instances.get(lead_session_id, {})

    if member_ids:
        targets = [resolve_instance(lead_session_id, m) for m in member_ids]
    else:
        targets = list(instances.values())

    if not targets:
        return {"message": "No subagents to wait for.", "results": {}}

    tasks = []
    for inst in targets:
        if inst.task_handle and not inst.task_handle.done():
            tasks.append(inst.task_handle)

    if tasks:
        done, pending = await asyncio.wait(tasks, timeout=float(timeout))
        for p in pending:
            logger.warning("wait_subagents_pending task={}", p)

    # Collect results
    results = {}
    for inst in targets:
        res = await _await_member_turn(inst, db_maker)
        results[inst.handle] = res

    return {"status": "completed", "results": results}


async def stop_subagent(lead_session_id: str, member_id: str) -> dict[str, Any]:
    """Stop a single subagent instance."""
    instance = resolve_instance(lead_session_id, member_id)
    if instance.task_handle and not instance.task_handle.done():
        instance.task_handle.cancel()
    await instance.session.handle_stop()
    instance.status = "error"
    instance.last_error = "Stopped by lead"
    return {
        "status": "stopped",
        "member_id": instance.handle,
        "message": f"Subagent '{instance.handle}' was stopped.",
    }


async def stop_all_subagents(lead_session_id: str) -> None:
    """Stop and cancel all subagents under a lead session."""
    instances = _live_instances.get(lead_session_id, {})
    for inst in instances.values():
        if inst.task_handle and not inst.task_handle.done():
            inst.task_handle.cancel()
        if inst.status not in ("completed", "error"):
            try:
                await inst.session.handle_stop()
            except Exception as exc:
                logger.warning(
                    "stop_subagent_failed handle={} error={}", inst.handle, exc
                )
        inst.status = "error"
    logger.info("stopped_all_subagents lead_session_id={}", lead_session_id)


def remove_subagent(child_session_id: str) -> bool:
    """Stop and remove a subagent instance by child session ID.

    Returns True if an instance was found and removed.
    """
    removed = False
    for lead_id, instances in list(_live_instances.items()):
        to_delete = [
            handle
            for handle, inst in instances.items()
            if inst.session_id == child_session_id
        ]
        for handle in to_delete:
            inst = instances.pop(handle)
            removed = True
            if inst.task_handle and not inst.task_handle.done():
                inst.task_handle.cancel()
            if inst.status not in ("completed", "error"):
                try:
                    asyncio.create_task(inst.session.handle_stop())
                except Exception:
                    pass
        if not instances:
            _live_instances.pop(lead_id, None)
    return removed


def cleanup_lead_session(lead_session_id: str) -> None:
    """Stop all subagents and clean up all in-memory tracking for a lead session."""
    instances = _live_instances.pop(lead_session_id, {})
    for inst in instances.values():
        if inst.task_handle and not inst.task_handle.done():
            inst.task_handle.cancel()
        if inst.status not in ("completed", "error"):
            try:
                asyncio.create_task(inst.session.handle_stop())
            except Exception:
                pass
    _instance_counters.pop(lead_session_id, None)
    _reconciled_lead_sessions.discard(lead_session_id)
