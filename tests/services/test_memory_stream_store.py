"""Tests for app/services/memory_stream_store.py — in-memory SSE stream store.

Covers uncovered lines: 83-86, 91-92, 99-187, 194-207, 214-219, 228-231, 243-330.
"""

from __future__ import annotations

import asyncio
import json
from unittest.mock import MagicMock, patch

import pytest

from app.services import memory_stream_store as store
from app.services.memory_stream_store import _turns, _SENTINEL
from app.services.stream_envelope import StreamEnvelope


@pytest.fixture(autouse=True)
def clean_state():
    """Me clear all turns before and after each test."""
    _turns.clear()
    yield
    _turns.clear()


# ---------------------------------------------------------------------------
# init_turn
# ---------------------------------------------------------------------------


class TestInitTurn:
    @pytest.mark.asyncio
    async def test_init_turn_creates_fresh_state(self):
        await store.init_turn("sid-1")
        assert "sid-1" in _turns
        state = _turns["sid-1"]
        assert state.is_streaming is True
        assert state.content == {}
        assert state.thinking == {}
        assert state.tool_calls == []
        assert state.agent_not_configured is None

    @pytest.mark.asyncio
    async def test_init_turn_replaces_old_state(self):
        await store.init_turn("sid-1")
        _turns["sid-1"].content = {"bot": ["old data"]}
        await store.init_turn("sid-1")
        assert _turns["sid-1"].content == {}

    @pytest.mark.asyncio
    async def test_init_turn_drains_old_subscribers(self):
        """Old subscribers receive sentinel when session is reused."""
        await store.init_turn("sid-1")
        q: asyncio.Queue = asyncio.Queue()
        _turns["sid-1"].subscribers.append(q)

        await store.init_turn("sid-1")

        # Me check old subscriber got sentinel
        item = q.get_nowait()
        assert item is _SENTINEL

    @pytest.mark.asyncio
    async def test_init_turn_handles_full_subscriber_queue(self):
        """Full subscriber queue doesn't crash init_turn."""
        await store.init_turn("sid-1")
        q: asyncio.Queue = asyncio.Queue(maxsize=1)
        q.put_nowait("blocker")
        _turns["sid-1"].subscribers.append(q)

        # Me should not raise
        await store.init_turn("sid-1")

    @pytest.mark.asyncio
    async def test_init_turn_can_keep_old_subscribers(self):
        await store.init_turn("sid-1")
        q: asyncio.Queue = asyncio.Queue()
        _turns["sid-1"].subscribers.append(q)

        await store.init_turn("sid-1", keep_subscribers=True)

        assert q.empty()
        assert _turns["sid-1"].subscribers == [q]

    @pytest.mark.asyncio
    async def test_kept_subscribers_receive_next_turn_events(self):
        await store.init_turn("sid-1")
        q: asyncio.Queue = asyncio.Queue()
        _turns["sid-1"].subscribers.append(q)
        await store.init_turn("sid-1", keep_subscribers=True)

        await store.push_event(
            "sid-1",
            StreamEnvelope.from_parts(
                "agent_status",
                {"type": "agent_status", "agent": "lead", "status": "working"},
            ),
        )

        item = q.get_nowait()
        assert item["event"] == "agent_status"


# ---------------------------------------------------------------------------
# cleanup expiry
# ---------------------------------------------------------------------------


class TestCleanupExpiry:
    def test_expire_turn_rearms_then_expires_and_ignores_replaced_state(self):
        class FakeLoop:
            def __init__(self):
                self.now = 100.0
                self.calls: list[tuple[float, object, tuple[object, ...]]] = []

            def time(self) -> float:
                return self.now

            def call_later(self, delay: float, callback, *args):
                self.calls.append((delay, callback, args))
                return object()

        loop = FakeLoop()
        original_get_event_loop = store.asyncio.get_event_loop
        store.asyncio.get_event_loop = lambda: loop
        try:
            state = store._TurnState()
            state._cleanup_deadline = 120.0
            _turns["sid-1"] = state

            store._expire_turn("sid-1", state)

            assert _turns["sid-1"] is state
            assert loop.calls == [(20.0, store._expire_turn, ("sid-1", state))]

            loop.now = 120.0
            store._expire_turn("sid-1", state)
            assert "sid-1" not in _turns

            replacement = store._TurnState()
            _turns["sid-1"] = replacement
            store._expire_turn("sid-1", state)
            assert _turns["sid-1"] is replacement
            assert len(loop.calls) == 1
        finally:
            store.asyncio.get_event_loop = original_get_event_loop


# ---------------------------------------------------------------------------
# push_event
# ---------------------------------------------------------------------------


class TestPushEvent:
    @pytest.mark.asyncio
    async def test_pushes_refresh_ttl_without_rescheduling_each_delta(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        scheduled = MagicMock(wraps=store._schedule_cleanup)
        monkeypatch.setattr(store, "_schedule_cleanup", scheduled)
        await store.init_turn("sid-1")

        for text in ("a", "b", "c"):
            await store.push_event(
                "sid-1",
                StreamEnvelope.from_parts("message", {"agent": "bot", "text": text}),
            )

        assert scheduled.call_count == 1

    @pytest.mark.asyncio
    async def test_push_without_subscribers_skips_wire_serialization(self):
        await store.init_turn("sid-1")
        envelope = StreamEnvelope.from_parts(
            "message", {"agent": "bot", "text": "hello"}
        )

        with patch.object(StreamEnvelope, "to_wire", autospec=True) as to_wire:
            await store.push_event("sid-1", envelope)

        to_wire.assert_not_called()
        assert _turns["sid-1"].content == {"bot": ["hello"]}

    @pytest.mark.asyncio
    async def test_push_noop_when_no_state(self):
        """Push to unknown session is silently ignored."""
        await store.push_event("unknown", StreamEnvelope.from_parts("message", {}))

    @pytest.mark.asyncio
    async def test_push_message_stores_single_content_chunk(self):
        await store.init_turn("sid-1")
        await store.push_event(
            "sid-1",
            StreamEnvelope.from_parts("message", {"agent": "bot", "text": "hello"}),
        )
        assert _turns["sid-1"].content == {"bot": ["hello"]}

    @pytest.mark.asyncio
    async def test_push_message_stores_content_as_chunks(self):
        await store.init_turn("sid-1")
        await store.push_event(
            "sid-1",
            StreamEnvelope.from_parts("message", {"agent": "bot", "text": "hel"}),
        )
        await store.push_event(
            "sid-1",
            StreamEnvelope.from_parts("message", {"agent": "bot", "text": "lo"}),
        )
        assert _turns["sid-1"].content == {"bot": ["hel", "lo"]}

    @pytest.mark.asyncio
    async def test_push_thinking_stores_thinking_as_chunks(self):
        await store.init_turn("sid-1")
        await store.push_event(
            "sid-1",
            StreamEnvelope.from_parts("thinking", {"agent": "bot", "text": "step"}),
        )
        await store.push_event(
            "sid-1",
            StreamEnvelope.from_parts("thinking", {"agent": "bot", "text": " one"}),
        )
        assert _turns["sid-1"].thinking == {"bot": ["step", " one"]}

        async def _mark_done():
            await asyncio.sleep(0.05)
            await store.mark_done("sid-1")

        task = asyncio.create_task(_mark_done())
        events = [event async for event in store.attach("sid-1")]
        await task
        thinking = [event for event in events if event["event"] == "thinking"]
        assert json.loads(thinking[0]["data"])["text"] == "step one"

    @pytest.mark.asyncio
    async def test_push_message_separates_agents(self):
        """Per-agent buckets — concurrent streams don't mix (regression for the
        mid-stream refresh bug where replay used agent='' and no UI panel
        rendered the accumulated text)."""
        await store.init_turn("sid-1")
        await store.push_event(
            "sid-1",
            StreamEnvelope.from_parts(
                "message", {"agent": "lead", "text": "hi from lead"}
            ),
        )
        await store.push_event(
            "sid-1",
            StreamEnvelope.from_parts(
                "message", {"agent": "worker", "text": "hi from worker"}
            ),
        )
        assert _turns["sid-1"].content == {
            "lead": ["hi from lead"],
            "worker": ["hi from worker"],
        }

    @pytest.mark.asyncio
    async def test_push_agent_not_configured_is_replayed(self):
        await store.init_turn("sid-1")
        await store.push_event(
            "sid-1",
            StreamEnvelope.from_parts(
                "agent_not_configured",
                {
                    "type": "agent_not_configured",
                    "agent": "openagentd",
                    "message": "Agent needs a model.",
                    "action": {"type": "open_settings", "tab": "providers"},
                },
            ),
        )

        events = []
        async for event in store.attach("sid-1"):
            events.append(event)
            break

        assert events[0]["event"] == "agent_not_configured"
        data = json.loads(events[0]["data"])
        assert data["agent"] == "openagentd"
        assert data["action"]["tab"] == "providers"

    @pytest.mark.asyncio
    async def test_push_thinking_stores_single_thinking_chunk(self):
        await store.init_turn("sid-1")
        await store.push_event(
            "sid-1",
            StreamEnvelope.from_parts("thinking", {"agent": "bot", "text": "step1"}),
        )
        assert _turns["sid-1"].thinking == {"bot": ["step1"]}

    @pytest.mark.asyncio
    async def test_push_tool_call_adds_entry(self):
        await store.init_turn("sid-1")
        await store.push_event(
            "sid-1",
            StreamEnvelope.from_parts(
                "tool_call",
                {
                    "tool_call_id": "tc1",
                    "name": "search",
                    "label": "web search",
                    "agent": "bot",
                },
            ),
        )
        tools = _turns["sid-1"].tool_calls
        assert len(tools) == 1
        assert tools[0]["name"] == "search"
        assert tools[0]["started"] is False
        assert tools[0]["done"] is False

    @pytest.mark.asyncio
    async def test_push_tool_start_marks_started_by_id(self):
        await store.init_turn("sid-1")
        _turns["sid-1"].tool_calls = [
            {
                "tool_call_id": "tc1",
                "name": "search",
                "label": "search",
                "arguments": None,
                "agent": "",
                "started": False,
                "done": False,
            }
        ]
        await store.push_event(
            "sid-1",
            StreamEnvelope.from_parts(
                "tool_start",
                {
                    "tool_call_id": "tc1",
                    "name": "search",
                    "arguments": '{"q":"test"}',
                },
            ),
        )
        assert _turns["sid-1"].tool_calls[0]["started"] is True
        assert _turns["sid-1"].tool_calls[0]["arguments"] == '{"q":"test"}'

    @pytest.mark.asyncio
    async def test_push_tool_start_fallback_by_name(self):
        """tool_start without tool_call_id falls back to name match."""
        await store.init_turn("sid-1")
        _turns["sid-1"].tool_calls = [
            {
                "tool_call_id": None,
                "name": "search",
                "label": "search",
                "arguments": None,
                "agent": "",
                "started": False,
                "done": False,
            }
        ]
        await store.push_event(
            "sid-1",
            StreamEnvelope.from_parts(
                "tool_start", {"name": "search", "arguments": "{}"}
            ),
        )
        assert _turns["sid-1"].tool_calls[0]["started"] is True

    @pytest.mark.asyncio
    async def test_push_tool_end_marks_done_by_id(self):
        await store.init_turn("sid-1")
        _turns["sid-1"].tool_calls = [
            {
                "tool_call_id": "tc1",
                "name": "search",
                "label": "search",
                "arguments": "{}",
                "agent": "",
                "started": True,
                "done": False,
            }
        ]
        await store.push_event(
            "sid-1",
            StreamEnvelope.from_parts(
                "tool_end",
                {"tool_call_id": "tc1", "name": "search", "result": "found it"},
            ),
        )
        assert _turns["sid-1"].tool_calls[0]["done"] is True
        assert _turns["sid-1"].tool_calls[0]["result"] == "found it"

    @pytest.mark.asyncio
    async def test_push_tool_end_fallback_by_name(self):
        """tool_end without matching tool_call_id falls back to name match."""
        await store.init_turn("sid-1")
        _turns["sid-1"].tool_calls = [
            {
                "tool_call_id": "other",
                "name": "search",
                "label": "search",
                "arguments": "{}",
                "agent": "",
                "started": True,
                "done": False,
            }
        ]
        await store.push_event(
            "sid-1",
            StreamEnvelope.from_parts(
                "tool_end", {"name": "search", "result": "fallback"}
            ),
        )
        assert _turns["sid-1"].tool_calls[0]["done"] is True

    @pytest.mark.asyncio
    async def test_push_usage_sets_usage(self):
        await store.init_turn("sid-1")
        await store.push_event(
            "sid-1",
            StreamEnvelope.from_parts(
                "usage",
                {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            ),
        )
        assert _turns["sid-1"].usage is not None
        assert _turns["sid-1"].usage["total_tokens"] == 15

    @pytest.mark.asyncio
    async def test_push_error_sets_error(self):
        await store.init_turn("sid-1")
        await store.push_event(
            "sid-1",
            StreamEnvelope.from_parts("error", {"message": "something bad"}),
        )
        assert _turns["sid-1"].error == "something bad"

    @pytest.mark.asyncio
    async def test_push_fans_out_to_subscribers(self):
        await store.init_turn("sid-1")
        q: asyncio.Queue = asyncio.Queue()
        _turns["sid-1"].subscribers.append(q)

        await store.push_event(
            "sid-1",
            StreamEnvelope.from_parts("message", {"text": "hi"}),
        )

        item = q.get_nowait()
        assert item["event"] == "message"

    @pytest.mark.asyncio
    async def test_push_removes_dead_subscriber(self):
        """Full subscriber queue is removed from subscriber list and receives
        a sentinel so its consumer can exit cleanly instead of blocking forever."""
        await store.init_turn("sid-1")
        dead_q: asyncio.Queue = asyncio.Queue(maxsize=1)
        dead_q.put_nowait("blocker")
        _turns["sid-1"].subscribers.append(dead_q)

        await store.push_event(
            "sid-1",
            StreamEnvelope.from_parts("message", {"text": "hi"}),
        )
        assert dead_q not in _turns["sid-1"].subscribers
        # Me the dropped queue must now carry a sentinel so the consumer
        # unblocks and the SSE client can close + reload from DB. The original
        # "blocker" item was drained to make room — that's acceptable because
        # a stalled queue was already losing events.
        remaining: list = []
        while not dead_q.empty():
            remaining.append(dead_q.get_nowait())
        assert _SENTINEL in remaining, (
            "dropped queue must receive sentinel to unblock its consumer"
        )

    @pytest.mark.asyncio
    async def test_push_sentinel_unblocks_attach_when_subscriber_dropped(self):
        """Regression for the "tool_call stuck executing" bug: when a subscriber
        queue fills up, the attach() generator must still terminate so the SSE
        endpoint yields `onDone` to the client (which then reloads from DB).

        Before the fix: QueueFull silently removed the queue, attach() blocked
        forever on q.get(), the client hung and the UI showed perpetual
        "executing" state until manual refresh.
        """
        await store.init_turn("sid-1")

        # Me simulate a stalled consumer — maxsize=1 queue with a blocker.
        # Register it manually so we control the exact queue attach() uses.
        stalled_q: asyncio.Queue = asyncio.Queue(maxsize=1)
        stalled_q.put_nowait({"event": "stale", "data": "{}"})
        _turns["sid-1"].subscribers.append(stalled_q)

        # Producer fires a new event — queue is full, triggers the drop path.
        await store.push_event(
            "sid-1",
            StreamEnvelope.from_parts("tool_end", {"result": "ok"}),
        )

        # Me consumer drains whatever is there — must see a sentinel so it
        # can exit its loop. Without the fix, the consumer would block forever
        # waiting for `done`.
        drained: list = []
        while not stalled_q.empty():
            drained.append(stalled_q.get_nowait())
        assert _SENTINEL in drained

    @pytest.mark.asyncio
    async def test_push_unknown_event_type(self):
        """Unknown event types are published to subscribers but don't update state."""
        await store.init_turn("sid-1")
        q: asyncio.Queue = asyncio.Queue()
        _turns["sid-1"].subscribers.append(q)

        await store.push_event(
            "sid-1",
            StreamEnvelope.from_parts("custom_event", {"foo": "bar"}),
        )
        # Me content not changed
        assert _turns["sid-1"].content == {}
        # Me subscriber still got it
        item = q.get_nowait()
        assert item["event"] == "custom_event"

    @pytest.mark.asyncio
    async def test_push_inbox_fanout_to_subscribers(self):
        await store.init_turn("sid-1")
        q: asyncio.Queue = asyncio.Queue()
        _turns["sid-1"].subscribers.append(q)

        await store.push_event(
            "sid-1",
            StreamEnvelope.from_parts(
                "inbox",
                {
                    "agent": "researcher",
                    "content": "hello",
                    "from_agent": "planner",
                },
            ),
        )
        item = q.get_nowait()
        assert item["event"] == "inbox"
        data = json.loads(item["data"])
        assert data["agent"] == "researcher"

    @pytest.mark.asyncio
    async def test_push_agent_status_records_latest(self):
        """agent_status events are tracked so replay can restore the composer's
        working indicator after reconnect mid-turn."""
        await store.init_turn("sid-1")
        await store.push_event(
            "sid-1",
            StreamEnvelope.from_parts(
                "agent_status", {"agent": "lead", "status": "working"}
            ),
        )
        await store.push_event(
            "sid-1",
            StreamEnvelope.from_parts(
                "agent_status", {"agent": "worker", "status": "working"}
            ),
        )
        # Latest value wins — lead flips to idle while worker stays working.
        await store.push_event(
            "sid-1",
            StreamEnvelope.from_parts(
                "agent_status", {"agent": "lead", "status": "idle"}
            ),
        )
        assert _turns["sid-1"].agent_statuses == {
            "lead": "idle",
            "worker": "working",
        }

    @pytest.mark.asyncio
    async def test_push_agent_status_ignores_empty_agent_or_status(self):
        await store.init_turn("sid-1")
        await store.push_event(
            "sid-1",
            StreamEnvelope.from_parts(
                "agent_status", {"agent": "", "status": "working"}
            ),
        )
        await store.push_event(
            "sid-1",
            StreamEnvelope.from_parts("agent_status", {"agent": "lead", "status": ""}),
        )
        assert _turns["sid-1"].agent_statuses == {}


# ---------------------------------------------------------------------------
# commit_agent_content
# ---------------------------------------------------------------------------


class TestCommitAgentContent:
    @pytest.mark.asyncio
    async def test_commit_drops_content_for_agent(self):
        """commit_agent_content removes only the named agent's content bucket."""
        await store.init_turn("sid-1")
        _turns["sid-1"].content["alice"] = ["hello from alice"]
        _turns["sid-1"].content["bob"] = ["hello from bob"]

        await store.commit_agent_content("sid-1", "alice")

        assert "alice" not in _turns["sid-1"].content
        assert _turns["sid-1"].content["bob"] == ["hello from bob"]

    @pytest.mark.asyncio
    async def test_commit_drops_thinking_for_agent(self):
        """commit_agent_content removes only the named agent's thinking bucket."""
        await store.init_turn("sid-1")
        _turns["sid-1"].thinking["alice"] = ["reasoning..."]
        _turns["sid-1"].thinking["bob"] = ["bob reasoning"]

        await store.commit_agent_content("sid-1", "alice")

        assert "alice" not in _turns["sid-1"].thinking
        assert _turns["sid-1"].thinking["bob"] == ["bob reasoning"]

    @pytest.mark.asyncio
    async def test_commit_drops_tool_calls_owned_by_agent(self):
        """commit_agent_content filters tool_calls by the ``agent`` field."""
        await store.init_turn("sid-1")
        _turns["sid-1"].tool_calls = [
            {"tool_call_id": "t1", "name": "send", "agent": "alice", "done": True},
            {"tool_call_id": "t2", "name": "send", "agent": "bob", "done": True},
            {"tool_call_id": "t3", "name": "read", "agent": "alice", "done": False},
        ]

        await store.commit_agent_content("sid-1", "alice")

        remaining = _turns["sid-1"].tool_calls
        assert len(remaining) == 1
        assert remaining[0]["tool_call_id"] == "t2"
        assert remaining[0]["agent"] == "bob"

    @pytest.mark.asyncio
    async def test_commit_idempotent_when_agent_missing(self):
        """Calling commit for an agent with no buffered content is a no-op."""
        await store.init_turn("sid-1")
        await store.commit_agent_content("sid-1", "ghost")  # Me should not raise
        assert _turns["sid-1"].content == {}
        assert _turns["sid-1"].thinking == {}
        assert _turns["sid-1"].tool_calls == []

    @pytest.mark.asyncio
    async def test_commit_noop_when_no_state(self):
        """commit on unknown session is silently ignored."""
        await store.commit_agent_content("unknown", "alice")  # Me should not raise

    @pytest.mark.asyncio
    async def test_attach_after_commit_does_not_replay_content(self):
        """Reconnect after commit must not re-emit the persisted text or tools."""
        await store.init_turn("sid-1")
        _turns["sid-1"].content["alice"] = ["persisted content"]
        _turns["sid-1"].thinking["alice"] = ["persisted thinking"]
        _turns["sid-1"].tool_calls = [
            {
                "tool_call_id": "t1",
                "name": "send",
                "agent": "alice",
                "started": True,
                "done": True,
                "arguments": "{}",
                "result": "ok",
            },
        ]

        await store.commit_agent_content("sid-1", "alice")

        events = []

        async def collect():
            async for ev in store.attach("sid-1"):
                events.append(ev)

        task = asyncio.create_task(collect())
        await asyncio.sleep(0.05)
        await store.mark_done("sid-1")
        await task

        # Me no replayed message/thinking/tool events for alice
        for ev in events:
            data = json.loads(ev["data"])
            assert not (ev["event"] == "message" and data.get("text"))
            assert not (ev["event"] == "thinking" and data.get("text"))
            assert ev["event"] not in {"tool_call", "tool_start", "tool_end"}

    @pytest.mark.asyncio
    async def test_commit_tool_calls_without_agent_field_preserved(self):
        """Tool calls with no 'agent' field are NOT dropped."""
        await store.init_turn("sid-1")
        _turns["sid-1"].tool_calls = [
            {"tool_call_id": "t1", "name": "send"},  # Me no agent field
            {"tool_call_id": "t2", "name": "read", "agent": "alice"},
        ]

        await store.commit_agent_content("sid-1", "alice")

        remaining = _turns["sid-1"].tool_calls
        assert len(remaining) == 1
        assert remaining[0]["tool_call_id"] == "t1"
        assert "agent" not in remaining[0]

    @pytest.mark.asyncio
    async def test_commit_concurrent_agents_dont_interfere(self):
        """Concurrent commits for different agents on same session don't interfere."""
        await store.init_turn("sid-1")
        _turns["sid-1"].content = {"alice": ["alice text"], "bob": ["bob text"]}
        _turns["sid-1"].thinking = {"alice": ["alice think"], "bob": ["bob think"]}
        _turns["sid-1"].tool_calls = [
            {"tool_call_id": "t1", "agent": "alice"},
            {"tool_call_id": "t2", "agent": "bob"},
            {"tool_call_id": "t3", "agent": "alice"},
        ]

        # Me commit both agents concurrently
        await asyncio.gather(
            store.commit_agent_content("sid-1", "alice"),
            store.commit_agent_content("sid-1", "bob"),
        )

        # Me both should be gone
        assert _turns["sid-1"].content == {}
        assert _turns["sid-1"].thinking == {}
        assert _turns["sid-1"].tool_calls == []


# ---------------------------------------------------------------------------
# mark_done
# ---------------------------------------------------------------------------


class TestMarkDone:
    @pytest.mark.asyncio
    async def test_mark_done_flips_is_streaming(self):
        await store.init_turn("sid-1")
        await store.mark_done("sid-1")
        assert _turns["sid-1"].is_streaming is False

    @pytest.mark.asyncio
    async def test_mark_done_sends_sentinel_to_subscribers(self):
        await store.init_turn("sid-1")
        q: asyncio.Queue = asyncio.Queue()
        _turns["sid-1"].subscribers.append(q)

        await store.mark_done("sid-1")
        item = q.get_nowait()
        assert item is _SENTINEL

    @pytest.mark.asyncio
    async def test_mark_done_noop_when_no_state(self):
        """mark_done on unknown session is silently ignored."""
        await store.mark_done("unknown")  # Me should not raise

    @pytest.mark.asyncio
    async def test_mark_done_handles_full_subscriber_queue(self):
        """Full subscriber queue doesn't crash mark_done."""
        await store.init_turn("sid-1")
        q: asyncio.Queue = asyncio.Queue(maxsize=1)
        q.put_nowait("blocker")
        _turns["sid-1"].subscribers.append(q)

        await store.mark_done("sid-1")  # Me should not raise


# ---------------------------------------------------------------------------
# clear
# ---------------------------------------------------------------------------


class TestClear:
    @pytest.mark.asyncio
    async def test_clear_removes_state(self):
        await store.init_turn("sid-1")
        await store.clear("sid-1")
        assert "sid-1" not in _turns

    @pytest.mark.asyncio
    async def test_clear_unblocks_full_subscriber_queue(self):
        await store.init_turn("sid-1")
        queue: asyncio.Queue = asyncio.Queue(maxsize=1)
        queue.put_nowait("stale event")
        _turns["sid-1"].subscribers.append(queue)

        await store.clear("sid-1")

        assert queue.get_nowait() is _SENTINEL

    @pytest.mark.asyncio
    async def test_clear_noop_when_no_state(self):
        await store.clear("unknown")  # Me should not raise


# ---------------------------------------------------------------------------
# is_done
# ---------------------------------------------------------------------------


class TestIsDone:
    @pytest.mark.asyncio
    async def test_is_done_true_when_no_state(self):
        result = await store.is_done("unknown")
        assert result is True

    @pytest.mark.asyncio
    async def test_is_done_false_when_streaming(self):
        await store.init_turn("sid-1")
        result = await store.is_done("sid-1")
        assert result is False

    @pytest.mark.asyncio
    async def test_is_done_true_after_mark_done(self):
        await store.init_turn("sid-1")
        await store.mark_done("sid-1")
        result = await store.is_done("sid-1")
        assert result is True


# ---------------------------------------------------------------------------
# attach — replay and live events
# ---------------------------------------------------------------------------


class TestAttach:
    @pytest.mark.asyncio
    async def test_attach_returns_nothing_when_no_state(self):
        events = [e async for e in store.attach("unknown")]
        assert events == []

    @pytest.mark.asyncio
    async def test_attach_returns_nothing_when_already_done(self):
        await store.init_turn("sid-1")
        _turns["sid-1"].is_streaming = False
        events = [e async for e in store.attach("sid-1")]
        assert events == []

    @pytest.mark.asyncio
    async def test_attach_replays_content_as_message(self):
        await store.init_turn("sid-1")
        _turns["sid-1"].content = {"bot": ["hello ", "world"]}

        # Me mark done after a short delay so attach exits
        async def _mark_done():
            await asyncio.sleep(0.05)
            await store.mark_done("sid-1")

        task = asyncio.create_task(_mark_done())
        events = [e async for e in store.attach("sid-1")]
        await task

        msg_events = [e for e in events if e.get("event") == "message"]
        assert len(msg_events) == 1
        payload = json.loads(msg_events[0]["data"])
        assert "hello world" in payload["text"]
        # Regression: replayed event MUST carry the real agent name so the
        # frontend routes it into the correct panel — agent="" would hit a
        # phantom bucket that no UI panel renders.
        assert payload["agent"] == "bot"

    @pytest.mark.asyncio
    async def test_attach_replays_content_per_agent(self):
        """Multi-agent turn: each agent's accumulated text replays separately."""
        await store.init_turn("sid-1")
        _turns["sid-1"].content = {
            "lead": ["lead text"],
            "worker": ["worker text"],
        }

        async def _mark_done():
            await asyncio.sleep(0.05)
            await store.mark_done("sid-1")

        task = asyncio.create_task(_mark_done())
        events = [e async for e in store.attach("sid-1")]
        await task

        msg_events = [e for e in events if e.get("event") == "message"]
        assert len(msg_events) == 2
        by_agent = {
            json.loads(e["data"])["agent"]: json.loads(e["data"])["text"]
            for e in msg_events
        }
        assert by_agent == {"lead": "lead text", "worker": "worker text"}

    @pytest.mark.asyncio
    async def test_attach_replays_thinking(self):
        await store.init_turn("sid-1")
        _turns["sid-1"].thinking = {"bot": ["my ", "reasoning"]}

        async def _mark_done():
            await asyncio.sleep(0.05)
            await store.mark_done("sid-1")

        task = asyncio.create_task(_mark_done())
        events = [e async for e in store.attach("sid-1")]
        await task

        thinking = [e for e in events if e.get("event") == "thinking"]
        assert len(thinking) == 1
        assert json.loads(thinking[0]["data"])["agent"] == "bot"

    @pytest.mark.asyncio
    async def test_attach_replays_tool_lifecycle(self):
        await store.init_turn("sid-1")
        _turns["sid-1"].tool_calls = [
            {
                "tool_call_id": "tc1",
                "name": "search",
                "label": "web search",
                "arguments": '{"q":"x"}',
                "agent": "bot",
                "started": True,
                "done": True,
                "result": "found it",
            }
        ]

        async def _mark_done():
            await asyncio.sleep(0.05)
            await store.mark_done("sid-1")

        task = asyncio.create_task(_mark_done())
        events = [e async for e in store.attach("sid-1")]
        await task

        types = [e["event"] for e in events]
        assert "tool_call" in types
        assert "tool_start" in types
        assert "tool_end" in types

    @pytest.mark.asyncio
    async def test_attach_replays_tool_not_started_not_done(self):
        """Tool that hasn't started/finished only emits tool_call."""
        await store.init_turn("sid-1")
        _turns["sid-1"].tool_calls = [
            {
                "tool_call_id": "tc1",
                "name": "search",
                "label": "search",
                "agent": "",
                "started": False,
                "done": False,
            }
        ]

        async def _mark_done():
            await asyncio.sleep(0.05)
            await store.mark_done("sid-1")

        task = asyncio.create_task(_mark_done())
        events = [e async for e in store.attach("sid-1")]
        await task

        types = [e["event"] for e in events]
        assert "tool_call" in types
        assert "tool_start" not in types
        assert "tool_end" not in types

    @pytest.mark.asyncio
    async def test_attach_yields_live_events(self):
        await store.init_turn("sid-1")

        async def _push_and_done():
            await asyncio.sleep(0.05)
            await store.push_event(
                "sid-1",
                StreamEnvelope.from_parts("message", {"text": "live!"}),
            )
            await asyncio.sleep(0.05)
            await store.mark_done("sid-1")

        task = asyncio.create_task(_push_and_done())
        events = [e async for e in store.attach("sid-1")]
        await task

        assert any(e.get("event") == "message" for e in events)

    @pytest.mark.asyncio
    async def test_attach_cleans_up_subscriber_on_exit(self):
        """Subscriber queue is removed from state when attach exits."""
        await store.init_turn("sid-1")

        async def _mark_done():
            await asyncio.sleep(0.05)
            await store.mark_done("sid-1")

        task = asyncio.create_task(_mark_done())
        _ = [e async for e in store.attach("sid-1")]
        await task

        assert len(_turns["sid-1"].subscribers) == 0

    @pytest.mark.asyncio
    async def test_attach_subscriber_already_removed_no_crash(self):
        """Lines 313-317: subscriber removed from state.subscribers before generator exits — no crash.

        Simulates the race where another coroutine removes the queue from
        state.subscribers before the finally block runs.
        """
        await store.init_turn("sid-1")

        events_collected = []

        async def _consume_and_remove():
            """Me consume attach generator but remove queue mid-flight."""
            gen = store.attach("sid-1")
            # Me start the generator — it registers the queue
            try:
                async for event in gen:
                    events_collected.append(event)
                    # Me after first event, manually remove all subscribers
                    # so the finally block hits ValueError
                    if _turns.get("sid-1"):
                        _turns["sid-1"].subscribers.clear()
                    break
            finally:
                await gen.aclose()

        # Me push one event then mark done so generator can exit
        async def _push_and_done():
            await asyncio.sleep(0.02)
            await store.push_event(
                "sid-1",
                StreamEnvelope.from_parts("message", {"text": "hi"}),
            )
            await asyncio.sleep(0.02)
            await store.mark_done("sid-1")

        task = asyncio.create_task(_push_and_done())
        await _consume_and_remove()
        await task  # Me should not raise

    @pytest.mark.asyncio
    async def test_attach_replays_agent_statuses_before_content(self):
        """agent_status must replay BEFORE thinking/message so the composer
        flips isTeamWorking=true before any content arrives. Without this the
        stop button stays hidden on reconnect even while tokens stream in."""
        await store.init_turn("sid-1")
        _turns["sid-1"].agent_statuses = {
            "lead": "working",
            "worker": "idle",
            "executor#1": "offline",
        }
        _turns["sid-1"].content = {"lead": ["partial ", "reply"]}

        async def _mark_done():
            await asyncio.sleep(0.05)
            await store.mark_done("sid-1")

        task = asyncio.create_task(_mark_done())
        events = [e async for e in store.attach("sid-1")]
        await task

        types = [e["event"] for e in events]
        status_events = [e for e in events if e.get("event") == "agent_status"]
        assert len(status_events) == 3
        by_agent = {
            json.loads(e["data"])["agent"]: json.loads(e["data"])["status"]
            for e in status_events
        }
        assert by_agent == {
            "lead": "working",
            "worker": "idle",
            "executor#1": "offline",
        }
        # Status must precede the message so the UI flips before rendering text.
        first_status_idx = types.index("agent_status")
        first_message_idx = types.index("message")
        assert first_status_idx < first_message_idx

    @pytest.mark.asyncio
    async def test_attach_skips_invalid_agent_status(self):
        """Unknown status strings are silently skipped on replay (defensive —
        the event payload is validated at push time but the dict is plain)."""
        await store.init_turn("sid-1")
        _turns["sid-1"].agent_statuses = {"lead": "bogus", "": "working"}

        async def _mark_done():
            await asyncio.sleep(0.05)
            await store.mark_done("sid-1")

        task = asyncio.create_task(_mark_done())
        events = [e async for e in store.attach("sid-1")]
        await task

        status_events = [e for e in events if e.get("event") == "agent_status"]
        assert status_events == []


# ---------------------------------------------------------------------------
# summarization (start/content/end) push + replay
# ---------------------------------------------------------------------------


class TestSummarizationPushAndReplay:
    @pytest.mark.asyncio
    async def test_start_initialises_per_agent_entry(self):
        await store.init_turn("sid-1")
        await store.push_event(
            "sid-1",
            StreamEnvelope.from_parts("summarization_start", {"agent": "lead"}),
        )
        assert _turns["sid-1"].summarization == {
            "lead": {"text": "", "done": False, "error": False}
        }

    @pytest.mark.asyncio
    async def test_content_appends_text(self):
        await store.init_turn("sid-1")
        await store.push_event(
            "sid-1",
            StreamEnvelope.from_parts("summarization_start", {"agent": "lead"}),
        )
        await store.push_event(
            "sid-1",
            StreamEnvelope.from_parts(
                "summarization_content", {"agent": "lead", "text": "Hello "}
            ),
        )
        await store.push_event(
            "sid-1",
            StreamEnvelope.from_parts(
                "summarization_content", {"agent": "lead", "text": "world."}
            ),
        )
        assert _turns["sid-1"].summarization["lead"]["text"] == "Hello world."

    @pytest.mark.asyncio
    async def test_end_marks_done_and_overrides_text(self):
        await store.init_turn("sid-1")
        await store.push_event(
            "sid-1",
            StreamEnvelope.from_parts("summarization_start", {"agent": "lead"}),
        )
        await store.push_event(
            "sid-1",
            StreamEnvelope.from_parts(
                "summarization_content", {"agent": "lead", "text": "partial"}
            ),
        )
        await store.push_event(
            "sid-1",
            StreamEnvelope.from_parts(
                "summarization_end",
                {"agent": "lead", "summary": "final summary"},
            ),
        )
        entry = _turns["sid-1"].summarization["lead"]
        assert entry["done"] is True
        assert entry["error"] is False
        assert entry["text"] == "final summary"

    @pytest.mark.asyncio
    async def test_end_error_flag_is_recorded(self):
        await store.init_turn("sid-1")
        await store.push_event(
            "sid-1",
            StreamEnvelope.from_parts(
                "summarization_end",
                {
                    "agent": "lead",
                    "summary": "",
                    "metadata": {"error": True},
                },
            ),
        )
        entry = _turns["sid-1"].summarization["lead"]
        assert entry["done"] is True
        assert entry["error"] is True

    @pytest.mark.asyncio
    async def test_attach_replays_in_flight_compaction(self):
        """Reconnect mid-compaction: start + content (no end yet)."""
        await store.init_turn("sid-1")
        _turns["sid-1"].summarization = {
            "lead": {"text": "half summary", "done": False, "error": False}
        }

        async def _mark_done():
            await asyncio.sleep(0.05)
            await store.mark_done("sid-1")

        task = asyncio.create_task(_mark_done())
        events = [e async for e in store.attach("sid-1")]
        await task

        types = [e["event"] for e in events]
        assert "summarization_start" in types
        assert "summarization_content" in types
        assert "summarization_end" not in types
        content = next(e for e in events if e["event"] == "summarization_content")
        assert json.loads(content["data"])["text"] == "half summary"

    @pytest.mark.asyncio
    async def test_attach_replays_completed_compaction(self):
        """Reconnect after compaction finished: start + end (no live content)."""
        await store.init_turn("sid-1")
        _turns["sid-1"].summarization = {
            "lead": {"text": "the final summary", "done": True, "error": False}
        }

        async def _mark_done():
            await asyncio.sleep(0.05)
            await store.mark_done("sid-1")

        task = asyncio.create_task(_mark_done())
        events = [e async for e in store.attach("sid-1")]
        await task

        types = [e["event"] for e in events]
        assert "summarization_start" in types
        # No live content replay when already done — end carries the full text.
        assert "summarization_content" not in types
        end = next(e for e in events if e["event"] == "summarization_end")
        end_data = json.loads(end["data"])
        assert end_data["summary"] == "the final summary"
        assert end_data.get("metadata", {}).get("error") is not True

    @pytest.mark.asyncio
    async def test_attach_replays_failed_compaction_with_error_flag(self):
        await store.init_turn("sid-1")
        _turns["sid-1"].summarization = {
            "lead": {"text": "", "done": True, "error": True}
        }

        async def _mark_done():
            await asyncio.sleep(0.05)
            await store.mark_done("sid-1")

        task = asyncio.create_task(_mark_done())
        events = [e async for e in store.attach("sid-1")]
        await task

        end = next(e for e in events if e["event"] == "summarization_end")
        assert json.loads(end["data"])["metadata"]["error"] is True


# ---------------------------------------------------------------------------
# close
# ---------------------------------------------------------------------------


class TestClose:
    @pytest.mark.asyncio
    async def test_close_clears_all_state(self):
        await store.init_turn("sid-1")
        await store.init_turn("sid-2")
        await store.close()
        assert len(_turns) == 0
