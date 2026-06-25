from app.agent.providers.anthropic.anthropic import AnthropicProvider
from app.agent.schemas.chat import HumanMessage, SystemMessage, ToolMessage


def _provider() -> AnthropicProvider:
    provider = AnthropicProvider.__new__(AnthropicProvider)
    provider.model = "claude-sonnet-4-6"
    return provider


def test_payload_marks_system_and_latest_user_block_cacheable() -> None:
    provider = _provider()

    payload = provider._payload(
        [
            SystemMessage(content="system prompt"),
            HumanMessage(content="first user"),
            HumanMessage(content="latest user"),
        ],
        None,
        {"max_tokens": 16},
    )

    assert payload["system"] == [
        {
            "type": "text",
            "text": "system prompt",
            "cache_control": {"type": "ephemeral"},
        }
    ]
    assert payload["messages"][0]["content"][0].get("cache_control") is None
    assert payload["messages"][1]["content"][0]["cache_control"] == {
        "type": "ephemeral"
    }


def test_payload_marks_latest_tool_result_cacheable() -> None:
    provider = _provider()

    payload = provider._payload(
        [
            SystemMessage(content="system prompt"),
            ToolMessage(tool_call_id="call_1", content="tool output"),
        ],
        None,
        {"max_tokens": 16},
    )

    tool_result = payload["messages"][0]["content"][0]
    assert tool_result["type"] == "tool_result"
    assert tool_result["cache_control"] == {"type": "ephemeral"}
