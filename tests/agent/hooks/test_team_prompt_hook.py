"""Tests for SessionRuntimeProtocolHook — protocol injection into system prompts."""

from __future__ import annotations

from unittest.mock import MagicMock
import pytest

from app.agent.mode.team.hooks.team_prompt import SessionRuntimeProtocolHook
from app.agent.mode.team.runtime import SessionRuntime
from app.agent.schemas.chat import AssistantMessage, HumanMessage
from app.agent.state import AgentState, ModelRequest, RunContext


def make_ctx() -> RunContext:
    return RunContext(session_id="test-session", run_id="test-run", agent_name="bot")


def make_state(prompt: str = "You are OpenAgentd.") -> AgentState:
    return AgentState(messages=[], system_prompt=prompt)


def _mock_runtime(
    name: str = "openagentd",
    is_child: bool = False,
) -> MagicMock:
    runtime = MagicMock(spec=SessionRuntime)
    runtime.name = name
    runtime.state = "idle"
    runtime.is_child_session = is_child
    runtime.parent_session_id = "parent-123" if is_child else None

    # Real assembly, mocked state: the hook is only a pass-through, so the
    # assertions below are about ``build_protocol`` itself.
    runtime.build_protocol = lambda base_prompt: SessionRuntime.build_protocol(
        runtime, base_prompt
    )
    return runtime


async def _get_injected_request(
    hook: SessionRuntimeProtocolHook,
    base_prompt: str,
    messages: tuple[HumanMessage, ...] = (),
) -> ModelRequest:
    ctx = make_ctx()
    state = make_state(base_prompt)
    request = ModelRequest(messages=messages, system_prompt=base_prompt)
    received: list[ModelRequest] = []

    async def handler(req: ModelRequest) -> AssistantMessage:
        received.append(req)
        return AssistantMessage(content="ok")

    await hook.wrap_model_call(ctx, state, request, handler)
    return received[0]


async def _get_injected_prompt(
    hook: SessionRuntimeProtocolHook, base_prompt: str
) -> str:
    request = await _get_injected_request(hook, base_prompt)
    return request.system_prompt


class TestProtocolInjection:
    """Test protocol injection for parent and child sessions."""

    @pytest.mark.asyncio
    async def test_parent_session_gets_the_delegation_protocol(self):
        hook = SessionRuntimeProtocolHook(
            runtime=_mock_runtime("openagentd", is_child=False)
        )
        prompt = await _get_injected_prompt(hook, "You are OpenAgentd.")

        assert "Multi-Agent Delegation Protocol" in prompt
        assert "agent_spawn" in prompt
        assert "Communication protocol" in prompt

    @pytest.mark.asyncio
    async def test_child_gets_child_protocol(self):
        hook = SessionRuntimeProtocolHook(
            runtime=_mock_runtime("child-agent", is_child=True)
        )
        prompt = await _get_injected_prompt(hook, "You are OpenAgentd.")

        assert "Child Agent Operating Protocol" in prompt
        assert "agent_merge" in prompt
        assert "agent_send" in prompt
        assert "Multi-Agent Delegation Protocol" not in prompt

    @pytest.mark.asyncio
    async def test_protocol_omits_retired_roster_instructions(self):
        """The prompt must not advertise tools the redesign removed.

        ``team_message`` / ``team_manage`` and the member-roster workflow no
        longer exist, so leaving them in the injected protocol makes the model
        call tools that are absent from its tool list.
        """
        hook = SessionRuntimeProtocolHook(
            runtime=_mock_runtime("openagentd", is_child=False)
        )
        prompt = await _get_injected_prompt(hook, "You are OpenAgentd.")

        assert "team_message" not in prompt
        assert "team_manage" not in prompt
        assert "blueprint" not in prompt.lower()
        assert "Markdown" in prompt
