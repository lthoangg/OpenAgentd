"""Tests for tool_choice propagation in AnthropicProvider._payload.

Anthropic represents tool_choice as an object: {"type": "none"} / {"type": "auto"}.
The canonical string "none" must be translated; other dict values pass through.

Critical paths:
- "none" string → {"type": "none"} object
- dict value passes through verbatim (caller already built the Anthropic shape)
- tool_choice NOT injected when no tools (API rejects it)
- tool_choice NOT injected when tools list is empty
- Unrelated payload fields (max_tokens, system, thinking) unaffected
"""

from __future__ import annotations

from app.agent.providers.anthropic import AnthropicProvider
from app.agent.schemas.chat import HumanMessage, SystemMessage

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_TOOL = {
    "type": "function",
    "function": {
        "name": "shell",
        "description": "Run shell",
        "parameters": {"type": "object", "properties": {}},
    },
}

_MESSAGES = [HumanMessage(content="hi")]


def _provider(**kwargs) -> AnthropicProvider:
    return AnthropicProvider(api_key="sk-ant-test", model="claude-sonnet-4-6", **kwargs)


def _payload(provider, tools, **merged_overrides):
    merged = provider._merged_kwargs(**merged_overrides)
    return provider._payload(_MESSAGES, tools, merged)


# ===========================================================================
# tool_choice="none" → {"type": "none"}
# ===========================================================================


class TestAnthropicToolChoiceNone:
    def test_none_string_translated_to_object_when_tools_present(self):
        """'none' string → {'type': 'none'} in payload when tools list is non-empty."""
        p = _provider()
        body = _payload(p, [_TOOL], tool_choice="none")
        assert body["tool_choice"] == {"type": "none"}

    def test_none_string_not_injected_without_tools(self):
        """tool_choice must NOT appear when there are no tools (API rejects it)."""
        p = _provider()
        body = _payload(p, None, tool_choice="none")
        assert "tool_choice" not in body
        assert "tools" not in body

    def test_none_string_not_injected_with_empty_tools(self):
        """Empty tools list → tool_choice omitted."""
        p = _provider()
        body = _payload(p, [], tool_choice="none")
        assert "tool_choice" not in body

    def test_none_does_not_corrupt_tools_list(self):
        """The tools list must still be present and correct after injecting tool_choice."""
        p = _provider()
        body = _payload(p, [_TOOL], tool_choice="none")
        assert "tools" in body
        assert body["tools"][0]["name"] == "shell"

    def test_none_does_not_affect_max_tokens(self):
        """Injecting tool_choice must not corrupt max_tokens resolution."""
        p = _provider(max_tokens=512)
        body = _payload(p, [_TOOL], tool_choice="none")
        assert body["tool_choice"] == {"type": "none"}
        assert body["max_tokens"] == 512

    def test_none_does_not_affect_system_prompt(self):
        """System prompt extraction is independent of tool_choice."""
        p = _provider()
        merged = p._merged_kwargs(tool_choice="none")
        body = p._payload(
            [SystemMessage(content="be concise"), HumanMessage(content="hi")],
            [_TOOL],
            merged,
        )
        assert body["tool_choice"] == {"type": "none"}
        # system prompt comes through as cache-control block
        assert body["system"][0]["text"] == "be concise"


# ===========================================================================
# Dict value passes through verbatim
# ===========================================================================


class TestAnthropicToolChoicePassthrough:
    def test_auto_dict_passes_through(self):
        """{'type': 'auto'} dict is forwarded verbatim."""
        p = _provider()
        body = _payload(p, [_TOOL], tool_choice={"type": "auto"})
        assert body["tool_choice"] == {"type": "auto"}

    def test_any_dict_passes_through(self):
        """{'type': 'any'} dict is forwarded verbatim."""
        p = _provider()
        body = _payload(p, [_TOOL], tool_choice={"type": "any"})
        assert body["tool_choice"] == {"type": "any"}

    def test_specific_tool_dict_passes_through(self):
        """Specific tool dict is forwarded verbatim."""
        p = _provider()
        spec = {"type": "tool", "name": "shell"}
        body = _payload(p, [_TOOL], tool_choice=spec)
        assert body["tool_choice"] == spec


# ===========================================================================
# Absent tool_choice
# ===========================================================================


class TestAnthropicToolChoiceAbsent:
    def test_no_tool_choice_in_merged_omits_key(self):
        """When tool_choice is not in merged kwargs, key is absent from payload."""
        p = _provider()
        body = _payload(p, [_TOOL])
        assert "tool_choice" not in body

    def test_none_value_in_merged_omits_key(self):
        """tool_choice=None (Python None, not string 'none') must not inject the key."""
        p = _provider()
        body = _payload(p, [_TOOL], tool_choice=None)
        assert "tool_choice" not in body

    def test_tool_choice_absent_without_tools(self):
        """No tool_choice and no tools → neither key in payload."""
        p = _provider()
        body = _payload(p, None)
        assert "tool_choice" not in body
        assert "tools" not in body
