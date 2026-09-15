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

    # Hard ceiling so the prompt stays within 10k characters.
    assert len(CODING_OPENAGENTD_PROMPT) <= 10000


def test_question_tool_is_not_a_constructor_tool_for_the_coding_lead():
    """It is injected at runtime; listing it here would bypass the lead gate."""
    from app.agent.builtin_prompts import CODING_OPENAGENTD_TOOLS

    assert "ask_user" not in CODING_OPENAGENTD_TOOLS


def test_member_prompts_match_pruned_toolset_and_topology():
    """Member prompts instruct delivering findings in response text, using ask_lead,
    and strictly forbid direct user communication, file mutations, or pruned tools."""
    from app.agent.builtin_prompts import (
        EXPLORER_MEMBER_PROMPT,
        EXPLORER_MEMBER_TOOLS,
        RESEARCHER_MEMBER_PROMPT,
        RESEARCHER_MEMBER_TOOLS,
    )

    assert set(EXPLORER_MEMBER_TOOLS) == {"glob", "grep", "read"}
    assert set(RESEARCHER_MEMBER_TOOLS) == {
        "glob",
        "grep",
        "read",
        "web_fetch",
        "web_search",
    }

    for prompt in (EXPLORER_MEMBER_PROMPT, RESEARCHER_MEMBER_PROMPT):
        # Enforces direct response text for deliverables (no send_to_lead)
        assert "response text" in prompt
        assert "ask_lead" in prompt
        assert "send_to_lead" not in prompt

        # Enforces hub-and-spoke topology and read-only invariants
        assert "strictly with the lead" in prompt
        assert "never prompt the human user" in prompt
        assert "do not modify any files" in prompt

        # Strictly excludes user/lead tools
        assert "ask_user" not in prompt
        assert "delegate" not in prompt
        assert "team_spawn" not in prompt
        assert "team_send" not in prompt


def test_coding_lead_prompt_does_not_contain_subagent_delegation():
    """Lead prompt stays tool-agnostic; subagent delegation is defined in delegate tool."""
    from app.agent.builtin_prompts import CODING_OPENAGENTD_PROMPT

    assert "## Subagent delegation" not in CODING_OPENAGENTD_PROMPT
    assert "explorer" not in CODING_OPENAGENTD_PROMPT
    assert "researcher" not in CODING_OPENAGENTD_PROMPT
