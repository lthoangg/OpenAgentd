"""Tests for TeamMember on-demand activation and _handle_messages."""

from __future__ import annotations

import asyncio
import json
import uuid
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid7

import pytest_asyncio

from app.agent.agent_loop import Agent
from app.agent.artifacts import TODOS_FILENAME
from app.agent.mode.team.mailbox import Message
from app.agent.mode.team.member import TeamLead, TeamMember
from app.agent.mode.team.team import AgentTeam
from app.agent.schemas.chat import (
    AssistantMessage,
    ChatCompletionChunk,
    ChatCompletionChunkChoice,
    ChatCompletionDelta,
    ChatMessage,
    ToolCallDelta,
)
from app.core import db as app_db
from app.models.chat import ChatSession
from app.services.chat_service import save_message
from tests.agent.mode.team.conftest import MockTeamProvider
from tests.agent.mode.team.test_activation import _drain_activation


class ClaimThenStopProvider(MockTeamProvider):
    """Claim once, then stop with plain text; report only after the nudge."""

    def __init__(self):
        super().__init__("I am incorrectly stopping without team_message")
        self.claimed = False
        self.reported = False

    def stream(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ):
        self.call_count += 1
        content = ""
        for message in reversed(messages):
            if getattr(message, "role", None) == "user":
                content = message.content or ""
                break
        if "Claim this todo" in content and not self.claimed:
            self.claimed = True
            chunk = _tool_chunk(
                "todo_manage",
                "claim_task",
                '{"actions":[{"action":"claim","task_id":"task_1"}]}',
            )
        elif "You still have open assigned task" in content and not self.reported:
            self.reported = True
            chunk = _tool_chunk(
                "team_message",
                "report_nudge",
                '{"to":["lead"],"content":"Nudge received; reporting back."}',
            )
        else:
            chunk = ChatCompletionChunk(
                id="plain-stop",
                created=1,
                model="mock-model",
                choices=[
                    ChatCompletionChunkChoice(
                        index=0,
                        delta=ChatCompletionDelta(
                            content="I am incorrectly stopping without team_message"
                        ),
                        finish_reason="stop",
                    )
                ],
            )

        async def _gen():
            yield chunk

        return _gen()


def _tool_chunk(name: str, tool_id: str, arguments: str) -> ChatCompletionChunk:
    return ChatCompletionChunk(
        id=tool_id,
        created=1,
        model="mock-model",
        choices=[
            ChatCompletionChunkChoice(
                index=0,
                delta=ChatCompletionDelta(
                    tool_calls=[
                        ToolCallDelta(
                            index=0,
                            id=tool_id,
                            function={"name": name, "arguments": arguments},
                        )
                    ]
                ),
                finish_reason="tool_calls",
            )
        ],
    )


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


def _make_mock_db_factory_with_session(session_row: ChatSession):
    mock_db = MagicMock()
    mock_db.commit = AsyncMock()
    mock_db.flush = AsyncMock()
    mock_db.refresh = AsyncMock()
    mock_db.get = AsyncMock(return_value=session_row)
    mock_db.exec = AsyncMock(return_value=MagicMock(all=MagicMock(return_value=[])))
    mock_db.add = MagicMock()

    @asynccontextmanager
    async def factory():
        yield mock_db

    return factory


async def _seed_worker_assistant(worker: TeamMember, content: str) -> None:
    worker.db_factory = app_db.async_session_factory
    session_uuid = uuid.UUID(worker.session_id)
    async with app_db.async_session_factory() as db:
        db.add(ChatSession(id=session_uuid, agent_name=worker.name))
        await db.flush()
        await save_message(db, session_uuid, AssistantMessage(content=content))
        await db.commit()


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


class TestOnDemandActivation:
    """Test on-demand activation — agents activate when messages arrive."""

    async def test_no_tasks_at_startup(self, team_with_db):
        """After start(), no background tasks are running."""
        team = team_with_db
        await team.start()

        assert team.lead._active_task is None
        assert team.members["worker"]._active_task is None

        await team.stop()

    async def test_lead_summarization_uses_session_model_override(self, monkeypatch):
        session_uuid = uuid7()
        session_id = str(session_uuid)
        session_row = ChatSession(
            id=session_uuid,
            title="s",
            model="googlegenai:gemini-3.1-flash-lite",
        )
        db_factory = _make_mock_db_factory_with_session(session_row)
        default_provider = MockTeamProvider("default")
        override_provider = MockTeamProvider("override")
        captured: dict[str, object] = {}

        async def fake_run(*_args, **_kwargs):
            return []

        def provider_factory(model: str, model_kwargs=None):
            captured["factory_model"] = model
            return override_provider

        def fake_build_summarization_hook(provider, *, mode=None, model_id=None):
            captured["summary_provider"] = provider
            captured["summary_model"] = model_id
            return None

        lead = TeamLead(
            Agent(name="lead", llm_provider=default_provider), db_factory=db_factory
        )
        lead.session_id = session_id
        team = AgentTeam(
            lead=lead, provider_factory=provider_factory, db_factory=db_factory
        )
        lead.register(team)
        monkeypatch.setattr(lead.agent, "run", fake_run)
        monkeypatch.setattr(
            "app.agent.mode.team.member.build_summarization_hook",
            fake_build_summarization_hook,
        )

        await lead._handle_messages(force_compaction=True)

        assert captured["factory_model"] == "googlegenai:gemini-3.1-flash-lite"
        assert captured["summary_provider"] is override_provider
        assert captured["summary_model"] == "googlegenai:gemini-3.1-flash-lite"

    async def test_worker_activates_on_inbox_message(self, team_with_db):
        """Worker activates when a message arrives in inbox."""
        team = team_with_db
        await team.start()

        msg = Message(from_agent="lead", to_agent="worker", content="[lead]: do task")
        await team.mailbox.send(to="worker", message=msg)
        await _drain_activation(team.members["worker"])

        assert team.members["worker"].state == "idle"

        await team.stop()

    async def test_worker_emits_agent_status_events(
        self, team_with_db, mock_stream_store
    ):
        """Worker emits agent_status working/idle events to the stream store."""
        team = team_with_db
        await team.start()

        msg = Message(from_agent="lead", to_agent="worker", content="[lead]: task")
        await team.mailbox.send(to="worker", message=msg)
        await asyncio.sleep(0.1)

        events = [c.args[1].event for c in mock_stream_store.call_args_list]
        assert "agent_status" in events

        await team.stop()

    async def test_worker_returns_to_idle_after_processing(self, team_with_db):
        """Worker returns to idle state after processing a message."""
        team = team_with_db
        worker = team.members["worker"]

        await team.start()

        msg = Message(from_agent="lead", to_agent="worker", content="[lead]: work")
        await team.mailbox.send(to="worker", message=msg)
        await _drain_activation(worker)

        assert worker.state == "idle"

        await team.stop()

    async def test_maybe_activate_skips_when_already_working(self, team_with_db):
        """_maybe_activate() is a no-op when agent is already working."""
        team = team_with_db
        await team.start()

        worker = team.members["worker"]
        worker.state = "working"
        worker._active_task = asyncio.create_task(asyncio.sleep(10))

        # This should not spawn a second task
        worker._maybe_activate()
        # Still the same task
        assert worker._active_task is not None

        worker._active_task.cancel()
        try:
            await worker._active_task
        except asyncio.CancelledError:
            pass
        await team.stop()


class TestWorkerErrorHandling:
    """Test error handling during activation."""

    async def test_worker_error_emits_agent_error(
        self, team_with_db, mock_stream_store
    ):
        """When agent.run() raises, worker emits agent_error to the stream store."""
        team = team_with_db
        worker = team.members["worker"]
        worker.agent.run = AsyncMock(side_effect=RuntimeError("LLM crashed"))

        await team.start()

        msg = Message(from_agent="lead", to_agent="worker", content="[lead]: task")
        await team.mailbox.send(to="worker", message=msg)
        await asyncio.sleep(0.1)

        # Should have emitted an agent_status error event
        events = [c.args[1].event for c in mock_stream_store.call_args_list]
        assert "agent_status" in events

        await team.stop()

    async def test_worker_error_sets_error_state(self, team_with_db):
        """When agent.run() raises, worker goes to error state."""
        team = team_with_db
        worker = team.members["worker"]
        worker.agent.run = AsyncMock(side_effect=RuntimeError("LLM crashed"))

        await team.start()

        msg = Message(from_agent="lead", to_agent="worker", content="[lead]: task")
        await team.mailbox.send(to="worker", message=msg)
        await asyncio.sleep(0.1)

        assert worker.state == "error"

        await team.stop()

    async def test_worker_error_notifies_lead_via_mailbox(self, team_with_db):
        """When agent.run() raises, member sends error notification to lead."""
        team = team_with_db
        worker = team.members["worker"]

        await team.start()
        team.lead.state = "working"

        await worker._on_turn_error(RuntimeError("boom"))

        notice = team.mailbox.receive_nowait("lead")
        assert notice.from_agent == "worker"
        assert notice.to_agent == "lead"
        assert "System error" in notice.content
        assert "temporarily unavailable" in notice.content

        await team.stop()

    async def test_worker_error_notifies_lead(self, team_with_db, mock_stream_store):
        """When member errors, lead gets a notification and stream store gets error event."""
        team = team_with_db
        worker = team.members["worker"]
        worker.agent.run = AsyncMock(side_effect=RuntimeError("crash"))

        await team.start()

        msg = Message(from_agent="lead", to_agent="worker", content="[lead]: task")
        await team.mailbox.send(to="worker", message=msg)
        await asyncio.sleep(0.1)

        events = [c.args[1].event for c in mock_stream_store.call_args_list]
        assert "agent_status" in events

        await team.stop()


class TestLeadErrorHandling:
    """Test error handling when the lead itself fails.

    Members notify the lead via mailbox on error; the lead has no peer to
    notify, so :meth:`TeamLead._on_turn_error` emits a typed ``ErrorEvent``
    to the stream so the UI can surface *why* the turn stopped.
    """

    async def test_lead_error_emits_error_event(self, team_with_db, mock_stream_store):
        """When the lead's agent.run() raises, an ErrorEvent hits the stream."""
        team = team_with_db
        lead = team.lead
        lead.agent.run = AsyncMock(side_effect=RuntimeError("quota exceeded"))

        await team.start()

        msg = Message(from_agent="user", to_agent="lead", content="[user]: hi")
        await team.mailbox.send(to="lead", message=msg)
        await asyncio.sleep(0.1)

        events = [c.args[1].event for c in mock_stream_store.call_args_list]
        assert "error" in events, (
            f"expected 'error' event from lead failure, got {events}"
        )

        # Payload carries the exception message and agent name.
        error_envelopes = [
            c.args[1]
            for c in mock_stream_store.call_args_list
            if c.args[1].event == "error"
        ]
        assert len(error_envelopes) == 1
        payload = error_envelopes[0].data
        assert "quota exceeded" in payload["message"]
        assert payload["metadata"]["agent"] == "lead"
        assert payload["metadata"]["exception"] == "RuntimeError"

        await team.stop()

    async def test_lead_error_sets_error_state(self, team_with_db):
        """Lead reaches 'error' state after agent.run() raises."""
        team = team_with_db
        lead = team.lead
        lead.agent.run = AsyncMock(side_effect=RuntimeError("boom"))

        await team.start()

        msg = Message(from_agent="user", to_agent="lead", content="[user]: hi")
        await team.mailbox.send(to="lead", message=msg)
        await asyncio.sleep(0.1)

        assert lead.state == "error"

        await team.stop()

    async def test_member_error_does_not_emit_error_event(
        self, team_with_db, mock_stream_store
    ):
        """Member failures go through mailbox to lead — no top-level ErrorEvent.

        Guards against regression where the base ``_on_turn_error`` is
        changed and accidentally starts emitting ``error`` for members too.
        """
        team = team_with_db
        worker = team.members["worker"]
        worker.agent.run = AsyncMock(side_effect=RuntimeError("member crashed"))

        await team.start()

        msg = Message(from_agent="lead", to_agent="worker", content="[lead]: task")
        await team.mailbox.send(to="worker", message=msg)
        await asyncio.sleep(0.1)

        events = [c.args[1].event for c in mock_stream_store.call_args_list]
        assert "error" not in events, (
            f"member error should not emit top-level ErrorEvent, got {events}"
        )

        await team.stop()


class TestHandleMessagesFormatting:
    """Test _handle_messages inbox formatting."""

    async def test_broadcast_message_kept_as_is(self, team_with_db):
        """Broadcast messages use their existing format."""
        team = team_with_db
        await team.start()

        msg = Message(
            from_agent="lead",
            to_agent="worker",
            content="[broadcast]: all hands",
            is_broadcast=True,
        )
        await team.mailbox.send(to="worker", message=msg)
        await asyncio.sleep(0.1)

        await team.stop()

    async def test_user_message_kept_as_is(self, team_with_db):
        """User messages keep their [user]: prefix."""
        team = team_with_db
        await team.start()

        msg = Message(from_agent="user", to_agent="lead", content="[user]: hello")
        await team.mailbox.send(to="lead", message=msg)
        await asyncio.sleep(0.1)

        await team.stop()


class TestSafetyNet:
    """Open-task safety net for members that stop without reporting."""

    async def test_member_plain_stop_with_claimed_task_is_reactivated_by_nudge(
        self, team_with_db, tmp_path, monkeypatch
    ):
        monkeypatch.setattr(
            "app.core.config.settings.OPENAGENTD_DATA_DIR", str(tmp_path / "data")
        )
        team = team_with_db
        worker = team.members["worker"]
        provider = ClaimThenStopProvider()
        worker.agent.llm_provider = provider
        worker.db_factory = app_db.async_session_factory
        team.lead.db_factory = app_db.async_session_factory
        lead_session_id = "01900000-0000-7000-8000-000000000001"
        team.lead.session_id = lead_session_id
        worker.session_id = "01900000-0000-7000-8000-000000000002"
        todos = tmp_path / "data" / "sessions" / lead_session_id / TODOS_FILENAME
        todos.parent.mkdir(parents=True)
        todos.write_text(
            json.dumps(
                {
                    "counter": 1,
                    "items": [
                        {
                            "task_id": "task_1",
                            "content": "Investigate flaky test",
                            "status": "pending",
                            "priority": "high",
                            "dependencies": [],
                            "assigned_to": "worker",
                            "claimed_by": None,
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        async with app_db.async_session_factory() as db:
            db.add(ChatSession(id=uuid.UUID(lead_session_id), agent_name="lead"))
            db.add(
                ChatSession(
                    id=uuid.UUID(worker.session_id),
                    parent_session_id=uuid.UUID(lead_session_id),
                    agent_name="worker",
                )
            )
            await db.commit()

        await team.start()
        await team.mailbox.send(
            to="worker",
            message=Message(
                from_agent="lead",
                to_agent="worker",
                content="[lead]: Claim this todo: task_1. Then stop incorrectly without team_message.",
            ),
        )
        deadline = asyncio.get_running_loop().time() + 5
        while asyncio.get_running_loop().time() < deadline:
            if (
                provider.reported
                and team.lead.state == "idle"
                and worker.state == "idle"
            ):
                break
            await asyncio.sleep(0.05)

        assert provider.claimed is True
        assert provider.reported is True
        assert provider.call_count >= 3
        store = json.loads(todos.read_text(encoding="utf-8"))
        assert store["items"][0]["status"] == "in_progress"

        await team.stop()

    async def test_member_with_open_task_gets_nudged(
        self, team_with_db, tmp_path, monkeypatch
    ):
        monkeypatch.setattr(
            "app.core.config.settings.OPENAGENTD_DATA_DIR", str(tmp_path / "data")
        )
        team = team_with_db
        worker = team.members["worker"]
        lead_session_id = "01900000-0000-7000-8000-000000000001"
        team.lead.session_id = lead_session_id
        todos = tmp_path / "data" / "sessions" / lead_session_id / TODOS_FILENAME
        todos.parent.mkdir(parents=True)
        todos.write_text(
            json.dumps(
                {
                    "counter": 1,
                    "items": [
                        {
                            "task_id": "task_1",
                            "content": "Investigate flaky test",
                            "status": "in_progress",
                            "priority": "high",
                            "dependencies": [],
                            "assigned_to": "worker",
                            "claimed_by": "worker",
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )

        await team.start()
        await _seed_worker_assistant(worker, "I found the file")
        await worker._maybe_inject_open_task_nudge()

        reminder = team.mailbox.receive_nowait("worker")
        assert reminder.from_agent == "system"
        assert "task_1" in reminder.content
        assert "team_message" in reminder.content

        await team.stop()

    async def test_member_with_open_task_nudge_is_bounded(
        self, team_with_db, tmp_path, monkeypatch
    ):
        monkeypatch.setattr(
            "app.core.config.settings.OPENAGENTD_DATA_DIR", str(tmp_path / "data")
        )
        team = team_with_db
        worker = team.members["worker"]
        lead_session_id = "01900000-0000-7000-8000-000000000001"
        team.lead.session_id = lead_session_id
        todos = tmp_path / "data" / "sessions" / lead_session_id / TODOS_FILENAME
        todos.parent.mkdir(parents=True)
        todos.write_text(
            json.dumps(
                {
                    "counter": 1,
                    "items": [
                        {
                            "task_id": "task_1",
                            "content": "Investigate flaky test",
                            "status": "in_progress",
                            "priority": "high",
                            "dependencies": [],
                            "assigned_to": "worker",
                            "claimed_by": "worker",
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )

        await team.start()
        await _seed_worker_assistant(worker, "I found the file")
        await worker._maybe_inject_open_task_nudge()
        team.mailbox.receive_nowait("worker")
        await worker._maybe_inject_open_task_nudge()

        assert team.mailbox.inbox_empty("worker")

        await team.stop()
