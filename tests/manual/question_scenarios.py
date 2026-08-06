"""
Manual scenario tests for the ``ask_user`` durable suspension.
Run with: uv run python tests/manual/question_scenarios.py

The suspension is the feature's whole safety net: the turn survives an app
reload, a daemon restart and a device switch because the pending row *and* the
interrupted tool call live in the database rather than in a coroutine. Every
bug found in this feature so far has lived in a seam between two layers that
were each correct on their own, so these run the real service against a real
database instead of mocking the layer underneath.

The invariant that matters most is C2/B1: the placeholder tool result is what
keeps the conversation well-formed while the turn is parked. Lose it and the
next model call sees an assistant message whose ``tool_calls`` have no matching
``tool`` row, which every strict provider rejects.
"""

import asyncio
import itertools
import sys
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession

from app.agent.schemas.chat import AssistantMessage, HumanMessage
from app.services.chat_service import (
    create_chat_session,
    get_messages_for_llm,
    heal_orphaned_tool_calls,
    save_message,
)
from app.services.question_service import (
    PLACEHOLDER_RESULT,
    answer_question,
    create_pending_question,
    format_answers_for_model,
    get_pending_question,
    resolve_pending_question,
    sessions_awaiting_input,
)

# ``pending_questions.tool_call_id`` is globally unique, not unique per session,
# so every scenario needs its own call id even though each uses a fresh session.
_call_ids = itertools.count(1)

PASS = "✅ PASS"
FAIL = "❌ FAIL"
results = []

QUESTIONS = [
    {
        "question": "Which package manager?",
        "header": "Package manager",
        "multiple": False,
        "custom": False,
        "options": [{"label": "pnpm", "recommended": True}, {"label": "bun"}],
    },
    {
        "question": "Which checks should run?",
        "header": "Checks",
        "multiple": True,
        "custom": False,
        "options": [{"label": "lint"}, {"label": "test"}],
    },
]


def check(label, got, expected):
    ok = got == expected
    sym = PASS if ok else FAIL
    results.append((sym, label))
    print(f"  {sym}  {label}")
    if not ok:
        print(f"       got:      {got}")
        print(f"       expected: {expected}")


async def _suspend(s, call_id=None, questions=None):
    """Persist a turn that asked a question, exactly as the tool does."""
    call_id = call_id or f"call_{next(_call_ids)}"
    sess = await create_chat_session(s)
    await save_message(s, sess.id, HumanMessage(content="set the project up"))
    await save_message(
        s,
        sess.id,
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
    row = await create_pending_question(
        s,
        session_id=sess.id,
        tool_call_id=call_id,
        questions=questions if questions is not None else QUESTIONS,
    )
    await s.commit()
    return sess, row


async def _tool_result(s, session_id, call_id):
    msgs = await get_messages_for_llm(s, session_id)
    for m in msgs:
        if getattr(m, "tool_call_id", None) == call_id:
            return m.content
    return None


async def run(engine):
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    # ── Scenario A: the suspension is durable ───────────────────────────────
    print("\n── Scenario A: A suspended turn is readable from the database ──")
    async with factory() as s:
        sess, row = await _suspend(s)

        found = await get_pending_question(s, sess.id)
        check("A1: the open question is found by session", found is not None, True)
        check("A2: it is the row that was written", found.id, row.id)
        check("A3: it carries the asked questions", len(found.payload["questions"]), 2)
        check("A4: it starts pending", found.status, "pending")
        check(
            "A5: it points back at the interrupted tool call",
            found.tool_call_id,
            "call_1",
        )

        awaiting = await sessions_awaiting_input(s)
        check("A6: the session is listed as awaiting input", sess.id in awaiting, True)

        check(
            "A7: the tool call is closed with a placeholder result",
            await _tool_result(s, sess.id, row.tool_call_id),
            PLACEHOLDER_RESULT,
        )

    # ── Scenario B: healing must not steal the suspended call ───────────────
    print("\n── Scenario B: heal_orphaned_tool_calls leaves the suspension alone ──")
    async with factory() as s:
        sess, row = await _suspend(s)

        healed = await heal_orphaned_tool_calls(s, sess.id)
        await s.commit()

        check("B1: nothing is healed — the call already has a result", healed, 0)
        check(
            "B2: the placeholder survives healing",
            await _tool_result(s, sess.id, row.tool_call_id),
            PLACEHOLDER_RESULT,
        )
        check(
            "B3: the question is still open",
            (await get_pending_question(s, sess.id)) is not None,
            True,
        )

    # ── Scenario C: answering rewrites the placeholder in place ─────────────
    print("\n── Scenario C: Answering resolves the row and rewrites the result ──")
    async with factory() as s:
        sess, row = await _suspend(s)
        before = len(await get_messages_for_llm(s, sess.id))

        resolved = await answer_question(
            s, question_id=row.id, answers=[["pnpm"], ["lint", "test"]]
        )
        await s.commit()

        check("C1: the row reports answered", resolved.status, "answered")
        check(
            "C2: the selections are stored",
            resolved.answers,
            [["pnpm"], ["lint", "test"]],
        )
        check(
            "C3: the placeholder now carries the answer",
            await _tool_result(s, sess.id, row.tool_call_id),
            format_answers_for_model(QUESTIONS, [["pnpm"], ["lint", "test"]]),
        )
        check(
            "C4: rewritten in place — no extra message appended",
            len(await get_messages_for_llm(s, sess.id)),
            before,
        )
        check(
            "C5: the session no longer awaits input",
            sess.id in await sessions_awaiting_input(s),
            False,
        )
        check(
            "C6: nothing is left pending",
            (await get_pending_question(s, sess.id)) is None,
            True,
        )

    # ── Scenario D: the answer race has exactly one winner ──────────────────
    print("\n── Scenario D: Two devices answer the same question ──")
    async with factory() as s:
        sess, row = await _suspend(s)

        first = await answer_question(s, question_id=row.id, answers=[["pnpm"], []])
        second = await answer_question(s, question_id=row.id, answers=[["bun"], []])
        await s.commit()

        check("D1: the first answer wins", first is not None, True)
        check("D2: the second is refused", second, None)
        check(
            "D3: the losing answer did not overwrite the result",
            '"Which package manager?"="pnpm"'
            in (await _tool_result(s, sess.id, row.tool_call_id)),
            True,
        )

    # ── Scenario E: the endings a user can cause ────────────────────────────
    print("\n── Scenario E: Dismissed and superseded endings ──")
    async with factory() as s:
        sess, row = await _suspend(s)
        await resolve_pending_question(s, question_id=row.id, status="dismissed")
        await s.commit()

        check(
            "E1: a dismissal is recorded",
            (await get_pending_question(s, sess.id)) is None,
            True,
        )
        check(
            "E2: the model is told, without a stale instruction",
            await _tool_result(s, sess.id, row.tool_call_id),
            "Question(s) being dismissed.",
        )

    async with factory() as s:
        sess, row = await _suspend(s)
        await resolve_pending_question(s, question_id=row.id, status="superseded")
        await s.commit()

        check(
            "E3: a superseded question explains itself to the model",
            "Superseded" in (await _tool_result(s, sess.id, row.tool_call_id)),
            True,
        )

    # ── Scenario F: partial answers stay index-matched ──────────────────────
    print("\n── Scenario F: A question the user skipped ──")
    async with factory() as s:
        sess, row = await _suspend(s)
        await answer_question(s, question_id=row.id, answers=[[], ["lint"]])
        await s.commit()

        content = await _tool_result(s, sess.id, row.tool_call_id)
        check(
            "F1: the skipped question is reported, not dropped",
            '"Which package manager?"="Unanswered"' in content,
            True,
        )
        check(
            "F2: the answered one is still index-matched to its question",
            '"Which checks should run?"="lint"' in content,
            True,
        )

    # ── Scenario G: a resolved question never comes back ────────────────────
    print("\n── Scenario G: A second question later in the same session ──")
    async with factory() as s:
        sess, first_row = await _suspend(s)
        await answer_question(s, question_id=first_row.id, answers=[["pnpm"], []])
        await s.commit()

        second_call = f"call_{next(_call_ids)}"
        await save_message(
            s,
            sess.id,
            AssistantMessage(
                content=None,
                tool_calls=[
                    {
                        "id": second_call,
                        "type": "function",
                        "function": {"name": "ask_user", "arguments": "{}"},
                    }
                ],
            ),
        )
        second_row = await create_pending_question(
            s, session_id=sess.id, tool_call_id=second_call, questions=QUESTIONS[:1]
        )
        await s.commit()

        open_now = await get_pending_question(s, sess.id)
        check("G1: the newest question is the open one", open_now.id, second_row.id)
        check(
            "G2: the answered one keeps its own result",
            '"Which package manager?"="pnpm"'
            in (await _tool_result(s, sess.id, first_row.tool_call_id)),
            True,
        )
        check(
            "G3: the new call holds its own placeholder",
            await _tool_result(s, sess.id, second_call),
            PLACEHOLDER_RESULT,
        )

        healed = await heal_orphaned_tool_calls(s, sess.id)
        await s.commit()
        check("G4: healing still finds nothing to repair", healed, 0)

    # ── Summary ─────────────────────────────────────────────────────────────
    print("\n" + "═" * 55)
    passed = sum(1 for s, _ in results if s == PASS)
    failed = sum(1 for s, _ in results if s == FAIL)
    print(f"  Results: {passed} passed, {failed} failed  (total {len(results)})")
    print("═" * 55)
    return failed


async def main():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
    failed = await run(engine)
    await engine.dispose()
    sys.exit(1 if failed else 0)


asyncio.run(main())
