"""
Manual scenario tests for chat_service dynamic visibility + undo behaviour.
Run with: uv run python tests/manual/manual_scenarios.py
"""

import asyncio
import sys
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession

from app.agent.schemas.chat import AssistantMessage, HumanMessage
from app.services.chat_service import (
    create_chat_session,
    save_message,
    get_messages,
    get_messages_for_llm,
    undo_session_messages,
    redo_session_messages,
    hide_messages_before_summary,
    save_queued_user_message,
)

PASS = "✅ PASS"
FAIL = "❌ FAIL"
results = []


def check(label, got, expected):
    ok = got == expected
    sym = PASS if ok else FAIL
    results.append((sym, label))
    if ok:
        print(f"  {sym}  {label}")
    else:
        print(f"  {sym}  {label}")
        print(f"       got:      {got}")
        print(f"       expected: {expected}")


async def run(engine):
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    # ── Scenario A: Normal compaction ───────────────────────────────────────
    print("\n── Scenario A: Normal compaction ──")
    async with factory() as s:
        sess = await create_chat_session(s)
        await save_message(s, sess.id, HumanMessage(content="msg1"))
        await save_message(s, sess.id, AssistantMessage(content="msg2"))
        await save_message(s, sess.id, HumanMessage(content="msg3"))
        await save_message(s, sess.id, AssistantMessage(content="msg4"))
        summary = await save_message(
            s, sess.id, HumanMessage(content="summary"), is_summary=True
        )
        await hide_messages_before_summary(s, sess.id, summary.id, keep_last_n=2)
        await save_message(s, sess.id, AssistantMessage(content="msg5"))
        await s.commit()

        user_msgs = await get_messages(s, sess.id)
        check(
            "A1: user view — summary anchored at divider position before kept tail",
            [m.content for m in user_msgs],
            ["summary", "msg3", "msg4", "msg5"],
        )

        llm_msgs = await get_messages_for_llm(s, sess.id)
        check("A2: LLM summary is first", llm_msgs[0].content, "summary")
        check(
            "A3: LLM sees [summary, kept, post] — summary force-prepended",
            [m.content for m in llm_msgs],
            ["summary", "msg3", "msg4", "msg5"],
        )
        check(
            "A4: LLM does NOT see compacted msg1/msg2",
            "msg1" not in [m.content for m in llm_msgs],
            True,
        )

    # ── Scenario B: Undo summary — user view ────────────────────────────────
    print("\n── Scenario B: Undo summary — user view ──")
    async with factory() as s:
        sess = await create_chat_session(s)
        await save_message(s, sess.id, HumanMessage(content="u1"))
        await save_message(s, sess.id, AssistantMessage(content="a1"))
        summary = await save_message(
            s, sess.id, HumanMessage(content="summary"), is_summary=True
        )
        await save_message(s, sess.id, AssistantMessage(content="after"))
        await hide_messages_before_summary(s, sess.id, summary.id)
        await s.commit()

        # Before undo
        before = await get_messages(s, sess.id)
        check(
            "B1: before undo — user sees [summary, after]",
            [m.content for m in before],
            ["summary", "after"],
        )

        shift = await undo_session_messages(s, sess.id)
        await s.commit()
        check(
            "B2: undo applied to summary",
            shift.applied and shift.target.id == summary.id,
            True,
        )

        after_undo = await get_messages(s, sess.id)
        check(
            "B3: after undo — user sees [u1, a1] (restored)",
            [m.content for m in after_undo],
            ["u1", "a1"],
        )

    # ── Scenario C: Undo summary — LLM view ─────────────────────────────────
    print("\n── Scenario C: Undo summary — LLM view ──")
    async with factory() as s:
        sess = await create_chat_session(s)
        await save_message(s, sess.id, HumanMessage(content="u1"))
        await save_message(s, sess.id, AssistantMessage(content="a1"))
        summary = await save_message(
            s, sess.id, HumanMessage(content="summary"), is_summary=True
        )
        await hide_messages_before_summary(s, sess.id, summary.id)
        await s.commit()

        # Before undo LLM
        before_llm = await get_messages_for_llm(s, sess.id)
        check(
            "C1: before undo — LLM sees [summary] only",
            [m.content for m in before_llm],
            ["summary"],
        )

        await undo_session_messages(s, sess.id)
        await s.commit()

        after_llm = await get_messages_for_llm(s, sess.id)
        check(
            "C2: after undo — LLM sees [u1, a1], no summary",
            [m.content for m in after_llm],
            ["u1", "a1"],
        )
        check(
            "C3: summary not in LLM context after undo",
            "summary" not in [m.content for m in after_llm],
            True,
        )

    # ── Scenario D: Two summaries, undo second — no over-restore ─────────────
    print("\n── Scenario D: Two summaries, undo second ──")
    async with factory() as s:
        sess = await create_chat_session(s)
        await save_message(s, sess.id, HumanMessage(content="u1"))
        await save_message(s, sess.id, AssistantMessage(content="a1"))
        await save_message(s, sess.id, HumanMessage(content="sum1"), is_summary=True)
        await save_message(s, sess.id, HumanMessage(content="u2"))
        await save_message(s, sess.id, AssistantMessage(content="a2"))
        s2 = await save_message(
            s, sess.id, HumanMessage(content="sum2"), is_summary=True
        )
        await save_message(s, sess.id, AssistantMessage(content="after_s2"))
        # Compaction coverage is positional: sum1 covers u1/a1, sum2 covers
        # everything before it (sum1 is superseded automatically by max-id).
        await hide_messages_before_summary(s, sess.id, s2.id)
        await s.commit()

        # Undo sum2
        shift = await undo_session_messages(s, sess.id)
        await s.commit()
        check(
            "D1: undo applied to sum2", shift.applied and shift.target.id == s2.id, True
        )

        user_view = await get_messages_for_llm(s, sess.id)
        contents = [m.content for m in user_view]
        check(
            "D2: u2/a2 restored (compacted by sum2)",
            "u2" in contents and "a2" in contents,
            True,
        )
        check(
            "D3: u1/a1 NOT restored (compacted by sum1 which is still active)",
            "u1" not in contents and "a1" not in contents,
            True,
        )
        check("D4: sum2 not in LLM context after undo", "sum2" not in contents, True)

    # ── Scenario E (backend): queued message visible despite exclude flag ─────
    print("\n── Scenario E-backend: Queued message visibility ──")
    async with factory() as s:
        sess = await create_chat_session(s)
        await save_message(s, sess.id, HumanMessage(content="normal"))
        await save_queued_user_message(s, sess.id, "queued")
        await s.commit()

        msgs = await get_messages(s, sess.id)
        contents = [m.content for m in msgs]
        check("E1: normal message visible", "normal" in contents, True)
        check(
            "E2: queued message visible despite queued kind",
            "queued" in contents,
            True,
        )

    # ── Scenario F: Redo after undo restores normal view ─────────────────────
    print("\n── Scenario F: Redo after undo ──")
    async with factory() as s:
        sess = await create_chat_session(s)
        await save_message(s, sess.id, HumanMessage(content="u1"))
        await save_message(s, sess.id, AssistantMessage(content="a1"))
        summary = await save_message(
            s, sess.id, HumanMessage(content="summary"), is_summary=True
        )
        await save_message(s, sess.id, AssistantMessage(content="after"))
        await hide_messages_before_summary(s, sess.id, summary.id)
        await s.commit()

        await undo_session_messages(s, sess.id)
        await s.commit()
        after_undo = await get_messages(s, sess.id)
        check(
            "F1: after undo — [u1, a1]", [m.content for m in after_undo], ["u1", "a1"]
        )

        await redo_session_messages(s, sess.id)
        await s.commit()
        after_redo = await get_messages(s, sess.id)
        check(
            "F2: after redo — back to [summary, after]",
            [m.content for m in after_redo],
            ["summary", "after"],
        )

        redo_llm = await get_messages_for_llm(s, sess.id)
        check(
            "F3: after redo — LLM sees [summary, after]",
            [m.content for m in redo_llm],
            ["summary", "after"],
        )

    # ── Scenario G: Undo first (only) summary, all compacted messages restored ─
    print("\n── Scenario G: Undo only summary, all compacted restored ──")
    async with factory() as s:
        sess = await create_chat_session(s)
        await save_message(s, sess.id, HumanMessage(content="u1"))
        await save_message(s, sess.id, AssistantMessage(content="a1"))
        await save_message(s, sess.id, HumanMessage(content="u2"))
        summary = await save_message(
            s, sess.id, HumanMessage(content="summary"), is_summary=True
        )
        await hide_messages_before_summary(s, sess.id, summary.id)
        await s.commit()

        await undo_session_messages(s, sess.id)
        await s.commit()

        msgs = await get_messages(s, sess.id)
        check(
            "G1: all three compacted messages restored",
            [m.content for m in msgs],
            ["u1", "a1", "u2"],
        )

        llm_msgs = await get_messages_for_llm(s, sess.id)
        check(
            "G2: LLM also sees all three restored",
            [m.content for m in llm_msgs],
            ["u1", "a1", "u2"],
        )

    # ── Summary ────────────────────────────────────────────────────────────
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
