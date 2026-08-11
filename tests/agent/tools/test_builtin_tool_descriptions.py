"""Contract tests for high-impact LLM-facing builtin tool descriptions."""

from app.agent.tools.builtin.filesystem.read import read_file
from app.agent.tools.builtin.date import get_date
from app.agent.tools.builtin.schedule import schedule_task
from app.agent.tools.builtin.shell import background_process, shell_tool
from app.agent.tools.builtin.todo import todo_manage, todo_manage_member
from app.agent.tools.builtin.web import web_search


def test_read_description_only_claims_supported_document_formats():
    assert "PDF, DOCX" in read_file.description
    assert "PPTX" not in read_file.description
    assert "XLSX" not in read_file.description


def test_read_description_says_html_comes_back_verbatim():
    # HTML is source, not a converted document — the model must know it gets
    # the raw markup so it can edit tags instead of expecting markdown.
    assert "HTML" in read_file.description
    assert "verbatim" in read_file.description


def test_shell_timeout_description_matches_runtime_default():
    from app.agent.tools.builtin.shell import _DEFAULT_TIMEOUT_SECONDS

    timeout = shell_tool.definition["function"]["parameters"]["properties"][
        "timeout_seconds"
    ]["description"]
    assert f"omitted uses {_DEFAULT_TIMEOUT_SECONDS}" in timeout
    # No ceiling: the model must know foreground is the right place for a slow
    # suite, instead of backgrounding it to dodge the timeout.
    assert "no ceiling" in timeout


def test_background_flag_description_steers_away_from_one_shot_commands():
    """25 of 29 observed background launches were one-shot builds, then blocked
    on a capped `bg wait`. The flag must read as "for things that outlive the
    call", not as a generic runner."""
    background = shell_tool.definition["function"]["parameters"]["properties"][
        "background"
    ]["description"]
    assert "outlive" in background
    assert "timeout_seconds" in background


def test_background_pid_description_lists_every_pid_action():
    pid = background_process.definition["function"]["parameters"]["properties"]["pid"]
    assert "status/output/stop" in pid["description"]
    assert "wait" not in pid["description"]


def test_bg_description_no_longer_advertises_wait():
    """`wait` was removed: it duplicated foreground shell while capping at 300s."""
    action = background_process.definition["function"]["parameters"]["properties"][
        "action"
    ]
    assert action["enum"] == ["list", "status", "output", "stop"]
    assert "wait" not in background_process.description
    assert "foreground" in background_process.description


def test_todo_descriptions_explain_assignment_claim_handoff():
    assert "Assigned member tasks remain pending until the member claims them" in (
        todo_manage.description
    )
    # Assignment is delegation: the brief rides on the task itself.
    assert "wakes its assignee automatically" in todo_manage.description
    # Completion carries the deliverable; notifications fan out on their own.
    assert "record the outcome in `result`" in todo_manage_member.description
    assert "notified automatically" in todo_manage_member.description


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
