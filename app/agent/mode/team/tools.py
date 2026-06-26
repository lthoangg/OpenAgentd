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
from typing import TYPE_CHECKING, Literal

from pydantic import BaseModel, Field

from app.agent.tools.registry import Tool

if TYPE_CHECKING:
    from app.agent.mode.team.mailbox import TeamMailbox
    from app.agent.mode.team.team import AgentTeam


_LEAD_DESCRIPTION = (
    "Send a message to one or more team members. "
    "Use to: delegate tasks, provide instructions, relay scope changes, "
    "or ask a member for status."
)

_MEMBER_DESCRIPTION = (
    "Your ONLY way to communicate — plain text output is silently discarded. "
    "Call this tool to: deliver work output (findings, drafts, data) to the lead, "
    "hand off results to a peer, or ask a specific unblocking question."
)


class TeamMessageArgs(BaseModel):
    """Arguments for the team_message tool."""

    to: list[str] = Field(
        description=(
            "Recipient names: exact live handles or an available bare "
            "blueprint name when exactly one instance is live. "
            "One call per intended audience; make separate calls for "
            "different messages."
        )
    )
    content: str = Field(
        description=(
            "The message body. Must be addressed ONLY to recipients in `to`. "
            "Work output only: findings, drafts, data, task instructions, or questions. "
            "NEVER greetings, status updates, or acknowledgements. "
            "Do NOT prefix with your name — the system adds [your-name]: automatically."
        )
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

    async def team_message(to: list[str], content: str) -> str:
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

        return f"Message sent to {', '.join(resolved)}."

    description = _LEAD_DESCRIPTION if role == "lead" else _MEMBER_DESCRIPTION
    return Tool(
        team_message,
        name="team_message",
        description=description,
        args_schema=TeamMessageArgs,
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
