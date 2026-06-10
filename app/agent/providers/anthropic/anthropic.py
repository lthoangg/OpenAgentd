from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator
from typing import Any

import httpx
from pydantic.types import SecretStr

from app.agent.providers.base import LLMProviderBase
from app.agent.schemas.chat import (
    AssistantMessage,
    ChatCompletionChunk,
    ChatCompletionChunkChoice,
    ChatCompletionDelta,
    ChatMessage,
    FunctionCall,
    FunctionCallDelta,
    HumanMessage,
    SystemMessage,
    ToolCall,
    ToolCallDelta,
    ToolMessage,
    Usage,
)

ANTHROPIC_API_BASE = "https://api.anthropic.com"
ANTHROPIC_API_VERSION = "2023-06-01"
ANTHROPIC_MODELS = [
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
]


def _resolve_secret(value: str | SecretStr) -> str:
    return value.get_secret_value() if isinstance(value, SecretStr) else value


def _headers(
    api_key: str,
    extra: dict[str, str] | None = None,
    *,
    use_api_key_header: bool = True,
) -> dict[str, str]:
    headers = {
        "anthropic-version": ANTHROPIC_API_VERSION,
        "content-type": "application/json",
        **(extra or {}),
    }
    if use_api_key_header:
        headers["x-api-key"] = api_key
    return headers


def _split_messages(
    messages: list[ChatMessage],
) -> tuple[str | None, list[dict[str, Any]]]:
    system_parts: list[str] = []
    out: list[dict[str, Any]] = []
    for message in messages:
        if isinstance(message, SystemMessage):
            if message.content:
                system_parts.append(message.content)
            continue
        if isinstance(message, HumanMessage):
            out.append({"role": "user", "content": message.content or ""})
        elif isinstance(message, AssistantMessage) and message.tool_calls:
            blocks: list[dict[str, Any]] = []
            if message.content:
                blocks.append({"type": "text", "text": message.content})
            for tool_call in message.tool_calls:
                blocks.append(
                    {
                        "type": "tool_use",
                        "id": tool_call.id,
                        "name": tool_call.function.name,
                        "input": json.loads(tool_call.function.arguments or "{}"),
                    }
                )
            out.append({"role": "assistant", "content": blocks})
        elif isinstance(message, AssistantMessage):
            out.append({"role": "assistant", "content": message.content or ""})
        elif isinstance(message, ToolMessage):
            out.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": message.tool_call_id,
                            "content": message.content or "",
                        }
                    ],
                }
            )
    return "\n\n".join(system_parts) or None, out


def _anthropic_tools(tools: list[dict] | None) -> list[dict[str, Any]] | None:
    if not tools:
        return None
    converted: list[dict[str, Any]] = []
    for tool in tools:
        function = tool.get("function") if isinstance(tool, dict) else None
        if not isinstance(function, dict):
            continue
        converted.append(
            {
                "name": str(function.get("name", "")),
                "description": function.get("description", ""),
                "input_schema": function.get("parameters")
                or {"type": "object", "properties": {}},
            }
        )
    return converted or None


def _supports_legacy_sampling(model: str) -> bool:
    return not any(marker in model for marker in ("-4-5", "-4-6", "-4-7"))


def _thinking_budget(level: str, max_tokens: int) -> int:
    ratios = {"low": 0.25, "medium": 0.4, "high": 0.6, "xhigh": 0.75, "max": 0.8}
    budget = int(max_tokens * ratios.get(level, 0.4))
    return max(1024, min(budget, max_tokens - 1))


def _supports_adaptive_thinking(model: str) -> bool:
    return any(
        marker in model for marker in ("opus-4-6", "opus-4-7", "opus-4-8", "sonnet-4-6")
    )


def _apply_thinking(
    model: str, kwargs: dict[str, Any], payload: dict[str, Any]
) -> bool:
    level = str(kwargs.pop("thinking_level", "") or "").lower()
    if not level or level in {"none", "off"}:
        return False
    if _supports_adaptive_thinking(model):
        payload["thinking"] = {"type": "adaptive", "display": "summarized"}
        payload["output_config"] = {"effort": level}
        return True
    max_tokens = int(payload["max_tokens"])
    payload["thinking"] = {
        "type": "enabled",
        "budget_tokens": _thinking_budget(level, max_tokens),
        "display": "summarized",
    }
    return True


def _add_sampling(
    model: str, kwargs: dict[str, Any], payload: dict[str, Any], *, thinking: bool
) -> None:
    if not _supports_legacy_sampling(model):
        return
    if not thinking:
        for name in ("temperature", "top_p"):
            if name in kwargs and kwargs[name] is not None:
                payload[name] = kwargs[name]
        return
    top_p = kwargs.get("top_p")
    if (
        isinstance(top_p, (int, float))
        and not isinstance(top_p, bool)
        and 0.95 <= top_p <= 1
    ):
        payload["top_p"] = top_p


def _finish_reason(stop_reason: str | None) -> str | None:
    return "tool_calls" if stop_reason == "tool_use" else stop_reason


def _stream_chunk(
    *,
    chunk_id: str,
    model: str,
    delta: ChatCompletionDelta,
    usage: Usage | None = None,
    finish_reason: str | None = None,
) -> ChatCompletionChunk:
    return ChatCompletionChunk(
        id=chunk_id,
        created=int(time.time()),
        model=model,
        choices=[
            ChatCompletionChunkChoice(index=0, delta=delta, finish_reason=finish_reason)
        ],
        usage=usage,
    )


class AnthropicProvider(LLMProviderBase):
    def __init__(
        self,
        *,
        api_key: str | SecretStr,
        model: str,
        base_url: str = ANTHROPIC_API_BASE,
        headers: dict[str, str] | None = None,
        use_api_key_header: bool = True,
        beta: bool = False,
        temperature: float | None = None,
        top_p: float | None = None,
        max_tokens: int | None = None,
        timeout: float | httpx.Timeout | None = 120,
        model_kwargs: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(
            temperature=temperature,
            top_p=top_p,
            max_tokens=max_tokens,
            model_kwargs=model_kwargs,
        )
        resolved_key = _resolve_secret(api_key)
        if not resolved_key:
            raise ValueError("Anthropic API key is required. Set ANTHROPIC_API_KEY.")
        self.api_key = resolved_key
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.headers = _headers(
            resolved_key, headers, use_api_key_header=use_api_key_header
        )
        self._messages_path = "/v1/messages?beta=true" if beta else "/v1/messages"
        self._timeout = timeout

    def _payload(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None,
        kwargs: dict[str, Any],
    ) -> dict[str, Any]:
        system, anthropic_messages = _split_messages(messages)
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": anthropic_messages,
            "max_tokens": int(kwargs.pop("max_tokens", 4096) or 4096),
        }
        if system:
            payload["system"] = system
        anthropic_tools = _anthropic_tools(tools)
        if anthropic_tools:
            payload["tools"] = anthropic_tools
        thinking = _apply_thinking(self.model, kwargs, payload)
        _add_sampling(self.model, kwargs, payload, thinking=thinking)
        return payload

    async def chat(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs: Any,
    ) -> AssistantMessage:
        merged = self._merged_kwargs(**kwargs)
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            response = await client.post(
                f"{self.base_url}{self._messages_path}",
                headers=self.headers,
                json=self._payload(messages, tools, merged),
            )
            response.raise_for_status()
        return self._parse_response(response.json())

    def _parse_response(self, data: dict[str, Any]) -> AssistantMessage:
        content_blocks = data.get("content", [])
        text = "".join(
            block.get("text", "")
            for block in content_blocks
            if isinstance(block, dict) and block.get("type") == "text"
        )
        reasoning = "".join(
            block.get("thinking", "")
            for block in content_blocks
            if isinstance(block, dict) and block.get("type") == "thinking"
        )
        tool_calls = []
        for block in content_blocks:
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            tool_calls.append(
                ToolCall(
                    id=str(block.get("id", "")),
                    function=FunctionCall(
                        name=str(block.get("name", "")),
                        arguments=json.dumps(block.get("input") or {}),
                    ),
                )
            )
        return AssistantMessage(
            content=text or None,
            reasoning_content=reasoning or None,
            tool_calls=tool_calls or None,
        )

    async def stream(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[ChatCompletionChunk]:
        merged = self._merged_kwargs(**kwargs)
        payload = self._payload(messages, tools, merged)
        payload["stream"] = True
        chunk_id = f"anthropic-{int(time.time())}"
        usage = Usage()
        tool_call_indexes: dict[int, int] = {}
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            async with client.stream(
                "POST",
                f"{self.base_url}{self._messages_path}",
                headers=self.headers,
                json=payload,
            ) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    raw = line.removeprefix("data: ")
                    if raw == "[DONE]":
                        break
                    event = json.loads(raw)
                    event_type = event.get("type") if isinstance(event, dict) else ""
                    if event_type == "message_start":
                        raw_usage = event.get("message", {}).get("usage", {})
                        if isinstance(raw_usage, dict):
                            usage.prompt_tokens = int(
                                raw_usage.get("input_tokens") or 0
                            )
                    elif event_type == "content_block_start":
                        content_block = event.get("content_block", {})
                        if (
                            not isinstance(content_block, dict)
                            or content_block.get("type") != "tool_use"
                        ):
                            continue
                        raw_index = event.get("index")
                        block_index = (
                            int(raw_index) if isinstance(raw_index, int) else 0
                        )
                        tool_index = tool_call_indexes.setdefault(
                            block_index, len(tool_call_indexes)
                        )
                        yield _stream_chunk(
                            chunk_id=chunk_id,
                            model=self.model,
                            delta=ChatCompletionDelta(
                                tool_calls=[
                                    ToolCallDelta(
                                        index=tool_index,
                                        id=str(content_block.get("id") or ""),
                                        function=FunctionCallDelta(
                                            name=str(content_block.get("name") or ""),
                                            arguments="",
                                        ),
                                    )
                                ]
                            ),
                        )
                    elif event_type == "message_delta":
                        delta = event.get("delta", {})
                        stop_reason = (
                            delta.get("stop_reason")
                            if isinstance(delta, dict)
                            else None
                        )
                        raw_usage = event.get("usage", {})
                        if isinstance(raw_usage, dict):
                            usage.completion_tokens = int(
                                raw_usage.get("output_tokens") or 0
                            )
                            usage.total_tokens = (
                                usage.prompt_tokens + usage.completion_tokens
                            )
                        yield _stream_chunk(
                            chunk_id=chunk_id,
                            model=self.model,
                            delta=ChatCompletionDelta(),
                            usage=usage,
                            finish_reason=_finish_reason(stop_reason),
                        )
                    else:
                        delta = event.get("delta") if isinstance(event, dict) else None
                        if not isinstance(delta, dict):
                            continue
                        delta_type = delta.get("type")
                        if isinstance(delta.get("thinking"), str):
                            yield _stream_chunk(
                                chunk_id=chunk_id,
                                model=self.model,
                                delta=ChatCompletionDelta(
                                    reasoning_content=delta["thinking"]
                                ),
                            )
                        elif isinstance(delta.get("text"), str):
                            yield _stream_chunk(
                                chunk_id=chunk_id,
                                model=self.model,
                                delta=ChatCompletionDelta(content=delta["text"]),
                            )
                        elif delta_type == "input_json_delta" and isinstance(
                            delta.get("partial_json"), str
                        ):
                            raw_index = event.get("index")
                            block_index = (
                                int(raw_index) if isinstance(raw_index, int) else 0
                            )
                            tool_index = tool_call_indexes.setdefault(
                                block_index, len(tool_call_indexes)
                            )
                            yield _stream_chunk(
                                chunk_id=chunk_id,
                                model=self.model,
                                delta=ChatCompletionDelta(
                                    tool_calls=[
                                        ToolCallDelta(
                                            index=tool_index,
                                            function=FunctionCallDelta(
                                                arguments=delta["partial_json"]
                                            ),
                                        )
                                    ]
                                ),
                            )
