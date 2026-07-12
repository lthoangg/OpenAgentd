"""Tests for `ResponsesHandler` SSE streaming parser — event sequences,
text deltas, tool-call assembly, reasoning chunks, and edge cases.

See `app/agent/providers/openai/responses.py:ResponsesHandler.parse_stream`.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
import httpx

from app.agent.providers.openai.responses import ResponsesHandler


# ─────────────────────────────────────────────────────────────────────────────
# Test ResponsesHandler streaming parser
# ─────────────────────────────────────────────────────────────────────────────


class TestResponsesStreaming:
    """Test Responses API streaming parser."""

    @pytest.fixture
    def handler(self):
        """Create a ResponsesHandler instance."""
        return ResponsesHandler(
            model="gpt-5.4",
            base_url="https://api.openai.com/v1",
            headers={"Authorization": "Bearer sk-test"},
        )

    async def test_parse_stream_text_response(self, handler):
        """Parse streaming text response."""
        # Each event is split into separate lines (event: and data:)
        lines = [
            "event: response.created",
            'data: {"type": "response.created", "response": {"id": "resp_123"}}',
            "event: response.output_text.delta",
            'data: {"type": "response.output_text.delta", "delta": "Hello"}',
            "event: response.output_text.delta",
            'data: {"type": "response.output_text.delta", "delta": " world"}',
            "event: response.output_text.done",
            'data: {"type": "response.output_text.done"}',
            "event: response.completed",
            'data: {"type": "response.completed", "response": {"id": "resp_123", "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}}}',
        ]

        # Mock response object with async iterator
        async def async_iter_lines():
            for line in lines:
                yield line

        response = MagicMock()
        response.aiter_lines = lambda: async_iter_lines()

        chunks = []
        async for chunk in handler._parse_stream(response):
            chunks.append(chunk)

        # Should have 4 chunks: 2 text deltas + 1 done + 1 usage
        assert len(chunks) == 4
        assert chunks[0].choices[0].delta.content == "Hello"
        assert chunks[1].choices[0].delta.content == " world"
        assert chunks[2].choices[0].finish_reason == "stop"
        assert chunks[3].usage is not None
        assert chunks[3].usage.prompt_tokens == 10
        assert chunks[3].usage.completion_tokens == 5

    async def test_parse_stream_response_failed_overload_is_retryable(self, handler):
        """Codex/OpenAI overload stream errors should enter retry handling."""
        lines = [
            "event: response.failed",
            'data: {"type": "response.failed", "response": {"error": {"type": "service_unavailable_error", "code": "server_is_overloaded", "message": "Our servers are currently overloaded."}}}',
        ]

        async def async_iter_lines():
            for line in lines:
                yield line

        response = MagicMock()
        response.aiter_lines = lambda: async_iter_lines()

        with pytest.raises(httpx.HTTPStatusError) as exc_info:
            async for _chunk in handler._parse_stream(response):
                pass

        assert exc_info.value.response.status_code == 503
        assert "overloaded" in exc_info.value.response.text

    async def test_parse_stream_response_failed_codex_usage_limit_is_429(self, handler):
        """Codex OAuth quota exhaustion should enter rate-limit fallback handling."""
        lines = [
            "event: response.failed",
            'data: {"type": "response.failed", "response": {"error": {"type": "usage_limit_reached", "message": "You have hit your usage limit."}}}',
        ]

        async def async_iter_lines():
            for line in lines:
                yield line

        response = MagicMock()
        response.aiter_lines = lambda: async_iter_lines()

        with pytest.raises(httpx.HTTPStatusError) as exc_info:
            async for _chunk in handler._parse_stream(response):
                pass

        assert exc_info.value.response.status_code == 429
        assert "usage_limit_reached" in exc_info.value.response.text

    async def test_parse_stream_response_failed_insufficient_quota_is_429(
        self, handler
    ):
        lines = [
            "event: response.failed",
            'data: {"type": "response.failed", "response": {"error": {"code": "insufficient_quota", "message": "You exceeded your current quota."}}}',
        ]

        async def async_iter_lines():
            for line in lines:
                yield line

        response = MagicMock()
        response.aiter_lines = lambda: async_iter_lines()

        with pytest.raises(httpx.HTTPStatusError) as exc_info:
            async for _chunk in handler._parse_stream(response):
                pass

        assert exc_info.value.response.status_code == 429
        assert "insufficient_quota" in exc_info.value.response.text

    async def test_parse_stream_tool_call(self, handler):
        """Parse streaming tool call response."""
        lines = [
            "event: response.created",
            'data: {"type": "response.created", "response": {"id": "resp_123"}}',
            "event: response.output_item.added",
            'data: {"type": "response.output_item.added", "item": {"id": "fc_456", "type": "function_call", "name": "get_weather"}}',
            "event: response.function_call_arguments.delta",
            'data: {"type": "response.function_call_arguments.delta", "item_id": "fc_456", "delta": "{\\"city"}',
            "event: response.function_call_arguments.delta",
            'data: {"type": "response.function_call_arguments.delta", "item_id": "fc_456", "delta": "\\": \\"NYC\\"}"}',
            "event: response.function_call_arguments.done",
            'data: {"type": "response.function_call_arguments.done", "item_id": "fc_456", "arguments": "{\\"city\\": \\"NYC\\"}"}',
            "event: response.completed",
            'data: {"type": "response.completed", "response": {"id": "resp_123", "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}}}',
        ]

        async def async_iter_lines():
            for line in lines:
                yield line

        response = MagicMock()
        response.aiter_lines = lambda: async_iter_lines()

        chunks = []
        async for chunk in handler._parse_stream(response):
            chunks.append(chunk)

        # Should have 4 chunks: 2 arg deltas + 1 done + 1 usage
        assert len(chunks) == 4
        # First two chunks are argument deltas
        assert chunks[0].choices[0].delta.tool_calls is not None
        assert chunks[0].choices[0].delta.tool_calls[0].function.arguments == '{"city'
        assert (
            chunks[1].choices[0].delta.tool_calls[0].function.arguments == '": "NYC"}'
        )
        # Third chunk is the done event — name is present, arguments suppressed
        # (deltas already streamed the full args; re-emitting would double JSON)
        assert chunks[2].choices[0].delta.tool_calls[0].function.name == "get_weather"
        assert chunks[2].choices[0].delta.tool_calls[0].id == "fc_456"
        assert chunks[2].choices[0].delta.tool_calls[0].function.arguments is None

    async def test_parse_stream_reasoning_and_text(self, handler):
        """Parse streaming response with reasoning and text."""
        lines = [
            "event: response.created",
            'data: {"type": "response.created", "response": {"id": "resp_123"}}',
            "event: response.reasoning_summary_text.delta",
            'data: {"type": "response.reasoning_summary_text.delta", "delta": "Let me think"}',
            "event: response.output_text.delta",
            'data: {"type": "response.output_text.delta", "delta": "The answer"}',
            "event: response.output_text.done",
            'data: {"type": "response.output_text.done"}',
            "event: response.completed",
            'data: {"type": "response.completed", "response": {"id": "resp_123", "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}}}',
        ]

        async def async_iter_lines():
            for line in lines:
                yield line

        response = MagicMock()
        response.aiter_lines = lambda: async_iter_lines()

        chunks = []
        async for chunk in handler._parse_stream(response):
            chunks.append(chunk)

        # Should have 4 chunks: 1 reasoning + 1 text + 1 done + 1 usage
        assert len(chunks) == 4
        assert chunks[0].choices[0].delta.reasoning_content == "Let me think"
        assert chunks[1].choices[0].delta.content == "The answer"

    async def test_parse_stream_captures_reasoning_encrypted_content_on_item_done(
        self, handler
    ):
        """A completed reasoning item's `encrypted_content` must be surfaced so
        it can be replayed on the next turn (see `convert_messages`)."""
        lines = [
            "event: response.created",
            'data: {"type": "response.created", "response": {"id": "resp_123"}}',
            "event: response.reasoning_summary_text.delta",
            'data: {"type": "response.reasoning_summary_text.delta", "delta": "Let me think"}',
            "event: response.output_item.done",
            'data: {"type": "response.output_item.done", "item": {"id": "rs_1", "type": "reasoning", "encrypted_content": "cipher123"}}',
        ]

        async def async_iter_lines():
            for line in lines:
                yield line

        response = MagicMock()
        response.aiter_lines = lambda: async_iter_lines()

        chunks = []
        async for chunk in handler._parse_stream(response):
            chunks.append(chunk)

        assert len(chunks) == 2
        assert chunks[1].choices[0].delta.reasoning_item_id == "rs_1"
        assert chunks[1].choices[0].delta.reasoning_encrypted_content == "cipher123"

    async def test_parse_stream_ignores_output_item_done_without_encrypted_content(
        self, handler
    ):
        """Reasoning items without `encrypted_content` (no `include` requested)
        must not emit a spurious delta."""
        lines = [
            "event: response.created",
            'data: {"type": "response.created", "response": {"id": "resp_123"}}',
            "event: response.output_item.done",
            'data: {"type": "response.output_item.done", "item": {"id": "rs_1", "type": "reasoning"}}',
            "event: response.output_item.done",
            'data: {"type": "response.output_item.done", "item": {"id": "msg_1", "type": "message"}}',
        ]

        async def async_iter_lines():
            for line in lines:
                yield line

        response = MagicMock()
        response.aiter_lines = lambda: async_iter_lines()

        chunks = []
        async for chunk in handler._parse_stream(response):
            chunks.append(chunk)

        assert chunks == []

    async def test_parse_stream_accepts_all_reasoning_delta_event_names(self, handler):
        """Parse all known Responses reasoning delta event names."""
        lines = [
            "event: response.created",
            'data: {"type": "response.created", "response": {"id": "resp_123"}}',
            "event: response.reasoning_text.delta",
            'data: {"type": "response.reasoning_text.delta", "delta": "raw"}',
            "event: response.reasoning_summary.delta",
            'data: {"type": "response.reasoning_summary.delta", "delta": "summary"}',
            "event: response.reasoning_summary_text.delta",
            'data: {"type": "response.reasoning_summary_text.delta", "delta": "summary text"}',
        ]

        async def async_iter_lines():
            for line in lines:
                yield line

        response = MagicMock()
        response.aiter_lines = lambda: async_iter_lines()

        chunks = []
        async for chunk in handler._parse_stream(response):
            chunks.append(chunk)

        assert [c.choices[0].delta.reasoning_content for c in chunks] == [
            "raw",
            "summary",
            "summary text",
        ]

    async def test_parse_stream_inserts_blank_line_between_reasoning_parts(
        self, handler
    ):
        """OpenAI's /responses API streams reasoning as multiple ``summary_part``
        items, each beginning with its own bold header (``**Title**``). Without
        an explicit separator between parts, the agent loop's
        ``reasoning += delta`` concatenation glues part N's header onto the
        tail of part N-1's prose. The parser must inject a blank-line delta
        on every ``reasoning_summary_part.added`` after the first.
        """
        lines = [
            "event: response.created",
            'data: {"type": "response.created", "response": {"id": "resp_1"}}',
            # Part 1
            "event: response.reasoning_summary_part.added",
            'data: {"type": "response.reasoning_summary_part.added"}',
            "event: response.reasoning_summary_text.delta",
            'data: {"type": "response.reasoning_summary_text.delta", "delta": "**One**\\n\\nFirst body."}',
            "event: response.reasoning_summary_text.done",
            'data: {"type": "response.reasoning_summary_text.done"}',
            # Part 2 — should be prefixed with a blank-line delta
            "event: response.reasoning_summary_part.added",
            'data: {"type": "response.reasoning_summary_part.added"}',
            "event: response.reasoning_summary_text.delta",
            'data: {"type": "response.reasoning_summary_text.delta", "delta": "**Two**\\n\\nSecond body."}',
            "event: response.reasoning_summary_text.done",
            'data: {"type": "response.reasoning_summary_text.done"}',
            "event: response.output_text.delta",
            'data: {"type": "response.output_text.delta", "delta": "final"}',
            "event: response.output_text.done",
            'data: {"type": "response.output_text.done"}',
            "event: response.completed",
            'data: {"type": "response.completed", "response": {"id": "resp_1", "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}}',
        ]

        async def async_iter_lines():
            for line in lines:
                yield line

        response = MagicMock()
        response.aiter_lines = lambda: async_iter_lines()

        chunks = []
        async for chunk in handler._parse_stream(response):
            chunks.append(chunk)

        reasoning_deltas = [
            c.choices[0].delta.reasoning_content
            for c in chunks
            if c.choices and c.choices[0].delta.reasoning_content
        ]

        # Three reasoning deltas: part-1 text, "\n\n" separator, part-2 text.
        assert reasoning_deltas == [
            "**One**\n\nFirst body.",
            "\n\n",
            "**Two**\n\nSecond body.",
        ]
        # Accumulated reasoning must not glue headers together.
        joined = "".join(reasoning_deltas)
        assert "First body.\n\n**Two**" in joined
        assert "First body.**Two**" not in joined

    async def test_parse_stream_no_separator_before_first_reasoning_part(self, handler):
        """The very first ``reasoning_summary_part.added`` must NOT emit a
        leading ``\\n\\n`` delta — that would prepend blank whitespace to
        the assistant's reasoning_content.
        """
        lines = [
            "event: response.created",
            'data: {"type": "response.created", "response": {"id": "resp_1"}}',
            "event: response.reasoning_summary_part.added",
            'data: {"type": "response.reasoning_summary_part.added"}',
            "event: response.reasoning_summary_text.delta",
            'data: {"type": "response.reasoning_summary_text.delta", "delta": "**Only**\\n\\nBody."}',
            "event: response.reasoning_summary_text.done",
            'data: {"type": "response.reasoning_summary_text.done"}',
            "event: response.completed",
            'data: {"type": "response.completed", "response": {"id": "resp_1", "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}}',
        ]

        async def async_iter_lines():
            for line in lines:
                yield line

        response = MagicMock()
        response.aiter_lines = lambda: async_iter_lines()

        chunks = []
        async for chunk in handler._parse_stream(response):
            chunks.append(chunk)

        reasoning_deltas = [
            c.choices[0].delta.reasoning_content
            for c in chunks
            if c.choices and c.choices[0].delta.reasoning_content
        ]
        assert reasoning_deltas == ["**Only**\n\nBody."]

    async def test_parse_stream_skips_invalid_json(self, handler):
        """Skip lines with invalid JSON."""
        lines = [
            "event: response.created",
            'data: {"type": "response.created", "response": {"id": "resp_123"}}',
            "event: response.output_text.delta",
            "data: {invalid json}",
            "event: response.output_text.delta",
            'data: {"type": "response.output_text.delta", "delta": "Hello"}',
            "event: response.output_text.done",
            'data: {"type": "response.output_text.done"}',
            "event: response.completed",
            'data: {"type": "response.completed", "response": {"id": "resp_123", "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}}}',
        ]

        async def async_iter_lines():
            for line in lines:
                yield line

        response = MagicMock()
        response.aiter_lines = lambda: async_iter_lines()

        chunks = []
        async for chunk in handler._parse_stream(response):
            chunks.append(chunk)

        # Should skip the invalid JSON line
        assert len(chunks) == 3
        assert chunks[0].choices[0].delta.content == "Hello"

    async def test_parse_stream_stops_at_done_sentinel(self, handler):
        """Stop parsing at [DONE] sentinel."""
        lines = [
            "event: response.created",
            'data: {"type": "response.created", "response": {"id": "resp_123"}}',
            "event: response.output_text.delta",
            'data: {"type": "response.output_text.delta", "delta": "Hello"}',
            "data: [DONE]",
            "event: response.output_text.delta",
            'data: {"type": "response.output_text.delta", "delta": " world"}',
        ]

        async def async_iter_lines():
            for line in lines:
                yield line

        response = MagicMock()
        response.aiter_lines = lambda: async_iter_lines()

        chunks = []
        async for chunk in handler._parse_stream(response):
            chunks.append(chunk)

        # Should stop at [DONE], so only 1 text chunk
        assert len(chunks) == 1
        assert chunks[0].choices[0].delta.content == "Hello"

    async def test_parse_stream_multiple_tool_calls(self, handler):
        """Parse streaming response with multiple tool calls."""
        lines = [
            "event: response.created",
            'data: {"type": "response.created", "response": {"id": "resp_123"}}',
            "event: response.output_item.added",
            'data: {"type": "response.output_item.added", "item": {"id": "fc_1", "type": "function_call", "name": "tool_a"}}',
            "event: response.function_call_arguments.delta",
            'data: {"type": "response.function_call_arguments.delta", "item_id": "fc_1", "delta": "{\\"x"}',
            "event: response.output_item.added",
            'data: {"type": "response.output_item.added", "item": {"id": "fc_2", "type": "function_call", "name": "tool_b"}}',
            "event: response.function_call_arguments.delta",
            'data: {"type": "response.function_call_arguments.delta", "item_id": "fc_2", "delta": "{\\"y"}',
            "event: response.function_call_arguments.done",
            'data: {"type": "response.function_call_arguments.done", "item_id": "fc_1", "arguments": "{\\"x\\": 1}"}',
            "event: response.function_call_arguments.done",
            'data: {"type": "response.function_call_arguments.done", "item_id": "fc_2", "arguments": "{\\"y\\": 2}"}',
            "event: response.completed",
            'data: {"type": "response.completed", "response": {"id": "resp_123", "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}}}',
        ]

        async def async_iter_lines():
            for line in lines:
                yield line

        response = MagicMock()
        response.aiter_lines = lambda: async_iter_lines()

        chunks = []
        async for chunk in handler._parse_stream(response):
            chunks.append(chunk)

        # Should have 5 chunks: 2 arg deltas + 2 done + 1 usage
        assert len(chunks) == 5
        # First delta is for fc_1 (index 0)
        assert chunks[0].choices[0].delta.tool_calls[0].index == 0
        assert chunks[0].choices[0].delta.tool_calls[0].id == "fc_1"
        # Second delta is for fc_2 (index 1)
        assert chunks[1].choices[0].delta.tool_calls[0].index == 1
        assert chunks[1].choices[0].delta.tool_calls[0].id == "fc_2"


# ─────────────────────────────────────────────────────────────────────────────
# Test OpenAIProvider routing
# ─────────────────────────────────────────────────────────────────────────────


# ─────────────────────────────────────────────────────────────────────────────
# Test ResponsesHandler._parse_stream() edge cases
# ─────────────────────────────────────────────────────────────────────────────


class TestResponsesStreamingEdgeCases:
    """Test ResponsesHandler streaming parser edge cases."""

    @pytest.fixture
    def handler(self):
        """Create a ResponsesHandler instance."""
        return ResponsesHandler(
            model="gpt-5.4",
            base_url="https://api.openai.com/v1",
            headers={"Authorization": "Bearer sk-test"},
        )

    async def test_parse_stream_done_event_before_delta(self, handler):
        """Test done event arriving before any delta event for that call_id."""
        lines = [
            "event: response.created",
            'data: {"type": "response.created", "response": {"id": "resp_123"}}',
            "event: response.output_item.added",
            'data: {"type": "response.output_item.added", "item": {"id": "fc_456", "type": "function_call", "name": "get_weather"}}',
            "event: response.function_call_arguments.done",
            'data: {"type": "response.function_call_arguments.done", "item_id": "fc_456", "arguments": "{\\"city\\": \\"NYC\\"}"}',
            "event: response.completed",
            'data: {"type": "response.completed", "response": {"id": "resp_123", "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}}}',
        ]

        async def async_iter_lines():
            for line in lines:
                yield line

        response = MagicMock()
        response.aiter_lines = lambda: async_iter_lines()

        chunks = []
        async for chunk in handler._parse_stream(response):
            chunks.append(chunk)

        # Should have 2 chunks: 1 done + 1 usage
        assert len(chunks) == 2
        # The done event should create a tool call with the function name
        assert chunks[0].choices[0].delta.tool_calls is not None
        assert chunks[0].choices[0].delta.tool_calls[0].function.name == "get_weather"
        assert chunks[0].choices[0].delta.tool_calls[0].id == "fc_456"

    async def test_parse_stream_skips_lines_without_data_prefix(self, handler):
        """Test that lines without 'data: ' prefix are skipped."""
        lines = [
            "event: response.created",
            'data: {"type": "response.created", "response": {"id": "resp_123"}}',
            "some random line without data prefix",
            "event: response.output_text.delta",
            'data: {"type": "response.output_text.delta", "delta": "Hello"}',
            "event: response.output_text.done",
            'data: {"type": "response.output_text.done"}',
            "event: response.completed",
            'data: {"type": "response.completed", "response": {"id": "resp_123", "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}}}',
        ]

        async def async_iter_lines():
            for line in lines:
                yield line

        response = MagicMock()
        response.aiter_lines = lambda: async_iter_lines()

        chunks = []
        async for chunk in handler._parse_stream(response):
            chunks.append(chunk)

        # Should have 3 chunks: 1 text + 1 done + 1 usage (random line skipped)
        assert len(chunks) == 3
        assert chunks[0].choices[0].delta.content == "Hello"

    async def test_parse_stream_multiple_tool_calls_first_seen_in_done(self, handler):
        """Test multiple tool calls where one is first seen in done event."""
        lines = [
            "event: response.created",
            'data: {"type": "response.created", "response": {"id": "resp_123"}}',
            "event: response.output_item.added",
            'data: {"type": "response.output_item.added", "item": {"id": "fc_1", "type": "function_call", "name": "tool_a"}}',
            "event: response.function_call_arguments.delta",
            'data: {"type": "response.function_call_arguments.delta", "item_id": "fc_1", "delta": "{\\"x"}',
            "event: response.function_call_arguments.done",
            'data: {"type": "response.function_call_arguments.done", "item_id": "fc_1", "arguments": "{\\"x\\": 1}"}',
            "event: response.output_item.added",
            'data: {"type": "response.output_item.added", "item": {"id": "fc_2", "type": "function_call", "name": "tool_b"}}',
            "event: response.function_call_arguments.done",
            'data: {"type": "response.function_call_arguments.done", "item_id": "fc_2", "arguments": "{\\"y\\": 2}"}',
            "event: response.completed",
            'data: {"type": "response.completed", "response": {"id": "resp_123", "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}}}',
        ]

        async def async_iter_lines():
            for line in lines:
                yield line

        response = MagicMock()
        response.aiter_lines = lambda: async_iter_lines()

        chunks = []
        async for chunk in handler._parse_stream(response):
            chunks.append(chunk)

        # Should have 4 chunks: 1 delta + 2 done + 1 usage
        assert len(chunks) == 4
        # First chunk is the delta for fc_1
        assert chunks[0].choices[0].delta.tool_calls[0].index == 0
        assert chunks[0].choices[0].delta.tool_calls[0].id == "fc_1"
        # Second chunk is the done for fc_1
        assert chunks[1].choices[0].delta.tool_calls[0].index == 0
        # Third chunk is the done for fc_2 (first seen in done, so index 1)
        assert chunks[2].choices[0].delta.tool_calls[0].index == 1
        assert chunks[2].choices[0].delta.tool_calls[0].id == "fc_2"

    async def test_stream_tool_call_args_not_duplicated_on_done_event(self, handler):
        """Done event must NOT re-emit arguments when delta events were already sent.

        Regression test for the doubled-JSON bug:
        The /responses API emits both .delta chunks (partial args, streaming)
        AND a final .done event (complete args).  Before the fix, the assembler
        in streaming.py appended every arguments fragment it received, so the
        complete fn_args from .done was concatenated onto the already-full delta
        string, producing e.g. '{"path":"."}{"path":"."}' which fails
        json.loads with "Extra data: line 1 column N (char N-1)".

        After the fix, .done suppresses arguments when deltas were already
        streamed; it only emits arguments when no deltas arrived (edge case).
        """
        import json as _json

        lines = [
            "event: response.created",
            'data: {"type": "response.created", "response": {"id": "resp_123"}}',
            "event: response.output_item.added",
            'data: {"type": "response.output_item.added", "item": {"id": "fc_abc", "type": "function_call", "name": "ls"}}',
            "event: response.function_call_arguments.delta",
            'data: {"type": "response.function_call_arguments.delta", "item_id": "fc_abc", "delta": "{\\"path\\": \\".\\"}"}',
            "event: response.function_call_arguments.done",
            'data: {"type": "response.function_call_arguments.done", "item_id": "fc_abc", "arguments": "{\\"path\\": \\".\\"}"}',
            "event: response.completed",
            'data: {"type": "response.completed", "response": {"id": "resp_123", "usage": {"input_tokens": 5, "output_tokens": 3, "total_tokens": 8}}}',
        ]

        async def async_iter_lines():
            for line in lines:
                yield line

        response = MagicMock()
        response.aiter_lines = lambda: async_iter_lines()

        chunks = []
        async for chunk in handler._parse_stream(response):
            chunks.append(chunk)

        # Collect all argument fragments across all chunks for fc_abc
        assembled = ""
        for chunk in chunks:
            if not chunk.choices:
                continue
            for tc in chunk.choices[0].delta.tool_calls or []:
                if tc.function and tc.function.arguments:
                    assembled += tc.function.arguments

        # Must be valid JSON — not doubled
        parsed = _json.loads(assembled)
        assert parsed == {"path": "."}

        # The .done chunk (second chunk) must have arguments=None
        done_chunk = chunks[1]
        tc_done = done_chunk.choices[0].delta.tool_calls[0]
        assert tc_done.function.arguments is None, (
            f"done event leaked arguments={tc_done.function.arguments!r}; "
            "expected None when deltas were already emitted"
        )


# ─────────────────────────────────────────────────────────────────────────────
# Test OpenAIProvider.chat() and stream() delegation
# ─────────────────────────────────────────────────────────────────────────────
