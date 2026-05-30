"""Tests for AgentTeamProtocolHook — team protocol injection into system prompts."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from app.agent.mode.team.hooks.team_prompt import AgentTeamProtocolHook
from app.agent.mode.team.member import (
    LEAD_COMMUNICATION_RULES,
    LEAD_MESSAGE_FORMAT,
    LEAD_PROTOCOL,
    MEMBER_COMMUNICATION_RULES,
    MEMBER_MESSAGE_FORMAT,
    MEMBER_PROTOCOL,
    TeamLead,
    TeamMember,
)
from app.agent.schemas.chat import AssistantMessage, HumanMessage
from app.agent.state import AgentState, ModelRequest, RunContext


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def make_ctx() -> RunContext:
    return RunContext(session_id="test-session", run_id="test-run", agent_name="bot")


def make_state(prompt: str = "You are a researcher.") -> AgentState:
    return AgentState(messages=[], system_prompt=prompt)


def _mock_agent(name: str, description: str | None = None) -> MagicMock:
    agent = MagicMock()
    agent.name = name
    agent.description = description
    return agent


def _mock_lead(
    name: str, description: str | None = None, state: str = "idle"
) -> MagicMock:
    """Mock that has build_protocol behaving like TeamLead."""
    member = MagicMock(spec=TeamLead)
    member.name = name
    member.state = state
    member.agent = _mock_agent(name, description)
    member.session_id = "lead-session-123"

    # Me wire up build_protocol to use the real TeamLead implementation
    def _build_protocol(base_prompt, team):
        return TeamLead.build_protocol(member, base_prompt, team)

    member.build_protocol = _build_protocol
    return member


def _mock_member(
    name: str, description: str | None = None, state: str = "idle"
) -> MagicMock:
    """Mock that has build_protocol behaving like TeamMember."""
    m = MagicMock(spec=TeamMember)
    m.name = name
    m.state = state
    m.agent = _mock_agent(name, description)

    # Me wire up build_protocol to use the real TeamMember implementation
    def _build_protocol(base_prompt, team):
        return TeamMember.build_protocol(m, base_prompt, team)

    m.build_protocol = _build_protocol
    return m


def _mock_team(
    lead_name: str = "team-lead",
    member_names: list[str] | None = None,
    lead_desc: str | None = "Coordinates the team.",
    member_descs: dict[str, str] | None = None,
) -> MagicMock:
    """Build a mock AgentTeam with lead + members."""
    member_names = member_names or ["researcher", "writer"]
    member_descs = member_descs or {}

    lead = _mock_lead(lead_name, description=lead_desc)

    members = {}
    for mname in member_names:
        desc = member_descs.get(mname)
        members[mname] = _mock_member(mname, description=desc)

    team = MagicMock()
    team.lead = lead
    team.members = members
    team.task_board = MagicMock()
    team.task_board.tasks = []
    team.blueprints = {}
    team.live_instances_for_blueprint = MagicMock(return_value=[])
    return team


async def _get_injected_request(
    hook: AgentTeamProtocolHook,
    base_prompt: str,
    messages: tuple[HumanMessage, ...] = (),
) -> ModelRequest:
    """Call wrap_model_call and return the request the handler received."""
    ctx = make_ctx()
    state = make_state(base_prompt)
    request = ModelRequest(messages=messages, system_prompt=base_prompt)
    received: list[ModelRequest] = []

    async def handler(req: ModelRequest) -> AssistantMessage:
        received.append(req)
        return AssistantMessage(content="ok")

    await hook.wrap_model_call(ctx, state, request, handler)
    return received[0]


async def _get_injected_prompt(hook: AgentTeamProtocolHook, base_prompt: str) -> str:
    """Call wrap_model_call and return the system_prompt the handler received."""
    request = await _get_injected_request(hook, base_prompt)
    return request.system_prompt


# ---------------------------------------------------------------------------
# Basic protocol injection
# ---------------------------------------------------------------------------


class TestProtocolInjection:
    """Test that protocol blocks are injected correctly."""

    @pytest.mark.asyncio
    async def test_member_gets_communication_rules(self):
        """Members receive the shared communication rules block."""
        team = _mock_team()
        hook = AgentTeamProtocolHook(team=team, agent_name="researcher")
        state = make_state("You are a researcher.")
        prompt = await _get_injected_prompt(hook, state.system_prompt)

        assert "Communication protocol" in prompt
        assert "ONLY tool calls" in prompt or "<sleep>" in prompt

    @pytest.mark.asyncio
    async def test_lead_gets_communication_rules(self):
        """Lead also receives the shared communication rules."""
        team = _mock_team()
        hook = AgentTeamProtocolHook(team=team, agent_name="team-lead")
        state = make_state("You are the team lead.")
        prompt = await _get_injected_prompt(hook, state.system_prompt)

        assert "Communication protocol" in prompt

    @pytest.mark.asyncio
    async def test_member_gets_member_protocol(self):
        """Members receive the member-specific protocol (workflow rules)."""
        team = _mock_team()
        hook = AgentTeamProtocolHook(team=team, agent_name="researcher")
        state = make_state("Base.")
        prompt = await _get_injected_prompt(hook, state.system_prompt)

        assert "Member workflow" in prompt

    @pytest.mark.asyncio
    async def test_lead_gets_lead_protocol(self):
        """Lead receives the lead-specific protocol (team_message, Lead workflow)."""
        team = _mock_team()
        hook = AgentTeamProtocolHook(team=team, agent_name="team-lead")
        state = make_state("Base.")
        prompt = await _get_injected_prompt(hook, state.system_prompt)

        assert "Lead workflow" in prompt
        assert "team_message" in prompt

    @pytest.mark.asyncio
    async def test_lead_does_not_get_member_protocol(self):
        """Lead should not see member-only tools like team_message claim."""
        team = _mock_team()
        hook = AgentTeamProtocolHook(team=team, agent_name="team-lead")
        state = make_state("Base.")
        prompt = await _get_injected_prompt(hook, state.system_prompt)

        assert "Member workflow" not in prompt

    @pytest.mark.asyncio
    async def test_member_does_not_get_lead_protocol(self):
        """Members should not see lead-only workflow like 'When NOT to message'."""
        team = _mock_team()
        hook = AgentTeamProtocolHook(team=team, agent_name="writer")
        state = make_state("Base.")
        prompt = await _get_injected_prompt(hook, state.system_prompt)

        assert "Lead workflow" not in prompt
        assert "Lead tools" not in prompt

    @pytest.mark.asyncio
    async def test_message_format_injected(self):
        """Lead sees [user]: content; member only sees [name]: content."""
        team = _mock_team()

        # Me lead gets LEAD_MESSAGE_FORMAT — includes [user]: content
        lead_hook = AgentTeamProtocolHook(team=team, agent_name="team-lead")
        lead_prompt = await _get_injected_prompt(lead_hook, "Base.")
        assert "[name]: content" in lead_prompt
        assert "[user]: content" in lead_prompt

        # Me member gets MEMBER_MESSAGE_FORMAT — no [user]: content
        member_hook = AgentTeamProtocolHook(team=team, agent_name="researcher")
        member_prompt = await _get_injected_prompt(member_hook, "Base.")
        assert "[name]: content" in member_prompt
        assert "[user]: content" not in member_prompt

    @pytest.mark.asyncio
    async def test_lead_has_team_message_in_protocol(self):
        """Lead protocol includes team_message tool (replaces send_message)."""
        team = _mock_team()
        hook = AgentTeamProtocolHook(team=team, agent_name="team-lead")
        state = make_state("Base.")
        prompt = await _get_injected_prompt(hook, state.system_prompt)

        assert "team_message" in prompt

    def test_protocol_constants_capture_current_communication_contract(self):
        """Prompt constants should preserve the team routing contract."""
        assert "one brief progress note after delegation" in LEAD_COMMUNICATION_RULES
        assert (
            "Do not use plain text output for responses/results"
            in MEMBER_COMMUNICATION_RULES
        )
        # Idle / waiting / done -> the only response is the sleep token.
        assert "exactly `<sleep>`" in MEMBER_COMMUNICATION_RULES
        # Members address team_message to anyone on the team, not lead-only.
        assert "anyone on the team" in MEMBER_COMMUNICATION_RULES
        assert (
            "return exactly `<sleep>` directly when waiting or idle" in MEMBER_PROTOCOL
        )


# ---------------------------------------------------------------------------
# Roster injection
# ---------------------------------------------------------------------------


class TestRosterInjection:
    """Roster stays OUT of the (static, cache-friendly) system prompt."""

    @pytest.mark.asyncio
    async def test_hook_no_longer_appends_runtime_roster_context(self):
        """Roster changes are persisted in history, not injected per model call."""
        team = _mock_team()
        hook = AgentTeamProtocolHook(team=team, agent_name="team-lead")
        prior_messages = (
            HumanMessage(content="A"),
            HumanMessage(content="B"),
            HumanMessage(content="C"),
        )

        request = await _get_injected_request(
            hook,
            "Base.",
            messages=prior_messages,
        )

        assert request.messages[: len(prior_messages)] == prior_messages
        assert len(request.messages) == len(prior_messages)

    @pytest.mark.asyncio
    async def test_lead_system_prompt_excludes_roster_and_blueprints(self):
        """Lead system prompt never carries the dynamic roster/blueprint sections."""
        team = _mock_team(
            member_names=["researcher", "writer"],
            member_descs={"researcher": "Does research.", "writer": "Writes articles."},
        )
        hook = AgentTeamProtocolHook(team=team, agent_name="team-lead")
        prompt = await _get_injected_prompt(hook, "Base.")

        assert "## Spawnable blueprints" not in prompt
        assert "## Live members" not in prompt
        assert "Does research." not in prompt
        assert "Writes articles." not in prompt

    @pytest.mark.asyncio
    async def test_member_system_prompt_excludes_dynamic_roster_and_blueprints(self):
        """Member live roster + blueprints stay out of the system prompt."""
        team = _mock_team(lead_desc="Coordinates the team.")
        team.blueprints = {
            "executor": MagicMock(name="executor", description="Writes files."),
        }
        hook = AgentTeamProtocolHook(team=team, agent_name="researcher")
        prompt = await _get_injected_prompt(hook, "Base.")

        assert "## Available members" not in prompt
        assert "## Spawnable blueprints" not in prompt

    @pytest.mark.asyncio
    async def test_lead_system_prompt_omits_no_blueprints_fallback(self):
        """No-blueprints guidance belongs only in team_manage description."""
        team = _mock_team(member_names=[])
        team.blueprints = {}
        hook = AgentTeamProtocolHook(team=team, agent_name="team-lead")
        request = await _get_injected_request(hook, "Base.")
        rendered = (
            request.system_prompt
            + "\n"
            + "\n".join(message.content for message in request.messages)
        )

        assert "no member blueprints are available to spawn" not in rendered
        assert "No member blueprints are available to spawn" not in rendered
        assert "## Spawnable blueprints" not in rendered


# ---------------------------------------------------------------------------
# Prompt preservation
# ---------------------------------------------------------------------------


class TestPromptPreservation:
    """Test that the original system prompt is preserved."""

    @pytest.mark.asyncio
    async def test_original_prompt_preserved(self):
        """The original system_prompt from yaml should appear at the start."""
        team = _mock_team()
        hook = AgentTeamProtocolHook(team=team, agent_name="researcher")
        state = make_state("You are a specialist researcher.")
        prompt = await _get_injected_prompt(hook, state.system_prompt)

        assert prompt.startswith("You are a specialist researcher.")

    @pytest.mark.asyncio
    async def test_separator_between_prompt_and_protocol(self):
        """A --- separator divides the yaml prompt from injected protocol."""
        team = _mock_team()
        hook = AgentTeamProtocolHook(team=team, agent_name="researcher")
        state = make_state("Base.")
        prompt = await _get_injected_prompt(hook, state.system_prompt)

        assert "\n\n---\n\n" in prompt

    @pytest.mark.asyncio
    async def test_empty_prompt_still_gets_protocol(self):
        """Even an empty system_prompt gets the protocol appended."""
        team = _mock_team()
        hook = AgentTeamProtocolHook(team=team, agent_name="writer")
        state = make_state("")
        prompt = await _get_injected_prompt(hook, state.system_prompt)

        assert "Communication protocol" in prompt
        assert "Member workflow" in prompt


# ---------------------------------------------------------------------------
# Protocol constant contents
# ---------------------------------------------------------------------------


class TestProtocolConstants:
    """Test that the constant protocol blocks contain expected content."""

    def test_lead_communication_rules_mentions_team_message(self):
        """LEAD_COMMUNICATION_RULES references team_message tool."""
        assert "team_message" in LEAD_COMMUNICATION_RULES

    def test_lead_communication_rules_do_not_assume_empty_live_roster(self):
        """Dynamic rosters may carry live handles across turns until dismissed."""
        assert (
            "No members are live at the start of a turn" not in LEAD_COMMUNICATION_RULES
        )
        assert "Members are spawned on demand" in LEAD_COMMUNICATION_RULES

    def test_lead_system_prompt_does_not_reference_roster_section(self):
        """Spawnable blueprint usage belongs in team_manage/tool context."""
        lead_prompt = f"{LEAD_COMMUNICATION_RULES}\n\n{LEAD_PROTOCOL}"
        assert "## Spawnable blueprints" not in lead_prompt
        assert "Spawnable blueprints` section" not in lead_prompt

    def test_member_communication_rules_enforce_team_message_to_anyone(self):
        """All member output routes via team_message — to any teammate, not lead-only."""
        assert "team_message" in MEMBER_COMMUNICATION_RULES
        assert (
            "Do not use plain text output for responses/results"
            in MEMBER_COMMUNICATION_RULES
        )
        # Cross-member: members are not restricted to messaging the lead.
        assert "Talk to peers directly" in MEMBER_COMMUNICATION_RULES
        assert "anyone on the team who needs it" in MEMBER_COMMUNICATION_RULES

    def test_lead_message_format_has_user_prefix(self):
        """Lead message format includes [user]: prefix — members do not."""
        assert "[name]" in LEAD_MESSAGE_FORMAT
        assert "[user]" in LEAD_MESSAGE_FORMAT

    def test_member_message_format_no_user_prefix(self):
        """Member message format does not mention [user]: — members never receive user messages."""
        assert "[name]" in MEMBER_MESSAGE_FORMAT
        assert "[user]" not in MEMBER_MESSAGE_FORMAT

    def test_lead_protocol_has_workflow(self):
        assert "Lead workflow" in LEAD_PROTOCOL
        assert "delegate" in LEAD_PROTOCOL.lower()
        assert "peer handoff chain" in LEAD_PROTOCOL
        assert "not as a message bus" in LEAD_PROTOCOL
        assert "do not execute the same task in parallel yourself" in LEAD_PROTOCOL
        assert "reclaim or cancel the member task first" in LEAD_PROTOCOL
        assert "dependencies" in LEAD_PROTOCOL
        assert "assigned_to" in LEAD_PROTOCOL
        assert "explorer#1" not in LEAD_PROTOCOL
        assert "consultant#1" not in LEAD_PROTOCOL
        assert "executor#1" not in LEAD_PROTOCOL

    def test_member_protocol_no_old_params(self):
        """Member protocol does not reference old mode/stop params."""
        assert "stop=true" not in MEMBER_PROTOCOL
        assert 'mode="inform"' not in MEMBER_PROTOCOL
        assert 'mode="ask"' not in MEMBER_PROTOCOL
        assert 'mode="reply"' not in MEMBER_PROTOCOL

    def test_member_protocol_has_workflow(self):
        assert "Member workflow" in MEMBER_PROTOCOL
        assert "<sleep>" in MEMBER_PROTOCOL
        assert "todo_manage" in MEMBER_PROTOCOL
        assert "claim" in MEMBER_PROTOCOL

    def test_member_protocol_no_old_tool_names(self):
        """Member protocol does not reference removed tools."""
        assert "message_leader" not in MEMBER_PROTOCOL
        assert "claim_task" not in MEMBER_PROTOCOL
        assert "update_task_status" not in MEMBER_PROTOCOL

    def test_lead_protocol_no_old_tool_names(self):
        """Lead protocol does not reference removed tools."""
        assert "create_tasks" not in LEAD_PROTOCOL
        assert "assign_task" not in LEAD_PROTOCOL
        assert "get_tasks" not in LEAD_PROTOCOL
        assert "broadcast" not in LEAD_PROTOCOL
        assert "send_message" not in LEAD_PROTOCOL
