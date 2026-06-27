from __future__ import annotations

from pydantic import SecretStr

from app.agent.providers.anthropic import AnthropicProvider
from app.agent.providers.anthropic.anthropic import _split_messages
from app.agent.schemas.chat import (
    AssistantMessage,
    FunctionCall,
    HumanMessage,
    SystemMessage,
    ToolCall,
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

    assert payload["system"] == [
        {
            "type": "text",
            "text": "be concise",
            "cache_control": {"type": "ephemeral"},
        }
    ]
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


def _make_assistant_with_tools(*tool_ids: str) -> AssistantMessage:
    return AssistantMessage(
        content="calling tools",
        tool_calls=[
            ToolCall(id=tid, function=FunctionCall(name="tool", arguments="{}"))
            for tid in tool_ids
        ],
    )


def test_split_messages_batches_parallel_tool_results_into_single_user_turn() -> None:
    """Parallel tool results must land in one user turn, not N separate turns.

    Anthropic rejects consecutive user-role messages; all tool_result blocks
    from a single assistant turn must be merged into one {"role": "user"} turn.
    """
    assistant = _make_assistant_with_tools("t1", "t2", "t3")
    tool_msgs = [
        ToolMessage(content=f"result {i}", tool_call_id=f"t{i + 1}", name="tool")
        for i in range(3)
    ]
    _, out = _split_messages([HumanMessage(content="go"), assistant, *tool_msgs])

    user_turns = [m for m in out if m["role"] == "user"]
    # First user turn is the human message; second is the batched tool results.
    assert len(user_turns) == 2
    tool_turn = user_turns[1]
    assert len(tool_turn["content"]) == 3
    assert all(b["type"] == "tool_result" for b in tool_turn["content"])
    assert [b["tool_use_id"] for b in tool_turn["content"]] == ["t1", "t2", "t3"]


def test_split_messages_cache_control_on_last_block_of_batched_turn() -> None:
    """cache_control must land only on the last block of the merged tool turn."""
    assistant = _make_assistant_with_tools("a", "b")
    tool_msgs = [
        ToolMessage(content="ok", tool_call_id="a", name="tool"),
        ToolMessage(content="ok", tool_call_id="b", name="tool"),
    ]
    _, out = _split_messages([HumanMessage(content="go"), assistant, *tool_msgs])

    tool_turn = next(
        m
        for m in out
        if m["role"] == "user" and m["content"][0]["type"] == "tool_result"
    )
    first, last = tool_turn["content"][0], tool_turn["content"][-1]
    assert "cache_control" not in first
    assert last.get("cache_control") == {"type": "ephemeral"}


def test_split_messages_sets_is_error_on_error_tool_results() -> None:
    """Tool results whose content starts with 'Error:' must have is_error=True."""
    assistant = _make_assistant_with_tools("ok_id", "err_id")
    _, out = _split_messages(
        [
            HumanMessage(content="go"),
            assistant,
            ToolMessage(content="all good", tool_call_id="ok_id", name="tool"),
            ToolMessage(
                content="Error: File not found: foo.txt",
                tool_call_id="err_id",
                name="tool",
            ),
        ]
    )

    tool_turn = next(
        m
        for m in out
        if m["role"] == "user" and m["content"][0]["type"] == "tool_result"
    )
    blocks = {b["tool_use_id"]: b for b in tool_turn["content"]}
    assert "is_error" not in blocks["ok_id"]
    assert blocks["err_id"].get("is_error") is True


def test_split_messages_does_not_batch_tool_results_across_human_turn() -> None:
    """A human message between two tool groups must keep them in separate user turns."""
    a1 = _make_assistant_with_tools("t1")
    a2 = _make_assistant_with_tools("t2")
    _, out = _split_messages(
        [
            HumanMessage(content="first"),
            a1,
            ToolMessage(content="r1", tool_call_id="t1", name="tool"),
            HumanMessage(content="second"),
            a2,
            ToolMessage(content="r2", tool_call_id="t2", name="tool"),
        ]
    )

    tool_turns = [
        m
        for m in out
        if m["role"] == "user"
        and m["content"]
        and m["content"][0]["type"] == "tool_result"
    ]
    assert len(tool_turns) == 2
    assert tool_turns[0]["content"][0]["tool_use_id"] == "t1"
    assert tool_turns[1]["content"][0]["tool_use_id"] == "t2"
