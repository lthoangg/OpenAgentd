"""Tests for the ``ask_user`` tool (``app.agent.mode.team.question``).

The tool never returns a value: it persists the suspension and raises
:class:`QuestionSuspended`, which the agent loop unwinds into a clean end of
activation.  Everything the model can get wrong is caught by the args schema
before any of that happens.
"""

from __future__ import annotations

import uuid

import pytest
from pydantic import ValidationError
from sqlmodel import select

from app.agent.errors import QuestionSuspended
from app.agent.mode.team.question import (
    AskUserArgs,
    make_ask_user_tool,
)
from app.models.chat import ChatSession, PendingQuestion


def _question(**overrides) -> dict:
    base = {
        "question": "Which package manager?",
        "header": "Package manager",
        "options": [
            {"label": "pnpm", "description": "Fast", "recommended": True},
            {"label": "bun", "description": "Faster"},
        ],
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# Args schema
# ---------------------------------------------------------------------------


def test_accepts_a_well_formed_question():
    args = AskUserArgs(questions=[_question()])

    assert args.questions[0].header == "Package manager"
    assert args.questions[0].options[0].recommended is True
    assert args.questions[0].custom is True
    assert args.questions[0].multiple is False


def test_rejects_more_than_four_questions():
    with pytest.raises(ValidationError):
        AskUserArgs(questions=[_question() for _ in range(5)])


def test_rejects_an_empty_question_list():
    with pytest.raises(ValidationError):
        AskUserArgs(questions=[])


def test_rejects_an_over_long_header():
    with pytest.raises(ValidationError):
        AskUserArgs(questions=[_question(header="x" * 31)])


def test_rejects_more_than_five_options():
    options = [{"label": f"opt-{index}"} for index in range(6)]
    with pytest.raises(ValidationError):
        AskUserArgs(questions=[_question(options=options)])


def test_rejects_two_recommendations_on_a_single_select_question():
    """A single-select question can only have one preferred choice."""
    options = [
        {"label": "pnpm", "recommended": True},
        {"label": "bun", "recommended": True},
    ]
    with pytest.raises(ValidationError):
        AskUserArgs(questions=[_question(options=options, multiple=False)])


def test_allows_two_recommendations_on_a_multi_select_question():
    options = [
        {"label": "lint", "recommended": True},
        {"label": "test", "recommended": True},
        {"label": "build"},
    ]
    args = AskUserArgs(questions=[_question(options=options, multiple=True)])

    assert sum(option.recommended for option in args.questions[0].options) == 2


def test_rejects_duplicate_option_labels():
    options = [{"label": "pnpm"}, {"label": "pnpm"}]
    with pytest.raises(ValidationError):
        AskUserArgs(questions=[_question(options=options)])


def test_rejects_a_question_with_no_options_and_no_free_text():
    """Otherwise the card renders with nothing the user can do."""
    with pytest.raises(ValidationError):
        AskUserArgs(questions=[_question(options=[], custom=False)])


def test_allows_a_free_text_only_question():
    args = AskUserArgs(questions=[_question(options=[], custom=True)])

    assert args.questions[0].options == []


# ---------------------------------------------------------------------------
# Tool behaviour
# ---------------------------------------------------------------------------


class _FakeLead:
    def __init__(self, session_id: str) -> None:
        self.name = "openagentd"
        self.session_id = session_id
        self.db_factory = None


class _FakeTeam:
    def __init__(self, session_id: str) -> None:
        self.lead = _FakeLead(session_id)
        self.mode = "coding"


def test_tool_definition_hides_injected_arguments():
    tool = make_ask_user_tool(_FakeTeam(str(uuid.uuid4())))  # type: ignore[arg-type]
    properties = tool.definition["function"]["parameters"]["properties"]

    assert tool.name == "ask_user"
    assert set(properties) == {"questions"}


async def test_calling_the_tool_persists_the_question_and_suspends():
    from app.core import db as core_db

    session_id = uuid.uuid4()
    async with core_db.async_session_factory() as db:
        db.add(ChatSession(id=session_id, agent_name="openagentd", mode="coding"))
        await db.commit()

    tool = make_ask_user_tool(_FakeTeam(str(session_id)))  # type: ignore[arg-type]

    with pytest.raises(QuestionSuspended) as excinfo:
        await tool.arun(
            _injected={"_tool_call_id": "call_42"},
            questions=[_question()],
        )

    async with core_db.async_session_factory() as db:
        row = (
            await db.exec(
                select(PendingQuestion).where(PendingQuestion.session_id == session_id)
            )
        ).one()

    assert excinfo.value.question_id == row.id
    assert row.tool_call_id == "call_42"
    assert row.payload["questions"][0]["header"] == "Package manager"


async def test_tool_refuses_without_a_resolvable_tool_call_id():
    """A suspension with no call to resume would strand the turn."""
    from app.core import db as core_db

    session_id = uuid.uuid4()
    async with core_db.async_session_factory() as db:
        db.add(ChatSession(id=session_id, agent_name="openagentd", mode="coding"))
        await db.commit()

    tool = make_ask_user_tool(_FakeTeam(str(session_id)))  # type: ignore[arg-type]

    result = await tool.arun(_injected={"_tool_call_id": None}, questions=[_question()])

    assert "could not be delivered" in str(result).lower()


async def test_asking_emits_the_event_and_a_notification(
    monkeypatch, mock_stream_store
):
    """Live clients render from the SSE event; absent users get a nudge.

    Uses the directory-level ``mock_stream_store`` fixture rather than patching
    ``push_event`` again: ``tests/conftest.py`` has an autouse fixture that
    requests ``monkeypatch``, which makes monkeypatch tear down *after* that
    fixture's ``patch()`` — re-patching here would leak the mock into every
    later test on the same xdist worker.
    """
    from app.core import db as core_db

    session_id = uuid.uuid4()
    async with core_db.async_session_factory() as db:
        db.add(
            ChatSession(
                id=session_id,
                agent_name="openagentd",
                mode="coding",
                workspace="/tmp/demo-project",
            )
        )
        await db.commit()

    published: list = []

    async def fake_publish(event, payload):
        published.append((event, payload))

    monkeypatch.setattr("app.services.event_broadcaster.publish", fake_publish)

    tool = make_ask_user_tool(_FakeTeam(str(session_id)))  # type: ignore[arg-type]
    with pytest.raises(QuestionSuspended):
        await tool.arun(
            _injected={"_tool_call_id": "call_evt"}, questions=[_question()]
        )

    assert mock_stream_store.await_count == 1
    sid, envelope = mock_stream_store.await_args.args
    assert sid == str(session_id)
    assert envelope.event == "question_asked"
    assert envelope.data["tool_call_id"] == "call_evt"
    assert envelope.data["questions"][0]["header"] == "Package manager"

    assert len(published) == 1
    event, payload = published[0]
    assert event == "desktop_notification"
    assert payload["kind"] == "input_needed"
    assert payload["session_id"] == str(session_id)
    assert "demo-project" in payload["title"]
    # Clicking the notification routes by mode + workspace, exactly like the
    # completion notification — without them the click opens the wrong view.
    assert payload["metadata"]["mode"] == "coding"
    assert payload["metadata"]["workspace"] == "/tmp/demo-project"


async def test_a_failed_event_fanout_does_not_break_the_suspension(
    monkeypatch, mock_stream_store
):
    """The question is already durable — fan-out is best effort."""
    from app.core import db as core_db

    session_id = uuid.uuid4()
    async with core_db.async_session_factory() as db:
        db.add(ChatSession(id=session_id, agent_name="openagentd", mode="coding"))
        await db.commit()

    async def boom(*args, **kwargs):
        raise RuntimeError("stream store down")

    mock_stream_store.side_effect = boom
    monkeypatch.setattr("app.services.event_broadcaster.publish", boom)

    tool = make_ask_user_tool(_FakeTeam(str(session_id)))  # type: ignore[arg-type]

    with pytest.raises(QuestionSuspended):
        await tool.arun(
            _injected={"_tool_call_id": "call_boom"}, questions=[_question()]
        )

    async with core_db.async_session_factory() as db:
        row = (
            await db.exec(
                select(PendingQuestion).where(PendingQuestion.session_id == session_id)
            )
        ).one()
    assert row.status == "pending"


def test_ask_user_accepts_single_question_dict():
    """AskUserArgs coerces a single question dict into a list."""
    args = AskUserArgs.model_validate(_question())
    assert len(args.questions) == 1
    assert args.questions[0].header == "Package manager"


def test_ask_user_accepts_json_string():
    """AskUserArgs coerces a JSON-stringified question list."""
    import json

    payload = json.dumps([_question()])
    args = AskUserArgs(questions=payload)  # type: ignore[arg-type]
    assert len(args.questions) == 1
    assert args.questions[0].header == "Package manager"
