"""Team behaviour while the lead is suspended on a question.

A suspended lead is neither working nor idle: the turn is still open, but no
coroutine is running it.  Everything that asks "is this agent busy?" has to
agree on that, or a member's report will spawn a second activation on top of a
half-finished turn and feed the model a placeholder tool result.
"""

from __future__ import annotations

import uuid
import tempfile
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.agent.agent_loop import Agent
from app.agent.mode.team.mailbox import Message
from app.agent.mode.team.member import (
    AlreadyWorkingError,
    TeamLead,
    TeamMember,
    is_busy,
)
from app.agent.mode.team.team import AgentTeam
from tests.agent.mode.team.conftest import MockTeamProvider

LEAD_SESSION = "018f0000-0000-7000-8000-000000000001"


def _make_db_factory():
    mock_db = MagicMock()
    mock_db.commit = AsyncMock()
    mock_db.flush = AsyncMock()
    mock_db.get = AsyncMock(return_value=None)
    mock_db.add = MagicMock()
    mock_db.exec = AsyncMock(
        return_value=MagicMock(
            all=MagicMock(return_value=[]),
            first=MagicMock(return_value=None),
        )
    )

    @asynccontextmanager
    async def factory():
        yield mock_db

    return factory


def _make_team() -> AgentTeam:
    db_factory = _make_db_factory()
    lead = TeamLead(
        Agent(name="openagentd", llm_provider=MockTeamProvider()),
        session_id=LEAD_SESSION,
        db_factory=db_factory,
    )
    member = TeamMember(
        Agent(name="coder", llm_provider=MockTeamProvider()),
        session_id="018f0000-0000-7000-8000-000000000002",
        db_factory=db_factory,
    )
    team = AgentTeam(
        lead=lead,
        members={"coder#1": member},
        workspace=tempfile.mkdtemp(prefix="openagentd-team-"),
    )
    lead.register(team)
    member.register(team)
    return team


# ---------------------------------------------------------------------------
# is_busy predicate
# ---------------------------------------------------------------------------


def test_waiting_input_counts_as_busy():
    assert is_busy("working") is True
    assert is_busy("waiting_input") is True
    assert is_busy("idle") is False
    assert is_busy("error") is False


# ---------------------------------------------------------------------------
# Activation guards
# ---------------------------------------------------------------------------


def test_member_message_does_not_activate_a_suspended_lead():
    team = _make_team()
    team.lead.state = "waiting_input"

    team.lead._maybe_activate()

    assert team.lead.state == "waiting_input"
    assert team.lead._active_task is None


async def test_member_message_stays_queued_while_the_lead_is_suspended():
    """Held, not dropped — TeamInboxHook drains it into the resumed turn."""
    team = _make_team()
    team.lead.state = "waiting_input"
    assert team.mailbox is not None

    await team.mailbox.send(
        to="openagentd",
        message=Message(from_agent="coder#1", to_agent="openagentd", content="done"),
    )

    assert team.mailbox.inbox_empty("openagentd") is False
    assert team.lead._active_task is None


def test_compaction_is_refused_while_suspended():
    team = _make_team()
    team.lead.state = "waiting_input"

    with pytest.raises(AlreadyWorkingError):
        team.lead.activate_for_compaction()


# ---------------------------------------------------------------------------
# Turn completion
# ---------------------------------------------------------------------------


async def test_done_is_not_emitted_while_the_lead_is_suspended():
    team = _make_team()
    team._has_active_turn = True
    team.lead.state = "waiting_input"
    for member in team.members.values():
        member.state = "idle"

    emitted: list[str] = []
    team._emit = AsyncMock(side_effect=lambda **kw: emitted.append(kw.get("event", "")))

    await team._try_emit_done()

    assert team._has_active_turn is True


def test_a_suspended_lead_still_counts_as_an_active_user_turn():
    """The scheduler skips a fire while a turn is open — including a suspended one."""
    team = _make_team()
    team._has_active_turn = False
    team.lead.state = "waiting_input"

    assert team.has_active_user_turn() is True


# ---------------------------------------------------------------------------
# Tool injection gate
# ---------------------------------------------------------------------------


def test_coding_lead_gets_the_question_tool():
    team = _make_team()

    names = {tool.name for tool in team.get_injected_tools("openagentd")}

    assert "ask_user" in names


def test_members_never_get_the_question_tool():
    team = _make_team()

    names = {tool.name for tool in team.get_injected_tools("coder#1")}

    assert "ask_user" not in names


def test_scheduler_owned_session_does_not_get_the_question_tool():
    """Nobody is there to answer a cron job's question."""
    team = _make_team()
    team.lead.is_scheduler_session = True

    names = {tool.name for tool in team.get_injected_tools("openagentd")}

    assert "ask_user" not in names


# ---------------------------------------------------------------------------
# Resume
# ---------------------------------------------------------------------------


async def test_activate_for_question_answer_marks_the_run_as_a_resume():
    """The resumed turn must not be able to ask again."""
    team = _make_team()
    team.lead.state = "waiting_input"
    captured: dict = {}

    async def fake_handle_messages(**kwargs):
        captured.update(kwargs)

    team.lead._handle_messages = fake_handle_messages  # type: ignore[method-assign]

    team.lead.activate_for_question_answer()
    assert team.lead._active_task is not None
    await team.lead._active_task

    assert captured.get("question_resume") is True
    assert team.lead.state == "idle"


def test_answer_activation_is_refused_when_already_working():
    team = _make_team()
    team.lead.state = "working"

    with pytest.raises(AlreadyWorkingError):
        team.lead.activate_for_question_answer()


# ---------------------------------------------------------------------------
# Guard of last resort
# ---------------------------------------------------------------------------


async def test_activation_aborts_when_a_question_is_still_pending(monkeypatch):
    """Catches every wake path, including ones the state flag missed."""
    team = _make_team()
    team.lead.state = "working"

    row = MagicMock()
    row.id = uuid.uuid4()
    row.payload = {"questions": []}

    async def fake_get_pending(db, session_id):
        return row

    monkeypatch.setattr(
        "app.services.question_service.get_pending_question", fake_get_pending
    )
    called = False

    async def fake_handle_messages(**kwargs):
        nonlocal called
        called = True

    team.lead._handle_messages = fake_handle_messages  # type: ignore[method-assign]
    assert team.mailbox is not None
    await team.mailbox.send(
        to="openagentd",
        message=Message(from_agent="coder#1", to_agent="openagentd", content="hi"),
    )

    await team.lead._run_activation()

    assert called is False
    assert team.lead.state == "waiting_input"


# ---------------------------------------------------------------------------
# Dismissal + rehydration
# ---------------------------------------------------------------------------


async def test_stop_dismisses_a_pending_question(monkeypatch):
    """Otherwise the session stays badged 'needs input' with no turn to resume."""
    team = _make_team()
    team.lead.state = "waiting_input"
    team.lead._question_suspended = {"question_id": uuid.uuid4()}

    row = MagicMock()
    row.id = uuid.uuid4()
    resolved: dict = {}

    async def fake_get_pending(db, session_id):
        return row

    async def fake_resolve(db, *, question_id, status, answers=None):
        resolved["status"] = status
        return row

    monkeypatch.setattr(
        "app.services.question_service.get_pending_question", fake_get_pending
    )
    monkeypatch.setattr(
        "app.services.question_service.resolve_pending_question", fake_resolve
    )

    assert await team.dismiss_pending_question(reason="dismissed") is True
    assert resolved["status"] == "dismissed"
    assert team.lead.state == "idle"
    assert team.lead._question_suspended is None


async def test_dismiss_is_a_noop_without_a_pending_question(monkeypatch):
    team = _make_team()

    async def fake_get_pending(db, session_id):
        return None

    monkeypatch.setattr(
        "app.services.question_service.get_pending_question", fake_get_pending
    )

    assert await team.dismiss_pending_question(reason="dismissed") is False


async def test_the_lead_parks_in_waiting_input_when_the_loop_suspends(
    monkeypatch, mock_stream_store
):
    """The suspension has to survive the trip back from ``Agent.run``.

    The loop reports it by writing into ``config.metadata``. ``RunConfig`` is a
    Pydantic model, so that dict is a *copy* of the one the caller passed —
    reading the caller's original never sees the flag, the lead goes ``idle``
    instead of ``waiting_input``, and the team emits ``done`` on a turn that is
    actually still waiting on the user.
    """
    team = _make_team()
    question_id = uuid.uuid4()

    async def fake_run(messages, *, config=None, **kwargs):
        config.metadata["question_suspended"] = {
            "question_id": question_id,
            "session_id": uuid.UUID(LEAD_SESSION),
            "tool_call_id": "call-1",
        }
        return []

    monkeypatch.setattr(team.lead.agent, "run", fake_run)
    monkeypatch.setattr(
        team.lead, "_persist_inbox", AsyncMock(return_value=[]), raising=False
    )

    await team.handle_user_message("ask me something", session_id=LEAD_SESSION)
    if team.lead._active_task is not None:
        await team.lead._active_task

    assert team.lead.state == "waiting_input"
    assert is_busy(team.lead.state) is True

    events = [call.args[1].event for call in mock_stream_store.call_args_list]
    # A suspended turn is not a finished turn: `done` would tell every client to
    # close the turn out from under the question card.
    assert "done" not in events


async def test_answering_resumes_the_turn_and_then_completes_it(
    monkeypatch, mock_stream_store
):
    """The whole round trip, across the seams that unit tests each half of.

    Suspend, park, resume on the answer, and finish. Every bug in this feature
    so far has lived between two layers that were each correct on their own, so
    this walks the full path: the loop reports a suspension, the member parks,
    the resume spends the turn's one interruption, and the team emits exactly
    one ``done`` — at the end, not at the suspension.
    """
    team = _make_team()
    resume_flags: list = []

    async def fake_run(messages, *, config=None, **kwargs):
        resume_flags.append(config.metadata.get("question_resume"))
        if len(resume_flags) == 1:
            config.metadata["question_suspended"] = {
                "question_id": uuid.uuid4(),
                "session_id": uuid.UUID(LEAD_SESSION),
                "tool_call_id": "call-1",
            }
        return []

    monkeypatch.setattr(team.lead.agent, "run", fake_run)
    monkeypatch.setattr(
        team.lead, "_persist_inbox", AsyncMock(return_value=[]), raising=False
    )

    await team.handle_user_message("ask me something", session_id=LEAD_SESSION)
    if team.lead._active_task is not None:
        await team.lead._active_task

    assert team.lead.state == "waiting_input"
    assert "done" not in [c.args[1].event for c in mock_stream_store.call_args_list]

    team.lead.activate_for_question_answer()
    assert team.lead._active_task is not None
    await team.lead._active_task

    assert team.lead.state == "idle"
    # The resumed activation spends the turn's one interruption up front, so a
    # second question cannot be asked on the way back.
    assert resume_flags == [None, True]

    events = [c.args[1].event for c in mock_stream_store.call_args_list]
    assert events.count("done") == 1


async def test_a_question_cannot_be_answered_twice(monkeypatch):
    """Two devices race; the loser must not start a second turn.

    The guarded UPDATE in ``resolve_pending_question`` is what makes this
    atomic, and a second resume on the same turn would replay the tail.
    """
    team = _make_team()
    team.lead.state = "waiting_input"
    row = MagicMock()
    row.id = uuid.uuid4()
    resolved: dict = {}

    async def fake_get_pending(db, session_id):
        return None if resolved else row

    async def fake_resolve(db, *, question_id, status, answers=None):
        if resolved:
            return None
        resolved["status"] = status
        return row

    monkeypatch.setattr(
        "app.services.question_service.get_pending_question", fake_get_pending
    )
    monkeypatch.setattr(
        "app.services.question_service.resolve_pending_question", fake_resolve
    )

    first = await team.dismiss_pending_question(reason="dismissed")
    second = await team.dismiss_pending_question(reason="dismissed")

    assert first is True
    assert second is False


# ---------------------------------------------------------------------------
# Supersede vs defer
# ---------------------------------------------------------------------------


async def test_a_typed_user_message_supersedes_the_question(monkeypatch):
    """Typing instead of answering means the user moved on."""
    team = _make_team()
    team.lead.state = "waiting_input"
    resolved: dict = {}

    row = MagicMock()
    row.id = uuid.uuid4()

    async def fake_get_pending(db, session_id):
        return None if resolved else row

    async def fake_resolve(db, *, question_id, status, answers=None):
        resolved["status"] = status
        return row

    monkeypatch.setattr(
        "app.services.question_service.get_pending_question", fake_get_pending
    )
    monkeypatch.setattr(
        "app.services.question_service.resolve_pending_question", fake_resolve
    )
    monkeypatch.setattr(
        team.lead, "_persist_inbox", AsyncMock(return_value=[]), raising=False
    )

    await team.handle_user_message("forget it, fix the tests", session_id=LEAD_SESSION)

    assert resolved["status"] == "superseded"


async def test_superseding_a_question_tells_the_clients(monkeypatch, mock_stream_store):
    """Resolving the row is not enough — the card is only on screen.

    Every other resolution path broadcasts. Without this one, a client that
    typed instead of answering is left holding an open question that the server
    has already closed, and it has no way to learn otherwise until a reload.
    """
    team = _make_team()
    team.lead.state = "waiting_input"
    row = MagicMock()
    row.id = uuid.uuid4()
    resolved: dict = {}

    async def fake_get_pending(db, session_id):
        return None if resolved else row

    async def fake_resolve(db, *, question_id, status, answers=None):
        resolved["status"] = status
        return row

    monkeypatch.setattr(
        "app.services.question_service.get_pending_question", fake_get_pending
    )
    monkeypatch.setattr(
        "app.services.question_service.resolve_pending_question", fake_resolve
    )
    monkeypatch.setattr(
        team.lead, "_persist_inbox", AsyncMock(return_value=[]), raising=False
    )

    await team.handle_user_message("actually, do this instead", session_id=LEAD_SESSION)

    dismissals = [
        call.args[1]
        for call in mock_stream_store.call_args_list
        if call.args[1].event == "question_dismissed"
    ]
    assert len(dismissals) == 1
    assert dismissals[0].data["reason"] == "superseded"
    assert dismissals[0].data["question_id"] == str(row.id)


async def test_dismissal_targets_the_named_session_not_the_lead_binding(monkeypatch):
    """Stop names the session; the lead's own binding may be stale.

    A coding team is cached per (workspace, session) and rebuilt after the idle
    window with a freshly minted lead session id. Only ``handle_user_message``
    rebinds it, so an interrupt-only request can reach a lead pointing at a
    session that never had a question.
    """
    team = _make_team()
    team.lead.session_id = "019fd000-0000-7000-8000-00000000dead"
    looked_up: list = []
    row = MagicMock()
    row.id = uuid.uuid4()

    async def fake_get_pending(db, session_id):
        looked_up.append(session_id)
        return row

    monkeypatch.setattr(
        "app.services.question_service.get_pending_question", fake_get_pending
    )
    monkeypatch.setattr(
        "app.services.question_service.resolve_pending_question",
        AsyncMock(return_value=row),
    )

    closed = await team.dismiss_pending_question(
        reason="dismissed", session_id=LEAD_SESSION
    )

    assert closed is True
    assert looked_up == [uuid.UUID(LEAD_SESSION)]


async def test_a_scheduled_message_defers_instead_of_superseding(monkeypatch):
    """A cron job must not cancel a question the user has not seen."""
    from app.agent.mode.team.team import QuestionPendingError

    team = _make_team()
    team.lead.state = "waiting_input"
    resolved: dict = {}

    row = MagicMock()
    row.id = uuid.uuid4()

    async def fake_get_pending(db, session_id):
        return row

    async def fake_resolve(db, *, question_id, status, answers=None):
        resolved["status"] = status
        return row

    monkeypatch.setattr(
        "app.services.question_service.get_pending_question", fake_get_pending
    )
    monkeypatch.setattr(
        "app.services.question_service.resolve_pending_question", fake_resolve
    )

    with pytest.raises(QuestionPendingError):
        await team.handle_user_message(
            "[Scheduled Task: nightly]", session_id=LEAD_SESSION, origin="scheduler"
        )

    assert resolved == {}
    assert team.lead.state == "waiting_input"
