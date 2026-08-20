"""Tests for app/agent/checkpointer.py — InMemoryCheckpointer + SQLiteCheckpointer.

Covers uncovered lines: 69, 73-80, 87-94, 137-151, 181, 208-209, 253, 263-289.
"""

from __future__ import annotations

import uuid
from unittest.mock import MagicMock

import pytest
from sqlalchemy import event
from sqlmodel import col, select

from app.agent.checkpointer import (
    Checkpointer,
    InMemoryCheckpointer,
    SQLiteCheckpointer,
)
from app.agent.schemas.chat import (
    AssistantMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from app.agent.state import AgentState, RunContext
from app.models.chat import ChatSession, SessionMessage


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _ctx(session_id: str = "test-session") -> RunContext:
    return RunContext(session_id=session_id, run_id="run-1", agent_name="TestBot")


async def _make_session(db, sid: uuid.UUID) -> ChatSession:
    """Create a ChatSession in the DB by model (avoids create_chat_session title param issue)."""
    session = ChatSession(id=sid)
    db.add(session)
    await db.flush()
    return session


# ---------------------------------------------------------------------------
# Protocol conformance
# ---------------------------------------------------------------------------


class TestCheckpointerProtocol:
    def test_in_memory_satisfies_protocol(self):
        assert isinstance(InMemoryCheckpointer(), Checkpointer)

    def test_sqlite_satisfies_protocol(self):
        mock_factory = MagicMock()
        assert isinstance(SQLiteCheckpointer(mock_factory), Checkpointer)


# ---------------------------------------------------------------------------
# InMemoryCheckpointer
# ---------------------------------------------------------------------------


class TestInMemoryCheckpointer:
    @pytest.mark.asyncio
    async def test_load_returns_none_for_unknown_session(self):
        cp = InMemoryCheckpointer()
        result = await cp.load("nonexistent")
        assert result is None

    @pytest.mark.asyncio
    async def test_sync_then_load_returns_state(self):
        """sync stores state; load returns a copy."""
        cp = InMemoryCheckpointer()
        ctx = _ctx("sid-1")
        state = AgentState(
            messages=[HumanMessage(content="hi")],
            system_prompt="Be helpful.",
        )

        await cp.sync(ctx, state)
        loaded = await cp.load("sid-1")

        assert loaded is not None
        assert len(loaded.messages) == 1
        assert loaded.messages[0].content == "hi"
        assert loaded.system_prompt == "Be helpful."

    @pytest.mark.asyncio
    async def test_load_returns_deep_copy(self):
        """Mutations to loaded state don't affect stored snapshot."""
        cp = InMemoryCheckpointer()
        ctx = _ctx("sid-1")
        state = AgentState(messages=[HumanMessage(content="hi")])

        await cp.sync(ctx, state)
        loaded = await cp.load("sid-1")
        assert loaded is not None
        loaded.messages.append(AssistantMessage(content="hello"))

        # Me check original snapshot untouched
        loaded2 = await cp.load("sid-1")
        assert loaded2 is not None
        assert len(loaded2.messages) == 1

    @pytest.mark.asyncio
    async def test_sync_stores_deep_copy(self):
        """Mutations to original state after sync don't affect snapshot."""
        cp = InMemoryCheckpointer()
        ctx = _ctx("sid-1")
        state = AgentState(messages=[HumanMessage(content="hi")])

        await cp.sync(ctx, state)
        state.messages.append(AssistantMessage(content="mutated"))

        loaded = await cp.load("sid-1")
        assert loaded is not None
        assert len(loaded.messages) == 1

    @pytest.mark.asyncio
    async def test_sync_with_none_session_id_uses_empty_string(self):
        """session_id=None in ctx → stores under empty string key."""
        cp = InMemoryCheckpointer()
        ctx = RunContext(session_id=None, run_id="r1", agent_name="bot")
        state = AgentState(messages=[HumanMessage(content="test")])

        await cp.sync(ctx, state)
        loaded = await cp.load("")
        assert loaded is not None
        assert len(loaded.messages) == 1

    @pytest.mark.asyncio
    async def test_sync_overwrites_previous_state(self):
        """Second sync overwrites the first snapshot."""
        cp = InMemoryCheckpointer()
        ctx = _ctx("sid-1")

        state1 = AgentState(messages=[HumanMessage(content="first")])
        await cp.sync(ctx, state1)

        state2 = AgentState(messages=[HumanMessage(content="second")])
        await cp.sync(ctx, state2)

        loaded = await cp.load("sid-1")
        assert loaded is not None
        assert len(loaded.messages) == 1
        assert loaded.messages[0].content == "second"


# ---------------------------------------------------------------------------
# SQLiteCheckpointer — load
# ---------------------------------------------------------------------------


class TestSQLiteCheckpointerLoad:
    @pytest.mark.asyncio
    async def test_history_revision_changes_when_message_is_saved(self):
        import app.core.db as _db
        from app.services.chat_service import get_history_revision, save_message

        sid = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _make_session(db, sid)
                before = await get_history_revision(db, sid)
                await save_message(
                    db, sid, AssistantMessage(content="summary"), is_summary=True
                )
                after = await get_history_revision(db, sid)

        assert after[0] == before[0] + 1
        assert after[1] == before[1] + 1

    @pytest.mark.asyncio
    async def test_load_returns_none_for_empty_session(self):
        """No messages in DB → returns None."""
        import app.core.db as _db

        cp = SQLiteCheckpointer(_db.async_session_factory)
        result = await cp.load(str(uuid.uuid7()))
        assert result is None

    @pytest.mark.asyncio
    async def test_load_returns_state_with_messages(self):
        """Messages in DB → returns AgentState with messages."""
        import app.core.db as _db
        from app.services.chat_service import save_message

        sid = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _make_session(db, sid)
                await save_message(db, sid, HumanMessage(content="hello"))
                await save_message(db, sid, AssistantMessage(content="world"))

        cp = SQLiteCheckpointer(_db.async_session_factory)
        loaded = await cp.load(str(sid))

        assert loaded is not None
        assert len(loaded.messages) >= 2

    @pytest.mark.asyncio
    async def test_load_marks_messages_as_persisted(self):
        """load() auto-registers messages so sync() won't re-insert them."""
        import app.core.db as _db
        from app.services.chat_service import save_message

        sid = uuid.uuid7()
        sid_str = str(sid)
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _make_session(db, sid)
                await save_message(db, sid, HumanMessage(content="hello"))
                await save_message(db, sid, AssistantMessage(content="world"))

        cp = SQLiteCheckpointer(_db.async_session_factory)
        loaded = await cp.load(sid_str)
        assert loaded is not None

        # Me verify loaded messages are in _persisted set
        assert sid_str in cp._persisted
        for msg in loaded.messages:
            assert id(msg) in cp._persisted[sid_str]


# ---------------------------------------------------------------------------
# SQLiteCheckpointer — sync
# ---------------------------------------------------------------------------


class TestSQLiteCheckpointerSync:
    @pytest.mark.asyncio
    async def test_sync_allocates_seq_tail_once_per_flush(self):
        """A flush of N new messages runs one MAX(seq) allocation, not N.

        The checkpointer allocates the append tail once and hands explicit
        ``seq`` values to ``save_message``; per-row pre-selects would put a
        redundant query on the hottest write path in the app.
        """
        import app.core.db as _db
        from app.models.chat import SEQ_STEP

        sid = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _make_session(db, sid)

        cp = SQLiteCheckpointer(_db.async_session_factory)
        ctx = _ctx(str(sid))
        state = AgentState(
            messages=[
                AssistantMessage(content="one"),
                ToolMessage(content="two", tool_call_id="tc1", name="search"),
                AssistantMessage(content="three"),
            ]
        )

        max_seq_selects = 0

        def _count(conn, cursor, statement, parameters, context, executemany):
            nonlocal max_seq_selects
            if "max(session_messages.seq" in statement.lower():
                max_seq_selects += 1

        event.listen(_db.engine.sync_engine, "before_cursor_execute", _count)
        try:
            await cp.sync(ctx, state)
        finally:
            event.remove(_db.engine.sync_engine, "before_cursor_execute", _count)

        assert max_seq_selects == 1

        async with _db.async_session_factory() as db:
            rows = (
                await db.exec(
                    select(SessionMessage)
                    .where(col(SessionMessage.session_id) == sid)
                    .order_by(col(SessionMessage.seq), col(SessionMessage.id))
                )
            ).all()
        assert [r.content for r in rows] == ["one", "two", "three"]
        seqs = [r.seq for r in rows]
        assert seqs == sorted(seqs) and len(set(seqs)) == 3
        assert seqs[1] - seqs[0] == SEQ_STEP and seqs[2] - seqs[1] == SEQ_STEP

    @pytest.mark.asyncio
    async def test_sync_persists_assistant_message(self):
        """AssistantMessage is persisted to DB."""
        import app.core.db as _db
        from app.services.chat_service import get_messages

        sid = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _make_session(db, sid)

        cp = SQLiteCheckpointer(_db.async_session_factory)
        ctx = _ctx(str(sid))
        state = AgentState(messages=[AssistantMessage(content="hello from agent")])

        await cp.sync(ctx, state)

        async with _db.async_session_factory() as db:
            messages = await get_messages(db, sid)
        assert any(m.content == "hello from agent" for m in messages)

    @pytest.mark.asyncio
    async def test_sync_persists_tool_message(self):
        """ToolMessage is persisted to DB."""
        import app.core.db as _db
        from app.services.chat_service import get_messages

        sid = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _make_session(db, sid)

        cp = SQLiteCheckpointer(_db.async_session_factory)
        ctx = _ctx(str(sid))
        state = AgentState(
            messages=[
                ToolMessage(content="tool result", tool_call_id="tc1", name="search")
            ]
        )

        await cp.sync(ctx, state)

        async with _db.async_session_factory() as db:
            messages = await get_messages(db, sid)
        assert any(m.content == "tool result" for m in messages)

    @pytest.mark.asyncio
    async def test_sync_persists_tool_message_extra_duration(self):
        """Tool duration metadata must survive reload via SessionMessage.extra."""
        import app.core.db as _db
        from app.services.chat_service import get_messages

        sid = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _make_session(db, sid)

        cp = SQLiteCheckpointer(_db.async_session_factory)
        ctx = _ctx(str(sid))
        state = AgentState(
            messages=[
                ToolMessage(
                    content="tool result",
                    tool_call_id="tc1",
                    name="search",
                    extra={"duration_ms": 456.0},
                )
            ]
        )

        await cp.sync(ctx, state)

        async with _db.async_session_factory() as db:
            messages = await get_messages(db, sid)
        tool_message = next(m for m in messages if m.tool_call_id == "tc1")
        assert tool_message.extra == {"duration_ms": 456.0}

    @pytest.mark.asyncio
    async def test_sync_skips_human_and_system_messages(self):
        """HumanMessage and SystemMessage are not persisted by checkpointer."""
        import app.core.db as _db
        from app.services.chat_service import get_messages

        sid = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _make_session(db, sid)

        cp = SQLiteCheckpointer(_db.async_session_factory)
        ctx = _ctx(str(sid))
        state = AgentState(
            messages=[
                SystemMessage(content="you are helpful"),
                HumanMessage(content="hello"),
            ]
        )

        await cp.sync(ctx, state)

        async with _db.async_session_factory() as db:
            messages = await get_messages(db, sid)
        # Me check no messages persisted (human/system skipped by checkpointer)
        assert not any(m.content == "you are helpful" for m in messages)
        assert not any(m.content == "hello" for m in messages)

    @pytest.mark.asyncio
    async def test_sync_persists_hidden_human_messages_and_filters_them(self):
        """HumanMessage with hidden_from_user extra is persisted, hidden from user view, but visible to LLM."""
        import app.core.db as _db
        from app.services.chat_service import get_messages, get_messages_for_llm

        sid = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _make_session(db, sid)

        cp = SQLiteCheckpointer(_db.async_session_factory)
        ctx = _ctx(str(sid))
        state = AgentState(
            messages=[
                HumanMessage(
                    content="hidden error recovery msg",
                    extra={"hidden_from_user": True},
                ),
            ]
        )

        await cp.sync(ctx, state)

        async with _db.async_session_factory() as db:
            user_messages = await get_messages(db, sid)
            llm_messages = await get_messages_for_llm(db, sid)

        # The hidden message must not be in the user view
        assert not any(m.content == "hidden error recovery msg" for m in user_messages)
        # The hidden message must be in the LLM view
        assert any(m.content == "hidden error recovery msg" for m in llm_messages)

    @pytest.mark.asyncio
    async def test_sync_idempotent_no_duplicates(self):
        """Calling sync twice with same state does not create duplicate rows."""
        import app.core.db as _db
        from app.services.chat_service import get_messages

        sid = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _make_session(db, sid)

        cp = SQLiteCheckpointer(_db.async_session_factory)
        ctx = _ctx(str(sid))
        msg = AssistantMessage(content="once only")
        state = AgentState(messages=[msg])

        await cp.sync(ctx, state)
        await cp.sync(ctx, state)

        async with _db.async_session_factory() as db:
            messages = await get_messages(db, sid)
        count = sum(1 for m in messages if m.content == "once only")
        assert count == 1

    @pytest.mark.asyncio
    async def test_sync_persists_cipher_only_reasoning_assistant_message(self):
        """Opaque Codex reasoning must survive when the turn has no visible text/tools."""
        import app.core.db as _db
        from app.agent.providers.openai.responses import ResponsesHandler

        sid = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _make_session(db, sid)

        cipher_only = AssistantMessage(
            reasoning_item_id="rs_1",
            reasoning_encrypted_content="cipher123",
            extra={
                "reasoning_item_id": "rs_1",
                "reasoning_encrypted_content": "cipher123",
            },
        )
        cp = SQLiteCheckpointer(_db.async_session_factory)
        await cp.sync(_ctx(str(sid)), AgentState(messages=[cipher_only]))

        loaded = await cp.load(str(sid))

        assert loaded is not None
        assert len(loaded.messages) == 1
        restored = loaded.messages[0]
        assert isinstance(restored, AssistantMessage)
        assert restored.reasoning_item_id == "rs_1"
        assert restored.reasoning_encrypted_content == "cipher123"
        assert ResponsesHandler(
            "gpt-5.4", "https://api.example.com", {}
        ).convert_messages([restored]) == [
            {
                "type": "reasoning",
                "id": "rs_1",
                "summary": [],
                "encrypted_content": "cipher123",
            }
        ]

    @pytest.mark.asyncio
    async def test_sync_persists_is_summary_and_extra(self):
        """is_summary and extra metadata are passed to save_message."""
        import app.core.db as _db

        sid = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _make_session(db, sid)

        cp = SQLiteCheckpointer(_db.async_session_factory)
        ctx = _ctx(str(sid))
        msg = AssistantMessage(
            content="summary text",
            is_summary=True,
            extra={"usage": {"input": 100}},
        )
        state = AgentState(messages=[msg])

        await cp.sync(ctx, state)

        # Me verify via raw DB query
        from sqlmodel import col, select
        from app.models.chat import SessionMessage

        async with _db.async_session_factory() as db:
            rows = (
                await db.exec(
                    select(SessionMessage).where(
                        col(SessionMessage.session_id) == sid,
                        col(SessionMessage.kind) == "summary",
                    )
                )
            ).all()
        assert len(rows) == 1
        assert rows[0].extra == {"usage": {"input": 100}}

    @pytest.mark.asyncio
    async def test_sync_early_return_when_no_messages(self):
        """sync returns early when no new and no seen messages."""
        import app.core.db as _db

        cp = SQLiteCheckpointer(_db.async_session_factory)
        ctx = _ctx(str(uuid.uuid7()))
        state = AgentState(messages=[])

        # Me should not raise
        await cp.sync(ctx, state)

    @pytest.mark.asyncio
    async def test_sync_updates_pinned_flag(self):
        """When a previously-persisted message flips pinned→True, the DB row is updated."""
        import app.core.db as _db
        from sqlmodel import col, select
        from app.models.chat import SessionMessage

        sid = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _make_session(db, sid)

        cp = SQLiteCheckpointer(_db.async_session_factory)
        ctx = _ctx(str(sid))
        msg = AssistantMessage(content="will be pinned")
        state = AgentState(messages=[msg])

        # Me first sync — persists the message
        await cp.sync(ctx, state)

        # Me flip pinned (SummarizationHook does this for retained skill pairs)
        msg.pinned = True
        await cp.sync(ctx, state)

        # Me check DB row
        async with _db.async_session_factory() as db:
            rows = (
                await db.exec(
                    select(SessionMessage).where(
                        col(SessionMessage.session_id) == sid,
                        col(SessionMessage.content) == "will be pinned",
                    )
                )
            ).all()
        assert len(rows) == 1
        assert rows[0].pinned is True

    @pytest.mark.asyncio
    async def test_sync_bulk_updates_pins_without_per_message_selects(self):
        """Seen pinned messages use one bulk UPDATE, not N PK SELECTs.

        Exclusion flips, by contrast, produce *no* writes at all — context
        membership is derived from the summary row's position.
        """
        import app.core.db as _db
        from app.services.chat_service import get_messages

        sid = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _make_session(db, sid)

        cp = SQLiteCheckpointer(_db.async_session_factory)
        ctx = _ctx(str(sid))
        messages = [AssistantMessage(content=f"message-{i}") for i in range(3)]
        state = AgentState(messages=messages)
        await cp.sync(ctx, state)
        for message in messages:
            message.exclude_from_context = True
            message.pinned = True

        statements: list[str] = []

        def record_statement(_conn, _cursor, statement, _parameters, _context, _many):
            statements.append(statement)

        event.listen(_db.engine.sync_engine, "before_cursor_execute", record_statement)
        try:
            await cp.sync(ctx, state)
        finally:
            event.remove(
                _db.engine.sync_engine, "before_cursor_execute", record_statement
            )

        pin_selects = [
            statement
            for statement in statements
            if "SELECT" in statement.upper() and "session_messages" in statement
        ]
        pin_updates = [
            statement
            for statement in statements
            if "UPDATE session_messages" in statement
        ]
        assert pin_selects == []
        assert len(pin_updates) == 1

        async with _db.async_session_factory() as db:
            persisted = await get_messages(db, sid)
        # In-memory exclusion is not persisted on its own — durability comes
        # from the summary row that always accompanies it in the real flow.
        assert len(persisted) == 3
        assert all(id(message) in cp._persisted[str(sid)] for message in messages)

    @pytest.mark.asyncio
    async def test_update_exclude_flags_skips_non_assistant_tool(self):
        """sync() skips exclude_from_context updates for system/human messages."""
        import app.core.db as _db

        cp = SQLiteCheckpointer(_db.async_session_factory)
        ctx = _ctx(str(uuid.uuid7()))
        human = HumanMessage(content="hello")
        state = AgentState(messages=[human])

        sid = ctx.session_id or ""
        cp._persisted[sid] = {id(human)}

        # Me flip exclude flag on human message
        human.exclude_from_context = True
        # Should not raise or try to query DB (no db_id on human)
        await cp.sync(ctx, state)

    @pytest.mark.asyncio
    async def test_update_exclude_flags_no_un_exclude(self):
        """Un-excluding (True→False) is not supported — only True direction."""
        import app.core.db as _db

        sid = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _make_session(db, sid)

        cp = SQLiteCheckpointer(_db.async_session_factory)
        ctx = _ctx(str(sid))
        msg = AssistantMessage(content="test", exclude_from_context=True)
        state = AgentState(messages=[msg])

        # Me first sync with exclude=True
        await cp.sync(ctx, state)

        # Me flip back to False
        msg.exclude_from_context = False
        # Me should not crash — just skips
        await cp.sync(ctx, state)

    @pytest.mark.asyncio
    async def test_update_exclude_flags_row_not_found(self):
        """When db_id is None on a seen message, skip the PK update gracefully."""
        import app.core.db as _db

        sid = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _make_session(db, sid)

        cp = SQLiteCheckpointer(_db.async_session_factory)
        ctx = _ctx(str(sid))
        msg = AssistantMessage(content="phantom message")
        state = AgentState(messages=[msg])

        # Me manually mark as persisted but leave db_id=None
        sid_str = str(sid)
        cp._persisted[sid_str] = {id(msg)}

        # Me flip exclude flag — db_id is None so PK lookup skipped
        msg.exclude_from_context = True
        # Me should not raise
        await cp.sync(ctx, state)

    @pytest.mark.asyncio
    async def test_update_exclude_flags_missing_db_row_is_safe(self):
        """A stale persisted db_id is harmless when the bulk UPDATE matches no row."""
        import app.core.db as _db

        sid = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _make_session(db, sid)

        cp = SQLiteCheckpointer(_db.async_session_factory)
        ctx = _ctx(str(sid))
        msg = AssistantMessage(content="deleted row", exclude_from_context=True)
        msg.db_id = uuid.uuid7()
        cp._persisted[str(sid)] = {id(msg)}

        await cp.sync(ctx, AgentState(messages=[msg]))

        assert id(msg) in cp._persisted[str(sid)]

    @pytest.mark.asyncio
    async def test_sync_system_message_in_seen_skipped(self):
        """Line 287: SystemMessage in seen_messages is skipped in exclude-flag loop."""
        import app.core.db as _db

        sid = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _make_session(db, sid)

        cp = SQLiteCheckpointer(_db.async_session_factory)
        ctx = _ctx(str(sid))

        # Me create a SystemMessage and mark it as "seen" (already persisted)
        sys_msg = SystemMessage(content="you are helpful")
        assistant_msg = AssistantMessage(content="hello")
        state = AgentState(messages=[sys_msg, assistant_msg])

        # Me manually register sys_msg as persisted so it ends up in seen_messages
        sid_str = str(sid)
        cp._persisted[sid_str] = {id(sys_msg)}

        # Me flip exclude flag on system message — should be skipped without crash
        sys_msg.exclude_from_context = True

        # Me should not raise
        await cp.sync(ctx, state)

    @pytest.mark.asyncio
    async def test_sync_saves_human_message_with_is_summary(self):
        """Lines 336-344: HumanMessage with is_summary=True is saved to DB."""
        import app.core.db as _db
        from sqlmodel import col, select
        from app.models.chat import SessionMessage

        sid = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _make_session(db, sid)

        cp = SQLiteCheckpointer(_db.async_session_factory)
        ctx = _ctx(str(sid))

        # Me create a summary HumanMessage (not yet persisted, no db_id)
        summary_msg = HumanMessage(
            content="[Summary] Earlier conversation summary.",
            is_summary=True,
        )
        state = AgentState(messages=[summary_msg])

        await cp.sync(ctx, state)

        # Me verify it was saved to DB
        async with _db.async_session_factory() as db:
            rows = (
                await db.exec(
                    select(SessionMessage).where(
                        col(SessionMessage.session_id) == sid,
                        col(SessionMessage.kind) == "summary",
                    )
                )
            ).all()
        assert len(rows) == 1
        assert rows[0].content == "[Summary] Earlier conversation summary."
        # Me db_id should be set on the message object
        assert summary_msg.db_id is not None

    @pytest.mark.asyncio
    async def test_sync_anchors_a_summary_before_the_window_it_kept(self):
        """A summary row sorts where the hook inserted it, not at the tail.

        ``SummarizationHook`` *inserts* the summary into ``state.messages``
        ahead of the window it kept verbatim. A fresh row defaults to
        the next append ``seq``, so persisting it plainly would sort it after
        that whole window — and, in the derived model, fail to cover the
        compacted rows at all.
        """
        import app.core.db as _db
        from sqlmodel import col, select
        from app.models.chat import SessionMessage
        from app.services.chat_service import save_message

        sid = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _make_session(db, sid)
                compacted_user = await save_message(
                    db, sid, HumanMessage(content="turn one")
                )
                compacted_reply = await save_message(
                    db, sid, AssistantMessage(content="ONE")
                )
                kept_user = await save_message(
                    db, sid, HumanMessage(content="turn two")
                )

        # Rebuild the in-memory window the hook would have mutated: the first
        # two rows compacted away, the third kept, summary spliced in between.
        old_user = HumanMessage(content="turn one", exclude_from_context=True)
        old_user.db_id = compacted_user.id
        old_reply = AssistantMessage(content="ONE", exclude_from_context=True)
        old_reply.db_id = compacted_reply.id
        new_user = HumanMessage(content="turn two")
        new_user.db_id = kept_user.id
        summary = HumanMessage(
            content="Earlier: the user asked for ONE.", is_summary=True
        )

        cp = SQLiteCheckpointer(_db.async_session_factory)
        cp.mark_loaded(str(sid), [old_user, old_reply, new_user])
        state = AgentState(messages=[old_user, old_reply, summary, new_user])

        await cp.sync(_ctx(str(sid)), state)

        async with _db.async_session_factory() as db:
            rows = (
                await db.exec(
                    select(SessionMessage)
                    .where(col(SessionMessage.session_id) == sid)
                    .order_by(
                        col(SessionMessage.seq).asc(),
                        col(SessionMessage.id).asc(),
                    )
                )
            ).all()

        assert [(r.role, r.kind) for r in rows] == [
            ("user", "chat"),
            ("assistant", "chat"),
            ("user", "summary"),
            ("user", "chat"),
        ]
        assert rows[2].content == "Earlier: the user asked for ONE."
        assert rows[3].id == kept_user.id

    @pytest.mark.asyncio
    async def test_sync_leaves_a_trailing_summary_at_the_tail(self):
        """No kept window after it — the default append ``seq`` is already right."""
        import app.core.db as _db
        from sqlmodel import col, select
        from app.models.chat import SessionMessage
        from app.services.chat_service import save_message

        sid = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _make_session(db, sid)
                first = await save_message(db, sid, HumanMessage(content="turn one"))

        old_user = HumanMessage(content="turn one", exclude_from_context=True)
        old_user.db_id = first.id
        summary = HumanMessage(content="Earlier: one turn.", is_summary=True)

        cp = SQLiteCheckpointer(_db.async_session_factory)
        cp.mark_loaded(str(sid), [old_user])
        await cp.sync(_ctx(str(sid)), AgentState(messages=[old_user, summary]))

        async with _db.async_session_factory() as db:
            rows = (
                await db.exec(
                    select(SessionMessage)
                    .where(col(SessionMessage.session_id) == sid)
                    .order_by(col(SessionMessage.seq).asc())
                )
            ).all()
        assert [r.kind for r in rows] == ["chat", "summary"]

    @pytest.mark.asyncio
    async def test_mark_loaded_sets_seeded_tokens_from_usage(self):
        """Line 61 + 191: mark_loaded with history containing usage sets _seeded_tokens."""
        import app.core.db as _db

        cp = SQLiteCheckpointer(_db.async_session_factory)
        sid = str(uuid.uuid7())

        # Me create assistant message with usage in extra
        assistant_with_usage = AssistantMessage(
            content="response",
            extra={"usage": {"input": 1500, "output": 200}},
        )
        history = [HumanMessage(content="hi"), assistant_with_usage]

        cp.mark_loaded(sid, history)

        assert cp._seeded_tokens.get(sid) == 1500

    @pytest.mark.asyncio
    async def test_seed_state_sets_last_prompt_tokens(self):
        """Lines 212-213: seed_state sets state.usage.last_prompt_tokens when tokens > 0."""
        import app.core.db as _db

        cp = SQLiteCheckpointer(_db.async_session_factory)
        sid = str(uuid.uuid7())

        assistant_with_usage = AssistantMessage(
            content="response",
            extra={"usage": {"input": 2000, "output": 300}},
        )
        history = [HumanMessage(content="hi"), assistant_with_usage]

        cp.mark_loaded(sid, history)

        state = AgentState(messages=list(history))
        cp.seed_state(sid, state)

        assert state.usage.last_prompt_tokens == 2000

    @pytest.mark.asyncio
    async def test_mark_loaded_prevents_duplicate_inserts(self):
        """mark_loaded() stops sync() from re-inserting DB-loaded messages."""
        import app.core.db as _db
        from app.services.chat_service import get_messages, save_message

        sid = uuid.uuid7()
        sid_str = str(sid)
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _make_session(db, sid)
                await save_message(db, sid, HumanMessage(content="user msg"))
                await save_message(db, sid, AssistantMessage(content="bot reply"))

        # Me simulate the pattern: load history, mark_loaded, then sync
        from app.services.chat_service import get_messages_for_llm

        async with _db.async_session_factory() as db:
            history = await get_messages_for_llm(db, sid)

        cp = SQLiteCheckpointer(_db.async_session_factory)
        cp.mark_loaded(sid_str, history)

        # Me add one NEW assistant message (simulating a fresh agent turn)
        new_msg = AssistantMessage(content="new bot response")
        all_msgs = history + [new_msg]
        state = AgentState(messages=all_msgs)
        ctx = _ctx(sid_str)
        await cp.sync(ctx, state)

        # Me count messages in DB — should be 3 (original 2 + 1 new), not 4+
        async with _db.async_session_factory() as db:
            db_msgs = await get_messages(db, sid)
        # Me filter to only assistant msgs to avoid counting system/human duplicates
        assistant_msgs = [m for m in db_msgs if m.role == "assistant"]
        assert len(assistant_msgs) == 2, (
            f"Expected 2 assistant messages (original + new), got {len(assistant_msgs)}"
        )


# ---------------------------------------------------------------------------
# SQLiteCheckpointer → stream_store.commit_agent_content wiring
# ---------------------------------------------------------------------------


class TestSQLiteCheckpointerStreamCommit:
    """The checkpointer calls ``stream_store.commit_agent_content`` after a
    successful DB persist so the in-flight replay buffer drops anything that
    is now durable.  Without the two constructor kwargs the call is skipped.
    """

    @pytest.mark.asyncio
    async def test_sync_commits_stream_when_wired(self, monkeypatch):
        import app.core.db as _db
        from app.services import memory_stream_store as stream_store

        sid = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _make_session(db, sid)

        calls: list[tuple[str, str]] = []

        async def _spy(session_id: str, agent: str) -> None:
            calls.append((session_id, agent))

        monkeypatch.setattr(stream_store, "commit_agent_content", _spy)

        cp = SQLiteCheckpointer(
            _db.async_session_factory,
            stream_session_id="lead-sid",
            agent_name="alice",
        )
        state = AgentState(messages=[AssistantMessage(content="hi")])
        await cp.sync(_ctx(str(sid)), state)

        assert calls == [("lead-sid", "alice")]

    @pytest.mark.asyncio
    async def test_sync_skips_stream_commit_when_not_wired(self, monkeypatch):
        """Without stream_session_id+agent_name the cleanup call is skipped."""
        import app.core.db as _db
        from app.services import memory_stream_store as stream_store

        sid = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _make_session(db, sid)

        calls: list[tuple[str, str]] = []

        async def _spy(session_id: str, agent: str) -> None:
            calls.append((session_id, agent))

        monkeypatch.setattr(stream_store, "commit_agent_content", _spy)

        cp = SQLiteCheckpointer(_db.async_session_factory)  # Me no wiring
        state = AgentState(messages=[AssistantMessage(content="hi")])
        await cp.sync(_ctx(str(sid)), state)

        assert calls == []

    @pytest.mark.asyncio
    async def test_sync_skips_stream_commit_when_only_one_kwarg(self, monkeypatch):
        """Either kwarg missing → skip (both are required)."""
        import app.core.db as _db
        from app.services import memory_stream_store as stream_store

        sid = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _make_session(db, sid)

        calls: list[tuple[str, str]] = []

        async def _spy(session_id: str, agent: str) -> None:
            calls.append((session_id, agent))

        monkeypatch.setattr(stream_store, "commit_agent_content", _spy)

        cp = SQLiteCheckpointer(_db.async_session_factory, stream_session_id="lead-sid")
        state = AgentState(messages=[AssistantMessage(content="hi")])
        await cp.sync(_ctx(str(sid)), state)

        assert calls == []

    @pytest.mark.asyncio
    async def test_sync_commits_stream_after_transaction_commits(self, monkeypatch):
        """Verify commit_agent_content is called AFTER the DB transaction commits."""
        import app.core.db as _db
        from app.services import memory_stream_store as stream_store

        sid = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _make_session(db, sid)

        call_order: list[str] = []

        async def _spy_commit(session_id: str, agent: str) -> None:
            call_order.append("commit")

        # Me patch to track when commit is called relative to DB operations
        monkeypatch.setattr(stream_store, "commit_agent_content", _spy_commit)

        cp = SQLiteCheckpointer(
            _db.async_session_factory,
            stream_session_id="lead-sid",
            agent_name="alice",
        )
        state = AgentState(messages=[AssistantMessage(content="hello world")])

        # Me sync should succeed and call commit after DB transaction
        await cp.sync(_ctx(str(sid)), state)

        # Me commit should have been called
        assert call_order == ["commit"]


# ---------------------------------------------------------------------------
# sync() must not open a transaction when there is nothing to write
#
# ``sync`` runs on every agent step.  The existing early-out only fires when
# the state has *no messages at all*, so after the first turn ``seen_messages``
# is always non-empty and every step opened a session and a transaction — even
# on a settled conversation with nothing new to persist and no exclude flags to
# flip.  Production logged 7,854 syncs across 2 days against 5,816 persisted
# messages, so a large share committed nothing.
# ---------------------------------------------------------------------------


async def test_sync_opens_no_transaction_when_nothing_to_persist():
    from app.core.db import async_session_factory

    opened = {"n": 0}

    def counting_factory(*args, **kwargs):
        opened["n"] += 1
        return async_session_factory(*args, **kwargs)

    cp = SQLiteCheckpointer(session_factory=counting_factory)
    ctx = _ctx("settled-session")
    messages = [HumanMessage(content="hi"), AssistantMessage(content="yo")]
    state = MagicMock()
    state.messages = messages
    # Everything already persisted, no exclude_from_context flips pending.
    cp._persisted[ctx.session_id] = {id(m) for m in messages}
    cp._stream_session_id = None
    cp._agent_name = None

    for _ in range(10):
        await cp.sync(ctx, state)

    assert opened["n"] == 0, (
        f"a settled sync opened {opened['n']} transactions that commit nothing"
    )


async def test_sync_still_opens_a_transaction_when_there_is_new_work():
    """Guard the other direction: real work must still reach the DB."""
    from app.core.db import async_session_factory

    opened = {"n": 0}

    def counting_factory(*args, **kwargs):
        opened["n"] += 1
        return async_session_factory(*args, **kwargs)

    sid = uuid.uuid4()
    async with async_session_factory() as db:
        await _make_session(db, sid)
        await db.commit()

    cp = SQLiteCheckpointer(session_factory=counting_factory)
    ctx = _ctx(str(sid))
    state = MagicMock()
    state.messages = [AssistantMessage(content="fresh")]
    cp._stream_session_id = None
    cp._agent_name = None

    await cp.sync(ctx, state)

    assert opened["n"] == 1, "a sync with new messages must persist them"
    assert state.messages[0].db_id is not None, "db_id should be stamped"
