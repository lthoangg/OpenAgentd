from __future__ import annotations

import pytest
from pydantic import SecretStr

from app.agent.providers.anthropic import AnthropicProvider
from app.agent.providers.anthropic.anthropic import (
    _split_messages,
    _uses_beta_messages_api,
)
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
    assert payload["thinking"] == {
        "type": "enabled",
        "budget_tokens": 1024,
        "display": "summarized",
    }
    assert "output_config" not in payload


@pytest.mark.parametrize(
    ("model", "expected"),
    [
        ("claude-sonnet-4-6", False),
        ("claude-opus-4-7", False),
        ("claude-haiku-4-5", False),
        ("claude-sonnet-4-5", False),
    ],
)
def test_anthropic_messages_api_beta_disabled_by_default(
    model: str, expected: bool
) -> None:
    assert _uses_beta_messages_api(model, {}) is expected


@pytest.mark.parametrize("explicit", [True, False])
def test_anthropic_messages_api_beta_respects_override(explicit: bool) -> None:
    kwargs = {"anthropic_beta": explicit}

    assert _uses_beta_messages_api("claude-sonnet-4-5", kwargs) is explicit
    assert kwargs == {}


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


def test_anthropic_payload_never_includes_temperature_or_top_p() -> None:
    """temperature/top_p are retired entirely — never sent to Anthropic,
    regardless of model, thinking mode, or caller-supplied kwargs."""
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


@pytest.mark.parametrize(
    ("thinking_level", "max_tokens", "expected_budget"),
    [
        ("low", 4096, 1024),
        ("medium", 4096, 1638),
        ("high", 4096, 2457),
    ],
)
def test_anthropic_budget_based_thinking_levels_map_to_expected_budgets(
    thinking_level: str, max_tokens: int, expected_budget: int
) -> None:
    provider = AnthropicProvider(
        api_key="sk-ant-test",
        model="claude-haiku-4-5-20251001",
        model_kwargs={"thinking_level": thinking_level, "max_tokens": max_tokens},
    )

    payload = provider._payload(
        [HumanMessage(content="hi")],
        None,
        provider._merged_kwargs(),
    )

    assert payload["thinking"] == {
        "type": "enabled",
        "budget_tokens": expected_budget,
        "display": "summarized",
    }


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


def test_split_messages_omits_assistant_tool_stub_without_matching_result() -> None:
    """Incomplete assistant tool stubs must not be replayed to Anthropic.

    A persisted assistant tool_use without the required following tool_result
    block is what triggers Anthropic 400s on resumed turns.
    """
    assistant = _make_assistant_with_tools("t1")
    _, out = _split_messages(
        [HumanMessage(content="first"), assistant, HumanMessage(content="follow-up")]
    )

    assert out == [
        {"role": "user", "content": [{"type": "text", "text": "first"}]},
        {
            "role": "assistant",
            "content": [{"type": "text", "text": "calling tools"}],
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": "follow-up",
                    "cache_control": {"type": "ephemeral"},
                }
            ],
        },
    ]


def test_split_messages_skips_empty_human_message() -> None:
    """HumanMessages with no content and no parts must be silently dropped.

    Anthropic rejects text content blocks with empty strings (HTTP 400:
    "text content blocks must be non-empty").
    """
    _, out = _split_messages(
        [
            HumanMessage(content=""),
            HumanMessage(content="hello"),
        ]
    )

    assert len(out) == 1
    assert out[0]["content"][0]["text"] == "hello"


def test_split_messages_skips_empty_assistant_message() -> None:
    """AssistantMessages with no content (and no tool calls) must be dropped."""
    _, out = _split_messages(
        [
            HumanMessage(content="hi"),
            AssistantMessage(content=None, tool_calls=None),
            AssistantMessage(content="", tool_calls=None),
            AssistantMessage(content="ok", tool_calls=None),
        ]
    )

    assistant_turns = [m for m in out if m["role"] == "assistant"]
    assert len(assistant_turns) == 1
    assert assistant_turns[0]["content"][0]["text"] == "ok"


def test_split_messages_skips_empty_text_parts_in_human_message() -> None:
    """Empty TextBlock parts inside a HumanMessage must not produce empty text blocks."""
    from app.agent.schemas.chat import TextBlock

    _, out = _split_messages(
        [
            HumanMessage(
                content=None, parts=[TextBlock(text=""), TextBlock(text="hi")]
            ),
        ]
    )

    assert len(out) == 1
    blocks = out[0]["content"]
    assert all(b["text"] for b in blocks if b["type"] == "text")
    assert blocks[0]["text"] == "hi"


def test_split_messages_skips_human_message_with_only_empty_text_parts() -> None:
    """A HumanMessage whose parts are all empty TextBlocks must be dropped entirely."""
    from app.agent.schemas.chat import TextBlock

    _, out = _split_messages(
        [
            HumanMessage(content=None, parts=[TextBlock(text=""), TextBlock(text="")]),
            HumanMessage(content="keep"),
        ]
    )

    assert len(out) == 1
    assert out[0]["content"][0]["text"] == "keep"


def test_split_messages_keeps_complete_assistant_tool_pair() -> None:
    """Complete assistant tool_use + tool_result pairs are preserved."""
    assistant = _make_assistant_with_tools("t1")
    _, out = _split_messages(
        [
            HumanMessage(content="first"),
            assistant,
            ToolMessage(content="done", tool_call_id="t1", name="tool"),
            HumanMessage(content="follow-up"),
        ]
    )

    assert out[1]["role"] == "assistant"
    assert out[1]["content"][1]["type"] == "tool_use"
    assert out[2]["role"] == "user"
    assert out[2]["content"][0]["type"] == "tool_result"


# ---------------------------------------------------------------------------
# thinking block round-trip (extended-thinking history contract)
# ---------------------------------------------------------------------------


def test_split_messages_echoes_thinking_block_with_tool_calls() -> None:
    """An AssistantMessage with reasoning_content + signature + tool_calls must
    include the thinking block first so Anthropic's extended-thinking history
    contract is met.  The API requires both `thinking` and `signature`."""
    assistant = AssistantMessage(
        content=None,
        reasoning_content="I should call the shell tool.",
        reasoning_signature="sig-abc",
        tool_calls=[
            ToolCall(
                id="t1",
                function=FunctionCall(name="shell", arguments='{"command":"ls"}'),
            )
        ],
    )
    _, out = _split_messages(
        [
            HumanMessage(content="run ls"),
            assistant,
            ToolMessage(content="file.txt", tool_call_id="t1", name="shell"),
        ]
    )

    assistant_turn = next(m for m in out if m["role"] == "assistant")
    block_types = [b["type"] for b in assistant_turn["content"]]
    assert block_types[0] == "thinking", "thinking block must come first"
    assert "tool_use" in block_types
    thinking_block = assistant_turn["content"][0]
    assert thinking_block["thinking"] == "I should call the shell tool."
    assert thinking_block["signature"] == "sig-abc"


def test_split_messages_echoes_thinking_block_plain_assistant() -> None:
    """An AssistantMessage with reasoning_content + signature but no tool_calls
    must include the thinking block so history stays valid under extended thinking."""
    _, out = _split_messages(
        [
            HumanMessage(content="think out loud"),
            AssistantMessage(
                content="Here is my answer.",
                reasoning_content="Let me reason first.",
                reasoning_signature="sig-xyz",
                tool_calls=None,
            ),
        ]
    )

    assistant_turn = next(m for m in out if m["role"] == "assistant")
    block_types = [b["type"] for b in assistant_turn["content"]]
    assert block_types == ["thinking", "text"]
    assert assistant_turn["content"][0]["thinking"] == "Let me reason first."
    assert assistant_turn["content"][0]["signature"] == "sig-xyz"
    assert assistant_turn["content"][1]["text"] == "Here is my answer."


def test_split_messages_echoes_thinking_block_when_content_empty() -> None:
    """Max-token truncation can produce reasoning_content with empty content.
    The thinking block alone must be emitted — not skipped — so the API
    receives a valid non-empty content array instead of an empty one."""
    _, out = _split_messages(
        [
            HumanMessage(content="hi"),
            AssistantMessage(
                content=None,
                reasoning_content="Ran out of tokens mid-thought.",
                reasoning_signature="sig-trunc",
                tool_calls=None,
            ),
            HumanMessage(content="continue"),
        ]
    )

    assistant_turns = [m for m in out if m["role"] == "assistant"]
    assert len(assistant_turns) == 1, "truncated thinking-only turn must be kept"
    blocks = assistant_turns[0]["content"]
    assert len(blocks) == 1
    assert blocks[0]["type"] == "thinking"
    assert blocks[0]["thinking"] == "Ran out of tokens mid-thought."
    assert blocks[0]["signature"] == "sig-trunc"


# ---------------------------------------------------------------------------
# signature guard — missing signature must silently drop the thinking block
# ---------------------------------------------------------------------------


def test_split_messages_drops_thinking_block_when_signature_missing_tool_calls() -> (
    None
):
    """Pre-fix rows have reasoning_content but no reasoning_signature.
    Sending an empty/missing signature triggers HTTP 400 'Invalid signature'.
    The thinking block must be silently omitted; tool_use blocks are still sent."""
    assistant = AssistantMessage(
        content=None,
        reasoning_content="some thoughts",
        reasoning_signature=None,  # pre-fix row — no signature stored
        tool_calls=[
            ToolCall(
                id="t1",
                function=FunctionCall(name="shell", arguments='{"command":"ls"}'),
            )
        ],
    )
    _, out = _split_messages(
        [
            HumanMessage(content="run ls"),
            assistant,
            ToolMessage(content="file.txt", tool_call_id="t1", name="shell"),
        ]
    )

    assistant_turn = next(m for m in out if m["role"] == "assistant")
    block_types = [b["type"] for b in assistant_turn["content"]]
    assert "thinking" not in block_types, (
        "thinking block must be dropped without signature"
    )
    assert "tool_use" in block_types


def test_split_messages_drops_thinking_block_when_signature_missing_plain() -> None:
    """Same guard for plain (non-tool-call) assistant turns without a signature."""
    _, out = _split_messages(
        [
            HumanMessage(content="hi"),
            AssistantMessage(
                content="My answer.",
                reasoning_content="some thoughts",
                reasoning_signature=None,
            ),
        ]
    )

    assistant_turn = next(m for m in out if m["role"] == "assistant")
    block_types = [b["type"] for b in assistant_turn["content"]]
    assert "thinking" not in block_types
    assert block_types == ["text"]
    assert assistant_turn["content"][0]["text"] == "My answer."


def test_anthropic_provider_8k_output_sonnet_v2() -> None:
    # Sonnet v2 should NOT have 8k max_tokens or beta header now (defaults to 4096)
    provider_v2 = AnthropicProvider(
        api_key="sk-ant-test",
        model="claude-3-5-sonnet-20241022",
    )
    assert "anthropic-beta" not in provider_v2.headers
    payload_v2 = provider_v2._payload([HumanMessage(content="hi")], None, {})
    assert payload_v2["max_tokens"] == 4096

    # Sonnet v1 should also default to 4096
    provider_v1 = AnthropicProvider(
        api_key="sk-ant-test",
        model="claude-3-5-sonnet-20240620",
    )
    assert "anthropic-beta" not in provider_v1.headers
    payload_v1 = provider_v1._payload([HumanMessage(content="hi")], None, {})
    assert payload_v1["max_tokens"] == 4096

    # Claude 3.7 should default to 4k max_tokens and have no beta header
    provider_37 = AnthropicProvider(
        api_key="sk-ant-test",
        model="claude-3-7-sonnet",
    )
    assert "anthropic-beta" not in provider_37.headers
    payload_37 = provider_37._payload([HumanMessage(content="hi")], None, {})
    assert payload_37["max_tokens"] == 4096

    # Claude 4.6 Sonnet should have its registry limit or 4k fallback
    provider_46 = AnthropicProvider(
        api_key="sk-ant-test",
        model="claude-sonnet-4-6",
    )
    assert "anthropic-beta" not in provider_46.headers
    payload_46 = provider_46._payload([HumanMessage(content="hi")], None, {})
    assert payload_46["max_tokens"] in (64000, 4096)

    # Claude 4.8 Opus should have its registry limit or 4k fallback
    provider_48 = AnthropicProvider(
        api_key="sk-ant-test",
        model="claude-opus-4-8",
    )
    assert "anthropic-beta" not in provider_48.headers
    payload_48 = provider_48._payload([HumanMessage(content="hi")], None, {})
    assert payload_48["max_tokens"] in (128000, 4096)


def test_anthropic_payload_service_tier_official_url() -> None:
    provider = AnthropicProvider(
        api_key="sk-ant-test",
        model="claude-sonnet-4-6",
        model_kwargs={"service_tier": "fast"},
    )
    payload = provider._payload(
        [HumanMessage(content="hi")],
        None,
        provider._merged_kwargs(),
    )
    assert payload["service_tier"] == "auto"


def test_anthropic_payload_service_tier_custom_url() -> None:
    provider = AnthropicProvider(
        api_key="sk-ant-test",
        model="claude-sonnet-4-6",
        base_url="https://some-proxy.com",
        model_kwargs={"service_tier": "fast"},
    )
    payload = provider._payload(
        [HumanMessage(content="hi")],
        None,
        provider._merged_kwargs(),
    )
    assert "service_tier" not in payload
