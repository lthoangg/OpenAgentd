"""In-process manual test for the three summarization improvements.

No server required. Runs in-process with a mock LLM provider and
InMemoryCheckpointer so you can see exactly what the summariser LLM receives.

Tests:
  1. P2 — tool result context: ToolMessage content reaches the summariser
     with the tool name, after normal tool truncation/offload has run.
  2. P5 — merge vs fresh request: when a prior summary is being compressed,
     the merge instruction is sent; otherwise the fresh summarise instruction.
  3. P6 — minimum-delta guard: summarisation skipped when fewer than
     min_messages_since_last_summary new messages have arrived.

Usage:
  uv run python -m manual.summarization_improvements_test
"""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

from app.agent.hooks.summarization import (
    SummarizationHook,
    _MERGE_REQUEST,
    _SUMMARISE_REQUEST,
)
from app.agent.schemas.chat import AssistantMessage, HumanMessage, ToolMessage
from app.agent.state import AgentState, ModelRequest, RunContext, UsageInfo


# ── Helpers ───────────────────────────────────────────────────────────────────


async def _trigger(hook: SummarizationHook, ctx: RunContext, state: AgentState) -> None:
    req = ModelRequest(system_prompt="system", messages=tuple(state.messages_for_llm))
    await hook.before_model(ctx, state, req)

    async def _handler(r: ModelRequest) -> AssistantMessage:
        return AssistantMessage(content="ok")

    await hook.wrap_model_call(ctx, state, req, _handler)


PASS = "\033[32mPASS\033[0m"
FAIL = "\033[31mFAIL\033[0m"


def _ctx() -> RunContext:
    return RunContext(session_id="manual-test", run_id="run-1", agent_name="TestAgent")


def _hook(**kwargs) -> tuple[SummarizationHook, list[str]]:
    """Return a hook wired to a capturing mock provider.

    The second return value is a list that collects every string chunk
    of conversation text sent to the summariser LLM.
    """
    captured_blobs: list[str] = []
    captured_msgs: list[object] = []

    provider = MagicMock()

    async def _stream(messages, **__):
        captured_msgs.extend(messages)
        for m in messages:
            if m.content:
                captured_blobs.append(m.content)
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = "<<summary>>"
        chunk.usage = None
        yield chunk

    provider.stream = lambda messages, **kw: _stream(messages)

    hook = SummarizationHook(
        llm_provider=provider,
        summary_prompt="You are a summariser.",
        prompt_token_threshold=1,
        **kwargs,
    )
    hook._captured_msgs = captured_msgs
    return hook, captured_blobs


def _check(label: str, condition: bool, detail: str = "") -> bool:
    status = PASS if condition else FAIL
    suffix = f"  ({detail})" if detail else ""
    print(f"  {status}  {label}{suffix}")
    return condition


# ── P2: tool result context ───────────────────────────────────────────────────


async def test_p2_tool_result_stubbing() -> bool:
    print("\n[P2] Tool result context")
    all_pass = True

    hook, captured = _hook(keep_last_assistants=0)
    ctx = _ctx()
    state = AgentState(
        messages=[
            HumanMessage(content="run a shell command"),
            AssistantMessage(content="ok", tool_calls=[]),
            ToolMessage(
                content='{"exit_code": 0, "stdout": "SECRET_OUTPUT_12345"}',
                tool_call_id="tc1",
                name="shell",
            ),
        ],
        usage=UsageInfo(last_prompt_tokens=9999),
    )

    await _trigger(hook, ctx, state)

    blob = " ".join(captured)
    tool_msg = next(
        (m for m in getattr(hook, "_captured_msgs", []) if isinstance(m, ToolMessage)),
        None,
    )

    ok1 = _check(
        "tool output sent to summariser",
        tool_msg is not None and "SECRET_OUTPUT_12345" in (tool_msg.content or ""),
        f"tool_msg: {tool_msg}",
    )
    ok2 = _check(
        "tool name preserved",
        tool_msg is not None and tool_msg.name == "shell",
        f"name: {getattr(tool_msg, 'name', None)}",
    )
    ok3 = _check(
        "old omitted marker absent",
        "[tool result omitted]" not in blob,
        f"blob snippet: {blob[:120]}",
    )

    # Tool without a name → generic stub
    hook2, captured2 = _hook(keep_last_assistants=0)
    state2 = AgentState(
        messages=[
            ToolMessage(content="raw output no name", tool_call_id="tc2", name=None),
        ],
        usage=UsageInfo(last_prompt_tokens=9999),
    )
    await _trigger(hook2, ctx, state2)
    tool_msg2 = next(
        (m for m in getattr(hook2, "_captured_msgs", []) if isinstance(m, ToolMessage)),
        None,
    )

    ok4 = _check(
        "nameless tool renders with output",
        tool_msg2 is not None and tool_msg2.content == "raw output no name",
        f"tool_msg2: {tool_msg2}",
    )
    ok5 = _check(
        "non-tool messages pass through unchanged",
        "run a shell command" in blob,
        f"blob snippet: {blob[:120]}",
    )

    all_pass = all([ok1, ok2, ok3, ok4, ok5])
    return all_pass


# ── P5: merge vs fresh request ────────────────────────────────────────────────


async def test_p5_merge_vs_fresh() -> bool:
    print("\n[P5] Merge vs fresh summarise request")
    all_pass = True

    # Fresh: no prior summary in window
    hook1, captured1 = _hook(keep_last_assistants=0)
    ctx = _ctx()
    state1 = AgentState(
        messages=[HumanMessage(content="hello world")],
        usage=UsageInfo(last_prompt_tokens=9999),
    )
    await _trigger(hook1, ctx, state1)
    blob1 = " ".join(captured1)

    ok1 = _check(
        "fresh request used when no prior summary",
        _SUMMARISE_REQUEST in blob1 and _MERGE_REQUEST not in blob1,
        f"blob: {blob1[:120]}",
    )

    # Merge: prior summary in to_summarise window
    hook2, captured2 = _hook(keep_last_assistants=1)
    prior = HumanMessage(
        content="[Summary of earlier conversation]\nUser set up the project.",
        is_summary=True,
    )
    state2 = AgentState(
        messages=[
            prior,
            HumanMessage(content="new user message"),
            AssistantMessage(content="new assistant reply — kept verbatim"),
        ],
        usage=UsageInfo(last_prompt_tokens=9999),
    )
    await _trigger(hook2, ctx, state2)
    blob2 = " ".join(captured2)

    ok2 = _check(
        "merge request used when prior summary in to_summarise",
        _MERGE_REQUEST in blob2 and _SUMMARISE_REQUEST not in blob2,
        f"blob: {blob2[:120]}",
    )

    # Verify the prior summary text is included in the merge input
    ok3 = _check(
        "prior summary content present in merge input",
        "User set up the project." in blob2,
        f"blob: {blob2[:160]}",
    )

    # Verify summary is tagged correctly in output
    summary_msgs = [m for m in state2.messages if m.is_summary]
    ok4 = _check(
        "new summary inserted as HumanMessage with is_summary=True",
        len(summary_msgs) >= 1 and isinstance(summary_msgs[-1], HumanMessage),
        f"summary count={len(summary_msgs)}",
    )

    all_pass = all([ok1, ok2, ok3, ok4])
    return all_pass


# ── P6: minimum-delta guard ───────────────────────────────────────────────────


async def test_p6_min_delta_guard() -> bool:
    print("\n[P6] Minimum-delta guard (min_messages_since_last_summary=4)")
    all_pass = True

    hook, captured = _hook(keep_last_assistants=0, min_messages_since_last_summary=4)
    ctx = _ctx()

    # First summarisation — must fire (no prior record)
    state = AgentState(
        messages=[HumanMessage(content="initial message")],
        usage=UsageInfo(last_prompt_tokens=9999),
    )
    await _trigger(hook, ctx, state)
    ok1 = _check(
        "first summarisation fires regardless",
        len(captured) > 0,
    )
    # Immediately after — only 1 new message added, below threshold of 4
    captured.clear()
    state.messages.append(HumanMessage(content="one more"))
    state.usage.last_prompt_tokens = 9999

    await _trigger(hook, ctx, state)
    ok2 = _check(
        "skipped when only 1 new message (< 4)",
        len(captured) == 0,
        f"messages_at_last_summary={hook._messages_at_last_summary} current={len(state.messages)}",
    )

    # Add 3 more to reach the threshold (total 4 new since last summary)
    captured.clear()
    for i in range(3):
        state.messages.append(HumanMessage(content=f"extra msg {i}"))
    state.usage.last_prompt_tokens = 9999

    await _trigger(hook, ctx, state)
    ok3 = _check(
        "fires again after 4 new messages",
        len(captured) > 0,
        f"messages_at_last_summary={hook._messages_at_last_summary} current={len(state.messages)}",
    )

    # Guard disabled with min=0
    hook_zero, captured_zero = _hook(
        keep_last_assistants=0, min_messages_since_last_summary=0
    )
    state_zero = AgentState(
        messages=[HumanMessage(content="x")],
        usage=UsageInfo(last_prompt_tokens=9999),
    )
    await _trigger(hook_zero, ctx, state_zero)
    captured_zero.clear()
    state_zero.messages.append(HumanMessage(content="y"))
    state_zero.usage.last_prompt_tokens = 9999
    await _trigger(hook_zero, ctx, state_zero)
    ok4 = _check(
        "min=0 disables the guard — fires every eligible turn",
        len(captured_zero) > 0,
    )

    all_pass = all([ok1, ok2, ok3, ok4])
    return all_pass


# ── Runner ────────────────────────────────────────────────────────────────────


async def main() -> None:
    print("summarization improvements manual test")
    print("=" * 50)

    results = await asyncio.gather(
        test_p2_tool_result_stubbing(),
        test_p5_merge_vs_fresh(),
        test_p6_min_delta_guard(),
    )

    print("\n" + "=" * 50)
    passed = sum(results)
    total = len(results)
    if passed == total:
        print(f"{PASS}  all {total} test groups passed")
    else:
        failed = total - passed
        print(f"{FAIL}  {failed}/{total} test groups failed")


if __name__ == "__main__":
    asyncio.run(main())
