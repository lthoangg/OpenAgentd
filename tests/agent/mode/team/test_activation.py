"""Tests for on-demand activation and reactivation in team mode.

Covers:
- _maybe_activate() spawning tasks
- State transitions (idle -> working -> idle/error)
- Spurious activation handling
- Cancel event clearing
- Reactivation after errors
- On-message callback behavior
- Late-inbox reactivation (message arrives while agent.run() is executing)
- No premature done event on late-inbox reactivation
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock

import pytest_asyncio

from app.agent.agent_loop import Agent
from app.agent.mode.team.mailbox import Message, TeamMailbox
from app.agent.mode.team.member import TeamLead, TeamMember
from app.agent.mode.team.team import AgentTeam
from tests.agent.mode.team.conftest import MockTeamProvider


async def _drain_activation(worker, *, timeout: float = 2.0) -> None:
    """Wait until the worker's pending activation task completes.

    Replaces fixed ``await asyncio.sleep(0.1)`` calls with a deterministic
    sync point.  Yields the event loop once first so the on_message callback
    has a chance to spawn ``_active_task``.
    """
    # Let the on_message callback chain run (mailbox.send → _on_message →
    # _maybe_activate → asyncio.create_task).
    for _ in range(5):
        await asyncio.sleep(0)
        if worker._active_task is not None and not worker._active_task.done():
            break

    task = worker._active_task
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
    mock_db.exec = AsyncMock(return_value=MagicMock(all=MagicMock(return_value=[])))
    mock_db.add = MagicMock()

    @asynccontextmanager
    async def factory():
        yield mock_db

    return factory


@pytest_asyncio.fixture
async def team_with_db():
    """Create a team with mocked DB factory."""
    db_factory = _make_mock_db_factory()

    lead = TeamLead(
        Agent(name="lead", llm_provider=MockTeamProvider("lead response")),
        db_factory=db_factory,
    )
    worker = TeamMember(
        Agent(name="worker", llm_provider=MockTeamProvider("worker response")),
        db_factory=db_factory,
    )

    team = AgentTeam(lead=lead, members={"worker": worker})
    return team


class TestInterrupt:
    async def test_interrupt_cancels_active_activation_task(self, team_with_db):
        worker = team_with_db.members["worker"]
        started = asyncio.Event()
        cancelled = asyncio.Event()

        async def active_turn():
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        worker.state = "working"
        worker._active_task = asyncio.create_task(active_turn())
        await started.wait()

        worker.interrupt()
        await asyncio.wait_for(
            asyncio.gather(worker._active_task, return_exceptions=True), timeout=0.1
        )

        assert cancelled.is_set()
        assert worker._active_task.cancelled()


class TestOnDemandActivation:
    """Test on-demand activation — agents activate when messages arrive."""

    async def test_activation_spawns_task(self, team_with_db):
        """Send message to registered member, verify _active_task is created."""
        team = team_with_db
        await team.start()

        worker = team.members["worker"]
        assert worker._active_task is None

        msg = Message(from_agent="lead", to_agent="worker", content="[lead]: task")
        await team.mailbox.send(to="worker", message=msg)
        await _drain_activation(worker)

        # Task should have been spawned and completed
        assert worker._active_task is not None
        assert worker._active_task.done()

        await team.stop()

    async def test_activation_returns_to_idle(self, team_with_db):
        """After activation completes, state is 'idle'."""
        team = team_with_db
        await team.start()

        worker = team.members["worker"]
        msg = Message(from_agent="lead", to_agent="worker", content="[lead]: task")
        await team.mailbox.send(to="worker", message=msg)
        await _drain_activation(worker)

        assert worker.state == "idle"

        await team.stop()

    async def test_maybe_activate_skips_when_working(self, team_with_db):
        """Set state='working', call _maybe_activate(), verify no new task."""
        team = team_with_db
        await team.start()

        worker = team.members["worker"]
        worker.state = "working"
        original_task = asyncio.create_task(asyncio.sleep(10))
        worker._active_task = original_task

        # Call _maybe_activate — should be a no-op
        worker._maybe_activate()

        # Task should be unchanged
        assert worker._active_task is original_task

        original_task.cancel()
        try:
            await original_task
        except asyncio.CancelledError:
            pass

        await team.stop()

    async def test_maybe_activate_skips_only_when_state_working(self, team_with_db):
        """_maybe_activate is a no-op only when state == 'working'.

        The old guard on _active_task.done() was removed because it caused a
        race: the previous task sets state='idle' in its finally block
        before it fully exits (still awaiting async I/O), so _maybe_activate
        would see state='idle' but task.done()==False and silently drop
        the new activation, leaving the incoming message in the inbox forever.

        Now state=='working' is the sole guard.  A running _active_task with
        state!='working' is the teardown window — a new activation MUST spawn.
        """
        team = team_with_db
        await team.start()

        worker = team.members["worker"]

        # state == "working" → no-op regardless of _active_task
        worker.state = "working"
        original_task = asyncio.create_task(asyncio.sleep(10))
        worker._active_task = original_task
        worker._maybe_activate()
        assert worker._active_task is original_task  # unchanged

        # state == "idle" even with a still-running task → new activation spawned
        # (this is the teardown-window fix)
        worker.state = "idle"
        worker._maybe_activate()
        assert worker._active_task is not original_task  # new task created

        original_task.cancel()
        try:
            await original_task
        except asyncio.CancelledError:
            pass

        await team.stop()

    async def test_spurious_activation_empty_inbox(self, team_with_db):
        """Call _run_activation() directly when inbox is empty, verify no agent.run()."""
        team = team_with_db
        await team.start()

        worker = team.members["worker"]
        # Mock agent.run to track if it's called
        worker.agent.run = AsyncMock()

        # Manually call _run_activation with empty inbox
        await worker._run_activation()

        # agent.run should NOT have been called (spurious activation)
        worker.agent.run.assert_not_called()
        assert worker.state == "idle"

        await team.stop()

    async def test_cancel_event_cleared_on_activation(self, team_with_db):
        """Set _cancel_event, then activate — verify event is cleared before agent.run()."""
        team = team_with_db
        await team.start()

        worker = team.members["worker"]
        worker._cancel_event.set()
        assert worker._cancel_event.is_set()

        msg = Message(from_agent="lead", to_agent="worker", content="[lead]: task")
        await team.mailbox.send(to="worker", message=msg)
        await _drain_activation(worker)

        # After activation, cancel event should be cleared
        assert not worker._cancel_event.is_set()

        await team.stop()


class TestReactivation:
    """Test reactivation after errors and sequential messages."""

    async def test_reactivation_after_error(self, team_with_db):
        """First message causes error, then send second message, verify NEW task spawned."""
        team = team_with_db
        await team.start()

        worker = team.members["worker"]
        # First message causes error
        worker.agent.run = AsyncMock(side_effect=RuntimeError("LLM crashed"))

        msg1 = Message(from_agent="lead", to_agent="worker", content="[lead]: task1")
        await team.mailbox.send(to="worker", message=msg1)
        await _drain_activation(worker)

        assert worker.state == "error"
        first_task = worker._active_task

        # Now send second message — should spawn a new task
        worker.agent.run = AsyncMock(return_value=None)
        msg2 = Message(from_agent="lead", to_agent="worker", content="[lead]: task2")
        await team.mailbox.send(to="worker", message=msg2)
        await _drain_activation(worker)

        # Should have a new task
        assert worker._active_task is not first_task
        assert worker.state == "idle"

        await team.stop()

    async def test_reactivation_after_success(self, team_with_db):
        """Two sequential messages, each gets its own activation cycle."""
        team = team_with_db
        await team.start()

        worker = team.members["worker"]

        # First message
        msg1 = Message(from_agent="lead", to_agent="worker", content="[lead]: task1")
        await team.mailbox.send(to="worker", message=msg1)
        await _drain_activation(worker)

        assert worker.state == "idle"
        first_task = worker._active_task

        # Second message
        msg2 = Message(from_agent="lead", to_agent="worker", content="[lead]: task2")
        await team.mailbox.send(to="worker", message=msg2)
        await _drain_activation(worker)

        # Should have a new task
        assert worker._active_task is not first_task
        assert worker.state == "idle"

        await team.stop()

    async def test_message_during_activation_handled_by_inbox_hook(self, team_with_db):
        """Agent is working, second message arrives, verify it queues (not lost)."""
        team = team_with_db
        await team.start()

        worker = team.members["worker"]

        # Make agent.run take a moment so we can send a second message during execution
        async def slow_run(*args, **kwargs):
            await asyncio.sleep(0.01)

        worker.agent.run = AsyncMock(side_effect=slow_run)

        # First message
        msg1 = Message(from_agent="lead", to_agent="worker", content="[lead]: task1")
        await team.mailbox.send(to="worker", message=msg1)
        # Yield so the activation task starts and enters slow_run.
        for _ in range(3):
            await asyncio.sleep(0)

        # While working, send second message
        msg2 = Message(from_agent="lead", to_agent="worker", content="[lead]: task2")
        await team.mailbox.send(to="worker", message=msg2)

        # Drain the active task (and any reactivation it spawns).
        for _ in range(3):
            await _drain_activation(worker)

        # Both messages should have been processed (no loss)
        assert worker.state == "idle"

        await team.stop()


class TestOnMessageCallback:
    """Test on_message callback behavior."""

    async def test_on_message_callback_fires_on_send(self):
        """Create mailbox with callback, send message, verify callback called."""
        callback_calls = []

        async def on_msg(agent_name: str, message: Message) -> None:
            callback_calls.append((agent_name, message))

        mailbox = TeamMailbox(on_message=on_msg)
        mailbox.register("alice")
        mailbox.register("bob")

        msg = Message(from_agent="alice", to_agent="bob", content="hello")
        await mailbox.send(to="bob", message=msg)

        assert len(callback_calls) == 1
        assert callback_calls[0][0] == "bob"
        assert callback_calls[0][1].content == "hello"

    async def test_on_message_unknown_agent_logged(self, team_with_db):
        """Call team._on_message('nonexistent', msg), verify no crash."""
        team = team_with_db
        await team.start()

        msg = Message(from_agent="lead", to_agent="nonexistent", content="hello")
        # Should not raise
        await team._on_message("nonexistent", msg)

        await team.stop()

    async def test_no_callback_when_none(self):
        """Create mailbox without callback, send message, no crash."""
        mailbox = TeamMailbox(on_message=None)
        mailbox.register("alice")
        mailbox.register("bob")

        msg = Message(from_agent="alice", to_agent="bob", content="hello")
        # Should not raise
        await mailbox.send(to="bob", message=msg)

        received = await mailbox.receive("bob")
        assert received.content == "hello"


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

    async def test_late_message_triggers_reactivation(self, team_with_db):
        """Message arrives during agent.run() → reactivation fires after run exits."""
        team = team_with_db
        await team.start()

        worker = team.members["worker"]
        reactivation_count = 0

        async def run_that_queues_late_message(*args, **kwargs):
            nonlocal reactivation_count
            reactivation_count += 1
            if reactivation_count == 1:
                # Simulate a late message arriving while this run executes
                late = Message(
                    from_agent="lead",
                    to_agent="worker",
                    content="[lead]: late message",
                )
                await team.mailbox.send(to="worker", message=late)

        worker.agent.run = AsyncMock(side_effect=run_that_queues_late_message)

        msg = Message(from_agent="lead", to_agent="worker", content="[lead]: first")
        await team.mailbox.send(to="worker", message=msg)
        # Drain the first activation, then the reactivation it triggers.
        for _ in range(3):
            await _drain_activation(worker)

        # agent.run() was called twice: once for the first message, once for the late one
        assert reactivation_count == 2
        assert worker.state == "idle"

        await team.stop()

    async def test_interrupt_discards_late_inbox_without_reactivation(
        self, team_with_db
    ):
        """An interrupted activation must not restart from messages queued mid-turn."""
        team = team_with_db
        await team.start()

        worker = team.members["worker"]
        run_count = 0

        async def run_that_is_interrupted(*args, **kwargs):
            nonlocal run_count
            run_count += 1
            late = Message(
                from_agent="lead",
                to_agent="worker",
                content="[lead]: stale after stop",
            )
            await team.mailbox.send(to="worker", message=late)
            worker.interrupt()

        worker.agent.run = AsyncMock(side_effect=run_that_is_interrupted)

        msg = Message(from_agent="lead", to_agent="worker", content="[lead]: first")
        await team.mailbox.send(to="worker", message=msg)
        await _drain_activation(worker)
        await asyncio.sleep(0)

        assert run_count == 1
        assert team.mailbox.inbox_empty("worker")
        assert worker.state == "idle"

        await team.stop()

    async def test_maybe_activate_sets_state_working_synchronously(self, team_with_db):
        """_maybe_activate sets state='working' before create_task returns.

        This prevents _try_emit_done() — called right after _maybe_activate in
        the finally block — from seeing state='idle' and firing done early.
        """
        team = team_with_db
        await team.start()

        worker = team.members["worker"]
        worker.state = "idle"

        worker._maybe_activate()

        # State must be "working" synchronously — before any await
        assert worker.state == "working"

        # Clean up the spawned task
        if worker._active_task:
            worker._active_task.cancel()
            try:
                await worker._active_task
            except (asyncio.CancelledError, Exception):
                pass

        await team.stop()

    async def test_no_premature_done_on_late_inbox(
        self, team_with_db, mock_stream_store
    ):
        """done event must not fire while reactivation is pending.

        When the finally block calls _maybe_activate (reactivation), state is
        set to 'working' synchronously.  The subsequent _try_emit_done must see
        state='working' and NOT emit done.
        """
        team = team_with_db
        await team.start()
        team._has_active_turn = True

        worker = team.members["worker"]
        reactivated = False
        second_run_started = asyncio.Event()
        release_second_run = asyncio.Event()

        async def run_that_queues_late_message(*args, **kwargs):
            nonlocal reactivated
            if not reactivated:
                reactivated = True
                late = Message(
                    from_agent="lead",
                    to_agent="worker",
                    content="[lead]: late",
                )
                await team.mailbox.send(to="worker", message=late)
            else:
                # Signal that second run started, then wait for the test to
                # release us — replaces a fixed 0.2s sleep.
                second_run_started.set()
                await release_second_run.wait()

        worker.agent.run = AsyncMock(side_effect=run_that_queues_late_message)

        msg = Message(from_agent="lead", to_agent="worker", content="[lead]: first")
        await team.mailbox.send(to="worker", message=msg)

        # Wait until second (reactivated) run has started
        await asyncio.wait_for(second_run_started.wait(), timeout=2.0)

        # done must not have fired — reactivation is still in progress
        pushed_events = [
            call.args[1].event for call in mock_stream_store.call_args_list
        ]
        assert "done" not in pushed_events

        # Release the second run and wait for full completion deterministically.
        release_second_run.set()
        await _drain_activation(worker)

        # Now done should have fired
        pushed_events = [
            call.args[1].event for call in mock_stream_store.call_args_list
        ]
        assert "done" in pushed_events

        await team.stop()

    async def test_spurious_activation_resets_state(self, team_with_db):
        """_run_activation with empty inbox resets state to 'idle'.

        _maybe_activate now pre-sets state='working' before create_task, so
        _run_activation must reset it if the inbox turns out to be empty
        (spurious activation).
        """
        team = team_with_db
        await team.start()

        worker = team.members["worker"]
        worker.agent.run = AsyncMock()

        # Manually set working (as _maybe_activate would) then run with empty inbox
        worker.state = "working"
        await worker._run_activation()

        assert worker.state == "idle"
        worker.agent.run.assert_not_called()

        await team.stop()
