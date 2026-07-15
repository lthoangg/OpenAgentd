import pytest
import respx
import httpx
from app.agent.providers.googlegenai.googlegenai import GoogleGenAIProvider
from app.agent.schemas.chat import (
    AssistantMessage,
    HumanMessage,
    ImageDataBlock,
    ImageUrlBlock,
    SystemMessage,
    TextBlock,
    ToolCall,
    ToolMessage,
    FunctionCall as ChatFunctionCall,
)


from app.agent.providers.googlegenai.schemas import (
    FunctionCall,
    GeminiChatRequest,
    GeminiChatResponse,
    Content,
    Part,
    GenerationConfig,
)


def test_gemini_schema_camel_case_dump():
    """Verify that Gemini schemas dump to camelCase when using by_alias=True."""
    req = GeminiChatRequest(
        contents=[Content(role="user", parts=[Part(text="hi")])],
        system_instruction=Content(parts=[Part(text="sys")]),
        generation_config=GenerationConfig(max_output_tokens=100),
    )
    dump = req.model_dump(exclude_none=True, by_alias=True)
    assert "systemInstruction" in dump
    assert "generationConfig" in dump
    assert "maxOutputTokens" in dump["generationConfig"]
    assert "system_instruction" not in dump


@pytest.fixture
def google_provider():
    return GoogleGenAIProvider(api_key="test-key", model="gemini-1.5-flash")


def test_init_no_key():
    with pytest.raises(ValueError, match="Google API key is required"):
        GoogleGenAIProvider(api_key="", model="gemini-1.5-flash")


def test_convert_messages_to_gemini(google_provider):
    messages = [
        SystemMessage(content="system instructions"),
        HumanMessage(content="hello"),
        AssistantMessage(content="hi there", reasoning_content="thinking"),
        ToolMessage(
            content='{"result": "success"}', tool_call_id="call_1", name="get_weather"
        ),
        ToolMessage(
            content='{"result": "london"}', tool_call_id="call_2", name="get_location"
        ),
    ]

    merged_contents, system_instruction = google_provider._convert_messages_to_gemini(
        messages
    )

    assert system_instruction.parts[0].text == "system instructions"
    # User(hello) -> Model(hi there) -> User(weather resp, location resp)
    assert len(merged_contents) == 3
    assert merged_contents[0].role == "user"
    assert merged_contents[0].parts[0].text == "hello"
    assert merged_contents[1].role == "model"
    assert merged_contents[1].parts[0].text == "hi there"
    assert merged_contents[2].role == "user"
    assert len(merged_contents[2].parts) == 2
    assert merged_contents[2].parts[0].function_response.name == "get_weather"
    assert merged_contents[2].parts[0].function_response.id == "call_1"
    assert merged_contents[2].parts[1].function_response.name == "get_location"
    assert merged_contents[2].parts[1].function_response.id == "call_2"


def test_convert_tool_message_payload_includes_function_response_id(google_provider):
    messages = [
        ToolMessage(
            content='{"result": "success"}',
            tool_call_id="toolu_123",
            name="read_file",
        )
    ]

    contents, _ = google_provider._convert_messages_to_gemini(messages)
    request = GeminiChatRequest(contents=contents)
    dump = request.model_dump(exclude_none=True, by_alias=True)

    function_response = dump["contents"][0]["parts"][0]["functionResponse"]
    assert function_response["name"] == "read_file"
    assert function_response["id"] == "toolu_123"
    assert function_response["response"] == {"result": "success"}


def test_convert_assistant_message_with_tools(google_provider):
    messages = [
        AssistantMessage(
            content=None,
            tool_calls=[
                ToolCall(
                    id="call_1",
                    function=ChatFunctionCall(
                        name="get_weather", arguments='{"location": "London"}'
                    ),
                )
            ],
        )
    ]
    merged_contents, _ = google_provider._convert_messages_to_gemini(messages)
    assert merged_contents[0].role == "model"
    assert merged_contents[0].parts[0].function_call.name == "get_weather"
    assert merged_contents[0].parts[0].function_call.args == {"location": "London"}


def test_convert_tools_to_gemini(google_provider):
    tools = [
        {
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "get weather",
                "parameters": {
                    "type": "object",
                    "properties": {"location": {"type": "string"}},
                },
            },
        }
    ]
    gemini_tools = google_provider._convert_tools_to_gemini(tools)
    assert len(gemini_tools) == 1
    assert gemini_tools[0].function_declarations[0].name == "get_weather"


@pytest.mark.asyncio
@respx.mock
async def test_chat_success(google_provider):
    respx.post(
        f"{google_provider.base_url}/models/gemini-1.5-flash:generateContent"
    ).mock(
        return_value=httpx.Response(
            200,
            json={
                "candidates": [
                    {
                        "content": {
                            "parts": [
                                {"text": "Hello there!"},
                                {"text": "Thinking about greeting.", "thought": True},
                            ],
                            "role": "model",
                        },
                        "finishReason": "STOP",
                        "index": 0,
                    }
                ],
                "usageMetadata": {
                    "promptTokenCount": 10,
                    "candidatesTokenCount": 20,
                    "totalTokenCount": 30,
                },
            },
        )
    )

    resp = await google_provider.chat(messages=[HumanMessage(content="hi")])

    assert isinstance(resp, AssistantMessage)
    assert resp.content == "Hello there!"
    assert resp.reasoning_content == "Thinking about greeting."


@pytest.mark.asyncio
@respx.mock
async def test_chat_rejects_response_without_candidates(google_provider):
    respx.post(
        f"{google_provider.base_url}/models/gemini-1.5-flash:generateContent"
    ).mock(return_value=httpx.Response(200, json={"promptFeedback": {}}))

    with pytest.raises(ValueError, match="no candidates"):
        await google_provider.chat(messages=[HumanMessage(content="hi")])


@pytest.mark.asyncio
@respx.mock
async def test_chat_with_tool_call(google_provider):
    respx.post(
        f"{google_provider.base_url}/models/gemini-1.5-flash:generateContent"
    ).mock(
        return_value=httpx.Response(
            200,
            json={
                "candidates": [
                    {
                        "content": {
                            "parts": [
                                {
                                    "functionCall": {
                                        "name": "get_weather",
                                        "args": {"location": "London"},
                                    }
                                }
                            ],
                            "role": "model",
                        },
                        "finishReason": "STOP",
                    }
                ],
                "usageMetadata": {
                    "promptTokenCount": 5,
                    "candidatesTokenCount": 5,
                    "totalTokenCount": 10,
                },
            },
        )
    )

    resp = await google_provider.chat(messages=[HumanMessage(content="weather?")])

    assert isinstance(resp, AssistantMessage)
    assert resp.tool_calls is not None
    assert resp.tool_calls[0].function.name == "get_weather"
    assert "London" in resp.tool_calls[0].function.arguments


@pytest.mark.asyncio
@respx.mock
async def test_stream(google_provider):
    stream_content = (
        'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}\n'
        'data: {"candidates":[{"content":{"parts":[{"text":" world!"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}\n'
    )

    respx.post(
        f"{google_provider.base_url}/models/gemini-1.5-flash:streamGenerateContent?alt=sse"
    ).mock(return_value=httpx.Response(200, content=stream_content))

    chunks = []
    async for chunk in google_provider.stream(messages=[HumanMessage(content="hi")]):
        chunks.append(chunk)

    assert len(chunks) == 2
    assert chunks[0].choices[0].delta.content == "Hello"
    assert chunks[1].choices[0].delta.content == " world!"


# ---------------------------------------------------------------------------
# Named parameter tests
# ---------------------------------------------------------------------------


def test_named_params_stored():
    provider = GoogleGenAIProvider(
        api_key="key",
        model="gemini-1.5-flash",
        max_tokens=512,
    )
    assert provider.max_tokens == 512


def test_named_params_merged_into_kwargs():
    provider = GoogleGenAIProvider(
        api_key="key",
        model="gemini-1.5-flash",
        max_tokens=256,
    )
    merged = provider._merged_kwargs()
    assert merged["max_tokens"] == 256


def test_call_kwargs_override_named_params():
    """Per-call kwargs have the highest priority."""
    provider = GoogleGenAIProvider(
        api_key="key",
        model="gemini-1.5-flash",
        max_tokens=256,
    )
    merged = provider._merged_kwargs(max_tokens=1024)
    assert merged["max_tokens"] == 1024


def test_model_kwargs_override_named_params():
    """model_kwargs override named params but are overridden by call kwargs."""
    provider = GoogleGenAIProvider(
        api_key="key",
        model="gemini-1.5-flash",
        max_tokens=100,
        model_kwargs={"max_tokens": 200, "thinking_level": "high"},
    )
    merged = provider._merged_kwargs()
    assert merged["max_tokens"] == 200
    assert merged["thinking_level"] == "high"


def test_none_named_params_not_in_merged():
    """Named params set to None must NOT appear in the merged dict."""
    provider = GoogleGenAIProvider(api_key="key", model="gemini-1.5-flash")
    merged = provider._merged_kwargs()
    assert "temperature" not in merged
    assert "top_p" not in merged
    assert "max_tokens" not in merged
    assert not hasattr(provider, "temperature")
    assert not hasattr(provider, "top_p")


# ---------------------------------------------------------------------------
# Edge cases for _convert_messages_to_gemini (lines 83-86, 89, 113-114, 117)
# ---------------------------------------------------------------------------


def test_convert_assistant_tool_call_invalid_args_json(google_provider):
    """When tool_call args is invalid JSON string, it falls back to {}."""
    messages = [
        AssistantMessage(
            content=None,
            tool_calls=[
                ToolCall(
                    id="call_1",
                    function=ChatFunctionCall(
                        name="my_tool",
                        arguments="not valid json{",
                    ),
                )
            ],
        )
    ]
    contents, _ = google_provider._convert_messages_to_gemini(messages)
    # Should not crash; args falls back to {}
    assert contents[0].parts[0].function_call.args == {}


def test_convert_assistant_tool_call_non_dict_non_str_args(google_provider):
    """When tool_call args is neither str nor dict, it falls back to {} (googlegenai.py:85-86)."""
    # Bypass Pydantic validation to inject a non-str, non-dict value for arguments
    func = ChatFunctionCall.model_construct(name="my_tool", arguments=[1, 2, 3])
    tc = ToolCall.model_construct(id="call_x", function=func)
    messages = [
        AssistantMessage.model_construct(
            role="assistant", content=None, tool_calls=[tc]
        )
    ]
    contents, _ = google_provider._convert_messages_to_gemini(messages)
    assert contents[0].parts[0].function_call.args == {}


def test_convert_assistant_tool_call_with_dict_args(google_provider):
    """When tool_call args is already a dict, it passes through."""
    messages = [
        AssistantMessage(
            content=None,
            tool_calls=[
                ToolCall(
                    id="call_1",
                    function=ChatFunctionCall(
                        name="my_tool",
                        arguments='{"key": "val"}',
                    ),
                )
            ],
        )
    ]
    contents, _ = google_provider._convert_messages_to_gemini(messages)
    assert contents[0].parts[0].function_call.args == {"key": "val"}


def test_convert_assistant_with_thought_signature(google_provider):
    """Tool call with thought and thought_signature preserved."""
    messages = [
        AssistantMessage(
            content=None,
            tool_calls=[
                ToolCall(
                    id="gemini_id_1",
                    function=ChatFunctionCall(
                        name="web_search",
                        arguments='{"q": "test"}',
                        thought="I should search",
                        thought_signature="sig123",
                    ),
                )
            ],
        )
    ]
    contents, _ = google_provider._convert_messages_to_gemini(messages)
    parts = contents[0].parts
    # Should have a thought part and a function_call part with thought_signature
    assert any(p.thought for p in parts)
    assert any(p.thought_signature == "sig123" for p in parts)


def test_convert_tool_message_invalid_json(google_provider):
    """ToolMessage with invalid JSON content falls back to dict wrapper."""
    messages = [
        ToolMessage(
            content="plain text result",
            tool_call_id="call_1",
            name="my_tool",
        )
    ]
    contents, _ = google_provider._convert_messages_to_gemini(messages)
    fr = contents[0].parts[0].function_response
    assert fr.response == {"result": "plain text result"}


def test_convert_tool_message_non_dict_json(google_provider):
    """ToolMessage whose JSON parses to a non-dict (e.g. list) gets wrapped."""
    messages = [
        ToolMessage(
            content="[1, 2, 3]",
            tool_call_id="call_1",
            name="my_tool",
        )
    ]
    contents, _ = google_provider._convert_messages_to_gemini(messages)
    fr = contents[0].parts[0].function_response
    assert fr.response == {"result": [1, 2, 3]}


def test_convert_tool_message_no_content(google_provider):
    """ToolMessage with None content gets fallback."""
    messages = [
        ToolMessage(
            content=None,
            tool_call_id="call_1",
            name="my_tool",
        )
    ]
    contents, _ = google_provider._convert_messages_to_gemini(messages)
    fr = contents[0].parts[0].function_response
    assert fr.response == {"result": "No content"}


def test_convert_assistant_reasoning_only(google_provider):
    """AssistantMessage with reasoning_content is serialized as a thought=True part."""
    messages = [AssistantMessage(content=None, reasoning_content="I'm thinking...")]
    contents, _ = google_provider._convert_messages_to_gemini(messages)
    assert contents[0].role == "model"
    part = contents[0].parts[0]
    assert part.text == "I'm thinking..."
    assert part.thought is True


def test_auth_headers(google_provider):
    """_auth_headers includes the API key."""
    headers = google_provider._auth_headers()
    assert headers == {"x-goog-api-key": "test-key"}


def test_build_url(google_provider):
    """_build_url constructs the Gemini API endpoint."""
    url = google_provider._build_url("streamGenerateContent")
    assert "gemini-1.5-flash" in url
    assert "streamGenerateContent" in url


def test_base_not_implemented():
    """GeminiProviderBase abstract methods raise NotImplementedError."""
    from app.agent.providers.googlegenai.googlegenai import GeminiProviderBase

    class Bare(GeminiProviderBase):
        model = "test"

        async def chat(self, messages, tools=None, **kw):
            raise NotImplementedError

        async def _stream_gen(self):
            return
            yield  # make it an async generator

        def stream(self, messages, tools=None, **kw):
            return self._stream_gen()

    prov = Bare()
    with pytest.raises(NotImplementedError):
        prov._auth_headers()
    with pytest.raises(NotImplementedError):
        prov._build_url("test")


def test_build_generation_config_thinking_model():
    """Thinking models get ThinkingConfig injected."""
    prov = GoogleGenAIProvider(api_key="key", model="gemini-2.0-flash-thinking")
    config = prov._build_generation_config(thinking_level="high")
    assert config.thinking_config is not None
    assert config.thinking_config.include_thoughts is True
    assert config.thinking_config.thinking_level == "high"


def test_build_generation_config_non_thinking_model():
    """No thinking_level → ThinkingConfig with no level set (model default)."""
    prov = GoogleGenAIProvider(api_key="key", model="gemini-1.5-flash")
    config = prov._build_generation_config()
    assert config.thinking_config is not None
    assert config.thinking_config.include_thoughts is True
    assert config.thinking_config.thinking_level is None


def test_build_generation_config_thinking_level_none():
    """thinking_level='none' disables ThinkingConfig entirely."""
    prov = GoogleGenAIProvider(api_key="key", model="gemini-2.0-flash")
    config = prov._build_generation_config(thinking_level="none")
    assert config.thinking_config is None


# ---------------------------------------------------------------------------
# stream() — empty candidates skipped (line 283-284)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_stream_skips_empty_candidates(google_provider):
    """SSE events with no candidates are silently skipped."""
    stream_content = (
        # Event with empty candidates array
        'data: {"candidates":[],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":0,"totalTokenCount":1}}\n'
        # Event with actual content
        'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}\n'
    )

    respx.post(
        f"{google_provider.base_url}/models/gemini-1.5-flash:streamGenerateContent?alt=sse"
    ).mock(return_value=httpx.Response(200, content=stream_content))

    chunks = []
    async for chunk in google_provider.stream(messages=[HumanMessage(content="hi")]):
        chunks.append(chunk)

    # Only the second event produces a chunk; the empty-candidates event is skipped
    assert len(chunks) == 1
    assert chunks[0].choices[0].delta.content == "Hello"


# ---------------------------------------------------------------------------
# stream() — reasoning in thought part (lines 292-294)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_stream_reasoning_part(google_provider):
    """SSE events with thought=True parts populate delta reasoning_content."""
    stream_content = (
        'data: {"candidates":[{"content":{"parts":[{"text":"thinking...","thought":true}],"role":"model"},"finishReason":"STOP"}],'
        '"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}\n'
    )

    respx.post(
        f"{google_provider.base_url}/models/gemini-1.5-flash:streamGenerateContent?alt=sse"
    ).mock(return_value=httpx.Response(200, content=stream_content))

    chunks = []
    async for chunk in google_provider.stream(messages=[HumanMessage(content="hi")]):
        chunks.append(chunk)

    assert len(chunks) == 1
    assert chunks[0].choices[0].delta.reasoning_content == "thinking..."


# ---------------------------------------------------------------------------
# stream() — tool call with no id (lines 298-309)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_stream_tool_call_without_id(google_provider):
    """Tool call parts without an id get an auto-generated id."""
    stream_content = (
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"web_search","args":{"q":"hello"}}}],"role":"model"},"finishReason":"STOP"}],'
        '"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":2,"totalTokenCount":4}}\n'
    )

    respx.post(
        f"{google_provider.base_url}/models/gemini-1.5-flash:streamGenerateContent?alt=sse"
    ).mock(return_value=httpx.Response(200, content=stream_content))

    chunks = []
    async for chunk in google_provider.stream(messages=[HumanMessage(content="hi")]):
        chunks.append(chunk)

    assert len(chunks) == 1
    tc_delta = chunks[0].choices[0].delta.tool_calls
    assert tc_delta is not None and len(tc_delta) == 1
    # id should be auto-generated since function_call.id is None
    assert tc_delta[0].id.startswith("call_web_search_")


# ---------------------------------------------------------------------------
# stream() — stable tool-call index across chunks
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_stream_tool_call_index_stable_when_parts_shift(google_provider):
    """Regression: the same function_call id must keep the same index even
    when its part position shifts between chunks (e.g. a thought part appears
    in a later chunk and pushes the function_call down by one slot).

    Without a stable id→index map, the agent_loop tool_calls_buffer treats
    the second chunk's delta as a NEW slot and the publisher hook emits a
    second, never-completed tool_call SSE event.
    """
    # First chunk: one function_call at part index 0.
    chunk_a = (
        'data: {"candidates":[{"content":{"parts":['
        '{"functionCall":{"id":"fc-A","name":"read","args":{}}}'
        "]}}]}\n"
    )
    # Second chunk: thought part at 0 pushes the same function_call to 1.
    chunk_b = (
        'data: {"candidates":[{"content":{"parts":['
        '{"thought":true,"text":"pondering"},'
        '{"functionCall":{"id":"fc-A","name":"read","args":{"path":"x"}}}'
        "]}}]}\n"
    )

    respx.post(
        f"{google_provider.base_url}/models/gemini-1.5-flash:streamGenerateContent?alt=sse"
    ).mock(return_value=httpx.Response(200, content=chunk_a + chunk_b))

    chunks = []
    async for chunk in google_provider.stream(messages=[HumanMessage(content="hi")]):
        chunks.append(chunk)

    # Me both chunks must emit the tool_call at the SAME index (0),
    # regardless of where the function_call sat within parts.
    tc_a = chunks[0].choices[0].delta.tool_calls
    tc_b = chunks[1].choices[0].delta.tool_calls
    assert tc_a is not None and len(tc_a) == 1
    assert tc_b is not None and len(tc_b) == 1
    assert tc_a[0].id == "fc-A"
    assert tc_b[0].id == "fc-A"
    assert tc_a[0].index == tc_b[0].index == 0


@pytest.mark.asyncio
@respx.mock
async def test_stream_parallel_tool_calls_get_distinct_stable_indices(google_provider):
    """Two different tool-call ids get distinct, monotonic indices."""
    chunk = (
        'data: {"candidates":[{"content":{"parts":['
        '{"functionCall":{"id":"fc-A","name":"read","args":{}}},'
        '{"functionCall":{"id":"fc-B","name":"write","args":{}}}'
        "]}}]}\n"
    )
    respx.post(
        f"{google_provider.base_url}/models/gemini-1.5-flash:streamGenerateContent?alt=sse"
    ).mock(return_value=httpx.Response(200, content=chunk))

    chunks = []
    async for c in google_provider.stream(messages=[HumanMessage(content="hi")]):
        chunks.append(c)

    tcs = chunks[0].choices[0].delta.tool_calls
    assert tcs is not None and len(tcs) == 2
    # Me first-seen → 0, next → 1
    assert tcs[0].id == "fc-A" and tcs[0].index == 0
    assert tcs[1].id == "fc-B" and tcs[1].index == 1


@pytest.mark.asyncio
@respx.mock
async def test_stream_tool_call_without_id_gets_fallback_index(google_provider):
    """A function_call with id=None gets a fallback id and stable index."""
    chunk = (
        'data: {"candidates":[{"content":{"parts":['
        '{"functionCall":{"id":null,"name":"read","args":{}}},'
        '{"functionCall":{"id":"fc-B","name":"write","args":{}}}'
        "]}}]}\n"
    )
    respx.post(
        f"{google_provider.base_url}/models/gemini-1.5-flash:streamGenerateContent?alt=sse"
    ).mock(return_value=httpx.Response(200, content=chunk))

    chunks = []
    async for c in google_provider.stream(messages=[HumanMessage(content="hi")]):
        chunks.append(c)

    tcs = chunks[0].choices[0].delta.tool_calls
    assert tcs is not None and len(tcs) == 2
    # Me first tool call (no id) gets fallback and index 0
    assert tcs[0].id.startswith("call_read_")
    assert tcs[0].index == 0
    # Me second tool call gets index 1
    assert tcs[1].id == "fc-B" and tcs[1].index == 1


@pytest.mark.asyncio
@respx.mock
async def test_stream_empty_stream_no_tool_calls(google_provider):
    """An empty stream (no tool calls) doesn't crash."""
    chunk = 'data: {"candidates":[{"content":{"parts":[{"text":"hello"}]}}]}\n'
    respx.post(
        f"{google_provider.base_url}/models/gemini-1.5-flash:streamGenerateContent?alt=sse"
    ).mock(return_value=httpx.Response(200, content=chunk))

    chunks = []
    async for c in google_provider.stream(messages=[HumanMessage(content="hi")]):
        chunks.append(c)

    # Me should have one chunk with text but no tool calls
    assert len(chunks) == 1
    assert chunks[0].choices[0].delta.content == "hello"
    assert (
        chunks[0].choices[0].delta.tool_calls is None
        or len(chunks[0].choices[0].delta.tool_calls) == 0
    )


@pytest.mark.asyncio
@respx.mock
async def test_stream_tool_idx_resets_per_stream_call(google_provider):
    """tool_idx_by_id is scoped to a single stream() call and resets on new stream."""
    chunk_a = (
        'data: {"candidates":[{"content":{"parts":['
        '{"functionCall":{"id":"fc-A","name":"read","args":{}}}'
        "]}}]}\n"
    )
    chunk_b = (
        'data: {"candidates":[{"content":{"parts":['
        '{"functionCall":{"id":"fc-B","name":"write","args":{}}}'
        "]}}]}\n"
    )
    respx.post(
        f"{google_provider.base_url}/models/gemini-1.5-flash:streamGenerateContent?alt=sse"
    ).mock(return_value=httpx.Response(200, content=chunk_a))

    # Me first stream: fc-A gets index 0
    chunks1 = []
    async for c in google_provider.stream(messages=[HumanMessage(content="hi")]):
        chunks1.append(c)
    assert chunks1[0].choices[0].delta.tool_calls[0].index == 0

    # Me second stream: reset tool_idx_by_id, so fc-B also gets index 0
    respx.post(
        f"{google_provider.base_url}/models/gemini-1.5-flash:streamGenerateContent?alt=sse"
    ).mock(return_value=httpx.Response(200, content=chunk_b))
    chunks2 = []
    async for c in google_provider.stream(messages=[HumanMessage(content="hi")]):
        chunks2.append(c)
    assert chunks2[0].choices[0].delta.tool_calls[0].index == 0


# ---------------------------------------------------------------------------
# _convert_messages_to_gemini — empty AssistantMessage placeholder (line 112)
# ---------------------------------------------------------------------------


def test_convert_assistant_empty_is_skipped(google_provider):
    """AssistantMessage with no content/tool_calls/reasoning is dropped from history."""
    messages = [AssistantMessage(content=None)]
    contents, _ = google_provider._convert_messages_to_gemini(messages)
    assert contents == []


# ---------------------------------------------------------------------------
# stream() — 4xx error body logging (lines 282-283)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_stream_logs_error_body_on_4xx(google_provider):
    """A 4xx response body is read and logged before raising."""
    respx.post(
        f"{google_provider.base_url}/models/gemini-1.5-flash:streamGenerateContent?alt=sse"
    ).mock(
        return_value=httpx.Response(400, content=b'{"error":{"message":"bad request"}}')
    )

    with pytest.raises(httpx.HTTPStatusError):
        async for _ in google_provider.stream(messages=[HumanMessage(content="hi")]):
            pass


# ---------------------------------------------------------------------------
# _build_generation_config — Gemma disables ThinkingConfig
# ---------------------------------------------------------------------------


def test_build_generation_config_gemma_disables_thinking():
    """Gemma models always omit ThinkingConfig regardless of thinking_level."""
    prov = GoogleGenAIProvider(api_key="key", model="gemma-4-31b-it")
    config = prov._build_generation_config(thinking_level="high")
    assert config.thinking_config is None


# ---------------------------------------------------------------------------
# _convert_messages_to_gemini — multimodal HumanMessage (lines 76-110)
# ---------------------------------------------------------------------------


class TestGeminiMultimodalConversion:
    @pytest.fixture
    def prov(self):
        return GoogleGenAIProvider(api_key="test-key", model="gemini-3.1-flash")

    def test_text_block_in_parts(self, prov):
        msg = HumanMessage(content="hi", parts=[TextBlock(text="text part")])
        contents, _ = prov._convert_messages_to_gemini([msg])
        assert len(contents) == 1
        assert contents[0].parts[0].text == "text part"

    def test_image_data_block(self, prov):
        msg = HumanMessage(
            content="",
            parts=[ImageDataBlock(data="abc123", media_type="image/jpeg")],
        )
        contents, _ = prov._convert_messages_to_gemini([msg])
        inline = contents[0].parts[0].inline_data
        assert inline.mime_type == "image/jpeg"
        assert inline.data == "abc123"

    def test_image_url_block_http_url(self, prov):
        """HTTP/HTTPS URLs go via file_data."""
        msg = HumanMessage(
            content="",
            parts=[
                ImageUrlBlock(
                    url="https://example.com/img.jpg", media_type="image/jpeg"
                )
            ],
        )
        contents, _ = prov._convert_messages_to_gemini([msg])
        file_data = contents[0].parts[0].file_data
        assert file_data.mime_type == "image/jpeg"
        assert file_data.file_uri == "https://example.com/img.jpg"

    def test_image_url_block_data_uri(self, prov):
        """data: URIs are parsed and sent as inline_data."""
        data_uri = "data:image/png;base64,iVBORw0KGgo="
        msg = HumanMessage(
            content="",
            parts=[ImageUrlBlock(url=data_uri)],
        )
        contents, _ = prov._convert_messages_to_gemini([msg])
        inline = contents[0].parts[0].inline_data
        assert inline.mime_type == "image/png"
        assert inline.data == "iVBORw0KGgo="

    def test_image_url_block_http_no_media_type_defaults_to_jpeg(self, prov):
        """ImageUrlBlock without media_type defaults to image/jpeg for HTTP URLs."""
        msg = HumanMessage(
            content="",
            parts=[ImageUrlBlock(url="https://example.com/photo.jpg")],
        )
        contents, _ = prov._convert_messages_to_gemini([msg])
        file_data = contents[0].parts[0].file_data
        assert file_data.mime_type == "image/jpeg"

    def test_mixed_text_and_image_parts(self, prov):
        msg = HumanMessage(
            content="describe",
            parts=[
                TextBlock(text="describe"),
                ImageDataBlock(data="b64", media_type="image/png"),
            ],
        )
        contents, _ = prov._convert_messages_to_gemini([msg])
        assert len(contents[0].parts) == 2


# ---------------------------------------------------------------------------
# stream() — Gemini re-emission: full args snapshot repeated across chunks
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_stream_tool_call_args_not_duplicated_on_re_emission(google_provider):
    """Each Gemini SSE chunk is a full snapshot, not a delta.

    The same function_call (same id, same args) is re-emitted verbatim in
    every subsequent chunk.  The provider must emit args only on the first
    chunk for each tool call id so the generic accumulator in streaming.py
    receives exactly one copy and produces valid JSON.
    """
    # Two SSE chunks both carrying the complete function_call snapshot.
    stream_content = (
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"search","args":{"q":"test"},"id":"tc1"}}],"role":"model"},"finishReason":null}],'
        '"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":2,"totalTokenCount":4}}\n'
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"search","args":{"q":"test"},"id":"tc1"}}],"role":"model"},"finishReason":"STOP"}],'
        '"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":4,"totalTokenCount":6}}\n'
    )

    respx.post(
        f"{google_provider.base_url}/models/gemini-1.5-flash:streamGenerateContent?alt=sse"
    ).mock(return_value=httpx.Response(200, content=stream_content))

    chunks = []
    async for chunk in google_provider.stream(
        messages=[HumanMessage(content="search")]
    ):
        chunks.append(chunk)

    assert len(chunks) == 2

    # First chunk: name + args emitted normally.
    tc0 = chunks[0].choices[0].delta.tool_calls
    assert tc0 is not None and len(tc0) == 1
    assert tc0[0].function.name == "search"
    assert tc0[0].function.arguments == '{"q": "test"}'

    # Second chunk: same id re-emitted — name and args must be suppressed.
    tc1 = chunks[1].choices[0].delta.tool_calls
    assert tc1 is not None and len(tc1) == 1
    assert tc1[0].id == "tc1"
    assert tc1[0].function.name is None
    assert tc1[0].function.arguments is None


# ---------------------------------------------------------------------------
# FunctionCall.args — missing args key from Gemini for zero-arg tools
# ---------------------------------------------------------------------------


def test_function_call_args_defaults_to_empty_dict_when_missing():
    """Regression: Gemini omits 'args' when a tool takes no arguments.

    Previously FunctionCall.args was a required field, so model_validate()
    raised a ValidationError for zero-arg tool calls like 'ls' or 'date'.
    """
    fc = FunctionCall.model_validate({"name": "ls", "id": "call_abc"})
    assert fc.name == "ls"
    assert fc.args == {}
    assert fc.id == "call_abc"


def test_gemini_response_parse_function_call_without_args():
    """Regression: GeminiChatResponse.model_validate() must not raise when
    a functionCall part has no 'args' key (zero-arg tool, e.g. ls, date).
    """
    data = {
        "candidates": [
            {
                "content": {
                    "role": "model",
                    "parts": [
                        {
                            "functionCall": {
                                "name": "ls",
                                "id": "call_xyz",
                                # no 'args' key — Gemini omits it for zero-arg tools
                            }
                        }
                    ],
                },
                "finishReason": "STOP",
            }
        ],
        "usageMetadata": {
            "promptTokenCount": 10,
            "candidatesTokenCount": 5,
            "totalTokenCount": 15,
        },
    }
    resp = GeminiChatResponse.model_validate(data)
    fc = resp.candidates[0].content.parts[0].function_call
    assert fc is not None
    assert fc.name == "ls"
    assert fc.args == {}


@pytest.mark.asyncio
@respx.mock
async def test_stream_zero_arg_tool_call(google_provider):
    """Regression: streaming a tool call with no args must not raise.

    Gemini omits the 'args' key entirely when calling a zero-argument tool.
    The stream() path hits GeminiChatResponse.model_validate() on each SSE
    chunk, so it raised the same ValidationError as the non-streaming path.
    """
    stream_content = (
        'data: {"candidates":[{"content":{"parts":['
        '{"functionCall":{"name":"ls","id":"call_ls1"}}'
        '],"role":"model"},"finishReason":"STOP"}],'
        '"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3,"totalTokenCount":8}}\n'
    )

    respx.post(
        f"{google_provider.base_url}/models/gemini-1.5-flash:streamGenerateContent?alt=sse"
    ).mock(return_value=httpx.Response(200, content=stream_content))

    chunks = []
    async for chunk in google_provider.stream(messages=[HumanMessage(content="list")]):
        chunks.append(chunk)

    assert len(chunks) == 1
    tc_delta = chunks[0].choices[0].delta.tool_calls
    assert tc_delta is not None and len(tc_delta) == 1
    assert tc_delta[0].function.name == "ls"
    assert tc_delta[0].function.arguments == "{}"


# ---------------------------------------------------------------------------
# thoughtSignature round-trip for thought parts (implicit caching / history)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_chat_captures_thought_signature_from_thought_part(google_provider):
    """_parse_response must capture thoughtSignature from thought parts and
    store it on AssistantMessage.reasoning_signature + extra so it can be
    round-tripped in subsequent requests for implicit caching."""
    respx.post(
        f"{google_provider.base_url}/models/gemini-1.5-flash:generateContent"
    ).mock(
        return_value=httpx.Response(
            200,
            json={
                "candidates": [
                    {
                        "content": {
                            "parts": [
                                {
                                    "text": "I'm reasoning here.",
                                    "thought": True,
                                    "thoughtSignature": "opaque-sig-xyz",
                                },
                                {"text": "The answer is 42."},
                            ],
                            "role": "model",
                        },
                        "finishReason": "STOP",
                    }
                ],
                "usageMetadata": {
                    "promptTokenCount": 10,
                    "candidatesTokenCount": 20,
                    "totalTokenCount": 30,
                },
            },
        )
    )

    resp = await google_provider.chat(messages=[HumanMessage(content="hi")])

    assert resp.reasoning_content == "I'm reasoning here."
    assert resp.reasoning_signature == "opaque-sig-xyz"
    assert resp.extra is not None
    assert resp.extra.get("reasoning_signature") == "opaque-sig-xyz"


def test_convert_messages_emits_thought_signature_on_thought_part(google_provider):
    """When an AssistantMessage carries reasoning_signature, the thought Part
    re-emitted during history reconstruction must include thoughtSignature so
    Gemini can resolve implicit cache hits on the thought."""
    messages = [
        AssistantMessage(
            content="The answer is 42.",
            reasoning_content="I'm reasoning here.",
            reasoning_signature="opaque-sig-xyz",
        )
    ]
    contents, _ = google_provider._convert_messages_to_gemini(messages)

    model_turn = contents[0]
    thought_parts = [p for p in model_turn.parts if p.thought]
    assert len(thought_parts) == 1
    assert thought_parts[0].text == "I'm reasoning here."
    assert thought_parts[0].thought_signature == "opaque-sig-xyz"


def test_convert_messages_thought_part_no_signature_when_absent(google_provider):
    """AssistantMessage without reasoning_signature must still emit the thought
    Part — just without thoughtSignature (pre-fix rows / non-thinking turns)."""
    messages = [
        AssistantMessage(
            content="answer",
            reasoning_content="thoughts",
            reasoning_signature=None,
        )
    ]
    contents, _ = google_provider._convert_messages_to_gemini(messages)

    thought_parts = [p for p in contents[0].parts if p.thought]
    assert len(thought_parts) == 1
    assert thought_parts[0].thought_signature is None


@pytest.mark.asyncio
@respx.mock
async def test_stream_captures_thought_signature(google_provider):
    """Streaming: thoughtSignature on a thought Part must surface as
    reasoning_signature on the ChatCompletionDelta chunk."""
    stream_content = (
        'data: {"candidates":[{"content":{"parts":['
        '{"text":"deep thought","thought":true,"thoughtSignature":"stream-sig-abc"}'
        '],"role":"model"},"finishReason":"STOP"}],'
        '"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":5,"totalTokenCount":6}}\n'
    )

    respx.post(
        f"{google_provider.base_url}/models/gemini-1.5-flash:streamGenerateContent?alt=sse"
    ).mock(return_value=httpx.Response(200, content=stream_content))

    chunks = []
    async for chunk in google_provider.stream(messages=[HumanMessage(content="hi")]):
        chunks.append(chunk)

    assert len(chunks) == 1
    delta = chunks[0].choices[0].delta
    assert delta.reasoning_content == "deep thought"
    assert delta.reasoning_signature == "stream-sig-abc"


@pytest.mark.asyncio
@respx.mock
async def test_googlegenai_service_tier_mapping(google_provider):
    import json

    respx.post(
        f"{google_provider.base_url}/models/gemini-1.5-flash:generateContent"
    ).mock(
        return_value=httpx.Response(
            200, json={"candidates": [{"content": {"parts": [{"text": "hello"}]}}]}
        )
    )

    await google_provider.chat(
        messages=[HumanMessage(content="hi")],
        service_tier="fast",
    )

    request = respx.calls.last.request
    body = json.loads(request.read())
    assert body["serviceTier"] == "priority"
