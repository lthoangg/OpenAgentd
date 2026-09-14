from __future__ import annotations

import asyncio
from uuid import uuid7
import pytest

import app.core.db as core_db
from app.models.chat import ChatSession
from app.services.subagent_service import (
    AmbiguousMemberError,
    MAX_CONCURRENT_MEMBERS,
    MemberNotFoundError,
    SubagentInstance,
    _instance_counters,
    _live_instances,
    _reconciled_lead_sessions,
    allocate_instance_handle,
    list_subagents,
    prune_subagent_output,
    reconcile_lead_instances,
    resolve_instance,
    stop_all_subagents,
    stop_subagent,
)


@pytest.mark.asyncio
async def test_reconcile_lead_instances_from_db() -> None:
    lead_uuid = uuid7()
    lead_id = str(lead_uuid)

    _instance_counters.clear()
    _reconciled_lead_sessions.clear()

    async with core_db.async_session_factory() as db:
        # Create parent session
        parent = ChatSession(
            id=lead_uuid,
            agent_name="code",
            workspace="",
        )
        db.add(parent)
        await db.flush()

        # Seed existing child sessions in DB
        c1 = ChatSession(
            id=uuid7(),
            parent_session_id=lead_uuid,
            agent_name="explorer#1",
            workspace="",
        )
        c2 = ChatSession(
            id=uuid7(),
            parent_session_id=lead_uuid,
            agent_name="explorer#2",
            workspace="",
        )
        c3 = ChatSession(
            id=uuid7(),
            parent_session_id=lead_uuid,
            agent_name="researcher#1",
            workspace="",
        )
        db.add(c1)
        db.add(c2)
        db.add(c3)
        await db.commit()

    await reconcile_lead_instances(lead_id, core_db.async_session_factory)

    # Next allocated handle for explorer should be explorer#3
    next_explorer = allocate_instance_handle(lead_id, "explorer")
    assert next_explorer == "explorer#3"

    # Next allocated handle for researcher should be researcher#2
    next_researcher = allocate_instance_handle(lead_id, "researcher")
    assert next_researcher == "researcher#2"


def test_resolve_instance_and_disambiguation() -> None:
    lead_id = "test-lead-disambiguation"
    _live_instances[lead_id] = {}

    class DummySession:
        pass

    inst1 = SubagentInstance(
        handle="explorer#1",
        profile_name="explorer",
        lead_session_id=lead_id,
        session_id="child-1",
        session=DummySession(),  # type: ignore[arg-type]
    )
    _live_instances[lead_id]["explorer#1"] = inst1

    # When exactly 1 instance exists, bare profile resolves cleanly
    assert resolve_instance(lead_id, "explorer").handle == "explorer#1"
    assert resolve_instance(lead_id, "explorer#1").handle == "explorer#1"

    # Adding explorer#2 creates ambiguity for bare "explorer"
    inst2 = SubagentInstance(
        handle="explorer#2",
        profile_name="explorer",
        lead_session_id=lead_id,
        session_id="child-2",
        session=DummySession(),  # type: ignore[arg-type]
    )
    _live_instances[lead_id]["explorer#2"] = inst2

    with pytest.raises(AmbiguousMemberError) as exc_info:
        resolve_instance(lead_id, "explorer")
    assert "Multiple live instances" in str(exc_info.value)

    # Explicit handles resolve unambiguously
    assert resolve_instance(lead_id, "explorer#1").handle == "explorer#1"
    assert resolve_instance(lead_id, "explorer#2").handle == "explorer#2"

    with pytest.raises(MemberNotFoundError):
        resolve_instance(lead_id, "unknown#1")


@pytest.mark.asyncio
async def test_list_subagents_output() -> None:
    lead_id = "test-lead-list"
    _live_instances[lead_id] = {}

    class DummySession:
        pass

    inst = SubagentInstance(
        handle="explorer#1",
        profile_name="explorer",
        lead_session_id=lead_id,
        session_id="child-1",
        session=DummySession(),  # type: ignore[arg-type]
        status="working",
    )
    _live_instances[lead_id]["explorer#1"] = inst

    res = await list_subagents(lead_id)
    assert "available_profiles" in res
    assert "live_members" in res
    assert any(p["name"] == "explorer" for p in res["available_profiles"])
    assert len(res["live_members"]) == 1
    assert res["live_members"][0]["member_id"] == "explorer#1"
    assert res["live_members"][0]["status"] == "working"


@pytest.mark.asyncio
async def test_stop_subagent_and_stop_all() -> None:
    lead_id = "test-lead-stop"
    _live_instances[lead_id] = {}

    stopped_count = 0

    class DummySession:
        async def handle_stop(self) -> bool:
            nonlocal stopped_count
            stopped_count += 1
            return True

    inst1 = SubagentInstance(
        handle="explorer#1",
        profile_name="explorer",
        lead_session_id=lead_id,
        session_id="child-1",
        session=DummySession(),  # type: ignore[arg-type]
        status="working",
    )
    inst2 = SubagentInstance(
        handle="researcher#1",
        profile_name="researcher",
        lead_session_id=lead_id,
        session_id="child-2",
        session=DummySession(),  # type: ignore[arg-type]
        status="working",
    )
    _live_instances[lead_id]["explorer#1"] = inst1
    _live_instances[lead_id]["researcher#1"] = inst2

    # Stop single member
    res = await stop_subagent(lead_id, "explorer#1")
    assert res["status"] == "stopped"
    assert inst1.status == "error"
    assert stopped_count == 1

    # Stop all remaining
    await stop_all_subagents(lead_id)
    assert inst2.status == "error"
    assert stopped_count == 2


@pytest.mark.asyncio
async def test_remove_subagent_cancels_task_and_removes_from_live_instances() -> None:
    from app.services.subagent_service import remove_subagent

    lead_id = "test-lead-remove"
    _live_instances[lead_id] = {}

    cancelled = False

    class DummyTask:
        def done(self) -> bool:
            return False

        def cancel(self) -> None:
            nonlocal cancelled
            cancelled = True

    class DummySession:
        async def handle_stop(self) -> bool:
            return True

    inst = SubagentInstance(
        handle="explorer#1",
        profile_name="explorer",
        lead_session_id=lead_id,
        session_id="child-to-remove",
        session=DummySession(),  # type: ignore[arg-type]
        task_handle=DummyTask(),  # type: ignore[arg-type]
        status="working",
    )
    _live_instances[lead_id]["explorer#1"] = inst

    assert remove_subagent("child-to-remove") is True
    assert cancelled is True
    assert "explorer#1" not in _live_instances.get(lead_id, {})
    assert remove_subagent("child-nonexistent") is False


@pytest.mark.asyncio
async def test_cleanup_lead_session_purges_all_tracking() -> None:
    from app.services.subagent_service import cleanup_lead_session

    lead_id = "test-lead-cleanup"
    _live_instances[lead_id] = {}
    _instance_counters[lead_id] = {"explorer": 5}
    _reconciled_lead_sessions.add(lead_id)

    class DummySession:
        async def handle_stop(self) -> bool:
            return True

    inst = SubagentInstance(
        handle="explorer#1",
        profile_name="explorer",
        lead_session_id=lead_id,
        session_id="child-1",
        session=DummySession(),  # type: ignore[arg-type]
        status="working",
    )
    _live_instances[lead_id]["explorer#1"] = inst

    cleanup_lead_session(lead_id)
    assert lead_id not in _live_instances
    assert lead_id not in _instance_counters
    assert lead_id not in _reconciled_lead_sessions


@pytest.mark.asyncio
async def test_delete_session_removes_subagent_from_live_instances_and_list() -> None:
    from app.services.chat_service import delete_session

    lead_uuid = uuid7()
    lead_id = str(lead_uuid)
    child_uuid = uuid7()
    child_id = str(child_uuid)

    async with core_db.async_session_factory() as db:
        parent = ChatSession(
            id=lead_uuid,
            agent_name="code",
            workspace="",
        )
        child = ChatSession(
            id=child_uuid,
            parent_session_id=lead_uuid,
            agent_name="explorer#1",
            workspace="",
        )
        db.add(parent)
        db.add(child)
        await db.commit()

    class DummySession:
        async def handle_stop(self) -> bool:
            return True

    inst = SubagentInstance(
        handle="explorer#1",
        profile_name="explorer",
        lead_session_id=lead_id,
        session_id=child_id,
        session=DummySession(),  # type: ignore[arg-type]
        status="working",
    )
    _live_instances[lead_id] = {"explorer#1": inst}

    # Delete the child session directly
    async with core_db.async_session_factory() as db:
        deleted = await delete_session(db, child_uuid)
        assert deleted is True

    # Verify it is removed from live instances
    assert "explorer#1" not in _live_instances.get(lead_id, {})

    # Verify list_subagents does not resurrect it
    data = await list_subagents(lead_id, core_db.async_session_factory)
    assert not any(m["member_id"] == "explorer#1" for m in data["live_members"])


def test_prune_subagent_output_within_budget() -> None:
    short_output = "Found 3 files matching *.py."
    assert (
        prune_subagent_output(short_output, "child-123", max_chars=1000) == short_output
    )


def test_prune_subagent_output_truncates_large_payload() -> None:
    giant_output = "A" * 5000 + "B" * 5000
    pruned = prune_subagent_output(giant_output, "child-456", max_chars=2000)
    assert len(pruned) <= 2200
    assert "Output truncated" in pruned
    assert "child-456" in pruned
    assert pruned.startswith("A" * 500)
    assert pruned.endswith("B" * 400)


def test_max_concurrent_members_is_twenty() -> None:
    assert MAX_CONCURRENT_MEMBERS == 20


@pytest.mark.asyncio
async def test_deliver_message_to_lead_activates_session() -> None:
    from app.services import agent_manager
    from app.services.subagent_service import deliver_message_to_lead

    lead_uuid = uuid7()
    lead_id = str(lead_uuid)

    async with core_db.async_session_factory() as db:
        parent = ChatSession(
            id=lead_uuid,
            agent_name="code",
            workspace="/test/ws",
        )
        db.add(parent)
        await db.commit()

    activated = False

    class MockLeadSession:
        session_id = lead_id
        workspace = "/test/ws"
        user_message_lock = asyncio.Lock()

        def has_active_user_turn(self) -> bool:
            return False

        async def attach_to_session(self, session_id: str) -> None:
            self.session_id = session_id

        async def _activate_queued_user_messages(self, session_id: str) -> bool:
            nonlocal activated
            activated = True
            return True

    mock_sess = MockLeadSession()
    agent_manager._sessions[("/test/ws", lead_id)] = mock_sess  # type: ignore[assignment]

    try:
        await deliver_message_to_lead(
            lead_session_id=lead_id,
            handle="explorer#1",
            content="Explorer findings here.",
            db_factory=core_db.async_session_factory,
        )
        assert activated is True
    finally:
        agent_manager._sessions.pop(("/test/ws", lead_id), None)
