"""Anthropic Messages API provider.

Extended-thinking round-trip contract
--------------------------------------
When ``thinking_level`` is set the API may return two block types that **must**
be echoed verbatim in subsequent turns (HTTP 400 otherwise):

``thinking`` blocks
    Carry ``thinking`` (summarised text) and an opaque ``signature``.  Both
    fields must be round-tripped unchanged.  ``_split_messages`` only emits a
    thinking block when **both** ``reasoning_content`` and
    ``reasoning_signature`` are non-empty; pre-fix rows that have no stored
    signature are silently omitted — the API accepts tool-use-only turns.

``redacted_thinking`` blocks
    Returned when Anthropic safety-redacts part of the model's reasoning.
    Contain only an opaque ``data`` field.  Must be passed back exactly as
    received; dropping or modifying them causes the same HTTP 400.

Storage layout
~~~~~~~~~~~~~~
Both block types are captured during streaming/parsing and stored in two places
so they survive a DB round-trip:

thinking blocks
  1. ``AssistantMessage.reasoning_content`` / ``.reasoning_signature`` —
     in-memory (``exclude=True``; not serialised to the wire).
  2. ``SessionMessage.extra["reasoning_signature"]`` — persisted in the DB.

redacted_thinking blocks
  1. ``AssistantMessage.redacted_thinking_blocks`` — in-memory list of raw
     block dicts (``exclude=True``).
  2. ``SessionMessage.extra["redacted_thinking_blocks"]`` — persisted in the DB.

On load, ``chat_service_messages.deserialize_messages`` copies both values from
``extra`` back onto the ``AssistantMessage`` so ``_split_messages`` can replay
them when rebuilding the API payload.
"""

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
    ImageDataBlock,
    ImageUrlBlock,
    SystemMessage,
    TextBlock,
    ToolCall,
    ToolCallDelta,
    ToolMessage,
    Usage,
)

ANTHROPIC_API_BASE = "https://api.anthropic.com"
ANTHROPIC_API_VERSION = "2023-06-01"


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
) -> tuple[list[dict[str, Any]] | None, list[dict[str, Any]]]:
    valid_tool_result_ids = {
        str(message.tool_call_id)
        for message in messages
        if isinstance(message, ToolMessage) and message.tool_call_id
    }
    system_parts: list[str] = []
    out: list[dict[str, Any]] = []
    for message in messages:
        if isinstance(message, SystemMessage):
            if message.content:
                system_parts.append(message.content)
            continue
        if isinstance(message, HumanMessage):
            if message.parts:
                blocks: list[dict[str, Any]] = []
                for part in message.parts:
                    if isinstance(part, TextBlock):
                        if part.text:
                            blocks.append({"type": "text", "text": part.text})
                    elif isinstance(part, ImageUrlBlock):
                        source: dict[str, Any] = {"type": "url", "url": part.url}
                        if part.media_type:
                            source["media_type"] = part.media_type
                        blocks.append({"type": "image", "source": source})
                    elif isinstance(part, ImageDataBlock):
                        blocks.append(
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": part.media_type,
                                    "data": part.data,
                                },
                            }
                        )
                content = message.content or ""
                if not blocks and not content:
                    continue
                out.append(
                    {
                        "role": "user",
                        "content": blocks or [{"type": "text", "text": content}],
                    }
                )
            else:
                content = message.content or ""
                if not content:
                    continue
                out.append(
                    {
                        "role": "user",
                        "content": [{"type": "text", "text": content}],
                    }
                )
        elif isinstance(message, AssistantMessage) and message.tool_calls:
            blocks: list[dict[str, Any]] = []
            # Re-emit the thinking block when we have a valid signature.
            # Anthropic requires both `thinking` and `signature` to be present
            # when a thinking block appears in history.  Omit it entirely when
            # the signature is missing (pre-fix rows) — tool_use-only content
            # arrays are accepted by the API without a preceding text block.
            if message.reasoning_content and message.reasoning_signature:
                blocks.append(
                    {
                        "type": "thinking",
                        "thinking": message.reasoning_content,
                        "signature": message.reasoning_signature,
                    }
                )
            # Re-emit redacted_thinking blocks verbatim — Anthropic requires
            # these to be round-tripped exactly as received (HTTP 400 otherwise).
            if message.redacted_thinking_blocks:
                blocks.extend(message.redacted_thinking_blocks)
            if message.content:
                blocks.append({"type": "text", "text": message.content})
            for tool_call in message.tool_calls:
                if tool_call.id not in valid_tool_result_ids:
                    continue
                blocks.append(
                    {
                        "type": "tool_use",
                        "id": tool_call.id,
                        "name": tool_call.function.name,
                        "input": json.loads(tool_call.function.arguments or "{}"),
                    }
                )
            if blocks:
                out.append({"role": "assistant", "content": blocks})
        elif isinstance(message, AssistantMessage):
            content = message.content or ""
            # Re-emit the thinking block for plain (non-tool-call) assistant
            # turns generated under extended thinking.  Without this, a turn
            # that produced only a thinking block + text (or only a thinking
            # block at max-token truncation) loses its thinking context when
            # history is re-sent, causing the same HTTP 400.
            if message.reasoning_content and message.reasoning_signature:
                thinking_block: dict[str, Any] = {
                    "type": "thinking",
                    "thinking": message.reasoning_content,
                    "signature": message.reasoning_signature,
                }
                # Also collect any redacted_thinking blocks alongside the
                # regular thinking block (both can appear in the same turn).
                extra_blocks: list[dict[str, Any]] = (
                    list(message.redacted_thinking_blocks)
                    if message.redacted_thinking_blocks
                    else []
                )
                if content:
                    out.append(
                        {
                            "role": "assistant",
                            "content": [thinking_block]
                            + extra_blocks
                            + [{"type": "text", "text": content}],
                        }
                    )
                else:
                    # Max-token truncation: the model ran out of output budget
                    # mid-thinking — only the thinking block survived.  Include
                    # it so the API sees a valid non-empty content array.
                    out.append(
                        {
                            "role": "assistant",
                            "content": [thinking_block] + extra_blocks,
                        }
                    )
                continue
            # No regular thinking block — still need to replay redacted_thinking
            # blocks if present (they can appear without a thinking block).
            if message.redacted_thinking_blocks:
                redacted_blocks: list[dict[str, Any]] = list(
                    message.redacted_thinking_blocks
                )
                if content:
                    out.append(
                        {
                            "role": "assistant",
                            "content": redacted_blocks
                            + [{"type": "text", "text": content}],
                        }
                    )
                else:
                    out.append({"role": "assistant", "content": redacted_blocks})
                continue
            if not content:
                continue
            out.append(
                {
                    "role": "assistant",
                    "content": [{"type": "text", "text": content}],
                }
            )
        elif isinstance(message, ToolMessage):
            tool_content: str | list[dict[str, Any]] = message.content or ""
            if message.parts:
                blocks: list[dict[str, Any]] = []
                for part in message.parts:
                    if isinstance(part, TextBlock):
                        if part.text:
                            blocks.append({"type": "text", "text": part.text})
                    elif isinstance(part, ImageUrlBlock):
                        source: dict[str, Any] = {"type": "url", "url": part.url}
                        if part.media_type:
                            source["media_type"] = part.media_type
                        blocks.append({"type": "image", "source": source})
                    elif isinstance(part, ImageDataBlock):
                        blocks.append(
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": part.media_type,
                                    "data": part.data,
                                },
                            }
                        )
                if blocks:
                    tool_content = blocks
            result_block: dict[str, Any] = {
                "type": "tool_result",
                "tool_use_id": message.tool_call_id,
                "content": tool_content,
            }
            if (message.content or "").startswith("Error:"):
                result_block["is_error"] = True
            # Batch consecutive tool results into the same user turn — Anthropic
            # requires all tool_result blocks from one assistant turn to arrive in
            # a single {"role": "user", "content": [...]} message. Emitting
            # separate user turns for each result causes a 400 error.
            if (
                out
                and out[-1]["role"] == "user"
                and isinstance(out[-1]["content"], list)
                and out[-1]["content"]
                and out[-1]["content"][0].get("type") == "tool_result"
            ):
                out[-1]["content"].append(result_block)
            else:
                out.append({"role": "user", "content": [result_block]})
    system_text = "\n\n".join(system_parts)
    system_blocks = (
        [{"type": "text", "text": system_text, "cache_control": {"type": "ephemeral"}}]
        if system_text
        else None
    )
    if out:
        last = out[-1]
        content = last.get("content")
        if isinstance(content, list) and content:
            final_block = content[-1]
            if isinstance(final_block, dict) and final_block.get("type") in {
                "text",
                "tool_result",
            }:
                final_block["cache_control"] = {"type": "ephemeral"}
    return system_blocks, out


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


def _thinking_budget(level: str, max_tokens: int) -> int:
    ratios = {"low": 0.25, "medium": 0.4, "high": 0.6, "xhigh": 0.75, "max": 0.8}
    budget = int(max_tokens * ratios.get(level, 0.4))
    return max(1024, min(budget, max_tokens - 1))


def _uses_beta_messages_api(_model: str, kwargs: dict[str, Any]) -> bool:
    explicit = kwargs.pop("anthropic_beta", None)
    return bool(explicit)


def _anthropic_model_name(model: str) -> str:
    """Normalize direct and Bedrock Mantle Anthropic model IDs."""
    return model.lower().removeprefix("anthropic.")


def _uses_adaptive_thinking(model: str) -> bool:
    return _anthropic_model_name(model).startswith(
        (
            "claude-opus-4-6",
            "claude-opus-4-7",
            "claude-opus-4-8",
            "claude-sonnet-4-6",
            "claude-sonnet-5",
            "claude-fable-5",
            "claude-mythos",
        )
    )


def _apply_thinking(
    model: str, kwargs: dict[str, Any], payload: dict[str, Any]
) -> bool:
    level = str(kwargs.pop("thinking_level", "") or "").lower()
    if not level:
        return False
    normalized_model = _anthropic_model_name(model)
    if level in {"none", "off"}:
        if normalized_model.startswith("claude-sonnet-5"):
            payload["thinking"] = {"type": "disabled"}
        return False
    if _uses_adaptive_thinking(model):
        payload["thinking"] = {"type": "adaptive", "display": "summarized"}
        payload["output_config"] = {"effort": level}
        return True
    max_tokens = int(payload["max_tokens"])
    payload["thinking"] = {
        "type": "enabled",
        "budget_tokens": _thinking_budget(level, max_tokens),
        "display": "summarized",
    }
    if normalized_model.startswith("claude-opus-4-5"):
        payload["output_config"] = {"effort": level}
    return True


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


def _max_output_tokens_for_model(model: str) -> int:
    from app.agent.providers.model_metadata import get_model_limits

    limits = get_model_limits(f"anthropic:{model}")
    if limits.max_completion_tokens is not None:
        return limits.max_completion_tokens

    return 4096


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
        max_tokens: int | None = None,
        timeout: float | httpx.Timeout | None = 120,
        model_kwargs: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(
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
        self._beta = beta
        self._messages_path = "/v1/messages"
        self._timeout = timeout

    def _payload(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None,
        kwargs: dict[str, Any],
    ) -> dict[str, Any]:
        system, anthropic_messages = _split_messages(messages)

        from app.agent.providers.model_metadata import get_model_limits

        limits = get_model_limits(f"anthropic:{self.model}")
        default_max = limits.max_completion_tokens or 4096

        requested_max = kwargs.pop("max_tokens", None)
        if requested_max is not None:
            if limits.max_completion_tokens is not None:
                max_tokens = min(int(requested_max), limits.max_completion_tokens)
            else:
                max_tokens = int(requested_max)
        else:
            max_tokens = default_max

        payload: dict[str, Any] = {
            "model": self.model,
            "messages": anthropic_messages,
            "max_tokens": max_tokens,
        }
        if system:
            payload["system"] = system
        anthropic_tools = _anthropic_tools(tools)
        if anthropic_tools:
            payload["tools"] = anthropic_tools
            # Honour an explicit tool_choice override (e.g. "none" from the
            # summarisation hook).  Anthropic represents this as an object
            # {"type": "none"} rather than a plain string.
            # Only injected when tools are present — the API rejects
            # tool_choice without a tools list.
            tool_choice = kwargs.pop("tool_choice", None)
            if tool_choice == "none":
                payload["tool_choice"] = {"type": "none"}
            elif tool_choice is not None:
                payload["tool_choice"] = tool_choice

        service_tier = kwargs.get("service_tier")
        if service_tier and "api.anthropic.com" in self.base_url:
            payload["service_tier"] = "auto" if service_tier == "fast" else service_tier

        _apply_thinking(self.model, kwargs, payload)
        return payload

    async def chat(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs: Any,
    ) -> AssistantMessage:
        merged = self._merged_kwargs(**kwargs)
        messages_path = (
            f"{self._messages_path}?beta=true"
            if _uses_beta_messages_api(self.model, merged) or self._beta
            else self._messages_path
        )
        async with self._http_client_context() as client:
            response = await client.post(
                f"{self.base_url}{messages_path}",
                headers=self.headers,
                json=self._payload(messages, tools, merged),
                timeout=self._timeout,
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
        # Anthropic returns an opaque `signature` on every thinking block that
        # must be round-tripped verbatim when the block appears in history.
        # Concatenate signatures if there are multiple thinking blocks (rare).
        reasoning_signature = "".join(
            block.get("signature", "")
            for block in content_blocks
            if isinstance(block, dict) and block.get("type") == "thinking"
        )
        # Capture redacted_thinking blocks verbatim so they can be replayed
        # in future turns.  Sending them modified (or omitted) causes HTTP 400.
        redacted_thinking_blocks = [
            {"type": "redacted_thinking", "data": block.get("data", "")}
            for block in content_blocks
            if isinstance(block, dict) and block.get("type") == "redacted_thinking"
        ] or None
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
        msg = AssistantMessage(
            content=text or None,
            reasoning_content=reasoning or None,
            reasoning_signature=reasoning_signature or None,
            tool_calls=tool_calls or None,
        )
        if redacted_thinking_blocks:
            msg.redacted_thinking_blocks = redacted_thinking_blocks
        return msg

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
        messages_path = (
            f"{self._messages_path}?beta=true"
            if _uses_beta_messages_api(self.model, merged) or self._beta
            else self._messages_path
        )
        usage = Usage()
        tool_call_indexes: dict[int, int] = {}
        async with self._http_client_context() as client:
            async with client.stream(
                "POST",
                f"{self.base_url}{messages_path}",
                headers=self.headers,
                json=payload,
                timeout=self._timeout,
            ) as response:
                if response.status_code >= 400:
                    await response.aread()
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
                            non_cached = int(raw_usage.get("input_tokens") or 0)
                            cache_read = int(
                                raw_usage.get("cache_read_input_tokens") or 0
                            )
                            cache_write = int(
                                raw_usage.get("cache_creation_input_tokens") or 0
                            )
                            usage.prompt_tokens = non_cached + cache_read + cache_write
                            usage.cached_tokens = cache_read or None
                    elif event_type == "content_block_start":
                        content_block = event.get("content_block", {})
                        if not isinstance(content_block, dict):
                            continue
                        block_type = content_block.get("type")
                        if block_type == "redacted_thinking":
                            # Anthropic delivers the entire redacted_thinking
                            # block in content_block_start (no deltas follow).
                            # Surface it so the streaming consumer can persist
                            # it and replay it verbatim in history.
                            yield _stream_chunk(
                                chunk_id=chunk_id,
                                model=self.model,
                                delta=ChatCompletionDelta(
                                    redacted_thinking_block={
                                        "type": "redacted_thinking",
                                        "data": content_block.get("data", ""),
                                    }
                                ),
                            )
                            continue
                        if block_type != "tool_use":
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
                        elif delta_type == "signature_delta" and isinstance(
                            delta.get("signature"), str
                        ):
                            # Anthropic streams the thinking-block signature as a
                            # separate delta type.  Surface it so the caller can
                            # persist it and include it when re-sending history.
                            yield _stream_chunk(
                                chunk_id=chunk_id,
                                model=self.model,
                                delta=ChatCompletionDelta(
                                    reasoning_signature=delta["signature"]
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
