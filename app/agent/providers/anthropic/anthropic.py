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

Multi-thinking-block turns (adaptive/interleaved thinking)
------------------------------------------------------------
Newer models (e.g. claude-sonnet-5) can emit *more than one* ``thinking``
block in a single turn, each immediately preceding the ``tool_use`` block it
justifies (e.g. ``thinking, tool_use, thinking, tool_use``). The
``reasoning_content``/``reasoning_signature``/``redacted_thinking_blocks``
fields above only capture one concatenated thinking segment and cannot
represent this interleaving; replaying them reconstructs a single leading
thinking block followed by all tool calls, which reorders the turn and
triggers ``HTTP 400: thinking or redacted_thinking blocks ... cannot be
modified``.

``AssistantMessage.raw_content_blocks`` fixes this per Anthropic's own
guidance for this exact error ("echo the assistant turn back verbatim ...
rebuilding the message ... triggers a 400 error") by capturing the *exact*
ordered block list Anthropic returned — verbatim ``thinking``/
``redacted_thinking``/``text`` dicts, plus a ``{"type": "tool_use_ref",
"id": ...}`` placeholder resolved against the already-validated
``tool_calls`` list (so interrupted/malformed tool calls stay dropped,
matching existing behaviour) — and is persisted the same way, in
``SessionMessage.extra["raw_content_blocks"]``. ``_split_messages`` prefers
it over the legacy fields when present (see ``_blocks_from_raw_content``);
older rows without it keep using the single-thinking-block reconstruction.
"""

from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator
from functools import lru_cache
from typing import Any

import httpx
from loguru import logger
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
from app.agent.usage import usage_to_dict

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


def _blocks_from_raw_content(
    message: AssistantMessage, valid_tool_result_ids: set[str]
) -> list[dict[str, Any]]:
    """Rebuild the exact content-block order Anthropic originally returned.

    Adaptive/interleaved thinking (e.g. claude-sonnet-5+) can emit multiple
    thinking blocks in a single turn, each immediately preceding the tool_use
    it justifies. The legacy branches in ``_split_messages`` reconstruct a
    fixed "thinking, then text, then all tool calls" order from the
    decomposed ``reasoning_content``/``redacted_thinking_blocks`` fields,
    which only holds for a single thinking block per turn. When
    ``raw_content_blocks`` was captured, replay it verbatim instead.
    """
    blocks: list[dict[str, Any]] = []
    tool_by_id = {tc.id: tc for tc in (message.tool_calls or []) if tc.id}
    for raw in message.raw_content_blocks or []:
        raw_type = raw.get("type")
        if raw_type == "thinking":
            thinking_text = raw.get("thinking") or ""
            signature = raw.get("signature") or ""
            # Pre-fix rows / edge cases without a signature are omitted — the
            # API accepts tool-use-only turns (see module docstring).
            if thinking_text is not None and signature:
                blocks.append(
                    {
                        "type": "thinking",
                        "thinking": thinking_text,
                        "signature": signature,
                    }
                )
        elif raw_type == "redacted_thinking":
            blocks.append({"type": "redacted_thinking", "data": raw.get("data", "")})
        elif raw_type == "text":
            # Verbatim — accumulated directly from the wire during streaming
            # (or copied from the non-streaming response), same as thinking.
            if raw.get("text"):
                blocks.append({"type": "text", "text": raw["text"]})
        elif raw_type == "tool_use_ref":
            tool_call = tool_by_id.get(raw.get("id"))
            if tool_call is None or tool_call.id not in valid_tool_result_ids:
                continue
            blocks.append(
                {
                    "type": "tool_use",
                    "id": tool_call.id,
                    "name": tool_call.function.name,
                    "input": json.loads(tool_call.function.arguments or "{}"),
                }
            )
        elif raw_type == "tool_use":
            tool_id = str(raw.get("id") or "")
            if not tool_id or tool_id not in valid_tool_result_ids:
                continue
            tool_call = tool_by_id.get(tool_id)
            if tool_call is not None:
                blocks.append(
                    {
                        "type": "tool_use",
                        "id": tool_call.id,
                        "name": tool_call.function.name,
                        "input": json.loads(tool_call.function.arguments or "{}"),
                    }
                )
            else:
                blocks.append(raw)
    return blocks


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
        elif isinstance(message, AssistantMessage) and message.raw_content_blocks:
            # Exact block order was captured from the API response — replay
            # it verbatim instead of reconstructing a canonical order (see
            # _blocks_from_raw_content docstring for why that matters).
            raw_blocks = _blocks_from_raw_content(message, valid_tool_result_ids)
            if raw_blocks:
                out.append({"role": "assistant", "content": raw_blocks})
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
    if out and messages and isinstance(messages[-1], AssistantMessage):
        last = out[-1]
        content = last.get("content")
        if last.get("role") == "assistant" and isinstance(content, list):
            # Anthropic Messages API prohibits thinking / redacted_thinking blocks in
            # the latest assistant message (prefill). Strip them if present; if no
            # content blocks remain, drop the empty trailing assistant turn.
            sanitized = [
                b
                for b in content
                if isinstance(b, dict)
                and b.get("type") not in {"thinking", "redacted_thinking"}
            ]
            if sanitized:
                last["content"] = sanitized
            else:
                out.pop()
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
            "claude-opus-5",
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


# Anthropic reports mid-stream failures as an SSE ``{"type": "error"}`` frame on a
# connection that already returned ``200 OK``, so there is no HTTP status for the
# transport layer to raise on.  Map the documented ``error.type`` values onto the
# equivalent status code and re-raise as a real ``httpx.HTTPStatusError`` — that
# way ``stream_with_retry`` applies the same retry budget, backoff, Retry-After
# parsing, and user-facing classification it already applies to HTTP-level
# failures, instead of us bolting a second, divergent error path onto the stream.
# https://docs.anthropic.com/en/api/errors
_STREAM_ERROR_STATUS: dict[str, int] = {
    "invalid_request_error": 400,
    "authentication_error": 401,
    "permission_error": 403,
    "not_found_error": 404,
    "request_too_large": 413,
    "rate_limit_error": 429,
    "api_error": 500,
    "overloaded_error": 529,
}
# Unknown error types are treated as transient: a 500 keeps the request eligible
# for retry, which is the safer default for an unrecognised upstream failure.
_STREAM_ERROR_FALLBACK_STATUS = 500


def _raise_stream_error_event(event: dict[str, Any], *, url: str, raw: str) -> None:
    """Convert an SSE ``error`` frame into ``httpx.HTTPStatusError`` and raise.

    ``raw`` is preserved verbatim as the synthetic response body because
    ``stream_with_retry`` re-parses it (``_extract_provider_error_message``) to
    recover the provider's own wording for the UI.
    """
    error = event.get("error")
    error = error if isinstance(error, dict) else {}
    error_type = error.get("type")
    error_type = error_type if isinstance(error_type, str) else "api_error"
    message = error.get("message")
    message = message if isinstance(message, str) else "stream error"
    status = _STREAM_ERROR_STATUS.get(error_type, _STREAM_ERROR_FALLBACK_STATUS)

    request = httpx.Request("POST", url)
    response = httpx.Response(
        status,
        content=raw.encode(),
        headers={"content-type": "application/json"},
        request=request,
    )
    raise httpx.HTTPStatusError(
        f"Anthropic stream error (HTTP {status}): {error_type}: {message}",
        request=request,
        response=response,
    )


def _prompt_usage_from_raw(raw_usage: dict[str, Any]) -> tuple[int, int | None]:
    """Collapse Anthropic's three prompt buckets into one total.

    ``input_tokens`` counts *only* uncached tokens — cache reads and cache
    creations are reported separately and are not included in it. They are
    summed here to restore the ``cached_tokens <= prompt_tokens`` invariant
    that cost estimation depends on (see ``app.agent.usage._estimate_cost``,
    which derives billable input by subtracting the cached count).

    Shared by the streaming and non-streaming paths so the two cannot drift.
    """
    non_cached = int(raw_usage.get("input_tokens") or 0)
    cache_read = int(raw_usage.get("cache_read_input_tokens") or 0)
    cache_write = int(raw_usage.get("cache_creation_input_tokens") or 0)
    return non_cached + cache_read + cache_write, cache_read or None


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


#: Output-token cap used when the model registry has no entry for a model.
#: Anthropic IDs arrive from live ``/v1/models`` discovery, so a new model can
#: be selectable before the curated registry knows it.  The historical fallback
#: here was 4096 (a Claude 2-era limit), which silently truncated large
#: ``write``/``patch`` tool calls mid-JSON.  Every supported Anthropic model
#: publishes at least 64000, so this stays comfortably inside real limits while
#: being large enough for whole-file writes.
_DEFAULT_MAX_OUTPUT_TOKENS = 32000


@lru_cache(maxsize=None)
def _max_output_tokens_for_model(model: str) -> int:
    """Return the output-token cap for *model*.

    Cached so the unknown-model warning is emitted once per model rather than
    on every request.
    """
    from app.agent.providers.model_metadata import get_model_limits

    limits = get_model_limits(f"anthropic:{_anthropic_model_name(model)}")
    if limits.max_completion_tokens is not None:
        return limits.max_completion_tokens

    # Cached, so this fires once per unknown model per process — not per request.
    logger.warning(
        "anthropic_model_limits_unknown model={} max_tokens={} (set limits in "
        "model_registry.yaml)",
        model,
        _DEFAULT_MAX_OUTPUT_TOKENS,
    )
    return _DEFAULT_MAX_OUTPUT_TOKENS


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
        default_max = _max_output_tokens_for_model(self.model)

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
        # Capture the exact block order too — needed to correctly replay
        # turns with more than one thinking block (adaptive/interleaved
        # thinking), which reasoning_content/redacted_thinking_blocks above
        # cannot represent (see _blocks_from_raw_content).
        raw_content_blocks: list[dict[str, Any]] = []
        for block in content_blocks:
            if not isinstance(block, dict):
                continue
            block_type = block.get("type")
            if block_type == "thinking":
                raw_content_blocks.append(
                    {
                        "type": "thinking",
                        "thinking": block.get("thinking", ""),
                        "signature": block.get("signature", ""),
                    }
                )
            elif block_type == "redacted_thinking":
                raw_content_blocks.append(
                    {"type": "redacted_thinking", "data": block.get("data", "")}
                )
            elif block_type == "text":
                raw_content_blocks.append(
                    {"type": "text", "text": block.get("text", "")}
                )
            elif block_type == "tool_use":
                raw_content_blocks.append(
                    {"type": "tool_use_ref", "id": str(block.get("id", ""))}
                )
        if raw_content_blocks:
            msg.raw_content_blocks = raw_content_blocks
        # Non-streaming callers (title generation, connectivity probes) read
        # usage off `extra` exactly like the streamed path does, so omitting it
        # here made those calls invisible to cost/token telemetry.
        raw_usage = data.get("usage")
        if isinstance(raw_usage, dict):
            prompt_tokens, cached_tokens = _prompt_usage_from_raw(raw_usage)
            completion_tokens = int(raw_usage.get("output_tokens") or 0)
            usage = Usage(
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=prompt_tokens + completion_tokens,
                cached_tokens=cached_tokens,
            )
            msg.extra = {**(msg.extra or {}), "usage": usage_to_dict(usage, self.model)}
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
        # Track the exact order/content of every block Anthropic streams so
        # multi-thinking-block turns (adaptive/interleaved thinking) can be
        # replayed verbatim later — see AssistantMessage.raw_content_blocks.
        raw_blocks: dict[int, dict[str, Any]] = {}
        raw_block_order: list[int] = []
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
                    if event_type == "error":
                        # Raised, not ignored: a discarded error frame ends the
                        # stream silently and the caller cannot tell an upstream
                        # failure from the model choosing to emit nothing.
                        _raise_stream_error_event(
                            event,
                            url=f"{self.base_url}{messages_path}",
                            raw=raw,
                        )
                    if event_type == "message_start":
                        raw_usage = event.get("message", {}).get("usage", {})
                        if isinstance(raw_usage, dict):
                            (
                                usage.prompt_tokens,
                                usage.cached_tokens,
                            ) = _prompt_usage_from_raw(raw_usage)
                    elif event_type == "content_block_start":
                        content_block = event.get("content_block", {})
                        if not isinstance(content_block, dict):
                            continue
                        block_type = content_block.get("type")
                        raw_index = event.get("index")
                        block_index = (
                            int(raw_index) if isinstance(raw_index, int) else 0
                        )
                        if block_type == "redacted_thinking":
                            # Anthropic delivers the entire redacted_thinking
                            # block in content_block_start (no deltas follow).
                            # Surface it so the streaming consumer can persist
                            # it and replay it verbatim in history.
                            raw_blocks[block_index] = {
                                "type": "redacted_thinking",
                                "data": content_block.get("data", ""),
                            }
                            raw_block_order.append(block_index)
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
                        if block_type == "thinking":
                            raw_blocks[block_index] = {
                                "type": "thinking",
                                "thinking": "",
                                "signature": "",
                            }
                            raw_block_order.append(block_index)
                            continue
                        if block_type == "text":
                            raw_blocks[block_index] = {"type": "text", "text": ""}
                            raw_block_order.append(block_index)
                            continue
                        if block_type != "tool_use":
                            continue
                        raw_blocks[block_index] = {
                            "type": "tool_use_ref",
                            "id": str(content_block.get("id") or ""),
                        }
                        raw_block_order.append(block_index)
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
                        raw_index = event.get("index")
                        block_index = (
                            int(raw_index) if isinstance(raw_index, int) else 0
                        )
                        if isinstance(delta.get("thinking"), str):
                            block = raw_blocks.get(block_index)
                            if block is not None and block.get("type") == "thinking":
                                block["thinking"] += delta["thinking"]
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
                            block = raw_blocks.get(block_index)
                            if block is not None and block.get("type") == "thinking":
                                block["signature"] += delta["signature"]
                            yield _stream_chunk(
                                chunk_id=chunk_id,
                                model=self.model,
                                delta=ChatCompletionDelta(
                                    reasoning_signature=delta["signature"]
                                ),
                            )
                        elif isinstance(delta.get("text"), str):
                            block = raw_blocks.get(block_index)
                            if block is not None and block.get("type") == "text":
                                block["text"] += delta["text"]
                            yield _stream_chunk(
                                chunk_id=chunk_id,
                                model=self.model,
                                delta=ChatCompletionDelta(content=delta["text"]),
                            )
                        elif delta_type == "input_json_delta" and isinstance(
                            delta.get("partial_json"), str
                        ):
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
                if raw_block_order:
                    # Surface the fully assembled, ordered block list once the
                    # stream completes so the caller can persist it and replay
                    # multi-thinking-block turns verbatim (see
                    # AssistantMessage.raw_content_blocks).
                    yield _stream_chunk(
                        chunk_id=chunk_id,
                        model=self.model,
                        delta=ChatCompletionDelta(
                            anthropic_raw_blocks=[
                                raw_blocks[i]
                                for i in raw_block_order
                                if i in raw_blocks
                            ]
                        ),
                    )
