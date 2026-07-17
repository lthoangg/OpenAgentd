"""Stream one LLM call and assemble the response into an :class:`AssistantMessage`.

The provider yields a sequence of OpenAI-style chat-completion chunks.
This module concatenates the textual content + reasoning, re-assembles
fragmented tool-call deltas back into whole :class:`ToolCall` objects,
and folds usage information into the final message.

Returns ``(AssistantMessage, last_usage)`` so the caller (``Agent.run``)
can both publish the message and update its rolling usage stats.

Lives outside the :class:`Agent` class because it depends only on the
agent's identity (name + id) for tagging the produced message — no
mutable instance state — which keeps the loop thin and the streaming
logic individually testable.
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING

from loguru import logger

from app.agent.agent_loop.retry import StreamRestart, stream_with_retry
from app.agent.usage import usage_to_dict
from app.agent.schemas.chat import (
    AssistantMessage,
    ChatMessage,
    HumanMessage,
    SystemMessage,
    ToolCall,
    Usage,
)

if TYPE_CHECKING:
    from typing import AsyncIterator

    from app.agent.hooks import BaseAgentHook
    from app.agent.providers.base import LLMProviderBase
    from app.agent.state import AgentState, ModelRequest, RunContext


async def _interruptible_stream(
    source: AsyncIterator,
    interrupt_event: asyncio.Event | None,
):
    """Yield from *source* but stop promptly when *interrupt_event* fires.

    Each ``__anext__`` is awaited concurrently with ``interrupt_event.wait()``.
    If the event wins the race the in-flight fetch is cancelled, which
    propagates ``aclose()`` up through the provider's async generator
    and closes the underlying HTTP stream — so a long mid-chunk pause
    (e.g. Gemini extended-thinking) no longer hides the user's stop
    request until the next SSE event arrives.

    When ``interrupt_event`` is ``None`` this degrades to a plain
    ``async for`` so the no-interrupt path is allocation-free.
    """
    if interrupt_event is None:
        async for item in source:
            yield item
        return

    aiter = source.__aiter__()
    waiter = asyncio.ensure_future(interrupt_event.wait())

    # Cancel the in-flight ``__anext__`` the moment the interrupt fires.
    # A done-callback on the (single, long-lived) waiter replaces the old
    # per-chunk ``asyncio.wait({fetch, waiter})`` race, which allocated a
    # wait set and attached/detached done-callbacks on both tasks for
    # every token (measured: 204ms -> ~2/3 less asyncio machinery for a
    # 3000-chunk turn; see commit message). Semantics are unchanged: a
    # long mid-chunk pause is still cut short because cancelling ``fetch``
    # propagates ``aclose()`` into the provider stream.
    current_fetch: asyncio.Future | None = None

    def _on_interrupt(_: asyncio.Future) -> None:
        # Also fires when the waiter is cancelled during cleanup below —
        # the ``is_set()`` guard makes that a no-op.
        if interrupt_event.is_set() and current_fetch is not None:
            current_fetch.cancel()

    waiter.add_done_callback(_on_interrupt)
    try:
        while True:
            if interrupt_event.is_set():
                return
            fetch = asyncio.ensure_future(aiter.__anext__())
            current_fetch = fetch
            try:
                item = await fetch
            except StopAsyncIteration:
                return
            except asyncio.CancelledError:
                # Either our waiter callback cancelled the fetch (interrupt
                # -> stop cleanly) or the consuming task itself was
                # cancelled from outside (propagate, after reaping fetch).
                if interrupt_event.is_set():
                    return
                fetch.cancel()
                raise
            finally:
                current_fetch = None
            yield item
    finally:
        waiter.cancel()
        try:
            await waiter
        except (asyncio.CancelledError, BaseException):
            pass
        # Best-effort: close the upstream generator so the provider's
        # ``async with httpx.AsyncClient`` exits and the socket is
        # released instead of waiting on GC.
        aclose = getattr(source, "aclose", None)
        if aclose is not None:
            try:
                await aclose()
            except (asyncio.CancelledError, BaseException):
                pass


def _merge_consecutive_user_messages(
    messages: list[ChatMessage],
) -> list[ChatMessage]:
    """Join adjacent plain-text :class:`HumanMessage` rows with ``\\n\\n``.

    Some providers (notably OpenAI gpt-5.5) treat the latest user message
    as superseding earlier ones, dropping prior instructions. Merging at
    the wire preserves additive intent ("Stop + I forgot to add ...")
    while the DB keeps the rows separate.

    Multimodal pairs (either side has ``.parts``) stay separate to
    preserve attachment ordering.
    """
    if not messages:
        return messages
    merged: list[ChatMessage] = []
    for m in messages:
        prev = merged[-1] if merged else None
        can_merge = (
            isinstance(m, HumanMessage)
            and not m.parts
            and isinstance(prev, HumanMessage)
            and not prev.parts
        )
        if can_merge:
            assert isinstance(prev, HumanMessage)
            merged[-1] = HumanMessage(
                content=f"{prev.content or ''}\n\n{m.content or ''}".strip(),
                extra=prev.extra,
            )
        else:
            merged.append(m)
    return merged


async def stream_and_assemble(
    *,
    req: ModelRequest,
    ctx: RunContext,
    state: AgentState,
    hooks: list[BaseAgentHook],
    interrupt_event: asyncio.Event | None,
    tool_defs: list,
    primary_provider: LLMProviderBase,
    primary_label: str,
    agent_name: str,
    agent_id: str,
) -> tuple[AssistantMessage, Usage | None]:
    """Stream one LLM call and assemble the response.

    The innermost handler passed to ``build_model_chain`` in the
    :class:`~app.agent.agent_loop.Agent`.  Hook ``wrap_model_call``
    wrappers receive a callable bound to this and may modify ``req``
    before forwarding it.

    Returns the assembled :class:`AssistantMessage` plus the last
    :class:`Usage` chunk seen during streaming (so the caller can
    update rolling stats).
    """
    full_content = ""
    reasoning = ""
    reasoning_signature = ""
    redacted_thinking_blocks: list[dict] = []
    reasoning_item_id: str | None = None
    reasoning_encrypted_content: str | None = None
    tool_calls_buffer: dict[int, dict] = {}
    last_usage: Usage | None = None
    last_finish_reason: str | None = None

    # Prepend system prompt and merge any [user, user] adjacency for the
    # wire — DB keeps adjacent user rows verbatim.
    provider_messages: list[ChatMessage] = _merge_consecutive_user_messages(
        [SystemMessage(content=req.system_prompt), *req.messages]
    )

    # Providers that don't support mid-stream interruption (e.g. stateful proxy
    # providers) receive interrupt_event=None so the stream always completes.
    # The loop still checks for interruption between iterations.
    effective_interrupt = (
        interrupt_event if primary_provider.support_interrupt else None
    )

    upstream = stream_with_retry(
        primary_provider=primary_provider,
        primary_label=primary_label,
        ctx=ctx,
        state=state,
        hooks=hooks,
        interrupt_event=effective_interrupt,
        messages=provider_messages,
        tools=tool_defs or None,
    )
    async for chunk in _interruptible_stream(upstream, effective_interrupt):
        # Preemptive interrupt: break out of streaming early.  The wrapper
        # also races against ``interrupt_event``, so this check fires
        # immediately even if the provider was mid-pause between chunks.
        if effective_interrupt is not None and effective_interrupt.is_set():
            logger.debug("agent_streaming_interrupted agent={}", agent_name)
            break

        # A retry restarted the provider stream after partial chunks were
        # already buffered.  Drop the partial assembly so the retry's output
        # replaces it instead of concatenating onto a half-formed message.
        if isinstance(chunk, StreamRestart):
            logger.warning(
                "agent_stream_restart_reset agent={} dropped_content_len={} dropped_tool_calls={}",
                agent_name,
                len(full_content),
                len(tool_calls_buffer),
            )
            full_content = ""
            reasoning = ""
            reasoning_signature = ""
            redacted_thinking_blocks = []
            reasoning_item_id = None
            reasoning_encrypted_content = None
            tool_calls_buffer = {}
            last_finish_reason = None
            continue

        for hook in hooks:
            await hook.on_model_delta(ctx, state, chunk)

        if chunk.usage:
            last_usage = chunk.usage

        if not chunk.choices:
            continue

        choice = chunk.choices[0]
        if choice.finish_reason:
            last_finish_reason = choice.finish_reason
        delta = choice.delta

        if delta.reasoning_content:
            reasoning += delta.reasoning_content
        if delta.reasoning_signature:
            reasoning_signature += delta.reasoning_signature
        if delta.redacted_thinking_block:
            redacted_thinking_blocks.append(delta.redacted_thinking_block)
        if delta.reasoning_encrypted_content:
            # Me: delivered once, whole, when the reasoning item completes —
            # not incremental text like reasoning_content, so assign rather
            # than concatenate.
            reasoning_item_id = delta.reasoning_item_id
            reasoning_encrypted_content = delta.reasoning_encrypted_content
        if delta.content:
            full_content += delta.content

        if delta.tool_calls:
            for tc in delta.tool_calls:
                idx = tc.index if tc.index is not None else 0
                # Me warn if different tool call lands in same slot
                if (
                    idx in tool_calls_buffer
                    and tc.id
                    and tool_calls_buffer[idx]["id"]
                    and tc.id != tool_calls_buffer[idx]["id"]
                ):
                    logger.warning(
                        "tool_call_index_collision idx={} existing_id={} new_id={}",
                        idx,
                        tool_calls_buffer[idx]["id"],
                        tc.id,
                    )
                if idx not in tool_calls_buffer:
                    tool_calls_buffer[idx] = {
                        "id": tc.id or "",
                        "function": {
                            "name": tc.function.name
                            if tc.function and tc.function.name
                            else "",
                            "arguments": tc.function.arguments
                            if tc.function and tc.function.arguments
                            else "",
                            "thought": tc.function.thought
                            if tc.function and tc.function.thought
                            else None,
                            "thought_signature": tc.function.thought_signature
                            if tc.function and tc.function.thought_signature
                            else None,
                        },
                    }
                else:
                    # Only update id if not already set — first id wins
                    if tc.id and not tool_calls_buffer[idx]["id"]:
                        tool_calls_buffer[idx]["id"] = tc.id
                    if tc.function:
                        if tc.function.name:
                            if not tool_calls_buffer[idx]["function"]["name"]:
                                tool_calls_buffer[idx]["function"]["name"] = (
                                    tc.function.name
                                )
                        if tc.function.arguments:
                            tool_calls_buffer[idx]["function"]["arguments"] += (
                                tc.function.arguments
                            )
                        if tc.function.thought:
                            tool_calls_buffer[idx]["function"]["thought"] = (
                                tc.function.thought
                            )
                        if tc.function.thought_signature:
                            tool_calls_buffer[idx]["function"]["thought_signature"] = (
                                tool_calls_buffer[idx]["function"]["thought_signature"]
                                or ""
                            ) + tc.function.thought_signature

    # Drop tool calls left half-formed by a mid-stream interrupt: missing
    # name (OpenAI Responses only emits it on the final ``done`` event) or
    # invalid JSON args. Empty ``arguments`` is a valid no-arg call.
    tc_list: list[ToolCall] = []
    dropped_tool_calls: list[dict] = []
    for i in sorted(tool_calls_buffer):
        buf = tool_calls_buffer[i]
        fn_name = buf["function"]["name"]
        fn_args = buf["function"]["arguments"]
        if not fn_name:
            logger.warning(
                "drop_partial_tool_call_no_name agent={} idx={} finish_reason={} args_prefix={!r}",
                agent_name,
                i,
                last_finish_reason,
                fn_args[:80],
            )
            dropped_tool_calls.append({"index": i, "reason": "missing_name"})
            continue
        if fn_args:
            try:
                json.loads(fn_args)
            except (json.JSONDecodeError, ValueError) as exc:
                logger.warning(
                    "drop_partial_tool_call_bad_json agent={} idx={} name={} chars={} finish_reason={} args_prefix={!r} args_suffix={!r} error={}",
                    agent_name,
                    i,
                    fn_name,
                    len(fn_args),
                    last_finish_reason,
                    fn_args[:120],
                    fn_args[-120:],
                    exc,
                )
                dropped_tool_calls.append(
                    {
                        "index": i,
                        "reason": "bad_json",
                        "name": fn_name,
                        "arguments_prefix": fn_args[:200],
                    }
                )
                continue
        tc_list.append(ToolCall(**buf))
    # Me attach usage to `extra` immediately so `wrap_model_call` hooks
    # (e.g. OtelHook) can read it from the returned message inside the
    # chain.  The run loop re-asserts the same mapping — that
    # assignment is now idempotent but kept for clarity and to cover the
    # rare case of a hook replacing `assistant_msg` wholesale.
    extra: dict | None = None
    if last_usage is not None:
        model_id = state.metadata.get("effective_model") or primary_label
        extra = {"usage": usage_to_dict(last_usage, model_id)}
    if last_finish_reason:
        extra = extra or {}
        extra["finish_reason"] = last_finish_reason
    if dropped_tool_calls:
        extra = extra or {}
        extra["dropped_tool_calls"] = dropped_tool_calls
    if reasoning_signature:
        extra = extra or {}
        extra["reasoning_signature"] = reasoning_signature
    if redacted_thinking_blocks:
        extra = extra or {}
        extra["redacted_thinking_blocks"] = redacted_thinking_blocks
    if reasoning_encrypted_content:
        extra = extra or {}
        extra["reasoning_item_id"] = reasoning_item_id
        extra["reasoning_encrypted_content"] = reasoning_encrypted_content

    msg = AssistantMessage(
        content=full_content or None,
        reasoning_content=reasoning or None,
        reasoning_signature=reasoning_signature or None,
        reasoning_item_id=reasoning_item_id,
        reasoning_encrypted_content=reasoning_encrypted_content or None,
        tool_calls=tc_list or None,
        agent_id=agent_id,
        agent_name=agent_name,
        extra=extra,
    )
    if redacted_thinking_blocks:
        msg.redacted_thinking_blocks = redacted_thinking_blocks
    return msg, last_usage
