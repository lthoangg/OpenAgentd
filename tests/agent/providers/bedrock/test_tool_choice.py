"""Tests for tool_choice handling in BedrockProvider._build_request.

Bedrock's Converse API has no "none" ToolChoice option (only auto/any/tool).
The correct behaviour is to strip tool_choice from merged kwargs silently so
it never reaches additionalModelRequestFields — which would cause a
ValidationException from the Bedrock service.

Critical paths:
- tool_choice="none" is in the known-strip set → absent from request
- tool_choice never appears in additionalModelRequestFields
- tool_choice="none" does not affect toolConfig or inferenceConfig
- Other unknown merged keys still flow to additionalModelRequestFields
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from app.agent.providers.bedrock.bedrock import BedrockProvider
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


def _make_provider(**kwargs) -> BedrockProvider:
    with patch(
        "app.agent.providers.bedrock.bedrock._make_client", return_value=MagicMock()
    ):
        return BedrockProvider(model="anthropic.claude-sonnet-4-6", **kwargs)


def _build_request(provider, messages=None, tools=None, **merged_overrides) -> dict:
    merged = provider._merged_kwargs(**merged_overrides)
    return provider._build_request(messages or _MESSAGES, tools, merged)


# ===========================================================================
# tool_choice stripped from known keys
# ===========================================================================


class TestBedrockToolChoiceStripped:
    def test_tool_choice_none_absent_from_request(self):
        """tool_choice='none' must not appear anywhere in the Bedrock request."""
        p = _make_provider()
        req = _build_request(p, tool_choice="none")
        assert "tool_choice" not in req

    def test_tool_choice_none_not_in_additional_fields(self):
        """tool_choice must NOT leak into additionalModelRequestFields."""
        p = _make_provider()
        req = _build_request(p, tool_choice="none")
        additional = req.get("additionalModelRequestFields", {})
        assert "tool_choice" not in additional

    def test_tool_choice_none_does_not_affect_toolconfig(self):
        """toolConfig is driven by the tools list, not by tool_choice."""
        p = _make_provider()
        req = _build_request(p, tools=[_TOOL], tool_choice="none")
        # toolConfig must be present (from tools), and tool_choice absent
        assert "toolConfig" in req
        assert "tool_choice" not in req

    def test_tool_choice_none_does_not_affect_inference_config(self):
        """inferenceConfig is independent of tool_choice."""
        p = _make_provider(max_tokens=128)
        req = _build_request(p, tool_choice="none")
        assert req["inferenceConfig"]["maxTokens"] == 128
        assert "tool_choice" not in req

    def test_tool_choice_none_with_no_tools_still_stripped(self):
        """tool_choice stripped even when there are no tools at all."""
        p = _make_provider()
        req = _build_request(p, tools=None, tool_choice="none")
        assert "tool_choice" not in req
        assert "toolConfig" not in req

    def test_other_unknown_key_still_goes_to_additional_fields(self):
        """Regression: stripping tool_choice must not break other extra-key forwarding."""
        p = _make_provider(model_kwargs={"custom_vendor_param": "abc"})
        req = _build_request(p, tool_choice="none")
        additional = req.get("additionalModelRequestFields", {})
        assert additional.get("custom_vendor_param") == "abc"
        assert "tool_choice" not in additional

    def test_tool_choice_auto_uses_bedrock_auto(self):
        p = _make_provider()
        req = _build_request(p, tools=[_TOOL], tool_choice="auto")
        assert req["toolConfig"]["toolChoice"] == {"auto": {}}
        assert "tool_choice" not in req.get("additionalModelRequestFields", {})

    def test_tool_choice_required_uses_bedrock_any(self):
        p = _make_provider()
        req = _build_request(p, tools=[_TOOL], tool_choice="required")
        assert req["toolConfig"]["toolChoice"] == {"any": {}}
        assert "tool_choice" not in req.get("additionalModelRequestFields", {})

    def test_tool_choice_is_omitted_without_tools(self):
        p = _make_provider()
        req = _build_request(p, tools=None, tool_choice="required")
        assert "toolConfig" not in req
        assert "tool_choice" not in req.get("additionalModelRequestFields", {})

    def test_toolconfig_shape_unaffected_by_tool_choice_stripping(self):
        """The tools list maps to the correct Bedrock toolConfig shape regardless."""
        p = _make_provider()
        req = _build_request(p, tools=[_TOOL], tool_choice="none")
        tool_config = req["toolConfig"]
        assert "tools" in tool_config
        bedrock_tool = tool_config["tools"][0]
        assert "toolSpec" in bedrock_tool
        assert bedrock_tool["toolSpec"]["name"] == "shell"

    def test_other_known_keys_also_stripped(self):
        """Sanity: the full known-strip set still works correctly alongside tool_choice."""
        p = _make_provider(
            model_kwargs={"thinking_level": "low", "responses_api": True}
        )
        req = _build_request(p, tool_choice="none")
        additional = req.get("additionalModelRequestFields", {})
        # These should all be stripped
        for stripped_key in ("tool_choice", "thinking_level", "responses_api"):
            assert stripped_key not in additional

    def test_legacy_temperature_and_top_p_stripped_not_leaked(self):
        """Regression: temperature/top_p are retired and never read into
        inferenceConfig, but a stray value surviving in old persisted
        session/agent config data must still be dropped rather than
        leaking into additionalModelRequestFields (which would cause a
        Bedrock ValidationException)."""
        p = _make_provider()
        req = _build_request(p, temperature=0.5, top_p=0.9)
        inference_config = req.get("inferenceConfig", {})
        additional = req.get("additionalModelRequestFields", {})
        assert "temperature" not in inference_config
        assert "top_p" not in inference_config
        assert "temperature" not in additional
        assert "top_p" not in additional
