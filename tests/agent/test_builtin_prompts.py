"""Behavioral contracts for first-party agent prompts."""

from app.agent.builtin_prompts import BUILTIN_MEMBER_PROFILES


def test_coder_prompt_defines_a_complete_implementation_handoff():
    prompt = BUILTIN_MEMBER_PROFILES["coding"]["coder"]["prompt"]

    assert "Read the relevant code and tests before editing" in prompt
    assert "Do not revert unrelated work" in prompt
    assert "Report changed files, checks and results" in prompt


def test_coding_lead_prompt_constrains_when_to_interrupt_the_user():
    """One batched interruption, after exploring — not a stream of questions."""
    from app.agent.builtin_prompts import CODING_OPENAGENTD_PROMPT

    assert "Explore before asking" in CODING_OPENAGENTD_PROMPT
    assert "ask once" in CODING_OPENAGENTD_PROMPT
    assert "recommend an option" in CODING_OPENAGENTD_PROMPT
    assert "Never interrupt for approval" in CODING_OPENAGENTD_PROMPT


def test_prompts_stay_tool_agnostic():
    """Runtime capabilities change; prompt bodies must not name specific tools.

    ``ask_user`` in particular is injected per-run, so a prompt that
    names it would be wrong for every session that does not receive it.
    """
    from app.agent.builtin_prompts import CODING_OPENAGENTD_PROMPT

    assert "ask_user" not in CODING_OPENAGENTD_PROMPT


def test_question_tool_is_not_a_constructor_tool_for_the_coding_lead():
    """It is injected at runtime; listing it here would bypass the lead gate."""
    from app.agent.builtin_prompts import CODING_OPENAGENTD_TOOLS

    assert "ask_user" not in CODING_OPENAGENTD_TOOLS
