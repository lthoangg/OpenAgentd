"""Manual smoke test for duplicate skill loads in one agent state.

Verifies two runtime invariants without requiring a live server or LLM:

1. Calling the skill tool twice for the same skill in the same visible session
   returns the full body only once; the duplicate returns a compact reuse note.
2. Summarisation preserves the first full skill tool pair and compacts later
   duplicate pairs for that skill.

Usage:
  uv run python -m manual.skill_dedupe
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import MagicMock

from app.agent.hooks.summarization import SummarizationHook
from app.agent.schemas.chat import (
    AssistantMessage,
    FunctionCall,
    HumanMessage,
    ToolCall,
    ToolMessage,
)
from app.agent.state import AgentState, ModelRequest, RunContext, UsageInfo
from app.agent.tools.builtin import skill as skill_module
from app.agent.tools.builtin.skill import load_skill


async def _noop_model_handler(request: ModelRequest) -> AssistantMessage:
    return AssistantMessage(content="ok")


async def _check_tool_dedupe() -> None:
    with TemporaryDirectory() as tmp:
        skills_root = Path(tmp)
        skill_dir = skills_root / "manual-demo"
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text(
            "---\nname: manual-demo\ndescription: Manual demo skill\n---\n"
            "MANUAL_DEMO_FULL_BODY",
            encoding="utf-8",
        )

        original_roots = skill_module._iter_skill_roots
        skill_module._iter_skill_roots = lambda: [skills_root]
        try:
            state = SimpleNamespace(metadata={}, messages_for_llm=[])
            first = await load_skill("manual-demo", _state=state)
            second = await load_skill("manual-demo", _state=state)
        finally:
            skill_module._iter_skill_roots = original_roots

    if first != "MANUAL_DEMO_FULL_BODY":
        raise AssertionError(f"first load returned unexpected body: {first!r}")
    if "already loaded" not in second:
        raise AssertionError(f"duplicate load did not return reuse note: {second!r}")
    if "MANUAL_DEMO_FULL_BODY" in second:
        raise AssertionError("duplicate load returned the full skill body again")


async def _check_summarization_keeps_only_first_pair() -> None:
    provider = MagicMock()

    async def _stream(messages, **__):
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = "Manual summary."
        chunk.usage = None
        yield chunk

    provider.stream = lambda messages, **kw: _stream(messages)

    hook = SummarizationHook(
        llm_provider=provider,
        summary_prompt="manual summary prompt",
        prompt_token_threshold=1,
        keep_last_assistants=0,
    )
    ctx = RunContext(session_id=None, run_id="manual-skill-dedupe", agent_name="manual")

    first_asst = AssistantMessage(
        tool_calls=[
            ToolCall(
                id="call_skill_1",
                function=FunctionCall(
                    name="skill", arguments='{"skill_name":"manual-demo"}'
                ),
            )
        ]
    )
    first_result = ToolMessage(
        tool_call_id="call_skill_1",
        name="skill",
        content="MANUAL_DEMO_FULL_BODY",
    )
    duplicate_asst = AssistantMessage(
        tool_calls=[
            ToolCall(
                id="call_skill_2",
                function=FunctionCall(
                    name="skill", arguments='{"skill_name":"manual-demo"}'
                ),
            )
        ]
    )
    duplicate_result = ToolMessage(
        tool_call_id="call_skill_2",
        name="skill",
        content="Skill 'manual-demo' is already loaded in this session.",
    )

    state = AgentState(
        messages=[
            HumanMessage(content="load skill"),
            first_asst,
            first_result,
            HumanMessage(content="load duplicate skill"),
            duplicate_asst,
            duplicate_result,
        ],
        usage=UsageInfo(last_prompt_tokens=9999),
    )

    await hook.before_model(ctx, state)
    await hook.wrap_model_call(
        ctx,
        state,
        ModelRequest(messages=tuple(state.messages_for_llm), system_prompt=""),
        _noop_model_handler,
    )

    if first_asst.exclude_from_context or first_result.exclude_from_context:
        raise AssertionError("first full skill pair was not preserved")
    if (
        not duplicate_asst.exclude_from_context
        or not duplicate_result.exclude_from_context
    ):
        raise AssertionError("duplicate skill pair was not compacted")


async def main_async() -> None:
    await _check_tool_dedupe()
    await _check_summarization_keeps_only_first_pair()
    print(
        "[PASS] duplicate skill loads return compact reuse note and compact away after summarisation"
    )


def main() -> None:
    asyncio.run(main_async())


if __name__ == "__main__":
    main()
