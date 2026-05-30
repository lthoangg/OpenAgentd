"""AgentTeamProtocolHook — injects team operating protocol into system prompts.

Fires via ``wrap_model_call`` before each LLM call. Delegates protocol
assembly to the role class (TeamLead / TeamMember) via ``build_protocol()``.

The yaml ``system_prompt`` only needs the agent's **role-specific** instructions
(what to research, how to write, etc.).  Everything about *how teams work* is
injected by each role's ``build_protocol()`` method.

Usage::

    hook = AgentTeamProtocolHook(team=team, agent_name="researcher")
    agent.run(messages, hooks=[hook, ...])

Created per-member in ``TeamMemberBase._handle_messages()``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from app.agent.hooks.base import BaseAgentHook

if TYPE_CHECKING:
    from app.agent.schemas.chat import AssistantMessage
    from app.agent.state import AgentState, ModelCallHandler, ModelRequest, RunContext
    from app.agent.mode.team.team import AgentTeam


class AgentTeamProtocolHook(BaseAgentHook):
    """Inject team operating protocol into the system prompt before each model call.

    Delegates to the role's ``build_protocol()`` method — no role branching here.
    """

    def __init__(self, team: "AgentTeam", agent_name: str) -> None:
        self._team = team
        self._agent_name = agent_name

    def _get_member(self):
        """Resolve the TeamMemberBase instance for this agent."""
        if self._agent_name == self._team.lead.name:
            return self._team.lead
        return self._team.members[self._agent_name]

    async def wrap_model_call(
        self,
        ctx: "RunContext",
        state: "AgentState",
        request: "ModelRequest",
        handler: "ModelCallHandler",
    ) -> "AssistantMessage":
        """Inject team protocol into the system prompt on every model call.

        The injected protocol is static per session, so the system prompt
        stays byte-stable across turns (prompt-cache friendly). Dynamic roster
        changes are surfaced to the LLM as append-only ``[system]`` messages
        (see :meth:`AgentTeam._persist_roster_change`) and via ``team_message``
        / ``team_manage`` tool results — never by mutating this prompt.
        """
        member = self._get_member()
        new_prompt = member.build_protocol(request.system_prompt, self._team)
        return await handler(request.override(system_prompt=new_prompt))
