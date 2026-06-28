"""
Extended scenario coverage — gaps from the first round.
Run with: uv run python tests/manual/extended_scenarios.py
"""

import asyncio
import sys
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession

from app.agent.schemas.chat import (
    AssistantMessage,
    HumanMessage,
    ToolCall,
    FunctionCall,
)
from app.services.chat_service import (
    create_chat_session,
    save_message,
    get_messages,
    get_messages_for_llm,
    undo_session_messages,
    heal_orphaned_tool_calls,
)

PASS = "✅ PASS"
FAIL = "❌ FAIL"
results = []


def check(label, got, expected):
    ok = got == expected
    results.append((PASS if ok else FAIL, label))
    if ok:
        print(f"  {PASS}  {label}")
    else:
        print(f"  {FAIL}  {label}")
        print(f"       got:      {got!r}")
        print(f"       expected: {expected!r}")


async def run(engine):
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    # ── H: no undo in effect (boundary=None) — no over-restore occurs ────────
    print("\n── H: boundary=None, excluded msgs stay excluded ──")
    async with factory() as s:
        sess = await create_chat_session(s)
        hidden = await save_message(s, sess.id, HumanMessage(content="hidden"))
        hidden.exclude_from_context = True
        s.add(hidden)
        await save_message(s, sess.id, AssistantMessage(content="visible"))
        await s.commit()

        msgs = await get_messages(s, sess.id)
        check(
            "H1: excluded msg stays hidden without undo",
            [m.content for m in msgs],
            ["visible"],
        )

        llm = await get_messages_for_llm(s, sess.id)
        check("H2: LLM also hides it", [m.content for m in llm], ["visible"])

    # ── I: hidden_from_user summary is NOT treated as active_summary ──────────
    print("\n── I: hidden_from_user summary excluded from active_summary ──")
    async with factory() as s:
        sess = await create_chat_session(s)
        await save_message(s, sess.id, HumanMessage(content="u1"))
        hidden_sum = await save_message(
            s, sess.id, HumanMessage(content="old_summary"), is_summary=True
        )
        extra = dict(hidden_sum.extra or {})
        extra["hidden_from_user"] = True
        hidden_sum.extra = extra
        s.add(hidden_sum)
        await save_message(s, sess.id, HumanMessage(content="u2"))
        await s.commit()

        # The hidden summary should not act as active_summary
        msgs = await get_messages(s, sess.id)
        check(
            "I1: hidden summary excluded from user view",
            [m.content for m in msgs],
            ["u1", "u2"],
        )

        llm = await get_messages_for_llm(s, sess.id)
        check(
            "I2: LLM sees u1, u2 (not the hidden summary)",
            [m.content for m in llm],
            ["u1", "u2"],
        )

    # ── J: heal_orphaned after undo uses dynamic visibility ───────────────────
    print("\n── J: heal_orphaned respects undo boundary ──")
    async with factory() as s:
        sess = await create_chat_session(s)
        u1 = await save_message(s, sess.id, HumanMessage(content="u1"))
        a1 = await save_message(
            s,
            sess.id,
            AssistantMessage(
                content="",
                tool_calls=[
                    ToolCall(
                        id="tc1", function=FunctionCall(name="search", arguments="{}")
                    )
                ],
            ),
        )
        # No tool result → orphaned
        await save_message(s, sess.id, HumanMessage(content="summary"), is_summary=True)
        for row in (u1, a1):
            row.exclude_from_context = True
            s.add(row)
        await s.commit()

        # Before undo: only summary visible, heal should see no orphans (a1 excluded)
        healed_before = await heal_orphaned_tool_calls(s, sess.id)
        check(
            "J1: heal_orphaned sees no orphans when a1 excluded by compaction",
            healed_before,
            0,
        )

        # After undo: a1 dynamically restored, heal should now find the orphan
        await undo_session_messages(s, sess.id)
        await s.commit()
        healed_after = await heal_orphaned_tool_calls(s, sess.id)
        check("J2: heal_orphaned finds orphan after undo restores a1", healed_after, 1)

    # ── K: double undo past first summary → bare messages ─────────────────────
    print("\n── K: double undo — two layers of undo ──")
    async with factory() as s:
        sess = await create_chat_session(s)
        u0 = await save_message(s, sess.id, HumanMessage(content="u0"))
        a0 = await save_message(s, sess.id, AssistantMessage(content="a0"))
        u1 = await save_message(s, sess.id, HumanMessage(content="u1"))
        a1 = await save_message(s, sess.id, AssistantMessage(content="a1"))
        sum1 = await save_message(
            s, sess.id, HumanMessage(content="sum1"), is_summary=True
        )
        u2 = await save_message(s, sess.id, HumanMessage(content="u2"))
        for row in (u0, a0, u1, a1):
            row.exclude_from_context = True
            s.add(row)
        await s.commit()

        # u2 is the latest user message that is_undo_target (not excluded, not hidden).
        # sum1 is also is_undo_target (is_summary=True), but u2 comes later → first undo = u2.
        shift1 = await undo_session_messages(s, sess.id)
        await s.commit()
        check(
            "K1: first undo target is u2 (latest visible user msg)",
            shift1.target.id == u2.id,
            True,
        )

        # After undoing u2: boundary = u2.created_at. sum1 is still active (before boundary).
        # u0/a0/u1/a1 are still compacted by sum1 → dynamic restore only sees [sum1].
        after_first_undo = await get_messages(s, sess.id)
        check(
            "K2: after first undo — sum1 active, compacted msgs still hidden",
            [m.content for m in after_first_undo],
            ["sum1"],
        )

        # Second undo → latest is_undo_target before u2.created_at is sum1 (is_summary=True).
        shift2 = await undo_session_messages(s, sess.id)
        await s.commit()
        check("K3: second undo target is sum1", shift2.target.id == sum1.id, True)

        # Now sum1 is undone: boundary = sum1.created_at. No active summary below boundary.
        # u0/a0/u1/a1 were compacted by sum1 (now undone) → all restored.
        after_second_undo = await get_messages(s, sess.id)
        check(
            "K4: after second undo — all compacted msgs restored",
            [m.content for m in after_second_undo],
            ["u0", "a0", "u1", "a1"],
        )

    # ── L: undo with keep_last_n — kept msgs visible, others NOT ─────────────
    print("\n── L: undo with keep_last_n=2 — over-restore guard ──")
    async with factory() as s:
        sess = await create_chat_session(s)
        u1 = await save_message(s, sess.id, HumanMessage(content="u1"))
        a1 = await save_message(s, sess.id, AssistantMessage(content="a1"))
        u2 = await save_message(s, sess.id, HumanMessage(content="u2"))  # kept
        await save_message(s, sess.id, AssistantMessage(content="a2"))  # kept
        sum1 = await save_message(
            s, sess.id, HumanMessage(content="sum1"), is_summary=True
        )
        await save_message(s, sess.id, AssistantMessage(content="after"))
        # Compact only u1/a1 (keep_last_n=2 kept u2/a2)
        for row in (u1, a1):
            row.exclude_from_context = True
            s.add(row)
        await s.commit()

        # Before undo: LLM = [sum1, u2, a2, after]
        llm_before = await get_messages_for_llm(s, sess.id)
        check(
            "L1: before undo — LLM sees [sum1, u2, a2, after]",
            [m.content for m in llm_before],
            ["sum1", "u2", "a2", "after"],
        )

        # Undo sum1
        shift = await undo_session_messages(s, sess.id)
        await s.commit()
        check("L2: undo target is sum1", shift.target.id == sum1.id, True)

        # After undo of sum1: boundary = sum1.created_at.
        # history_messages_stmt fetches only messages < boundary, so 'after' (saved after sum1)
        # is in the undone tail and correctly absent.
        # u1/a1 were compacted by sum1 (undone) → restored. u2/a2 were never excluded.
        after_undo = await get_messages(s, sess.id)
        check(
            "L3: after undo — u1/a1 restored, u2/a2 present, 'after' in undone tail (absent)",
            [m.content for m in after_undo],
            ["u1", "a1", "u2", "a2"],
        )

        llm_after = await get_messages_for_llm(s, sess.id)
        check(
            "L4: LLM after undo — no summary, 'after' absent (beyond boundary)",
            [m.content for m in llm_after],
            ["u1", "a1", "u2", "a2"],
        )

    # ── M: no messages at all → empty returns ─────────────────────────────────
    print("\n── M: empty session edge cases ──")
    async with factory() as s:
        sess = await create_chat_session(s)
        await s.commit()

        msgs = await get_messages(s, sess.id)
        check("M1: get_messages on empty session returns []", msgs, [])

        llm = await get_messages_for_llm(s, sess.id)
        check("M2: get_messages_for_llm on empty session returns []", llm, [])

        shift = await undo_session_messages(s, sess.id)
        check("M3: undo on empty session returns applied=False", shift.applied, False)

    # ── N: undo non-summary user message (no summary at all) ─────────────────
    print("\n── N: undo plain user message (no compaction involved) ──")
    async with factory() as s:
        sess = await create_chat_session(s)
        u1 = await save_message(s, sess.id, HumanMessage(content="u1"))
        await save_message(s, sess.id, AssistantMessage(content="a1"))
        u2 = await save_message(s, sess.id, HumanMessage(content="u2"))
        await save_message(s, sess.id, AssistantMessage(content="a2"))
        await s.commit()

        shift = await undo_session_messages(s, sess.id)
        await s.commit()
        check("N1: undo targets u2", shift.target.id == u2.id, True)

        msgs = await get_messages(s, sess.id)
        check(
            "N2: user sees [u1, a1] after undo of u2",
            [m.content for m in msgs],
            ["u1", "a1"],
        )

        llm = await get_messages_for_llm(s, sess.id)
        check("N3: LLM also sees [u1, a1]", [m.content for m in llm], ["u1", "a1"])

    # ── Summary ────────────────────────────────────────────────────────────
    print("\n" + "═" * 60)
    passed = sum(1 for s, _ in results if s == PASS)
    failed = sum(1 for s, _ in results if s == FAIL)
    print(f"  Results: {passed} passed, {failed} failed  (total {len(results)})")
    print("═" * 60)
    return failed


async def main():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
    failed = await run(engine)
    await engine.dispose()
    sys.exit(1 if failed else 0)


asyncio.run(main())
