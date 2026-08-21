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
    ToolMessage,
)
from app.agent.providers.anthropic.anthropic import _split_messages
from app.models.chat import MessageKind
from app.services.chat_service import (
    create_chat_session,
    save_message,
    get_messages,
    get_messages_for_llm,
    undo_session_messages,
    heal_orphaned_tool_calls,
    hide_messages_before_summary,
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

    # ── H: no undo in effect (boundary=None) — reverted rows stay hidden ─────
    print("\n── H: boundary=None, reverted msgs stay hidden ──")
    async with factory() as s:
        sess = await create_chat_session(s)
        hidden = await save_message(s, sess.id, HumanMessage(content="hidden"))
        hidden.kind = MessageKind.REVERTED
        s.add(hidden)
        await save_message(s, sess.id, AssistantMessage(content="visible"))
        await s.commit()

        msgs = await get_messages(s, sess.id)
        check(
            "H1: reverted msg stays hidden without undo",
            [m.content for m in msgs],
            ["visible"],
        )

        llm = await get_messages_for_llm(s, sess.id)
        check("H2: LLM also hides it", [m.content for m in llm], ["visible"])

    # ── I: reverted summary is NOT treated as active_summary ─────────────────
    print("\n── I: reverted summary excluded from active_summary ──")
    async with factory() as s:
        sess = await create_chat_session(s)
        await save_message(s, sess.id, HumanMessage(content="u1"))
        dead_sum = await save_message(
            s, sess.id, HumanMessage(content="old_summary"), is_summary=True
        )
        # Simulate a materialised undo of the compaction turn.
        dead_sum.kind = MessageKind.REVERTED
        s.add(dead_sum)
        await save_message(s, sess.id, HumanMessage(content="u2"))
        await s.commit()

        # The reverted summary should not act as active_summary
        msgs = await get_messages(s, sess.id)
        check(
            "I1: reverted summary excluded from user view",
            [m.content for m in msgs],
            ["u1", "u2"],
        )

        llm = await get_messages_for_llm(s, sess.id)
        check(
            "I2: LLM sees u1, u2 (not the reverted summary)",
            [m.content for m in llm],
            ["u1", "u2"],
        )

    # ── J: heal_orphaned after undo uses dynamic visibility ───────────────────
    print("\n── J: heal_orphaned respects undo boundary ──")
    async with factory() as s:
        sess = await create_chat_session(s)
        await save_message(s, sess.id, HumanMessage(content="u1"))
        await save_message(
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
        summary = await save_message(
            s, sess.id, HumanMessage(content="summary"), is_summary=True
        )
        await hide_messages_before_summary(s, sess.id, summary.id)
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
        await save_message(s, sess.id, HumanMessage(content="u0"))
        await save_message(s, sess.id, AssistantMessage(content="a0"))
        await save_message(s, sess.id, HumanMessage(content="u1"))
        await save_message(s, sess.id, AssistantMessage(content="a1"))
        sum1 = await save_message(
            s, sess.id, HumanMessage(content="sum1"), is_summary=True
        )
        await hide_messages_before_summary(s, sess.id, sum1.id)
        u2 = await save_message(s, sess.id, HumanMessage(content="u2"))
        await s.commit()

        # u2 is the latest undo target still in the LLM window; sum1 is also a
        # target (summary), but u2 sits later in position → first undo = u2.
        shift1 = await undo_session_messages(s, sess.id)
        await s.commit()
        check(
            "K1: first undo target is u2 (latest visible user msg)",
            shift1.target.id == u2.id,
            True,
        )

        # After undoing u2: boundary = u2. sum1 is still active (before the
        # boundary); u0/a0/u1/a1 sit below its anchor → view is [sum1].
        after_first_undo = await get_messages(s, sess.id)
        check(
            "K2: after first undo — sum1 active, compacted msgs still hidden",
            [m.content for m in after_first_undo],
            ["sum1"],
        )

        # Second undo → latest undo target positioned before u2 is sum1.
        shift2 = await undo_session_messages(s, sess.id)
        await s.commit()
        check("K3: second undo target is sum1", shift2.target.id == sum1.id, True)

        # Now sum1 is undone: boundary = sum1. No active summary below the
        # boundary → u0/a0/u1/a1 (compacted by sum1) are all back.
        after_second_undo = await get_messages(s, sess.id)
        check(
            "K4: after second undo — all compacted msgs restored",
            [m.content for m in after_second_undo],
            ["u0", "a0", "u1", "a1"],
        )

    # ── L: undo with keep_last_n — summary anchored before the kept tail ─────
    print("\n── L: undo with keep_last_n=2 — divider-anchored summary ──")
    async with factory() as s:
        sess = await create_chat_session(s)
        await save_message(s, sess.id, HumanMessage(content="u1"))
        await save_message(s, sess.id, AssistantMessage(content="a1"))
        u2 = await save_message(s, sess.id, HumanMessage(content="u2"))  # kept
        await save_message(s, sess.id, AssistantMessage(content="a2"))  # kept
        sum1 = await save_message(
            s, sess.id, HumanMessage(content="sum1"), is_summary=True
        )
        # Compact u1/a1, keep u2/a2 — sum1 is re-anchored before the kept tail
        # (divider position), exactly like automatic compaction.
        await hide_messages_before_summary(s, sess.id, sum1.id, keep_last_n=2)
        await save_message(s, sess.id, AssistantMessage(content="after"))
        await s.commit()

        # Before undo: LLM = [sum1, u2, a2, after]
        llm_before = await get_messages_for_llm(s, sess.id)
        check(
            "L1: before undo — LLM sees [sum1, u2, a2, after]",
            [m.content for m in llm_before],
            ["sum1", "u2", "a2", "after"],
        )

        # First undo: the summary sits *before* the kept tail, so the latest
        # undo target in the window is the kept user turn u2, not sum1.
        shift = await undo_session_messages(s, sess.id)
        await s.commit()
        check("L2: first undo target is u2 (kept tail)", shift.target.id == u2.id, True)

        # Boundary = u2: sum1 stays active, u1/a1 stay compacted below its
        # anchor, and the kept tail is in the undone region.
        after_undo = await get_messages(s, sess.id)
        check(
            "L3: after first undo — only the active summary remains",
            [m.content for m in after_undo],
            ["sum1"],
        )

        # Second undo targets sum1 itself; the boundary moves to the divider,
        # so the compacted u1/a1 are restored while the kept tail (positioned
        # after the divider) stays in the undone region.
        shift2 = await undo_session_messages(s, sess.id)
        await s.commit()
        check("L4: second undo target is sum1", shift2.target.id == sum1.id, True)

        llm_after = await get_messages_for_llm(s, sess.id)
        check(
            "L5: LLM after second undo — compacted rows restored, tail undone",
            [m.content for m in llm_after],
            ["u1", "a1"],
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
        await save_message(s, sess.id, HumanMessage(content="u1"))
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

    # ── O: interrupted tool stub is removed before Anthropic replay ─────────
    print("\n── O: interrupted tool stub sanitized for Anthropic replay ──")
    async with factory() as s:
        sess = await create_chat_session(s)
        await save_message(s, sess.id, HumanMessage(content="first"))
        await save_message(
            s,
            sess.id,
            AssistantMessage(
                content="calling tools",
                tool_calls=[
                    ToolCall(
                        id="call_1",
                        function=FunctionCall(name="ls", arguments="{}"),
                    )
                ],
            ),
        )
        await save_message(s, sess.id, HumanMessage(content="follow-up"))
        await s.commit()

        llm = await get_messages_for_llm(s, sess.id)
        check(
            "O1: LLM history strips incomplete assistant tool_calls",
            [
                len(m.tool_calls or []) if isinstance(m, AssistantMessage) else None
                for m in llm
            ],
            [None, 0, None],
        )
        _, anthropic = _split_messages(llm)
        check(
            "O2: Anthropic replay omits bare tool_use stub",
            anthropic,
            [
                {"role": "user", "content": [{"type": "text", "text": "first"}]},
                {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "calling tools"}],
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": "follow-up",
                            "cache_control": {"type": "ephemeral"},
                        }
                    ],
                },
            ],
        )

    # ── P: complete tool pair still survives Anthropic replay ───────────────
    print("\n── P: complete tool pair preserved for Anthropic replay ──")
    async with factory() as s:
        sess = await create_chat_session(s)
        await save_message(s, sess.id, HumanMessage(content="first"))
        await save_message(
            s,
            sess.id,
            AssistantMessage(
                content="calling tools",
                tool_calls=[
                    ToolCall(
                        id="call_1",
                        function=FunctionCall(name="ls", arguments="{}"),
                    )
                ],
            ),
        )
        await save_message(
            s,
            sess.id,
            ToolMessage(content="done", tool_call_id="call_1", name="ls"),
        )
        await save_message(s, sess.id, HumanMessage(content="follow-up"))
        await s.commit()

        llm = await get_messages_for_llm(s, sess.id)
        _, anthropic = _split_messages(llm)
        check(
            "P1: Anthropic replay keeps assistant tool_use when result exists",
            anthropic[1]["content"][1]["type"],
            "tool_use",
        )
        check(
            "P2: Anthropic replay keeps matching tool_result block",
            anthropic[2]["content"][0]["type"],
            "tool_result",
        )

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
