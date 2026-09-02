"""Tests for app/agent/schemas/chat.py — BaseMessage.model_dump_full() and related."""

from __future__ import annotations

from uuid import UUID


from app.agent.schemas.chat import (
    AssistantMessage,
    ChatCompletionDelta,
    EncryptedReasoningItem,
    FunctionCall,
    HumanMessage,
    ImageDataBlock,
    ImageUrlBlock,
    TextBlock,
    ToolCall,
    ToolCallDelta,
    ToolMessage,
    Usage,
)


# ---------------------------------------------------------------------------
# Usage defaults
# ---------------------------------------------------------------------------


class TestUsageDefaults:
    def test_default_values(self):
        u = Usage()
        assert u.prompt_tokens == 0
        assert u.completion_tokens == 0
        assert u.total_tokens == 0
        assert u.cached_tokens is None
        assert u.thoughts_tokens is None
        assert u.tool_use_tokens is None

    def test_explicit_values(self):
        u = Usage(
            prompt_tokens=10,
            completion_tokens=5,
            total_tokens=15,
            cached_tokens=3,
            thoughts_tokens=2,
        )
        assert u.prompt_tokens == 10
        assert u.cached_tokens == 3
        assert u.thoughts_tokens == 2


# ---------------------------------------------------------------------------
# ToolCallDelta defaults
# ---------------------------------------------------------------------------


class TestToolCallDeltaDefaults:
    def test_all_optional_fields_default_none(self):
        tcd = ToolCallDelta()
        assert tcd.index is None
        assert tcd.id is None
        assert tcd.function is None

    def test_type_defaults_to_function(self):
        tcd = ToolCallDelta()
        assert tcd.type == "function"


# ---------------------------------------------------------------------------
# ChatCompletionDelta._coerce_reasoning
# ---------------------------------------------------------------------------


class TestCoerceReasoning:
    def test_string_preserved(self):
        delta = ChatCompletionDelta(reasoning_content="Thinking...")
        assert delta.reasoning_content == "Thinking..."

    def test_int_coerced_to_none(self):
        delta = ChatCompletionDelta(reasoning_content=42)  # type: ignore[arg-type]
        assert delta.reasoning_content is None

    def test_none_stays_none(self):
        delta = ChatCompletionDelta(reasoning_content=None)
        assert delta.reasoning_content is None

    def test_empty_string_preserved(self):
        delta = ChatCompletionDelta(reasoning_content="")
        assert delta.reasoning_content == ""

    def test_float_coerced_to_none(self):
        delta = ChatCompletionDelta(reasoning_content=3.14)  # type: ignore[arg-type]
        assert delta.reasoning_content is None


# ---------------------------------------------------------------------------
# BaseMessage.model_dump_full()
# ---------------------------------------------------------------------------


class TestModelDumpFull:
    def test_includes_exclude_true_fields(self):
        msg = HumanMessage(content="hello")
        msg.exclude_from_context = True
        msg.is_summary = True
        msg.extra = {"key": "val"}

        d = msg.model_dump_full(exclude_none=False)
        assert "exclude_from_context" in d
        assert "is_summary" in d
        assert "extra" in d

    def test_db_id_always_omitted(self):
        msg = HumanMessage(content="hello")
        msg.db_id = UUID("12345678-1234-5678-1234-567812345678")

        d = msg.model_dump_full()
        assert "db_id" not in d

    def test_exclude_none_true_drops_none_fields(self):
        msg = HumanMessage(content="hello")
        d = msg.model_dump_full(exclude_none=True)
        # Me extra is None by default — should be dropped
        assert "extra" not in d

    def test_exclude_none_false_includes_none_fields(self):
        msg = HumanMessage(content="hello")
        d = msg.model_dump_full(exclude_none=False)
        # Me extra is None — should be present
        assert "extra" in d
        assert d["extra"] is None

    def test_nested_pydantic_model_serialized_to_dict(self):
        msg = AssistantMessage(
            content=None,
            tool_calls=[
                ToolCall(
                    id="call_1",
                    function=FunctionCall(name="search", arguments='{"q":"x"}'),
                )
            ],
        )
        d = msg.model_dump_full()
        assert isinstance(d["tool_calls"], list)
        assert isinstance(d["tool_calls"][0], dict)
        assert d["tool_calls"][0]["function"]["name"] == "search"

    def test_list_of_pydantic_models_serialized(self):
        msg = AssistantMessage(
            content=None,
            tool_calls=[
                ToolCall(
                    id="call_1",
                    function=FunctionCall(name="fn1", arguments="{}"),
                ),
                ToolCall(
                    id="call_2",
                    function=FunctionCall(name="fn2", arguments="{}"),
                ),
            ],
        )
        d = msg.model_dump_full()
        assert len(d["tool_calls"]) == 2
        assert all(isinstance(tc, dict) for tc in d["tool_calls"])

    def test_human_message_full_dump(self):
        msg = HumanMessage(content="hello")
        msg.is_summary = True
        d = msg.model_dump_full(exclude_none=False)
        assert d["role"] == "user"
        assert d["content"] == "hello"
        assert d["is_summary"] is True

    def test_assistant_message_reasoning_content_included(self):
        msg = AssistantMessage(content="answer", reasoning_content="thinking")
        d = msg.model_dump_full()
        assert "reasoning_content" in d
        assert d["reasoning_content"] == "thinking"

    def test_assistant_message_reasoning_content_excluded_from_model_dump(self):
        """Me model_dump() must NOT include reasoning_content (provider safety)."""
        msg = AssistantMessage(content="answer", reasoning_content="thinking")
        d = msg.model_dump(exclude_none=True)
        assert "reasoning_content" not in d

    def test_tool_message_full_dump(self):
        msg = ToolMessage(content="result", tool_call_id="call_1", name="fn")
        d = msg.model_dump_full()
        assert d["role"] == "tool"
        assert d["tool_call_id"] == "call_1"
        assert d["name"] == "fn"

    def test_exclude_from_context_included_in_full_dump(self):
        msg = HumanMessage(content="hi")
        msg.exclude_from_context = True
        d = msg.model_dump_full()
        assert d["exclude_from_context"] is True

    def test_exclude_from_context_excluded_from_model_dump(self):
        """Me model_dump() must NOT include exclude_from_context."""
        msg = HumanMessage(content="hi")
        msg.exclude_from_context = True
        d = msg.model_dump(exclude_none=True)
        assert "exclude_from_context" not in d

    def test_extra_dict_included_in_full_dump(self):
        msg = AssistantMessage(content="ok")
        msg.extra = {"usage": {"input": 10, "output": 5}}
        d = msg.model_dump_full()
        assert d["extra"] == {"usage": {"input": 10, "output": 5}}

    def test_extra_dict_excluded_from_model_dump(self):
        """``model_dump()`` (the LLM-serialisation path) must drop ``extra``.

        Providers feed messages to the LLM via ``model_dump(exclude_none=True)``;
        anything that lands there is visible to the model.  ``extra`` carries
        metadata (usage stats, the ``interrupted`` marker, etc.) that must
        never leak into the prompt — neither the key nor its values.  This
        test pins that contract: serialising an interrupted assistant
        message yields a payload that contains neither ``extra`` nor the
        string ``interrupted``.
        """
        msg = AssistantMessage(
            content="partial answer",
            extra={"interrupted": True, "usage": {"input": 42}},
        )
        d = msg.model_dump(exclude_none=True)
        assert "extra" not in d
        assert "interrupted" not in repr(d)

    def test_is_summary_included_in_full_dump(self):
        msg = HumanMessage(content="[summary of conversation]")
        msg.is_summary = True
        d = msg.model_dump_full()
        assert d["is_summary"] is True

    def test_is_summary_excluded_from_model_dump(self):
        msg = HumanMessage(content="[summary]")
        msg.is_summary = True
        d = msg.model_dump(exclude_none=True)
        assert "is_summary" not in d

    def test_agent_name_included_in_assistant_full_dump(self):
        msg = AssistantMessage(content="ok")
        msg.agent_name = "my-agent"
        d = msg.model_dump_full()
        assert d.get("agent_name") == "my-agent"

    def test_agent_name_excluded_from_model_dump(self):
        msg = AssistantMessage(content="ok")
        msg.agent_name = "my-agent"
        d = msg.model_dump(exclude_none=True)
        assert "agent_name" not in d

    def test_default_exclude_none_is_true(self):
        """Me default call drops None fields."""
        msg = HumanMessage(content="hi")
        d = msg.model_dump_full()
        # Me extra is None by default — dropped with default exclude_none=True
        assert "extra" not in d

    def test_list_of_non_pydantic_values_passed_through(self):
        """Line 113: list items that are not BaseModel are passed through as-is."""
        msg = HumanMessage(content="hi")
        msg.extra = {"tags": ["a", "b", "c"]}
        d = msg.model_dump_full()
        assert d["extra"]["tags"] == ["a", "b", "c"]


# ---------------------------------------------------------------------------
# HumanMessage.text_content (lines 140-143)
# ---------------------------------------------------------------------------


class TestHumanMessageTextContent:
    def test_returns_content_when_no_parts(self):
        msg = HumanMessage(content="hello")
        assert msg.text_content() == "hello"

    def test_returns_joined_text_blocks_when_parts_present(self):
        msg = HumanMessage(
            content="original",
            parts=[TextBlock(text="first"), TextBlock(text="second")],
        )
        assert msg.text_content() == "first second"

    def test_returns_content_fallback_when_parts_have_no_text_blocks(self):
        """Parts contain only image — fall back to content."""
        msg = HumanMessage(
            content="fallback text",
            parts=[ImageDataBlock(data="b64", media_type="image/png")],
        )
        assert msg.text_content() == "fallback text"

    def test_returns_none_when_no_content_and_no_parts(self):
        msg = HumanMessage(content=None)
        assert msg.text_content() is None


# ---------------------------------------------------------------------------
# HumanMessage.is_multimodal (lines 147-149)
# ---------------------------------------------------------------------------


class TestHumanMessageIsMultimodal:
    def test_false_when_no_parts(self):
        msg = HumanMessage(content="text only")
        assert msg.is_multimodal() is False

    def test_false_when_parts_is_none(self):
        msg = HumanMessage(content="text", parts=None)
        assert msg.is_multimodal() is False

    def test_false_when_parts_has_only_text_blocks(self):
        msg = HumanMessage(
            content="text",
            parts=[TextBlock(text="a"), TextBlock(text="b")],
        )
        assert msg.is_multimodal() is False

    def test_true_when_parts_has_image_data_block(self):
        msg = HumanMessage(
            content="describe",
            parts=[ImageDataBlock(data="b64", media_type="image/jpeg")],
        )
        assert msg.is_multimodal() is True

    def test_true_when_parts_has_image_url_block(self):
        msg = HumanMessage(
            content="describe",
            parts=[ImageUrlBlock(url="https://example.com/img.jpg")],
        )
        assert msg.is_multimodal() is True

    def test_true_when_mixed_text_and_image(self):
        msg = HumanMessage(
            content="describe",
            parts=[
                TextBlock(text="describe this"),
                ImageDataBlock(data="b64", media_type="image/png"),
            ],
        )
        assert msg.is_multimodal() is True


# ---------------------------------------------------------------------------
# capabilities.py — exact-match resolution against the bundled YAML
# (See tests/agent/providers/test_capabilities.py for the resolver's
# detailed contract. The cases below cover schema-adjacent behaviour
# that should keep working even if the YAML contents shift.)
# ---------------------------------------------------------------------------


class TestGetCapabilities:
    def test_none_returns_default(self):
        from app.agent.providers.capabilities import get_capabilities

        caps = get_capabilities(None)
        assert caps.input.vision is False
        assert caps.input.document_text is True

    def test_unknown_model_returns_default(self):
        from app.agent.providers.capabilities import get_capabilities

        # No prefix matching — a made-up openai:* falls through to defaults.
        caps = get_capabilities("openai:gpt-unknown-future-model")
        assert caps.input.vision is False
        assert caps.input.document_text is True

    def test_unknown_provider_returns_default(self):
        from app.agent.providers.capabilities import get_capabilities

        caps = get_capabilities("unknown_provider:some-model")
        assert caps.input.vision is False
        assert caps.input.document_text is True

    def test_listed_vision_model(self):
        from app.agent.providers.capabilities import get_capabilities

        # openai:gpt-5.5 is in the bundled YAML with vision=true.
        assert get_capabilities("openai:gpt-5.5").input.vision is True

    def test_case_insensitive_lookup(self):
        from app.agent.providers.capabilities import get_capabilities

        caps_lower = get_capabilities("openai:gpt-5.5")
        caps_upper = get_capabilities("OPENAI:GPT-5.5")
        assert caps_lower == caps_upper

    def test_to_dict(self):
        from app.agent.providers.capabilities import (
            ModelCapabilities,
            ModelInputCapabilities,
        )

        caps = ModelCapabilities(
            input=ModelInputCapabilities(vision=True, document_text=True)
        )
        d = caps.to_dict()
        assert d == {
            "input": {
                "vision": True,
                "document_text": True,
                "audio": False,
                "video": False,
            },
            "output": {
                "text": True,
                "image": False,
                "audio": False,
                "video": False,
            },
        }


# ---------------------------------------------------------------------------
# Settings — NVIDIA_API_KEY
# ---------------------------------------------------------------------------


class TestNvidiaSettings:
    def test_nvidia_api_key_defaults_to_none(self):
        """NVIDIA_API_KEY is optional and defaults to None when not set."""
        from app.core.config import Settings

        s = Settings(NVIDIA_API_KEY=None)
        assert s.NVIDIA_API_KEY is None

    def test_nvidia_api_key_accepts_secret_str(self):
        """NVIDIA_API_KEY is stored as SecretStr."""
        from app.core.config import Settings
        from pydantic import SecretStr

        s = Settings(NVIDIA_API_KEY="nvapi-test-key")  # type: ignore[arg-type]
        assert isinstance(s.NVIDIA_API_KEY, SecretStr)
        assert s.NVIDIA_API_KEY.get_secret_value() == "nvapi-test-key"


# ---------------------------------------------------------------------------
# AssistantMessage reasoning_items & backwards compatibility
# ---------------------------------------------------------------------------


class TestAssistantMessageReasoningItems:
    def test_init_with_reasoning_items_syncs_extra_and_aliases(self):
        msg = AssistantMessage(
            content="Done",
            reasoning_items=[
                EncryptedReasoningItem(
                    id="rs_1",
                    summary=[{"type": "summary_text", "text": "Thought 1"}],
                    encrypted_content="cipher-1",
                ),
                EncryptedReasoningItem(
                    id="rs_2",
                    summary=[{"type": "summary_text", "text": "Thought 2"}],
                    encrypted_content="cipher-2",
                ),
            ],
        )
        assert msg.reasoning_item_id == "rs_2"
        assert msg.reasoning_encrypted_content == "cipher-2"
        assert msg.reasoning_items is not None
        assert len(msg.reasoning_items) == 2
        assert msg.extra is not None
        assert msg.extra["reasoning_item_id"] == "rs_2"
        assert msg.extra["reasoning_encrypted_content"] == "cipher-2"
        assert len(msg.extra["reasoning_items"]) == 2
        assert msg.extra["reasoning_items"][0]["id"] == "rs_1"
        assert msg.extra["reasoning_items"][1]["id"] == "rs_2"

    def test_init_with_legacy_single_fields_creates_reasoning_items(self):
        msg = AssistantMessage(
            content="Done",
            reasoning_content="Single thought",
            reasoning_item_id="rs_1",
            reasoning_encrypted_content="cipher-1",
        )
        assert msg.reasoning_items is not None
        assert len(msg.reasoning_items) == 1
        assert msg.reasoning_items[0].id == "rs_1"
        assert msg.reasoning_items[0].encrypted_content == "cipher-1"
        assert msg.reasoning_items[0].summary == [
            {"type": "summary_text", "text": "Single thought"}
        ]
        assert msg.extra is not None
        assert msg.extra["reasoning_item_id"] == "rs_1"
        assert msg.extra["reasoning_encrypted_content"] == "cipher-1"

    def test_init_from_extra_with_reasoning_items_list(self):
        msg = AssistantMessage(
            content="Done",
            extra={
                "reasoning_items": [
                    {
                        "id": "rs_1",
                        "summary": [{"type": "summary_text", "text": "P1"}],
                        "encrypted_content": "c1",
                    },
                    {
                        "id": "rs_2",
                        "summary": [{"type": "summary_text", "text": "P2"}],
                        "encrypted_content": "c2",
                    },
                ]
            },
        )
        assert msg.reasoning_items is not None
        assert len(msg.reasoning_items) == 2
        assert msg.reasoning_items[0].id == "rs_1"
        assert msg.reasoning_items[1].id == "rs_2"
        assert msg.reasoning_item_id == "rs_2"
        assert msg.reasoning_encrypted_content == "c2"

    def test_init_from_extra_with_legacy_single_encrypted_content(self):
        msg = AssistantMessage(
            content="Done",
            reasoning_content="Legacy thought",
            extra={
                "reasoning_item_id": "rs_legacy",
                "reasoning_encrypted_content": "c_legacy",
            },
        )
        assert msg.reasoning_items is not None
        assert len(msg.reasoning_items) == 1
        assert msg.reasoning_items[0].id == "rs_legacy"
        assert msg.reasoning_items[0].encrypted_content == "c_legacy"
        assert msg.reasoning_items[0].summary == [
            {"type": "summary_text", "text": "Legacy thought"}
        ]
        assert msg.reasoning_item_id == "rs_legacy"
        assert msg.reasoning_encrypted_content == "c_legacy"
