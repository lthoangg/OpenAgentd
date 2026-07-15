import httpx
import pytest
import respx
from app.agent.providers.openai import OpenAIProvider
from app.agent.providers.zai.zai import ZAI_API_BASE, ZAIProvider
from app.agent.schemas.chat import AssistantMessage, HumanMessage


# ---------------------------------------------------------------------------
# Class hierarchy
# ---------------------------------------------------------------------------


class TestZAIProviderInheritance:
    """ZAIProvider must be a subclass of OpenAIProvider."""

    def test_zai_provider_is_subclass_of_openai_provider(self):
        assert issubclass(ZAIProvider, OpenAIProvider)

    def test_zai_api_base_constant(self):
        assert ZAI_API_BASE == "https://api.z.ai/api/paas/v4"


# ---------------------------------------------------------------------------
# Constructor
# ---------------------------------------------------------------------------


def test_missing_api_key_raises():
    with pytest.raises(ValueError, match="API key is required"):
        ZAIProvider(api_key="", model="m")


def test_secret_str_api_key():
    from pydantic import SecretStr

    prov = ZAIProvider(api_key=SecretStr("secret"), model="m")
    assert prov.api_key == "secret"


def test_base_url_points_at_zai():
    prov = ZAIProvider(api_key="k", model="m")
    assert prov.base_url == ZAI_API_BASE


# ---------------------------------------------------------------------------
# chat()
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_chat_success(zai_provider):
    route = respx.post("https://api.z.ai/api/paas/v4/chat/completions").mock(
        return_value=httpx.Response(
            200,
            json={
                "id": "1",
                "object": "chat.completion",
                "created": 1,
                "model": "m",
                "choices": [
                    {"index": 0, "message": {"role": "assistant", "content": "hi"}}
                ],
                "usage": {
                    "prompt_tokens": 1,
                    "completion_tokens": 1,
                    "total_tokens": 2,
                },
            },
        )
    )

    resp = await zai_provider.chat(messages=[HumanMessage(content="hi")])
    assert isinstance(resp, AssistantMessage)
    assert resp.content == "hi"
    assert route.called


@pytest.mark.asyncio
@respx.mock
async def test_chat_with_tools(zai_provider):
    """chat() passes tools in the payload."""
    route = respx.post("https://api.z.ai/api/paas/v4/chat/completions").mock(
        return_value=httpx.Response(
            200,
            json={
                "id": "1",
                "object": "chat.completion",
                "created": 1,
                "model": "m",
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": "tc1",
                                    "type": "function",
                                    "function": {
                                        "name": "search",
                                        "arguments": '{"q": "test"}',
                                    },
                                }
                            ],
                        },
                    }
                ],
            },
        )
    )

    tools = [{"type": "function", "function": {"name": "search"}}]
    resp = await zai_provider.chat(
        messages=[HumanMessage(content="search")], tools=tools
    )
    assert resp.tool_calls is not None
    assert resp.tool_calls[0].function.name == "search"
    # Verify tools were sent in the request
    sent = route.calls[0].request.content
    assert b'"tools"' in sent


@pytest.mark.asyncio
@respx.mock
async def test_chat_empty_choices(zai_provider):
    """Empty choices returns AssistantMessage with content=None."""
    respx.post("https://api.z.ai/api/paas/v4/chat/completions").mock(
        return_value=httpx.Response(
            200,
            json={
                "id": "1",
                "object": "chat.completion",
                "created": 1,
                "model": "m",
                "choices": [],
            },
        )
    )
    resp = await zai_provider.chat(messages=[HumanMessage(content="hi")])
    assert resp.content is None


# ---------------------------------------------------------------------------
# stream()
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_stream(zai_provider):
    stream_content = (
        'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"}}]}\n'
        "data: [DONE]\n"
    )
    respx.post("https://api.z.ai/api/paas/v4/chat/completions").mock(
        return_value=httpx.Response(200, content=stream_content)
    )

    chunks = []
    async for chunk in zai_provider.stream(messages=[HumanMessage(content="hi")]):
        chunks.append(chunk)

    assert len(chunks) == 1
    assert chunks[0].choices[0].delta.content == "hi"


@pytest.mark.asyncio
@respx.mock
async def test_stream_with_tools(zai_provider):
    """stream() passes tools and parses tool_calls in delta."""
    stream_content = (
        'data: {"id":"1","created":1,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"tc1","function":{"name":"search","arguments":"{\\"q\\": \\"test\\"}"}}]}}]}\n'
        "data: [DONE]\n"
    )
    route = respx.post("https://api.z.ai/api/paas/v4/chat/completions").mock(
        return_value=httpx.Response(200, content=stream_content)
    )

    tools = [{"type": "function", "function": {"name": "search"}}]
    chunks = []
    async for chunk in zai_provider.stream(
        messages=[HumanMessage(content="hi")], tools=tools
    ):
        chunks.append(chunk)

    assert len(chunks) == 1
    tc = chunks[0].choices[0].delta.tool_calls
    assert tc is not None
    assert tc[0].function.name == "search"
    assert b'"tools"' in route.calls[0].request.content


@pytest.mark.asyncio
@respx.mock
async def test_stream_empty_choices_skipped(zai_provider):
    """Chunks with empty choices are skipped."""
    stream_content = (
        'data: {"id":"1","created":1,"model":"m","choices":[]}\n'
        'data: {"id":"2","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"ok"}}]}\n'
        "data: [DONE]\n"
    )
    respx.post("https://api.z.ai/api/paas/v4/chat/completions").mock(
        return_value=httpx.Response(200, content=stream_content)
    )

    chunks = []
    async for chunk in zai_provider.stream(messages=[HumanMessage(content="hi")]):
        chunks.append(chunk)

    assert len(chunks) == 1
    assert chunks[0].choices[0].delta.content == "ok"


# ---------------------------------------------------------------------------
# Usage extraction (delegated to CompletionsHandler — smoke-tested here)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_stream_usage_with_nested_cached_and_reasoning_tokens(zai_provider):
    """cached_tokens and reasoning_tokens extracted from nested usage fields."""
    stream_content = (
        'data: {"id":"1","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"}}],'
        '"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,'
        '"prompt_tokens_details":{"cached_tokens":3},'
        '"completion_tokens_details":{"reasoning_tokens":8}}}\n'
        "data: [DONE]\n"
    )
    respx.post("https://api.z.ai/api/paas/v4/chat/completions").mock(
        return_value=httpx.Response(200, content=stream_content)
    )

    chunks = []
    async for chunk in zai_provider.stream(messages=[HumanMessage(content="hi")]):
        chunks.append(chunk)

    # Last chunk carries the usage payload.
    usage_chunks = [c for c in chunks if c.usage is not None]
    assert len(usage_chunks) == 1
    assert usage_chunks[0].usage.cached_tokens == 3
    assert usage_chunks[0].usage.thoughts_tokens == 8


# ---------------------------------------------------------------------------
# customize_thinking — the one true ZAI behavioural difference
# ---------------------------------------------------------------------------


_OK_RESPONSE = {
    "id": "1",
    "object": "chat.completion",
    "created": 1,
    "model": "m",
    "choices": [
        {
            "index": 0,
            "message": {"role": "assistant", "content": "ok"},
        }
    ],
}


@pytest.mark.asyncio
@respx.mock
async def test_thinking_level_none_sends_thinking_disabled():
    """thinking_level='none' must send thinking={"type":"disabled"} (not reasoning_effort)."""
    import json

    route = respx.post("https://api.z.ai/api/paas/v4/chat/completions").mock(
        return_value=httpx.Response(200, json=_OK_RESPONSE)
    )

    prov = ZAIProvider(api_key="k", model="m", model_kwargs={"thinking_level": "none"})
    await prov.chat(messages=[HumanMessage(content="hi")])

    body = json.loads(route.calls[0].request.content)
    assert body["thinking"] == {"type": "disabled"}
    assert "reasoning_effort" not in body


@pytest.mark.asyncio
@respx.mock
async def test_thinking_level_high_does_not_send_reasoning_effort():
    """ZAI never sends reasoning_effort — even with non-none thinking_level."""
    import json

    route = respx.post("https://api.z.ai/api/paas/v4/chat/completions").mock(
        return_value=httpx.Response(200, json=_OK_RESPONSE)
    )

    prov = ZAIProvider(api_key="k", model="m", model_kwargs={"thinking_level": "high"})
    await prov.chat(messages=[HumanMessage(content="hi")])

    body = json.loads(route.calls[0].request.content)
    assert "reasoning_effort" not in body
    assert "thinking" not in body


@pytest.mark.asyncio
@respx.mock
async def test_no_thinking_level_sends_neither_field():
    """Default request omits both thinking and reasoning_effort."""
    import json

    route = respx.post("https://api.z.ai/api/paas/v4/chat/completions").mock(
        return_value=httpx.Response(200, json=_OK_RESPONSE)
    )

    prov = ZAIProvider(api_key="k", model="m")
    await prov.chat(messages=[HumanMessage(content="hi")])

    body = json.loads(route.calls[0].request.content)
    assert "thinking" not in body
    assert "reasoning_effort" not in body


@pytest.mark.asyncio
@respx.mock
async def test_max_tokens_uses_zai_legacy_field():
    """Z.AI's Chat Completions API accepts max_tokens, not its OpenAI successor."""
    import json

    route = respx.post("https://api.z.ai/api/paas/v4/chat/completions").mock(
        return_value=httpx.Response(200, json=_OK_RESPONSE)
    )

    prov = ZAIProvider(api_key="k", model="m", max_tokens=123)
    await prov.chat(messages=[HumanMessage(content="hi")])

    body = json.loads(route.calls[0].request.content)
    assert body["max_tokens"] == 123
    assert "max_completion_tokens" not in body


@pytest.mark.asyncio
@respx.mock
async def test_tool_choice_none_is_omitted_for_zai():
    """Z.AI's function-calling API only accepts tool_choice='auto'."""
    import json

    route = respx.post("https://api.z.ai/api/paas/v4/chat/completions").mock(
        return_value=httpx.Response(200, json=_OK_RESPONSE)
    )

    prov = ZAIProvider(api_key="k", model="m", model_kwargs={"tool_choice": "none"})
    await prov.chat(
        messages=[HumanMessage(content="hi")],
        tools=[{"type": "function", "function": {"name": "search"}}],
    )

    body = json.loads(route.calls[0].request.content)
    assert "tool_choice" not in body
