"""Behavioral contracts for first-party agent prompts."""

from app.agent.builtin_prompts import (
    CODING_CHILD_AGENT_PROTOCOL,
    CODING_PARENT_DELEGATION_PROTOCOL,
)


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


def test_child_protocol_defines_worktree_merge_and_summary_contract():
    assert "isolated git worktree" in CODING_CHILD_AGENT_PROTOCOL
    assert "agent_merge" in CODING_CHILD_AGENT_PROTOCOL
    assert "agent_send" in CODING_CHILD_AGENT_PROTOCOL
    assert "Do not ask user questions" in CODING_CHILD_AGENT_PROTOCOL
    assert "delivered verbatim to your parent" in CODING_CHILD_AGENT_PROTOCOL


def test_parent_delegation_protocol_defines_spawning_and_async_delivery():
    assert "agent_spawn" in CODING_PARENT_DELEGATION_PROTOCOL
    assert "agent_list" in CODING_PARENT_DELEGATION_PROTOCOL
    assert "agent_send" in CODING_PARENT_DELEGATION_PROTOCOL
    assert (
        "delivered to your session asynchronously" in CODING_PARENT_DELEGATION_PROTOCOL
    )
