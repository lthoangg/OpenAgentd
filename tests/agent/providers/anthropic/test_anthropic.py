from __future__ import annotations

from pydantic import SecretStr

from app.agent.providers.anthropic import AnthropicProvider
from app.agent.schemas.chat import (
    AssistantMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)


def test_anthropic_provider_requires_api_key() -> None:
    try:
        AnthropicProvider(api_key="", model="claude-sonnet-4-6")
    except ValueError as exc:
        assert "ANTHROPIC_API_KEY" in str(exc)
    else:
        raise AssertionError("expected ValueError")


def test_anthropic_provider_accepts_secret_str() -> None:
    provider = AnthropicProvider(
        api_key=SecretStr("sk-ant-test"),
        model="claude-sonnet-4-6",
    )

    assert provider.api_key == "sk-ant-test"
    assert provider.base_url == "https://api.anthropic.com"


def test_anthropic_provider_accepts_custom_timeout() -> None:
    provider = AnthropicProvider(
        api_key="sk-ant-test",
        model="claude-sonnet-4-6",
        timeout=None,
    )

    assert provider._timeout is None


def test_anthropic_payload_converts_system_tools_and_thinking() -> None:
    provider = AnthropicProvider(
        api_key="sk-ant-test",
        model="claude-sonnet-4-6",
        model_kwargs={"thinking_level": "low", "max_tokens": 4096},
    )

    payload = provider._payload(
        [
            SystemMessage(content="be concise"),
            HumanMessage(content="hi"),
            AssistantMessage(content=None, tool_calls=[]),
            ToolMessage(tool_call_id="toolu_1", content="ok"),
        ],
        [
            {
                "type": "function",
                "function": {
                    "name": "lookup",
                    "description": "Lookup a value.",
                    "parameters": {"type": "object", "properties": {}},
                },
            }
        ],
        provider._merged_kwargs(),
    )

    assert payload["system"] == "be concise"
    assert payload["tools"][0]["name"] == "lookup"
    assert payload["thinking"] == {"type": "adaptive", "display": "summarized"}
    assert payload["output_config"] == {"effort": "low"}


def test_anthropic_payload_uses_adaptive_thinking_for_claude_opus_4_7() -> None:
    provider = AnthropicProvider(
        api_key="sk-ant-test",
        model="claude-opus-4-7",
        model_kwargs={"thinking_level": "medium", "max_tokens": 4096},
    )

    payload = provider._payload(
        [HumanMessage(content="hi")],
        None,
        provider._merged_kwargs(),
    )

    assert payload["thinking"] == {"type": "adaptive", "display": "summarized"}
    assert payload["output_config"] == {"effort": "medium"}
    assert "budget_tokens" not in payload["thinking"]


def test_anthropic_payload_uses_manual_thinking_for_older_models() -> None:
    provider = AnthropicProvider(
        api_key="sk-ant-test",
        model="claude-sonnet-4-5",
        model_kwargs={"thinking_level": "low", "max_tokens": 4096},
    )

    payload = provider._payload(
        [HumanMessage(content="hi")],
        None,
        provider._merged_kwargs(),
    )

    assert payload["thinking"] == {
        "type": "enabled",
        "budget_tokens": 1024,
        "display": "summarized",
    }
    assert "output_config" not in payload


def test_anthropic_payload_omits_incompatible_sampling_when_thinking() -> None:
    provider = AnthropicProvider(
        api_key="sk-ant-test",
        model="claude-sonnet-4",
        model_kwargs={
            "thinking_level": "low",
            "temperature": 0.2,
            "top_p": 0.7,
            "max_tokens": 4096,
        },
    )

    payload = provider._payload(
        [HumanMessage(content="hi")],
        None,
        provider._merged_kwargs(),
    )

    assert payload["thinking"] == {
        "type": "enabled",
        "budget_tokens": 1024,
        "display": "summarized",
    }
    assert "temperature" not in payload
    assert "top_p" not in payload


def test_anthropic_payload_allows_supported_top_p_when_thinking() -> None:
    provider = AnthropicProvider(
        api_key="sk-ant-test",
        model="claude-sonnet-4",
        model_kwargs={
            "thinking_level": "low",
            "temperature": 0.2,
            "top_p": 0.95,
            "max_tokens": 4096,
        },
    )

    payload = provider._payload(
        [HumanMessage(content="hi")],
        None,
        provider._merged_kwargs(),
    )

    assert "temperature" not in payload
    assert payload["top_p"] == 0.95
