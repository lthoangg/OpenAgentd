"""Tests for on-demand activation and reactivation of a session runtime.

Covers:
- _maybe_activate() spawning tasks
- State transitions (idle -> working -> idle/error)
- Spurious activation handling
- Cancel event clearing
- Reactivation after errors
- Late-inbox reactivation (message arrives while agent.run() is executing)
- No premature done event on late-inbox reactivation
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid7

import pytest_asyncio

from app.agent.agent_loop import Agent
from app.agent.mode.team.mailbox import Message
from app.agent.mode.team.runtime import SessionRuntime
from tests.agent.mode.team.conftest import MockTeamProvider


async def _drain_activation(agent, *, timeout: float = 2.0) -> None:
    """Wait until the agent's pending activation task completes.

    Replaces fixed ``await asyncio.sleep(0.1)`` calls with a deterministic
    sync point.  Yields the event loop once first so the on_message callback
    has a chance to spawn ``_active_task``.
    """
    # Let the delivery chain run (deliver → _maybe_activate →
    # asyncio.create_task).
    for _ in range(5):
        await asyncio.sleep(0)
        if agent._active_task is not None and not agent._active_task.done():
            break

    task = agent._active_task
    if task is None or task.done():
        return
    try:
        await asyncio.wait_for(asyncio.shield(task), timeout=timeout)
    except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
        pass


def _make_mock_db_factory():
    """Create a mock async session factory that returns a mock db session."""
    mock_db = MagicMock()
    mock_db.commit = AsyncMock()
    mock_db.flush = AsyncMock()
    mock_db.refresh = AsyncMock()
    mock_db.get = AsyncMock(return_value=None)
    mock_db.exec = AsyncMock(
        return_value=MagicMock(
            all=MagicMock(return_value=[]), first=MagicMock(return_value=None)
        )
    )
    mock_db.add = MagicMock()

    @asynccontextmanager
    async def factory():
        yield mock_db

    return factory


@pytest_asyncio.fixture
async def runtime():
    """Override the shared fixture: this module needs a mocked DB factory.

    Activation drains the inbox straight into ``_persist_inbox``, so every test
    here goes through the DB layer.
    """
    return SessionRuntime(
        Agent(name="openagentd", llm_provider=MockTeamProvider("agent response")),
        db_factory=_make_mock_db_factory(),
    )


class TestInterrupt:
    async def test_interrupt_cancels_active_activation_task(self, runtime):
        started = asyncio.Event()
        cancelled = asyncio.Event()

        async def active_turn():
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        runtime.state = "working"
        runtime._active_task = asyncio.create_task(active_turn())
        await started.wait()

        runtime.interrupt()
        await asyncio.wait_for(
            asyncio.gather(runtime._active_task, return_exceptions=True), timeout=0.1
        )

        assert cancelled.is_set()
        assert runtime._active_task.cancelled()


class TestOnDemandActivation:
    """Test on-demand activation — agents activate when messages arrive."""

    async def test_pre_persisted_inbox_message_is_not_saved_twice(self, runtime):
        message = Message(
            from_agent="child",
            to_agent="openagentd",
            content="Already durable.",
            persisted_message_id=str(uuid7()),
        )

        persisted = await runtime._persist_inbox([message])

        assert persisted[0].db_id is not None

    async def test_activation_spawns_task(self, runtime):
        """Send message to registered member, verify _active_task is created."""
        await runtime.start()

        assert runtime._active_task is None

        msg = Message(
            from_agent="child", to_agent="openagentd", content="[openagentd]: task"
        )
        await runtime.deliver(msg)
        await _drain_activation(runtime)

        # Task should have been spawned and completed
        assert runtime._active_task is not None
        assert runtime._active_task.done()

        await runtime.stop()

    async def test_activation_returns_to_idle(self, runtime):
        """After activation completes, state is 'idle'."""
        await runtime.start()

        msg = Message(
            from_agent="child", to_agent="openagentd", content="[openagentd]: task"
        )
        await runtime.deliver(msg)
        await _drain_activation(runtime)

        assert runtime.state == "idle"

        await runtime.stop()

    async def test_maybe_activate_skips_when_working(self, runtime):
        """Set state='working', call _maybe_activate(), verify no new task."""
        await runtime.start()

        runtime.state = "working"
        original_task = asyncio.create_task(asyncio.sleep(10))
        runtime._active_task = original_task

        # Call _maybe_activate — should be a no-op
        runtime._maybe_activate()

        # Task should be unchanged
        assert runtime._active_task is original_task

        original_task.cancel()
        try:
            await original_task
        except asyncio.CancelledError:
            pass

        await runtime.stop()

    async def test_maybe_activate_skips_only_when_state_working(self, runtime):
        """_maybe_activate is a no-op only when state == 'working'.

        The old guard on _active_task.done() was removed because it caused a
        race: the previous task sets state='idle' in its finally block
        before it fully exits (still awaiting async I/O), so _maybe_activate
        would see state='idle' but task.done()==False and silently drop
        the new activation, leaving the incoming message in the inbox forever.

        Now state=='working' is the sole guard.  A running _active_task with
        state!='working' is the teardown window — a new activation MUST spawn.
        """
        await runtime.start()

        # state == "working" → no-op regardless of _active_task
        runtime.state = "working"
        original_task = asyncio.create_task(asyncio.sleep(10))
        runtime._active_task = original_task
        runtime._maybe_activate()
        assert runtime._active_task is original_task  # unchanged

        # state == "idle" even with a still-running task → new activation spawned
        # (this is the teardown-window fix)
        runtime.state = "idle"
        runtime._maybe_activate()
        assert runtime._active_task is not original_task  # new task created

        original_task.cancel()
        try:
            await original_task
        except asyncio.CancelledError:
            pass

        await runtime.stop()

    async def test_spurious_activation_empty_inbox(self, runtime):
        """Call _run_activation() directly when inbox is empty, verify no agent.run()."""
        await runtime.start()

        # Mock agent.run to track if it's called
        runtime.agent.run = AsyncMock()

        # Manually call _run_activation with empty inbox
        await runtime._run_activation()

        # agent.run should NOT have been called (spurious activation)
        runtime.agent.run.assert_not_called()
        assert runtime.state == "idle"

        await runtime.stop()

    async def test_cancel_event_cleared_on_activation(self, runtime):
        """Set _cancel_event, then activate — verify event is cleared before agent.run()."""
        await runtime.start()

        runtime._cancel_event.set()
        assert runtime._cancel_event.is_set()

        msg = Message(
            from_agent="child", to_agent="openagentd", content="[openagentd]: task"
        )
        await runtime.deliver(msg)
        await _drain_activation(runtime)

        # After activation, cancel event should be cleared
        assert not runtime._cancel_event.is_set()

        await runtime.stop()


class TestReactivation:
    """Test reactivation after errors and sequential messages."""

    async def test_reactivation_after_error(self, runtime):
        """First message causes error, then send second message, verify NEW task spawned."""
        await runtime.start()

        # First message causes error
        runtime.agent.run = AsyncMock(side_effect=RuntimeError("LLM crashed"))

        msg1 = Message(
            from_agent="child", to_agent="openagentd", content="[openagentd]: task1"
        )
        await runtime.deliver(msg1)
        await _drain_activation(runtime)

        assert runtime.state == "error"
        first_task = runtime._active_task

        # Now send second message — should spawn a new task
        runtime.agent.run = AsyncMock(return_value=None)
        msg2 = Message(
            from_agent="child", to_agent="openagentd", content="[openagentd]: task2"
        )
        await runtime.deliver(msg2)
        await _drain_activation(runtime)

        # Should have a new task
        assert runtime._active_task is not first_task
        assert runtime.state == "idle"

        await runtime.stop()

    async def test_reactivation_after_success(self, runtime):
        """Two sequential messages, each gets its own activation cycle."""
        await runtime.start()

        # First message
        msg1 = Message(
            from_agent="child", to_agent="openagentd", content="[openagentd]: task1"
        )
        await runtime.deliver(msg1)
        await _drain_activation(runtime)

        assert runtime.state == "idle"
        first_task = runtime._active_task

        # Second message
        msg2 = Message(
            from_agent="child", to_agent="openagentd", content="[openagentd]: task2"
        )
        await runtime.deliver(msg2)
        await _drain_activation(runtime)

        # Should have a new task
        assert runtime._active_task is not first_task
        assert runtime.state == "idle"

        await runtime.stop()

    async def test_message_during_activation_handled_by_inbox_hook(self, runtime):
        """Agent is working, second message arrives, verify it queues (not lost)."""
        await runtime.start()

        # Make agent.run take a moment so we can send a second message during execution
        async def slow_run(*args, **kwargs):
            await asyncio.sleep(0.01)

        runtime.agent.run = AsyncMock(side_effect=slow_run)

        # First message
        msg1 = Message(
            from_agent="child", to_agent="openagentd", content="[openagentd]: task1"
        )
        await runtime.deliver(msg1)
        # Yield so the activation task starts and enters slow_run.
        for _ in range(3):
            await asyncio.sleep(0)

        # While working, send second message
        msg2 = Message(
            from_agent="child", to_agent="openagentd", content="[openagentd]: task2"
        )
        await runtime.deliver(msg2)

        # Drain the active task (and any reactivation it spawns).
        for _ in range(3):
            await _drain_activation(runtime)

        # Both messages should have been processed (no loss)
        assert runtime.state == "idle"

        await runtime.stop()


class TestLateInboxReactivation:
    """Test the late-inbox reactivation fix.

    Scenario: a message arrives in the inbox while agent.run() is still
    executing (e.g. a peer replies while the agent is streaming <sleep>).
    The TeamInboxHook never fires again after agent.run() breaks, so without
    the fix the message would sit in the inbox forever.

    Fix: _run_activation checks the inbox in its finally block and calls
    _maybe_activate() if there are pending messages.  _maybe_activate() now
    also sets state="working" synchronously before create_task so that the
    immediately-following _try_emit_done() does not fire a premature done.
    """

    async def test_late_message_triggers_reactivation(self, runtime):
        """Message arrives during agent.run() → reactivation fires after run exits."""
        await runtime.start()

        reactivation_count = 0

        async def run_that_queues_late_message(*args, **kwargs):
            nonlocal reactivation_count
            reactivation_count += 1
            if reactivation_count == 1:
                # Simulate a late message arriving while this run executes
                late = Message(
                    from_agent="child",
                    to_agent="openagentd",
                    content="[openagentd]: late message",
                )
                await runtime.deliver(late)

        runtime.agent.run = AsyncMock(side_effect=run_that_queues_late_message)

        msg = Message(
            from_agent="child", to_agent="openagentd", content="[openagentd]: first"
        )
        await runtime.deliver(msg)
        # Drain the first activation, then the reactivation it triggers.
        for _ in range(3):
            await _drain_activation(runtime)

        # agent.run() was called twice: once for the first message, once for the late one
        assert reactivation_count == 2
        assert runtime.state == "idle"

        await runtime.stop()

    async def test_interrupt_discards_late_inbox_without_reactivation(self, runtime):
        """An interrupted activation must not restart from messages queued mid-turn."""
        await runtime.start()

        run_count = 0

        async def run_that_is_interrupted(*args, **kwargs):
            nonlocal run_count
            run_count += 1
            late = Message(
                from_agent="child",
                to_agent="openagentd",
                content="[openagentd]: stale after stop",
            )
            await runtime.deliver(late)
            runtime.interrupt()

        runtime.agent.run = AsyncMock(side_effect=run_that_is_interrupted)

        msg = Message(
            from_agent="child", to_agent="openagentd", content="[openagentd]: first"
        )
        await runtime.deliver(msg)
        await _drain_activation(runtime)
        await asyncio.sleep(0)

        assert run_count == 1
        assert runtime.inbox_empty()
        assert runtime.state == "idle"

        await runtime.stop()

    async def test_maybe_activate_sets_state_working_synchronously(self, runtime):
        """_maybe_activate sets state='working' before create_task returns.

        This prevents _try_emit_done() — called right after _maybe_activate in
        the finally block — from seeing state='idle' and firing done early.
        """
        await runtime.start()

        runtime.state = "idle"

        runtime._maybe_activate()

        # State must be "working" synchronously — before any await
        assert runtime.state == "working"

        # Clean up the spawned task
        if runtime._active_task:
            runtime._active_task.cancel()
            try:
                await runtime._active_task
            except (asyncio.CancelledError, Exception):
                pass

        await runtime.stop()

    async def test_no_premature_done_on_late_inbox(self, runtime, mock_stream_store):
        """done event must not fire while reactivation is pending.

        When the finally block calls _maybe_activate (reactivation), state is
        set to 'working' synchronously.  The subsequent _try_emit_done must see
        state='working' and NOT emit done.
        """
        await runtime.start()
        runtime._has_active_turn = True

        reactivated = False
        second_run_started = asyncio.Event()
        release_second_run = asyncio.Event()

        async def run_that_queues_late_message(*args, **kwargs):
            nonlocal reactivated
            if not reactivated:
                reactivated = True
                late = Message(
                    from_agent="child",
                    to_agent="openagentd",
                    content="[openagentd]: late",
                )
                await runtime.deliver(late)
            else:
                # Signal that second run started, then wait for the test to
                # release us — replaces a fixed 0.2s sleep.
                second_run_started.set()
                await release_second_run.wait()

        runtime.agent.run = AsyncMock(side_effect=run_that_queues_late_message)

        msg = Message(
            from_agent="child", to_agent="openagentd", content="[openagentd]: first"
        )
        await runtime.deliver(msg)

        # Wait until second (reactivated) run has started
        await asyncio.wait_for(second_run_started.wait(), timeout=2.0)

        # done must not have fired — reactivation is still in progress
        pushed_events = [
            call.args[1].event for call in mock_stream_store.call_args_list
        ]
        assert "done" not in pushed_events

        # Release the second run and wait for full completion deterministically.
        release_second_run.set()
        await _drain_activation(runtime)

        # Now done should have fired
        pushed_events = [
            call.args[1].event for call in mock_stream_store.call_args_list
        ]
        assert "done" in pushed_events

        await runtime.stop()

    async def test_spurious_activation_resets_state(self, runtime):
        """_run_activation with empty inbox resets state to 'idle'.

        _maybe_activate now pre-sets state='working' before create_task, so
        _run_activation must reset it if the inbox turns out to be empty
        (spurious activation).
        """
        await runtime.start()

        runtime.agent.run = AsyncMock()

        # Manually set working (as _maybe_activate would) then run with empty inbox
        runtime.state = "working"
        await runtime._run_activation()

        assert runtime.state == "idle"
        runtime.agent.run.assert_not_called()

        await runtime.stop()


class TestTurnErrorSeverity:
    """Expected provider states must not be logged as application faults.

    ``_run_activation`` logs a known set of provider exceptions at WARNING and
    everything else via ``logger.exception`` (ERROR + traceback, which lands in
    the 14-day app-error.log).  ``UnconfiguredProviderError`` subclasses
    ``ValueError``, not any provider error, so a brand-new install that has not
    picked a model yet produced ERROR-level tracebacks — the loudest signal in
    the log — for a state the UI already handles with a "configure a provider"
    banner.
    """

    async def test_unconfigured_provider_logs_warning_not_error(self, runtime, caplog):
        from loguru import logger

        from app.agent.providers.unconfigured import UnconfiguredProviderError

        await runtime.start()
        runtime.agent.run = AsyncMock(
            side_effect=UnconfiguredProviderError("openagentd")
        )

        handler_id = logger.add(caplog.handler, format="{message}", level="DEBUG")
        try:
            msg = Message(
                from_agent="child", to_agent="openagentd", content="[openagentd]: task"
            )
            await runtime.deliver(msg)
            await _drain_activation(runtime)
        finally:
            logger.remove(handler_id)

        levels = {
            r.levelname
            for r in caplog.records
            if "session_runtime_turn_error" in r.getMessage()
        }
        assert levels, "the turn error should have been logged"
        assert levels == {"WARNING"}, (
            f"unconfigured provider must log at WARNING, got {levels}"
        )

        await runtime.stop()

    async def test_genuine_crash_still_logs_error_with_traceback(self, runtime, caplog):
        """Guard the other side: real faults must stay loud."""
        from loguru import logger

        await runtime.start()
        runtime.agent.run = AsyncMock(side_effect=KeyError("genuine bug"))

        handler_id = logger.add(caplog.handler, format="{message}", level="DEBUG")
        try:
            msg = Message(
                from_agent="child", to_agent="openagentd", content="[openagentd]: task"
            )
            await runtime.deliver(msg)
            await _drain_activation(runtime)
        finally:
            logger.remove(handler_id)

        levels = {
            r.levelname
            for r in caplog.records
            if "session_runtime_turn_error" in r.getMessage()
        }
        assert levels == {"ERROR"}, f"a real bug must stay ERROR, got {levels}"

        await runtime.stop()
