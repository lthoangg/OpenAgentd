"""Tests for the ``ask_user`` HTTP routes.

Covers the full resolution round-trip against a real DB row:

- ``GET  /{sid}/question``                 — cold load / reconnect
- ``POST /{sid}/question/{qid}/answer``    — resolve and resume the turn
- ``POST /{sid}/question/{qid}/dismiss``   — resolve and stop the turn

Answer payloads are the only untrusted input on this path, so the validation
cases (unknown label, free text where it is disallowed, oversized text, stale
question id) are covered as carefully as the happy path.
"""

from __future__ import annotations

import asyncio
import uuid
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.models.chat import ChatSession
from app.services import question_service

QUESTIONS = [
    {
        "question": "Which package manager?",
        "header": "Package manager",
        "multiple": False,
        "custom": True,
        "options": [
            {"label": "pnpm", "description": "Fast", "recommended": True},
            {"label": "bun", "description": "Faster", "recommended": False},
        ],
    },
    {
        "question": "Which checks?",
        "header": "Checks",
        "multiple": True,
        "custom": False,
        "options": [
            {"label": "lint", "recommended": True},
            {"label": "test", "recommended": True},
            {"label": "build"},
        ],
    },
]


@pytest.fixture
def app() -> FastAPI:
    from app.api.routes.team.questions import router

    application = FastAPI()
    application.include_router(router)
    return application


@pytest.fixture
async def client(app: FastAPI):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


class _FakeLead:
    def __init__(self) -> None:
        self.name = "openagentd"
        self.state = "waiting_input"
        self._question_suspended = {"question_id": "x"}
        self.resumed = 0

    def activate_for_question_answer(self) -> None:
        self.resumed += 1
        self.state = "working"


class _FakeTeam:
    def __init__(self, session_id: str) -> None:
        self.lead = _FakeLead()
        self.lead.session_id = session_id  # type: ignore[attr-defined]
        self.mode = "coding"
        self.turns_ended = 0
        self.attached: list[str] = []
        self.started_with = None

    async def _try_emit_done(self) -> None:
        self.turns_ended += 1

    async def attach_lead_to_session(self, session_id: str, *, title=None) -> None:
        self.attached.append(session_id)
        self.lead.session_id = session_id


async def _seed(
    session_id: uuid.UUID,
    call_id: str = "call_1",
    questions: list[dict] | None = None,
):
    """Create a session with a suspended question and return the row id."""
    from app.agent.schemas.chat import AssistantMessage
    from app.core import db as core_db
    from app.services.chat_service import save_message

    async with core_db.async_session_factory() as db:
        db.add(ChatSession(id=session_id, agent_name="openagentd", mode="coding"))
        await db.commit()
        await save_message(
            db,
            session_id,
            AssistantMessage(
                content=None,
                tool_calls=[
                    {
                        "id": call_id,
                        "type": "function",
                        "function": {"name": "ask_user", "arguments": "{}"},
                    }
                ],
            ),
        )
        row = await question_service.create_pending_question(
            db,
            session_id=session_id,
            tool_call_id=call_id,
            questions=questions if questions is not None else QUESTIONS,
        )
        question_id = row.id
        await db.commit()
    return question_id


@pytest.fixture
def team(monkeypatch):
    """Patch team resolution so the routes talk to a fake lead."""
    holder: dict = {}

    async def fake_get_team_for_session(session_id: str):
        return holder.get("team")

    monkeypatch.setattr(
        "app.api.routes.team.questions.get_team_for_session",
        fake_get_team_for_session,
    )
    return holder


# ---------------------------------------------------------------------------
# GET
# ---------------------------------------------------------------------------


async def test_get_returns_the_open_question(client, team):
    session_id = uuid.uuid4()
    question_id = await _seed(session_id)
    team["team"] = _FakeTeam(str(session_id))

    resp = await client.get(f"/{session_id}/question")

    assert resp.status_code == 200
    body = resp.json()
    assert body["question"]["id"] == str(question_id)
    assert len(body["question"]["questions"]) == 2
    assert body["question"]["questions"][0]["options"][0]["recommended"] is True


def _history_app(session_id: uuid.UUID) -> FastAPI:
    """Minimal app exposing the history route with the team dependency stubbed."""
    from app.api.deps import get_team
    from app.api.routes.team import chat as chat_routes

    application = FastAPI()
    application.include_router(chat_routes.router)
    application.dependency_overrides[get_team] = lambda: _FakeTeam(str(session_id))
    return application


async def test_history_carries_the_open_question():
    """A cold load must learn about the question from the history it already fetches.

    The SSE replay buffer is in-memory, so after a daemon restart it no longer
    holds the ``question_asked`` event — but the row is still open and the lead
    is still suspended. Embedding it in the history response is what makes the
    card survive a restart, and it lets the client set the lead's status and
    render the card in one pass instead of a second waterfall request.
    """
    session_id = uuid.uuid4()
    question_id = await _seed(session_id)

    transport = ASGITransport(app=_history_app(session_id))
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        resp = await c.get(f"/{session_id}/history")

    assert resp.status_code == 200
    pending = resp.json()["pending_question"]
    assert pending is not None
    assert pending["id"] == str(question_id)
    assert pending["tool_call_id"] == "call_1"
    assert pending["questions"][0]["header"] == "Package manager"


async def test_history_reports_no_question_when_none_is_open():
    from app.core import db as core_db

    session_id = uuid.uuid4()
    async with core_db.async_session_factory() as db:
        db.add(ChatSession(id=session_id, agent_name="openagentd", mode="coding"))
        await db.commit()

    transport = ASGITransport(app=_history_app(session_id))
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        resp = await c.get(f"/{session_id}/history")

    assert resp.status_code == 200
    assert resp.json()["pending_question"] is None


async def test_get_returns_null_when_nothing_is_pending(client, team):
    session_id = uuid.uuid4()
    from app.core import db as core_db

    async with core_db.async_session_factory() as db:
        db.add(ChatSession(id=session_id, agent_name="openagentd", mode="coding"))
        await db.commit()
    team["team"] = _FakeTeam(str(session_id))

    resp = await client.get(f"/{session_id}/question")

    assert resp.status_code == 200
    assert resp.json()["question"] is None


# ---------------------------------------------------------------------------
# Answer
# ---------------------------------------------------------------------------


async def test_answer_resolves_and_resumes_the_turn(client, team):
    session_id = uuid.uuid4()
    question_id = await _seed(session_id)
    fake_team = _FakeTeam(str(session_id))
    team["team"] = fake_team

    resp = await client.post(
        f"/{session_id}/question/{question_id}/answer",
        json={"answers": [["pnpm"], ["lint", "test"]]},
    )

    assert resp.status_code == 200
    assert resp.json() == {"status": "ok", "resumed": True}
    assert fake_team.lead.resumed == 1

    from app.core import db as core_db

    async with core_db.async_session_factory() as db:
        assert await question_service.get_pending_question(db, session_id) is None


async def test_answer_accepts_free_text_when_custom_is_allowed(client, team):
    session_id = uuid.uuid4()
    question_id = await _seed(session_id)
    team["team"] = _FakeTeam(str(session_id))

    resp = await client.post(
        f"/{session_id}/question/{question_id}/answer",
        json={"answers": [["yarn, actually"], ["lint"]]},
    )

    assert resp.status_code == 200


async def test_answer_rejects_free_text_when_custom_is_disallowed(client, team):
    """Question 2 has custom=false — only its own labels are acceptable."""
    session_id = uuid.uuid4()
    question_id = await _seed(session_id)
    team["team"] = _FakeTeam(str(session_id))

    resp = await client.post(
        f"/{session_id}/question/{question_id}/answer",
        json={"answers": [["pnpm"], ["deploy to prod"]]},
    )

    assert resp.status_code == 422


async def test_answer_rejects_multiple_selections_on_a_single_select_question(
    client, team
):
    session_id = uuid.uuid4()
    question_id = await _seed(session_id)
    team["team"] = _FakeTeam(str(session_id))

    resp = await client.post(
        f"/{session_id}/question/{question_id}/answer",
        json={"answers": [["pnpm", "bun"], ["lint"]]},
    )

    assert resp.status_code == 422


async def test_answer_rejects_too_many_answer_groups(client, team):
    session_id = uuid.uuid4()
    question_id = await _seed(session_id)
    team["team"] = _FakeTeam(str(session_id))

    resp = await client.post(
        f"/{session_id}/question/{question_id}/answer",
        json={"answers": [["pnpm"], ["lint"], ["extra"]]},
    )

    assert resp.status_code == 422


async def test_answer_rejects_oversized_free_text(client, team):
    session_id = uuid.uuid4()
    question_id = await _seed(session_id)
    team["team"] = _FakeTeam(str(session_id))

    resp = await client.post(
        f"/{session_id}/question/{question_id}/answer",
        json={"answers": [["x" * 3000], ["lint"]]},
    )

    assert resp.status_code == 422


#: Multi-select *and* free-text: the combination where a label check alone
#: bounds nothing, because any string is an acceptable value.
MULTI_CUSTOM = [
    {
        "question": "Which checks?",
        "header": "Checks",
        "multiple": True,
        "custom": True,
        "options": [
            {"label": "lint", "recommended": True},
            {"label": "test", "recommended": True},
        ],
    }
]


async def test_answer_rejects_more_selections_than_were_offered(client, team):
    """A multi-select free-text question is not an unbounded context sink.

    Per-value length was capped but the *count* was not, so a client could post
    thousands of free-text entries — 2 KB each by the per-value cap — straight
    into the model's context window. The honest bound is "every option that was
    offered, plus one answer of your own".
    """
    session_id = uuid.uuid4()
    question_id = await _seed(session_id, questions=MULTI_CUSTOM)
    team["team"] = _FakeTeam(str(session_id))

    resp = await client.post(
        f"/{session_id}/question/{question_id}/answer",
        json={"answers": [["a", "b", "c", "d", "e", "f"]]},
    )

    assert resp.status_code == 422


async def test_answer_allows_every_option_plus_one_custom_answer(client, team):
    """The cap must not reject a legitimate maximal reply."""
    session_id = uuid.uuid4()
    question_id = await _seed(session_id, questions=MULTI_CUSTOM)
    team["team"] = _FakeTeam(str(session_id))

    resp = await client.post(
        f"/{session_id}/question/{question_id}/answer",
        json={"answers": [["lint", "test", "and also typecheck"]]},
    )

    assert resp.status_code == 200


async def test_partial_answers_are_allowed(client, team):
    """Skipping a question is a legitimate reply, reported as Unanswered."""
    session_id = uuid.uuid4()
    question_id = await _seed(session_id)
    team["team"] = _FakeTeam(str(session_id))

    resp = await client.post(
        f"/{session_id}/question/{question_id}/answer",
        json={"answers": [["pnpm"], []]},
    )

    assert resp.status_code == 200


async def test_second_answer_loses_the_race(client, team):
    """Two devices answering: the loser gets 409, not a second resume."""
    session_id = uuid.uuid4()
    question_id = await _seed(session_id)
    fake_team = _FakeTeam(str(session_id))
    team["team"] = fake_team

    first = await client.post(
        f"/{session_id}/question/{question_id}/answer",
        json={"answers": [["pnpm"], ["lint"]]},
    )
    second = await client.post(
        f"/{session_id}/question/{question_id}/answer",
        json={"answers": [["bun"], ["test"]]},
    )

    assert first.status_code == 200
    assert second.status_code == 409
    assert fake_team.lead.resumed == 1


async def test_answer_reports_when_the_resume_could_not_start(client, team):
    """The answer is saved either way — the UI offers a manual resume."""
    from app.agent.mode.team.member import AlreadyWorkingError

    session_id = uuid.uuid4()
    question_id = await _seed(session_id)
    fake_team = _FakeTeam(str(session_id))

    def boom() -> None:
        raise AlreadyWorkingError("openagentd")

    fake_team.lead.activate_for_question_answer = boom  # type: ignore[method-assign]
    team["team"] = fake_team

    resp = await client.post(
        f"/{session_id}/question/{question_id}/answer",
        json={"answers": [["pnpm"], ["lint"]]},
    )

    assert resp.status_code == 200
    assert resp.json() == {"status": "ok", "resumed": False}

    from app.core import db as core_db

    async with core_db.async_session_factory() as db:
        assert await question_service.get_pending_question(db, session_id) is None


async def test_answer_for_an_unknown_question_is_404(client, team):
    session_id = uuid.uuid4()
    await _seed(session_id)
    team["team"] = _FakeTeam(str(session_id))

    resp = await client.post(
        f"/{session_id}/question/{uuid.uuid4()}/answer",
        json={"answers": [["pnpm"]]},
    )

    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Dismiss
# ---------------------------------------------------------------------------


async def test_dismiss_resolves_without_resuming(client, team):
    session_id = uuid.uuid4()
    question_id = await _seed(session_id)
    fake_team = _FakeTeam(str(session_id))
    team["team"] = fake_team

    resp = await client.post(f"/{session_id}/question/{question_id}/dismiss")

    assert resp.status_code == 200
    assert fake_team.lead.resumed == 0
    assert fake_team.lead.state == "idle"

    from app.core import db as core_db

    async with core_db.async_session_factory() as db:
        assert await question_service.get_pending_question(db, session_id) is None


async def test_dismiss_ends_the_turn(client, team):
    """Dismissing has to close the turn, not just free the lead.

    A suspended lead holds an *open* turn: `waiting_input` counts as busy and
    the client is showing a live turn. Every other ending — Stop, a superseding
    message, a resumed turn running to completion — emits `done`. Without it
    here the pane stays live forever and the session list keeps the session
    marked running, with nothing left to finish it.
    """
    session_id = uuid.uuid4()
    question_id = await _seed(session_id)
    fake_team = _FakeTeam(str(session_id))
    team["team"] = fake_team

    resp = await client.post(f"/{session_id}/question/{question_id}/dismiss")

    assert resp.status_code == 200
    assert fake_team.turns_ended == 1


async def test_dismiss_ends_the_turn_on_the_named_session(client, team, monkeypatch):
    """The closer must target the session being dismissed.

    ``find_live_team_for_lead_session`` matches on the coding registry *key* as
    well as the lead binding, so it can hand back a team whose lead points
    somewhere else — a team evicted after the idle window and rebuilt gets a
    freshly minted lead session id. ``_try_emit_done`` closes
    ``self.lead.session_id``, which would end a turn on the wrong stream and
    leave this one live forever.
    """
    session_id = uuid.uuid4()
    question_id = await _seed(session_id)
    fake_team = _FakeTeam("019fd000-0000-7000-8000-00000000dead")
    team["team"] = fake_team

    pushed: list = []

    async def capture(sid, envelope):
        pushed.append((sid, envelope.event))

    monkeypatch.setattr(
        "app.api.routes.team.questions.stream_store.push_event", capture
    )
    monkeypatch.setattr(
        "app.api.routes.team.questions.stream_store.mark_done", AsyncMock()
    )

    resp = await client.post(f"/{session_id}/question/{question_id}/dismiss")

    assert resp.status_code == 200
    # Not through the stale team: that would have closed the wrong session.
    assert fake_team.turns_ended == 0
    assert (str(session_id), "done") in pushed


async def test_dismiss_ends_the_turn_with_no_live_team(client, team, monkeypatch):
    """After a restart there is no live team, but the client still shows a turn.

    The suspension is durable, so the card comes back on reload and can be
    dismissed with nothing running. Without a close, the pane stays live and
    the session list keeps the session marked running.
    """
    session_id = uuid.uuid4()
    question_id = await _seed(session_id)
    team["team"] = None

    pushed: list = []

    async def capture(sid, envelope):
        pushed.append((sid, envelope.event))

    monkeypatch.setattr(
        "app.api.routes.team.questions.stream_store.push_event", capture
    )
    monkeypatch.setattr(
        "app.api.routes.team.questions.stream_store.mark_done", AsyncMock()
    )

    resp = await client.post(f"/{session_id}/question/{question_id}/dismiss")

    assert resp.status_code == 200
    assert (str(session_id), "done") in pushed


async def test_answer_binds_a_stale_lead_before_resuming(client, team):
    """A rebuilt team's lead points at a freshly minted session.

    ``activate_for_question_answer`` runs on ``lead.session_id``, so resuming
    without binding would replay this answer's turn into another conversation.
    Binding is what ``handle_user_message`` already does for any message that
    lands on an existing session; the resume needs the same thing.
    """
    session_id = uuid.uuid4()
    question_id = await _seed(session_id)
    fake_team = _FakeTeam("019fd000-0000-7000-8000-00000000dead")
    # A rebuilt team has never run a turn, so its lead is idle.
    fake_team.lead.state = "idle"
    team["team"] = fake_team

    resp = await client.post(
        f"/{session_id}/question/{question_id}/answer",
        json={"answers": [["pnpm"], ["lint"]]},
    )

    assert resp.json()["resumed"] is True
    assert fake_team.attached == [str(session_id)]
    assert fake_team.lead.session_id == str(session_id)
    assert fake_team.lead.resumed == 1


async def test_answer_does_not_steal_a_lead_working_another_session(client, team):
    """Rebinding mid-turn would move a running activation to this session."""
    session_id = uuid.uuid4()
    question_id = await _seed(session_id)
    fake_team = _FakeTeam("019fd000-0000-7000-8000-00000000dead")
    fake_team.lead.state = "working"
    team["team"] = fake_team

    resp = await client.post(
        f"/{session_id}/question/{question_id}/answer",
        json={"answers": [["pnpm"], ["lint"]]},
    )

    assert resp.json()["resumed"] is False
    assert fake_team.attached == []
    assert fake_team.lead.resumed == 0


async def test_answer_does_not_steal_a_lead_suspended_on_another_session(client, team):
    """Another session's unanswered question outranks this resume.

    ``waiting_input`` counts as busy for exactly this reason: rebinding would
    abandon a question the user has not answered yet on the other session.
    """
    session_id = uuid.uuid4()
    question_id = await _seed(session_id)
    fake_team = _FakeTeam("019fd000-0000-7000-8000-00000000dead")
    fake_team.lead.state = "waiting_input"
    team["team"] = fake_team

    resp = await client.post(
        f"/{session_id}/question/{question_id}/answer",
        json={"answers": [["pnpm"], ["lint"]]},
    )

    assert resp.json()["resumed"] is False
    assert fake_team.attached == []


async def test_answer_starts_a_team_when_none_is_live(client, team, monkeypatch):
    """The suspension is durable, so answering must survive a daemon restart.

    Nothing is live after a restart, but the resumed turn reads its history
    from the database — a cold team can run it. Without this the answer is
    saved and the turn simply never continues.
    """
    from app.core import db as core_db
    from app.models.chat import ChatSession

    session_id = uuid.uuid4()
    question_id = await _seed(session_id)
    async with core_db.async_session_factory() as db:
        row = await db.get(ChatSession, session_id)
        row.workspace = "/tmp/ws"
        db.add(row)
        await db.commit()

    team["team"] = None
    started = _FakeTeam(str(session_id))
    started.lead.state = "waiting_input"

    async def fake_start(workspace: str, sid: str):
        started.started_with = (workspace, sid)
        return started

    monkeypatch.setattr(
        "app.services.team_manager.get_or_start_coding_team", fake_start
    )

    resp = await client.post(
        f"/{session_id}/question/{question_id}/answer",
        json={"answers": [["pnpm"], ["lint"]]},
    )

    assert resp.json()["resumed"] is True
    assert started.started_with == ("/tmp/ws", str(session_id))
    assert started.lead.resumed == 1


async def test_a_failed_resume_frees_the_lead(client, team):
    """A lead left parked with no question wedges the session.

    ``waiting_input`` counts as busy, so ``_maybe_activate`` refuses to start a
    turn — and with the question already answered nothing will ever resume it.
    The next message would sit in the inbox undelivered.
    """
    session_id = uuid.uuid4()
    question_id = await _seed(session_id)
    fake_team = _FakeTeam(str(session_id))

    def boom() -> None:
        raise RuntimeError("event loop is closed")

    fake_team.lead.activate_for_question_answer = boom  # type: ignore[method-assign]
    team["team"] = fake_team

    resp = await client.post(
        f"/{session_id}/question/{question_id}/answer",
        json={"answers": [["pnpm"], ["lint"]]},
    )

    assert resp.status_code == 200
    assert resp.json()["resumed"] is False
    assert fake_team.lead.state != "waiting_input"


async def test_a_failed_resume_closes_the_turn(client, team, monkeypatch):
    """If nothing restarts, the turn is over and the client has to be told.

    The pane is showing a live turn (``waiting_input`` reads as busy). With the
    question answered and no activation coming, only a ``done`` gets the UI out
    of it — otherwise it stays live until a reload.
    """
    session_id = uuid.uuid4()
    question_id = await _seed(session_id)
    fake_team = _FakeTeam(str(session_id))

    def boom() -> None:
        raise RuntimeError("no loop")

    fake_team.lead.activate_for_question_answer = boom  # type: ignore[method-assign]
    team["team"] = fake_team

    pushed: list = []

    async def capture(sid, envelope):
        pushed.append((sid, envelope.event))

    monkeypatch.setattr(
        "app.api.routes.team.questions.stream_store.push_event", capture
    )
    monkeypatch.setattr(
        "app.api.routes.team.questions.stream_store.mark_done", AsyncMock()
    )

    resp = await client.post(
        f"/{session_id}/question/{question_id}/answer",
        json={"answers": [["pnpm"], ["lint"]]},
    )

    assert resp.json()["resumed"] is False
    assert (str(session_id), "done") in pushed


async def test_a_successful_resume_leaves_the_turn_open(client, team, monkeypatch):
    """The resumed activation owns the turn — closing it would cut it short."""
    session_id = uuid.uuid4()
    question_id = await _seed(session_id)
    fake_team = _FakeTeam(str(session_id))
    team["team"] = fake_team

    pushed: list = []

    async def capture(sid, envelope):
        pushed.append((sid, envelope.event))

    monkeypatch.setattr(
        "app.api.routes.team.questions.stream_store.push_event", capture
    )
    monkeypatch.setattr(
        "app.api.routes.team.questions.stream_store.mark_done", AsyncMock()
    )

    resp = await client.post(
        f"/{session_id}/question/{question_id}/answer",
        json={"answers": [["pnpm"], ["lint"]]},
    )

    assert resp.json()["resumed"] is True
    assert "done" not in [event for _sid, event in pushed]


# ---------------------------------------------------------------------------
# stream state across a restart
# ---------------------------------------------------------------------------


@pytest.fixture
def turn_state():
    """The stream store's in-memory turn table, cleared around the test."""
    from app.services.memory_stream_store import _turns

    _turns.clear()
    yield _turns
    _turns.clear()


async def test_answer_restores_the_stream_when_the_turn_state_is_gone(
    client, team, turn_state
):
    """A resume has to re-establish the stream it is about to write to.

    The suspension is durable but the stream store is not: a daemon restart
    drops the whole table, and so does the sliding ``STREAM_TTL`` — a waiting
    turn emits nothing to refresh it, so simply taking an hour to answer is
    enough. ``push_event`` and ``attach`` both no-op without turn state, so
    every event of the resumed turn would go nowhere and no client could
    reattach: no streaming, and a card that never resolves anywhere else.
    """
    session_id = uuid.uuid4()
    question_id = await _seed(session_id)
    team["team"] = _FakeTeam(str(session_id))
    assert str(session_id) not in turn_state

    resp = await client.post(
        f"/{session_id}/question/{question_id}/answer",
        json={"answers": [["pnpm"], ["lint"]]},
    )

    assert resp.json()["resumed"] is True
    assert str(session_id) in turn_state
    # Attachable, or the reconnecting client is still turned away.
    assert turn_state[str(session_id)].is_streaming is True


async def test_answer_keeps_the_replay_state_of_a_live_suspension(
    client, team, turn_state
):
    """The warm path must not be reset by the repair.

    When the suspension is still in memory its accumulated state is what a
    mid-turn reconnect replays — the text and tool cards that came *before* the
    question. Re-initialising instead of ensuring would blank all of it.
    """
    from app.services import memory_stream_store as stream_store

    session_id = uuid.uuid4()
    question_id = await _seed(session_id)
    team["team"] = _FakeTeam(str(session_id))
    await stream_store.init_turn(str(session_id))
    turn_state[str(session_id)].content = {"openagentd": ["before the question"]}
    original = turn_state[str(session_id)]

    await client.post(
        f"/{session_id}/question/{question_id}/answer",
        json={"answers": [["pnpm"], ["lint"]]},
    )

    assert turn_state[str(session_id)] is original
    assert turn_state[str(session_id)].content == {
        "openagentd": ["before the question"]
    }


async def test_dismiss_delivers_its_events_when_the_turn_state_is_gone(
    client, team, turn_state
):
    """Dismissing after a restart still has to reach every connected client.

    Without turn state the ``question_dismissed`` broadcast and the ``done``
    that ends the turn are both dropped, so other devices keep showing an open
    card on a session that reads as running forever.
    """
    session_id = uuid.uuid4()
    question_id = await _seed(session_id)
    # No live team owns the session — the restart path through ``_end_turn``.
    assert str(session_id) not in turn_state

    resp = await client.post(f"/{session_id}/question/{question_id}/dismiss")

    assert resp.status_code == 200
    assert str(session_id) in turn_state
    # ``mark_done`` ran on real state, so the whole close reached the store.
    assert turn_state[str(session_id)].is_streaming is False


async def test_stream_holds_open_while_a_question_is_unanswered(turn_state):
    """End-to-end: the SSE connection must park, not close instantly.

    This is the behaviour the reconnect storm came from. With no turn state the
    generator finishes immediately, the client sees a *clean* close (so no error
    to trigger its backoff), and — because an open question correctly counts as
    a live turn — it reopens at once, over and over. Asserting on the wire is
    the only way to catch that; a unit test on the helper cannot see it.
    """
    from fastapi import FastAPI
    from app.api.routes.team.chat import router as chat_router

    session_id = uuid.uuid4()
    await _seed(session_id)

    application = FastAPI()
    application.include_router(chat_router)
    transport = ASGITransport(app=application)

    async def read_first_bytes() -> None:
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            async with ac.stream("GET", f"/{session_id}/stream") as resp:
                async for _ in resp.aiter_bytes():
                    return

    # Parked on the question: nothing to send, and the connection stays up.
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(read_first_bytes(), timeout=0.4)

    assert str(session_id) in turn_state


async def test_stream_closes_immediately_for_a_session_with_no_question(turn_state):
    """The counterpart: an idle session must not be held open by the repair."""
    from fastapi import FastAPI
    from app.api.routes.team.chat import router as chat_router
    from app.core import db as core_db

    session_id = uuid.uuid4()
    async with core_db.async_session_factory() as db:
        db.add(ChatSession(id=session_id, agent_name="openagentd", mode="coding"))
        await db.commit()

    application = FastAPI()
    application.include_router(chat_router)
    transport = ASGITransport(app=application)

    async def drain() -> None:
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            async with ac.stream("GET", f"/{session_id}/stream") as resp:
                async for _ in resp.aiter_bytes():
                    pass

    await asyncio.wait_for(drain(), timeout=5)
    assert str(session_id) not in turn_state
