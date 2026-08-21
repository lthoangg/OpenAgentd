"""A hook's own ``wrap_tool_call`` code can fail independently of the tool.

``tool_executor.execute`` (the innermost handler) already turns an ordinary
tool failure into an ``"Error: ..."`` string. Hooks sit *outside* that
handler though — a bug in a hook's own pre/post logic (permission checks,
stream publishing, telemetry, ...) is not covered by it.

Before the fix, such a failure surfaced as a bare exception from
``gather_or_cancel`` and ``_append_tool_results`` silently dropped that
call's ``ToolMessage`` — leaving its ``tool_call_id`` unanswered in the
transcript sent back to the model on the very next call, in the same turn.
"""

from __future__ import annotations

from app.agent.agent_loop import Agent
from app.agent.hooks.base import BaseAgentHook
from app.agent.schemas.chat import HumanMessage, ToolMessage
from app.agent.tools.registry import Tool

from tests.agent.agent_loop.test_question_suspension import (
    ScriptedProvider,
    make_multi_tool_chunk,
)
from tests.agent.test_agent_run import make_text_chunk


class _ExplodingHook(BaseAgentHook):
    """Simulates a buggy hook: raises for one tool, passes the rest through."""

    def __init__(self, boom_for: str) -> None:
        self._boom_for = boom_for

    async def wrap_tool_call(self, ctx, state, tool_call, handler):
        if tool_call.function.name == self._boom_for:
            raise RuntimeError("hook exploded before calling the tool")
        return await handler(ctx, state, tool_call)


def _tools() -> list[Tool]:
    async def flaky(path: str = "x") -> str:
        """Would succeed — its hook wrapper is what blows up."""
        return "flaky ran"

    async def fine(path: str = "x") -> str:
        """An ordinary sibling in the same parallel batch."""
        return "fine ran"

    return [Tool(flaky, name="flaky"), Tool(fine, name="fine")]


async def test_hook_failure_still_yields_a_tool_message_for_every_call():
    provider = ScriptedProvider(
        [
            [
                make_multi_tool_chunk(
                    [
                        ("flaky", "call-flaky", "{}"),
                        ("fine", "call-fine", "{}"),
                    ]
                )
            ],
            [make_text_chunk("done")],
        ]
    )
    agent = Agent(
        name="lead",
        llm_provider=provider,
        hooks=[_ExplodingHook(boom_for="flaky")],
    )

    msgs = await agent.run(
        [HumanMessage(content="go")],
        injected_tools=_tools(),
    )

    results = {m.tool_call_id: m.content for m in msgs if isinstance(m, ToolMessage)}
    # The exploding hook's call still gets answered instead of being dropped.
    assert "call-flaky" in results
    assert "hook exploded" in (results["call-flaky"] or "")
    # Its sibling in the same batch is unaffected.
    assert results["call-fine"] == "fine ran"
