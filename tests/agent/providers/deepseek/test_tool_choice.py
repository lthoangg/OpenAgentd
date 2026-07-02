"""Tests for tool_choice propagation in DeepSeek's _DeepSeekCompletionsHandler.

DeepSeek overrides build_request completely (no super() call to the base
CompletionsHandler), so it needs its own test coverage.

Critical paths:
- tool_choice="none" injected when tools present
- tool_choice NOT injected without tools
- tool_choice coexists with DeepSeek-specific thinking fields
- tool_choice coexists with legacy max_tokens field (DeepSeek rejects max_completion_tokens)
"""

from __future__ import annotations

from app.agent.providers.deepseek import DeepSeekProvider
from app.agent.schemas.chat import HumanMessage

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


def _make_provider(**kwargs) -> DeepSeekProvider:
    return DeepSeekProvider(api_key="ds-test-key", model="deepseek-v4-flash", **kwargs)


def _build(provider, tools, merged_overrides=None) -> dict:
    merged = provider._merged_kwargs(**(merged_overrides or {}))
    return provider._completions.build_request(
        _MESSAGES, tools, stream=False, merged=merged
    )


# ===========================================================================
# tool_choice injection
# ===========================================================================


class TestDeepSeekToolChoice:
    def test_tool_choice_none_injected_when_tools_present(self):
        """tool_choice='none' appears in body when tools list is non-empty."""
        p = _make_provider()
        body = _build(p, [_TOOL], {"tool_choice": "none"})
        assert body["tool_choice"] == "none"
        assert "tools" in body

    def test_tool_choice_not_injected_without_tools(self):
        """No tools → tool_choice must be absent (API error prevention)."""
        p = _make_provider()
        body = _build(p, None, {"tool_choice": "none"})
        assert "tool_choice" not in body
        assert "tools" not in body

    def test_tool_choice_not_injected_with_empty_tools(self):
        """Empty tools list → tool_choice omitted."""
        p = _make_provider()
        body = _build(p, [], {"tool_choice": "none"})
        assert "tool_choice" not in body

    def test_tool_choice_auto_passes_through(self):
        p = _make_provider()
        body = _build(p, [_TOOL], {"tool_choice": "auto"})
        assert body["tool_choice"] == "auto"

    def test_tool_choice_absent_when_not_in_merged(self):
        p = _make_provider()
        body = _build(p, [_TOOL])
        assert "tool_choice" not in body

    def test_tool_choice_coexists_with_legacy_max_tokens(self):
        """tool_choice must not displace DeepSeek's legacy max_tokens field."""
        p = _make_provider(max_tokens=256)
        body = _build(p, [_TOOL], {"tool_choice": "none"})
        assert body["tool_choice"] == "none"
        assert body["max_tokens"] == 256
        # DeepSeek rejects the new field name
        assert "max_completion_tokens" not in body

    def test_tool_choice_coexists_with_thinking_fields(self):
        """tool_choice and DeepSeek thinking fields must coexist without collision."""
        p = _make_provider(model_kwargs={"thinking_level": "low"})
        body = _build(p, [_TOOL], {"tool_choice": "none"})
        assert body["tool_choice"] == "none"
        assert body.get("thinking") == {"type": "enabled"}
        assert body.get("reasoning_effort") == "low"

    def test_tool_choice_none_does_not_corrupt_tools_list(self):
        """The tools list must remain intact when tool_choice is injected."""
        p = _make_provider()
        body = _build(p, [_TOOL], {"tool_choice": "none"})
        assert len(body["tools"]) == 1
        assert body["tools"][0]["function"]["name"] == "shell"

    def test_handler_override_flag_unaffected(self):
        """Verify DeepSeek still uses legacy max_tokens (not a regression from tool_choice)."""
        p = _make_provider()
        assert p._completions.uses_max_completion_tokens is False
