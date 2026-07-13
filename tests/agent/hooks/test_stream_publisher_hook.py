"""Tests for app/agent/hooks/stream_publisher.py — StreamPublisherHook."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.agent.hooks.stream_publisher import StreamPublisherHook
from app.agent.permission import PermissionService, Rule
from app.agent.schemas.chat import (
    AssistantMessage,
    ChatCompletionChunk,
    ChatCompletionChunkChoice,
    ChatCompletionDelta,
    FunctionCallDelta,
    ToolCallDelta,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_hook(
    session_id: str = "sess-1",
    agent_name: str = "worker",
    *,
    publish_reasoning: bool = True,
) -> StreamPublisherHook:
    return StreamPublisherHook(
        session_id=session_id,
        agent_name=agent_name,
        publish_reasoning=publish_reasoning,
    )


def _make_chunk(
    *,
    content: str | None = None,
    reasoning: str | None = None,
    tool_calls: list | None = None,
    usage=None,
) -> ChatCompletionChunk:
    delta = ChatCompletionDelta(
        content=content,
        reasoning_content=reasoning,
        tool_calls=tool_calls,
    )
    choice = ChatCompletionChunkChoice(index=0, delta=delta, finish_reason=None)
    return ChatCompletionChunk(
        id="c1", created=1000, model="mock", choices=[choice], usage=usage
    )


# ---------------------------------------------------------------------------
# model timing
# ---------------------------------------------------------------------------


class TestModelTiming:
    @pytest.mark.asyncio
    async def test_after_model_persists_duration_in_response_extra(self):
        hook = _make_hook()
        response = AssistantMessage(content="answer")

        with patch("app.agent.hooks.stream_publisher.time") as mock_time:
            mock_time.monotonic.side_effect = [20.0, 21.234]
            await hook.before_model(MagicMock(), MagicMock(), MagicMock())
            await hook.after_model(MagicMock(), MagicMock(), response)

        assert response.extra == {"duration_ms": 1234.0}

    @pytest.mark.asyncio
    async def test_after_model_uses_turn_start_when_available(self):
        hook = _make_hook()
        response = AssistantMessage(content="answer")

        with patch("app.agent.hooks.stream_publisher.time") as mock_time:
            mock_time.monotonic.side_effect = [10.0, 12.0, 15.5]
            await hook.before_agent(MagicMock(), MagicMock())
            await hook.before_model(MagicMock(), MagicMock(), MagicMock())
            await hook.after_model(MagicMock(), MagicMock(), response)

        assert response.extra == {"duration_ms": 5500.0}

    @pytest.mark.asyncio
    async def test_after_model_preserves_existing_extra_fields(self):
        hook = _make_hook()
        response = AssistantMessage(content="answer", extra={"usage": {"input": 1}})

        with patch("app.agent.hooks.stream_publisher.time") as mock_time:
            mock_time.monotonic.side_effect = [5.0, 5.25]
            await hook.before_model(MagicMock(), MagicMock(), MagicMock())
            await hook.after_model(MagicMock(), MagicMock(), response)

        assert response.extra == {"usage": {"input": 1}, "duration_ms": 250.0}

    @pytest.mark.asyncio
    async def test_after_model_without_before_model_leaves_extra_unchanged(self):
        hook = _make_hook()
        response = AssistantMessage(content="answer", extra={"usage": {"input": 1}})

        await hook.after_model(MagicMock(), MagicMock(), response)

        assert response.extra == {"usage": {"input": 1}}


# ---------------------------------------------------------------------------
# on_model_delta — message
# ---------------------------------------------------------------------------


class TestOnModelDeltaMessage:
    @pytest.mark.asyncio
    async def test_pushes_message_event_for_content(self):
        hook = _make_hook()
        pushed = []

        async def fake_push(sid, event):
            pushed.append(event)

        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            await hook.on_model_delta(
                MagicMock(), MagicMock(), _make_chunk(content="hello")
            )

        assert any(e.event == "message" for e in pushed)
        msg_event = next(e for e in pushed if e.event == "message")
        assert msg_event.data["text"] == "hello"
        assert msg_event.data["agent"] == "worker"

    @pytest.mark.asyncio
    async def test_pushes_thinking_event_for_reasoning(self):
        hook = _make_hook()
        pushed = []

        async def fake_push(sid, event):
            pushed.append(event)

        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            await hook.on_model_delta(
                MagicMock(), MagicMock(), _make_chunk(reasoning="my thought")
            )

        assert any(e.event == "thinking" for e in pushed)

    @pytest.mark.asyncio
    async def test_suppresses_thinking_event_when_reasoning_not_published(self):
        hook = _make_hook(publish_reasoning=False)
        pushed = []

        async def fake_push(sid, event):
            pushed.append(event)

        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            await hook.on_model_delta(
                MagicMock(), MagicMock(), _make_chunk(reasoning="my thought")
            )

        assert not any(e.event == "thinking" for e in pushed)

    @pytest.mark.asyncio
    async def test_no_push_for_empty_content(self):
        hook = _make_hook()
        pushed = []

        async def fake_push(sid, event):
            pushed.append(event)

        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            await hook.on_model_delta(
                MagicMock(), MagicMock(), _make_chunk(content=None)
            )

        assert not any(e.event == "message" for e in pushed)


# ---------------------------------------------------------------------------
# on_model_delta — tool_call delta
# ---------------------------------------------------------------------------


def _make_tool_call_delta(tc_id: str, fn_name: str, index: int = 0) -> ToolCallDelta:
    return ToolCallDelta(
        id=tc_id,
        index=index,
        function=FunctionCallDelta(name=fn_name, arguments=""),
    )


class TestOnModelDeltaToolCall:
    @pytest.mark.asyncio
    async def test_pushes_tool_call_event_on_first_delta(self):
        hook = _make_hook()
        pushed = []

        async def fake_push(sid, event):
            pushed.append(event)

        tc = _make_tool_call_delta("tc-1", "web_search")
        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            await hook.on_model_delta(
                MagicMock(), MagicMock(), _make_chunk(tool_calls=[tc])
            )

        assert any(e.event == "tool_call" for e in pushed)
        tc_event = next(e for e in pushed if e.event == "tool_call")
        assert tc_event.data["name"] == "web_search"
        assert tc_event.data["tool_call_id"] == "tc-1"

    @pytest.mark.asyncio
    async def test_deduplicates_tool_call_id(self):
        """Same tc_id in two chunks must only push one tool_call event."""
        hook = _make_hook()
        pushed = []

        async def fake_push(sid, event):
            pushed.append(event)

        tc = _make_tool_call_delta("tc-dup", "web_search")
        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            await hook.on_model_delta(
                MagicMock(), MagicMock(), _make_chunk(tool_calls=[tc])
            )
            await hook.on_model_delta(
                MagicMock(), MagicMock(), _make_chunk(tool_calls=[tc])
            )

        tool_call_events = [e for e in pushed if e.event == "tool_call"]
        assert len(tool_call_events) == 1

    @pytest.mark.asyncio
    async def test_parallel_same_tool_gets_unique_ids(self):
        """Two parallel calls to the same tool must enqueue two separate ids."""
        hook = _make_hook()
        pushed = []

        async def fake_push(sid, event):
            pushed.append(event)

        tc_a = _make_tool_call_delta("id-A", "web_search")
        tc_b = _make_tool_call_delta("id-B", "web_search")

        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            await hook.on_model_delta(
                MagicMock(), MagicMock(), _make_chunk(tool_calls=[tc_a])
            )
            await hook.on_model_delta(
                MagicMock(), MagicMock(), _make_chunk(tool_calls=[tc_b])
            )

        tool_ids = [e.data["tool_call_id"] for e in pushed if e.event == "tool_call"]
        assert len(set(tool_ids)) == 2


# ---------------------------------------------------------------------------
# wrap_tool_call — FIFO + resolved_ids
# ---------------------------------------------------------------------------


class TestWrapToolCall:
    async def test_concurrent_permission_requests_keep_each_hooks_stream_callback(self):
        """Shared permission services must not leak one hook's SSE callback."""
        original_callback = MagicMock()
        service = PermissionService(
            session_id="permissions",
            base_ruleset=[Rule(permission="shell", pattern="*", action="ask")],
            on_ask=original_callback,
        )
        first = _make_hook(session_id="first-session", agent_name="first")
        second = _make_hook(session_id="second-session", agent_name="second")
        emitted = []
        both_permission_events_emitted = asyncio.Event()

        def make_tool_call(tool_id: str):
            tool_call = MagicMock()
            tool_call.id = tool_id
            tool_call.function = MagicMock()
            tool_call.function.name = "shell"
            tool_call.function.arguments = '{"command":"echo hi"}'
            return tool_call

        async def fake_push(session_id, event):
            emitted.append((session_id, event))
            if event.event == "permission_asked":
                if len([e for _, e in emitted if e.event == "permission_asked"]) == 2:
                    both_permission_events_emitted.set()
                    service.auto_allow_all_pending()
                else:
                    await both_permission_events_emitted.wait()

        async def handler(ctx, state, tool_call):
            return "ok"

        with (
            patch("app.agent.permission.get_permission_service", return_value=service),
            patch("app.services.memory_stream_store.push_event", new=fake_push),
        ):
            first_task = asyncio.create_task(
                first.wrap_tool_call(
                    MagicMock(),
                    SimpleNamespace(metadata={}),
                    make_tool_call("one"),
                    handler,
                )
            )
            second_task = asyncio.create_task(
                second.wrap_tool_call(
                    MagicMock(),
                    SimpleNamespace(metadata={}),
                    make_tool_call("two"),
                    handler,
                )
            )
            await asyncio.gather(first_task, second_task)

        permission_sessions = [
            session_id
            for session_id, event in emitted
            if event.event == "permission_asked"
        ]
        assert sorted(permission_sessions) == ["first-session", "second-session"]
        assert service._on_ask is original_callback

    @pytest.mark.asyncio
    async def test_pushes_tool_start_and_tool_end(self):
        hook = _make_hook()
        pushed = []

        async def fake_push(sid, event):
            pushed.append(event)

        # Prime the FIFO queue with one id (as if on_model_delta was called first)
        hook._resolver.register("web_search", "queued-tc-id")

        tool_call = MagicMock()
        tool_call.id = "internal-id"
        tool_call.function = MagicMock()
        tool_call.function.name = "web_search"
        tool_call.function.arguments = '{"q":"test"}'

        async def mock_handler(ctx, state, tc):
            return "search results"

        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            result = await hook.wrap_tool_call(
                MagicMock(), MagicMock(), tool_call, mock_handler
            )

        assert result == "search results"
        event_types = [e.event for e in pushed]
        assert "tool_start" in event_types
        assert "tool_end" in event_types

    @pytest.mark.asyncio
    async def test_tool_output_callback_pushes_delta(self):
        hook = _make_hook()
        pushed = []

        async def fake_push(sid, event):
            pushed.append(event)

        hook._resolver.register("shell", "queued-shell-id")

        tool_call = MagicMock()
        tool_call.id = "internal-shell-id"
        tool_call.function = MagicMock()
        tool_call.function.name = "shell"
        tool_call.function.arguments = '{"command":"echo hi"}'
        state = MagicMock()
        state.metadata = {}

        async def mock_handler(ctx, state, tc):
            callback = state.metadata["_tool_output_callbacks"][tc.id]
            await callback("hi\n")
            return "[Succeeded]\n\nhi\n"

        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            result = await hook.wrap_tool_call(
                MagicMock(), state, tool_call, mock_handler
            )

        assert result == "[Succeeded]\n\nhi\n"
        delta = next(e for e in pushed if e.event == "tool_output_delta")
        assert delta.data["tool_call_id"] == "queued-shell-id"
        assert delta.data["name"] == "shell"
        assert delta.data["text"] == "hi\n"
        assert delta.data["sequence"] == 1

    @pytest.mark.asyncio
    async def test_tool_end_carries_result_and_persists_duration_metadata(self):
        hook = _make_hook()
        pushed = []

        async def fake_push(sid, event):
            pushed.append(event)

        hook._resolver.register("my_tool", "tc-99")

        tool_call = MagicMock()
        tool_call.id = "int-id"
        tool_call.function = MagicMock()
        tool_call.function.name = "my_tool"
        tool_call.function.arguments = "{}"
        state = MagicMock()
        state.metadata = {"keep": "me"}

        async def mock_handler(ctx, state, tc):
            return "the result"

        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            with patch("app.agent.hooks.stream_publisher.time") as mock_time:
                mock_time.monotonic.side_effect = [10.0, 10.456]
                await hook.wrap_tool_call(MagicMock(), state, tool_call, mock_handler)

        end_event = next(e for e in pushed if e.event == "tool_end")
        assert end_event.data["result"] == "the result"
        assert end_event.data["metadata"]["duration_ms"] == 456.0
        assert state.metadata["keep"] == "me"
        assert state.metadata["_tool_duration_ms"]["int-id"] == 456.0

    @pytest.mark.asyncio
    async def test_tool_end_passes_full_result(self):
        """Full result is sent via SSE — no truncation.

        ToolResultOffloadHook handles truly large results upstream;
        StreamPublisherHook should not silently break structured data.
        """
        hook = _make_hook()
        pushed = []

        async def fake_push(sid, event):
            pushed.append(event)

        hook._resolver.register("big_tool", "tc-big")

        tool_call = MagicMock()
        tool_call.id = "int-big"
        tool_call.function = MagicMock()
        tool_call.function.name = "big_tool"
        tool_call.function.arguments = "{}"

        long_result = "x" * 3000

        async def mock_handler(ctx, state, tc):
            return long_result

        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            await hook.wrap_tool_call(MagicMock(), MagicMock(), tool_call, mock_handler)

        end_event = next(e for e in pushed if e.event == "tool_end")
        assert end_event.data["result"] == long_result

    @pytest.mark.asyncio
    async def test_fifo_assigns_correct_ids_for_parallel_calls(self):
        """First wrap_tool_call gets id-A, second gets id-B (FIFO)."""
        hook = _make_hook()
        pushed = []

        async def fake_push(sid, event):
            pushed.append(event)

        hook._resolver.register("web_search", "id-A")
        hook._resolver.register("web_search", "id-B")

        def _make_tc(internal_id: str):
            tc = MagicMock()
            tc.id = internal_id
            tc.function = MagicMock()
            tc.function.name = "web_search"
            tc.function.arguments = "{}"
            return tc

        async def mock_handler(ctx, state, tc):
            return "ok"

        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            await hook.wrap_tool_call(
                MagicMock(), MagicMock(), _make_tc("int-1"), mock_handler
            )
            await hook.wrap_tool_call(
                MagicMock(), MagicMock(), _make_tc("int-2"), mock_handler
            )

        start_ids = [e.data["tool_call_id"] for e in pushed if e.event == "tool_start"]
        assert start_ids == ["id-A", "id-B"]


# ---------------------------------------------------------------------------
# on_rate_limit
# ---------------------------------------------------------------------------


class TestOnRateLimit:
    @pytest.mark.asyncio
    async def test_pushes_rate_limit_event(self):
        hook = _make_hook()
        pushed = []

        async def fake_push(sid, event):
            pushed.append(event)

        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            await hook.on_rate_limit(
                MagicMock(), MagicMock(), retry_after=5, attempt=1, max_attempts=3
            )

        assert len(pushed) == 1
        assert pushed[0].event == "rate_limit"
        assert pushed[0].data["retry_after"] == 5


# ---------------------------------------------------------------------------
# after_agent
# ---------------------------------------------------------------------------


class TestAfterAgent:
    @pytest.mark.asyncio
    async def test_does_not_push_agent_done_event(self):
        # agent_done is no longer emitted from after_agent — agent_status:idle
        # from _run_activation is sufficient to signal completion.
        hook = _make_hook(agent_name="researcher")
        pushed = []

        async def fake_push(sid, event):
            pushed.append(event)

        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            await hook.after_agent(MagicMock(), MagicMock(), MagicMock())

        assert not any(e.event == "agent_done" for e in pushed)
