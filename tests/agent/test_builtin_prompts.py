"""Behavioral contracts for first-party agent prompts."""

from app.agent.builtin_prompts import (
    BUILTIN_MEMBER_PROFILES,
    NORMAL_OPENAGENTD_PROMPT,
)


def test_normal_lead_prompt_requires_result_verification_and_user_work_safety():
    assert "Never claim an action succeeded until its tool result confirms it" in (
        NORMAL_OPENAGENTD_PROMPT
    )
    assert "Preserve the user's existing work" in NORMAL_OPENAGENTD_PROMPT


def test_coder_prompt_defines_a_complete_implementation_handoff():
    prompt = BUILTIN_MEMBER_PROFILES["coding"]["coder"]["prompt"]

    assert "Read the relevant code and tests before editing" in prompt
    assert "Do not revert unrelated work" in prompt
    assert "Report changed files, checks and results" in prompt


def test_executor_prompt_requires_artifact_verification():
    prompt = BUILTIN_MEMBER_PROFILES["normal"]["executor"]["prompt"]

    assert "Verify the artifact exists" in prompt
    assert "Do not report success from an error" in prompt
