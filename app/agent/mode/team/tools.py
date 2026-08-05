"""Team communication tools — LLM-callable tools for agent-team messaging.

One tool for everyone: team_message(to, content)

Injected into agent.run() at runtime via injected_tools.
Lead and members share the same underlying function but get role-specific
descriptions so the LLM understands the intended usage for each role.

Recipient resolution:
- Exact instance handle (``executor#1``) routes directly.
- Bare blueprint name (``executor``) routes to the unique live instance
  if exactly one exists.  Ambiguous (multiple live instances) and unknown
  (no live instance) cases produce a tailored error so the lead/member can
  pick a specific handle.
"""

from __future__ import annotations

import re
from typing import Annotated, Any, TYPE_CHECKING, Literal

from pydantic import BaseModel, Field, field_validator

from app.agent.tools.registry import InjectedArg, Tool

if TYPE_CHECKING:
    from app.agent.mode.team.mailbox import TeamMailbox
    from app.agent.mode.team.team import AgentTeam


_LEAD_DESCRIPTION = (
    "Send a message to one or more recipients to delegate, instruct, update scope, "
    "or request status."
)

_MEMBER_DESCRIPTION = (
    "Plain text output is silently discarded. Use this tool for peer handoffs, "
    "blockers, and unblocking questions. Task results reach the lead through "
    "`todo_manage`; never resend them here."
)


class TeamMessageArgs(BaseModel):
    """Arguments for the team_message tool."""

    to: list[str] = Field(
        min_length=1,
        description=(
            "Exact live handles, or a bare blueprint name when exactly one instance "
            "is live. Use one call per audience."
        ),
    )
    content: str = Field(
        min_length=1,
        description=(
            "Message body for the listed recipients only: work output, instructions, "
            "questions, requested progress, or blockers. Avoid greetings, "
            "acknowledgements, and routine status chatter. Do not prefix your name; "
            "the system adds [your-name]: automatically."
        ),
    )

    @field_validator("to", mode="before")
    @classmethod
    def coerce_to(cls, v: Any) -> Any:
        if v is None:
            return []
        if isinstance(v, str):
            text = v.strip()
            if not text:
                return []
            if text.startswith("[") and text.endswith("]"):
                try:
                    import json

                    parsed = json.loads(text)
                    if isinstance(parsed, list):
                        return [
                            str(item).strip() for item in parsed if str(item).strip()
                        ]
                except ValueError:
                    pass  # not JSON — fall through to comma-splitting
            return [item.strip() for item in text.split(",") if item.strip()]
        if isinstance(v, (list, tuple, set)):
            return [str(item).strip() for item in v if str(item).strip()]
        return [str(v).strip()]

    @field_validator("content")
    @classmethod
    def _not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("content must not be blank")
        return v


class TeamMessageMemberArgs(TeamMessageArgs):
    """Member variant — adds the structured turn-end signal."""

    end_turn: bool = Field(
        default=False,
        description=(
            "Set true when this message is your last action for the turn "
            "(final report sent, or waiting on someone): the turn ends after "
            "delivery with no further model call. Leave false when you will "
            "keep working."
        ),
    )


def make_team_message_tool(
    mailbox: "TeamMailbox",
    agent_name: str,
    role: Literal["lead", "member"] = "member",
    team: "AgentTeam | None" = None,
) -> Tool:
    """Return the team_message tool bound to *agent_name* with role-specific description.

    When ``team`` is supplied, recipient resolution understands instance
    handles (``executor#1``) and bare-blueprint-name shorthand (``executor``,
    routed to the unique live instance).  Without it the tool falls back to
    raw mailbox name lookup — used by older tests that build a mailbox by
    hand.
    """

    async def team_message(
        to: list[str],
        content: str,
        end_turn: bool = False,
        _state: Annotated[Any, InjectedArg()] = None,
    ) -> str:
        """Send a message to one or more teammates."""
        from app.agent.mode.team.mailbox import Message

        # Drop self — agents cannot message themselves
        requested = [r for r in to if r != agent_name]
        if not requested:
            return "No valid recipients (cannot message yourself)."

        # Resolve each requested name through the team's recipient
        # resolver (handles bare-blueprint-name shorthand) when available.
        resolved: list[str] = []
        errors: list[str] = []
        for name in requested:
            target = _resolve(team, mailbox, name, agent_name)
            if target is None:
                errors.append(_recipient_error(team, mailbox, name, agent_name))
            else:
                resolved.append(target)

        if errors:
            return " | ".join(errors)

        # Strip self-prefix in both "[name]: " and "name: " forms (prevents double-prefix)
        stripped = re.sub(r"^\[?" + re.escape(agent_name) + r"\]?:\s*", "", content)
        formatted = f"[{agent_name}]: {stripped}"

        for recipient in resolved:
            msg = Message(
                from_agent=agent_name,
                to_agent=recipient,
                content=formatted,
            )
            await mailbox.send(to=recipient, message=msg)

        # Structured turn-end: only after successful delivery (a failed send
        # must keep the turn alive so the sender can correct the recipient).
        if end_turn and role == "member" and _state is not None:
            _state.metadata["end_turn"] = True

        return f"Message sent to {', '.join(resolved)}."

    description = _LEAD_DESCRIPTION if role == "lead" else _MEMBER_DESCRIPTION
    return Tool(
        team_message,
        name="team_message",
        description=description,
        args_schema=TeamMessageArgs if role == "lead" else TeamMessageMemberArgs,
    )


def _resolve(
    team: "AgentTeam | None",
    mailbox: "TeamMailbox",
    name: str,
    sender: str,
) -> str | None:
    """Resolve a requested recipient name to a live mailbox key, or ``None``."""
    if team is not None:
        target = team.resolve_recipient(name)
        if target is not None and target != sender:
            return target
        if target == sender:
            return None
        # Fall through to mailbox-based check so the caller can produce a
        # tailored ambiguity / unknown error message via ``_recipient_error``.
        return None
    # No team context — fall back to raw mailbox lookup.
    if name in mailbox.registered_agents and name != sender:
        return name
    return None


def _recipient_error(
    team: "AgentTeam | None",
    mailbox: "TeamMailbox",
    name: str,
    sender: str,
) -> str:
    """Produce a helpful error string for a failed recipient resolution."""
    if team is None:
        available = [a for a in mailbox.registered_agents if a != sender]
        return f"Agent '{name}' not found. Available: {', '.join(available)}"

    # Bare blueprint name? Surface ambiguity vs. not-spawned distinctly.
    if name in team.blueprints:
        live = team.live_instances_for_blueprint(name)
        if not live:
            return (
                f"Blueprint '{name}' has no live instances — "
                f"call team_manage(action='spawn', members=['{name}']) first."
            )
        return (
            f"Blueprint '{name}' has multiple live instances {live}. "
            f"Address one explicitly (e.g. team_message(to=['{live[0]}']))."
        )
    available = [a for a in mailbox.registered_agents if a != sender]
    blueprints = sorted(team.blueprints.keys())
    return (
        f"Agent '{name}' not found. "
        f"Live: {available}. Spawnable blueprints: {blueprints}."
    )
