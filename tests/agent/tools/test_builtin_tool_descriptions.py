"""Contract tests for high-impact LLM-facing builtin tool descriptions."""

from app.agent.tools.builtin.filesystem.read import read_file
from app.agent.tools.builtin.date import get_date
from app.agent.tools.builtin.lsp import lsp_navigation
from app.agent.tools.builtin.schedule import schedule_task
from app.agent.tools.builtin.shell import background_process, shell_tool
from app.agent.tools.builtin.skill import load_skill
from app.agent.tools.builtin.todo import todo_manage, todo_manage_member
from app.agent.tools.builtin.web import web_search
from app.agent.tools.multimodalities.image import generate_image
from app.agent.tools.multimodalities.video import generate_video


def test_read_description_only_claims_supported_document_formats():
    assert "PDF/DOCX" in read_file.description
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
    assert f"default {_DEFAULT_TIMEOUT_SECONDS}" in timeout
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
    assert "long-lived" in background
    assert "foreground" in background


def test_background_pid_description_lists_every_pid_action():
    pid = background_process.definition["function"]["parameters"]["properties"]["pid"]
    assert "status, output, or stop" in pid["description"]
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
    lead_description = " ".join(todo_manage.description.split())
    member_description = " ".join(todo_manage_member.description.split())
    assert "Assigned tasks stay pending until claimed" in lead_description
    # Assignment is delegation: the brief rides on the task itself.
    assert "wakes its assignee automatically" in lead_description
    # Completion carries the deliverable; notifications fan out on their own.
    assert "record the outcome in `result`" in member_description
    assert "notified automatically" in member_description


def test_high_cost_coordination_descriptions_stay_compact():
    assert len(todo_manage.description) < 1_200
    assert len(todo_manage_member.description) < 600
    assert len(schedule_task.description) < 400


def test_skill_description_keeps_load_once_lifecycle_without_repeating_schema():
    assert "Call this at most once per skill." in load_skill.description
    assert "visible conversation" in load_skill.description
    assert "reuse those instructions instead of calling this tool again" in (
        load_skill.description
    )
    assert "repeated loads return the same content" in load_skill.description
    skill_name = load_skill.definition["function"]["parameters"]["properties"][
        "skill_name"
    ]["description"]
    assert skill_name == "Skill name from the available-skills list."


def test_multimodal_descriptions_keep_output_and_cross_field_constraints():
    assert "include it verbatim" in generate_image.description
    assert "Error: ..." in generate_image.description
    image_inputs = generate_image.definition["function"]["parameters"]["properties"][
        "images"
    ]["description"]
    assert "1–16" in image_inputs

    assert "include it verbatim" in generate_video.description
    video_properties = generate_video.definition["function"]["parameters"]["properties"]
    assert "up to 3" in video_properties["reference_images"]["description"]
    assert "Mutually exclusive" in video_properties["extend_video"]["description"]


def test_simple_tools_do_not_repeat_examples_or_unstable_result_shapes():
    assert get_date.description == "Get the current local date, time, and timezone."
    assert web_search.description == "Search the web."


def test_shell_description_keeps_only_non_obvious_execution_constraints():
    assert "stdin is /dev/null" in shell_tool.description
    assert "non-interactive flags" in shell_tool.description
    assert "&&, ||, pipes" in shell_tool.description
    assert "long-lived processes" in shell_tool.description
    assert "Prefer file tools" in shell_tool.description
    assert "npm init" not in shell_tool.description


def test_schedule_description_keeps_self_routing_and_compact_loop_recipe():
    assert "Schedule your own" in schedule_task.description
    assert "another team" not in schedule_task.description
    assert "cross-team" not in schedule_task.description
    assert "session_id='current'" in schedule_task.description
    assert "every_seconds=30" in schedule_task.description
    assert "trigger" in schedule_task.description
    assert "delete" in schedule_task.description
    assert "Remind me in 30 minutes" not in schedule_task.description


def test_lsp_description_distinguishes_semantic_and_text_search():
    assert "Coding mode only" not in lsp_navigation.description
    assert "definition" in lsp_navigation.description
    assert "reference" in lsp_navigation.description
    assert "symbol" in lsp_navigation.description
    assert "grep for text search" in lsp_navigation.description
    assert "glob for filename patterns" in lsp_navigation.description
    assert "workspace-relative locations" in lsp_navigation.description
    assert "up to 50" in lsp_navigation.description


def test_tool_schemas_do_not_repeat_pydantic_titles():
    def has_title(node: object) -> bool:
        if isinstance(node, dict):
            return "title" in node or any(has_title(value) for value in node.values())
        if isinstance(node, list):
            return any(has_title(value) for value in node)
        return False

    for tool in (todo_manage, schedule_task):
        assert not has_title(tool.definition["function"]["parameters"])
