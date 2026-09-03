"""Behavioral contracts for first-party agent prompts."""


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
    for tool_name in ("patch", "glob", "grep", "shell", "web_fetch", "todo_manage"):
        assert f"`{tool_name}`" not in CODING_OPENAGENTD_PROMPT


def test_coding_prompt_demands_persistence_through_verification():
    """Autonomous end-to-end: implement, verify, report — never stop at analysis."""
    from app.agent.builtin_prompts import CODING_OPENAGENTD_PROMPT

    assert "end-to-end" in CODING_OPENAGENTD_PROMPT
    assert "Do not stop at analysis" in CODING_OPENAGENTD_PROMPT


def test_coding_prompt_teaches_batched_parallel_reads():
    from app.agent.builtin_prompts import CODING_OPENAGENTD_PROMPT

    assert "Batch" in CODING_OPENAGENTD_PROMPT
    assert "parallel" in CODING_OPENAGENTD_PROMPT


def test_coding_prompt_has_a_loop_breaker_and_anti_thrash_rule():
    from app.agent.builtin_prompts import CODING_OPENAGENTD_PROMPT

    assert "without clear progress" in CODING_OPENAGENTD_PROMPT
    assert "Read enough context before editing" in CODING_OPENAGENTD_PROMPT


def test_coding_prompt_forbids_destructive_git_operations():
    from app.agent.builtin_prompts import CODING_OPENAGENTD_PROMPT

    assert "git reset --hard" in CODING_OPENAGENTD_PROMPT
    assert "amend" in CODING_OPENAGENTD_PROMPT


def test_coding_prompt_stays_within_the_token_budget():
    """Peers spend 10k+ tokens; we buy the behaviours that matter for ~500."""
    from app.agent.builtin_prompts import CODING_OPENAGENTD_PROMPT

    # ~4 chars/token: a hard ceiling so the prompt cannot silently balloon.
    assert len(CODING_OPENAGENTD_PROMPT) < 3200


def test_question_tool_is_not_a_constructor_tool_for_the_coding_lead():
    """It is injected at runtime; listing it here would bypass the lead gate."""
    from app.agent.builtin_prompts import CODING_OPENAGENTD_TOOLS

    assert "ask_user" not in CODING_OPENAGENTD_TOOLS
