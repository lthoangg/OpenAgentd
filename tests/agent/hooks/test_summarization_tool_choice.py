"""Tests for tool_choice="none" enforcement in SummarizationHook._call_llm.

The summariser must never invoke tools even when state.tool_defs are present.
tool_choice="none" is the API-level hard guard; these tests verify it is
always passed to the provider's stream() call and that the prompt no longer
carries the advisory "do not call tools" text.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from app.agent.hooks.summarization import (
    CHAT_SUMMARY_PROMPT,
    CODING_SUMMARY_PROMPT,
    SummarizationHook,
)
from app.agent.schemas.chat import AssistantMessage, HumanMessage
from app.agent.state import AgentState, ModelRequest, RunContext, UsageInfo


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_TOOL_DEF = {
    "type": "function",
    "function": {
        "name": "shell",
        "description": "Run a shell command",
        "parameters": {"type": "object", "properties": {}},
    },
}


def _make_ctx() -> RunContext:
    return RunContext(session_id="s1", run_id="r1", agent_name="bot")


def _make_state(*, with_tools: bool = True) -> AgentState:
    state = AgentState(
        messages=[
            HumanMessage(content="older message"),
            AssistantMessage(content="older reply"),
            HumanMessage(content="recent message"),
            AssistantMessage(content="recent reply"),
        ],
        usage=UsageInfo(last_prompt_tokens=99_999),
    )
    if with_tools:
        state.tool_defs = [_TOOL_DEF]
    return state


async def _noop_handler(req: ModelRequest) -> AssistantMessage:
    return AssistantMessage(content="done")


def _make_hook(provider) -> SummarizationHook:
    return SummarizationHook(
        llm_provider=provider,
        summary_prompt="Summarise the conversation.",
        prompt_token_threshold=1,
        keep_last_assistants=1,
        max_token_length=0,  # no max_tokens kwarg — isolates tool_choice check
    )


def _make_capturing_provider():
    """Provider that records every kwarg passed to stream() and returns a summary."""
    captured: list[dict] = []

    async def _gen():
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = "Summary."
        chunk.usage = None
        yield chunk

    provider = MagicMock()

    def _stream(messages, tools=None, **kwargs):
        captured.append({"tools": tools, **kwargs})
        return _gen()

    provider.stream.side_effect = _stream
    return provider, captured


# ---------------------------------------------------------------------------
# Core: tool_choice="none" always reaches stream()
# ---------------------------------------------------------------------------


async def test_call_llm_passes_tool_choice_none_with_tools():
    """tool_choice='none' is forwarded to stream() when tools are present."""
    provider, captured = _make_capturing_provider()
    hook = _make_hook(provider)
    ctx = _make_ctx()
    state = _make_state(with_tools=True)

    await hook.before_model(ctx, state)
    with patch("app.services.memory_stream_store.push_event"):
        await hook.wrap_model_call(
            ctx,
            state,
            ModelRequest(messages=tuple(state.messages_for_llm), system_prompt=""),
            _noop_handler,
        )

    assert len(captured) == 1
    assert captured[0]["tool_choice"] == "none"


async def test_call_llm_passes_tool_choice_none_without_tools():
    """tool_choice='none' is forwarded even when state.tool_defs is empty/None.

    The provider-level guard (only inject when tools list is non-empty) handles
    the wire safety; _call_llm always sends the kwarg regardless.
    """
    provider, captured = _make_capturing_provider()
    hook = _make_hook(provider)
    ctx = _make_ctx()
    state = _make_state(with_tools=False)

    await hook.before_model(ctx, state)
    with patch("app.services.memory_stream_store.push_event"):
        await hook.wrap_model_call(
            ctx,
            state,
            ModelRequest(messages=tuple(state.messages_for_llm), system_prompt=""),
            _noop_handler,
        )

    assert len(captured) == 1
    assert captured[0]["tool_choice"] == "none"


async def test_call_llm_tool_choice_none_alongside_max_tokens():
    """tool_choice='none' coexists correctly with max_tokens in kwargs."""
    provider, captured = _make_capturing_provider()
    hook = SummarizationHook(
        llm_provider=provider,
        summary_prompt="Summarise.",
        prompt_token_threshold=1,
        keep_last_assistants=1,
        max_token_length=500,  # non-zero → also sends max_tokens
    )
    ctx = _make_ctx()
    state = _make_state(with_tools=True)

    await hook.before_model(ctx, state)
    with patch("app.services.memory_stream_store.push_event"):
        await hook.wrap_model_call(
            ctx,
            state,
            ModelRequest(messages=tuple(state.messages_for_llm), system_prompt=""),
            _noop_handler,
        )

    assert captured[0]["tool_choice"] == "none"
    assert captured[0]["max_tokens"] == 500


async def test_normal_agent_loop_does_not_receive_tool_choice_none():
    """The tool_choice='none' kwarg must NOT leak into normal (non-summarisation) calls.

    The hook only calls stream() from _call_llm during summarisation. The
    agent loop's normal model call goes through wrap_model_call -> handler,
    which is a separate code path that never receives tool_choice.
    """
    provider, captured = _make_capturing_provider()
    hook = _make_hook(provider)
    ctx = _make_ctx()
    state = AgentState(
        messages=[HumanMessage(content="hi")],
        usage=UsageInfo(last_prompt_tokens=0),  # below threshold — no summarisation
    )

    normal_handler_calls: list[ModelRequest] = []

    async def _capturing_handler(req: ModelRequest) -> AssistantMessage:
        normal_handler_calls.append(req)
        return AssistantMessage(content="done")

    await hook.before_model(ctx, state)
    await hook.wrap_model_call(
        ctx,
        state,
        ModelRequest(messages=tuple(state.messages_for_llm), system_prompt=""),
        _capturing_handler,
    )

    # summariser stream() was never called
    assert len(captured) == 0
    # handler was called exactly once (normal path)
    assert len(normal_handler_calls) == 1


# ---------------------------------------------------------------------------
# Prompt no longer carries advisory "do not call tools" text
# ---------------------------------------------------------------------------


def test_chat_summary_prompt_has_no_tool_restriction_text():
    """CHAT_SUMMARY_PROMPT must not contain 'do not call tools' advisory text.

    The API-level tool_choice='none' is the sole enforcement; the prompt
    instruction was removed to avoid redundancy.
    """
    lowered = CHAT_SUMMARY_PROMPT.lower()
    assert "do not call tools" not in lowered
    assert "request tool execution" not in lowered


def test_coding_summary_prompt_has_no_tool_restriction_text():
    """CODING_SUMMARY_PROMPT must not contain 'do not call tools' advisory text."""
    lowered = CODING_SUMMARY_PROMPT.lower()
    assert "do not call tools" not in lowered
    assert "request tool execution" not in lowered


def test_chat_summary_prompt_still_has_return_only_summary():
    """Sanity check: removing the tool line didn't accidentally wipe other content."""
    assert "Return only the summary text" in CHAT_SUMMARY_PROMPT
    assert "third-person narrative" in CHAT_SUMMARY_PROMPT


def test_coding_summary_prompt_still_has_structure():
    """Sanity check: coding prompt template is intact."""
    assert "## Goal" in CODING_SUMMARY_PROMPT
    assert "## Next Steps" in CODING_SUMMARY_PROMPT
    assert "Return only the summary text" in CODING_SUMMARY_PROMPT


# ---------------------------------------------------------------------------
# tool_choice kwarg does not prevent a valid summary from being produced
# ---------------------------------------------------------------------------


async def test_summary_inserted_despite_tool_choice_none():
    """End-to-end: tool_choice='none' in the call does not prevent summary insertion."""
    provider, _ = _make_capturing_provider()
    hook = _make_hook(provider)
    ctx = _make_ctx()
    state = _make_state(with_tools=True)

    await hook.before_model(ctx, state)
    with patch("app.services.memory_stream_store.push_event"):
        await hook.wrap_model_call(
            ctx,
            state,
            ModelRequest(messages=tuple(state.messages_for_llm), system_prompt=""),
            _noop_handler,
        )

    summaries = [m for m in state.messages if getattr(m, "is_summary", False)]
    assert len(summaries) == 1
    assert summaries[0].content == "Summary."


async def test_tool_choice_none_does_not_suppress_tool_calls_in_subsequent_turn():
    """tool_choice='none' is only sent for the summarisation LLM call.

    After summarisation, the state.tool_defs are still present; the next
    normal agent turn should be able to use tools without restriction.
    tool_defs must remain in state after summarisation.
    """
    provider, captured = _make_capturing_provider()
    hook = _make_hook(provider)
    ctx = _make_ctx()
    state = _make_state(with_tools=True)

    await hook.before_model(ctx, state)
    with patch("app.services.memory_stream_store.push_event"):
        await hook.wrap_model_call(
            ctx,
            state,
            ModelRequest(messages=tuple(state.messages_for_llm), system_prompt=""),
            _noop_handler,
        )

    # tool_defs must still be present for the agent loop's next normal call
    assert state.tool_defs == [_TOOL_DEF]
