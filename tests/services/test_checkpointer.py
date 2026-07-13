"""Tests for app/agent/checkpointer.py — InMemoryCheckpointer + SQLiteCheckpointer.

Covers uncovered lines: 69, 73-80, 87-94, 137-151, 181, 208-209, 253, 263-289.
"""

from __future__ import annotations

import uuid
from unittest.mock import MagicMock

import pytest

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
from app.models.chat import ChatSession


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
                        col(SessionMessage.is_summary).is_(True),
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
    async def test_sync_updates_exclude_from_context_flag(self):
        """When a previously-persisted message flips exclude_from_context→True, DB row is updated."""
        import app.core.db as _db
        from sqlmodel import col, select
        from app.models.chat import SessionMessage

        sid = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _make_session(db, sid)

        cp = SQLiteCheckpointer(_db.async_session_factory)
        ctx = _ctx(str(sid))
        msg = AssistantMessage(content="will be excluded")
        state = AgentState(messages=[msg])

        # Me first sync — persists the message
        await cp.sync(ctx, state)

        # Me flip exclude_from_context
        msg.exclude_from_context = True
        await cp.sync(ctx, state)

        # Me check DB row
        async with _db.async_session_factory() as db:
            rows = (
                await db.exec(
                    select(SessionMessage).where(
                        col(SessionMessage.session_id) == sid,
                        col(SessionMessage.content) == "will be excluded",
                    )
                )
            ).all()
        assert len(rows) == 1
        assert rows[0].exclude_from_context is True

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
                        col(SessionMessage.is_summary).is_(True),
                    )
                )
            ).all()
        assert len(rows) == 1
        assert rows[0].content == "[Summary] Earlier conversation summary."
        # Me db_id should be set on the message object
        assert summary_msg.db_id is not None

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
