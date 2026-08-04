"""Tests for app/agent/mode/team/board.py — board-driven activation.

The todo board is the team's coordination backbone: board mutations produce
transition-edge events that wake the right agents through the mailbox.

Covers:
- derive_board_events: pure before/after store diff → TaskReady / TaskCompleted
- dispatch_board_events: events → system-authored mailbox messages
- make_team_todo_tool: team-bound todo_manage wrapper wiring apply + diff + dispatch
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.agent.agent_loop import Agent
from app.agent.mode.team.board import (
    TaskCompleted,
    TaskReady,
    derive_board_events,
    dispatch_board_events,
    make_team_todo_tool,
)
from app.agent.mode.team.member import TeamLead, TeamMember
from app.agent.mode.team.team import AgentTeam
from app.agent.sandbox import SandboxConfig, set_sandbox
from app.agent.tools.builtin.todo import TODOS_FILENAME

from .conftest import MockTeamProvider


# ---------------------------------------------------------------------------
# Store builders
# ---------------------------------------------------------------------------


def _item(
    task_id: str,
    *,
    status: str = "pending",
    assigned_to: str | None = None,
    claimed_by: str | None = None,
    dependencies: list[str] | None = None,
    content: str = "work",
    instructions: str | None = None,
    result: str | None = None,
) -> dict:
    return {
        "task_id": task_id,
        "content": content,
        "status": status,
        "priority": "high",
        "dependencies": dependencies or [],
        "assigned_to": assigned_to,
        "claimed_by": claimed_by,
        "instructions": instructions,
        "result": result,
    }


def _store(*items: dict) -> dict:
    return {"counter": len(items), "items": list(items)}


# ---------------------------------------------------------------------------
# derive_board_events — pure diff
# ---------------------------------------------------------------------------


class TestDeriveReady:
    def test_new_assigned_unblocked_task_emits_ready(self):
        before = _store()
        after = _store(_item("task_1", assigned_to="executor#1", instructions="do X"))

        events = derive_board_events(before, after)

        assert events == [
            TaskReady(
                task_id="task_1",
                assignee="executor#1",
                content="work",
                instructions="do X",
                dependency_results=(),
            )
        ]

    def test_assigned_task_with_open_deps_is_not_ready(self):
        before = _store()
        after = _store(
            _item("task_1", assigned_to="executor#1"),
            _item("task_2", assigned_to="executor#2", dependencies=["task_1"]),
        )

        events = derive_board_events(before, after)

        assert [e for e in events if isinstance(e, TaskReady)] == [
            TaskReady(
                task_id="task_1",
                assignee="executor#1",
                content="work",
                instructions=None,
                dependency_results=(),
            )
        ]

    def test_completing_dependency_unblocks_dependent_with_results(self):
        before = _store(
            _item(
                "task_1",
                status="in_progress",
                assigned_to="executor#1",
                claimed_by="executor#1",
            ),
            _item("task_2", assigned_to="executor#2", dependencies=["task_1"]),
        )
        after = _store(
            _item(
                "task_1",
                status="completed",
                assigned_to="executor#1",
                claimed_by="executor#1",
                result="found the root cause",
            ),
            _item("task_2", assigned_to="executor#2", dependencies=["task_1"]),
        )

        events = derive_board_events(before, after)

        ready = [e for e in events if isinstance(e, TaskReady)]
        assert ready == [
            TaskReady(
                task_id="task_2",
                assignee="executor#2",
                content="work",
                instructions=None,
                dependency_results=(("task_1", "work", "found the root cause"),),
            )
        ]

    def test_one_completion_unblocks_multiple_dependents(self):
        before = _store(
            _item("task_1", status="in_progress", claimed_by="executor#1"),
            _item("task_2", assigned_to="executor#2", dependencies=["task_1"]),
            _item("task_3", assigned_to="executor#3", dependencies=["task_1"]),
        )
        after = _store(
            _item("task_1", status="completed", claimed_by="executor#1", result="ok"),
            _item("task_2", assigned_to="executor#2", dependencies=["task_1"]),
            _item("task_3", assigned_to="executor#3", dependencies=["task_1"]),
        )

        events = derive_board_events(before, after)

        ready_assignees = {e.assignee for e in events if isinstance(e, TaskReady)}
        assert ready_assignees == {"executor#2", "executor#3"}
        assert sum(isinstance(e, TaskCompleted) for e in events) == 1

    def test_claim_transition_emits_nothing(self):
        before = _store(_item("task_1", assigned_to="executor#1"))
        after = _store(
            _item(
                "task_1",
                status="in_progress",
                assigned_to="executor#1",
                claimed_by="executor#1",
            )
        )

        assert derive_board_events(before, after) == []

    def test_unchanged_ready_task_does_not_refire(self):
        store = _store(_item("task_1", assigned_to="executor#1"))
        assert derive_board_events(store, store) == []

    def test_reassignment_fires_ready_for_new_assignee(self):
        before = _store(_item("task_1", assigned_to="executor#1"))
        after = _store(_item("task_1", assigned_to="executor#2"))

        events = derive_board_events(before, after)

        assert [e.assignee for e in events if isinstance(e, TaskReady)] == [
            "executor#2"
        ]

    def test_unassigned_task_never_fires_ready(self):
        before = _store()
        after = _store(_item("task_1"))

        assert derive_board_events(before, after) == []

    def test_cancelled_task_never_fires_ready(self):
        before = _store()
        after = _store(_item("task_1", status="cancelled", assigned_to="executor#1"))

        assert derive_board_events(before, after) == []


class TestDeriveCompleted:
    def test_completion_emits_completed_with_result(self):
        before = _store(
            _item(
                "task_1",
                status="in_progress",
                assigned_to="executor#1",
                claimed_by="executor#1",
            )
        )
        after = _store(
            _item(
                "task_1",
                status="completed",
                assigned_to="executor#1",
                claimed_by="executor#1",
                result="done and verified",
            )
        )

        events = derive_board_events(before, after)

        assert [e for e in events if isinstance(e, TaskCompleted)] == [
            TaskCompleted(
                task_id="task_1",
                content="work",
                result="done and verified",
                completed_by="executor#1",
            )
        ]

    def test_already_completed_task_does_not_refire(self):
        store = _store(_item("task_1", status="completed", claimed_by="executor#1"))
        assert derive_board_events(store, store) == []

    def test_cancellation_does_not_emit_completed(self):
        before = _store(_item("task_1", assigned_to="executor#1"))
        after = _store(_item("task_1", status="cancelled", assigned_to="executor#1"))

        assert derive_board_events(before, after) == []


# ---------------------------------------------------------------------------
# Team fixtures — handles that satisfy the assigned_to pattern
# ---------------------------------------------------------------------------


@pytest.fixture
def tmp_sandbox(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> SandboxConfig:
    monkeypatch.setattr(
        "app.core.config.settings.OPENAGENTD_DATA_DIR", str(tmp_path / "data")
    )
    sandbox = SandboxConfig(workspace=str(tmp_path), session_id="session-1")
    set_sandbox(sandbox)
    return sandbox


@pytest.fixture
def handle_team() -> AgentTeam:
    """Team whose members use spawned-instance handles (``executor#N``).

    Activation is stubbed out: these tests assert mailbox delivery (the
    activation contract itself is covered by test_activation.py), and real
    activations would hit the DB for sessions that don't exist here.
    """
    lead = TeamLead(Agent(name="lead", llm_provider=MockTeamProvider("OK")))
    exec1 = TeamMember(Agent(name="executor#1", llm_provider=MockTeamProvider("OK")))
    exec2 = TeamMember(Agent(name="executor#2", llm_provider=MockTeamProvider("OK")))
    team = AgentTeam(lead=lead, members={"executor#1": exec1, "executor#2": exec2})
    for agent in (lead, exec1, exec2):
        agent.register(team)
        agent._maybe_activate = lambda: None  # type: ignore[method-assign]
    return team


# ---------------------------------------------------------------------------
# dispatch_board_events
# ---------------------------------------------------------------------------


class TestDispatch:
    async def test_ready_event_delivers_system_message_to_assignee(self, handle_team):
        event = TaskReady(
            task_id="task_1",
            assignee="executor#1",
            content="Build the parser",
            instructions="No new deps.",
            dependency_results=(),
        )

        await dispatch_board_events(handle_team, [event], actor="lead")

        msg = handle_team.mailbox.receive_nowait("executor#1")
        assert msg.from_agent == "system"
        assert "task_1" in msg.content
        assert "Build the parser" in msg.content
        assert "No new deps." in msg.content

    async def test_completed_event_delivers_result_to_lead(self, handle_team):
        event = TaskCompleted(
            task_id="task_1",
            content="Build the parser",
            result="Parser built, tests green.",
            completed_by="executor#1",
        )

        await dispatch_board_events(handle_team, [event], actor="executor#1")

        msg = handle_team.mailbox.receive_nowait("lead")
        assert msg.from_agent == "system"
        assert "executor#1" in msg.content
        assert "Parser built, tests green." in msg.content

    async def test_actor_is_never_notified_of_own_mutation(self, handle_team):
        event = TaskCompleted(
            task_id="task_1",
            content="Self-managed task",
            result="done",
            completed_by="lead",
        )

        await dispatch_board_events(handle_team, [event], actor="lead")

        assert handle_team.mailbox.inbox_empty("lead")

    async def test_ready_event_for_non_live_assignee_is_skipped(self, handle_team):
        event = TaskReady(
            task_id="task_1",
            assignee="ghost#9",
            content="work",
            instructions=None,
            dependency_results=(),
        )

        # Must not raise (no inbox registered for ghost#9).
        await dispatch_board_events(handle_team, [event], actor="lead")


# ---------------------------------------------------------------------------
# make_team_todo_tool — end-to-end wiring
# ---------------------------------------------------------------------------


class TestTeamTodoTool:
    async def test_assignment_wakes_assignee(self, handle_team, tmp_sandbox):
        tool = make_team_todo_tool(handle_team, agent_name="lead", role="lead")

        result = await tool.arun(
            actions=[
                {
                    "action": "create",
                    "content": "Build the parser",
                    "status": "pending",
                    "priority": "high",
                    "assigned_to": "executor#1",
                    "instructions": "Use existing tokenizer.",
                }
            ]
        )

        assert "task_1" in result
        msg = handle_team.mailbox.receive_nowait("executor#1")
        assert msg.from_agent == "system"
        assert "Use existing tokenizer." in msg.content

    async def test_member_completion_wakes_lead(self, handle_team, tmp_sandbox):
        lead_tool = make_team_todo_tool(handle_team, agent_name="lead", role="lead")
        member_tool = make_team_todo_tool(
            handle_team, agent_name="executor#1", role="member"
        )

        await lead_tool.arun(
            actions=[
                {
                    "action": "create",
                    "content": "Investigate bug",
                    "status": "pending",
                    "priority": "high",
                    "assigned_to": "executor#1",
                }
            ]
        )
        # Drain the assignment wake so only the completion wake remains.
        handle_team.mailbox.receive_nowait("executor#1")

        await member_tool.arun(actions=[{"action": "claim", "task_id": "task_1"}])
        await member_tool.arun(
            actions=[
                {
                    "action": "update",
                    "task_id": "task_1",
                    "status": "completed",
                    "result": "Fixed in commit abc123.",
                }
            ]
        )

        msg = handle_team.mailbox.receive_nowait("lead")
        assert msg.from_agent == "system"
        assert "Fixed in commit abc123." in msg.content

    async def test_injected_todo_tool_is_board_aware(self, handle_team, tmp_sandbox):
        """AgentTeam.get_injected_tools wires the team-bound todo tool."""
        tools = {t.name: t for t in handle_team.get_injected_tools("lead")}

        await tools["todo_manage"].arun(
            actions=[
                {
                    "action": "create",
                    "content": "Injected wiring",
                    "status": "pending",
                    "priority": "high",
                    "assigned_to": "executor#1",
                }
            ]
        )

        msg = handle_team.mailbox.receive_nowait("executor#1")
        assert msg.from_agent == "system"
        assert "task_1" in msg.content

    async def test_store_written_like_plain_tool(self, handle_team, tmp_sandbox):
        tool = make_team_todo_tool(handle_team, agent_name="lead", role="lead")
        await tool.arun(
            actions=[
                {
                    "action": "create",
                    "content": "Plain persistence",
                    "status": "pending",
                    "priority": "low",
                }
            ]
        )

        store = json.loads(
            tmp_sandbox.metadata_path(TODOS_FILENAME).read_text(encoding="utf-8")
        )
        assert store["items"][0]["content"] == "Plain persistence"


class TestTodoEndTurn:
    """Member todo_manage supports the structured turn-end signal."""

    async def test_member_end_turn_sets_state_flag(self, handle_team, tmp_sandbox):
        lead_tool = make_team_todo_tool(handle_team, agent_name="lead", role="lead")
        member_tool = make_team_todo_tool(
            handle_team, agent_name="executor#1", role="member"
        )
        await lead_tool.arun(
            actions=[
                {
                    "action": "create",
                    "content": "Solo task",
                    "status": "pending",
                    "priority": "high",
                    "assigned_to": "executor#1",
                }
            ]
        )

        class _RunState:
            metadata: dict = {}

        state = _RunState()
        state.metadata = {}
        await member_tool.arun(
            _injected={"_state": state},
            actions=[{"action": "claim", "task_id": "task_1"}],
        )
        assert "end_turn" not in state.metadata

        await member_tool.arun(
            _injected={"_state": state},
            actions=[
                {
                    "action": "update",
                    "task_id": "task_1",
                    "status": "completed",
                    "result": "done",
                }
            ],
            end_turn=True,
        )
        assert state.metadata.get("end_turn") is True

    async def test_member_schema_exposes_end_turn(self, handle_team):
        tool = make_team_todo_tool(handle_team, agent_name="executor#1", role="member")
        props = tool.definition["function"]["parameters"]["properties"]
        assert "end_turn" in props

    async def test_lead_schema_has_no_end_turn(self, handle_team):
        tool = make_team_todo_tool(handle_team, agent_name="lead", role="lead")
        props = tool.definition["function"]["parameters"]["properties"]
        assert "end_turn" not in props


# ---------------------------------------------------------------------------
# Restart reconciliation — restore re-wakes members with resumable tasks
# ---------------------------------------------------------------------------


class TestResumableTasks:
    """Pure selection of tasks an actor should be woken for after restore."""

    def test_claimed_in_progress_and_ready_assigned_are_resumable(self):
        from app.agent.mode.team.board import resumable_tasks

        store = _store(
            _item(
                "task_1",
                status="in_progress",
                assigned_to="executor#1",
                claimed_by="executor#1",
            ),
            _item("task_2", assigned_to="executor#1"),
            _item("task_3", assigned_to="executor#1", dependencies=["task_2"]),
            _item("task_4", assigned_to="executor#2"),
            _item("task_5", status="completed", claimed_by="executor#1"),
        )

        ids = [t["task_id"] for t in resumable_tasks(store, "executor#1")]
        assert ids == ["task_1", "task_2"]


class TestRestoreRewake:
    async def test_restore_wakes_members_with_resumable_tasks(
        self, tmp_path, monkeypatch
    ):
        """After a restart/session restore, surviving open tasks re-wake
        their assignees — the in-memory mailbox died with the process, the
        board did not."""
        import uuid
        from contextlib import asynccontextmanager
        from unittest.mock import AsyncMock, MagicMock

        monkeypatch.setattr(
            "app.core.config.settings.OPENAGENTD_DATA_DIR", str(tmp_path / "data")
        )
        lead_uuid = uuid.uuid7()

        # Seed the board: executor#1 crashed mid-task, executor#2 has nothing.
        from app.agent.artifacts import todos_path

        board_path = todos_path(str(lead_uuid))
        board_path.parent.mkdir(parents=True, exist_ok=True)
        board_path.write_text(
            json.dumps(
                _store(
                    _item(
                        "task_1",
                        status="in_progress",
                        assigned_to="executor#1",
                        claimed_by="executor#1",
                        content="Interrupted work",
                    )
                )
            ),
            encoding="utf-8",
        )

        handles = ["executor#1", "executor#2"]
        rows = []
        for handle in handles:
            row = MagicMock()
            row.id = uuid.uuid7()
            row.agent_name = handle
            rows.append(row)

        async def tracking_exec(stmt):
            return MagicMock(all=MagicMock(return_value=rows))

        mock_db = MagicMock()
        mock_db.exec = tracking_exec
        mock_db.commit = AsyncMock()

        @asynccontextmanager
        async def factory():
            yield mock_db

        lead = TeamLead(
            Agent(name="lead", llm_provider=MockTeamProvider("OK")),
            db_factory=factory,
        )
        members = {
            handle: TeamMember(
                Agent(name=handle, llm_provider=MockTeamProvider("OK")),
                db_factory=factory,
            )
            for handle in handles
        }
        team = AgentTeam(lead=lead, members=members, db_factory=factory)
        for agent in [lead, *members.values()]:
            agent.register(team)
            agent._maybe_activate = lambda: None  # type: ignore[method-assign]

        await team._restore_or_drop_members_for_lead(str(lead_uuid))

        msg = team.mailbox.receive_nowait("executor#1")
        assert msg.from_agent == "system"
        assert "task_1" in msg.content
        assert "Interrupted work" in msg.content
        assert team.mailbox.inbox_empty("executor#2")
        assert team.mailbox.inbox_empty("lead")

        # Session switches re-run the restore path; the same open task must
        # not re-wake the member on every switch (each wake is an LLM call).
        await team._restore_or_drop_members_for_lead(str(lead_uuid))
        assert team.mailbox.inbox_empty("executor#1")
