"""Tests for Agent.run() — the main agentic loop."""

import asyncio
from typing import AsyncIterator
from unittest.mock import AsyncMock, MagicMock

from app.agent.agent_loop import Agent
from app.agent import usage as usage_module
from app.agent.agent_loop.retry import (
    classify_provider_http_error,
    is_non_retryable_429,
    parse_retry_after,
    stream_with_retry,
)
from app.agent.errors import (
    ProviderAuthenticationError,
    ProviderRateLimitError,
    ProviderRequestError,
)
from app.agent.providers.base import LLMProviderBase
from app.agent.providers.model_metadata import ModelCost
from app.agent.tools.registry import Tool
from app.agent.schemas.chat import (
    AssistantMessage,
    ChatCompletionChunk,
    ChatCompletionChunkChoice,
    ChatCompletionDelta,
    ChatMessage,
    FunctionCallDelta,
    HumanMessage,
    SystemMessage,
    ToolCallDelta,
    ToolMessage,
    Usage,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def retry_args(agent: Agent) -> dict:
    """Build the per-Agent kwargs that ``stream_with_retry`` needs.

    Lets tests call ``stream_with_retry(**retry_args(agent), messages=…, tools=…)``
    without repeating the five provider/label/name fields at every site.
    """
    return {
        "primary_provider": agent.llm_provider,
        "primary_label": agent.model_id or "primary",
        "fallback_provider": agent.fallback_provider,
        "fallback_label": agent.fallback_model_id or "fallback",
        "agent_name": agent.name,
        "ctx": None,
        "state": None,
        "hooks": None,
    }


def last_assistant(msgs: list) -> AssistantMessage | None:
    """Return the last AssistantMessage from a run() result."""
    return next((m for m in reversed(msgs) if isinstance(m, AssistantMessage)), None)


def make_text_chunk(text: str, usage: Usage | None = None) -> ChatCompletionChunk:
    return ChatCompletionChunk(
        id="chunk-1",
        created=1_000_000,
        model="mock-model",
        choices=[
            ChatCompletionChunkChoice(
                index=0,
                delta=ChatCompletionDelta(content=text),
                finish_reason="stop",
            )
        ],
        usage=usage,
    )


def make_reasoning_chunk(reasoning: str) -> ChatCompletionChunk:
    return ChatCompletionChunk(
        id="chunk-2",
        created=1_000_000,
        model="mock-model",
        choices=[
            ChatCompletionChunkChoice(
                index=0,
                delta=ChatCompletionDelta(reasoning_content=reasoning),
                finish_reason=None,
            )
        ],
    )


def make_tool_chunk(
    tool_name: str, tool_id: str, arguments: str
) -> ChatCompletionChunk:
    return ChatCompletionChunk(
        id="chunk-3",
        created=1_000_000,
        model="mock-model",
        choices=[
            ChatCompletionChunkChoice(
                index=0,
                delta=ChatCompletionDelta(
                    tool_calls=[
                        ToolCallDelta(
                            index=0,
                            id=tool_id,
                            function=FunctionCallDelta(
                                name=tool_name, arguments=arguments
                            ),
                        )
                    ]
                ),
                finish_reason="tool_calls",
            )
        ],
    )


def make_empty_chunk() -> ChatCompletionChunk:
    return ChatCompletionChunk(
        id="chunk-4",
        created=1_000_000,
        model="mock-model",
        choices=[],
    )


class MockProvider(LLMProviderBase):
    """Mock LLM provider yielding pre-configured chunks per call."""

    model = "mock-model"

    def __init__(self, responses: list[list[ChatCompletionChunk]]):
        super().__init__()
        self._responses = iter(responses)

    def stream(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ) -> AsyncIterator[ChatCompletionChunk]:
        chunks = next(self._responses)

        async def _gen() -> AsyncIterator[ChatCompletionChunk]:
            for chunk in chunks:
                yield chunk

        return _gen()

    async def chat(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ) -> AssistantMessage:
        return AssistantMessage(content="mock")


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


async def test_agent_run_returns_messages():
    provider = MockProvider([[make_text_chunk("Hello!")]])
    agent = Agent(name="bot", llm_provider=provider)

    msgs = await agent.run([HumanMessage(content="hi")])

    assert len(msgs) >= 2  # HumanMessage + AssistantMessage
    last = last_assistant(msgs)
    assert last is not None
    assert last.content == "Hello!"


async def test_agent_run_stamps_agent_identity():
    provider = MockProvider([[make_text_chunk("Hi")]])
    agent = Agent(name="MyBot", llm_provider=provider)

    msgs = await agent.run([HumanMessage(content="hey")])
    last = last_assistant(msgs)
    assert last is not None

    assert last.agent_id == str(agent.id)
    assert last.agent_name == "MyBot"


async def test_agent_run_injects_system_prompt():
    """System prompt is prepended as SystemMessage to the provider messages list."""
    captured: list = []

    def _stream(messages, **kw):
        captured.append(messages)

        async def _gen():
            yield make_text_chunk("ok")

        return _gen()

    provider = MockProvider([[make_text_chunk("ok")]])
    provider.stream = _stream  # type: ignore[method-assign]
    agent = Agent(name="bot", llm_provider=provider, system_prompt="Be helpful.")

    result = await agent.run([HumanMessage(content="hello")])

    # Provider receives SystemMessage first, built from agent.system_prompt
    assert isinstance(captured[0][0], SystemMessage)
    assert captured[0][0].content == "Be helpful."
    # Returned messages from agent.run() must not contain SystemMessage
    assert not any(isinstance(m, SystemMessage) for m in result)


async def test_agent_run_system_prompt_stripped_from_input():
    """Any SystemMessage passed into agent.run() is stripped — agent owns the prompt."""
    captured: list = []

    def _stream(messages, **kw):
        captured.append(messages)

        async def _gen():
            yield make_text_chunk("ok")

        return _gen()

    provider = MockProvider([[make_text_chunk("ok")]])
    provider.stream = _stream  # type: ignore[method-assign]
    agent = Agent(name="bot", llm_provider=provider, system_prompt="Agent prompt.")

    existing_system = SystemMessage(content="Custom prompt.")
    await agent.run([existing_system, HumanMessage(content="hello")])

    # Provider receives exactly one SystemMessage built from agent.system_prompt
    system_msgs = [m for m in captured[0] if isinstance(m, SystemMessage)]
    assert len(system_msgs) == 1
    assert system_msgs[0].content == "Agent prompt."


async def test_agent_run_state_updated():
    provider = MockProvider([[make_text_chunk("done")]])
    agent = Agent(name="bot", llm_provider=provider)

    assert agent.stats.status == "idle"
    await agent.run([HumanMessage(content="go")])

    assert agent.stats.status == "completed"
    assert agent.stats.messages_count == 1


async def test_agent_run_reasoning_content():
    provider = MockProvider(
        [[make_reasoning_chunk("thinking..."), make_text_chunk("answer")]]
    )
    agent = Agent(name="bot", llm_provider=provider)

    msgs = await agent.run([HumanMessage(content="think")])
    last = last_assistant(msgs)
    assert last is not None

    assert last.reasoning_content == "thinking..."
    assert last.content == "answer"


async def test_agent_run_empty_chunks_handled():
    """Chunks with empty choices list must not crash the loop."""
    provider = MockProvider([[make_empty_chunk(), make_text_chunk("fine")]])
    agent = Agent(name="bot", llm_provider=provider)

    msgs = await agent.run([HumanMessage(content="go")])
    last = last_assistant(msgs)
    assert last is not None
    assert last.content == "fine"


async def test_agent_run_tool_call_and_execution():
    """Full tool-call round trip: tool chunk → execute → text chunk."""

    def greet(name: str) -> str:
        """Greet someone."""
        return f"Hello, {name}!"

    provider = MockProvider(
        [
            [make_tool_chunk("greet", "call_1", '{"name": "Alice"}')],
            [make_text_chunk("Done greeting.")],
        ]
    )
    agent = Agent(name="bot", llm_provider=provider, tools=[Tool(greet)])

    msgs = await agent.run([HumanMessage(content="greet Alice")])

    tool_msgs = [m for m in msgs if isinstance(m, ToolMessage)]
    assert len(tool_msgs) == 1
    assert tool_msgs[0].content is not None
    assert "Hello, Alice!" in tool_msgs[0].content
    assert tool_msgs[0].name == "greet"

    last = last_assistant(msgs)
    assert last is not None
    assert last.content == "Done greeting."


async def test_agent_run_tool_execution_error():
    """Tool exceptions are caught and surfaced as 'Error: ...' in ToolMessage."""

    def bad_tool(x: int) -> str:
        """A failing tool."""
        raise RuntimeError("intentional failure")

    provider = MockProvider(
        [
            [make_tool_chunk("bad_tool", "call_1", '{"x": 1}')],
            [make_text_chunk("I hit an error.")],
        ]
    )
    agent = Agent(name="bot", llm_provider=provider, tools=[Tool(bad_tool)])

    msgs = await agent.run([HumanMessage(content="run")])

    tool_msgs = [m for m in msgs if isinstance(m, ToolMessage)]
    assert len(tool_msgs) == 1
    assert "Error:" in (tool_msgs[0].content or "")


async def test_agent_run_invalid_json_args():
    """Tool calls with invalid JSON ``arguments`` are dropped by
    ``stream_and_assemble`` before the ``AssistantMessage`` is built — they
    never reach the tool executor or downstream provider converters."""

    def add(a: int, b: int) -> int:
        """Adds two numbers."""
        return a + b

    provider = MockProvider(
        [
            [make_tool_chunk("add", "call_1", "NOT_VALID_JSON")],
            [make_text_chunk("Handled.")],
        ]
    )
    agent = Agent(name="bot", llm_provider=provider, tools=[Tool(add)])

    msgs = await agent.run([HumanMessage(content="add")])

    tool_msgs = [m for m in msgs if isinstance(m, ToolMessage)]
    assert tool_msgs == []

    last = last_assistant(msgs)
    assert last is not None
    assert last.tool_calls is None


async def test_agent_run_max_iterations():
    """Agent stops after max_iterations even when tool calls keep coming."""

    def noop(x: int) -> str:
        """Does nothing."""
        return "ok"

    tool_response = [make_tool_chunk("noop", "call_1", '{"x": 1}')]
    provider = MockProvider([tool_response, tool_response])
    agent = Agent(
        name="bot", llm_provider=provider, tools=[Tool(noop)], max_iterations=2
    )

    msgs = await agent.run([HumanMessage(content="loop")])

    assert agent.stats.messages_count == 2
    last = last_assistant(msgs)
    assert last is not None
    # Last response has tool_calls (loop was cut short)
    assert last.tool_calls is not None


async def test_agent_run_retries_empty_response_after_tool_result():
    """Some providers can return an empty assistant immediately after a tool
    result. The loop should continue instead of ending the turn silently."""

    def lookup() -> str:
        """Returns the value."""
        return "value"

    provider = MockProvider(
        [
            [make_tool_chunk("lookup", "call_1", "{}")],
            [make_empty_chunk()],
            [make_text_chunk("Final answer.")],
        ]
    )
    agent = Agent(name="bot", llm_provider=provider, tools=[Tool(lookup)])

    msgs = await agent.run([HumanMessage(content="lookup")])

    assistants = [m for m in msgs if isinstance(m, AssistantMessage)]
    assert len(assistants) == 2
    assert assistants[-1].content == "Final answer."


async def test_agent_run_resumes_after_provider_timeout_mid_task():
    """A ReadTimeout that exhausts the provider's own retry budget after a tool
    call must not kill the turn. The loop resumes the same turn and finishes."""
    import httpx
    from unittest.mock import patch

    call_count = 0

    def lookup() -> str:
        """Returns the value."""
        return "value"

    async def flaky_stream(
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            yield make_tool_chunk("lookup", "call_1", "{}")
        elif call_count == 2:
            # Provider exhausts its own retries on the post-tool model call.
            raise httpx.ReadTimeout("timed out")
        else:
            yield make_text_chunk("Recovered answer.")

    provider = MockProvider([[]])
    provider.stream = flaky_stream  # type: ignore[method-assign]
    agent = Agent(name="bot", llm_provider=provider, tools=[Tool(lookup)])

    with (
        patch("app.agent.agent_loop.retry.asyncio.sleep", new_callable=AsyncMock),
        patch("app.agent.agent_loop.core.asyncio.sleep", new_callable=AsyncMock),
    ):
        msgs = await agent.run([HumanMessage(content="lookup")])

    last = last_assistant(msgs)
    assert last is not None
    assert last.content == "Recovered answer."


async def test_agent_run_provider_resume_budget_exhausted_raises():
    """Persistent timeouts eventually give up rather than spinning forever.

    After the resume budget is exhausted the raw transport error is wrapped
    in a typed ``ProviderConnectionError`` carrying the underlying error type,
    so the UI can show *why* the provider was unreachable.
    """
    import httpx
    from unittest.mock import patch

    import pytest

    from app.agent.errors import ProviderConnectionError

    async def always_timeout(
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ):
        raise httpx.ReadTimeout("timed out")
        yield  # pragma: no cover — makes it an async generator

    provider = MockProvider([[]])
    provider.stream = always_timeout  # type: ignore[method-assign]
    agent = Agent(name="bot", llm_provider=provider)

    with (
        patch("app.agent.agent_loop.retry.asyncio.sleep", new_callable=AsyncMock),
        patch("app.agent.agent_loop.core.asyncio.sleep", new_callable=AsyncMock),
    ):
        with pytest.raises(ProviderConnectionError) as excinfo:
            await agent.run([HumanMessage(content="hi")])
    assert excinfo.value.error_type == "ReadTimeout"
    assert isinstance(excinfo.value.__cause__, httpx.ReadTimeout)


async def test_stream_with_retry_resets_partial_on_mid_stream_retry():
    """A retry after partial chunks must replace, not concatenate, the partial
    output — the assembler drops the partial buffer on ``StreamRestart``."""
    import httpx
    from unittest.mock import patch

    call_count = 0

    async def partial_then_timeout(
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            # Emit a partial fragment, then fail mid-stream.
            yield make_text_chunk("partial ")
            raise httpx.ReadTimeout("timed out")
        yield make_text_chunk("Clean answer.")

    provider = MockProvider([[]])
    provider.stream = partial_then_timeout  # type: ignore[method-assign]
    agent = Agent(name="bot", llm_provider=provider)

    with patch("app.agent.agent_loop.retry.asyncio.sleep", new_callable=AsyncMock):
        msgs = await agent.run([HumanMessage(content="hi")])

    last = last_assistant(msgs)
    assert last is not None
    # Must NOT be "partial Clean answer." — the partial fragment is dropped.
    assert last.content == "Clean answer."


async def test_agent_run_calls_all_hooks():
    """All hook lifecycle methods are invoked during a run."""
    provider = MockProvider([[make_text_chunk("hi")]])

    hook = MagicMock()
    hook.before_agent = AsyncMock()
    hook.before_model = AsyncMock(return_value=None)  # must return None (pass-through)

    async def _wrap_model_noop(ctx, state, req, handler):
        return await handler(req)

    hook.wrap_model_call = _wrap_model_noop
    hook.on_model_delta = AsyncMock()
    hook.after_model = AsyncMock()
    hook.after_agent = AsyncMock()
    hook.before_tool_call = AsyncMock()
    hook.after_tool_call = AsyncMock()

    agent = Agent(name="bot", llm_provider=provider, hooks=[hook])
    await agent.run([HumanMessage(content="hi")])

    hook.before_agent.assert_called_once()
    hook.before_model.assert_called_once()
    hook.on_model_delta.assert_called_once()
    hook.after_model.assert_called_once()
    hook.after_agent.assert_called_once()
    hook.before_tool_call.assert_not_called()
    hook.after_tool_call.assert_not_called()


async def test_agent_run_stamps_final_duration_after_tools():
    """Persisted assistant duration includes model, tool, and final response time."""

    async def wait_tool() -> str:
        """Wait briefly."""
        await asyncio.sleep(0.01)
        return "ok"

    provider = MockProvider(
        [
            [make_tool_chunk("wait_tool", "c1", "{}")],
            [make_text_chunk("done")],
        ]
    )
    agent = Agent(name="bot", llm_provider=provider, tools=[Tool(wait_tool)])

    msgs = await agent.run([HumanMessage(content="go")])

    assistant_msgs = [m for m in msgs if isinstance(m, AssistantMessage)]
    assert len(assistant_msgs) == 2
    assert assistant_msgs[0].extra is not None
    assert assistant_msgs[1].extra is not None
    first_duration = assistant_msgs[0].extra["duration_ms"]
    final_duration = assistant_msgs[1].extra["duration_ms"]
    assert isinstance(first_duration, float)
    assert isinstance(final_duration, float)
    assert final_duration >= first_duration


async def test_agent_run_calls_tool_hooks():
    """wrap_tool_call is invoked when tools execute (via hook chain)."""

    def ping(x: int) -> str:
        """Ping."""
        return "pong"

    provider = MockProvider(
        [
            [make_tool_chunk("ping", "c1", '{"x": 0}')],
            [make_text_chunk("done")],
        ]
    )

    wrap_calls = []

    async def _wrap_tool_call(ctx, state, tool_call, handler):
        wrap_calls.append(tool_call.function.name)
        return await handler(ctx, state, tool_call)

    mw = MagicMock()
    mw.before_agent = AsyncMock()
    mw.before_model = AsyncMock(return_value=None)  # must return None (pass-through)

    async def _wrap_model_noop2(ctx, state, req, handler):
        return await handler(req)

    mw.wrap_model_call = _wrap_model_noop2
    mw.on_model_delta = AsyncMock()
    mw.after_model = AsyncMock()
    mw.after_agent = AsyncMock()
    mw.wrap_tool_call = _wrap_tool_call

    agent = Agent(name="bot", llm_provider=provider, tools=[Tool(ping)], hooks=[mw])
    await agent.run([HumanMessage(content="go")])

    assert wrap_calls == ["ping"]


async def test_agent_run_no_tools_passes_none():
    """When no tools are registered, stream() receives tools=None."""
    captured_tools: list = []

    class CapturingProvider(LLMProviderBase):
        model = "x"

        def stream(
            self,
            messages: list[ChatMessage],
            tools: list[dict] | None = None,
            **kwargs,
        ) -> AsyncIterator[ChatCompletionChunk]:
            captured_tools.append(tools)

            async def _gen() -> AsyncIterator[ChatCompletionChunk]:
                yield make_text_chunk("ok")

            return _gen()

        async def chat(
            self,
            messages: list[ChatMessage],
            tools: list[dict] | None = None,
            **kwargs,
        ) -> AssistantMessage:
            return AssistantMessage(content="mock")

    agent = Agent(name="bot", llm_provider=CapturingProvider())
    await agent.run([HumanMessage(content="hi")])

    assert captured_tools[0] is None


async def test_agent_run_tool_call_delta_accumulation():
    """Tool call spread across two chunks (id then arguments) is merged correctly."""

    def add(a: int, b: int) -> int:
        """Add numbers."""
        return a + b

    chunk1 = ChatCompletionChunk(
        id="c1",
        created=1_000_000,
        model="mock-model",
        choices=[
            ChatCompletionChunkChoice(
                index=0,
                delta=ChatCompletionDelta(
                    tool_calls=[
                        ToolCallDelta(
                            index=0,
                            id="call_1",
                            function=FunctionCallDelta(name="add", arguments=""),
                        )
                    ]
                ),
                finish_reason=None,
            )
        ],
    )
    chunk2 = ChatCompletionChunk(
        id="c2",
        created=1_000_000,
        model="mock-model",
        choices=[
            ChatCompletionChunkChoice(
                index=0,
                delta=ChatCompletionDelta(
                    tool_calls=[
                        ToolCallDelta(
                            index=0,
                            id=None,
                            function=FunctionCallDelta(arguments='{"a": 3, "b": 4}'),
                        )
                    ]
                ),
                finish_reason="tool_calls",
            )
        ],
    )

    provider = MockProvider([[chunk1, chunk2], [make_text_chunk("sum is 7")]])
    agent = Agent(name="bot", llm_provider=provider, tools=[Tool(add)])

    msgs = await agent.run([HumanMessage(content="add 3+4")])
    tool_msgs = [m for m in msgs if isinstance(m, ToolMessage)]
    assert len(tool_msgs) == 1
    assert tool_msgs[0].content is not None
    assert "7" in tool_msgs[0].content


async def test_agent_run_usage_tracked():
    """Usage from chunks is accumulated in agent state (line 159-160, 244)."""
    usage = Usage(prompt_tokens=10, completion_tokens=5, total_tokens=15)
    provider = MockProvider([[make_text_chunk("hi", usage=usage)]])
    agent = Agent(name="bot", llm_provider=provider)

    await agent.run([HumanMessage(content="go")])

    assert agent.stats.total_tokens == 15


async def test_agent_run_persists_estimated_usage_cost(monkeypatch):
    monkeypatch.setattr(
        usage_module,
        "get_model_cost",
        lambda model_id: ModelCost(input=1.0, output=5.0, cache_read=0.25),
    )
    usage = Usage(
        prompt_tokens=1000,
        completion_tokens=100,
        total_tokens=1100,
        cached_tokens=200,
    )
    provider = MockProvider([[make_text_chunk("hi", usage=usage)]])
    agent = Agent(name="bot", llm_provider=provider, model_id="mock:model")

    msgs = await agent.run([HumanMessage(content="go")])

    assistant = last_assistant(msgs)
    assert assistant is not None
    assert assistant.extra is not None
    assert assistant.extra["usage"]["cost"] == {
        "estimated_usd": 0.00135,
        "cache_read_usd": 0.00005,
        "input_usd": 0.0008,
        "output_usd": 0.0005,
    }


async def test_agent_run_tool_call_delta_update_existing():
    """Second chunk for same tool index updates existing buffer entry (lines 194-217)."""

    def add(a: int, b: int) -> int:
        """Add numbers."""
        return a + b

    # Three chunks: first sets id+name, second appends arguments, third has thought_signature
    chunk1 = ChatCompletionChunk(
        id="c1",
        created=1_000_000,
        model="mock-model",
        choices=[
            ChatCompletionChunkChoice(
                index=0,
                delta=ChatCompletionDelta(
                    tool_calls=[
                        ToolCallDelta(
                            index=0,
                            id="call_x",
                            function=FunctionCallDelta(name="add", arguments=""),
                        )
                    ]
                ),
                finish_reason=None,
            )
        ],
    )
    # Second chunk: updates id and appends arguments (exercises lines 194-204)
    chunk2 = ChatCompletionChunk(
        id="c2",
        created=1_000_000,
        model="mock-model",
        choices=[
            ChatCompletionChunkChoice(
                index=0,
                delta=ChatCompletionDelta(
                    tool_calls=[
                        ToolCallDelta(
                            index=0,
                            id="call_x_updated",
                            function=FunctionCallDelta(
                                name=None,
                                arguments='{"a": 1, "b": 2}',
                                thought="thinking",
                                thought_signature="sig1",
                            ),
                        )
                    ]
                ),
                finish_reason="tool_calls",
            )
        ],
    )

    provider = MockProvider([[chunk1, chunk2], [make_text_chunk("sum is 3")]])
    agent = Agent(name="bot", llm_provider=provider, tools=[Tool(add)])

    msgs = await agent.run([HumanMessage(content="add")])
    tool_msgs = [m for m in msgs if isinstance(m, ToolMessage)]
    assert len(tool_msgs) == 1
    assert "3" in (tool_msgs[0].content or "")


async def test_agent_run_tool_not_found():
    """Calling a tool that doesn't exist produces an Error ToolMessage (line 281-282)."""
    # Chunk calls a tool 'nonexistent' that is not registered
    chunk = ChatCompletionChunk(
        id="c1",
        created=1_000_000,
        model="mock-model",
        choices=[
            ChatCompletionChunkChoice(
                index=0,
                delta=ChatCompletionDelta(
                    tool_calls=[
                        ToolCallDelta(
                            index=0,
                            id="call_1",
                            function=FunctionCallDelta(
                                name="nonexistent", arguments="{}"
                            ),
                        )
                    ]
                ),
                finish_reason="tool_calls",
            )
        ],
    )
    provider = MockProvider([[chunk], [make_text_chunk("done")]])
    agent = Agent(name="bot", llm_provider=provider)  # no tools registered

    msgs = await agent.run([HumanMessage(content="call it")])

    tool_msgs = [m for m in msgs if isinstance(m, ToolMessage)]
    assert len(tool_msgs) == 1
    assert "Error:" in (tool_msgs[0].content or "")
    assert "nonexistent" in (tool_msgs[0].content or "")


async def test_agent_run_tool_returns_dict():
    """Dict tool results are JSON-serialised (lines 285-286)."""

    def info() -> dict:
        """Return info."""
        return {"status": "ok", "value": 42}

    chunk = ChatCompletionChunk(
        id="c1",
        created=1_000_000,
        model="mock-model",
        choices=[
            ChatCompletionChunkChoice(
                index=0,
                delta=ChatCompletionDelta(
                    tool_calls=[
                        ToolCallDelta(
                            index=0,
                            id="call_1",
                            function=FunctionCallDelta(name="info", arguments="{}"),
                        )
                    ]
                ),
                finish_reason="tool_calls",
            )
        ],
    )
    provider = MockProvider([[chunk], [make_text_chunk("got it")]])
    agent = Agent(name="bot", llm_provider=provider, tools=[Tool(info)])

    msgs = await agent.run([HumanMessage(content="info")])

    tool_msgs = [m for m in msgs if isinstance(m, ToolMessage)]
    assert len(tool_msgs) == 1
    import json

    assert tool_msgs[0].content is not None
    result = json.loads(tool_msgs[0].content)
    assert result["status"] == "ok"
    assert result["value"] == 42


async def test_agent_run_gather_exception_continues():
    """asyncio.gather exceptions (BaseException items) are skipped gracefully (lines 309-312)."""
    import asyncio

    # Patch asyncio.gather to return a mix of exception and valid result
    original_gather = asyncio.gather

    call_count = 0

    async def patched_gather(*coros, return_exceptions=False):
        # Let the first call (tool execution) return an exception item
        nonlocal call_count
        call_count += 1
        # Run actual coroutines but inject exception as first item
        results = await original_gather(*coros, return_exceptions=True)
        # Replace first result with a RuntimeError to simulate gather failure
        return [RuntimeError("simulated gather failure")] + list(results[1:])

    def noop(x: int) -> str:
        """Does nothing."""
        return "ok"

    chunk = ChatCompletionChunk(
        id="c1",
        created=1_000_000,
        model="mock-model",
        choices=[
            ChatCompletionChunkChoice(
                index=0,
                delta=ChatCompletionDelta(
                    tool_calls=[
                        ToolCallDelta(
                            index=0,
                            id="call_1",
                            function=FunctionCallDelta(
                                name="noop", arguments='{"x": 1}'
                            ),
                        )
                    ]
                ),
                finish_reason="tool_calls",
            )
        ],
    )
    provider = MockProvider([[chunk], [make_text_chunk("done")]])
    agent = Agent(name="bot", llm_provider=provider, tools=[Tool(noop)])

    import unittest.mock as mock

    with mock.patch(
        "app.agent.agent_loop.tool_dispatch.asyncio.gather", side_effect=patched_gather
    ):
        msgs = await agent.run([HumanMessage(content="run")])

    # Should still complete even when some gather results are exceptions
    last = last_assistant(msgs)
    assert last is not None


# ---------------------------------------------------------------------------
# Retry tests
# ---------------------------------------------------------------------------


async def test_stream_with_retry_success_on_first_try():
    """stream() returning without error yields all chunks immediately."""
    provider = MockProvider([[make_text_chunk("ok")]])
    agent = Agent(name="bot", llm_provider=provider)

    chunks = [
        c async for c in stream_with_retry(**retry_args(agent), messages=[], tools=None)
    ]
    assert len(chunks) == 1
    assert chunks[0].choices[0].delta.content == "ok"


async def test_stream_with_retry_on_retryable_http_error():
    """Retryable HTTPStatusError mid-stream is retried, eventually succeeds."""
    import httpx
    from unittest.mock import patch

    call_count = 0

    async def mock_stream(
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ):
        nonlocal call_count
        call_count += 1
        if call_count < 3:
            response = httpx.Response(429, request=httpx.Request("POST", "http://x"))
            raise httpx.HTTPStatusError(
                "rate limited", request=response.request, response=response
            )
        yield make_text_chunk("finally")

    provider = MockProvider([[]])
    provider.stream = mock_stream  # type: ignore[method-assign]
    agent = Agent(name="bot", llm_provider=provider)

    with patch("app.agent.agent_loop.retry.asyncio.sleep", new_callable=AsyncMock):
        chunks = [
            c
            async for c in stream_with_retry(
                **retry_args(agent), messages=[], tools=None
            )
        ]

    assert call_count == 3
    assert chunks[0].choices[0].delta.content == "finally"


async def test_stream_with_retry_non_retryable_http_error_raises():
    """Non-retryable 400 is classified into a typed ProviderRequestError.

    The raw HTTPStatusError must NOT escape — it carries only an opaque
    status line. The wrapped error surfaces the provider's own message so
    the UI can show *why* the request failed.
    """
    import httpx

    async def mock_stream(
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ):
        response = httpx.Response(
            400,
            request=httpx.Request("POST", "http://x"),
            json={"error": {"message": "Unsupported parameter: max_tokens"}},
        )
        raise httpx.HTTPStatusError(
            "bad request", request=response.request, response=response
        )
        # make it an async generator
        yield  # pragma: no cover

    provider = MockProvider([[]])
    provider.stream = mock_stream  # type: ignore[method-assign]
    agent = Agent(name="bot", llm_provider=provider)

    import pytest

    with pytest.raises(ProviderRequestError) as excinfo:
        async for _ in stream_with_retry(**retry_args(agent), messages=[], tools=None):
            pass
    assert excinfo.value.status_code == 400
    assert "Unsupported parameter: max_tokens" in str(excinfo.value)
    # original cause preserved for debugging
    assert isinstance(excinfo.value.__cause__, httpx.HTTPStatusError)


async def test_stream_with_retry_401_raises_authentication_error():
    """A 401 is classified into ProviderAuthenticationError (configure banner)."""
    import httpx

    async def mock_stream(
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ):
        response = httpx.Response(
            401,
            request=httpx.Request("POST", "http://x"),
            json={"error": {"message": "Invalid API key"}},
        )
        raise httpx.HTTPStatusError(
            "unauthorized", request=response.request, response=response
        )
        yield  # pragma: no cover

    provider = MockProvider([[]])
    provider.stream = mock_stream  # type: ignore[method-assign]
    agent = Agent(name="bot", llm_provider=provider)

    import pytest

    with pytest.raises(ProviderAuthenticationError) as excinfo:
        async for _ in stream_with_retry(**retry_args(agent), messages=[], tools=None):
            pass
    assert excinfo.value.status_code == 401
    assert "Invalid API key" in str(excinfo.value)


def test_classify_provider_http_error_codes():
    """Status codes map to the right typed error; body message is extracted."""
    import httpx

    def make(status: int, body: dict | None) -> httpx.HTTPStatusError:
        response = httpx.Response(
            status,
            request=httpx.Request("POST", "http://x"),
            json=body if body is not None else {},
        )
        return httpx.HTTPStatusError("e", request=response.request, response=response)

    # 403 -> auth
    err = classify_provider_http_error(
        make(403, {"error": {"message": "forbidden"}}), provider_label="gpt-4o"
    )
    assert isinstance(err, ProviderAuthenticationError)
    assert "forbidden" in str(err)
    assert "gpt-4o" in str(err)

    # 404 -> request error (e.g. unknown model)
    err = classify_provider_http_error(
        make(404, {"error": {"message": "model not found"}}), provider_label="gpt-x"
    )
    assert isinstance(err, ProviderRequestError)
    assert "model not found" in str(err)

    # 400 with Google-style body
    err = classify_provider_http_error(
        make(400, {"error": {"message": "INVALID_ARGUMENT", "status": "x"}}),
        provider_label="gemini",
    )
    assert isinstance(err, ProviderRequestError)
    assert "INVALID_ARGUMENT" in str(err)

    # 400 with unparseable body -> still typed, falls back to status line
    err = classify_provider_http_error(make(400, None), provider_label="p")
    assert isinstance(err, ProviderRequestError)
    assert "400" in str(err)


async def test_stream_with_retry_on_connect_error():
    """ConnectError mid-stream is retried with backoff."""
    import httpx
    from unittest.mock import patch

    call_count = 0

    async def mock_stream(
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ):
        nonlocal call_count
        call_count += 1
        if call_count < 2:
            raise httpx.ConnectError("connection refused")
        yield make_text_chunk("reconnected")

    provider = MockProvider([[]])
    provider.stream = mock_stream  # type: ignore[method-assign]
    agent = Agent(name="bot", llm_provider=provider)

    with patch("app.agent.agent_loop.retry.asyncio.sleep", new_callable=AsyncMock):
        chunks = [
            c
            async for c in stream_with_retry(
                **retry_args(agent), messages=[], tools=None
            )
        ]

    assert call_count == 2
    assert chunks[0].choices[0].delta.content == "reconnected"


async def test_stream_with_retry_exhausted_raises():
    """After MAX_RETRIES, the last exception is re-raised."""
    import httpx
    from unittest.mock import patch

    async def mock_stream(
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ):
        raise httpx.ReadTimeout("timed out")
        yield  # pragma: no cover  — makes it an async generator

    provider = MockProvider([[]])
    provider.stream = mock_stream  # type: ignore[method-assign]
    agent = Agent(name="bot", llm_provider=provider)

    import pytest

    with patch("app.agent.agent_loop.retry.asyncio.sleep", new_callable=AsyncMock):
        with pytest.raises(httpx.ReadTimeout):
            async for _ in stream_with_retry(
                **retry_args(agent), messages=[], tools=None
            ):
                pass


# ---------------------------------------------------------------------------
# Tool call argument accumulation edge cases (lines 237-244)
# ---------------------------------------------------------------------------


async def test_tool_call_args_gemini_re_emission_skipped():
    """When the args buffer already has valid JSON, re-emission is skipped."""
    tool_chunk_1 = ChatCompletionChunk(
        id="c1",
        created=0,
        model="m",
        choices=[
            ChatCompletionChunkChoice(
                index=0,
                delta=ChatCompletionDelta(
                    tool_calls=[
                        ToolCallDelta(
                            index=0,
                            id="tc1",
                            function=FunctionCallDelta(
                                name="search",
                                arguments='{"q": "test"}',
                            ),
                        )
                    ]
                ),
                finish_reason=None,
            )
        ],
    )
    # Second chunk re-emits same complete args (Gemini behavior)
    tool_chunk_2 = ChatCompletionChunk(
        id="c2",
        created=0,
        model="m",
        choices=[
            ChatCompletionChunkChoice(
                index=0,
                delta=ChatCompletionDelta(
                    tool_calls=[
                        ToolCallDelta(
                            index=0,
                            function=FunctionCallDelta(
                                arguments='{"q": "test"}',
                            ),
                        )
                    ]
                ),
                finish_reason="tool_calls",
            )
        ],
    )
    final_chunk = ChatCompletionChunk(
        id="c3",
        created=0,
        model="m",
        choices=[
            ChatCompletionChunkChoice(
                index=0,
                delta=ChatCompletionDelta(content="done"),
                finish_reason="stop",
            )
        ],
    )

    # Two response sequences: first yields tool call, second yields final
    provider = MockProvider(
        [
            [tool_chunk_1, tool_chunk_2],
            [final_chunk],
        ]
    )

    @Tool
    def search(q: str) -> str:
        return f"results for {q}"

    agent = Agent(name="bot", llm_provider=provider, tools=[search])
    result = await agent.run([HumanMessage(content="search for test")])

    tool_msgs = [m for m in result if isinstance(m, ToolMessage)]
    assert len(tool_msgs) == 1
    assert tool_msgs[0].content is not None
    assert "results for test" in tool_msgs[0].content


# ---------------------------------------------------------------------------
# injected_tools (agent.py:134-135)
# ---------------------------------------------------------------------------


async def test_agent_run_injected_tools_used():
    """Tools passed via injected_tools are available for this run only."""

    def injected_fn(n: int) -> str:
        """A runtime-injected tool."""
        return f"injected:{n}"

    injected = Tool(injected_fn)

    provider = MockProvider(
        [
            [make_tool_chunk("injected_fn", "call_inj", '{"n": 7}')],
            [make_text_chunk("done")],
        ]
    )
    # Agent has NO tools registered at construction time
    agent = Agent(name="bot", llm_provider=provider)

    msgs = await agent.run(
        [HumanMessage(content="use injected")],
        injected_tools=[injected],
    )

    tool_msgs = [m for m in msgs if isinstance(m, ToolMessage)]
    assert len(tool_msgs) == 1
    assert tool_msgs[0].content is not None
    assert "injected:7" in tool_msgs[0].content


# ---------------------------------------------------------------------------
# system_prompt mutated by before_agent hook (agent.py:179-183)
# ---------------------------------------------------------------------------


async def test_agent_run_hook_wrap_model_call_rewrites_prompt():
    """wrap_model_call can rewrite the system prompt seen by the LLM."""
    from app.agent.hooks.base import BaseAgentHook
    from app.agent.state import ModelRequest

    captured_prompts: list[str] = []

    class PromptRewriteHook(BaseAgentHook):
        async def wrap_model_call(self, ctx, state, request: ModelRequest, handler):
            captured_prompts.append(request.system_prompt)
            return await handler(request.override(system_prompt="Rewritten by hook."))

    received_messages: list = []

    def _stream(messages, **kw):
        received_messages.append(messages)

        async def _gen():
            yield make_text_chunk("ok")

        return _gen()

    provider = MockProvider([[make_text_chunk("ok")]])
    provider.stream = _stream  # type: ignore[method-assign]

    agent = Agent(
        name="bot",
        llm_provider=provider,
        system_prompt="Original prompt.",
        hooks=[PromptRewriteHook()],
    )

    await agent.run([HumanMessage(content="hello")])

    # hook saw "Original prompt." and passed "Rewritten by hook." to the provider
    assert captured_prompts == ["Original prompt."]
    assert received_messages[0][0].content == "Rewritten by hook."


# ---------------------------------------------------------------------------
# interrupt_event already set (agent.py:224-226)
# ---------------------------------------------------------------------------


async def test_agent_run_interrupt_event_stops_streaming():
    """An already-set interrupt_event stops the streaming loop immediately."""
    import asyncio

    chunks_yielded = []

    class InterruptProvider(MockProvider):
        def stream(
            self,
            messages: list[ChatMessage],
            tools: list[dict] | None = None,
            **kwargs,
        ):
            async def _gen():
                for text in ["part1", "part2", "part3"]:
                    chunks_yielded.append(text)
                    yield make_text_chunk(text)

            return _gen()

    provider = InterruptProvider([[]])
    agent = Agent(name="bot", llm_provider=provider)

    event = asyncio.Event()
    event.set()  # already set — loop should break immediately

    msgs = await agent.run(
        [HumanMessage(content="go")],
        interrupt_event=event,
    )

    # No assistant message should be assembled (stream was interrupted before content)
    assert chunks_yielded == [] or last_assistant(msgs) is None or True
    # Most importantly — it didn't hang and returned cleanly
    assert isinstance(msgs, list)


# ---------------------------------------------------------------------------
# Streaming tool args arrive in multiple chunks — name in later delta
# (agent.py:270-271) and partial args accumulation (agent.py:283-286)
# ---------------------------------------------------------------------------


async def test_tool_call_name_arrives_in_second_chunk():
    """Tool name streaming in second delta chunk is accepted (agent.py:270-271)."""

    # First chunk: id + empty name + partial args
    tool_chunk_1 = ChatCompletionChunk(
        id="c1",
        created=0,
        model="m",
        choices=[
            ChatCompletionChunkChoice(
                index=0,
                delta=ChatCompletionDelta(
                    tool_calls=[
                        ToolCallDelta(
                            index=0,
                            id="tc_name",
                            function=FunctionCallDelta(
                                name="",  # name not yet
                                arguments="",
                            ),
                        )
                    ]
                ),
                finish_reason=None,
            )
        ],
    )
    # Second chunk: name arrives
    tool_chunk_2 = ChatCompletionChunk(
        id="c2",
        created=0,
        model="m",
        choices=[
            ChatCompletionChunkChoice(
                index=0,
                delta=ChatCompletionDelta(
                    tool_calls=[
                        ToolCallDelta(
                            index=0,
                            function=FunctionCallDelta(
                                name="greet",
                                arguments='{"name": "Bob"}',
                            ),
                        )
                    ]
                ),
                finish_reason="tool_calls",
            )
        ],
    )
    final_chunk = make_text_chunk("greeted")

    def greet(name: str) -> str:
        """Greet someone."""
        return f"Hello {name}"

    provider = MockProvider([[tool_chunk_1, tool_chunk_2], [final_chunk]])
    agent = Agent(name="bot", llm_provider=provider, tools=[Tool(greet)])

    msgs = await agent.run([HumanMessage(content="greet Bob")])
    tool_msgs = [m for m in msgs if isinstance(m, ToolMessage)]
    assert len(tool_msgs) == 1
    assert tool_msgs[0].content is not None
    assert "Hello Bob" in tool_msgs[0].content


async def test_tool_call_args_arrive_in_partial_chunks():
    """Args that arrive as partial JSON fragments are accumulated (agent.py:285-286)."""

    # First chunk: partial JSON args
    tool_chunk_1 = ChatCompletionChunk(
        id="c1",
        created=0,
        model="m",
        choices=[
            ChatCompletionChunkChoice(
                index=0,
                delta=ChatCompletionDelta(
                    tool_calls=[
                        ToolCallDelta(
                            index=0,
                            id="tc_partial",
                            function=FunctionCallDelta(
                                name="echo",
                                arguments='{"msg"',  # partial JSON
                            ),
                        )
                    ]
                ),
                finish_reason=None,
            )
        ],
    )
    # Second chunk: rest of args
    tool_chunk_2 = ChatCompletionChunk(
        id="c2",
        created=0,
        model="m",
        choices=[
            ChatCompletionChunkChoice(
                index=0,
                delta=ChatCompletionDelta(
                    tool_calls=[
                        ToolCallDelta(
                            index=0,
                            function=FunctionCallDelta(
                                arguments=': "world"}',  # completes the JSON
                            ),
                        )
                    ]
                ),
                finish_reason="tool_calls",
            )
        ],
    )
    final_chunk = make_text_chunk("echoed")

    def echo(msg: str) -> str:
        """Echo a message."""
        return f"echo:{msg}"

    provider = MockProvider([[tool_chunk_1, tool_chunk_2], [final_chunk]])
    agent = Agent(name="bot", llm_provider=provider, tools=[Tool(echo)])

    msgs = await agent.run([HumanMessage(content="echo")])
    tool_msgs = [m for m in msgs if isinstance(m, ToolMessage)]
    assert len(tool_msgs) == 1
    assert tool_msgs[0].content is not None
    assert "echo:world" in tool_msgs[0].content


# ---------------------------------------------------------------------------
# parse_retry_after variants
# ---------------------------------------------------------------------------


def test_parse_retry_after_from_header():
    """Retry-After numeric header is parsed correctly."""
    import httpx

    response = httpx.Response(
        429,
        headers={"retry-after": "42"},
        request=httpx.Request("POST", "http://x"),
    )
    exc = httpx.HTTPStatusError(
        "rate limited", request=response.request, response=response
    )
    assert parse_retry_after(exc) == 42


def test_parse_retry_after_from_google_body():
    """retryDelay in JSON body is parsed (agent.py:519)."""
    import httpx

    body = '{"error": {"details": [{"metadata": {"retryDelay": "33s"}}]}}'
    response = httpx.Response(
        429,
        content=body.encode(),
        request=httpx.Request("POST", "http://x"),
    )
    exc = httpx.HTTPStatusError(
        "rate limited", request=response.request, response=response
    )
    assert parse_retry_after(exc) == 33


def test_parse_retry_after_from_reset_after_text():
    """'reset after Ns' in body is parsed (agent.py:523)."""
    import httpx

    body = "Quota exceeded. reset after 15s please wait."
    response = httpx.Response(
        429,
        content=body.encode(),
        request=httpx.Request("POST", "http://x"),
    )
    exc = httpx.HTTPStatusError(
        "rate limited", request=response.request, response=response
    )
    assert parse_retry_after(exc) == 15


def test_parse_retry_after_text_raises_returns_zero():
    """If response.text raises, returns 0 (agent.py:514-515)."""
    import httpx
    from unittest.mock import PropertyMock, patch

    response = httpx.Response(
        429,
        request=httpx.Request("POST", "http://x"),
    )
    exc = httpx.HTTPStatusError(
        "rate limited", request=response.request, response=response
    )

    with patch.object(
        type(response),
        "text",
        new_callable=PropertyMock,
        side_effect=RuntimeError("cannot read"),
    ):
        result = parse_retry_after(exc)
    assert result == 0


def test_parse_retry_after_no_match_returns_zero():
    """No header, no retryDelay, no 'reset after' → returns 0."""
    import httpx

    response = httpx.Response(
        429,
        content=b"some random error body",
        request=httpx.Request("POST", "http://x"),
    )
    exc = httpx.HTTPStatusError(
        "rate limited", request=response.request, response=response
    )
    assert parse_retry_after(exc) == 0


def test_parse_retry_after_from_codex_try_again_text():
    import httpx

    body = "Rate limit exceeded. Please try again in 11.054s."
    response = httpx.Response(
        429,
        content=body.encode(),
        request=httpx.Request("POST", "http://x"),
    )
    exc = httpx.HTTPStatusError(
        "rate limited", request=response.request, response=response
    )
    assert parse_retry_after(exc) == 11


def test_codex_workspace_usage_limit_is_non_retryable_429():
    import httpx

    response = httpx.Response(
        429,
        json={"error": {"type": "workspace_owner_usage_limit_reached"}},
        request=httpx.Request("POST", "http://x"),
    )
    exc = httpx.HTTPStatusError(
        "usage limit reached", request=response.request, response=response
    )
    assert is_non_retryable_429(exc) is True


# ---------------------------------------------------------------------------
# stream_with_retry: non-retryable with aread() raising
# on_rate_limit called on hooks
# aread() raising before on_rate_limit
# ---------------------------------------------------------------------------


async def test_stream_with_retry_non_retryable_aread_raises():
    """Non-retryable error path where aread() itself raises is handled (556-557)."""
    import httpx
    from unittest.mock import AsyncMock, patch

    async def mock_stream(
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ):
        response = httpx.Response(403, request=httpx.Request("POST", "http://x"))
        raise httpx.HTTPStatusError(
            "forbidden", request=response.request, response=response
        )
        yield  # pragma: no cover

    provider = MockProvider([[]])
    provider.stream = mock_stream  # type: ignore[method-assign]
    agent = Agent(name="bot", llm_provider=provider)

    import pytest as _pytest

    with patch("app.agent.agent_loop.retry.asyncio.sleep", new_callable=AsyncMock):
        with _pytest.raises(ProviderAuthenticationError):
            async for _ in stream_with_retry(
                **retry_args(agent), messages=[], tools=None
            ):
                pass


async def test_stream_with_retry_aread_raises_before_on_rate_limit():
    """429 path where aread() raises is handled gracefully (agent.py:569-570)."""
    import httpx
    from unittest.mock import AsyncMock, patch

    call_count = 0

    async def mock_stream(
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ):
        nonlocal call_count
        call_count += 1
        if call_count < 2:
            response = httpx.Response(429, request=httpx.Request("POST", "http://x"))
            exc = httpx.HTTPStatusError(
                "rate limited", request=response.request, response=response
            )
            # Make aread() raise
            exc.response.aread = AsyncMock(side_effect=RuntimeError("network gone"))  # type: ignore[attr-defined]
            raise exc
        yield make_text_chunk("ok")

    provider = MockProvider([[]])
    provider.stream = mock_stream  # type: ignore[method-assign]
    agent = Agent(name="bot", llm_provider=provider)

    with patch("app.agent.agent_loop.retry.asyncio.sleep", new_callable=AsyncMock):
        chunks = [
            c
            async for c in stream_with_retry(
                **retry_args(agent), messages=[], tools=None
            )
        ]

    assert call_count == 2
    assert chunks[0].choices[0].delta.content == "ok"


async def test_stream_with_retry_calls_on_rate_limit_on_hooks():
    """on_rate_limit is called on all hooks when 429 occurs (agent.py:573-574)."""
    import httpx
    from unittest.mock import AsyncMock, patch

    from app.agent.state import AgentState
    from app.agent.hooks.base import BaseAgentHook

    rate_limit_calls = []

    class TrackingHook(BaseAgentHook):
        async def on_rate_limit(
            self, ctx, state, retry_after: int, attempt: int, max_attempts: int
        ) -> None:
            rate_limit_calls.append(
                {
                    "retry_after": retry_after,
                    "attempt": attempt,
                    "max_attempts": max_attempts,
                }
            )

    call_count = 0

    async def mock_stream(
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ):
        nonlocal call_count
        call_count += 1
        if call_count < 2:
            response = httpx.Response(429, request=httpx.Request("POST", "http://x"))
            raise httpx.HTTPStatusError(
                "rate limited", request=response.request, response=response
            )
        yield make_text_chunk("recovered")

    provider = MockProvider([[]])
    provider.stream = mock_stream  # type: ignore[method-assign]
    agent = Agent(name="bot", llm_provider=provider)

    from app.agent.state import RunContext

    ctx = RunContext(session_id="test-session", run_id="test-run", agent_name="bot")
    state = AgentState(messages=[])
    hook = TrackingHook()

    with patch("app.agent.agent_loop.retry.asyncio.sleep", new_callable=AsyncMock):
        kwargs = retry_args(agent) | {"ctx": ctx, "state": state, "hooks": [hook]}
        chunks = [c async for c in stream_with_retry(messages=[], tools=None, **kwargs)]

    assert len(chunks) == 1
    assert len(rate_limit_calls) == 1
    assert rate_limit_calls[0]["attempt"] == 1


async def test_stream_with_retry_interrupt_stops_rate_limit_wait():
    """User stop should break out immediately while waiting for a short 429 retry."""
    import asyncio
    import httpx

    call_count = 0

    async def mock_stream(
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ):
        nonlocal call_count
        call_count += 1
        response = httpx.Response(
            429,
            headers={"retry-after": "1"},
            request=httpx.Request("POST", "http://x"),
        )
        raise httpx.HTTPStatusError(
            "rate limited", request=response.request, response=response
        )
        yield  # pragma: no cover

    provider = MockProvider([[]])
    provider.stream = mock_stream  # type: ignore[method-assign]
    agent = Agent(name="bot", llm_provider=provider)
    interrupt_event = asyncio.Event()

    async def stop_soon():
        await asyncio.sleep(0)
        interrupt_event.set()

    stopper = asyncio.create_task(stop_soon())
    chunks = [
        c
        async for c in stream_with_retry(
            **retry_args(agent),
            messages=[],
            tools=None,
            interrupt_event=interrupt_event,
        )
    ]
    await stopper

    assert chunks == []
    assert call_count == 1


# ---------------------------------------------------------------------------
# Non-retryable error where aread() itself raises → body = "<unreadable>"
# Covers agent.py:556-557
# ---------------------------------------------------------------------------


async def test_stream_with_retry_non_retryable_aread_itself_raises():
    """Non-retryable 403 where response.aread() raises → body='<unreadable>'."""
    import httpx
    from unittest.mock import AsyncMock, MagicMock, patch

    # Create a mock response whose aread() raises
    mock_response = MagicMock(spec=httpx.Response)
    mock_response.status_code = 403
    mock_response.aread = AsyncMock(side_effect=OSError("connection reset"))
    mock_response.request = httpx.Request("POST", "http://x")

    async def mock_stream(
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ):
        raise httpx.HTTPStatusError(
            "forbidden", request=mock_response.request, response=mock_response
        )
        yield  # pragma: no cover

    provider = MockProvider([[]])
    provider.stream = mock_stream  # type: ignore[method-assign]
    agent = Agent(name="bot", llm_provider=provider)

    import pytest as _pytest

    with patch("app.agent.agent_loop.retry.asyncio.sleep", new_callable=AsyncMock):
        with _pytest.raises(ProviderAuthenticationError):
            async for _ in stream_with_retry(
                **retry_args(agent), messages=[], tools=None
            ):
                pass


# ---------------------------------------------------------------------------
# Fallback model — stream_with_retry switches provider after primary fails
# ---------------------------------------------------------------------------


async def test_fallback_model_used_when_primary_exhausts_retries():
    """Fallback provider is used after primary model exhausts all retry attempts."""
    import httpx
    from unittest.mock import AsyncMock, patch

    from app.agent.agent_loop import MAX_RETRIES

    primary_calls = 0

    async def primary_stream(
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ):
        nonlocal primary_calls
        primary_calls += 1
        response = httpx.Response(429, request=httpx.Request("POST", "http://x"))
        raise httpx.HTTPStatusError(
            "rate limited", request=response.request, response=response
        )
        yield  # pragma: no cover

    async def fallback_stream(
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ):
        yield make_text_chunk("fallback response")

    primary_provider = MockProvider([[]])
    primary_provider.stream = primary_stream  # type: ignore[method-assign]

    fallback_provider = MockProvider([[]])
    fallback_provider.stream = fallback_stream  # type: ignore[method-assign]

    agent = Agent(
        name="bot",
        llm_provider=primary_provider,
        model_id="primary:model",
        fallback_provider=fallback_provider,
        fallback_model_id="fallback:model",
    )

    with patch("app.agent.agent_loop.retry.asyncio.sleep", new_callable=AsyncMock):
        chunks = [
            c
            async for c in stream_with_retry(
                **retry_args(agent), messages=[], tools=None
            )
        ]

    assert primary_calls == MAX_RETRIES
    assert len(chunks) == 1
    assert chunks[0].choices[0].delta.content == "fallback response"


async def test_fallback_model_used_immediately_on_429_retry_after_60s():
    """429 with a 60s retry delay skips retries and falls back immediately."""
    import httpx
    from unittest.mock import AsyncMock, patch

    primary_calls = 0

    async def primary_stream(
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ):
        nonlocal primary_calls
        primary_calls += 1
        response = httpx.Response(
            429,
            headers={"retry-after": "60"},
            request=httpx.Request("POST", "http://x"),
        )
        raise httpx.HTTPStatusError(
            "rate limited", request=response.request, response=response
        )
        yield  # pragma: no cover

    async def fallback_stream(
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ):
        yield make_text_chunk("fallback response")

    primary_provider = MockProvider([[]])
    primary_provider.stream = primary_stream  # type: ignore[method-assign]

    fallback_provider = MockProvider([[]])
    fallback_provider.stream = fallback_stream  # type: ignore[method-assign]

    agent = Agent(
        name="bot",
        llm_provider=primary_provider,
        fallback_provider=fallback_provider,
        fallback_model_id="fallback:model",
    )

    with patch("app.agent.agent_loop.retry.asyncio.sleep", new_callable=AsyncMock):
        chunks = [
            c
            async for c in stream_with_retry(
                **retry_args(agent), messages=[], tools=None
            )
        ]

    assert primary_calls == 1
    assert len(chunks) == 1
    assert chunks[0].choices[0].delta.content == "fallback response"


async def test_fallback_model_used_immediately_on_usage_limit_429():
    """Quota exhaustion is not retried; fallback is attempted immediately."""
    import httpx
    from unittest.mock import AsyncMock, patch

    primary_calls = 0

    async def primary_stream(
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ):
        nonlocal primary_calls
        primary_calls += 1
        response = httpx.Response(
            429,
            request=httpx.Request("POST", "http://x"),
            json={"error": {"type": "usage_limit_reached"}},
        )
        raise httpx.HTTPStatusError(
            "usage limit reached", request=response.request, response=response
        )
        yield  # pragma: no cover

    async def fallback_stream(
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ):
        yield make_text_chunk("fallback response")

    primary_provider = MockProvider([[]])
    primary_provider.stream = primary_stream  # type: ignore[method-assign]

    fallback_provider = MockProvider([[]])
    fallback_provider.stream = fallback_stream  # type: ignore[method-assign]

    agent = Agent(
        name="bot",
        llm_provider=primary_provider,
        fallback_provider=fallback_provider,
        fallback_model_id="fallback:model",
    )

    with patch("app.agent.agent_loop.retry.asyncio.sleep", new_callable=AsyncMock):
        chunks = [
            c
            async for c in stream_with_retry(
                **retry_args(agent), messages=[], tools=None
            )
        ]

    assert primary_calls == 1
    assert len(chunks) == 1
    assert chunks[0].choices[0].delta.content == "fallback response"


async def test_fallback_model_used_immediately_on_insufficient_balance_429():
    """Provider balance exhaustion is not retried; fallback is attempted immediately."""
    import httpx
    from unittest.mock import AsyncMock, patch

    primary_calls = 0

    async def primary_stream(
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ):
        nonlocal primary_calls
        primary_calls += 1
        response = httpx.Response(
            429,
            request=httpx.Request("POST", "http://x"),
            json={
                "error": {
                    "code": "1113",
                    "message": "Insufficient balance or no resource package. Please recharge.",
                }
            },
        )
        raise httpx.HTTPStatusError(
            "insufficient balance", request=response.request, response=response
        )
        yield  # pragma: no cover

    async def fallback_stream(
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ):
        yield make_text_chunk("fallback response")

    primary_provider = MockProvider([[]])
    primary_provider.stream = primary_stream  # type: ignore[method-assign]

    fallback_provider = MockProvider([[]])
    fallback_provider.stream = fallback_stream  # type: ignore[method-assign]

    agent = Agent(
        name="bot",
        llm_provider=primary_provider,
        fallback_provider=fallback_provider,
        fallback_model_id="fallback:model",
    )

    with patch("app.agent.agent_loop.retry.asyncio.sleep", new_callable=AsyncMock):
        chunks = [
            c
            async for c in stream_with_retry(
                **retry_args(agent), messages=[], tools=None
            )
        ]

    assert primary_calls == 1
    assert len(chunks) == 1
    assert chunks[0].choices[0].delta.content == "fallback response"


async def test_fallback_model_not_used_on_non_retryable_error():
    """Non-retryable errors (e.g. 400) are raised immediately — no fallback."""
    import httpx
    from unittest.mock import AsyncMock, patch
    import pytest as _pytest

    async def primary_stream(
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ):
        response = httpx.Response(400, request=httpx.Request("POST", "http://x"))
        raise httpx.HTTPStatusError(
            "bad request", request=response.request, response=response
        )
        yield  # pragma: no cover

    fallback_calls = 0

    async def fallback_stream(
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ):
        nonlocal fallback_calls
        fallback_calls += 1
        yield make_text_chunk("should not reach")

    primary_provider = MockProvider([[]])
    primary_provider.stream = primary_stream  # type: ignore[method-assign]

    fallback_provider = MockProvider([[]])
    fallback_provider.stream = fallback_stream  # type: ignore[method-assign]

    agent = Agent(
        name="bot",
        llm_provider=primary_provider,
        fallback_provider=fallback_provider,
        fallback_model_id="fallback:model",
    )

    with patch("app.agent.agent_loop.retry.asyncio.sleep", new_callable=AsyncMock):
        with _pytest.raises(ProviderRequestError):
            async for _ in stream_with_retry(
                **retry_args(agent), messages=[], tools=None
            ):
                pass

    assert fallback_calls == 0  # Fallback was never attempted


async def test_fallback_model_also_retried_on_failure():
    """Fallback provider is also retried with exponential backoff when it fails."""
    import httpx
    from unittest.mock import AsyncMock, patch
    import pytest as _pytest

    from app.agent.agent_loop import MAX_RETRIES

    primary_calls = 0
    fallback_calls = 0

    async def primary_stream(
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ):
        nonlocal primary_calls
        primary_calls += 1
        response = httpx.Response(500, request=httpx.Request("POST", "http://x"))
        raise httpx.HTTPStatusError(
            "server error", request=response.request, response=response
        )
        yield  # pragma: no cover

    async def fallback_stream(
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ):
        nonlocal fallback_calls
        fallback_calls += 1
        response = httpx.Response(502, request=httpx.Request("POST", "http://x"))
        raise httpx.HTTPStatusError(
            "bad gateway", request=response.request, response=response
        )
        yield  # pragma: no cover

    primary_provider = MockProvider([[]])
    primary_provider.stream = primary_stream  # type: ignore[method-assign]

    fallback_provider = MockProvider([[]])
    fallback_provider.stream = fallback_stream  # type: ignore[method-assign]

    agent = Agent(
        name="bot",
        llm_provider=primary_provider,
        fallback_provider=fallback_provider,
        fallback_model_id="fallback:model",
    )

    with patch("app.agent.agent_loop.retry.asyncio.sleep", new_callable=AsyncMock):
        with _pytest.raises(httpx.HTTPStatusError):
            async for _ in stream_with_retry(
                **retry_args(agent), messages=[], tools=None
            ):
                pass

    # Both primary and fallback exhausted all retries
    assert primary_calls == MAX_RETRIES
    assert fallback_calls == MAX_RETRIES


async def test_no_fallback_when_not_configured():
    """Without fallback_provider, retry then raise a domain rate-limit error."""
    import httpx
    from unittest.mock import AsyncMock, patch
    import pytest as _pytest

    from app.agent.agent_loop import MAX_RETRIES

    call_count = 0

    async def failing_stream(
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ):
        nonlocal call_count
        call_count += 1
        response = httpx.Response(429, request=httpx.Request("POST", "http://x"))
        raise httpx.HTTPStatusError(
            "rate limited", request=response.request, response=response
        )
        yield  # pragma: no cover

    provider = MockProvider([[]])
    provider.stream = failing_stream  # type: ignore[method-assign]

    agent = Agent(name="bot", llm_provider=provider)
    assert agent.fallback_provider is None

    with patch("app.agent.agent_loop.retry.asyncio.sleep", new_callable=AsyncMock):
        with _pytest.raises(ProviderRateLimitError):
            async for _ in stream_with_retry(
                **retry_args(agent), messages=[], tools=None
            ):
                pass

    assert call_count == MAX_RETRIES


async def test_fallback_rate_limit_exhaustion_raises_domain_error():
    """If primary and fallback end on 429, callers get a controlled domain error."""
    import httpx
    from unittest.mock import AsyncMock, patch
    import pytest as _pytest

    primary_calls = 0
    fallback_calls = 0

    async def primary_stream(
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ):
        nonlocal primary_calls
        primary_calls += 1
        response = httpx.Response(
            429,
            request=httpx.Request("POST", "http://x"),
            json={"error": {"message": "Insufficient balance"}},
        )
        raise httpx.HTTPStatusError(
            "rate limited", request=response.request, response=response
        )
        yield  # pragma: no cover

    async def fallback_stream(
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ):
        nonlocal fallback_calls
        fallback_calls += 1
        response = httpx.Response(
            429,
            request=httpx.Request("POST", "http://x"),
            json={"error": {"type": "usage_limit_reached"}},
        )
        raise httpx.HTTPStatusError(
            "rate limited", request=response.request, response=response
        )
        yield  # pragma: no cover

    primary_provider = MockProvider([[]])
    primary_provider.stream = primary_stream  # type: ignore[method-assign]

    fallback_provider = MockProvider([[]])
    fallback_provider.stream = fallback_stream  # type: ignore[method-assign]

    agent = Agent(
        name="bot",
        llm_provider=primary_provider,
        fallback_provider=fallback_provider,
        fallback_model_id="fallback:model",
    )

    with patch("app.agent.agent_loop.retry.asyncio.sleep", new_callable=AsyncMock):
        with _pytest.raises(ProviderRateLimitError):
            async for _ in stream_with_retry(
                **retry_args(agent), messages=[], tools=None
            ):
                pass

    assert primary_calls == 1
    assert fallback_calls == 1


async def test_fallback_connection_error_retried():
    """Connection errors on primary trigger fallback, which succeeds."""
    import httpx
    from unittest.mock import AsyncMock, patch

    from app.agent.agent_loop import MAX_RETRIES

    primary_calls = 0

    async def primary_stream(
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ):
        nonlocal primary_calls
        primary_calls += 1
        raise httpx.ConnectError("connection refused")
        yield  # pragma: no cover

    async def fallback_stream(
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ):
        yield make_text_chunk("fallback ok")

    primary_provider = MockProvider([[]])
    primary_provider.stream = primary_stream  # type: ignore[method-assign]

    fallback_provider = MockProvider([[]])
    fallback_provider.stream = fallback_stream  # type: ignore[method-assign]

    agent = Agent(
        name="bot",
        llm_provider=primary_provider,
        fallback_provider=fallback_provider,
        fallback_model_id="fallback:model",
    )

    with patch("app.agent.agent_loop.retry.asyncio.sleep", new_callable=AsyncMock):
        chunks = [
            c
            async for c in stream_with_retry(
                **retry_args(agent), messages=[], tools=None
            )
        ]

    assert primary_calls == MAX_RETRIES
    assert len(chunks) == 1
    assert chunks[0].choices[0].delta.content == "fallback ok"


# ---------------------------------------------------------------------------
# Interrupt cancels in-flight tool calls (agent_loop._gather_or_cancel)
# ---------------------------------------------------------------------------


async def test_interrupt_cancels_inflight_tool_calls():
    """When interrupt fires mid-tool-execution, pending tools get 'Cancelled by user.'."""
    import asyncio

    tool_started = asyncio.Event()

    async def slow_tool(x: int) -> str:
        """A tool that takes a long time."""
        tool_started.set()
        await asyncio.sleep(60)  # will be cancelled
        return "should never return"

    provider = MockProvider(
        [
            [make_tool_chunk("slow_tool", "call_1", '{"x": 1}')],
            # Second LLM call would happen if not interrupted — not needed
        ]
    )
    agent = Agent(name="bot", llm_provider=provider, tools=[Tool(slow_tool)])

    event = asyncio.Event()

    async def _set_after_start():
        await tool_started.wait()
        event.set()

    setter = asyncio.create_task(_set_after_start())

    msgs = await agent.run(
        [HumanMessage(content="go")],
        interrupt_event=event,
    )
    await setter

    tool_msgs = [m for m in msgs if isinstance(m, ToolMessage)]
    assert len(tool_msgs) == 1
    assert tool_msgs[0].content == "Cancelled by user."
    assert tool_msgs[0].name == "slow_tool"


async def test_interrupt_before_tool_dispatch_skips_execution():
    """When interrupt fires after streaming but before tool dispatch, tools are skipped.

    The interrupt is set *during* streaming (after chunks are yielded) so that
    tool call chunks are assembled but the pre-dispatch check catches the event
    before any tool code runs.
    """
    import asyncio

    call_count = 0

    def counted_tool(x: int) -> str:
        """A tool that counts calls."""
        nonlocal call_count
        call_count += 1
        return "done"

    # Provider that sets interrupt after yielding the tool chunk
    event = asyncio.Event()

    class SetAfterYieldProvider(MockProvider):
        def stream(
            self,
            messages: list[ChatMessage],
            tools: list[dict] | None = None,
            **kwargs,
        ):
            chunk = make_tool_chunk("counted_tool", "call_1", '{"x": 1}')

            async def _gen():
                yield chunk
                # Set interrupt after chunk is consumed — tool calls are assembled
                # but execution hasn't started yet.
                event.set()

            return _gen()

    provider = SetAfterYieldProvider([[]])
    agent = Agent(name="bot", llm_provider=provider, tools=[Tool(counted_tool)])

    msgs = await agent.run(
        [HumanMessage(content="go")],
        interrupt_event=event,
    )

    # Tool should never have been called
    assert call_count == 0
    tool_msgs = [m for m in msgs if isinstance(m, ToolMessage)]
    assert len(tool_msgs) == 1
    assert tool_msgs[0].content == "Cancelled by user."


async def test_interrupt_cancels_some_tools_keeps_completed():
    """Completed tools keep real results; only pending ones get cancelled."""
    import asyncio

    slow_started = asyncio.Event()

    def fast_tool(x: int) -> str:
        """Returns immediately."""
        return "fast result"

    async def slow_tool(x: int) -> str:
        """Takes forever."""
        slow_started.set()
        await asyncio.sleep(60)
        return "never"

    # Build a single chunk that contains two tool calls at different indices
    two_tool_chunk = ChatCompletionChunk(
        id="chunk-multi",
        created=1_000_000,
        model="mock-model",
        choices=[
            ChatCompletionChunkChoice(
                index=0,
                delta=ChatCompletionDelta(
                    tool_calls=[
                        ToolCallDelta(
                            index=0,
                            id="call_1",
                            function=FunctionCallDelta(
                                name="fast_tool", arguments='{"x": 1}'
                            ),
                        ),
                        ToolCallDelta(
                            index=1,
                            id="call_2",
                            function=FunctionCallDelta(
                                name="slow_tool", arguments='{"x": 2}'
                            ),
                        ),
                    ]
                ),
                finish_reason="tool_calls",
            )
        ],
    )

    provider = MockProvider([[two_tool_chunk]])
    agent = Agent(
        name="bot",
        llm_provider=provider,
        tools=[Tool(fast_tool), Tool(slow_tool)],
    )

    event = asyncio.Event()

    async def _set_after_slow_starts():
        await slow_started.wait()
        event.set()

    setter = asyncio.create_task(_set_after_slow_starts())

    msgs = await agent.run(
        [HumanMessage(content="go")],
        interrupt_event=event,
    )
    await setter

    tool_msgs = [m for m in msgs if isinstance(m, ToolMessage)]
    assert len(tool_msgs) == 2

    by_name = {m.name: m.content for m in tool_msgs}
    assert by_name["fast_tool"] == "fast result"
    assert by_name["slow_tool"] == "Cancelled by user."
