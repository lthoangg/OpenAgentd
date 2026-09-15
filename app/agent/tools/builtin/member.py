"""Member agent communication tools — send_to_lead and ask_lead."""

from __future__ import annotations

from typing import Annotated, Any

from pydantic import AliasChoices, BaseModel, Field, field_validator

from app.agent.errors import LeadSuspended
from app.agent.tools.registry import InjectedArg, Tool

_SEND_TO_LEAD_DESC = (
    "Send a message, progress update, or final deliverable back to the lead agent. "
    "Set end_turn=True when your assigned task is complete."
)

_ASK_LEAD_DESC = (
    "Ask the lead agent a clarifying question or request a decision when blocked by ambiguity. "
    "Pauses your turn until the lead responds."
)


class SendToLeadArgs(BaseModel):
    message: str = Field(
        min_length=1,
        validation_alias=AliasChoices("message", "content", "report", "text"),
        description="Findings, progress updates, or final deliverables for the lead agent.",
    )
    end_turn: bool = Field(
        default=False,
        description="Set to true if this completes your assigned task.",
    )

    @field_validator("message")
    @classmethod
    def _not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("message must not be blank")
        return v


class AskLeadArgs(BaseModel):
    question: str = Field(
        min_length=1,
        description="The specific decision, clarification, or guidance needed from the lead.",
    )
    options: list[str] | None = Field(
        default=None,
        description="Optional discrete choices for the lead to choose from.",
    )

    @field_validator("question")
    @classmethod
    def _not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("question must not be blank")
        return v


def make_send_to_lead_tool(lead_session_id: str, member_handle: str) -> Tool:
    """Return the send_to_lead tool bound to a member instance."""

    async def send_to_lead(
        message: str,
        end_turn: bool = False,
        _state: Annotated[Any, InjectedArg()] = None,
    ) -> str:
        from app.services import subagent_service

        instances = subagent_service._live_instances.get(lead_session_id, {})
        inst = instances.get(member_handle)
        if inst is not None:
            inst.last_result = message
            if end_turn:
                inst.status = "completed"

        if end_turn and _state is not None and hasattr(_state, "metadata"):
            _state.metadata["end_turn"] = True

        return "Message successfully delivered to lead agent."

    return Tool(
        send_to_lead,
        name="send_to_lead",
        description=_SEND_TO_LEAD_DESC,
        args_schema=SendToLeadArgs,
    )


def make_ask_lead_tool(lead_session_id: str, member_handle: str) -> Tool:
    """Return the ask_lead tool bound to a member instance."""

    async def ask_lead(
        question: str,
        options: list[str] | None = None,
        _tool_call_id: Annotated[str | None, InjectedArg()] = None,
        _state: Annotated[Any, InjectedArg()] = None,
    ) -> str:
        from app.services import subagent_service

        instances = subagent_service._live_instances.get(lead_session_id, {})
        inst = instances.get(member_handle)
        tool_call_id = _tool_call_id
        if not tool_call_id and _state is not None and hasattr(_state, "metadata"):
            tool_call_id = _state.metadata.get("current_tool_call_id")

        if inst is not None:
            inst.pending_lead_question = {
                "question": question,
                "options": options or [],
            }
            inst.status = "waiting_lead"
            if tool_call_id:
                setattr(inst, "_pending_tool_call_id", tool_call_id)

        raise LeadSuspended(
            question=question,
            options=options,
            tool_call_id=tool_call_id,
        )

    return Tool(
        ask_lead,
        name="ask_lead",
        description=_ASK_LEAD_DESC,
        args_schema=AskLeadArgs,
    )
