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

    async def _try_emit_done(self) -> None:
        self.turns_ended += 1


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


async def test_answer_does_not_resume_a_team_bound_to_another_session():
    """Resuming the wrong lead would replay a turn into someone else's history.

    ``find_live_team_for_lead_session`` also matches on the coding registry
    key, so it can return a team whose lead points elsewhere — a team evicted
    after the idle window is rebuilt with a freshly minted lead session id.
    ``activate_for_question_answer`` runs on ``lead.session_id``, so resuming
    it would append this answer's turn to a different session.
    """
    from app.api.routes.team import questions as questions_route

    session_id = uuid.uuid4()
    fake_team = _FakeTeam("019fd000-0000-7000-8000-00000000dead")

    async def fake_get_team_for_session(sid: str):
        return fake_team

    original = questions_route.get_team_for_session
    questions_route.get_team_for_session = fake_get_team_for_session
    try:
        resumed = await questions_route._resume_lead(str(session_id))
    finally:
        questions_route.get_team_for_session = original

    assert resumed is False
    assert fake_team.lead.resumed == 0


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
