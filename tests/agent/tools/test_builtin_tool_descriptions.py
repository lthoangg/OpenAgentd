"""Contract tests for high-impact LLM-facing builtin tool descriptions."""

from app.agent.tools.builtin.filesystem.read import read_file
from app.agent.tools.builtin.date import get_date
from app.agent.tools.builtin.schedule import schedule_task
from app.agent.tools.builtin.shell import background_process, shell_tool
from app.agent.tools.builtin.todo import todo_manage, todo_manage_member
from app.agent.tools.builtin.web import web_search


def test_read_description_only_claims_supported_document_formats():
    assert "PDF, DOCX, HTML" in read_file.description
    assert "PPTX" not in read_file.description
    assert "XLSX" not in read_file.description


def test_shell_timeout_description_matches_runtime_default():
    timeout = shell_tool.definition["function"]["parameters"]["properties"][
        "timeout_seconds"
    ]["description"]
    assert "omitted uses 60" in timeout


def test_background_pid_description_lists_every_pid_action():
    pid = background_process.definition["function"]["parameters"]["properties"]["pid"]
    assert "status/output/stop/wait" in pid["description"]


def test_todo_descriptions_explain_assignment_claim_handoff():
    assert "Assigned member tasks remain pending until the member claims them" in (
        todo_manage.description
    )
    assert "completed before sending the final result" in (
        todo_manage_member.description
    )


def test_simple_tools_do_not_repeat_examples_or_unstable_result_shapes():
    assert get_date.description == "Get the current local date, time, and timezone."
    assert web_search.description == "Search the web."


def test_shell_description_keeps_only_non_obvious_execution_constraints():
    assert "stdin is /dev/null" in shell_tool.description
    assert "non-interactive flags" in shell_tool.description
    assert "&&, ||, pipes" in shell_tool.description
    assert "Relative workdir paths" in shell_tool.description
    assert "Prefer file tools" in shell_tool.description
    assert "npm init" not in shell_tool.description


def test_schedule_description_keeps_self_routing_and_compact_loop_recipe():
    assert "Every task fires back to you" in schedule_task.description
    assert "session_id='current'" in schedule_task.description
    assert "every_seconds=30" in schedule_task.description
    assert "trigger" in schedule_task.description
    assert "delete" in schedule_task.description
    assert "Remind me in 30 minutes" not in schedule_task.description
