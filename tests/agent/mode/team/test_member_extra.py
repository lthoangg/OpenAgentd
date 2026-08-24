"""Extra tests for app/agent/mode/team/member.py — covers uncovered lines."""

from __future__ import annotations

import asyncio
import uuid
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock

import inspect
import pytest

from app.agent.mode.team.mailbox import Message, TeamMailbox
from app.agent.mode.team.member import (
    _mark_last_assistant_interrupted,
    TeamLead,
    TeamMember,
)
from tests.agent.mode.team.conftest import MockTeamProvider


def _make_db_factory(msg=None):
    mock_db = MagicMock()
    mock_db.commit = AsyncMock()
    mock_db.add = MagicMock()
    result_mock = MagicMock()
    result_mock.first = MagicMock(return_value=msg)
    mock_db.exec = AsyncMock(return_value=result_mock)
    mock_db.get = AsyncMock(return_value=None)

    @asynccontextmanager
    async def factory():
        yield mock_db

    return factory, mock_db


# ---------------------------------------------------------------------------
# _mark_last_assistant_interrupted
# ---------------------------------------------------------------------------


class TestMarkLastAssistantInterrupted:
    @pytest.mark.asyncio
    async def test_sets_interrupted_flag_in_extra(self):
        msg = MagicMock()
        msg.content = "I was working on it"
        msg.extra = None
        factory, mock_db = _make_db_factory(msg=msg)

        await _mark_last_assistant_interrupted(factory, uuid.uuid7())

        # Content is untouched — flag rides on extra so the LLM never sees it.
        assert msg.content == "I was working on it"
        assert msg.extra == {"interrupted": True}
        mock_db.add.assert_called_once_with(msg)
        mock_db.commit.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_merges_into_existing_extra(self):
        msg = MagicMock()
        msg.content = "partial"
        msg.extra = {"usage": {"input": 100}}
        factory, _ = _make_db_factory(msg=msg)

        await _mark_last_assistant_interrupted(factory, uuid.uuid7())

        assert msg.extra == {"usage": {"input": 100}, "interrupted": True}

    @pytest.mark.asyncio
    async def test_noop_when_no_assistant_message(self):
        factory, mock_db = _make_db_factory(msg=None)

        await _mark_last_assistant_interrupted(factory, uuid.uuid7())

        mock_db.add.assert_not_called()
        mock_db.commit.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_swallows_db_exception(self):
        @asynccontextmanager
        async def bad_factory():
            raise RuntimeError("DB error")
            yield  # noqa: RET504

        await _mark_last_assistant_interrupted(bad_factory, uuid.uuid7())


# ---------------------------------------------------------------------------
# TeamMember.stop — timeout path (lines 168-169)
# ---------------------------------------------------------------------------


class TestTeamMemberStop:
    @pytest.mark.asyncio
    async def test_stop_cancels_active_task_on_timeout(self):
        from unittest.mock import patch

        from app.agent.agent_loop import Agent
        from app.agent.mode.team.mailbox import TeamMailbox

        agent = Agent(name="w", llm_provider=MockTeamProvider(), system_prompt="")
        factory, _ = _make_db_factory()
        member = TeamMember(agent, session_id=str(uuid.uuid7()), db_factory=factory)

        async def never_ends():
            await asyncio.sleep(999)

        member._mailbox = TeamMailbox()
        member._mailbox.register("w")
        member._active_task = asyncio.create_task(never_ends())

        # Patch wait_for to raise TimeoutError immediately instead of waiting 5s
        with patch(
            "app.agent.mode.team.member.asyncio.wait_for",
            side_effect=asyncio.TimeoutError,
        ):
            await member.stop()

        # Yield to let the cancellation propagate
        await asyncio.sleep(0)
        assert member._active_task is None or member._active_task.done()

    @pytest.mark.asyncio
    async def test_stop_closes_configured_provider_after_cancelling_turn(self):
        from app.agent.agent_loop import Agent

        provider = MockTeamProvider()
        provider.aclose = AsyncMock()
        member = TeamMember(Agent(name="w", llm_provider=provider, system_prompt=""))

        async def never_ends():
            await asyncio.sleep(999)

        member._active_task = asyncio.create_task(never_ends())

        await member.stop()

        provider.aclose.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_stop_without_mailbox_is_safe(self):
        from app.agent.agent_loop import Agent

        agent = Agent(name="w", llm_provider=MockTeamProvider(), system_prompt="")
        factory, _ = _make_db_factory()
        member = TeamMember(agent, session_id=str(uuid.uuid7()), db_factory=factory)
        # No mailbox or active task set
        await member.stop()  # Must not raise

    @pytest.mark.asyncio
    async def test_stop_deregisters_from_mailbox(self):
        """After stop(), agent no longer in registered_agents."""
        from app.agent.agent_loop import Agent

        agent = Agent(name="w", llm_provider=MockTeamProvider(), system_prompt="")
        factory, _ = _make_db_factory()
        member = TeamMember(agent, session_id=str(uuid.uuid7()), db_factory=factory)

        member._mailbox = TeamMailbox()
        member._mailbox.register("w")

        assert "w" in member._mailbox.registered_agents

        await member.stop()

        assert "w" not in member._mailbox.registered_agents

    @pytest.mark.asyncio
    async def test_double_stop_is_safe(self):
        """Call stop() twice, no crash."""
        from app.agent.agent_loop import Agent

        agent = Agent(name="w", llm_provider=MockTeamProvider(), system_prompt="")
        factory, _ = _make_db_factory()
        member = TeamMember(agent, session_id=str(uuid.uuid7()), db_factory=factory)

        member._mailbox = TeamMailbox()
        member._mailbox.register("w")

        await member.stop()
        # Second stop should be safe
        await member.stop()

        assert "w" not in member._mailbox.registered_agents

    @pytest.mark.asyncio
    async def test_stop_without_active_task(self):
        """Stop when no task running, clean exit."""
        from app.agent.agent_loop import Agent

        agent = Agent(name="w", llm_provider=MockTeamProvider(), system_prompt="")
        factory, _ = _make_db_factory()
        member = TeamMember(agent, session_id=str(uuid.uuid7()), db_factory=factory)

        member._mailbox = TeamMailbox()
        member._mailbox.register("w")

        assert member._active_task is None

        await member.stop()

        assert member.state == "idle"
        assert "w" not in member._mailbox.registered_agents


# ---------------------------------------------------------------------------
# TeamMember._ensure_db_session (lines 195-198)
# ---------------------------------------------------------------------------


class TestEnsureDbSession:
    def test_session_persistence_is_coding_workspace_only(self):
        from app.agent.mode.team.member import TeamMemberBase

        assert (
            "mode"
            not in inspect.signature(TeamMemberBase._ensure_db_session).parameters
        )

    @pytest.mark.asyncio
    async def test_creates_session_when_not_exists(self):
        from app.agent.agent_loop import Agent

        sid = str(uuid.uuid7())
        agent = Agent(name="m", llm_provider=MockTeamProvider(), system_prompt="")
        factory, mock_db = _make_db_factory(msg=None)
        member = TeamMember(agent, session_id=sid, db_factory=factory)

        await member._ensure_db_session()

        mock_db.add.assert_called_once()
        mock_db.commit.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_skips_create_when_session_exists(self):
        from app.agent.agent_loop import Agent
        from app.models.chat import ChatSession

        sid = str(uuid.uuid7())
        existing = MagicMock(spec=ChatSession)
        agent = Agent(name="m", llm_provider=MockTeamProvider(), system_prompt="")

        factory, mock_db = _make_db_factory()
        mock_db.get = AsyncMock(return_value=existing)
        member = TeamMember(agent, session_id=sid, db_factory=factory)

        await member._ensure_db_session()

        mock_db.add.assert_not_called()

    @pytest.mark.asyncio
    async def test_ensure_db_session_swallows_exception(self):
        from app.agent.agent_loop import Agent

        sid = str(uuid.uuid7())
        agent = Agent(name="m", llm_provider=MockTeamProvider(), system_prompt="")

        @asynccontextmanager
        async def bad_factory():
            raise RuntimeError("DB gone")
            yield  # noqa: RET504

        member = TeamMember(agent, session_id=sid, db_factory=bad_factory)
        await member._ensure_db_session()  # Must not raise


class TestInboxPersistence:
    @pytest.mark.asyncio
    async def test_lead_inbox_skips_user_rows_but_persists_peer_rows_in_order(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        from app.agent.agent_loop import Agent

        factory_calls = 0

        class Db:
            @asynccontextmanager
            async def begin(self):
                yield

        @asynccontextmanager
        async def factory():
            nonlocal factory_calls
            factory_calls += 1
            yield Db()

        async def fake_save(_db, _session_id, _message, **_kwargs):
            return type("Row", (), {"id": uuid.uuid7()})()

        monkeypatch.setattr("app.agent.mode.team.member.save_message", fake_save)
        lead = TeamLead(
            Agent(name="lead", llm_provider=MockTeamProvider()),
            session_id=str(uuid.uuid7()),
            db_factory=factory,
        )

        persisted = await lead._persist_inbox(
            [
                Message(from_agent="user", to_agent="lead", content="user"),
                Message(from_agent="worker", to_agent="lead", content="peer"),
            ]
        )

        assert factory_calls == 1
        assert [message.content for message in persisted] == ["user", "peer"]
        assert persisted[0].db_id is None
        assert persisted[1].db_id is not None

    @pytest.mark.asyncio
    async def test_persist_inbox_rolls_back_the_entire_batch_on_save_error(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        import app.core.db as app_db
        from app.agent.agent_loop import Agent
        from app.models.chat import ChatSession, SessionMessage
        from app.services.chat_service import save_message as real_save_message
        from sqlmodel import col, select

        session_id = uuid.uuid7()
        async with app_db.async_session_factory() as db:
            async with db.begin():
                db.add(ChatSession(id=session_id))

        calls = 0

        async def failing_second_save(db, *args, **kwargs):
            nonlocal calls
            calls += 1
            row = await real_save_message(db, *args, **kwargs)
            if calls == 2:
                raise RuntimeError("second insert failed")
            return row

        monkeypatch.setattr(
            "app.agent.mode.team.member.save_message", failing_second_save
        )
        member = TeamMember(
            Agent(name="worker", llm_provider=MockTeamProvider()),
            session_id=str(session_id),
            db_factory=app_db.async_session_factory,
        )

        with pytest.raises(RuntimeError, match="second insert failed"):
            await member._persist_inbox(
                [
                    Message(from_agent="lead", to_agent="worker", content="first"),
                    Message(from_agent="lead", to_agent="worker", content="second"),
                ]
            )

        async with app_db.async_session_factory() as db:
            rows = (
                await db.exec(
                    select(SessionMessage).where(
                        col(SessionMessage.session_id) == session_id
                    )
                )
            ).all()
        assert rows == []

    @pytest.mark.asyncio
    async def test_persist_inbox_uses_one_transaction_and_preserves_message_order(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        from app.agent.agent_loop import Agent

        factory_calls = 0
        transactions = 0

        class Db:
            @asynccontextmanager
            async def begin(self):
                nonlocal transactions
                transactions += 1
                yield

        @asynccontextmanager
        async def factory():
            nonlocal factory_calls
            factory_calls += 1
            yield Db()

        saved: list[tuple[str, dict]] = []

        async def fake_save(_db, _session_id, message, *, extra=None, **_kwargs):
            saved.append((message.content or "", extra or {}))
            return type("Row", (), {"id": uuid.uuid7()})()

        monkeypatch.setattr("app.agent.mode.team.member.save_message", fake_save)
        member = TeamMember(
            Agent(name="worker", llm_provider=MockTeamProvider()),
            session_id=str(uuid.uuid7()),
            db_factory=factory,
        )
        inbox = [
            Message(from_agent="lead", to_agent="worker", content="first"),
            Message(
                from_agent="peer",
                to_agent="worker",
                content="second",
                is_broadcast=True,
            ),
        ]

        persisted = await member._persist_inbox(inbox)

        assert factory_calls == 1
        assert transactions == 1
        assert [message.content for message in persisted] == ["first", "second"]
        assert all(message.db_id is not None for message in persisted)
        assert saved == [
            ("first", {"from_agent": "lead", "is_broadcast": False}),
            ("second", {"from_agent": "peer", "is_broadcast": True}),
        ]
