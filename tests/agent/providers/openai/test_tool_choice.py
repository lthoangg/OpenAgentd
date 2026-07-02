"""Tests for tool_choice propagation in OpenAI CompletionsHandler and ResponsesHandler.

Critical paths:
- tool_choice injected into body when tools present
- tool_choice NOT injected when tools list is absent/empty (API would reject it)
- tool_choice="none" passes through verbatim (no translation needed for OpenAI)
- Other tool_choice values ("auto", "required") also pass through
- Responses API maps max_tokens → max_output_tokens independently (no regression)
"""

from __future__ import annotations

from app.agent.providers.openai.completions import CompletionsHandler
from app.agent.providers.openai.responses import ResponsesHandler
from app.agent.schemas.chat import HumanMessage

# ---------------------------------------------------------------------------
# Shared fixtures / helpers
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


def _completions(model: str = "gpt-4o") -> CompletionsHandler:
    return CompletionsHandler(
        model=model,
        base_url="https://api.openai.com/v1",
        headers={"Authorization": "Bearer sk-test"},
    )


def _responses(model: str = "gpt-5.4") -> ResponsesHandler:
    return ResponsesHandler(
        model=model,
        base_url="https://api.openai.com/v1",
        headers={"Authorization": "Bearer sk-test"},
    )


# ===========================================================================
# CompletionsHandler — build_request
# ===========================================================================


class TestCompletionsHandlerToolChoice:
    def test_tool_choice_none_injected_when_tools_present(self):
        """tool_choice='none' appears in body when tools list is non-empty."""
        h = _completions()
        body = h.build_request(
            _MESSAGES, [_TOOL], stream=False, merged={"tool_choice": "none"}
        )
        assert body["tool_choice"] == "none"
        assert "tools" in body  # guard: tools are actually in the request

    def test_tool_choice_not_injected_when_no_tools(self):
        """tool_choice must NOT appear in body when there are no tools.

        Sending tool_choice without a tools list is an API error on OpenAI.
        """
        h = _completions()
        body = h.build_request(
            _MESSAGES, None, stream=False, merged={"tool_choice": "none"}
        )
        assert "tool_choice" not in body
        assert "tools" not in body

    def test_tool_choice_not_injected_when_empty_tools(self):
        """Empty tools list → tool_choice omitted (same API error risk)."""
        h = _completions()
        body = h.build_request(
            _MESSAGES, [], stream=False, merged={"tool_choice": "none"}
        )
        assert "tool_choice" not in body

    def test_tool_choice_auto_passes_through(self):
        """tool_choice='auto' is forwarded verbatim."""
        h = _completions()
        body = h.build_request(
            _MESSAGES, [_TOOL], stream=False, merged={"tool_choice": "auto"}
        )
        assert body["tool_choice"] == "auto"

    def test_tool_choice_required_passes_through(self):
        """tool_choice='required' is forwarded verbatim."""
        h = _completions()
        body = h.build_request(
            _MESSAGES, [_TOOL], stream=False, merged={"tool_choice": "required"}
        )
        assert body["tool_choice"] == "required"

    def test_tool_choice_absent_from_merged_leaves_no_key(self):
        """When caller passes no tool_choice, the key is absent from body."""
        h = _completions()
        body = h.build_request(_MESSAGES, [_TOOL], stream=False, merged={})
        assert "tool_choice" not in body

    def test_tool_choice_none_in_merged_none_value_not_injected(self):
        """merged={'tool_choice': None} must not inject the key (None means not set)."""
        h = _completions()
        body = h.build_request(
            _MESSAGES, [_TOOL], stream=False, merged={"tool_choice": None}
        )
        assert "tool_choice" not in body

    def test_tool_choice_does_not_affect_other_body_fields(self):
        """Injecting tool_choice must not discard temperature or max_tokens."""
        h = _completions()
        body = h.build_request(
            _MESSAGES,
            [_TOOL],
            stream=False,
            merged={"tool_choice": "none", "temperature": 0.5, "max_tokens": 256},
        )
        assert body["tool_choice"] == "none"
        assert body.get("temperature") == 0.5
        # max_completion_tokens because CompletionsHandler.uses_max_completion_tokens=True
        assert body.get("max_completion_tokens") == 256

    def test_tool_choice_none_injected_in_streaming_request(self):
        """tool_choice injected for streaming requests too."""
        h = _completions()
        body = h.build_request(
            _MESSAGES, [_TOOL], stream=True, merged={"tool_choice": "none"}
        )
        assert body["tool_choice"] == "none"
        assert body["stream"] is True


# ===========================================================================
# ResponsesHandler — build_request
# ===========================================================================


class TestResponsesHandlerToolChoice:
    def test_tool_choice_none_injected_when_tools_present(self):
        """tool_choice='none' appears in body when tools list is non-empty."""
        h = _responses()
        body = h.build_request(
            _MESSAGES, [_TOOL], stream=False, merged={"tool_choice": "none"}
        )
        assert body["tool_choice"] == "none"
        assert "tools" in body

    def test_tool_choice_not_injected_when_no_tools(self):
        """No tools → no tool_choice (API error prevention)."""
        h = _responses()
        body = h.build_request(
            _MESSAGES, None, stream=False, merged={"tool_choice": "none"}
        )
        assert "tool_choice" not in body
        assert "tools" not in body

    def test_tool_choice_not_injected_when_empty_tools(self):
        """Empty tools list → tool_choice omitted."""
        h = _responses()
        body = h.build_request(
            _MESSAGES, [], stream=False, merged={"tool_choice": "none"}
        )
        assert "tool_choice" not in body

    def test_tool_choice_auto_passes_through(self):
        h = _responses()
        body = h.build_request(
            _MESSAGES, [_TOOL], stream=False, merged={"tool_choice": "auto"}
        )
        assert body["tool_choice"] == "auto"

    def test_tool_choice_required_passes_through(self):
        h = _responses()
        body = h.build_request(
            _MESSAGES, [_TOOL], stream=False, merged={"tool_choice": "required"}
        )
        assert body["tool_choice"] == "required"

    def test_tool_choice_absent_leaves_no_key(self):
        h = _responses()
        body = h.build_request(_MESSAGES, [_TOOL], stream=False, merged={})
        assert "tool_choice" not in body

    def test_tool_choice_does_not_affect_max_output_tokens(self):
        """tool_choice injection must not disrupt max_tokens→max_output_tokens mapping."""
        h = _responses()
        body = h.build_request(
            _MESSAGES,
            [_TOOL],
            stream=False,
            merged={"tool_choice": "none", "max_tokens": 1024},
        )
        assert body["tool_choice"] == "none"
        assert body["max_output_tokens"] == 1024

    def test_tool_choice_none_injected_in_streaming_request(self):
        """tool_choice injected for streaming Responses API requests too."""
        h = _responses()
        body = h.build_request(
            _MESSAGES, [_TOOL], stream=True, merged={"tool_choice": "none"}
        )
        assert body["tool_choice"] == "none"
        assert body["stream"] is True

    def test_tool_choice_inside_tools_block_not_at_top_level_without_tools(self):
        """Regression: tool_choice must be a sibling of 'tools', not nested inside it."""
        h = _responses()
        body = h.build_request(
            _MESSAGES, [_TOOL], stream=False, merged={"tool_choice": "none"}
        )
        # tool_choice is a top-level key, not nested under tools
        assert isinstance(body["tool_choice"], str)
        assert isinstance(body["tools"], list)
