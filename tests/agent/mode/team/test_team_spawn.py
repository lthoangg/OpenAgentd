"""Tests for AgentTeam.spawn / .dismiss + roster team_manage tool.

Covers:
- Lead-only-at-startup (no members materialised from blueprints).
- spawn() auto-suffixes (coder → coder#1, coder → coder#2).
- spawn(instance_id=N) restores a previously-dismissed instance with history.
- dismiss() preserves DB chat history.
- Counter is monotonic per (lead_session, blueprint) and survives restart
  by re-deriving from existing DB rows.
- Counter resets to #1 when a fresh lead session starts.
- Legacy bare-name session adoption — first ``coder#1`` spawn under a lead
  whose DB has a legacy ``coder`` row inherits that row.
- team_message recipient resolution: bare blueprint name routes to the
  unique live instance; ambiguous / not-spawned cases produce tailored
  errors; explicit handles route directly.
- Lead-only injection of roster tools.
- Blueprints disallow ``#`` in names + lead-name collision.
"""

from __future__ import annotations

import uuid
from pathlib import Path
import asyncio
from unittest.mock import AsyncMock

import pytest
import yaml
from sqlmodel import select

from app.agent.agent_loop import Agent
from app.agent.loader import load_team_from_dir
from app.agent.mode.team.mailbox import Message
from app.agent.mode.team.member import TeamMember
from app.agent.mode.team.team import (
    AgentTeam,
    MemberBlueprint,
    make_instance_handle,
    parse_instance_handle,
)
import app.core.db as _db_module
from app.agent.schemas.chat import HumanMessage
from app.models.chat import ChatSession, SessionMessage
from app.services.chat_service import (
    get_messages,
    get_messages_for_llm,
    save_message,
    undo_session_messages,
)
from tests.agent.mode.team.conftest import MockTeamProvider, make_text_chunk


def _session_factory():
    """Return the currently-active test session factory.

    ``conftest.setup_db`` swaps ``app.core.db.async_session_factory`` to
    point at the in-memory test engine.  Importing the symbol at module
    import time captures the *original* unpatched factory, which then
    fails because the test schema lives on a different engine — fetch
    the attribute at call time instead.
    """
    return _db_module.async_session_factory


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_md(
    path: Path,
    *,
    name: str,
    role: str = "member",
    description: str | None = None,
    skills: list[str] | None = None,
    body: str | None = None,
) -> Path:
    meta: dict = {"name": name, "role": role, "model": "mock:model"}
    if description is not None:
        meta["description"] = description
    if skills is not None:
        meta["skills"] = skills
    yaml_block = yaml.safe_dump(meta, sort_keys=False).strip()
    path.write_text(
        f"---\n{yaml_block}\n---\n{body or f'You are {name}.'}\n", encoding="utf-8"
    )
    return path


def _make_test_provider(model: str | None, model_kwargs: dict | None = None):
    """Stub provider factory — ignores the requested model and returns a mock.

    ``load_team_from_dir`` calls ``provider_factory(cfg.model, model_kwargs=...)``
    for every agent it builds.  Tests don't have real API keys configured, so
    the factory simply returns the same mock provider for every model id.
    """
    return MockTeamProvider("ok")


def _status_events(push_mock: AsyncMock) -> list[tuple[str, str]]:
    events: list[tuple[str, str]] = []
    for call in push_mock.call_args_list:
        envelope = call.args[1]
        if envelope.event == "agent_status":
            events.append((envelope.data["agent"], envelope.data["status"]))
    return events


async def _wait_for_lead_idle(team: AgentTeam) -> None:
    if team.lead._active_task is not None:
        await team.lead._active_task


def _build_dynamic_team(
    tmp_path: Path,
    blueprints: dict[str, dict | None],
) -> AgentTeam:
    """Build a real ``AgentTeam`` via ``load_team_from_dir``.

    *blueprints* maps blueprint name -> optional metadata dict (or ``None``
    for defaults).  A ``lead.md`` is always added for the loader to find a
    role:lead.
    """
    _write_md(tmp_path / "lead.md", name="lead", role="lead", description="lead")
    for name, meta in blueprints.items():
        meta = meta or {}
        _write_md(
            tmp_path / f"{name}.md",
            name=name,
            role="member",
            description=meta.get("description", name),
            skills=meta.get("skills"),
            body=meta.get("body"),
        )

    team = load_team_from_dir(tmp_path, provider_factory=_make_test_provider)
    assert team is not None
    return team


# ---------------------------------------------------------------------------
# Loader: lead-only at startup
# ---------------------------------------------------------------------------


class TestLoaderLeadOnly:
    """``load_team_from_dir`` should build only the lead, never members."""

    def test_lead_built_members_are_blueprints(self, tmp_path):
        team = _build_dynamic_team(
            tmp_path,
            {"coder": {"description": "writes files"}, "explorer": None},
        )
        assert team.lead.name == "lead"
        assert team.members == {}
        assert set(team.blueprints) == {"coder", "explorer"}
        assert team.blueprints["coder"].description == "writes files"

    def test_builtin_blueprint_description_is_effective_without_user_description(
        self, tmp_path
    ):
        from app.agent.builtin_prompts import BUILTIN_MEMBER_PROFILES

        _write_md(tmp_path / "lead.md", name="lead", role="lead")
        _write_md(tmp_path / "coder.md", name="coder", role="member")

        team = load_team_from_dir(tmp_path, provider_factory=_make_test_provider)

        assert team is not None
        assert (
            team.blueprints["coder"].description
            == BUILTIN_MEMBER_PROFILES["coding"]["coder"]["description"]
        )

    def test_blueprint_name_with_hash_is_rejected(self, tmp_path):
        _write_md(tmp_path / "lead.md", name="lead", role="lead")
        _write_md(tmp_path / "bad.md", name="coder#1", role="member")

        with pytest.raises(ValueError, match="Reserved character"):
            load_team_from_dir(tmp_path, provider_factory=_make_test_provider)

    def test_blueprint_collides_with_lead_name(self, tmp_path):
        _write_md(tmp_path / "lead.md", name="boss", role="lead")
        _write_md(tmp_path / "boss-mem.md", name="boss", role="member")

        with pytest.raises(ValueError, match="shares the lead's name"):
            load_team_from_dir(tmp_path, provider_factory=_make_test_provider)

    async def test_start_only_registers_lead(self, tmp_path):
        team = _build_dynamic_team(tmp_path, {"coder": None, "explorer": None})
        await team.start()
        try:
            assert team.mailbox.registered_agents == ["lead"]
            assert team.lead._active_task is None
        finally:
            await team.stop()


# ---------------------------------------------------------------------------
# spawn() — basic, auto-suffix, explicit instance_id
# ---------------------------------------------------------------------------


class TestSpawn:
    async def test_first_spawn_returns_hash_one(self, tmp_path):
        team = _build_dynamic_team(tmp_path, {"coder": None})
        await team.start()
        try:
            member = await team.spawn("coder")
            assert member.name == "coder#1"
            assert "coder#1" in team.members
            assert "coder#1" in team.mailbox.registered_agents
        finally:
            await team.stop()

    async def test_auto_suffix_for_parallel_instances(self, tmp_path):
        team = _build_dynamic_team(tmp_path, {"coder": None})
        await team.start()
        try:
            m1 = await team.spawn("coder")
            m2 = await team.spawn("coder")
            m3 = await team.spawn("coder")
            assert m1.name == "coder#1"
            assert m2.name == "coder#2"
            assert m3.name == "coder#3"
            assert set(team.members) == {"coder#1", "coder#2", "coder#3"}
        finally:
            await team.stop()

    async def test_spawned_instances_get_runtime_identity_prompt(self, tmp_path):
        team = _build_dynamic_team(
            tmp_path,
            {"coder": {"body": "You are `coder`, the reusable blueprint."}},
        )
        await team.start()
        try:
            m1 = await team.spawn("coder")
            m2 = await team.spawn("coder")

            prompt1 = m1.build_protocol(m1.agent.system_prompt, team)
            prompt2 = m2.build_protocol(m2.agent.system_prompt, team)

            assert "You are `coder#1`" in prompt1
            assert "You are `coder#2`" in prompt2
            assert "do not use the blueprint name" in prompt1
            assert "do not use the blueprint name" in prompt2
            assert prompt1.rfind("You are `coder#1`") > prompt1.find("You are `coder`")
            assert "**coder#1**" not in prompt1
            assert "**coder#2**" not in prompt1
        finally:
            await team.stop()

    async def test_restored_explicit_instance_keeps_handle_specific_identity(
        self, tmp_path
    ):
        team = _build_dynamic_team(tmp_path, {"coder": None})
        await team.start()
        try:
            member = await team.spawn("coder", instance_id=10)
            prompt = member.build_protocol(member.agent.system_prompt, team)

            assert member.name == "coder#10"
            assert member.agent.name == "coder#10"
            assert "You are `coder#10`" in prompt
            assert "You are `coder#1`" not in prompt
        finally:
            await team.stop()

    async def test_explicit_instance_id_skips_auto_counter(self, tmp_path):
        team = _build_dynamic_team(tmp_path, {"coder": None})
        await team.start()
        try:
            m_explicit = await team.spawn("coder", instance_id=5)
            assert m_explicit.name == "coder#5"
            # Next auto-spawn should be #6, not #2.
            m_next = await team.spawn("coder")
            assert m_next.name == "coder#6"
        finally:
            await team.stop()

    async def test_unknown_blueprint_raises(self, tmp_path):
        team = _build_dynamic_team(tmp_path, {"coder": None})
        await team.start()
        try:
            with pytest.raises(KeyError, match="Unknown blueprint"):
                await team.spawn("nope")
        finally:
            await team.stop()

    async def test_spawn_with_existing_handle_raises(self, tmp_path):
        team = _build_dynamic_team(tmp_path, {"coder": None})
        await team.start()
        try:
            await team.spawn("coder", instance_id=1)
            with pytest.raises(ValueError, match="already live"):
                await team.spawn("coder", instance_id=1)
        finally:
            await team.stop()

    async def test_negative_instance_id_rejected(self, tmp_path):
        team = _build_dynamic_team(tmp_path, {"coder": None})
        await team.start()
        try:
            with pytest.raises(ValueError, match="must be >= 1"):
                await team.spawn("coder", instance_id=0)
        finally:
            await team.stop()


# ---------------------------------------------------------------------------
# dismiss() — preserves DB session
# ---------------------------------------------------------------------------


class SlowProvider(MockTeamProvider):
    def stream(self, messages, tools=None, **kwargs):
        self.call_count += 1

        async def _gen():
            try:
                await asyncio.sleep(60)
            except asyncio.CancelledError:
                raise
            yield make_text_chunk(self.response_text)

        return _gen()


class TestDismiss:
    async def test_dismiss_returns_true_and_removes_from_roster(self, tmp_path):
        team = _build_dynamic_team(tmp_path, {"coder": None})
        await team.start()
        try:
            await team.spawn("coder")
            assert "coder#1" in team.members
            ok = await team.dismiss("coder#1")
            assert ok is True
            assert "coder#1" not in team.members
            assert "coder#1" not in team.mailbox.registered_agents
        finally:
            await team.stop()

    async def test_dismiss_unknown_handle_returns_false(self, tmp_path):
        team = _build_dynamic_team(tmp_path, {"coder": None})
        await team.start()
        try:
            ok = await team.dismiss("coder#42")
            assert ok is False
        finally:
            await team.stop()

    async def test_dismiss_working_member_cancels_cleanly(self, tmp_path):
        team = _build_dynamic_team(tmp_path, {"coder": None})
        await team.start()
        try:
            member = await team.spawn("coder")
            member.agent.llm_provider = SlowProvider("OK")

            await team.mailbox.send(
                to="coder#1",
                message=Message(
                    from_agent="lead", to_agent="coder#1", content="[lead]: task"
                ),
            )
            await asyncio.sleep(0.05)
            assert member.state == "working"

            assert await team.dismiss("coder#1") is True
            assert "coder#1" not in team.members
            assert member.state == "idle"
        finally:
            await team.stop()

    async def test_dismiss_keeps_db_session_for_respawn(self, tmp_path):
        team = _build_dynamic_team(tmp_path, {"coder": None})
        await team.start()
        try:
            # Establish a lead session id first so child sessions parent to it.
            await team.handle_user_message("Hi", session_id=str(uuid.uuid7()))
            member = await team.spawn("coder")
            old_session_id = uuid.UUID(member.session_id)

            await team.dismiss("coder#1")

            # DB row should still exist after dismiss.
            async with _session_factory()() as db:
                row = await db.get(ChatSession, old_session_id)
                assert row is not None
                assert row.agent_name == "coder#1"

            # Respawning #1 should restore the same DB session id.
            restored = await team.spawn("coder", instance_id=1)
            assert restored.session_id == str(old_session_id)
        finally:
            await team.stop()

    async def test_roster_changes_persist_hidden_llm_visible_messages(self, tmp_path):
        team = _build_dynamic_team(tmp_path, {"coder": None, "explorer": None})
        lead_session_id = uuid.uuid7()
        await team.start()
        try:
            await team.handle_user_message("Hi", session_id=str(lead_session_id))
            await team.spawn("coder")
            await team.spawn("explorer")
            await team.dismiss("coder#1")

            async with _session_factory()() as db:
                rows = (
                    await db.exec(
                        select(SessionMessage)
                        .where(SessionMessage.session_id == lead_session_id)
                        .order_by(SessionMessage.created_at, SessionMessage.id)
                    )
                ).all()
                roster_rows = [
                    r for r in rows if r.extra and r.extra.get("roster_change")
                ]

                assert [r.role for r in roster_rows] == ["user", "user", "user"]
                assert [r.kind for r in roster_rows] == ["note"] * 3
                assert [r.pinned for r in roster_rows] == [True] * 3
                assert all(
                    r.extra and r.extra.get("hidden_from_user") is True
                    for r in roster_rows
                )
                assert all(
                    r.extra and r.extra.get("hidden_from_summary") is True
                    for r in roster_rows
                )
                assert "Member spawned: coder#1" in (roster_rows[0].content or "")
                assert "Live members: coder#1" in (roster_rows[0].content or "")
                assert "Member spawned: explorer#1" in (roster_rows[1].content or "")
                assert "coder#1, explorer#1" in (roster_rows[1].content or "")
                assert "Member dismissed: coder#1" in (roster_rows[2].content or "")
                assert "Live members: explorer#1" in (roster_rows[2].content or "")

                visible = await get_messages(db, lead_session_id)
                assert all(
                    "Available members changed" not in (m.content or "")
                    for m in visible
                )

                llm_messages = await get_messages_for_llm(db, lead_session_id)
                assert [
                    m.content
                    for m in llm_messages
                    if m.extra and m.extra.get("roster_change")
                ] == [r.content for r in roster_rows]
        finally:
            await team.stop()

    async def test_undo_skips_hidden_roster_change_messages(self, tmp_path):
        team = _build_dynamic_team(tmp_path, {"coder": None})
        lead_session_id = uuid.uuid7()
        await team.start()
        try:
            await team.handle_user_message("Hi", session_id=str(lead_session_id))
            async with _session_factory()() as db:
                await save_message(
                    db, lead_session_id, HumanMessage(content="visible turn")
                )
                await db.commit()

            await team.spawn("coder")

            async with _session_factory()() as db:
                shift = await undo_session_messages(db, lead_session_id)
                await db.commit()

                assert shift.applied is True
                assert shift.target is not None
                assert shift.target.content == "visible turn"
        finally:
            await team.stop()


# ---------------------------------------------------------------------------
# lifecycle SSE status events
# ---------------------------------------------------------------------------


class TestLifecycleStatusEvents:
    async def test_spawn_emits_idle_status(self, tmp_path, mock_stream_store):
        team = _build_dynamic_team(tmp_path, {"coder": None})
        await team.start()
        try:
            await team.spawn("coder")
            assert ("coder#1", "idle") in _status_events(mock_stream_store)
        finally:
            await team.stop()

    async def test_member_activation_emits_working_then_idle(
        self,
        tmp_path,
        mock_stream_store,
    ):
        team = _build_dynamic_team(tmp_path, {"coder": None})
        await team.start()
        try:
            member = await team.spawn("coder")
            mock_stream_store.reset_mock()

            await team.mailbox.send(
                to="coder#1",
                message=Message(
                    from_agent="lead",
                    to_agent="coder#1",
                    content="[lead]: do one thing",
                ),
            )
            assert member._active_task is not None
            await member._active_task

            statuses = _status_events(mock_stream_store)
            assert statuses[0] == ("coder#1", "working")
            assert statuses[-1] == ("coder#1", "idle")
            assert member.state == "idle"
        finally:
            await team.stop()

    async def test_dismiss_emits_offline_status(self, tmp_path, mock_stream_store):
        team = _build_dynamic_team(tmp_path, {"coder": None})
        await team.start()
        try:
            await team.spawn("coder")
            mock_stream_store.reset_mock()

            assert await team.dismiss("coder#1") is True
            assert ("coder#1", "offline") in _status_events(mock_stream_store)
        finally:
            await team.stop()


# ---------------------------------------------------------------------------
# Counter scope + restart safety
# ---------------------------------------------------------------------------


class TestCounter:
    async def test_counter_resets_on_new_lead_session(self, tmp_path):
        team = _build_dynamic_team(tmp_path, {"coder": None})
        await team.start()
        try:
            # First session: spawn three.
            sid1 = str(uuid.uuid7())
            await team.handle_user_message("a", session_id=sid1)
            await _wait_for_lead_idle(team)
            for _ in range(3):
                await team.spawn("coder")
            assert sorted(team.members) == [
                "coder#1",
                "coder#2",
                "coder#3",
            ]

            # Switch to a fresh lead session — counters should reset.
            sid2 = str(uuid.uuid7())
            await team.handle_user_message("b", session_id=sid2)
            await _wait_for_lead_idle(team)
            # Old spawned ``blueprint#N`` instances are dropped on session
            # change because they have no DB rows under the new lead.
            assert team.members == {}

            m = await team.spawn("coder")
            assert m.name == "coder#1"
        finally:
            await team.stop()

    async def test_counter_survives_restart(self, tmp_path):
        # First "process": spawn #1, #2, #3 under a lead session, dismiss
        # them, then build a fresh AgentTeam against the same DB.  The new
        # team's first auto-spawn should be #4 (or any value > 3).
        team1 = _build_dynamic_team(tmp_path, {"coder": None})
        await team1.start()
        sid = str(uuid.uuid7())
        try:
            await team1.handle_user_message("hi", session_id=sid)
            await _wait_for_lead_idle(team1)
            for _ in range(3):
                await team1.spawn("coder")
            for n in (1, 2, 3):
                await team1.dismiss(f"coder#{n}")
        finally:
            await team1.stop()

        # Fresh team — same agents dir, same DB.
        team2 = _build_dynamic_team(tmp_path, {"coder": None})
        await team2.start()
        try:
            # Re-bind the lead to the same session id so counter
            # reconciliation reads our existing rows.
            await team2.handle_user_message("hi again", session_id=sid)
            await _wait_for_lead_idle(team2)
            m = await team2.spawn("coder")
            # max(existing #N) was 3 → next is 4.
            assert m.name == "coder#4"
        finally:
            await team2.stop()


# ---------------------------------------------------------------------------
# Legacy bare-name adoption
# ---------------------------------------------------------------------------


class TestLegacyAdoption:
    async def test_first_spawn_adopts_legacy_bare_name_session(self, tmp_path):
        team = _build_dynamic_team(tmp_path, {"coder": None})
        await team.start()
        try:
            sid = str(uuid.uuid7())
            await team.handle_user_message("hello", session_id=sid)
            lead_uuid = uuid.UUID(sid)

            # Pre-create a legacy bare-name child session.
            async with _session_factory()() as db:
                legacy = ChatSession(
                    parent_session_id=lead_uuid,
                    agent_name="coder",
                    title="legacy coder",
                )
                db.add(legacy)
                await db.commit()
                legacy_id = legacy.id

            # First spawn for this blueprint under this lead → should
            # adopt the legacy row as ``coder#1``.
            m = await team.spawn("coder")
            assert m.name == "coder#1"
            assert m.session_id == str(legacy_id)

            async with _session_factory()() as db:
                row = await db.get(ChatSession, legacy_id)
                assert row is not None
                await db.refresh(row)
                assert row.agent_name == "coder#1"
        finally:
            await team.stop()


# ---------------------------------------------------------------------------
# team_message recipient resolution
# ---------------------------------------------------------------------------


class TestRecipientResolution:
    def test_resolve_bare_name_when_unique(self, tmp_path):
        team = _build_dynamic_team(tmp_path, {"coder": None})
        # Manually add a single live instance without going through DB.
        agent = Agent(name="coder#1", llm_provider=MockTeamProvider("ok"))
        team.members["coder#1"] = TeamMember(agent)
        team._members_by_name["coder#1"] = team.members["coder#1"]
        team.mailbox.register("coder#1")

        assert team.resolve_recipient("coder") == "coder#1"
        assert team.resolve_recipient("coder#1") == "coder#1"
        assert team.resolve_recipient("lead") == "lead"

    def test_resolve_bare_name_ambiguous_returns_none(self, tmp_path):
        team = _build_dynamic_team(tmp_path, {"coder": None})
        for n in (1, 2):
            agent = Agent(name=f"coder#{n}", llm_provider=MockTeamProvider("ok"))
            handle = f"coder#{n}"
            team.members[handle] = TeamMember(agent)
            team._members_by_name[handle] = team.members[handle]
            team.mailbox.register(handle)

        assert team.resolve_recipient("coder") is None
        # Explicit handles still resolve.
        assert team.resolve_recipient("coder#1") == "coder#1"
        assert team.resolve_recipient("coder#2") == "coder#2"

    def test_resolve_unknown_returns_none(self, tmp_path):
        team = _build_dynamic_team(tmp_path, {"coder": None})
        assert team.resolve_recipient("ghost") is None

    def test_live_instances_for_blueprint_sorted(self, tmp_path):
        team = _build_dynamic_team(tmp_path, {"coder": None})
        for n in (3, 1, 2):
            agent = Agent(name=f"coder#{n}", llm_provider=MockTeamProvider("ok"))
            handle = f"coder#{n}"
            team.members[handle] = TeamMember(agent)
            team._members_by_name[handle] = team.members[handle]
            team.mailbox.register(handle)

        assert team.live_instances_for_blueprint("coder") == [
            "coder#1",
            "coder#2",
            "coder#3",
        ]


# ---------------------------------------------------------------------------
# roster team_manage tool surface
# ---------------------------------------------------------------------------


class TestRosterManageTool:
    async def test_lead_gets_manage_tool(self, tmp_path):
        team = _build_dynamic_team(tmp_path, {"coder": None})
        injected = team.get_injected_tools(team.lead.name)
        names = {t.name for t in injected}
        assert "team_manage" in names
        assert "team_configure" not in names
        assert "team_message" in names
        assert "todo_manage" in names

    async def test_team_manage_description_contains_spawn_restore_guidance(
        self, tmp_path
    ):
        from app.agent.mode.team.manage import make_team_manage_tool

        team = _build_dynamic_team(tmp_path, {"coder": None})
        tool = make_team_manage_tool(team)

        assert "List live handles and spawnable blueprints" in tool.description
        assert "spawn listed blueprints or restorable handles" in tool.description
        assert "dismiss explicit live handles" in tool.description
        assert "Lead-only" not in tool.description
        assert "coder" not in tool.description

    async def test_members_do_not_get_manage_tools(self, tmp_path):
        team = _build_dynamic_team(tmp_path, {"coder": None})
        await team.start()
        try:
            member = await team.spawn("coder")
            injected = team.get_injected_tools(member.name)
            names = {t.name for t in injected}
            assert "team_manage" not in names
            assert "team_configure" not in names
            assert "team_message" in names
            assert "todo_manage" in names
        finally:
            await team.stop()

    async def test_spawn_batch_returns_handles_only(self, tmp_path):
        from app.agent.mode.team.manage import make_team_manage_tool

        team = _build_dynamic_team(tmp_path, {"coder": None, "explorer": None})
        tool = make_team_manage_tool(team)
        await team.start()
        try:
            result = await tool(action="spawn", members=["coder", "coder", "explorer"])
            assert "coder#1" in result
            assert "coder#2" in result
            assert "explorer#1" in result
            assert "session_id" not in result
        finally:
            await team.stop()

    async def test_spawn_explicit_handle_reuses_history(self, tmp_path):
        from app.agent.mode.team.manage import make_team_manage_tool

        team = _build_dynamic_team(tmp_path, {"coder": None})
        tool = make_team_manage_tool(team)
        await team.start()
        try:
            first = await tool(action="spawn", members=["coder#3"])
            assert "coder#3" in first
            await tool(action="dismiss", members=["coder#3"])
            second = await tool(action="spawn", members=["coder#3"])
            assert "coder#3" in second
            assert set(team.members) == {"coder#3"}
        finally:
            await team.stop()

    async def test_spawn_unknown_blueprint_reports_available(self, tmp_path):
        from app.agent.mode.team.manage import make_team_manage_tool

        team = _build_dynamic_team(tmp_path, {"coder": None})
        tool = make_team_manage_tool(team)
        result = await tool(action="spawn", members=["ghost"])
        assert "Unknown blueprints: ghost" in result
        assert "coder" in result

    async def test_spawn_unknown_blueprints_are_grouped(self, tmp_path):
        from app.agent.mode.team.manage import make_team_manage_tool

        team = _build_dynamic_team(tmp_path, {"coder": None, "explorer": None})
        tool = make_team_manage_tool(team)
        result = await tool(action="spawn", members=["design", "frontend", "writer"])
        assert "Unknown blueprints: design, frontend, writer." in result
        assert result.count("Available:") == 1
        assert "coder" in result
        assert "explorer" in result

    async def test_list_reports_spawnable_blueprints(self, tmp_path):
        from app.agent.mode.team.manage import make_team_manage_tool

        team = _build_dynamic_team(tmp_path, {"coder": {"description": "writes files"}})
        tool = make_team_manage_tool(team)
        result = await tool(action="list", members=[])
        assert "Spawnable blueprints" in result
        assert "coder — writes files" in result

    async def test_list_reports_live_members(self, tmp_path):
        from app.agent.mode.team.manage import make_team_manage_tool

        team = _build_dynamic_team(tmp_path, {"coder": None})
        tool = make_team_manage_tool(team)
        await team.start()
        try:
            await team.spawn("coder")
            result = await tool(action="list", members=[])
            assert "Live: coder#1" in result
            assert "Spawnable blueprints: coder" in result
        finally:
            await team.stop()

    async def test_dismiss_batch_and_partial_success(self, tmp_path):
        from app.agent.mode.team.manage import make_team_manage_tool

        team = _build_dynamic_team(tmp_path, {"coder": None})
        tool = make_team_manage_tool(team)
        await team.start()
        try:
            await tool(action="spawn", members=["coder", "coder"])
            result = await tool(action="dismiss", members=["coder#1", "coder#99"])
            assert "Dismissed: coder#1" in result
            assert "Not live: coder#99" in result
            assert set(team.members) == {"coder#2"}
        finally:
            await team.stop()

    async def test_dismiss_requires_explicit_handles(self, tmp_path):
        from app.agent.mode.team.manage import make_team_manage_tool

        team = _build_dynamic_team(tmp_path, {"coder": None})
        tool = make_team_manage_tool(team)
        await team.start()
        try:
            await tool(action="spawn", members=["coder", "coder"])
            result = await tool(action="dismiss", members=["coder"])
            assert "Use explicit handles" in result
            assert "coder#1" in result and "coder#2" in result
        finally:
            await team.stop()

    async def test_team_manage_coercion(self, tmp_path):
        from app.agent.mode.team.manage import make_team_manage_tool

        team = _build_dynamic_team(tmp_path, {"coder": None, "explorer": None})
        tool = make_team_manage_tool(team)
        await team.start()
        try:
            # Coerce single string: "coder"
            result1 = await tool.arun(action="spawn", members="coder")
            assert "coder#1" in result1

            # Coerce comma-separated string: "coder, explorer"
            result2 = await tool.arun(action="spawn", members="coder, explorer")
            assert "coder#2" in result2
            assert "explorer#1" in result2

            # Coerce JSON-stringified list: '["explorer"]'
            result3 = await tool.arun(action="spawn", members='["explorer"]')
            assert "explorer#2" in result3

            # Coerce singular member param: member="coder"
            result4 = await tool.arun(action="spawn", member="coder")
            assert "coder#3" in result4
        finally:
            await team.stop()


# ---------------------------------------------------------------------------
# Handle parsing + formatting helpers
# ---------------------------------------------------------------------------


class TestHandleHelpers:
    def test_parse_valid(self):
        assert parse_instance_handle("coder#1") == ("coder", 1)
        assert parse_instance_handle("alpha-beta#42") == ("alpha-beta", 42)

    def test_parse_invalid(self):
        assert parse_instance_handle("coder") is None
        assert parse_instance_handle("coder#abc") is None
        assert parse_instance_handle("coder#") is None
        assert parse_instance_handle("") is None

    def test_make(self):
        assert make_instance_handle("coder", 7) == "coder#7"


# ---------------------------------------------------------------------------
# AgentTeam constructor accepts pre-built blueprints (smoke)
# ---------------------------------------------------------------------------


class TestAgentTeamConstructorBlueprints:
    """Smoke: blueprints can be passed via the constructor without the loader."""

    async def test_blueprint_dataclass_holds_metadata(self, tmp_path):
        path = _write_md(tmp_path / "ex.md", name="coder", description="d")
        bp = MemberBlueprint(name="coder", description="d", source_path=path)
        assert bp.name == "coder"
        assert bp.next_instance_id == 1
        assert bp.counter_reconciled_for is None

    async def test_get_status_includes_blueprints(self, tmp_path):
        team = _build_dynamic_team(tmp_path, {"coder": {"description": "d"}})
        status = team.status()
        assert "blueprints" in status
        bp_names = [b["name"] for b in status["blueprints"]]
        assert "coder" in bp_names


# ---------------------------------------------------------------------------
# Round-trip via load_team_from_dir + spawn (smoke)
# ---------------------------------------------------------------------------


class TestEndToEndSmoke:
    async def test_spawn_message_dismiss_via_real_team(self, tmp_path):
        team = _build_dynamic_team(
            tmp_path,
            {
                "coder": {"description": "executes"},
                "explorer": {"description": "explores"},
            },
        )
        await team.start()
        try:
            assert team.members == {}

            # Spawn one of each.
            ex = await team.spawn("coder")
            xp = await team.spawn("explorer")
            assert ex.name == "coder#1"
            assert xp.name == "explorer#1"
            assert {ex.name, xp.name}.issubset(team.mailbox.registered_agents)

            # Dismiss explorer.
            await team.dismiss("explorer#1")
            assert "explorer#1" not in team.members

            # Lead's introspection reflects state.
            status = team.status()
            assert any(m["name"] == "coder#1" for m in status["members"])
            assert all(m["name"] != "explorer#1" for m in status["members"])
        finally:
            await team.stop()


# ---------------------------------------------------------------------------
# Stored DB rows for completeness (paranoia check on counter reconciliation)
# ---------------------------------------------------------------------------


async def test_counter_reconciliation_reads_db(tmp_path):
    """Pre-existing high-numbered child rows should bump the counter."""
    team = _build_dynamic_team(tmp_path, {"coder": None})
    await team.start()
    try:
        sid = str(uuid.uuid7())
        await team.handle_user_message("hi", session_id=sid)
        if team.lead._active_task is not None:
            await team.lead._active_task
        lead_uuid = uuid.UUID(sid)

        # Pre-create coder#7 under this lead.
        async with _session_factory()() as db:
            db.add(
                ChatSession(
                    parent_session_id=lead_uuid,
                    agent_name="coder#7",
                    title="coder#7",
                )
            )
            await db.commit()

        m = await team.spawn("coder")  # should auto-pick #8
        assert m.name == "coder#8"

        # Confirm the row count makes sense.
        async with _session_factory()() as db:
            result = await db.exec(
                select(ChatSession).where(ChatSession.parent_session_id == lead_uuid)
            )
            child_names = {row.agent_name for row in result.all()}
            assert "coder#7" in child_names
            assert "coder#8" in child_names
    finally:
        await team.stop()
