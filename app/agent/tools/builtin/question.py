"""``ask_user`` — hand the turn to the user, then resume where it left off."""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Annotated, Any

from loguru import logger
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.agent.errors import QuestionSuspended
from app.agent.tools.registry import InjectedArg, Tool
from app.core.db import DbFactory, resolve_db_factory
from app.models.chat import ChatSession

TOOL_NAME = "ask_user"

DESCRIPTION = (
    "Ask the user 1-4 questions and pause the turn until they answer. "
    "Use only when blocked on a decision the repository cannot answer, never for "
    "approval or progress. Batch related questions together so you ask at once."
)


def _lean_schema(schema: dict[str, Any]) -> None:
    schema.pop("title", None)
    schema.pop("description", None)
    for prop in schema.get("properties", {}).values():
        prop.pop("title", None)


class QuestionOption(BaseModel):
    """One selectable choice."""

    model_config = ConfigDict(json_schema_extra=_lean_schema)

    label: str = Field(
        min_length=1, max_length=60, description="Display text, 1-5 words."
    )
    description: str | None = Field(
        default=None, max_length=200, description="One short line on what it means."
    )
    recommended: bool = Field(
        default=False,
        description="Your preferred choice. Only one unless multiple is true.",
    )


class Question(BaseModel):
    """A single question with its choices."""

    model_config = ConfigDict(json_schema_extra=_lean_schema)

    question: str = Field(
        min_length=1, max_length=500, description="The complete question."
    )
    header: str = Field(
        min_length=1, max_length=30, description="Tab label, max 30 chars."
    )
    options: list[QuestionOption] = Field(
        default_factory=list,
        max_length=5,
        description="Choices, 2-5. Omit for free text only.",
    )
    multiple: bool = Field(default=False, description="Allow more than one choice.")
    custom: bool = Field(
        default=True,
        description=(
            "Adds a 'Type your own answer' option. Leave true unless the "
            "choices are exhaustive; never write your own catch-all option."
        ),
    )

    @field_validator("options")
    @classmethod
    def _labels_unique(cls, value: list[QuestionOption]) -> list[QuestionOption]:
        labels = [option.label.strip().lower() for option in value]
        if len(labels) != len(set(labels)):
            raise ValueError("option labels must be unique within a question")
        return value

    @model_validator(mode="after")
    def _answerable_and_unambiguous(self) -> "Question":
        if not self.options and not self.custom:
            raise ValueError(
                "a question with no options must allow a custom answer "
                "(set custom=true or provide options)"
            )
        if not self.multiple:
            recommended = sum(option.recommended for option in self.options)
            if recommended > 1:
                raise ValueError(
                    "a single-select question may recommend at most one option; "
                    "set multiple=true to recommend several"
                )
        return self


def _coerce_questions(value: Any) -> Any:
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return value
        try:
            import json

            value = json.loads(text)
        except (json.JSONDecodeError, ValueError):
            return value
    if isinstance(value, dict):
        if "question" in value:
            return [value]
        if "questions" in value:
            return _coerce_questions(value["questions"])
    return value


class AskUserArgs(BaseModel):
    """Arguments for ``ask_user``."""

    model_config = ConfigDict(json_schema_extra=_lean_schema)

    questions: list[Question] = Field(
        min_length=1, max_length=4, description="Questions to ask, 1-4."
    )

    @model_validator(mode="before")
    @classmethod
    def _normalize_args(cls, values: Any) -> Any:
        if (
            isinstance(values, dict)
            and "questions" not in values
            and "question" in values
        ):
            return {"questions": [values]}
        return values

    @field_validator("questions", mode="before")
    @classmethod
    def _coerce(cls, value: Any) -> Any:
        return _coerce_questions(value)


async def _announce(
    *,
    session_id: uuid.UUID,
    question_id: uuid.UUID,
    tool_call_id: str,
    payload: list[dict[str, Any]],
    title: str | None,
    workspace: str | None,
) -> None:
    from app.agent.schemas.events import QuestionAskedEvent
    from app.services import event_broadcaster
    from app.services import memory_stream_store as stream_store
    from app.services.stream_envelope import StreamEnvelope

    sid = str(session_id)
    try:
        await stream_store.push_event(
            sid,
            StreamEnvelope.from_event(
                QuestionAskedEvent(
                    question_id=str(question_id),
                    session_id=sid,
                    tool_call_id=tool_call_id,
                    questions=payload,
                )
            ),
        )
    except Exception as exc:
        logger.warning("question_event_emit_failed session_id={} error={}", sid, exc)

    headline = payload[0].get("question", "") if payload else ""
    try:
        await event_broadcaster.publish(
            "desktop_notification",
            {
                "type": "desktop_notification",
                "notification_id": str(uuid.uuid4()),
                "kind": "input_needed",
                "session_id": sid,
                "title": (
                    f"Needs your input - {Path(workspace).name}"
                    if workspace
                    else "Needs your input"
                ),
                "body": headline or (title or "The agent has a question"),
                "metadata": {
                    "session_id": sid,
                    "question_id": str(question_id),
                    "mode": "coding",
                    "workspace": workspace,
                },
            },
        )
    except Exception as exc:
        logger.warning("question_notify_failed session_id={} error={}", sid, exc)


def make_ask_user_tool(
    session_id: str | uuid.UUID,
    db_factory: DbFactory,
    agent_name: str = "code",
) -> Tool:
    """Return the ``ask_user`` tool bound to *session_id*."""
    sess_uuid = (
        session_id if isinstance(session_id, uuid.UUID) else uuid.UUID(session_id)
    )

    async def ask_user(
        questions: list[Question],
        _tool_call_id: Annotated[str | None, InjectedArg()] = None,
        _state: Annotated[Any, InjectedArg()] = None,
    ) -> str:
        from app.services import question_service

        if not _tool_call_id:
            logger.warning("question_tool_missing_tool_call_id agent={}", agent_name)
            return (
                "Your question could not be delivered (no tool call id). "
                "Continue with your best judgment."
            )

        payload = [question.model_dump() for question in questions]

        resolved_db = resolve_db_factory(db_factory)
        async with resolved_db() as db:
            row = await question_service.create_pending_question(
                db,
                session_id=sess_uuid,
                tool_call_id=_tool_call_id,
                questions=payload,
            )
            question_id = row.id
            session_row = await db.get(ChatSession, sess_uuid)
            title = session_row.title if session_row is not None else None
            workspace = session_row.workspace if session_row is not None else None
            await db.commit()

        await _announce(
            session_id=sess_uuid,
            question_id=question_id,
            tool_call_id=_tool_call_id,
            payload=payload,
            title=title,
            workspace=workspace,
        )

        raise QuestionSuspended(question_id=question_id, session_id=sess_uuid)

    return Tool(
        ask_user,
        name=TOOL_NAME,
        description=DESCRIPTION,
        args_schema=AskUserArgs,
    )
