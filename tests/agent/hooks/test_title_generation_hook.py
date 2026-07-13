"""Tests for app/agent/hooks/title_generation.py — TitleGenerationHook.

Covers uncovered lines: 68, 73, 78-80, 85-95, 105-109.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from app.agent.hooks.title_generation import (
    TITLE_GENERATION_PROMPT,
    TitleGenerationHook,
)
from app.agent.schemas.chat import AssistantMessage, HumanMessage, SystemMessage
from app.agent.state import AgentState, RunContext

# A fixed UUID for deterministic tests
_TEST_SESSION_ID = "12345678-1234-5678-1234-567812345678"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def make_ctx(
    session_id: str | None = _TEST_SESSION_ID,
    run_id: str = "run_1",
    agent_name: str = "bot",
) -> RunContext:
    return RunContext(session_id=session_id, run_id=run_id, agent_name=agent_name)


def make_state(messages: list | None = None) -> AgentState:
    return AgentState(messages=messages or [])


def make_hook(wait_timeout: float = 3.0) -> TitleGenerationHook:
    provider = MagicMock()
    db_factory = MagicMock()
    return TitleGenerationHook(
        provider=provider,
        db_factory=db_factory,
        system_prompt="test title prompt",
        wait_timeout=wait_timeout,
    )


def test_title_prompt_requires_matching_the_user_prompt_language():
    assert "same language as the user's prompt" in TITLE_GENERATION_PROMPT
    assert "Do not translate the title" in TITLE_GENERATION_PROMPT


# ---------------------------------------------------------------------------
# before_agent — early returns
# ---------------------------------------------------------------------------


class TestBeforeAgentEarlyReturns:
    """Test that before_agent exits early in the right conditions."""

    async def test_no_session_id_does_nothing(self):
        """Line 68: session_id is None → return immediately, no task spawned."""
        hook = make_hook()
        ctx = make_ctx(session_id=None)
        state = make_state(messages=[HumanMessage(content="Hello")])

        await hook.before_agent(ctx, state)

        assert hook._task is None

    async def test_has_assistant_message_does_nothing(self):
        """Line 73: assistant message already exists → not the first turn."""
        hook = make_hook()
        ctx = make_ctx()
        state = make_state(
            messages=[
                HumanMessage(content="Hello"),
                AssistantMessage(content="Hi there"),
                HumanMessage(content="Follow up"),
            ]
        )

        await hook.before_agent(ctx, state)

        assert hook._task is None

    async def test_no_human_message_does_nothing(self):
        """Lines 78-80, 82: no HumanMessage with content → return."""
        hook = make_hook()
        ctx = make_ctx()
        # Only a system message, no human messages at all
        state = make_state(messages=[SystemMessage(content="You are helpful.")])

        await hook.before_agent(ctx, state)

        assert hook._task is None

    async def test_empty_human_content_does_nothing(self):
        """Lines 78-80: HumanMessage exists but content is empty string."""
        hook = make_hook()
        ctx = make_ctx()
        state = make_state(messages=[HumanMessage(content="")])

        await hook.before_agent(ctx, state)

        assert hook._task is None

    async def test_greeting_only_does_nothing(self):
        hook = make_hook()
        ctx = make_ctx()
        state = make_state(messages=[HumanMessage(content="Good morning!")])

        await hook.before_agent(ctx, state)

        assert hook._task is None

    async def test_short_message_does_nothing(self):
        hook = make_hook()
        ctx = make_ctx()
        state = make_state(messages=[HumanMessage(content="fix tests")])

        await hook.before_agent(ctx, state)

        assert hook._task is None


# ---------------------------------------------------------------------------
# before_agent — spawns task
# ---------------------------------------------------------------------------


class TestBeforeAgentSpawnsTask:
    """Test that before_agent spawns the title generation task."""

    async def test_first_turn_spawns_task(self):
        """Lines 85-95: first user message triggers background task."""
        hook = make_hook()
        ctx = make_ctx(session_id=_TEST_SESSION_ID)
        state = make_state(messages=[HumanMessage(content="Write a sorting algorithm")])

        with patch(
            "app.services.title_service.generate_and_save_title",
            new_callable=AsyncMock,
        ) as mock_gen:
            await hook.before_agent(ctx, state)

            assert hook._task is not None
            # Let the task run
            await hook._task

            mock_gen.assert_awaited_once()
            call_kwargs = mock_gen.call_args.kwargs
            assert str(call_kwargs["session_id"]) == _TEST_SESSION_ID
            assert call_kwargs["user_message"] == "Write a sorting algorithm"
            assert call_kwargs["provider"] is hook._provider
            assert call_kwargs["db_factory"] is hook._db_factory
            assert call_kwargs["system_prompt"] == "test title prompt"

    async def test_picks_last_human_message(self):
        """Lines 78-80: iterates reversed, picks the last HumanMessage."""
        hook = make_hook()
        ctx = make_ctx()
        state = make_state(
            messages=[
                SystemMessage(content="System prompt"),
                HumanMessage(content="First question"),
                HumanMessage(content="Actually, this one"),
            ]
        )

        with patch(
            "app.services.title_service.generate_and_save_title",
            new_callable=AsyncMock,
        ) as mock_gen:
            await hook.before_agent(ctx, state)
            await hook._task

            assert mock_gen.call_args.kwargs["user_message"] == "Actually, this one"

    async def test_skips_empty_human_messages(self):
        """Lines 78-80: skips HumanMessage with empty content, finds earlier one."""
        hook = make_hook()
        ctx = make_ctx()
        state = make_state(
            messages=[
                HumanMessage(content="Good question here"),
                HumanMessage(content=""),
            ]
        )

        with patch(
            "app.services.title_service.generate_and_save_title",
            new_callable=AsyncMock,
        ) as mock_gen:
            await hook.before_agent(ctx, state)
            await hook._task

            assert mock_gen.call_args.kwargs["user_message"] == "Good question here"

    async def test_skips_hidden_from_user_messages(self):
        """Skips HumanMessage with hidden_from_user=True, finds the real user message."""
        hook = make_hook()
        ctx = make_ctx()
        state = make_state(
            messages=[
                HumanMessage(content="This is the real user prompt"),
                HumanMessage(
                    content="[File: somefile.py] ...",
                    extra={"hidden_from_user": True},
                ),
            ]
        )

        with patch(
            "app.services.title_service.generate_and_save_title",
            new_callable=AsyncMock,
        ) as mock_gen:
            await hook.before_agent(ctx, state)
            await hook._task

            assert (
                mock_gen.call_args.kwargs["user_message"]
                == "This is the real user prompt"
            )


# ---------------------------------------------------------------------------
# after_agent — task cleanup
# ---------------------------------------------------------------------------


class TestAfterAgent:
    """Test after_agent awaits/cleans up the background task."""

    async def test_no_task_is_noop(self):
        """Line 101-103: no task set → nothing to do."""
        hook = make_hook()
        ctx = make_ctx()
        state = make_state()
        response = AssistantMessage(content="Done")

        await hook.after_agent(ctx, state, response)

        assert hook._task is None

    async def test_already_done_task_is_cleared(self):
        """Line 101-103: task already finished → just clear it."""
        hook = make_hook()
        ctx = make_ctx()
        state = make_state()
        response = AssistantMessage(content="Done")

        # Create a task that finishes immediately
        async def noop():
            pass

        hook._task = asyncio.create_task(noop())
        await hook._task  # let it finish

        await hook.after_agent(ctx, state, response)

        assert hook._task is None

    async def test_waits_for_pending_task(self):
        """Lines 105-106: pending task → await with 3s timeout."""
        hook = make_hook()
        ctx = make_ctx()
        state = make_state()
        response = AssistantMessage(content="Done")

        completed = False

        async def slow_title():
            nonlocal completed
            await asyncio.sleep(0.05)
            completed = True

        hook._task = asyncio.create_task(slow_title())

        await hook.after_agent(ctx, state, response)

        assert completed
        assert hook._task is None

    async def test_timeout_does_not_crash(self):
        """Lines 107-108: task exceeds 3s timeout → swallowed, no crash."""
        hook = make_hook()
        ctx = make_ctx()
        state = make_state()
        response = AssistantMessage(content="Done")

        async def very_slow():
            await asyncio.sleep(999)

        hook._task = asyncio.create_task(very_slow())

        # Patch wait_for timeout to a tiny value so test doesn't wait 3s
        with patch(
            "app.agent.hooks.title_generation.asyncio.wait_for",
            side_effect=TimeoutError,
        ):
            await hook.after_agent(ctx, state, response)

        # Should not raise, task ref cleared
        assert hook._task is None

    async def test_exception_in_task_does_not_crash(self):
        """Lines 107-108: task raises an exception → swallowed gracefully."""
        hook = make_hook()
        ctx = make_ctx()
        state = make_state()
        response = AssistantMessage(content="Done")

        async def failing_title():
            raise RuntimeError("LLM call failed")

        hook._task = asyncio.create_task(failing_title())

        # Give the task a moment to fail
        await asyncio.sleep(0.01)

        await hook.after_agent(ctx, state, response)

        assert hook._task is None
