"""AWS Bedrock provider — Converse / ConverseStream API.

Uses boto3's ``bedrock-runtime`` Converse API, which presents a unified
interface across model families (Anthropic Claude, Amazon Nova/Titan,
Meta Llama, Mistral, etc.).

Auth is resolved in priority order:
1. Explicit ``aws_access_key_id`` + ``aws_secret_access_key`` constructor args.
2. Named profile (``profile_name``) from ``~/.aws/credentials``.
3. Standard boto3 credential chain (env vars ``AWS_ACCESS_KEY_ID`` /
   ``AWS_SECRET_ACCESS_KEY``, instance profile, IAM role, etc.).

Region is resolved in priority order:
1. ``region_name`` constructor arg.
2. ``AWS_BEDROCK_REGION`` setting.
3. ``AWS_DEFAULT_REGION`` env var.
4. ``"us-east-1"`` fallback.

Usage::

    # Default credential chain, explicit region
    provider = BedrockProvider(model="anthropic.claude-3-5-sonnet-20241022-v2:0",
                               region_name="us-west-2")

    # Named profile
    provider = BedrockProvider(model="amazon.nova-pro-v1:0",
                               profile_name="my-profile")

    # Explicit API key
    provider = BedrockProvider(model="anthropic.claude-3-5-haiku-20241022-v1:0",
                               aws_access_key_id="AKIA...",
                               aws_secret_access_key="secret")
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import time
from typing import Any

from loguru import logger

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


_DONE = object()  # sentinel — StopIteration cannot propagate through asyncio Futures


async def _nonblocking_iter(sync_iter: Any):
    """Fetch items from a blocking iterator one at a time in a thread pool.

    boto3's EventStream.__next__ does blocking socket I/O; calling it on the
    event loop freezes SSE delivery until the full response is consumed.
    """
    it = iter(sync_iter)
    while (item := await asyncio.to_thread(next, it, _DONE)) is not _DONE:
        yield item


def _resolve_region(region_name: str | None) -> str:
    """Resolve AWS region: explicit arg → AWS_BEDROCK_REGION → AWS_DEFAULT_REGION → us-east-1."""
    if region_name:
        return region_name
    # Lazy import — avoids env-var reads at module import time
    from app.core.config import settings as s

    return s.AWS_BEDROCK_REGION or os.getenv("AWS_DEFAULT_REGION") or "us-east-1"


def _make_client(
    region: str,
    profile_name: str | None,
    aws_access_key_id: str | None,
    aws_secret_access_key: str | None,
) -> Any:
    """Build a boto3 bedrock-runtime client."""
    import boto3

    session_kwargs: dict[str, Any] = {}
    if profile_name:
        session_kwargs["profile_name"] = profile_name
    if aws_access_key_id and aws_secret_access_key:
        session_kwargs["aws_access_key_id"] = aws_access_key_id
        session_kwargs["aws_secret_access_key"] = aws_secret_access_key

    session = boto3.Session(**session_kwargs)
    return session.client("bedrock-runtime", region_name=region)


# ── Message conversion ────────────────────────────────────────────────────────


def _content_block_to_bedrock(block: Any) -> dict[str, Any]:
    """Convert a canonical ContentBlock to a Bedrock content block."""
    if isinstance(block, TextBlock):
        return {"text": block.text}
    if isinstance(block, ImageDataBlock):
        return {
            "image": {
                "format": block.media_type.split("/")[-1],  # "jpeg", "png", etc.
                "source": {
                    "bytes": base64.b64decode(block.data),
                },
            }
        }
    if isinstance(block, ImageUrlBlock):
        # Bedrock doesn't support URL images natively — fetch or raise
        raise ValueError(
            "BedrockProvider does not support image URLs directly. "
            "Use ImageDataBlock with base64-encoded image bytes instead."
        )
    raise ValueError(f"Unsupported content block type: {type(block)}")


def _human_message_to_bedrock(msg: HumanMessage) -> dict[str, Any]:
    """Convert HumanMessage to a Bedrock converse message."""
    if msg.parts:
        content = [_content_block_to_bedrock(p) for p in msg.parts]
    else:
        content = [{"text": msg.content or ""}]
    return {"role": "user", "content": content}


def _messages_to_bedrock(
    messages: list[ChatMessage],
) -> tuple[str | None, list[dict[str, Any]]]:
    """Split messages into (system_prompt, converse_messages).

    Bedrock Converse takes system as a separate top-level field.
    Tool results are inlined as ``toolResult`` blocks on user turns.
    """
    system_parts: list[str] = []
    converse: list[dict[str, Any]] = []

    # Collect consecutive ToolMessages to merge them into one user turn
    pending_tool_results: list[dict[str, Any]] = []

    def _flush_tool_results() -> None:
        if pending_tool_results:
            converse.append({"role": "user", "content": list(pending_tool_results)})
            pending_tool_results.clear()

    for msg in messages:
        if isinstance(msg, SystemMessage):
            if msg.content:
                system_parts.append(msg.content)

        elif isinstance(msg, HumanMessage):
            _flush_tool_results()
            converse.append(_human_message_to_bedrock(msg))

        elif isinstance(msg, AssistantMessage):
            _flush_tool_results()
            content: list[dict[str, Any]] = []
            if msg.content:
                content.append({"text": msg.content})
            for tc in msg.tool_calls or []:
                content.append(
                    {
                        "toolUse": {
                            "toolUseId": tc.id,
                            "name": tc.function.name,
                            "input": json.loads(tc.function.arguments or "{}"),
                        }
                    }
                )
            if content:
                converse.append({"role": "assistant", "content": content})

        elif isinstance(msg, ToolMessage):
            # Accumulate — Bedrock expects all tool results in one user turn
            if msg.parts:
                tool_content: list[dict[str, Any]] = [
                    _content_block_to_bedrock(p) for p in msg.parts
                ]
            else:
                tool_content = [{"text": msg.content or ""}]
            pending_tool_results.append(
                {
                    "toolResult": {
                        "toolUseId": msg.tool_call_id,
                        "content": tool_content,
                    }
                }
            )

    _flush_tool_results()

    system_prompt = "\n\n".join(system_parts) if system_parts else None
    return system_prompt, converse


def _tools_to_bedrock(tools: list[dict] | None) -> list[dict[str, Any]] | None:
    """Convert OpenAI-format tool specs to Bedrock toolSpec format."""
    if not tools:
        return None
    bedrock_tools = []
    for t in tools:
        fn = t.get("function", t)  # accept both {function: ...} and flat dicts
        bedrock_tools.append(
            {
                "toolSpec": {
                    "name": fn["name"],
                    "description": fn.get("description", ""),
                    "inputSchema": {"json": fn.get("parameters", {})},
                }
            }
        )
    return bedrock_tools


# ── Chunk construction ────────────────────────────────────────────────────────


def _chunk(
    model: str,
    delta: ChatCompletionDelta,
    finish_reason: str | None = None,
    usage: Usage | None = None,
) -> ChatCompletionChunk:
    return ChatCompletionChunk(
        id="bedrock-stream",
        created=int(time.time()),
        model=model,
        choices=[
            ChatCompletionChunkChoice(index=0, delta=delta, finish_reason=finish_reason)
        ],
        usage=usage,
    )


# ── Response parsing ──────────────────────────────────────────────────────────


def _parse_usage(usage_dict: dict[str, Any] | None) -> Usage | None:
    if not usage_dict:
        return None
    return Usage(
        prompt_tokens=usage_dict.get("inputTokens", 0),
        completion_tokens=usage_dict.get("outputTokens", 0),
        total_tokens=usage_dict.get("totalTokens", 0),
        cached_tokens=usage_dict.get("cacheReadInputTokens") or None,
    )


def _parse_converse_response(response: dict[str, Any]) -> AssistantMessage:
    """Parse a Bedrock converse (non-streaming) response."""
    output = response.get("output", {})
    msg = output.get("message", {})
    content_blocks = msg.get("content", [])

    text_parts: list[str] = []
    tool_calls: list[ToolCall] = []

    for block in content_blocks:
        if "text" in block:
            text_parts.append(block["text"])
        elif "toolUse" in block:
            tu = block["toolUse"]
            tool_calls.append(
                ToolCall(
                    id=tu["toolUseId"],
                    function=FunctionCall(
                        name=tu["name"],
                        arguments=json.dumps(tu.get("input", {})),
                    ),
                )
            )

    return AssistantMessage(
        content="\n".join(text_parts) if text_parts else None,
        tool_calls=tool_calls if tool_calls else None,
    )


# ── Provider ──────────────────────────────────────────────────────────────────


class BedrockProvider(LLMProviderBase):
    """AWS Bedrock provider using the Converse API.

    Supports any model family available via Bedrock's Converse API
    (Anthropic Claude, Amazon Nova/Titan, Meta Llama, Mistral, etc.).

    Auth is resolved from explicit args → profile → boto3 default chain.

    Args:
        model: Bedrock model ID, e.g.
            ``"anthropic.claude-3-5-sonnet-20241022-v2:0"``,
            ``"amazon.nova-pro-v1:0"``.
        region_name: AWS region. Falls back to ``AWS_BEDROCK_REGION``
            setting → ``AWS_DEFAULT_REGION`` env var → ``"us-east-1"``.
        profile_name: Named AWS profile from ``~/.aws/credentials``.
            ``None`` uses the standard boto3 credential chain.
        aws_access_key_id: Explicit access key ID. Takes precedence over
            the profile when both are provided.
        aws_secret_access_key: Explicit secret access key.
        max_tokens: Hard cap on completion tokens.
        model_kwargs: Extra fields forwarded to ``additionalModelRequestFields``
            in the Converse API call.
    """

    def __init__(
        self,
        model: str,
        region_name: str | None = None,
        profile_name: str | None = None,
        aws_access_key_id: str | None = None,
        aws_secret_access_key: str | None = None,
        max_tokens: int | None = None,
        model_kwargs: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(
            max_tokens=max_tokens,
            model_kwargs=model_kwargs,
        )
        self.model = model
        self._region = _resolve_region(region_name)
        self._client = _make_client(
            self._region,
            profile_name,
            aws_access_key_id,
            aws_secret_access_key,
        )
        logger.debug(
            "bedrock_provider model={} region={}",
            model,
            self._region,
        )

    def _build_request(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None,
        merged: dict[str, Any],
    ) -> dict[str, Any]:
        system_prompt, converse_messages = _messages_to_bedrock(messages)
        bedrock_tools = _tools_to_bedrock(tools)

        # Inference config — only include fields that are set
        inference_config: dict[str, Any] = {}
        if merged.get("max_tokens") is not None:
            from app.agent.providers.model_metadata import get_model_limits

            limits = get_model_limits(f"bedrock:{self.model}")
            requested_max = merged["max_tokens"]
            if limits.max_completion_tokens is not None:
                inference_config["maxTokens"] = min(
                    int(requested_max), limits.max_completion_tokens
                )
            else:
                inference_config["maxTokens"] = int(requested_max)

        # Remaining merged keys → additionalModelRequestFields.
        # Strip keys that are provider-specific to other providers and have no
        # Bedrock equivalent — forwarding them causes ValidationException.
        known = {
            "max_tokens",
            # temperature/top_p are retired entirely (no longer set by any
            # caller), but stay in this filter so a stray value surviving in
            # legacy session/agent config data is dropped rather than leaking
            # into additionalModelRequestFields.
            "temperature",
            "top_p",
            # OpenAI / Gemini / ZAI reasoning control — not a Bedrock field
            "thinking_level",
            # OpenAI-specific
            "responses_api",
            "reasoning_effort",
            # Generic tool-choice override — Bedrock's ToolChoice API has no
            # "none" option so this key is intentionally not forwarded.
            "tool_choice",
        }
        additional = {k: v for k, v in merged.items() if k not in known}

        req: dict[str, Any] = {
            "modelId": self.model,
            "messages": converse_messages,
        }
        if system_prompt:
            req["system"] = [{"text": system_prompt}]
        if inference_config:
            req["inferenceConfig"] = inference_config
        if bedrock_tools:
            tool_config: dict[str, Any] = {"tools": bedrock_tools}
            # Converse supports auto/any tool choices. See:
            # https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolConfiguration.html
            # "none" has no Bedrock equivalent, so omit toolChoice to use the API default.
            tool_choice = merged.get("tool_choice")
            if tool_choice == "auto":
                tool_config["toolChoice"] = {"auto": {}}
            elif tool_choice == "required":
                tool_config["toolChoice"] = {"any": {}}
            req["toolConfig"] = tool_config
        if additional:
            req["additionalModelRequestFields"] = additional

        return req

    async def chat(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs: Any,
    ) -> AssistantMessage:
        merged = self._merged_kwargs(**kwargs)
        req = self._build_request(messages, tools, merged)

        response = await asyncio.to_thread(self._client.converse, **req)
        msg = _parse_converse_response(response)
        logger.debug(
            "bedrock_chat model={} stop_reason={}",
            self.model,
            response.get("stopReason"),
        )
        return msg

    async def stream(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs: Any,
    ):
        merged = self._merged_kwargs(**kwargs)
        req = self._build_request(messages, tools, merged)

        response = await asyncio.to_thread(self._client.converse_stream, **req)
        stream = response.get("stream")
        if stream is None:
            raise RuntimeError("BedrockProvider: converse_stream returned no stream")

        # Track open tool-use blocks by index
        tool_idx_by_id: dict[str, int] = {}
        current_tool_id: str | None = None
        current_tool_name: str | None = None

        async for event in _nonblocking_iter(stream):
            # ── Text delta ────────────────────────────────────────────────
            if "contentBlockDelta" in event:
                delta = event["contentBlockDelta"].get("delta", {})
                if "text" in delta:
                    yield _chunk(self.model, ChatCompletionDelta(content=delta["text"]))
                elif "toolUse" in delta:
                    # Argument fragment for the current tool call
                    args_fragment = delta["toolUse"].get("input", "")
                    if current_tool_id is not None:
                        idx = tool_idx_by_id.get(current_tool_id, 0)
                        yield _chunk(
                            self.model,
                            ChatCompletionDelta(
                                tool_calls=[
                                    ToolCallDelta(
                                        index=idx,
                                        id=current_tool_id,
                                        function=FunctionCallDelta(
                                            name=current_tool_name,
                                            arguments=args_fragment
                                            if isinstance(args_fragment, str)
                                            else json.dumps(args_fragment),
                                        ),
                                    )
                                ]
                            ),
                        )

            # ── Tool-use block start ──────────────────────────────────────
            elif "contentBlockStart" in event:
                start = event["contentBlockStart"].get("start", {})
                if "toolUse" in start:
                    tu = start["toolUse"]
                    current_tool_id = tu["toolUseId"]
                    current_tool_name = tu.get("name")
                    idx = tool_idx_by_id.setdefault(
                        current_tool_id, len(tool_idx_by_id)
                    )
                    yield _chunk(
                        self.model,
                        ChatCompletionDelta(
                            tool_calls=[
                                ToolCallDelta(
                                    index=idx,
                                    id=current_tool_id,
                                    function=FunctionCallDelta(
                                        name=current_tool_name, arguments=""
                                    ),
                                )
                            ]
                        ),
                    )

            # ── Stream metadata (usage) ───────────────────────────────────
            elif "metadata" in event:
                usage = _parse_usage(event["metadata"].get("usage"))
                if usage:
                    yield _chunk(self.model, ChatCompletionDelta(), usage=usage)

            # ── Stop reason ───────────────────────────────────────────────
            elif "messageStop" in event:
                stop_reason = event["messageStop"].get("stopReason")
                logger.debug(
                    "bedrock_stream model={} stop_reason={}", self.model, stop_reason
                )
                yield _chunk(
                    self.model, ChatCompletionDelta(), finish_reason=stop_reason
                )
