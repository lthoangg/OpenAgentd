"""``ask_user`` — hand the turn to the user, then resume where it left off.

Unlike every other tool, this one never returns a result to the model. It
persists the question plus a placeholder tool result (see
:mod:`app.services.question_service`) and raises
:class:`~app.agent.errors.QuestionSuspended`, which unwinds the agent loop so
the activation can exit cleanly. The turn resumes from the same point once the
user answers — see ``SessionRuntime.activate_for_question_answer``.

Built per-agent by ``SessionRuntime.get_injected_tools``, which grants it only to
top-level coding sessions; child sessions report back to their parent
instead.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import TYPE_CHECKING, Annotated, Any

from loguru import logger
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.agent.errors import QuestionSuspended
from app.agent.tools.registry import InjectedArg, Tool
from app.core.db import resolve_db_factory
from app.models.chat import ChatSession

if TYPE_CHECKING:
    from app.agent.mode.team.runtime import SessionRuntime


TOOL_NAME = "ask_user"

DESCRIPTION = (
    "Ask the user 1-4 questions and pause the turn until they answer. "
    "Use only when blocked on a decision the repository cannot answer, never for "
    "approval or progress. One interruption per turn, so ask everything at once."
)


def _lean_schema(schema: dict[str, Any]) -> None:
    """Drop schema keys the model gains nothing from reading.

    Pydantic emits a ``title`` for the model and for every property, plus a
    ``description`` taken from the class docstring. The titles restate the key
    they sit under (``"header"`` → ``"title": "Header"``) and the docstrings
    restate the field descriptions, so all of it is tokens spent on every
    request for no added meaning. Nested models are the expensive case: this
    schema carried eleven such titles.

    Scoped to this tool deliberately — the same waste exists across every tool
    with a nested args model, but that is a cross-cutting change with its own
    blast radius.
    """
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
    """Publish the question to live clients and nudge an absent user.

    The SSE event carries the full payload so a client that reconnects mid-wait
    renders straight from the replay buffer instead of fetching.  The
    notification is what makes a suspended turn visible when the app is
    backgrounded — without it, a question on a phone is invisible.
    """
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
        # The question is already durable; a failed fan-out only costs the
        # client a fetch on reconnect.
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
                # ``mode``/``workspace`` are what the desktop click handler
                # routes on — same contract as the completion notification.
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


def make_ask_user_tool(runtime: "SessionRuntime") -> Tool:
    """Return the ``ask_user`` tool bound to *runtime*'s session.

    The session is bound at construction rather than taken from the model, so
    a question can only ever suspend the turn it was asked in.
    """

    async def ask_user(
        questions: list[Question],
        _tool_call_id: Annotated[str | None, InjectedArg()] = None,
        _state: Annotated[Any, InjectedArg()] = None,
    ) -> str:
        """Ask the user and suspend the turn until they answer."""
        from app.services import question_service

        if not _tool_call_id:
            # Without a call id there is nothing to resume: refuse rather than
            # strand the turn in a suspension nobody can resolve.
            logger.warning("question_tool_missing_tool_call_id agent={}", runtime.name)
            return (
                "Your question could not be delivered (no tool call id). "
                "Continue with your best judgment."
            )

        session_id = uuid.UUID(runtime.session_id)
        payload = [question.model_dump() for question in questions]

        db_factory = resolve_db_factory(runtime.db_factory)
        async with db_factory() as db:
            row = await question_service.create_pending_question(
                db,
                session_id=session_id,
                tool_call_id=_tool_call_id,
                questions=payload,
            )
            question_id = row.id
            # Read the session row in the same transaction — the notification
            # needs its title/workspace and this saves a second round trip.
            session_row = await db.get(ChatSession, session_id)
            title = session_row.title if session_row is not None else None
            workspace = session_row.workspace if session_row is not None else None
            await db.commit()

        await _announce(
            session_id=session_id,
            question_id=question_id,
            tool_call_id=_tool_call_id,
            payload=payload,
            title=title,
            workspace=workspace,
        )

        raise QuestionSuspended(question_id=question_id, session_id=session_id)

    return Tool(
        ask_user,
        name=TOOL_NAME,
        description=DESCRIPTION,
        args_schema=AskUserArgs,
    )
