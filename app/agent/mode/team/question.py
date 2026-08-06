"""``ask_user_question`` — hand the turn to the user, then resume where it left off.

Unlike every other tool, this one never returns a result to the model. It
persists the question plus a placeholder tool result (see
:mod:`app.services.question_service`) and raises
:class:`~app.agent.errors.QuestionSuspended`, which unwinds the agent loop so
the activation can exit cleanly. The turn resumes from the same point once the
user answers — see ``TeamMemberBase.activate_for_question_answer``.

Built per-agent by ``AgentTeam.get_injected_tools``, which is also where the
coding-mode lead gate lives: members never receive this tool and escalate
through ``team_message`` instead.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import TYPE_CHECKING, Annotated, Any

from loguru import logger
from pydantic import BaseModel, Field, field_validator, model_validator

from app.agent.errors import QuestionSuspended
from app.agent.tools.registry import InjectedArg, Tool
from app.core.db import resolve_db_factory
from app.models.chat import ChatSession

if TYPE_CHECKING:
    from app.agent.mode.team.team import AgentTeam


TOOL_NAME = "ask_user_question"

DESCRIPTION = """Ask the user one or more questions and wait for their answer before continuing.

Use this when you are blocked on a decision only the user can make — an ambiguous
requirement, a trade-off with no right answer, or a direction choice that would
waste real work if guessed wrong. Explore the codebase first: never ask something
the repository can answer.

Usage notes:
- You get ONE interruption per turn. Gather every open decision and ask them together.
- Ask after exploring and before implementing, not in the same batch as edits.
- Always mark your preferred choice with `recommended: true` so the user can accept it in one tap.
- A "Type your own answer" option is added automatically when `custom` is true (the default) — never add "Other" or catch-all options yourself.
- Do NOT use this to ask for approval to proceed, to report progress, or to collect secrets.
"""


class QuestionOption(BaseModel):
    """One selectable choice."""

    label: str = Field(
        min_length=1,
        max_length=60,
        description="Display text, 1-5 words. Shown on the button.",
    )
    description: str | None = Field(
        default=None,
        max_length=200,
        description="One short line explaining what picking this means.",
    )
    recommended: bool = Field(
        default=False,
        description=(
            "Mark your preferred choice. Single-select questions allow at most "
            "one; multi-select questions may mark several."
        ),
    )


class Question(BaseModel):
    """A single question with its choices."""

    question: str = Field(
        min_length=1, max_length=500, description="The complete question."
    )
    header: str = Field(
        min_length=1,
        max_length=30,
        description="Very short label for the question tab (max 30 chars).",
    )
    options: list[QuestionOption] = Field(
        default_factory=list,
        max_length=5,
        description="Available choices, 2-5. Omit for a free-text-only question.",
    )
    multiple: bool = Field(
        default=False, description="Allow selecting more than one option."
    )
    custom: bool = Field(
        default=True,
        description=(
            "Add a 'Type your own answer' option automatically. Leave true "
            "unless the choices are genuinely exhaustive."
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


class AskUserQuestionArgs(BaseModel):
    """Arguments for ``ask_user_question``."""

    questions: list[Question] = Field(
        min_length=1,
        max_length=4,
        description="Questions to ask, 1-4. Ask everything you need in one call.",
    )


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


def make_ask_user_question_tool(team: "AgentTeam") -> Tool:
    """Return the ``ask_user_question`` tool bound to *team*'s lead session.

    The session is bound at construction rather than taken from the model, so
    a question can only ever suspend the turn it was asked in.
    """

    async def ask_user_question(
        questions: list[Question],
        _tool_call_id: Annotated[str | None, InjectedArg()] = None,
        _state: Annotated[Any, InjectedArg()] = None,
    ) -> str:
        """Ask the user and suspend the turn until they answer."""
        from app.services import question_service

        if not _tool_call_id:
            # Without a call id there is nothing to resume: refuse rather than
            # strand the turn in a suspension nobody can resolve.
            logger.warning(
                "question_tool_missing_tool_call_id agent={}", team.lead.name
            )
            return (
                "Your question could not be delivered (no tool call id). "
                "Continue with your best judgment."
            )

        session_id = uuid.UUID(team.lead.session_id)
        payload = [question.model_dump() for question in questions]

        db_factory = resolve_db_factory(team.lead.db_factory)
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
        ask_user_question,
        name=TOOL_NAME,
        description=DESCRIPTION,
        args_schema=AskUserQuestionArgs,
    )
