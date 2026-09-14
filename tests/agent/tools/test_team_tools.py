from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.agent.tools.builtin.team import (
    DelegateArgs,
    TeamListArgs,
    TeamManageArgs,
    TeamSendArgs,
    TeamSpawnArgs,
    TeamStopArgs,
    TeamWaitArgs,
    make_delegate_tool,
    make_team_manage_tool,
)
from app.agent.tools.builtin.member import (
    AskLeadArgs,
    SendToLeadArgs,
)
from app.services.subagent_service import (
    AmbiguousMemberError,
    MemberNotFoundError,
    allocate_instance_handle,
    parse_instance_handle,
    resolve_instance,
    _live_instances,
    _instance_counters,
    SubagentInstance,
)


def test_instance_handle_parsing() -> None:
    assert parse_instance_handle("explorer#1") == ("explorer", 1)
    assert parse_instance_handle("researcher#42") == ("researcher", 42)
    assert parse_instance_handle("explorer") is None
    assert parse_instance_handle("invalid#abc") is None


def test_allocate_instance_handle() -> None:
    lead_id = "test-lead-1"
    _instance_counters.clear()

    h1 = allocate_instance_handle(lead_id, "explorer")
    h2 = allocate_instance_handle(lead_id, "explorer")
    h3 = allocate_instance_handle(lead_id, "researcher")

    assert h1 == "explorer#1"
    assert h2 == "explorer#2"
    assert h3 == "researcher#1"

    # Explicit name allocation
    h4 = allocate_instance_handle(lead_id, "explorer", explicit_name="custom-exp")
    assert h4 == "custom-exp"


def test_resolve_instance_exact_and_bare() -> None:
    lead_id = "test-lead-resolve"
    _live_instances[lead_id] = {}

    class MockSession:
        pass

    inst1 = SubagentInstance(
        handle="explorer#1",
        profile_name="explorer",
        lead_session_id=lead_id,
        session_id="child-1",
        session=MockSession(),  # type: ignore[arg-type]
    )
    _live_instances[lead_id]["explorer#1"] = inst1

    # 1. Exact resolution
    resolved = resolve_instance(lead_id, "explorer#1")
    assert resolved.handle == "explorer#1"

    # 2. Bare resolution when unique
    resolved_bare = resolve_instance(lead_id, "explorer")
    assert resolved_bare.handle == "explorer#1"

    # 3. Add second instance of explorer -> bare resolution becomes ambiguous
    inst2 = SubagentInstance(
        handle="explorer#2",
        profile_name="explorer",
        lead_session_id=lead_id,
        session_id="child-2",
        session=MockSession(),  # type: ignore[arg-type]
    )
    _live_instances[lead_id]["explorer#2"] = inst2

    with pytest.raises(AmbiguousMemberError) as exc:
        resolve_instance(lead_id, "explorer")
    assert "Multiple live instances" in str(exc.value)

    # Exact resolution still succeeds
    assert resolve_instance(lead_id, "explorer#2").handle == "explorer#2"

    # Missing member raises MemberNotFoundError
    with pytest.raises(MemberNotFoundError):
        resolve_instance(lead_id, "nonexistent#1")


def test_team_tool_args_validation() -> None:
    # TeamSpawnArgs
    spawn_args = TeamSpawnArgs(profile="explorer", task="Find auth routes")
    assert spawn_args.profile == "explorer"
    assert spawn_args.wait is True

    with pytest.raises(ValidationError):
        TeamSpawnArgs(profile="", task="Find auth routes")

    # TeamSendArgs
    send_args = TeamSendArgs(member_id="explorer#1", message="Proceed with v2")
    assert send_args.member_id == "explorer#1"
    assert send_args.message == "Proceed with v2"

    with pytest.raises(ValidationError):
        TeamSendArgs(member_id="explorer#1", message="   ")

    # TeamWaitArgs
    wait_args = TeamWaitArgs(member_ids=["explorer#1", "explorer#2"], timeout=60)
    assert wait_args.member_ids == ["explorer#1", "explorer#2"]
    assert wait_args.timeout == 60

    # TeamStopArgs
    stop_args = TeamStopArgs(member_id="explorer#1")
    assert stop_args.member_id == "explorer#1"

    # TeamListArgs
    assert TeamListArgs() is not None


def test_member_tool_args_validation() -> None:
    # SendToLeadArgs
    send_args = SendToLeadArgs(message="Found 5 routes", end_turn=True)
    assert send_args.message == "Found 5 routes"
    assert send_args.end_turn is True

    with pytest.raises(ValidationError):
        SendToLeadArgs(message="")

    # AskLeadArgs
    ask_args = AskLeadArgs(question="Which database?", options=["sqlite", "postgres"])
    assert ask_args.question == "Which database?"
    assert ask_args.options == ["sqlite", "postgres"]

    with pytest.raises(ValidationError):
        AskLeadArgs(question="")


@pytest.mark.asyncio
async def test_team_manage_tool() -> None:
    lead_id = "test-lead-manage"
    _live_instances[lead_id] = {}

    class DummySession:
        async def handle_stop(self) -> None:
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

    tool = make_team_manage_tool(lead_id, db_factory=None)  # type: ignore[arg-type]

    # 1. Action: list
    list_res = await tool.arun(action="list")
    assert "explorer#1" in list_res

    # 2. Action: stop
    stop_res = await tool.arun(action="stop", member_id="explorer#1")
    assert "stopped" in stop_res
    assert _live_instances[lead_id]["explorer#1"].last_error == "Stopped by lead"

    # 3. Action: invalid action validation
    with pytest.raises(ValidationError):
        TeamManageArgs(action="invalid_action")  # type: ignore[arg-type]


def test_delegate_args_validation() -> None:
    args = DelegateArgs(profile="explorer", task="Audit routes")
    assert args.profile == "explorer"
    assert args.task == "Audit routes"
    assert args.target is None

    # Alias support
    alias_args = DelegateArgs.model_validate(
        {"agent": "researcher", "message": "Search docs", "to": "researcher#1"}
    )
    assert alias_args.profile == "researcher"
    assert alias_args.task == "Search docs"
    assert alias_args.target == "researcher#1"

    with pytest.raises(ValidationError):
        DelegateArgs(profile="", task="valid")

    with pytest.raises(ValidationError):
        DelegateArgs(profile="valid", task="")


@pytest.mark.asyncio
async def test_delegate_tool_reply_to_target() -> None:
    lead_id = "test-lead-delegate"
    _live_instances[lead_id] = {}

    class MockReplySession:
        def __init__(self) -> None:
            self.state = "idle"
            self._active_task = None

        async def handle_user_message(self, *args, **kwargs) -> None:
            pass

        async def resume_after_question_answer(self, *args, **kwargs) -> None:
            pass

    inst = SubagentInstance(
        handle="explorer#1",
        profile_name="explorer",
        lead_session_id=lead_id,
        session_id="child-delegate-1",
        session=MockReplySession(),  # type: ignore[arg-type]
        status="waiting_lead",
        pending_lead_question={"question": "Which auth?"},
        last_result="Audited JWT auth",
    )
    _live_instances[lead_id]["explorer#1"] = inst

    tool = make_delegate_tool(lead_id, db_factory=None)  # type: ignore[arg-type]
    res = await tool.arun(profile="explorer", target="explorer#1", task="Use JWT")
    assert "Message delivered to subagent 'explorer#1'" in res
    assert "running in the background" in res


def test_delegate_tool_dynamic_profile_descriptions(tmp_path, monkeypatch) -> None:
    custom_agent_md = tmp_path / "custom.md"
    custom_agent_md.write_text(
        "---\n"
        "name: custom\n"
        "role: member\n"
        "description: Custom domain analysis agent.\n"
        "tools: [read]\n"
        "---\n"
        "Custom agent prompt.\n",
        encoding="utf-8",
    )

    monkeypatch.setattr(
        "app.services.subagent_service._resolve_agents_dir", lambda: tmp_path
    )

    tool = make_delegate_tool("lead-test-dyn", db_factory=None)  # type: ignore[arg-type]
    desc = tool.description
    assert "- profile='custom': Custom domain analysis agent." in desc
    assert "- profile='explorer':" in desc
    assert "- profile='researcher':" in desc

    def_desc = tool.definition["function"]["description"]
    assert "- profile='custom': Custom domain analysis agent." in def_desc
