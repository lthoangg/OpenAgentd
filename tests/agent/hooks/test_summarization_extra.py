"""Extra tests for SummarizationHook — covers empty summary path.

LLM returns empty summary text → hook skips inserting summary.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from app.agent.hooks.summarization import SummarizationHook
from app.agent.schemas.chat import AssistantMessage, HumanMessage
from app.agent.state import AgentState, ModelRequest, RunContext, UsageInfo


def _make_ctx(session_id="test-session") -> RunContext:
    return RunContext(session_id=session_id, run_id="test-run", agent_name="TestAgent")


async def _noop_model_handler(request: ModelRequest) -> AssistantMessage:
    return AssistantMessage(content="done")


# ---------------------------------------------------------------------------
# Lines 194-199: LLM returns empty/whitespace-only summary
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_summarisation_skipped_when_llm_returns_empty():
    """When LLM returns empty string as summary, no summary message is inserted."""
    mock_provider = MagicMock()

    async def _empty_stream(*_, **__):
        # Me yield chunk with empty content
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = ""
        chunk.usage = None
        yield chunk

    mock_provider.stream = lambda messages, **kw: _empty_stream()

    hook = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1,
        keep_last_assistants=1,
    )
    ctx = _make_ctx()
    state = AgentState(
        messages=[
            HumanMessage(content="msg1"),
            AssistantMessage(content="msg2"),
        ],
        usage=UsageInfo(last_prompt_tokens=9999),
    )

    await hook.before_model(ctx, state)
    await hook.wrap_model_call(
        ctx,
        state,
        ModelRequest(
            messages=tuple(state.messages_for_llm), system_prompt=state.system_prompt
        ),
        _noop_model_handler,
    )

    # Me check no summary inserted
    summary_msgs = [m for m in state.messages if getattr(m, "is_summary", False)]
    assert len(summary_msgs) == 0


@pytest.mark.asyncio
async def test_summarisation_skipped_when_llm_returns_none_content():
    """When LLM chunks have None content, summary text is empty → skip."""
    mock_provider = MagicMock()

    async def _none_stream(*_, **__):
        # Me yield chunk with None content
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = None
        chunk.usage = None
        yield chunk

    mock_provider.stream = lambda messages, **kw: _none_stream()

    hook = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1,
        keep_last_assistants=1,
    )
    ctx = _make_ctx()
    state = AgentState(
        messages=[HumanMessage(content="hi")],
        usage=UsageInfo(last_prompt_tokens=9999),
    )

    await hook.before_model(ctx, state)
    await hook.wrap_model_call(
        ctx,
        state,
        ModelRequest(
            messages=tuple(state.messages_for_llm), system_prompt=state.system_prompt
        ),
        _noop_model_handler,
    )

    summary_msgs = [m for m in state.messages if getattr(m, "is_summary", False)]
    assert len(summary_msgs) == 0


# ---------------------------------------------------------------------------
# Line 75: _find_assistant_cutoff with keep_last <= 0
# ---------------------------------------------------------------------------


def test_find_assistant_cutoff_keep_last_zero():
    """Line 75: keep_last <= 0 returns len(msgs) immediately."""
    from app.agent.hooks.summarization import _find_assistant_cutoff

    msgs = [
        HumanMessage(content="hi"),
        AssistantMessage(content="hello"),
        HumanMessage(content="more"),
        AssistantMessage(content="sure"),
    ]
    result = _find_assistant_cutoff(msgs, keep_last=0)
    assert result == len(msgs)


def test_find_assistant_cutoff_keep_last_negative():
    """keep_last < 0 also returns len(msgs)."""
    from app.agent.hooks.summarization import _find_assistant_cutoff

    msgs = [HumanMessage(content="hi"), AssistantMessage(content="hello")]
    result = _find_assistant_cutoff(msgs, keep_last=-1)
    assert result == len(msgs)


# ---------------------------------------------------------------------------
# build_summarization_hook coverage moved to test_build_summarization_hook.py
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# _summarise_inner — all messages in keep window → skips LLM call (lines 272-278)
# ---------------------------------------------------------------------------
# Note: lines 272-278 (the "to_summarise is empty" branch) require cutoff_idx > 0
# AND eligible[:cutoff_idx] to be empty — which is structurally impossible since
# cutoff_idx > 0 means at least one message precedes it.  These lines are
# effectively unreachable defensive code; there is no meaningful test to write.


# ---------------------------------------------------------------------------
# Summarization runs from wrap_model_call after prompt wrappers
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_wrap_model_call_runs_pending_summarization_with_final_prompt():
    """Summarization uses the final system prompt and forwards updated messages."""

    mock_provider = MagicMock()

    async def _summary_stream(*_, **__):
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = "Summary text here."
        chunk.usage = None
        yield chunk

    mock_provider.stream = lambda messages, **kw: _summary_stream()

    hook = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1,
        keep_last_assistants=1,
    )
    ctx = _make_ctx()
    state = AgentState(
        messages=[
            HumanMessage(content="msg1"),
            AssistantMessage(content="reply1"),
            HumanMessage(content="msg2"),
            AssistantMessage(content="reply2"),
        ],
        usage=UsageInfo(last_prompt_tokens=9999),
    )

    # Me build a real ModelRequest to pass in
    request = ModelRequest(
        messages=tuple(state.messages_for_llm),
        system_prompt="You are helpful.",
        context=None,
    )

    result = await hook.before_model(ctx, state, request)
    assert result is None

    handled: list[ModelRequest] = []

    async def _handler(req: ModelRequest) -> AssistantMessage:
        handled.append(req)
        return AssistantMessage(content="done")

    response = await hook.wrap_model_call(
        ctx,
        state,
        request.override(system_prompt="You are helpful.\n\nFinal injected prompt."),
        _handler,
    )

    assert response.content == "done"
    assert handled
    assert handled[0].system_prompt == "You are helpful.\n\nFinal injected prompt."
    assert any(m.is_summary for m in handled[0].messages)


# ---------------------------------------------------------------------------
# Line 244: prior summary in kept window is marked exclude_from_context=True
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_prior_summary_in_kept_window_excluded():
    """Line 244: existing is_summary=True message NOT in to_summarise_set gets excluded."""
    mock_provider = MagicMock()

    async def _summary_stream(*_, **__):
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = "New summary."
        chunk.usage = None
        yield chunk

    mock_provider.stream = lambda messages, **kw: _summary_stream()

    hook = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1,
        keep_last_assistants=1,
    )
    ctx = _make_ctx()

    # Me prior summary already in state (in the kept window — not in to_summarise)
    prior_summary = HumanMessage(
        content="[Summary] Old summary.",
        is_summary=True,
    )
    state = AgentState(
        messages=[
            HumanMessage(content="old msg 1"),
            AssistantMessage(content="old reply 1"),
            prior_summary,  # Me prior summary in kept window
            HumanMessage(content="recent msg"),
            AssistantMessage(content="recent reply"),
        ],
        usage=UsageInfo(last_prompt_tokens=9999),
    )

    await hook.before_model(ctx, state)
    await hook.wrap_model_call(
        ctx,
        state,
        ModelRequest(
            messages=tuple(state.messages_for_llm), system_prompt=state.system_prompt
        ),
        _noop_model_handler,
    )

    # Me prior summary should now be excluded (superseded by new summary)
    assert prior_summary.exclude_from_context is True
    # Me new summary should be in state
    new_summaries = [
        m
        for m in state.messages
        if getattr(m, "is_summary", False) and m is not prior_summary
    ]
    assert len(new_summaries) == 1
