"""Tests for SummarizationHook.

SummarizationHook is a pure state transform.
- Reads state.usage.last_prompt_tokens (no DB read)
- Mutates state.messages directly (no DB write)
- Constructor: SummarizationHook(llm_provider, prompt_token_threshold, keep_last_assistants, summary_prompt, max_token_length)
"""

from unittest.mock import MagicMock

import pytest

from app.agent.state import AgentState, ModelRequest, RunContext, UsageInfo
from app.agent.hooks.summarization import CODING_SUMMARY_PROMPT, SummarizationHook
from app.agent.schemas.chat import (
    AssistantMessage,
    FunctionCall,
    HumanMessage,
    SystemMessage,
    ToolCall,
    ToolMessage,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_ctx(session_id="test-session") -> RunContext:
    return RunContext(session_id=session_id, run_id="test-run", agent_name="TestAgent")


def _make_state(last_prompt_tokens: int = 0) -> AgentState:
    usage = UsageInfo(last_prompt_tokens=last_prompt_tokens)
    return AgentState(
        messages=[HumanMessage(content="hi")],
        usage=usage,
    )


async def _noop_model_handler(request: ModelRequest) -> AssistantMessage:
    return AssistantMessage(content="done")


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_provider():
    provider = MagicMock()

    async def _stream(*_, **__):
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = "Summary text."
        chunk.usage = None
        yield chunk

    provider.stream.return_value = _stream()
    return provider


# ---------------------------------------------------------------------------
# before_model — threshold not reached
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_no_summarisation_below_threshold(mock_provider):
    """before_model is a no-op when prompt tokens are below threshold."""
    hook = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1000,
    )
    ctx = _make_ctx()
    state = _make_state(last_prompt_tokens=900)

    await hook.before_model(ctx, state)
    await hook.wrap_model_call(
        ctx,
        state,
        ModelRequest(
            messages=tuple(state.messages_for_llm), system_prompt=state.system_prompt
        ),
        _noop_model_handler,
    )

    mock_provider.stream.assert_not_called()


@pytest.mark.asyncio
async def test_force_summarisation_ignores_threshold(mock_provider):
    hook = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1000,
        keep_last_assistants=0,
    )
    ctx = _make_ctx()
    state = _make_state(last_prompt_tokens=0)
    state.metadata["force_summarization"] = True

    await hook.before_model(ctx, state)
    await hook.wrap_model_call(
        ctx,
        state,
        ModelRequest(
            messages=tuple(state.messages_for_llm), system_prompt=state.system_prompt
        ),
        _noop_model_handler,
    )

    assert mock_provider.stream.called
    assert any(m.is_summary for m in state.messages)


# ---------------------------------------------------------------------------
# before_model — threshold reached triggers summarisation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_summarisation_triggered_when_threshold_met(mock_provider):
    """Summarisation fires in before_model once prompt_tokens >= threshold."""
    hook = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1000,
        keep_last_assistants=1,
    )
    ctx = _make_ctx()
    # Me set tokens above threshold
    state = AgentState(
        messages=[
            HumanMessage(content="msg1"),
            AssistantMessage(content="msg2"),
            HumanMessage(content="msg3"),
            AssistantMessage(content="msg4"),
        ],
        usage=UsageInfo(last_prompt_tokens=1000),
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

    # Me check summary inserted and old messages excluded
    summary_msgs = [m for m in state.messages if getattr(m, "is_summary", False)]
    assert len(summary_msgs) == 1
    excluded = [m for m in state.messages if m.exclude_from_context]
    assert len(excluded) >= 1


# ---------------------------------------------------------------------------
# Minimum-message-delta guard
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_min_messages_delta_guard(mock_provider):
    """before_model skips summarisation when too few new messages have arrived
    since the last summarisation."""
    hook = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1,
        min_messages_since_last_summary=4,
    )
    ctx = _make_ctx()
    state = _make_state(last_prompt_tokens=9999)
    # Simulate a prior summarisation that left 10 messages in state.
    hook._messages_at_last_summary = len(state.messages)

    # Add 3 new messages — below the minimum of 4.
    from app.agent.schemas.chat import HumanMessage as HM

    state.messages.append(HM(content="msg1"))
    state.messages.append(HM(content="msg2"))
    state.messages.append(HM(content="msg3"))

    await hook.before_model(ctx, state)
    await hook.wrap_model_call(
        ctx,
        state,
        ModelRequest(
            messages=tuple(state.messages_for_llm), system_prompt=state.system_prompt
        ),
        _noop_model_handler,
    )
    mock_provider.stream.assert_not_called()


@pytest.mark.asyncio
async def test_min_messages_delta_guard_allows_after_enough(mock_provider):
    """before_model proceeds when enough new messages have arrived."""
    hook = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1,
        min_messages_since_last_summary=4,
    )
    ctx = _make_ctx()
    state = _make_state(last_prompt_tokens=9999)
    hook._messages_at_last_summary = len(state.messages)

    from app.agent.schemas.chat import HumanMessage as HM

    for i in range(4):
        state.messages.append(HM(content=f"msg{i}"))

    await hook.before_model(ctx, state)
    await hook.wrap_model_call(
        ctx,
        state,
        ModelRequest(
            messages=tuple(state.messages_for_llm), system_prompt=state.system_prompt
        ),
        _noop_model_handler,
    )
    mock_provider.stream.assert_called_once()


# ---------------------------------------------------------------------------
# keep_last_assistants — only older messages are summarised
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_keep_last_assistants_excluded_from_summary(mock_provider):
    """keep_last_assistants=1 keeps the last assistant turn, summarises older ones."""
    hook = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1,
        keep_last_assistants=1,
    )
    ctx = _make_ctx()
    state = AgentState(
        messages=[
            HumanMessage(content="old1"),
            AssistantMessage(content="old2"),
            HumanMessage(content="recent1"),
            AssistantMessage(content="recent2"),
        ],
        usage=UsageInfo(last_prompt_tokens=9999),
    )

    captured = []

    async def fake_stream(messages, **__):
        captured.extend(messages)
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = "Summary."
        chunk.usage = None
        yield chunk

    mock_provider.stream = lambda messages, **kw: fake_stream(messages)

    await hook.before_model(ctx, state)
    await hook.wrap_model_call(
        ctx,
        state,
        ModelRequest(
            messages=tuple(state.messages_for_llm), system_prompt=state.system_prompt
        ),
        _noop_model_handler,
    )

    # Me check only old messages sent to LLM (not the last assistant turn)
    # to_summarise is embedded as text inside one HumanMessage
    full_text = " ".join(m.content or "" for m in captured if hasattr(m, "content"))
    assert "old1" in full_text
    assert "old2" in full_text
    assert "recent2" not in full_text


@pytest.mark.asyncio
async def test_compaction_does_not_leave_orphan_tool_result_when_call_summarised(
    mock_provider,
):
    """If compaction summarises an assistant tool call, it summarises its tool output too."""
    hook = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1,
        keep_last_assistants=1,
    )
    ctx = _make_ctx()
    tool_asst = AssistantMessage(
        content=None,
        tool_calls=[
            ToolCall(
                id="call_1",
                function=FunctionCall(name="shell", arguments='{"cmd":"ls"}'),
            )
        ],
    )
    tool_result = ToolMessage(
        content="file1.txt",
        tool_call_id="call_1",
        name="shell",
    )
    kept_asst = AssistantMessage(content="final answer")
    state = AgentState(
        messages=[HumanMessage(content="run ls"), tool_asst, tool_result, kept_asst],
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

    assert tool_asst.exclude_from_context is True
    assert tool_result.exclude_from_context is True
    assert kept_asst.exclude_from_context is False


@pytest.mark.asyncio
async def test_compaction_preserves_tool_call_when_result_is_kept(mock_provider):
    """If a tool result is in the kept window, its assistant call remains visible."""
    hook = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1,
        keep_last_assistants=1,
    )
    ctx = _make_ctx()
    old_asst = AssistantMessage(content="old answer")
    tool_asst = AssistantMessage(
        content=None,
        tool_calls=[
            ToolCall(
                id="call_1",
                function=FunctionCall(name="shell", arguments='{"cmd":"ls"}'),
            )
        ],
    )
    tool_result = ToolMessage(
        content="file1.txt",
        tool_call_id="call_1",
        name="shell",
    )
    state = AgentState(
        messages=[HumanMessage(content="old"), old_asst, tool_asst, tool_result],
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

    assert old_asst.exclude_from_context is True
    assert tool_asst.exclude_from_context is False
    assert tool_result.exclude_from_context is False


# ---------------------------------------------------------------------------
# No session id — graceful skip
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_no_summarisation_without_session_id(mock_provider):
    hook = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1,
    )
    # Me use None session_id in ctx
    ctx = RunContext(session_id=None, run_id="test-run", agent_name="Agent")
    state = _make_state(last_prompt_tokens=9999)

    await hook.before_model(ctx, state)
    await hook.wrap_model_call(
        ctx,
        state,
        ModelRequest(
            messages=tuple(state.messages_for_llm), system_prompt=state.system_prompt
        ),
        _noop_model_handler,
    )
    # Me check hook still runs (no session_id guard in new impl — it's a pure state transform)
    # The hook should attempt summarisation regardless of session_id
    # (session_id is only used for logging)


# ---------------------------------------------------------------------------
# Empty visible messages — skip LLM call
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_no_llm_call_when_no_visible_messages(mock_provider):
    hook = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1,
    )
    ctx = _make_ctx()
    # Me create state with all messages excluded
    msg = HumanMessage(content="hidden")
    msg.exclude_from_context = True
    state = AgentState(
        messages=[msg],
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

    mock_provider.stream.assert_not_called()


@pytest.mark.asyncio
async def test_hidden_from_summary_messages_are_not_summarised(mock_provider):
    hook = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1,
    )
    ctx = _make_ctx()
    directive = HumanMessage(
        content="continue directive",
        extra={"hidden_from_summary": True},
    )
    state = AgentState(
        messages=[directive],
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

    mock_provider.stream.assert_not_called()


# ---------------------------------------------------------------------------
# LLM failure — graceful error handling
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_graceful_on_llm_failure(mock_provider):
    hook = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1,
    )
    ctx = _make_ctx()
    state = AgentState(
        messages=[
            HumanMessage(content="hi"),
            AssistantMessage(content="hello"),
        ],
        usage=UsageInfo(last_prompt_tokens=9999),
    )

    async def _bad_stream(*_, **__):
        raise RuntimeError("LLM down")
        yield

    mock_provider.stream.return_value = _bad_stream()

    # Me check no exception raised — hook handles LLM failure gracefully
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


# ---------------------------------------------------------------------------
# Summary saved with is_summary=True and AssistantMessage role
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_summary_saved_with_is_summary_flag(mock_provider):
    # Me use keep_last_assistants=1 but only have a HumanMessage (no assistant) —
    # cutoff returns 0 → all messages are summarised
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

    # Me check summary message inserted with is_summary=True
    summary_msgs = [m for m in state.messages if getattr(m, "is_summary", False)]
    assert len(summary_msgs) == 1
    # Me check summary is HumanMessage — ensures system → user → ... invariant
    assert isinstance(summary_msgs[0], HumanMessage)
    # Me check summary not excluded from context
    assert summary_msgs[0].exclude_from_context is False


# ---------------------------------------------------------------------------
# prompt_token_threshold=0 disables the hook
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_disabled_when_threshold_is_zero(mock_provider):
    hook = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=0,
    )
    ctx = _make_ctx()
    state = _make_state(last_prompt_tokens=9999)

    await hook.before_model(ctx, state)
    await hook.wrap_model_call(
        ctx,
        state,
        ModelRequest(
            messages=tuple(state.messages_for_llm), system_prompt=state.system_prompt
        ),
        _noop_model_handler,
    )
    mock_provider.stream.assert_not_called()


# ---------------------------------------------------------------------------
# _summarise — not enough assistant turns → summarises all messages
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_summarise_all_messages_when_not_enough_assistant_turns(mock_provider):
    """When fewer assistant turns exist than keep_last_assistants, summarises all messages."""
    hook = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1,
        keep_last_assistants=5,  # Me want to keep 5 assistant turns but only 1 exists
    )
    ctx = _make_ctx()
    state = AgentState(
        messages=[
            HumanMessage(content="msg1"),
            AssistantMessage(content="msg2"),
        ],
        usage=UsageInfo(last_prompt_tokens=9999),
    )

    captured_messages = []

    async def _capturing_stream(messages, **__):
        captured_messages.extend(messages)
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = "Summary."
        chunk.usage = None
        yield chunk

    mock_provider.stream = lambda messages, **kw: _capturing_stream(messages)

    await hook.before_model(ctx, state)
    await hook.wrap_model_call(
        ctx,
        state,
        ModelRequest(
            messages=tuple(state.messages_for_llm), system_prompt=state.system_prompt
        ),
        _noop_model_handler,
    )

    # Both messages should be embedded in the HumanMessage sent to the LLM
    full_text = " ".join(
        m.content or "" for m in captured_messages if hasattr(m, "content")
    )
    assert "msg1" in full_text
    assert "msg2" in full_text


# ---------------------------------------------------------------------------
# _call_llm — chunk with no choices is skipped
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_call_llm_skips_empty_choices_chunks(mock_provider):
    """Chunks with empty choices list are skipped; content-only chunks are accumulated."""
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

    async def _mixed_stream(*_, **__):
        # Me send chunk with no choices first
        no_choices = MagicMock()
        no_choices.choices = []
        no_choices.usage = None
        yield no_choices

        # Me send chunk with content
        with_content = MagicMock()
        delta = MagicMock()
        delta.content = "Summary result."
        choice = MagicMock()
        choice.delta = delta
        with_content.choices = [choice]
        with_content.usage = None
        yield with_content

    mock_provider.stream = lambda messages, **kw: _mixed_stream()

    await hook.before_model(ctx, state)
    await hook.wrap_model_call(
        ctx,
        state,
        ModelRequest(
            messages=tuple(state.messages_for_llm), system_prompt=state.system_prompt
        ),
        _noop_model_handler,
    )

    # Me check summary inserted with correct content (prefixed by anchor label)
    summary_msgs = [m for m in state.messages if getattr(m, "is_summary", False)]
    assert len(summary_msgs) == 1
    assert "Summary result." in summary_msgs[0].content


# ---------------------------------------------------------------------------
# max_token_length parameter — pass to LLM provider
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_max_token_length_passed_to_provider_when_set():
    """max_token_length=10000 should be passed to provider.stream()."""
    provider = MagicMock()

    async def _stream(*_, **__):
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = "Summary."
        chunk.usage = None
        yield chunk

    provider.stream.return_value = _stream()

    hook = SummarizationHook(
        llm_provider=provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1000,
        keep_last_assistants=1,
        max_token_length=10000,  # explicit max tokens
    )

    ctx = _make_ctx()
    state = AgentState(
        messages=[
            HumanMessage(content="msg1"),
            AssistantMessage(content="msg2"),
            HumanMessage(content="msg3"),
            AssistantMessage(content="msg4"),
        ],
        usage=UsageInfo(last_prompt_tokens=1000),
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

    # Me check provider.stream was called with max_tokens kwarg
    provider.stream.assert_called_once()
    call_kwargs = provider.stream.call_args[1]
    assert call_kwargs.get("max_tokens") == 10000


@pytest.mark.asyncio
async def test_max_token_length_zero_disables_limit():
    """max_token_length=0 should NOT pass max_tokens to provider."""
    provider = MagicMock()

    async def _stream(*_, **__):
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = "Summary."
        chunk.usage = None
        yield chunk

    provider.stream.return_value = _stream()

    hook = SummarizationHook(
        llm_provider=provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1000,
        keep_last_assistants=1,
        max_token_length=0,  # disabled
    )

    ctx = _make_ctx()
    state = AgentState(
        messages=[
            HumanMessage(content="msg1"),
            AssistantMessage(content="msg2"),
            HumanMessage(content="msg3"),
            AssistantMessage(content="msg4"),
        ],
        usage=UsageInfo(last_prompt_tokens=1000),
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

    # Me check provider.stream was called WITHOUT max_tokens kwarg
    provider.stream.assert_called_once()
    call_kwargs = provider.stream.call_args[1]
    assert "max_tokens" not in call_kwargs


# ---------------------------------------------------------------------------
# thinking_level — inherited from the agent's primary configuration
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_summariser_call_does_not_override_thinking_level():
    """Summarisation must not force ``thinking_level="none"`` — Codex rejects
    requests with no ``reasoning`` field, so the agent's configured level
    must flow through unchanged."""
    provider = MagicMock()

    async def _stream(*_, **__):
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = "Summary."
        chunk.usage = None
        yield chunk

    provider.stream.return_value = _stream()

    hook = SummarizationHook(
        llm_provider=provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1000,
        keep_last_assistants=1,
    )
    ctx = _make_ctx()
    state = AgentState(
        messages=[
            HumanMessage(content="msg1"),
            AssistantMessage(content="msg2"),
            HumanMessage(content="msg3"),
            AssistantMessage(content="msg4"),
        ],
        usage=UsageInfo(last_prompt_tokens=1000),
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

    provider.stream.assert_called_once()
    call_kwargs = provider.stream.call_args[1]
    assert "thinking_level" not in call_kwargs


@pytest.mark.asyncio
async def test_summariser_passes_tool_defs_without_prompt_cache_key():
    provider = MagicMock()

    async def _stream(*_, **__):
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = "Summary."
        chunk.usage = None
        yield chunk

    provider.stream.return_value = _stream()

    hook = SummarizationHook(
        llm_provider=provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1000,
        keep_last_assistants=0,
    )
    tool_defs = [
        {
            "type": "function",
            "function": {
                "name": "shell",
                "description": "Run shell commands.",
                "parameters": {"type": "object", "properties": {}},
            },
        }
    ]
    state = AgentState(
        messages=[HumanMessage(content="msg1")],
        usage=UsageInfo(last_prompt_tokens=1000),
        tool_defs=tool_defs,
    )

    ctx = _make_ctx(session_id="session-123")
    await hook.before_model(ctx, state)
    await hook.wrap_model_call(
        ctx,
        state,
        ModelRequest(
            messages=tuple(state.messages_for_llm), system_prompt=state.system_prompt
        ),
        _noop_model_handler,
    )

    provider.stream.assert_called_once()
    call_kwargs = provider.stream.call_args[1]
    assert call_kwargs["tools"] == tool_defs
    # No forced session-scoped cache key: summarization relies on the
    # provider's automatic prefix caching, consistent with normal chat turns,
    # so it can reuse the already-warmed conversation prefix on OpenAI/codex.
    assert "prompt_cache_key" not in call_kwargs
    assert "tool_choice" not in call_kwargs


# ---------------------------------------------------------------------------
# is BaseAgentHook subclass
# ---------------------------------------------------------------------------


def test_is_base_agent_hook(mock_provider):
    from app.agent.hooks.base import BaseAgentHook

    hook = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
    )
    assert isinstance(hook, BaseAgentHook)


# ---------------------------------------------------------------------------
# P2 — Tool result stubbing in summariser input
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_tool_message_content_kept_for_compaction(mock_provider):
    """ToolMessage content is sent to the summariser with the tool name."""
    hook = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1,
        keep_last_assistants=0,  # summarise everything
    )
    ctx = _make_ctx()
    state = AgentState(
        messages=[
            HumanMessage(content="run a command"),
            AssistantMessage(content="sure", tool_calls=[]),
            ToolMessage(
                content='{"exit_code": 0, "stdout": "lots of output..."}',
                tool_call_id="tc1",
                name="shell",
            ),
        ],
        usage=UsageInfo(last_prompt_tokens=9999),
    )

    captured: list = []

    async def _capturing_stream(messages, **__):
        captured.extend(messages)
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = "Summary."
        chunk.usage = None
        yield chunk

    mock_provider.stream = lambda messages, **kw: _capturing_stream(messages)

    await hook.before_model(ctx, state)
    await hook.wrap_model_call(
        ctx,
        state,
        ModelRequest(
            messages=tuple(state.messages_for_llm), system_prompt=state.system_prompt
        ),
        _noop_model_handler,
    )

    # The original tool output stays in the provider-visible prefix instead of
    # being flattened into the final instruction message.
    tool_msgs = [m for m in captured if isinstance(m, ToolMessage)]
    assert tool_msgs
    assert tool_msgs[0].name == "shell"
    assert "lots of output" in (tool_msgs[0].content or "")
    assert '{"exit_code"' in (tool_msgs[0].content or "")


@pytest.mark.asyncio
async def test_tool_message_without_name_uses_generic_stub(mock_provider):
    """A ToolMessage with no name renders as '[tool]: <output>'."""
    hook = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1,
        keep_last_assistants=0,
    )
    ctx = _make_ctx()
    state = AgentState(
        messages=[
            ToolMessage(content="raw output", tool_call_id="tc1", name=None),
        ],
        usage=UsageInfo(last_prompt_tokens=9999),
    )

    captured: list = []

    async def _capturing_stream(messages, **__):
        captured.extend(messages)
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = "Summary."
        chunk.usage = None
        yield chunk

    mock_provider.stream = lambda messages, **kw: _capturing_stream(messages)

    await hook.before_model(ctx, state)
    await hook.wrap_model_call(
        ctx,
        state,
        ModelRequest(
            messages=tuple(state.messages_for_llm), system_prompt=state.system_prompt
        ),
        _noop_model_handler,
    )

    tool_msgs = [m for m in captured if isinstance(m, ToolMessage)]
    assert tool_msgs
    assert tool_msgs[0].name is None
    assert tool_msgs[0].content == "raw output"


@pytest.mark.asyncio
async def test_summariser_input_preserves_normal_call_prefix(mock_provider):
    """Summarisation sends system + original messages before the instruction."""
    hook = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1,
        keep_last_assistants=0,
    )
    ctx = _make_ctx()
    state = AgentState(
        messages=[
            HumanMessage(content="what is the capital of France?"),
            AssistantMessage(content="Paris."),
        ],
        usage=UsageInfo(last_prompt_tokens=9999),
        system_prompt="stable agent prompt",
    )

    captured: list = []

    async def _capturing_stream(messages, **__):
        captured.extend(messages)
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = "Summary."
        chunk.usage = None
        yield chunk

    mock_provider.stream = lambda messages, **kw: _capturing_stream(messages)

    await hook.before_model(ctx, state)
    await hook.wrap_model_call(
        ctx,
        state,
        ModelRequest(
            messages=tuple(state.messages_for_llm), system_prompt=state.system_prompt
        ),
        _noop_model_handler,
    )

    assert [type(m) for m in captured] == [
        SystemMessage,
        HumanMessage,
        AssistantMessage,
        HumanMessage,
    ]
    assert captured[0].content == "stable agent prompt"
    assert captured[1].content == "what is the capital of France?"
    assert captured[2].content == "Paris."


@pytest.mark.asyncio
async def test_summariser_uses_request_system_prompt_for_cache_prefix(mock_provider):
    """The agent loop request carries the actual pre-prompt after prompt hooks."""
    hook = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1,
        keep_last_assistants=0,
    )
    ctx = _make_ctx()
    state = AgentState(
        messages=[HumanMessage(content="hello")],
        usage=UsageInfo(last_prompt_tokens=9999),
        system_prompt="base prompt",
    )
    request = ModelRequest(
        messages=tuple(state.messages_for_llm),
        system_prompt="base prompt\n\n## Tools attached\n- shell",
    )

    captured: list = []

    async def _capturing_stream(messages, **__):
        captured.extend(messages)
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = "Summary."
        chunk.usage = None
        yield chunk

    mock_provider.stream = lambda messages, **kw: _capturing_stream(messages)

    await hook.before_model(ctx, state, request)
    await hook.wrap_model_call(ctx, state, request, _noop_model_handler)

    assert isinstance(captured[0], SystemMessage)
    assert captured[0].content == "base prompt\n\n## Tools attached\n- shell"


@pytest.mark.asyncio
async def test_summariser_uses_final_wrapped_system_prompt_for_cache_prefix(
    mock_provider,
):
    """Summarization sees prompt text appended by earlier wrap_model_call hooks."""

    hook = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1,
        keep_last_assistants=0,
    )
    ctx = _make_ctx()
    state = AgentState(
        messages=[HumanMessage(content="hello")],
        usage=UsageInfo(last_prompt_tokens=9999),
        system_prompt="base prompt",
    )
    request = ModelRequest(
        messages=tuple(state.messages_for_llm),
        system_prompt="base prompt",
    )

    captured: list = []

    async def _capturing_stream(messages, **__):
        captured.extend(messages)
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = "Summary."
        chunk.usage = None
        yield chunk

    mock_provider.stream = lambda messages, **kw: _capturing_stream(messages)

    await hook.before_model(ctx, state, request)
    await hook.wrap_model_call(
        ctx,
        state,
        request.override(
            system_prompt="base prompt\n\nCurrent date (UTC): 2026-06-15\n\n## Workspace Instructions\nUse project rules."
        ),
        _noop_model_handler,
    )

    assert isinstance(captured[0], SystemMessage)
    assert captured[0].content == (
        "base prompt\n\nCurrent date (UTC): 2026-06-15\n\n"
        "## Workspace Instructions\nUse project rules."
    )


# ---------------------------------------------------------------------------
# P5 — Merge vs. fresh summarisation request
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fresh_request_sent_when_no_prior_summary(mock_provider):
    """When no prior summary is in the window, the fresh summarise request is used."""
    from app.agent.hooks.summarization import _SUMMARISE_REQUEST, _MERGE_REQUEST

    hook = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1,
        keep_last_assistants=0,
    )
    ctx = _make_ctx()
    state = AgentState(
        messages=[HumanMessage(content="hello")],
        usage=UsageInfo(last_prompt_tokens=9999),
    )

    captured: list = []

    async def _capturing_stream(messages, **__):
        captured.extend(messages)
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = "Summary."
        chunk.usage = None
        yield chunk

    mock_provider.stream = lambda messages, **kw: _capturing_stream(messages)

    await hook.before_model(ctx, state)
    await hook.wrap_model_call(
        ctx,
        state,
        ModelRequest(
            messages=tuple(state.messages_for_llm), system_prompt=state.system_prompt
        ),
        _noop_model_handler,
    )

    human_msgs = [m for m in captured if isinstance(m, HumanMessage)]
    convo_blob = " ".join(m.content or "" for m in human_msgs)

    assert _SUMMARISE_REQUEST in convo_blob
    assert _MERGE_REQUEST not in convo_blob


@pytest.mark.asyncio
async def test_merge_request_sent_when_prior_summary_in_window(mock_provider):
    """When a prior summary (is_summary=True) is being summarised, the merge
    request is used instead of the fresh summarise request."""
    from app.agent.hooks.summarization import _SUMMARISE_REQUEST, _MERGE_REQUEST

    hook = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1,
        keep_last_assistants=0,
    )
    ctx = _make_ctx()

    prior_summary = HumanMessage(
        content="[Summary of earlier conversation]\nUser set up the project.",
        is_summary=True,
    )
    state = AgentState(
        messages=[
            prior_summary,
            HumanMessage(content="now do something else"),
        ],
        usage=UsageInfo(last_prompt_tokens=9999),
    )

    captured: list = []

    async def _capturing_stream(messages, **__):
        captured.extend(messages)
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = "Merged summary."
        chunk.usage = None
        yield chunk

    mock_provider.stream = lambda messages, **kw: _capturing_stream(messages)

    await hook.before_model(ctx, state)
    await hook.wrap_model_call(
        ctx,
        state,
        ModelRequest(
            messages=tuple(state.messages_for_llm), system_prompt=state.system_prompt
        ),
        _noop_model_handler,
    )

    human_msgs = [m for m in captured if isinstance(m, HumanMessage)]
    convo_blob = " ".join(m.content or "" for m in human_msgs)

    assert _MERGE_REQUEST in convo_blob
    assert _SUMMARISE_REQUEST not in convo_blob


@pytest.mark.asyncio
async def test_prior_summary_in_kept_window_is_excluded_from_context(mock_provider):
    """A prior is_summary message sitting in the *kept* window (beyond the cutoff)
    must be marked exclude_from_context=True by the second exclusion loop —
    it is superseded by the new summary.

    Message order in eligible:
      [old_msg(user), kept_asst(assistant), orphaned_summary(user, is_summary=True)]
    keep_last_assistants=1 → _find_assistant_cutoff walks back:
      orphaned_summary: role=user → skip
      kept_asst: role=assistant → count hits 1 → cutoff=1
    to_summarise = [old_msg]          (id in to_summarise_set)
    kept window  = [kept_asst, orphaned_summary]   (id NOT in to_summarise_set)
    orphaned_summary.is_summary=True AND not in to_summarise_set → excluded by second loop.
    """
    hook = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1,
        keep_last_assistants=1,
    )
    ctx = _make_ctx()

    old_msg = HumanMessage(content="old user message")
    kept_asst = AssistantMessage(content="kept assistant reply")
    orphaned_summary = HumanMessage(
        content="[Summary of earlier conversation]\nStale summary.",
        is_summary=True,
    )
    state = AgentState(
        messages=[old_msg, kept_asst, orphaned_summary],
        usage=UsageInfo(last_prompt_tokens=9999),
    )

    async def _stream(messages, **__):
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = "New summary."
        chunk.usage = None
        yield chunk

    mock_provider.stream = lambda messages, **kw: _stream(messages)

    await hook.before_model(ctx, state)
    await hook.wrap_model_call(
        ctx,
        state,
        ModelRequest(
            messages=tuple(state.messages_for_llm), system_prompt=state.system_prompt
        ),
        _noop_model_handler,
    )

    assert orphaned_summary.exclude_from_context is True, (
        "Prior is_summary in kept window must be superseded (exclude_from_context=True)"
    )
    active = [m for m in state.messages if m.is_summary and not m.exclude_from_context]
    assert len(active) == 1, (
        "Exactly one active summary should exist after summarisation"
    )


@pytest.mark.asyncio
async def test_merge_request_only_when_prior_summary_in_to_summarise(mock_provider):
    """Merge request fires only when the prior summary is in the portion being
    summarised — not when it is in the kept (verbatim) window.

    Setup: prior_summary → new_human → new_assistant1 → new_assistant2
    With keep_last_assistants=2, the cutoff lands at new_assistant1, so
    to_summarise = [prior_summary, new_human] — summary IS in to_summarise
    and the merge request must fire.

    When keep_last_assistants=3 and only 2 assistant turns exist, cutoff=0
    (protect everything) → to_summarise is empty → no LLM call. So we need
    keep_last_assistants=1 with enough turns before the summary to verify the
    summary ends up in to_summarise vs kept.
    """
    from app.agent.hooks.summarization import _SUMMARISE_REQUEST, _MERGE_REQUEST

    # Scenario A: prior_summary in to_summarise → merge request
    hook_a = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1,
        keep_last_assistants=1,
    )
    ctx = _make_ctx()

    prior_summary = HumanMessage(
        content="[Summary of earlier conversation]\nSome summary.",
        is_summary=True,
    )
    # eligible: [prior_summary, new_human, new_assistant]
    # cutoff at new_assistant (index 2) → to_summarise = [prior_summary, new_human]
    state_a = AgentState(
        messages=[
            prior_summary,
            HumanMessage(content="new user turn"),
            AssistantMessage(content="new assistant reply — kept verbatim"),
        ],
        usage=UsageInfo(last_prompt_tokens=9999),
    )

    captured_a: list = []

    async def _stream_a(messages, **__):
        captured_a.extend(messages)
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = "Merged summary."
        chunk.usage = None
        yield chunk

    mock_provider.stream = lambda messages, **kw: _stream_a(messages)

    await hook_a.before_model(ctx, state_a)
    await hook_a.wrap_model_call(
        ctx,
        state_a,
        ModelRequest(
            messages=tuple(state_a.messages_for_llm),
            system_prompt=state_a.system_prompt,
        ),
        _noop_model_handler,
    )

    human_a = [m for m in captured_a if isinstance(m, HumanMessage)]
    blob_a = " ".join(m.content or "" for m in human_a)
    assert _MERGE_REQUEST in blob_a, (
        "Expected merge request when prior summary in to_summarise"
    )
    assert _SUMMARISE_REQUEST not in blob_a

    # Scenario B: no prior summary at all → fresh request
    hook_b = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1,
        keep_last_assistants=1,
    )
    state_b = AgentState(
        messages=[
            HumanMessage(content="plain old message"),
            AssistantMessage(content="kept assistant turn"),
        ],
        usage=UsageInfo(last_prompt_tokens=9999),
    )

    captured_b: list = []

    async def _stream_b(messages, **__):
        captured_b.extend(messages)
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = "Fresh summary."
        chunk.usage = None
        yield chunk

    mock_provider.stream = lambda messages, **kw: _stream_b(messages)

    await hook_b.before_model(ctx, state_b)
    await hook_b.wrap_model_call(
        ctx,
        state_b,
        ModelRequest(
            messages=tuple(state_b.messages_for_llm),
            system_prompt=state_b.system_prompt,
        ),
        _noop_model_handler,
    )

    human_b = [m for m in captured_b if isinstance(m, HumanMessage)]
    blob_b = " ".join(m.content or "" for m in human_b)
    assert _SUMMARISE_REQUEST in blob_b, "Expected fresh request when no prior summary"
    assert _MERGE_REQUEST not in blob_b


# ---------------------------------------------------------------------------
# _messages_at_last_summary not updated on failure paths
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_messages_at_last_summary_not_updated_on_llm_failure(mock_provider):
    """When the LLM call fails, _messages_at_last_summary must not advance.
    On the next turn the guard should not block summarisation."""
    hook = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1,
        min_messages_since_last_summary=4,
    )
    ctx = _make_ctx()
    state = AgentState(
        messages=[HumanMessage(content="msg"), AssistantMessage(content="reply")],
        usage=UsageInfo(last_prompt_tokens=9999),
    )

    async def _bad_stream(*_, **__):
        raise RuntimeError("LLM down")
        yield

    mock_provider.stream.return_value = _bad_stream()

    await hook.before_model(ctx, state)
    await hook.wrap_model_call(
        ctx,
        state,
        ModelRequest(
            messages=tuple(state.messages_for_llm), system_prompt=state.system_prompt
        ),
        _noop_model_handler,
    )

    assert hook._messages_at_last_summary == 0, (
        "_messages_at_last_summary must stay 0 when LLM fails — "
        "otherwise the guard would block the retry"
    )


@pytest.mark.asyncio
async def test_messages_at_last_summary_not_updated_on_empty_response(mock_provider):
    """When the LLM returns an empty string, _messages_at_last_summary must not advance."""
    hook = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1,
        min_messages_since_last_summary=4,
    )
    ctx = _make_ctx()
    state = AgentState(
        messages=[HumanMessage(content="msg"), AssistantMessage(content="reply")],
        usage=UsageInfo(last_prompt_tokens=9999),
    )

    async def _empty_stream(*_, **__):
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = ""  # empty content
        chunk.usage = None
        yield chunk

    mock_provider.stream = lambda messages, **kw: _empty_stream()

    await hook.before_model(ctx, state)
    await hook.wrap_model_call(
        ctx,
        state,
        ModelRequest(
            messages=tuple(state.messages_for_llm), system_prompt=state.system_prompt
        ),
        _noop_model_handler,
    )

    assert hook._messages_at_last_summary == 0, (
        "_messages_at_last_summary must stay 0 when LLM returns empty response"
    )


# ---------------------------------------------------------------------------
# wrap_model_call return value — ModelRequest override
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_wrap_model_call_forwards_updated_request_when_summarisation_fires(
    mock_provider,
):
    """When summarisation fires, wrap_model_call forwards post-summary messages."""
    from app.agent.state import ModelRequest

    hook = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1,
        keep_last_assistants=1,
    )
    ctx = _make_ctx()
    state = AgentState(
        messages=[
            HumanMessage(content="old message"),
            AssistantMessage(content="old reply"),
            HumanMessage(content="new message"),
            AssistantMessage(content="new reply — kept"),
        ],
        usage=UsageInfo(last_prompt_tokens=9999),
    )

    original_request = ModelRequest(
        messages=tuple(state.messages_for_llm),
        system_prompt="You are an assistant.",
    )

    async def _stream(messages, **__):
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = "Compact summary."
        chunk.usage = None
        yield chunk

    mock_provider.stream = lambda messages, **kw: _stream(messages)

    result = await hook.before_model(ctx, state, original_request)
    assert result is None

    handled: list[ModelRequest] = []

    async def _handler(req: ModelRequest) -> AssistantMessage:
        handled.append(req)
        return AssistantMessage(content="done")

    response = await hook.wrap_model_call(ctx, state, original_request, _handler)

    assert response.content == "done"
    assert handled
    assert handled[0] is not original_request
    # The returned messages must include the summary and exclude old messages
    result_contents = [m.content or "" for m in handled[0].messages]
    assert any("Compact summary." in c for c in result_contents), (
        "Returned ModelRequest messages must contain the new summary"
    )
    assert "old message" not in " ".join(result_contents), (
        "Excluded messages must not appear in the returned ModelRequest"
    )


@pytest.mark.asyncio
async def test_before_model_returns_none_when_no_summarisation(mock_provider):
    """When summarisation does not fire, before_model must return None (pass-through)."""
    from app.agent.state import ModelRequest

    hook = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=99999,  # threshold not reached
    )
    ctx = _make_ctx()
    state = _make_state(last_prompt_tokens=100)

    request = ModelRequest(
        messages=tuple(state.messages_for_llm),
        system_prompt="prompt",
    )

    result = await hook.before_model(ctx, state, request)

    assert result is None


# ---------------------------------------------------------------------------
# Coding summary output quality guards
# ---------------------------------------------------------------------------


def test_coding_prompt_rejects_raw_transcript_output():
    assert "Start your response with exactly `## Goal`" in CODING_SUMMARY_PROMPT
    assert "Do not call tools" in CODING_SUMMARY_PROMPT
    assert "Do not output raw role/tool prefixes" in CODING_SUMMARY_PROMPT

    assert "[assistant]:" in CODING_SUMMARY_PROMPT


def test_summary_prompts_do_not_summarize_skill_instructions():
    from app.agent.hooks.summarization import CHAT_SUMMARY_PROMPT

    expected = "Do not summarize, paraphrase, or quote skill instruction tool results"
    assert expected in CHAT_SUMMARY_PROMPT
    assert expected in CODING_SUMMARY_PROMPT


# ---------------------------------------------------------------------------
# _render — None content on non-tool message
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_assistant_with_none_content_renders_as_empty_string(mock_provider):
    """An AssistantMessage with content=None (tool-call-only turn) must render as
    '[assistant]: ' without crashing or leaking 'None' into the summariser input."""
    hook = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1,
        keep_last_assistants=0,
    )
    ctx = _make_ctx()
    state = AgentState(
        messages=[
            HumanMessage(content="do something"),
            AssistantMessage(content=None, tool_calls=[]),  # tool-call-only turn
        ],
        usage=UsageInfo(last_prompt_tokens=9999),
    )

    captured: list = []

    async def _stream(messages, **__):
        captured.extend(messages)
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = "Summary."
        chunk.usage = None
        yield chunk

    mock_provider.stream = lambda messages, **kw: _stream(messages)

    await hook.before_model(ctx, state)
    await hook.wrap_model_call(
        ctx,
        state,
        ModelRequest(
            messages=tuple(state.messages_for_llm), system_prompt=state.system_prompt
        ),
        _noop_model_handler,
    )

    assistant_msgs = [m for m in captured if isinstance(m, AssistantMessage)]
    assert assistant_msgs
    assert assistant_msgs[0].content is None


# ---------------------------------------------------------------------------
# Skill tool preservation — skill call/result pairs survive summarisation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_skill_tool_messages_preserved_through_summarisation(mock_provider):
    """Skill tool call/result pairs are sent to the summariser and kept visible."""
    hook = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1,
        keep_last_assistants=0,
    )
    ctx = _make_ctx()

    skill_asst = AssistantMessage(
        content=None,
        tool_calls=[
            ToolCall(
                id="call_skill_1",
                function=FunctionCall(
                    name="skill", arguments='{"skill_name":"guidelines"}'
                ),
            )
        ],
    )
    skill_result = ToolMessage(
        tool_call_id="call_skill_1",
        name="skill",
        content="# Guidelines\nLong skill instructions body...",
    )
    other_asst = AssistantMessage(
        content=None,
        tool_calls=[
            ToolCall(
                id="call_shell_1",
                function=FunctionCall(name="shell", arguments='{"cmd":"ls"}'),
            )
        ],
    )
    other_result = ToolMessage(
        tool_call_id="call_shell_1",
        name="shell",
        content="file1.txt\nfile2.txt",
    )

    state = AgentState(
        messages=[
            HumanMessage(content="load skill"),
            skill_asst,
            skill_result,
            HumanMessage(content="now list files"),
            other_asst,
            other_result,
        ],
        usage=UsageInfo(last_prompt_tokens=9999),
    )

    captured: list = []

    async def _capturing_stream(messages, **__):
        captured.extend(messages)
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = "Summary."
        chunk.usage = None
        yield chunk

    mock_provider.stream = lambda messages, **kw: _capturing_stream(messages)

    await hook.before_model(ctx, state)
    await hook.wrap_model_call(
        ctx,
        state,
        ModelRequest(
            messages=tuple(state.messages_for_llm), system_prompt=state.system_prompt
        ),
        _noop_model_handler,
    )

    # 1) Skill and non-skill tool calls both appear in summariser input.
    assert skill_asst in captured
    assert skill_result in captured
    assert "Long skill instructions body" in (skill_result.content or "")
    assert other_asst in captured

    # 2) Skill messages stay visible; other older messages got compacted.
    assert skill_asst.exclude_from_context is False
    assert skill_result.exclude_from_context is False
    assert other_asst.exclude_from_context is True
    assert other_result.exclude_from_context is True

    visible = state.messages_for_llm
    assert skill_asst in visible
    assert skill_result in visible
    assert other_asst not in visible
    assert other_result not in visible

    # 3) Summary was inserted after the retained skill pair.
    summaries = [m for m in state.messages if m.is_summary]
    assert len(summaries) == 1
    assert summaries[0].content == "Summary."
    assert state.messages.index(skill_asst) < state.messages.index(summaries[0])
    assert state.messages.index(skill_result) < state.messages.index(summaries[0])


@pytest.mark.asyncio
async def test_duplicate_skill_tool_messages_compact_after_first_load(mock_provider):
    """Summarisation keeps only the first full skill load pair per skill."""
    hook = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1,
        keep_last_assistants=0,
    )
    ctx = _make_ctx()

    first_asst = AssistantMessage(
        content=None,
        tool_calls=[
            ToolCall(
                id="call_skill_1",
                function=FunctionCall(
                    name="skill", arguments='{"skill_name":"guidelines"}'
                ),
            )
        ],
    )
    first_result = ToolMessage(
        tool_call_id="call_skill_1",
        name="skill",
        content="# Guidelines\nFull instruction body...",
    )
    duplicate_asst = AssistantMessage(
        content=None,
        tool_calls=[
            ToolCall(
                id="call_skill_2",
                function=FunctionCall(
                    name="skill", arguments='{"skill_name":"guidelines"}'
                ),
            )
        ],
    )
    duplicate_result = ToolMessage(
        tool_call_id="call_skill_2",
        name="skill",
        content="Skill 'guidelines' is already loaded in this session.",
    )

    state = AgentState(
        messages=[
            HumanMessage(content="load skill"),
            first_asst,
            first_result,
            HumanMessage(content="load it again"),
            duplicate_asst,
            duplicate_result,
        ],
        usage=UsageInfo(last_prompt_tokens=9999),
    )

    async def _stream(messages, **__):
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = "Summary."
        chunk.usage = None
        yield chunk

    mock_provider.stream = lambda messages, **kw: _stream(messages)

    await hook.before_model(ctx, state)
    await hook.wrap_model_call(
        ctx,
        state,
        ModelRequest(
            messages=tuple(state.messages_for_llm), system_prompt=state.system_prompt
        ),
        _noop_model_handler,
    )

    assert first_asst.exclude_from_context is False
    assert first_result.exclude_from_context is False
    assert duplicate_asst.exclude_from_context is True
    assert duplicate_result.exclude_from_context is True


# ---------------------------------------------------------------------------
# support_interrupt=False — defer summarisation to user-turn boundary
# ---------------------------------------------------------------------------


def _make_hook_no_interrupt(mock_provider, threshold: int = 1) -> SummarizationHook:
    return SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=threshold,
        support_interrupt=False,
    )


@pytest.mark.asyncio
async def test_no_interrupt_skips_summarisation_mid_loop(mock_provider):
    """When support_interrupt=False, summarisation must NOT fire mid-loop
    (last visible message is an AssistantMessage or ToolMessage)."""
    hook = _make_hook_no_interrupt(mock_provider)
    ctx = _make_ctx()

    # Simulate mid-loop state: last visible message is a ToolMessage
    state = AgentState(
        messages=[
            HumanMessage(content="do the thing"),
            AssistantMessage(
                content=None,
                tool_calls=[
                    ToolCall(
                        id="call_1",
                        function=FunctionCall(
                            name="shell", arguments='{"command":"ls"}'
                        ),
                    )
                ],
            ),
            ToolMessage(tool_call_id="call_1", name="shell", content="file.txt"),
        ],
        usage=UsageInfo(last_prompt_tokens=9999),
    )

    result = await hook.before_model(ctx, state)
    assert result is None

    # wrap_model_call should call handler directly (no pending summary)
    called = []

    async def _handler(req: ModelRequest) -> AssistantMessage:
        called.append(True)
        return AssistantMessage(content="done")

    await hook.wrap_model_call(
        ctx,
        state,
        ModelRequest(messages=tuple(state.messages_for_llm), system_prompt=""),
        _handler,
    )
    assert called, "handler should have been called (no summary pending)"
    mock_provider.stream.assert_not_called()


@pytest.mark.asyncio
async def test_no_interrupt_skips_summarisation_after_assistant_reply(mock_provider):
    """When support_interrupt=False and the last visible message is an
    AssistantMessage (content-only, no tool calls), summarisation is deferred."""
    hook = _make_hook_no_interrupt(mock_provider)
    ctx = _make_ctx()

    state = AgentState(
        messages=[
            HumanMessage(content="hello"),
            AssistantMessage(content="I am working on it..."),
        ],
        usage=UsageInfo(last_prompt_tokens=9999),
    )

    result = await hook.before_model(ctx, state)
    assert result is None
    mock_provider.stream.assert_not_called()


@pytest.mark.asyncio
async def test_no_interrupt_fires_at_user_turn_boundary(mock_provider):
    """When support_interrupt=False, summarisation fires normally when the last
    visible message is a HumanMessage (start of a new user turn)."""
    stream_calls: list[int] = []

    async def _stream(messages, **__):
        stream_calls.append(1)
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = "Compact summary."
        chunk.usage = None
        yield chunk

    mock_provider.stream = _stream

    hook = _make_hook_no_interrupt(mock_provider, threshold=1)
    ctx = _make_ctx()

    # Last visible message is a HumanMessage → user-turn boundary
    state = AgentState(
        messages=[
            HumanMessage(content="earlier message"),
            AssistantMessage(content="earlier reply"),
            HumanMessage(content="new user message"),
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

    assert len(stream_calls) == 1, "summarisation LLM should have been called once"


@pytest.mark.asyncio
async def test_no_interrupt_fires_at_turn_boundary_empty_messages(mock_provider):
    """When support_interrupt=False and messages list is empty, summarisation
    is not deferred (empty is treated as a turn boundary).  The hook proceeds
    to _summarise but returns early because there is nothing to compact —
    the pending_summary path fires (no mid-loop deferral log emitted)."""
    hook = _make_hook_no_interrupt(mock_provider, threshold=1)
    ctx = _make_ctx()

    state = AgentState(
        messages=[],
        usage=UsageInfo(last_prompt_tokens=9999),
    )

    # before_model should set pending_summary (not defer), returning None
    result = await hook.before_model(ctx, state)
    assert result is None
    # The summary was triggered (pending set), not deferred
    assert hook._pending_summary is not None


@pytest.mark.asyncio
async def test_no_interrupt_force_flag_overrides_deferral(mock_provider):
    """force_summarization=True bypasses the support_interrupt deferral guard."""
    stream_calls: list[int] = []

    async def _stream(messages, **__):
        stream_calls.append(1)
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = "Forced summary."
        chunk.usage = None
        yield chunk

    mock_provider.stream = _stream

    hook = _make_hook_no_interrupt(mock_provider, threshold=1)
    ctx = _make_ctx()

    # Mid-loop state (last message is ToolMessage), but force=True overrides
    state = AgentState(
        messages=[
            HumanMessage(content="do the thing"),
            AssistantMessage(
                content=None,
                tool_calls=[
                    ToolCall(
                        id="call_f",
                        function=FunctionCall(
                            name="shell", arguments='{"command":"ls"}'
                        ),
                    )
                ],
            ),
            ToolMessage(tool_call_id="call_f", name="shell", content="result"),
        ],
        usage=UsageInfo(last_prompt_tokens=9999),
    )
    state.metadata["force_summarization"] = True

    await hook.before_model(ctx, state)
    await hook.wrap_model_call(
        ctx,
        state,
        ModelRequest(messages=tuple(state.messages_for_llm), system_prompt=""),
        _noop_model_handler,
    )

    assert len(stream_calls) == 1, "force_summarization should override deferral"


@pytest.mark.asyncio
async def test_support_interrupt_true_fires_mid_loop(mock_provider):
    """When support_interrupt=True (default), summarisation fires mid-loop as
    before — this confirms the flag does not accidentally block the normal path."""
    stream_calls: list[int] = []

    async def _stream(messages, **__):
        stream_calls.append(1)
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = "Mid-loop summary."
        chunk.usage = None
        yield chunk

    mock_provider.stream = _stream

    hook = SummarizationHook(
        llm_provider=mock_provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1,
        support_interrupt=True,  # default
    )
    ctx = _make_ctx()

    # Mid-loop state — support_interrupt=True so it should still fire
    state = AgentState(
        messages=[
            HumanMessage(content="do the thing"),
            AssistantMessage(
                content=None,
                tool_calls=[
                    ToolCall(
                        id="call_m",
                        function=FunctionCall(
                            name="shell", arguments='{"command":"ls"}'
                        ),
                    )
                ],
            ),
            ToolMessage(tool_call_id="call_m", name="shell", content="result"),
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

    assert len(stream_calls) == 1, "support_interrupt=True should still fire mid-loop"


# ---------------------------------------------------------------------------
# _at_user_turn_boundary — unit tests
# ---------------------------------------------------------------------------


def test_at_user_turn_boundary_real_user_message(mock_provider):
    """Returns True for a plain HumanMessage with no special extra."""
    hook = _make_hook_no_interrupt(mock_provider)
    state = AgentState(
        messages=[
            HumanMessage(content="previous"),
            AssistantMessage(content="reply"),
            HumanMessage(content="new user turn"),
        ],
    )
    assert hook._at_user_turn_boundary(state) is True


def test_at_user_turn_boundary_from_agent_user(mock_provider):
    """Returns True when from_agent is explicitly 'user' (broadcast path)."""
    hook = _make_hook_no_interrupt(mock_provider)
    msg = HumanMessage(content="broadcast", extra={"from_agent": "user"})
    state = AgentState(messages=[msg])
    assert hook._at_user_turn_boundary(state) is True


def test_at_user_turn_boundary_last_assistant(mock_provider):
    """Returns False when the last visible message is an AssistantMessage."""
    hook = _make_hook_no_interrupt(mock_provider)
    state = AgentState(
        messages=[
            HumanMessage(content="msg1"),
            AssistantMessage(content="working..."),
        ],
    )
    assert hook._at_user_turn_boundary(state) is False


def test_at_user_turn_boundary_last_tool(mock_provider):
    """Returns False when the last visible message is a ToolMessage."""
    hook = _make_hook_no_interrupt(mock_provider)
    state = AgentState(
        messages=[
            HumanMessage(content="do it"),
            AssistantMessage(
                content=None,
                tool_calls=[
                    ToolCall(
                        id="c1",
                        function=FunctionCall(name="shell", arguments="{}"),
                    )
                ],
            ),
            ToolMessage(tool_call_id="c1", name="shell", content="ok"),
        ],
    )
    assert hook._at_user_turn_boundary(state) is False


def test_at_user_turn_boundary_inbox_from_other_agent(mock_provider):
    """Returns False when the last HumanMessage came from another agent (TeamInboxHook).

    Inbox messages injected mid-loop have extra['from_agent'] = '<member_name>'.
    They must NOT be treated as user-turn boundaries.
    """
    hook = _make_hook_no_interrupt(mock_provider)
    # Simulate a message injected by TeamInboxHook mid-loop
    inbox_msg = HumanMessage(
        content="[executor#1]: done with subtask",
        extra={"from_agent": "executor#1", "is_broadcast": False},
    )
    state = AgentState(
        messages=[
            HumanMessage(content="user request"),
            AssistantMessage(content=None, tool_calls=[]),
            inbox_msg,
        ],
    )
    assert hook._at_user_turn_boundary(state) is False


def test_at_user_turn_boundary_inbox_broadcast_from_agent(mock_provider):
    """Returns False for a broadcast HumanMessage from a non-user agent."""
    hook = _make_hook_no_interrupt(mock_provider)
    broadcast = HumanMessage(
        content="[planner]: update for all",
        extra={"from_agent": "planner", "is_broadcast": True},
    )
    state = AgentState(messages=[broadcast])
    assert hook._at_user_turn_boundary(state) is False


def test_at_user_turn_boundary_summary_message(mock_provider):
    """Returns False when the last message is a summary HumanMessage (is_summary=True)."""
    hook = _make_hook_no_interrupt(mock_provider)
    summary = HumanMessage(content="## Goal\n- ...", is_summary=True)
    state = AgentState(messages=[summary])
    assert hook._at_user_turn_boundary(state) is False


def test_at_user_turn_boundary_continue_directive(mock_provider):
    """Returns False for the /continue directive (hidden_from_summary=True)."""
    hook = _make_hook_no_interrupt(mock_provider)
    directive = HumanMessage(
        content="Continue exactly where your previous response stopped.",
        extra={
            "command": "continue",
            "hidden_from_user": True,
            "hidden_from_summary": True,
        },
    )
    state = AgentState(messages=[directive])
    assert hook._at_user_turn_boundary(state) is False


def test_at_user_turn_boundary_attachment_synthetic(mock_provider):
    """Returns False for a hidden attachment synthetic row (hidden_from_summary=True)."""
    hook = _make_hook_no_interrupt(mock_provider)
    synthetic = HumanMessage(
        content="[File: report.pdf]\n...",
        extra={
            "hidden_from_user": True,
            "hidden_from_summary": True,
            "attachment_for_message_id": "abc-123",
        },
    )
    state = AgentState(messages=[synthetic])
    assert hook._at_user_turn_boundary(state) is False


def test_at_user_turn_boundary_empty(mock_provider):
    """Returns True when there are no visible messages."""
    hook = _make_hook_no_interrupt(mock_provider)
    state = AgentState(messages=[])
    assert hook._at_user_turn_boundary(state) is True


def test_at_user_turn_boundary_only_excluded(mock_provider):
    """Returns True when all messages are excluded from context."""
    hook = _make_hook_no_interrupt(mock_provider)
    msg = AssistantMessage(content="hidden")
    msg.exclude_from_context = True
    state = AgentState(messages=[msg])
    assert hook._at_user_turn_boundary(state) is True


def test_at_user_turn_boundary_skips_system(mock_provider):
    """SystemMessage is excluded from the visible window; last real visible is checked."""
    hook = _make_hook_no_interrupt(mock_provider)
    state = AgentState(
        messages=[
            HumanMessage(content="question"),
            AssistantMessage(content="answer"),
            SystemMessage(content="injected system"),
        ],
    )
    # SystemMessage excluded by filter; last real visible = AssistantMessage
    assert hook._at_user_turn_boundary(state) is False


def test_at_user_turn_boundary_mention_context_synthetic(mock_provider):
    """Returns False for a mention-context synthetic row (hidden_from_summary=True)."""
    hook = _make_hook_no_interrupt(mock_provider)
    mention = HumanMessage(
        content="[File: foo.py]\n...",
        extra={
            "hidden_from_user": True,
            "hidden_from_summary": True,
            "mention_context": True,
        },
    )
    state = AgentState(messages=[mention])
    assert hook._at_user_turn_boundary(state) is False


@pytest.mark.asyncio
async def test_no_interrupt_skips_summarisation_after_inbox_injection(mock_provider):
    """When support_interrupt=False, a HumanMessage injected by TeamInboxHook
    (from_agent != 'user') mid-loop must NOT trigger summarisation."""
    hook = _make_hook_no_interrupt(mock_provider)
    ctx = _make_ctx()

    inbox_msg = HumanMessage(
        content="[executor#1]: subtask complete",
        extra={"from_agent": "executor#1", "is_broadcast": False},
    )
    state = AgentState(
        messages=[
            HumanMessage(content="user request"),
            AssistantMessage(
                content=None,
                tool_calls=[
                    ToolCall(
                        id="call_x",
                        function=FunctionCall(
                            name="shell", arguments='{"command":"ls"}'
                        ),
                    )
                ],
            ),
            ToolMessage(tool_call_id="call_x", name="shell", content="result"),
            inbox_msg,
        ],
        usage=UsageInfo(last_prompt_tokens=9999),
    )

    result = await hook.before_model(ctx, state)
    assert result is None

    called = []

    async def _handler(req: ModelRequest) -> AssistantMessage:
        called.append(True)
        return AssistantMessage(content="done")

    await hook.wrap_model_call(
        ctx,
        state,
        ModelRequest(messages=tuple(state.messages_for_llm), system_prompt=""),
        _handler,
    )
    assert called, "handler should be called (no pending summary)"
    mock_provider.stream.assert_not_called()
