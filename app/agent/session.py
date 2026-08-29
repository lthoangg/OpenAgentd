"""Single-agent session runtime and coordinator."""

from __future__ import annotations

import asyncio
import contextlib
import uuid
from pathlib import Path
from typing import Any, Literal

from loguru import logger
from sqlmodel import col, select

from app.agent.agent_loop import Agent
from app.agent.checkpointer import SQLiteCheckpointer
from app.agent.denied_paths import (
    DeniedPathsConfig,
    _denied_paths_ctx,
    set_denied_paths,
)
from app.agent.drift import detect_drift, stamp_agent_files
from app.agent.errors import (
    ProviderAuthenticationError,
    ProviderConnectionError,
    ProviderRateLimitError,
    ProviderRequestError,
    QuestionSuspended,
    format_agent_error,
)
from app.agent.hooks.base import BaseAgentHook
from app.agent.hooks.dynamic_prompt import inject_current_date
from app.agent.hooks.lsp import LspHook
from app.agent.hooks.otel import OpenTelemetryHook
from app.agent.hooks.queued_injection import QueuedMessageInjectionHook
from app.agent.hooks.stream_publisher import StreamPublisherHook
from app.agent.hooks.summarization import build_summarization_hook
from app.agent.hooks.title_generation import build_title_generation_hook
from app.agent.hooks.tool_result_offload import ToolResultOffloadHook
from app.agent.hooks.workspace_instructions import WorkspaceInstructionsHook
from app.agent.permission import (
    AutoAllowPermissionService,
    _permission_ctx,
    set_permission_service,
)
from app.agent.providers.base import LLMProviderBase
from app.agent.providers.factory import ProviderFactory, build_provider
from app.agent.providers.unconfigured import UnconfiguredProviderError
from app.agent.schemas.agent import RunConfig
from app.agent.schemas.chat import HumanMessage
from app.agent.schemas.events import DoneEvent
from app.agent.tools.builtin.question import make_ask_user_tool
from app.agent.tools.registry import Tool
from app.core.db import DbFactory, resolve_db_factory
from app.core.paths import session_workspace_dir
from app.models.chat import ChatSession, SessionMessage
from app.services import memory_stream_store as stream_store
from app.services.chat_service import (
    BoundaryShift,
    cleanup_reverted_tail,
    get_messages_for_llm,
    heal_orphaned_tool_calls,
    pop_queued_user_messages,
    redo_all_session_messages,
    redo_session_messages,
    save_message,
    undo_session_messages,
)
from app.services.stream_envelope import StreamEnvelope


def _normalize_question_status(
    status: str,
) -> Literal["answered", "dismissed", "superseded", "expired"]:
    if status == "answered":
        return "answered"
    if status == "superseded":
        return "superseded"
    if status == "expired":
        return "expired"
    return "dismissed"


class QuestionPendingError(Exception):
    """Raised when an operation cannot proceed because a question is pending."""

    def __init__(self, session_id: str) -> None:
        super().__init__(
            f"Session {session_id} is awaiting answer to pending question."
        )
        self.session_id = session_id


class ContinuePreconditionError(Exception):
    """Raised when /continue is called while the agent is still running."""

    def __init__(self, message: str = "Precondition failed", status: int = 409) -> None:
        super().__init__(message)
        self.status = status
        self.reason = message


class AlreadyWorkingError(Exception):
    """Raised when the agent is already running a turn."""

    def __init__(self, agent_name: str) -> None:
        super().__init__(
            f"Cannot continue while {agent_name} is working — "
            "wait for the current turn to finish."
        )
        self.agent_name = agent_name


async def _mark_last_assistant_interrupted(
    db_factory: DbFactory, session_id: uuid.UUID
) -> None:
    try:
        async with resolve_db_factory(db_factory)() as db:
            stmt = (
                select(SessionMessage)
                .where(col(SessionMessage.session_id) == session_id)
                .where(col(SessionMessage.role) == "assistant")
                .order_by(col(SessionMessage.created_at).desc())
                .limit(1)
            )
            result = await db.exec(stmt)
            msg = result.first()
            if msg is not None:
                existing = msg.extra or {}
                msg.extra = {**existing, "interrupted": True}
                db.add(msg)
                await db.commit()
    except Exception as exc:
        logger.warning(
            "mark_interrupted_failed session_id={} error={}", session_id, exc
        )


def _schedule_provider_close(provider: LLMProviderBase | None) -> None:
    if provider is None:
        return
    close_coro = getattr(provider, "aclose", None) or getattr(provider, "close", None)
    if close_coro is None:
        return

    async def _safe_close() -> None:
        try:
            res = close_coro()
            if asyncio.iscoroutine(res):
                await res
        except Exception as exc:
            logger.warning("provider_close_failed error={}", exc)

    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_safe_close())
    except RuntimeError:
        pass


async def _close_provider(provider: LLMProviderBase | None) -> None:
    if provider is None:
        return
    close_coro = getattr(provider, "aclose", None) or getattr(provider, "close", None)
    if close_coro is None:
        return
    try:
        res = close_coro()
        if asyncio.iscoroutine(res):
            await res
    except Exception as exc:
        logger.warning("provider_close_failed error={}", exc)


class AgentSession:
    """Single-agent execution runtime and coordinator."""

    def __init__(
        self,
        agent: Agent,
        *,
        session_id: str | None = None,
        workspace: str | None = None,
        db_factory: DbFactory | None = None,
        provider_factory: ProviderFactory | None = None,
        extra_tools: dict[str, Tool] | None = None,
    ) -> None:
        self.agent = agent
        self.session_id = session_id or str(uuid.uuid4())
        self.workspace = workspace or ""
        self.db_factory = resolve_db_factory(db_factory)
        self.provider_factory = provider_factory or build_provider
        self.extra_tools = extra_tools or {}

        self.state: str = "idle"  # idle | working | waiting_input | offline | error
        self._cancel_event = asyncio.Event()
        self._user_message_lock = asyncio.Lock()
        self._command_lock = asyncio.Lock()
        self._has_active_turn: bool = False
        self._active_task: asyncio.Task | None = None
        self._config_dirty: bool = False
        self._question_suspended: dict[str, Any] | None = None
        self.is_scheduler_session: bool = False

    @property
    def name(self) -> str:
        return self.agent.name

    @property
    def model_id(self) -> str:
        return self.agent.model_id or ""

    @property
    def user_message_lock(self) -> asyncio.Lock:
        return self._user_message_lock

    def is_busy(self) -> bool:
        return self.state in {"working", "waiting_input"} or self._has_active_turn

    def has_active_user_turn(self) -> bool:
        return self._has_active_turn or self.is_busy()

    def is_awaiting_question_answer(self) -> bool:
        return self.state == "waiting_input"

    async def start(self) -> None:
        logger.info(
            "agent_session_started agent={} session_id={}", self.name, self.session_id
        )

    async def stop(self) -> None:
        self._cancel_event.set()
        if self._active_task and not self._active_task.done():
            self._active_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._active_task
        self.state = "offline"
        logger.info("agent_session_stopped session_id={}", self.session_id)

    async def _emit(
        self,
        event: str,
        status: str | None = None,
        extra: dict[str, Any] | None = None,
    ) -> None:
        payload: dict[str, Any] = {"type": event, "agent": self.name}
        if status is not None:
            payload["status"] = status
        if extra:
            payload.update(extra)

        envelope = StreamEnvelope.from_parts(event, payload)
        try:
            await stream_store.push_event(self.session_id, envelope)
        except Exception as exc:
            logger.warning("session_emit_failed event={} error={}", event, exc)

    async def attach_to_session(
        self, session_id: str, *, title: str | None = None
    ) -> None:
        self.session_id = session_id
        await self._ensure_db_session(title=title, workspace=self.workspace)

    async def _ensure_db_session(
        self,
        title: str | None = None,
        workspace: str | None = None,
    ) -> None:
        if not self.db_factory:
            return
        try:
            sess_uuid = uuid.UUID(self.session_id)
        except ValueError:
            return
        async with self.db_factory() as db:
            row = await db.get(ChatSession, sess_uuid)
            if row is None:
                row = ChatSession(
                    id=sess_uuid,
                    agent_name=self.name,
                    title=title,
                    workspace=workspace or self.workspace or "",
                    model=self.agent.model_id,
                )
                db.add(row)
                await db.commit()
            else:
                updated = False
                if workspace and not row.workspace:
                    row.workspace = workspace
                    updated = True
                if title and not row.title:
                    row.title = title
                    updated = True
                if updated:
                    db.add(row)
                    await db.commit()

    def _detect_config_drift(self) -> None:
        if self.agent.source_path is None or self.agent.config_stamp is None:
            return
        drifted = detect_drift(self.agent.config_stamp)
        if drifted:
            self._config_dirty = True
            logger.info(
                "agent_config_dirty name={} paths={}",
                self.name,
                [Path(p).name for p in drifted],
            )

    def _refresh_agent_from_disk(self) -> None:
        from app.agent.loader import rebuild_agent_from_disk

        source = self.agent.source_path
        if source is None:
            self._config_dirty = False
            return

        try:
            new_agent = rebuild_agent_from_disk(source, mode="coding")
        except Exception as exc:
            logger.warning(
                "agent_config_refresh_failed name={} error={}", self.name, exc
            )
            from app.agent.mcp.config import config_path as _mcp_config_path

            self.agent.config_stamp = stamp_agent_files(
                agent_md_path=source,
                mcp_config_path=_mcp_config_path(),
            )
            self._config_dirty = False
            return

        old_agent = self.agent
        self.agent = new_agent
        _schedule_provider_close(old_agent.llm_provider)
        self._config_dirty = False
        logger.info(
            "agent_config_refreshed name={} model={} tools={}",
            self.name,
            new_agent.model_id,
            sorted(new_agent._tools.keys()),
        )

    async def _has_open_question(self) -> bool:
        if not self.db_factory:
            return False
        from app.services import question_service

        try:
            async with self.db_factory() as db:
                pending = await question_service.get_pending_question(
                    db, uuid.UUID(self.session_id)
                )
                return pending is not None
        except Exception:
            return False

    async def dismiss_pending_question(
        self, reason: str = "dismissed", session_id: str | None = None
    ) -> None:
        if not self.db_factory:
            return
        target_sid = session_id or self.session_id
        if not target_sid:
            return
        from app.services import question_service

        try:
            async with self.db_factory() as db:
                pending = await question_service.get_pending_question(
                    db, uuid.UUID(str(target_sid))
                )
                if pending is not None:
                    await question_service.resolve_pending_question(
                        db,
                        question_id=pending.id,
                        status=_normalize_question_status(reason),
                    )
                    await db.commit()
        except Exception as exc:
            logger.warning("dismiss_pending_question_failed error={}", exc)

    async def handle_user_message(
        self,
        content: str,
        session_id: str,
        interrupt: bool = False,
        attachment_metas: list[dict] | None = None,
        mention_context_blocks: list[str] | None = None,
        workspace: str | None = None,
        model: str | None = None,
        model_provided: bool = False,
        thinking_level: str | None = None,
        thinking_level_provided: bool = False,
        service_tier: str | None = None,
        mentions: list[str] | None = None,
        origin: str = "user",
    ) -> tuple[str, str]:
        if workspace is not None:
            self.workspace = workspace

        is_new_session = self.session_id != session_id
        if is_new_session:
            await self.attach_to_session(
                session_id, title=content[:100] if content else None
            )

        if await self._has_open_question():
            if origin != "user":
                logger.info(
                    "question_deferred_machine_message session_id={} origin={}",
                    session_id,
                    origin,
                )
                raise QuestionPendingError(session_id)
            await self.dismiss_pending_question(reason="superseded")

        if interrupt and self.is_busy():
            self._cancel_event.set()
            await self.dismiss_pending_question(reason="dismissed")

        db_factory = self.db_factory
        sess_uuid = uuid.UUID(session_id)
        async with db_factory() as db:
            await heal_orphaned_tool_calls(db, sess_uuid)

            sess_row = await db.get(ChatSession, sess_uuid)
            if sess_row is not None:
                sess_row.workspace = self.workspace or ""
                if model_provided:
                    sess_row.model = model
                if thinking_level_provided:
                    sess_row.thinking_level = thinking_level
                self.is_scheduler_session = sess_row.scheduled_task_name is not None
                db.add(sess_row)
                await db.commit()

        extra: dict[str, Any] = {}
        if attachment_metas:
            extra["attachments"] = attachment_metas
        if model_provided:
            extra["model"] = model
        if thinking_level_provided:
            extra["thinking_level"] = thinking_level
        if service_tier is not None:
            extra["service_tier"] = service_tier
        if mentions:
            extra["mentions"] = mentions

        user_msg = HumanMessage(content=content, extra=extra)
        async with db_factory() as db:
            persisted = await save_message(db, sess_uuid, user_msg)
            user_msg.db_id = persisted.id
            await db.commit()

        if mention_context_blocks:
            note_extra: dict[str, Any] = {"hidden_from_summary": True}
            if mentions:
                note_extra["mentions"] = mentions
            note_msg = HumanMessage(
                content="\n\n".join(mention_context_blocks),
                extra=note_extra,
            )
            async with db_factory() as db:
                await save_message(db, sess_uuid, note_msg, kind="note", pinned=True)
                await db.commit()

        await stream_store.init_turn(session_id, keep_subscribers=True)
        self.state = "working"
        self._cancel_event.clear()
        self._has_active_turn = True
        self._active_task = asyncio.create_task(self._run_turn())
        return session_id, str(user_msg.db_id)

    async def handle_stop(self) -> bool:
        if not self.is_busy():
            return False
        self._cancel_event.set()
        if self._active_task and not self._active_task.done():
            self._active_task.cancel()
        await self.dismiss_pending_question(reason="dismissed")
        self.state = "idle"
        await self._emit("agent_status", status="idle")
        return True

    async def handle_continue(
        self,
        session_id: str,
        workspace: str | None = None,
        model: str | None = None,
        thinking_level: str | None = None,
    ) -> tuple[str, str]:
        if self.is_busy():
            raise ContinuePreconditionError("Cannot continue while agent is busy.")

        if workspace is not None:
            self.workspace = workspace
        if self.session_id != session_id:
            await self.attach_to_session(session_id)

        await stream_store.init_turn(session_id, keep_subscribers=True)
        self.state = "working"
        self._cancel_event.clear()
        self._has_active_turn = True
        self._active_task = asyncio.create_task(
            self._run_turn(
                runtime_model=model,
                runtime_thinking_level=thinking_level,
            )
        )
        return session_id, str(uuid.uuid4())

    async def handle_compact(
        self,
        session_id: str,
        workspace: str | None = None,
    ) -> str:
        if self.is_busy():
            raise ContinuePreconditionError("Cannot compact while agent is busy.")
        if self.session_id != session_id:
            await self.attach_to_session(session_id)

        await stream_store.init_turn(session_id, keep_subscribers=True)
        self.state = "working"
        self._cancel_event.clear()
        self._has_active_turn = True
        self._active_task = asyncio.create_task(self._run_turn(force_compaction=True))
        return session_id

    async def handle_undo(self, session_id: str) -> tuple[str, BoundaryShift]:
        if self.is_busy():
            raise ContinuePreconditionError("Cannot undo while agent is busy.")
        sess_uuid = uuid.UUID(session_id)
        async with self._command_lock:
            async with self.db_factory() as db:
                shift = await undo_session_messages(db, sess_uuid)
                await db.commit()
                return session_id, shift

    async def handle_redo(self, session_id: str) -> tuple[str, BoundaryShift]:
        if self.is_busy():
            raise ContinuePreconditionError("Cannot redo while agent is busy.")
        sess_uuid = uuid.UUID(session_id)
        async with self._command_lock:
            async with self.db_factory() as db:
                shift = await redo_session_messages(db, sess_uuid)
                await db.commit()
                return session_id, shift

    async def handle_redo_all(self, session_id: str) -> tuple[str, BoundaryShift]:
        if self.is_busy():
            raise ContinuePreconditionError("Cannot redo while agent is busy.")
        sess_uuid = uuid.UUID(session_id)
        async with self._command_lock:
            async with self.db_factory() as db:
                shift = await redo_all_session_messages(db, sess_uuid)
                await db.commit()
                return session_id, shift

    async def _activate_queued_user_messages(self, session_id: str) -> bool:
        if not self.db_factory:
            return False
        sess_uuid = uuid.UUID(session_id)
        async with self.db_factory() as db:
            queued = await pop_queued_user_messages(db, sess_uuid)
            await db.commit()
        if not queued:
            return False
        message_ids = [str(row.id) for row in queued]
        messages_data = [
            {"id": str(row.id), "content": row.content or ""} for row in queued
        ]
        self._cancel_event.clear()
        self._has_active_turn = True
        self._active_task = asyncio.create_task(
            self._run_turn(
                queued_activation_event={
                    "type": "queued_turn_start",
                    "agent": self.name,
                    "message_ids": message_ids,
                    "messages": messages_data,
                }
            )
        )
        return True

    async def handle_question_answer(
        self, question_id: uuid.UUID, answers: list[list[str]]
    ) -> None:
        from app.services import question_service

        async with self.db_factory() as db:
            await question_service.resolve_pending_question(
                db, question_id=question_id, status="answered", answers=answers
            )
            await db.commit()

        await stream_store.init_turn(self.session_id, keep_subscribers=True)
        self._question_suspended = None
        self.state = "working"
        await self._emit("agent_status", status="working")
        self._cancel_event.clear()
        self._has_active_turn = True
        self._active_task = asyncio.create_task(self._run_turn(question_resume=True))

    async def handle_question_dismiss(
        self, question_id: uuid.UUID, reason: str = "dismissed"
    ) -> None:
        from app.services import question_service

        async with self.db_factory() as db:
            await question_service.resolve_pending_question(
                db,
                question_id=question_id,
                status=_normalize_question_status(reason),
            )
            await db.commit()

        self._question_suspended = None
        self.state = "idle"
        await self._emit("agent_status", status="idle")

    async def _run_turn(
        self,
        *,
        force_compaction: bool = False,
        question_resume: bool = False,
        runtime_model: str | None = None,
        runtime_thinking_level: str | None = None,
        queued_activation_event: dict[str, Any] | None = None,
    ) -> None:
        if self.session_id:
            await stream_store.init_turn(self.session_id, keep_subscribers=True)
        self.state = "working"
        self._question_suspended = None
        await self._emit("agent_status", status="working")
        if queued_activation_event and self.session_id:
            try:
                await stream_store.push_event(
                    self.session_id,
                    StreamEnvelope.from_parts(
                        "queued_turn_start",
                        queued_activation_event,
                    ),
                )
            except Exception as exc:
                logger.warning("queued_activation_emit_failed error={}", exc)

        self._detect_config_drift()
        if self._config_dirty:
            self._refresh_agent_from_disk()

        try:
            await self._execute_turn(
                force_compaction=force_compaction,
                question_resume=question_resume,
                runtime_model=runtime_model,
                runtime_thinking_level=runtime_thinking_level,
            )
        except Exception as exc:
            if isinstance(
                exc,
                (
                    ProviderRateLimitError,
                    ProviderAuthenticationError,
                    ProviderRequestError,
                    ProviderConnectionError,
                    UnconfiguredProviderError,
                    RuntimeError,
                ),
            ):
                logger.warning("agent_session_error name={} error={}", self.name, exc)
            else:
                logger.exception("agent_session_error name={} error={}", self.name, exc)
            self.state = "error"
            err_info = format_agent_error(exc, agent_name=self.name)
            await self._emit(
                "agent_status",
                status="error",
                extra={
                    "message": err_info["message"],
                    "title": err_info["title"],
                    "code": err_info["code"],
                    "category": err_info["category"],
                },
            )
        finally:
            activated = False
            if self.state != "error" and self._question_suspended is not None:
                self.state = "waiting_input"
                await self._emit(
                    "agent_status",
                    status="waiting_input",
                    extra={"question_id": str(self._question_suspended["question_id"])},
                )
            elif self.state != "error":
                if self.session_id and not self._cancel_event.is_set():
                    activated = await self._activate_queued_user_messages(
                        self.session_id
                    )

                if not activated:
                    self.state = "idle"
                    await self._emit("agent_status", status="idle")
                    await stream_store.push_event(
                        self.session_id,
                        StreamEnvelope.from_event(
                            DoneEvent(metadata={"session_id": self.session_id})
                        ),
                        create_if_missing=True,
                    )
                    await stream_store.mark_done(self.session_id)
            else:
                await stream_store.mark_done(self.session_id)

            if not activated:
                self._has_active_turn = False
            self._detect_config_drift()

    async def _execute_turn(
        self,
        *,
        force_compaction: bool = False,
        question_resume: bool = False,
        runtime_model: str | None = None,
        runtime_thinking_level: str | None = None,
    ) -> None:
        sess_uuid = uuid.UUID(self.session_id)

        # Load session history from DB
        async with self.db_factory() as db:
            await cleanup_reverted_tail(db, sess_uuid)
            sess_row = await db.get(ChatSession, sess_uuid)
            if sess_row is not None:
                if not runtime_model:
                    runtime_model = sess_row.model
                if not runtime_thinking_level:
                    runtime_thinking_level = sess_row.thinking_level

            history = await get_messages_for_llm(db, sess_uuid)

        publisher_hook = StreamPublisherHook(
            session_id=self.session_id,
            agent_name=self.name,
            publish_reasoning=True,
        )
        effective_model = runtime_model or self.agent.model_id
        runtime_provider: LLMProviderBase | None = None
        if effective_model and (runtime_model or runtime_thinking_level is not None):
            kwargs: dict[str, object] = {}
            if runtime_thinking_level is not None:
                kwargs["thinking_level"] = runtime_thinking_level
            runtime_provider = self.provider_factory(
                effective_model,
                model_kwargs=kwargs or None,
            )

        provider_for_hooks = runtime_provider or self.agent.llm_provider

        otel_hook = OpenTelemetryHook(
            agent_name=self.name,
            model_id=effective_model,
        )

        hooks: list[BaseAgentHook] = [
            inject_current_date,
            publisher_hook,
            otel_hook,
            LspHook(enabled=True),
        ]

        hooks.append(
            QueuedMessageInjectionHook(
                session_id=self.session_id,
                agent_name=self.name,
                db_factory=self.db_factory,
                support_interrupt=provider_for_hooks.support_interrupt,
            )
        )
        hooks.append(WorkspaceInstructionsHook(self.workspace))

        title_hook = build_title_generation_hook(
            default_provider=provider_for_hooks,
            db_factory=self.db_factory,
        )
        if title_hook is not None:
            hooks.append(title_hook)

        checkpointer = SQLiteCheckpointer(
            self.db_factory,
            stream_session_id=self.session_id,
            agent_name=self.name,
        )
        checkpointer.mark_loaded(self.session_id, history)
        hooks.append(ToolResultOffloadHook())

        summ_hook = build_summarization_hook(
            provider_for_hooks,
            mode="coding",
            model_id=effective_model,
            support_interrupt=provider_for_hooks.support_interrupt,
        )
        if summ_hook:
            hooks.append(summ_hook)

        injected_tools: list[Tool] = []
        if not self.is_scheduler_session:
            injected_tools.append(
                make_ask_user_tool(self.session_id, self.db_factory, self.name)
            )

        run_metadata: dict[str, Any] = {"session_id": self.session_id}
        if question_resume:
            run_metadata["question_resume"] = True
        if force_compaction:
            run_metadata["force_summarization"] = True
            run_metadata["stop_after_before_model"] = True
        if self.workspace:
            run_metadata["workspace"] = self.workspace

        config = RunConfig(session_id=self.session_id, metadata=run_metadata)

        workspace_path = str(session_workspace_dir(self.session_id, self.workspace))
        session_sandbox = DeniedPathsConfig(
            workspace=workspace_path, session_id=self.session_id
        )
        token = set_denied_paths(session_sandbox)
        permission_service = AutoAllowPermissionService(session_id=self.session_id)
        perm_token = set_permission_service(permission_service)
        try:
            await self.agent.run(
                history,
                config=config,
                checkpointer=checkpointer,
                hooks=hooks,
                injected_tools=injected_tools,
                llm_provider=runtime_provider,
                model_id=effective_model,
                interrupt_event=self._cancel_event,
            )
        except QuestionSuspended as suspended:
            self._question_suspended = {
                "question_id": suspended.question_id,
                "session_id": suspended.session_id,
            }
        finally:
            if runtime_provider is not None:
                await _close_provider(runtime_provider)
            _denied_paths_ctx.reset(token)
            _permission_ctx.reset(perm_token)

        if self._cancel_event.is_set() and self.db_factory:
            await _mark_last_assistant_interrupted(self.db_factory, sess_uuid)
