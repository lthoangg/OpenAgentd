"""Tests for the offline prompt/token budget inspector."""

from types import SimpleNamespace

import tiktoken

from manual.inspect_prompt import (
    _budget_entry,
    _builtin_prompt_budgets,
    _builtin_skill_budgets,
    _inject_team_protocol,
    _inject_team_tools,
    _restrict_skill_catalog_to_builtins,
    _serialize_tools,
)


def test_budget_entry_uses_selected_tokenizer():
    encoding = tiktoken.get_encoding("o200k_base")

    entry = _budget_entry("hello world", encoding)

    assert entry == {"chars": 11, "bytes": 11, "tokens": 2}


def test_serialize_tools_uses_compact_provider_style_json():
    encoding = tiktoken.get_encoding("o200k_base")
    definitions = [
        {
            "type": "function",
            "function": {
                "name": "read",
                "description": "Read a file.",
                "parameters": {"type": "object", "properties": {}},
            },
        }
    ]

    serialized, total, items = _serialize_tools(definitions, encoding)

    assert "\n" not in serialized
    assert '"name":"read"' in serialized
    assert total["tokens"] == len(encoding.encode(serialized))
    assert items[0]["name"] == "read"
    assert items[0]["tokens"] > 0


def test_team_protocol_is_part_of_inspected_system_prompt():
    lead = SimpleNamespace(role="lead", name="openagentd")
    member = SimpleNamespace(role="member", name="explorer")

    lead_prompt = _inject_team_protocol("BASE", lead)
    member_prompt = _inject_team_protocol("BASE", member)

    assert lead_prompt.startswith("BASE\n\n---\n\n")
    assert "## Lead workflow" in lead_prompt
    assert "You are `explorer#1`" in member_prompt
    assert "## Member workflow" in member_prompt


def test_coding_prompt_inspection_does_not_include_lsp_runtime_tool():
    """lsp injection is temporarily detached — mirrored in _inject_team_tools."""
    lead = SimpleNamespace(role="lead", name="openagentd")

    normal = _inject_team_tools([], lead, mode="normal")
    coding = _inject_team_tools([], lead, mode="coding")

    assert "lsp" not in {tool["function"]["name"] for tool in normal}
    assert "lsp" not in {tool["function"]["name"] for tool in coding}


def test_builtin_skill_budgets_count_stable_skill_bodies():
    encoding = tiktoken.get_encoding("o200k_base")

    skills = _builtin_skill_budgets(encoding)

    assert {item["name"] for item in skills} >= {"self-healing", "skill-installer"}
    assert all(item["tokens"] > 0 for item in skills)
    assert all(item["chars"] > 0 for item in skills)
    assert all(item["path"].endswith("SKILL.md") for item in skills)


def test_builtin_prompt_budgets_include_every_first_party_profile():
    encoding = tiktoken.get_encoding("o200k_base")

    prompts = _builtin_prompt_budgets(encoding)

    assert {item["name"] for item in prompts} == {
        "coding/openagentd",
        "coding/coder",
        "coding/explorer",
    }
    assert all(item["tokens"] > 0 for item in prompts)


def test_builtin_skill_scope_rewrites_dynamic_skill_tool_catalog():
    definitions = [
        {
            "type": "function",
            "function": {
                "name": "skill",
                "description": "machine-local catalog",
                "parameters": {"type": "object", "properties": {}},
            },
        }
    ]

    rewritten = _restrict_skill_catalog_to_builtins(definitions)
    description = rewritten[0]["function"]["description"]

    assert "self-healing" in description
    assert "skill-installer" in description
    assert "machine-local catalog" not in description
