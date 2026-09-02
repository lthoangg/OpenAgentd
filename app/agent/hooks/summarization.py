"""SummarizationHook — keeps context windows small without losing history.

How it works
------------
At the start of each LLM call (``before_model``), the hook reads
``state.usage.last_prompt_tokens`` — written by the agent loop after each
model response.  If that count meets or exceeds ``prompt_token_threshold``,
the hook:

1. Reads all *visible* messages from ``state.messages``
   (``exclude_from_context=False``).
2. Finds the last ``keep_last_assistants`` assistant turns and protects all
   messages from the earliest of those turns onward.
3. Calls the LLM with a summarisation prompt to produce a compact summary of
   all older messages.
4. Inserts the summary ``HumanMessage`` (``is_summary=True``) into
   ``state.messages`` at the position of the first non-excluded message.
5. Marks summarised messages as ``exclude_from_context=True`` — retained in
   the list for audit but invisible to future LLM calls.

This is a **pure state transform**: no DB reads or writes occur here.
The checkpointer (called by the agent loop after ``before_model``) is
responsible for persisting the mutated ``state.messages``.

Timing — support_interrupt
--------------------------
``support_interrupt=True`` (default): summarisation may fire at any
``before_model`` boundary within a turn, including mid-loop between tool
calls.  Safe because the user can interrupt the loop at any time.

``support_interrupt=False`` (proxy/quota-tracked providers): summarisation
is deferred to the **user-turn boundary** — the first ``before_model`` call
of a new turn, before the agent has produced any output.  Mid-loop compaction
is skipped to avoid disrupting an in-progress agentic task on a provider
whose stream cannot be safely aborted.  ``force_summarization=True`` in
``state.metadata`` overrides this deferral unconditionally.

``build_summarization_hook`` reads ``provider.support_interrupt`` automatically
when called from ``member.py``, so no manual wiring is needed.

Usage::

    from app.agent.hooks.summarization import SummarizationHook

    mw = SummarizationHook(
        llm_provider=provider,
        prompt_token_threshold=30000,  # trigger when model reports 30k prompt tokens
        keep_last_assistants=3,        # keep last 3 assistant turns verbatim
    )
    agent = Agent(llm_provider=provider, hooks=[mw])
"""

from __future__ import annotations

import json
import time
from collections.abc import Sequence
from typing import TYPE_CHECKING, Awaitable, Callable

from loguru import logger
from opentelemetry.trace import SpanKind, StatusCode

from app.agent.usage import (
    provider_cost_model_id,
    set_usage_span_attributes,
    usage_to_dict,
)
from app.agent.hooks.base import BaseAgentHook
from app.agent.providers.base import LLMProviderBase
from app.agent.providers.model_metadata import get_model_limits
from app.agent.schemas.chat import (
    AssistantMessage,
    ChatMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from app.agent.schemas.events import (
    SummarizationContentEvent,
    SummarizationEndEvent,
    SummarizationStartEvent,
    UsageEvent,
)
from app.core.otel import get_tracer
from app.services.stream_envelope import StreamEnvelope

if TYPE_CHECKING:
    from app.agent.state import AgentState, ModelCallHandler, ModelRequest, RunContext

# ── Module-level defaults ─────────────────────────────────────────────────
# These are the single source of truth for summarisation tuning. There is no
# per-agent override and no file-based override — change the values here to
# reconfigure summarisation.
#
# Both the prompt and the ``keep_last_assistants`` window are mode-aware:
#
# * CHAT mode (default): prose summary, keep last ``DEFAULT_KEEP_LAST_ASSISTANTS``
#   assistant turns verbatim so the next reply has recent conversational
#   context.
# * CODING mode: structured Markdown summary, ``keep_last_assistants=0`` so
#   the full pre-threshold history collapses into the summary. Coding sessions
#   benefit from a single authoritative "state of the world" record over
#   partially-summarised history.
DEFAULT_PROMPT_TOKEN_THRESHOLD = 250000
PROMPT_TOKEN_THRESHOLD_CONTEXT_RATIO = 0.9
DEFAULT_KEEP_LAST_ASSISTANTS = 3
CODING_KEEP_LAST_ASSISTANTS = 0
DEFAULT_MAX_TOKEN_LENGTH = 30000
DEFAULT_MIN_MESSAGES_SINCE_LAST_SUMMARY = 4


# ── Bundled summariser prompts ────────────────────────────────────────────
# CHAT mode: terse third-person narrative — works well for open-ended
# assistant conversations where structure would feel out of place.
CHAT_SUMMARY_PROMPT = (
    "You are a conversation summariser. Produce a concise but complete handoff "
    "summary of the conversation so far. Preserve the user's goal, constraints, "
    "preferences, important facts, decisions, outcomes, blockers, and any active "
    "or unfinished task. If work is in progress, include the current state and "
    "the immediate next step so the assistant can continue without another user "
    "prompt. Preserve exact names, identifiers, commands, file paths, error "
    "strings, and other details needed for continuity. Do not summarize, "
    "paraphrase, or quote skill instruction tool results; skill instruction "
    "blocks are preserved separately in context. Mention only that a skill "
    "remains loaded when relevant. Write in third-person narrative form. "
    "Return only the summary text. Do not include pleasantries or meta-commentary."
)


# CODING mode: structured Markdown template the model fills in.  Empirically
# preserves much more actionable state for follow-up turns than free-form
# prose (file paths, errors, blockers, next steps). Borrowed from the
# opencode project (anomalyco/opencode session/compaction.ts).
CODING_SUMMARY_PROMPT = """\
Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]

### In Progress
- [current work or "(none)"]

### Blocked
- [blockers or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Start your response with exactly `## Goal`.
- Synthesize the history into the template; do not copy, replay, or lightly reformat the transcript.
- Do not output raw role/tool prefixes such as `[user]:`, `[assistant]:`, `[tool/shell]:`, or `[main ...]`.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Do not summarize, paraphrase, or quote skill instruction tool results; skill instruction blocks are preserved separately in context. Mention only that a skill remains loaded when relevant.
- Return only the summary text.
- Do not mention the summary process or that context was compacted."""


def prompt_for_mode(mode: str | None) -> str:
    """Return the bundled summariser prompt for a given session mode.

    ``mode == "coding"`` → :data:`CODING_SUMMARY_PROMPT`. Anything else
    (including ``None``) → :data:`CHAT_SUMMARY_PROMPT`.
    """
    return CODING_SUMMARY_PROMPT if mode == "coding" else CHAT_SUMMARY_PROMPT


def keep_last_for_mode(mode: str | None) -> int:
    """Return the ``keep_last_assistants`` window for a given session mode.

    ``mode == "coding"`` → :data:`CODING_KEEP_LAST_ASSISTANTS` (0 — summarise
    everything). Anything else → :data:`DEFAULT_KEEP_LAST_ASSISTANTS`.
    """
    return (
        CODING_KEEP_LAST_ASSISTANTS
        if mode == "coding"
        else DEFAULT_KEEP_LAST_ASSISTANTS
    )


_SUMMARISE_REQUEST = (
    "Please summarise the conversation above according to your instructions. "
    "Return only the requested summary, not the raw transcript."
)

# Merge wording borrowed from opencode's compaction.ts — explicitly tells
# the model what to do with the prior summary rather than leaving it to
# interpret "merge".
_MERGE_REQUEST = (
    "Update the anchored summary in the conversation above using the newer "
    "conversation history above. Preserve still-true details, remove stale "
    "details, and merge in the new facts."
)


def _find_assistant_cutoff(msgs: Sequence[ChatMessage], keep_last: int) -> int:
    """Return the index of the Nth-from-last assistant message in *msgs*.

    Messages at or after this index are protected from summarisation; the
    caller summarises ``msgs[:cutoff]``.

    Two boundary values are **not** slice offsets and the caller special-cases
    both to mean "summarise everything":

    * ``len(msgs)`` — ``keep_last <= 0``, so nothing is protected.
    * ``0`` — fewer than *keep_last* assistant turns exist, so no valid keep
      window can be built. The caller deliberately compacts the whole visible
      history in this case (see
      ``test_summarise_all_messages_when_not_enough_assistant_turns``): the
      token threshold has already been exceeded, and protecting everything
      would leave the context permanently un-compactable.
    """
    if keep_last <= 0:
        return len(msgs)
    remaining = keep_last
    for i in range(len(msgs) - 1, -1, -1):
        if msgs[i].role == "assistant":
            remaining -= 1
            if remaining == 0:
                return i
    return 0  # not enough assistant turns — protect everything


def _expand_tool_pair_ids(
    messages: Sequence[ChatMessage], seed_ids: set[int]
) -> set[int]:
    """Expand *seed_ids* so assistant/tool-call pairs stay together.

    Compaction must not hide only one side of an assistant→tool exchange: OpenAI
    rejects orphan ``tool`` rows, and preserving an assistant ``tool_calls`` row
    without all of its tool outputs leaves an incomplete call. Treat each
    visible assistant/tool-call group as an atomic unit when deciding what to
    summarise or preserve.
    """
    if not seed_ids:
        return set()

    assistant_ids_by_call: dict[str, set[int]] = {}
    tool_ids_by_call: dict[str, set[int]] = {}

    for m in messages:
        if isinstance(m, AssistantMessage) and m.tool_calls:
            for tc in m.tool_calls:
                if tc.id:
                    assistant_ids_by_call.setdefault(tc.id, set()).add(id(m))
        elif isinstance(m, ToolMessage) and m.tool_call_id:
            tool_ids_by_call.setdefault(m.tool_call_id, set()).add(id(m))

    expanded = set(seed_ids)
    changed = True
    while changed:
        changed = False
        for m in messages:
            if id(m) not in expanded:
                continue
            related: set[int] = set()
            if isinstance(m, AssistantMessage) and m.tool_calls:
                for tc in m.tool_calls:
                    related.update(tool_ids_by_call.get(tc.id, set()))
            elif isinstance(m, ToolMessage) and m.tool_call_id:
                related.update(assistant_ids_by_call.get(m.tool_call_id, set()))

            new_ids = related - expanded
            if new_ids:
                expanded.update(new_ids)
                changed = True

    return expanded


def _skill_tool_pair_ids(messages: Sequence[ChatMessage]) -> set[int]:
    """Return ids for the first visible assistant→skill tool-result pair per skill.

    Skill tool results contain active instruction text. During compaction they
    must remain in the provider-visible transcript so the agent can keep using
    the loaded skill without calling the tool again. Preserve only the first
    successful load per skill so duplicate "already loaded" pairs can compact
    away instead of accumulating forever. Preserve the assistant ``tool_calls``
    message as well so provider tool-call ordering stays valid.
    """
    skill_call_ids: set[str] = set()
    message_ids: set[int] = set()
    seen_skills: set[str] = set()

    for m in messages:
        if isinstance(m, AssistantMessage) and m.tool_calls:
            for tc in m.tool_calls:
                if not tc.id or tc.function.name != "skill":
                    continue
                try:
                    args = json.loads(tc.function.arguments or "{}")
                except (TypeError, json.JSONDecodeError):
                    continue
                skill_name = args.get("skill_name")
                if not isinstance(skill_name, str) or not skill_name:
                    continue
                if skill_name in seen_skills:
                    continue
                seen_skills.add(skill_name)
                skill_call_ids.add(tc.id)
                message_ids.add(id(m))

    if not skill_call_ids:
        return set()

    for m in messages:
        if isinstance(m, ToolMessage) and m.tool_call_id in skill_call_ids:
            message_ids.add(id(m))

    return _expand_tool_pair_ids(messages, message_ids)


def prompt_token_threshold_for_model(model_id: str | None) -> int:
    """Return the auto-computed summarisation threshold for *model_id*.

    Formula: ``prompt_capacity * PROMPT_TOKEN_THRESHOLD_CONTEXT_RATIO``.
    ``prompt_capacity`` is the lower of the model's total context and explicit
    input limit when both are known. Falls back to
    :data:`DEFAULT_PROMPT_TOKEN_THRESHOLD` for unknown models. There is no
    artificial upper cap — a 10M prompt capacity correctly gets a 9M
    threshold. This value is the **ceiling** used by
    :func:`resolve_prompt_token_threshold`.
    """
    limits = get_model_limits(model_id)
    known_prompt_limits = tuple(
        value
        for value in (limits.context_length, limits.max_input_tokens)
        if value is not None
    )
    if not known_prompt_limits:
        return DEFAULT_PROMPT_TOKEN_THRESHOLD
    return int(min(known_prompt_limits) * PROMPT_TOKEN_THRESHOLD_CONTEXT_RATIO)


def resolve_prompt_token_threshold(
    model_id: str | None,
    custom_threshold: int | None,
) -> int:
    """Return the effective summarisation threshold, applying any user override.

    Logic:

    * ``custom_threshold`` is ``None`` → use the auto-computed value.
    * ``custom_threshold >= auto`` → use the auto-computed value (custom is
      too high to change anything — it would never fire before the ceiling).
    * ``custom_threshold < auto`` → use ``custom_threshold`` (triggers earlier
      than the default, as requested by the user).

    The setting can only *lower* the trigger; it can never raise it above the
    model-aware ceiling.
    """
    auto = prompt_token_threshold_for_model(model_id)
    if custom_threshold is None or custom_threshold >= auto:
        return auto
    return custom_threshold


def build_summarization_hook(
    default_provider: LLMProviderBase,
    *,
    mode: str | None = None,
    model_id: str | None = None,
    support_interrupt: bool = True,
) -> "SummarizationHook | None":
    """Return a configured SummarizationHook, or ``None`` if disabled.

    Reads the user-configured ``summarization.prompt_token_threshold`` from
    ``settings.yaml`` via :func:`resolve_prompt_token_threshold` — when absent
    the auto-computed model-aware threshold is used; when present and lower than
    the auto value the custom value is used.  Returns ``None`` when
    ``DEFAULT_PROMPT_TOKEN_THRESHOLD <= 0`` (operator-level kill switch).

    The summariser provider is the caller's ``default_provider`` (typically
    the agent's own LLM provider). Both the summariser PROMPT and the
    ``keep_last_assistants`` window are mode-aware:

    * ``mode == "coding"`` → :data:`CODING_SUMMARY_PROMPT` +
      :data:`CODING_KEEP_LAST_ASSISTANTS` (0 — summarise everything).
    * Anything else → :data:`CHAT_SUMMARY_PROMPT` +
      :data:`DEFAULT_KEEP_LAST_ASSISTANTS`.

    ``support_interrupt`` mirrors the provider flag of the same name.  When
    ``False`` (e.g. quota-tracked proxy providers), summarisation is deferred
    to the **user-turn boundary** — the very first ``before_model`` call of a
    new turn, before the agent has produced any output.  This prevents
    mid-loop compaction for providers where an interrupt cannot safely abort
    an in-flight stream.
    """
    if DEFAULT_PROMPT_TOKEN_THRESHOLD <= 0:
        return None

    from app.core.runtime_settings import load_runtime_settings

    try:
        custom_threshold = load_runtime_settings().summarization.prompt_token_threshold
    except Exception:
        custom_threshold = None

    limits = get_model_limits(model_id)
    max_token_length = DEFAULT_MAX_TOKEN_LENGTH
    if limits.max_completion_tokens is not None:
        max_token_length = min(DEFAULT_MAX_TOKEN_LENGTH, limits.max_completion_tokens)

    auto_threshold = prompt_token_threshold_for_model(model_id)
    effective_threshold = resolve_prompt_token_threshold(model_id, custom_threshold)
    logger.info(
        "summarization_config model={} context_length={} max_input_tokens={} "
        "auto_threshold={} custom_threshold={} effective_threshold={}",
        model_id,
        limits.context_length,
        limits.max_input_tokens,
        auto_threshold,
        custom_threshold,
        effective_threshold,
    )

    return SummarizationHook(
        default_provider,
        summary_prompt=prompt_for_mode(mode),
        model_id=model_id,
        prompt_token_threshold=effective_threshold,
        keep_last_assistants=keep_last_for_mode(mode),
        max_token_length=max_token_length,
        support_interrupt=support_interrupt,
    )


class SummarizationHook(BaseAgentHook):
    """Summarises session history before an LLM call when the context is too large.

    Mutates ``state.messages`` — adds a summary message and marks old messages
    as ``exclude_from_context=True``.

    Parameters
    ----------
    llm_provider:
        LLM provider used to generate the summary.
    summary_prompt:
        System prompt given to the summariser LLM. Required — must be
        non-empty. ``build_summarization_hook`` selects this from
        :data:`CHAT_SUMMARY_PROMPT` / :data:`CODING_SUMMARY_PROMPT` based
        on the session mode.
    prompt_token_threshold:
        Trigger when ``state.usage.last_prompt_tokens`` meets or exceeds this
        value.  Set to ``0`` to disable.
    keep_last_assistants:
        Number of most-recent *assistant turns* to keep verbatim alongside the
        summary.  All messages belonging to those turns (including the user
        messages that preceded them) are protected.
    max_token_length:
        Maximum tokens for the summarizer LLM response. Passed as ``max_tokens``
        to the LLM provider API call. Set to ``0`` to disable limit.
    min_messages_since_last_summary:
        Minimum number of new messages that must have been added since the last
        summarisation before another can fire.  Prevents thrashing when the
        kept window is already close to the threshold.  Set to ``0`` to disable.
    support_interrupt:
        Mirrors the provider flag of the same name.  When ``True`` (default),
        summarisation may fire at any ``before_model`` boundary within a turn
        — safe because the user can interrupt mid-loop.  When ``False``
        (e.g. quota-tracked proxy providers), summarisation is deferred to the
        **user-turn boundary**: it only fires when the last visible message is
        a ``HumanMessage``, meaning the agent loop has not yet produced any
        output for this turn.  This prevents mid-loop compaction for providers
        that cannot safely abort an in-flight stream.
    """

    def __init__(
        self,
        llm_provider: LLMProviderBase,
        summary_prompt: str,
        *,
        model_id: str | None = None,
        prompt_token_threshold: int = DEFAULT_PROMPT_TOKEN_THRESHOLD,
        keep_last_assistants: int = DEFAULT_KEEP_LAST_ASSISTANTS,
        max_token_length: int = DEFAULT_MAX_TOKEN_LENGTH,
        min_messages_since_last_summary: int = DEFAULT_MIN_MESSAGES_SINCE_LAST_SUMMARY,
        support_interrupt: bool = True,
    ) -> None:
        if not summary_prompt or not summary_prompt.strip():
            raise ValueError(
                "SummarizationHook requires a non-empty summary_prompt — "
                "pass one of the bundled constants (CHAT_SUMMARY_PROMPT / "
                "CODING_SUMMARY_PROMPT) or use build_summarization_hook()."
            )
        self._llm_provider = llm_provider
        self._model_id = model_id
        self._prompt_token_threshold = prompt_token_threshold
        self._keep_last_assistants = keep_last_assistants
        self._summary_prompt = summary_prompt
        self._max_token_length = max_token_length
        self._min_messages_since_last_summary = min_messages_since_last_summary
        self._support_interrupt = support_interrupt
        # Snapshot of len(state.messages) at the last summarisation — used
        # by the minimum-delta guard in before_model to prevent thrashing.
        self._messages_at_last_summary: int = 0
        self._pending_summary: tuple["RunContext", "AgentState"] | None = None

    @property
    def prompt_token_threshold(self) -> int:
        """Token count at which summarisation fires.  Public for peer hooks."""
        return self._prompt_token_threshold

    @staticmethod
    def _at_user_turn_boundary(state: "AgentState") -> bool:
        """Return ``True`` when the agent loop is at the start of a new user turn.

        A *genuine* user-turn boundary requires the last visible non-system
        message to be a real ``HumanMessage`` from the user (or the queued
        message drain), not one of the several synthetic ``HumanMessage``
        variants that can appear mid-loop:

        * **Inbox message from another agent** — ``extra["from_agent"]`` is set
          to an agent name other than ``"user"``.  These are injected by
          an inbox hook between LLM iterations and must not
          be mistaken for a user-turn start.
        * **Summary message** — ``is_summary=True``.  Summaries are
          ``HumanMessage`` rows but they anchor past history, not new user input.
        * **``/continue`` directive and mention context blocks** — carry
          ``extra["hidden_from_summary"] = True`` to signal they are internal
          plumbing, not user-facing input.

        All three cases return ``False`` even though the last message is a
        ``HumanMessage``.  An empty visible window returns ``True`` (no output
        has been produced yet for this turn).
        """
        visible = [
            m
            for m in state.messages
            if not m.exclude_from_context and not isinstance(m, SystemMessage)
        ]
        if not visible:
            return True
        last = visible[-1]
        if not isinstance(last, HumanMessage):
            return False
        # Summary messages are HumanMessage rows but not user input.
        if last.is_summary:
            return False
        extra = last.extra or {}
        # Internal synthetics (/continue directive, mention context blocks).
        if extra.get("hidden_from_summary"):
            return False
        # Queued messages injected while the turn is running.
        from_agent = extra.get("from_agent")
        if from_agent is not None and from_agent != "user":
            return False
        return True

    async def before_model(
        self,
        ctx: "RunContext",
        state: "AgentState",
        request: "ModelRequest | None" = None,
    ) -> "ModelRequest | None":
        """Trigger summarisation if the previous call's prompt tokens hit the threshold.

        Mutates ``state.messages`` then returns a new ``ModelRequest`` with the
        updated message window so the current LLM call sees the summary immediately.
        Returns ``None`` (pass-through) when summarisation does not fire.

        When ``support_interrupt=False``, summarisation is additionally gated on
        being at the **user-turn boundary** (the last visible message is a
        ``HumanMessage``).  This defers compaction to the start of a new turn
        rather than firing mid-loop, matching the constraint that these providers
        cannot safely abort an in-flight stream.
        """
        force = state.metadata.get("force_summarization") is True
        if self._prompt_token_threshold <= 0 and not force:
            return None

        if state.usage.last_prompt_tokens < self._prompt_token_threshold and not force:
            return None

        if self._min_messages_since_last_summary > 0 and not force:
            messages_since = len(state.messages) - self._messages_at_last_summary
            if (
                self._messages_at_last_summary > 0
                and messages_since < self._min_messages_since_last_summary
            ):
                logger.debug(
                    "summarization_skipped_min_delta agent={} messages_since={} min={}",
                    ctx.agent_name,
                    messages_since,
                    self._min_messages_since_last_summary,
                )
                return None

        # For non-interruptible providers, defer summarisation to the start of
        # the next user turn.  Mid-loop compaction is unsafe for these providers
        # because the current agent loop cannot be aborted.
        if not self._support_interrupt and not force:
            if not self._at_user_turn_boundary(state):
                logger.debug(
                    "summarization_deferred_mid_loop agent={} last_prompt_tokens={}",
                    ctx.agent_name,
                    state.usage.last_prompt_tokens,
                )
                return None

        logger.info(
            "summarization_triggered agent={} last_prompt_tokens={}",
            ctx.agent_name,
            state.usage.last_prompt_tokens,
        )
        self._pending_summary = (ctx, state)

        # The actual summariser LLM call runs from wrap_model_call(), after
        # earlier prompt-building wrappers (date, memory, agent protocol,
        # workspace instructions, etc.) have produced the same system prompt
        # the normal chat call would use. That keeps summarisation shaped like
        # a normal request with one extra final user instruction, preserving
        # provider prefix-cache reuse.
        return None

    async def wrap_model_call(
        self,
        ctx: "RunContext",
        state: "AgentState",
        request: "ModelRequest",
        handler: "ModelCallHandler",
    ) -> AssistantMessage:
        if self._pending_summary is None:
            return await handler(request)

        pending_ctx, pending_state = self._pending_summary
        if pending_ctx is not ctx or pending_state is not state:
            return await handler(request)

        self._pending_summary = None
        await self._summarise(ctx, state, system_prompt=request.system_prompt)

        # Return a fresh request so the current LLM call sees the summary
        # immediately, without the loop needing to rebuild the message list.
        return await handler(request.override(messages=tuple(state.messages_for_llm)))

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _summarise(
        self,
        ctx: "RunContext",
        state: "AgentState",
        *,
        system_prompt: str | None = None,
    ) -> None:
        """Generate summary and mutate state.messages — pure state transform + LLM call."""
        logger.info(
            "summarization_started session_id={} agent={}",
            ctx.session_id,
            ctx.agent_name,
        )

        tracer = get_tracer()
        with tracer.start_as_current_span(
            "summarization",
            kind=SpanKind.INTERNAL,
            attributes={
                "gen_ai.agent.name": ctx.agent_name or "",
                "gen_ai.conversation.id": ctx.session_id or "",
                "run_id": ctx.run_id,
                "summarization.prompt_tokens": state.usage.last_prompt_tokens,
                "summarization.threshold": self._prompt_token_threshold,
            },
        ) as span:
            await self._summarise_inner(ctx, state, span, system_prompt=system_prompt)

    async def _summarise_inner(
        self,
        ctx: "RunContext",
        state: "AgentState",
        span,
        *,
        system_prompt: str | None = None,
    ) -> None:
        """Core summarisation logic, called inside the OTel span."""
        # The agent loop injects SystemMessage separately per call, so it
        # must never enter the summariser's view.
        eligible = [
            m
            for m in state.messages
            if not m.exclude_from_context
            and not isinstance(m, SystemMessage)
            and not (m.extra and m.extra.get("hidden_from_summary"))
        ]

        if not eligible:
            logger.debug(
                "summarization_skipped_no_messages session_id={}", ctx.session_id
            )
            span.set_attribute("summarization.skipped", "no_messages")
            span.set_status(StatusCode.OK)
            return

        # ``0`` means no valid keep window exists (fewer assistant turns than
        # ``keep_last_assistants``). Compact everything rather than skip: the
        # threshold has already been exceeded, so skipping would let the
        # context keep growing with no way to ever shrink it.
        cutoff_idx = _find_assistant_cutoff(eligible, self._keep_last_assistants)
        if cutoff_idx > 0:
            to_summarise = eligible[:cutoff_idx]
        else:
            to_summarise = eligible

        to_summarise_ids = _expand_tool_pair_ids(
            eligible, {id(m) for m in to_summarise}
        )
        retained_skill_ids = _skill_tool_pair_ids(eligible)
        to_summarise = [m for m in eligible if id(m) in to_summarise_ids]

        if not to_summarise:
            logger.debug(
                "summarization_skipped_all_messages_in_keep_window session_id={}",
                ctx.session_id,
            )
            span.set_attribute("summarization.skipped", "all_in_keep_window")
            span.set_status(StatusCode.OK)
            return

        # Keep the original messages as the provider-visible prefix and append
        # compaction instructions as the final user message. This preserves
        # prompt-cache reuse from the normal chat/coding request that just
        # overflowed; replacing the system prompt or flattening the transcript
        # into one user blob makes the compaction call diverge at token 1 and
        # yields near-zero cache hits.
        has_prior_summary = any(m.is_summary for m in to_summarise)
        request_line = _MERGE_REQUEST if has_prior_summary else _SUMMARISE_REQUEST
        prompt = system_prompt if system_prompt is not None else state.system_prompt
        summariser_messages = [
            *([SystemMessage(content=prompt)] if prompt else []),
            *to_summarise,
            HumanMessage(content=f"{request_line}\n\n{self._summary_prompt}"),
        ]

        span.set_attribute("summarization.messages_to_summarise", len(to_summarise))
        span.set_attribute(
            "summarization.keep_last_assistants", self._keep_last_assistants
        )
        span.set_attribute("summarization.has_prior_summary", has_prior_summary)

        # SSE start/content/end drive the frontend "Session compacting"
        # divider. session_id is None for headless/test runs — skip then.
        agent_name = ctx.agent_name or ""
        emit_session_id = ctx.session_id

        on_delta: Callable[[str], Awaitable[None]] | None = None
        if emit_session_id:
            await self._emit_start(emit_session_id, agent_name)
            on_delta = self._make_delta_emitter(emit_session_id, agent_name)

        try:
            summary_text, summariser_usage = await self._call_llm(
                ctx,
                summariser_messages,
                tools=state.tool_defs or None,
                on_delta=on_delta,
            )
        except Exception as exc:
            logger.error(
                "summarization_llm_failed session_id={} error={}",
                ctx.session_id,
                exc,
            )
            span.set_attribute("error.type", type(exc).__name__)
            span.set_status(StatusCode.ERROR, str(exc))
            if emit_session_id:
                await self._emit_end(
                    emit_session_id, agent_name, summary="", error=True
                )
            return

        if not summary_text:
            logger.warning(
                "summarization_skipped_empty_response session_id={} agent={}",
                ctx.session_id,
                ctx.agent_name,
            )
            span.set_attribute("summarization.skipped", "empty_llm_response")
            span.set_status(StatusCode.OK)
            if emit_session_id:
                await self._emit_end(
                    emit_session_id, agent_name, summary="", error=True
                )
            return

        to_summarise_set = {id(m) for m in to_summarise}
        for m in state.messages:
            if id(m) in to_summarise_set and id(m) not in retained_skill_ids:
                m.exclude_from_context = True
                # Compacted rows lose position-independent membership — a
                # previously retained skill pair that just got superseded by a
                # newer load of the same skill compacts away like anything
                # else. The checkpointer flushes the flip.
                m.pinned = False

        # Exclude any prior summary still in the kept window — the new
        # summary supersedes it, and two summaries in a row can produce
        # consecutive-assistant-message violations (ZAI code 1214).
        for m in state.messages:
            if m.is_summary and id(m) not in to_summarise_set:
                m.exclude_from_context = True

        retained_skill_indexes = [
            i for i, m in enumerate(state.messages) if id(m) in retained_skill_ids
        ]
        if retained_skill_indexes:
            first_kept_idx = max(retained_skill_indexes) + 1
        else:
            first_kept_idx = next(
                (i for i, m in enumerate(state.messages) if not m.exclude_from_context),
                len(state.messages),
            )

        # Invariant for the derived DB window: no excluded message may sit
        # *after* the summary's position — coverage is positional
        # (seq >= summary), so a straddled excluded row above the anchor
        # would silently re-enter the window on reload. Tool-pair expansion
        # can exclude rows past the first kept one; place the summary after
        # the last excluded row in that case.
        last_excluded_idx = next(
            (
                i
                for i in range(len(state.messages) - 1, -1, -1)
                if state.messages[i].exclude_from_context
            ),
            -1,
        )
        first_kept_idx = max(first_kept_idx, last_excluded_idx + 1)

        # Everything that survives *below* the summary's anchor position is
        # position-independent by definition (retained skill pairs, permanent
        # notes, and any kept row the anchor ended up past). Pin them so the
        # derived DB window — pinned rows + rows at/after the summary —
        # reproduces exactly this in-memory window on reload.
        for m in state.messages[:first_kept_idx]:
            if not m.exclude_from_context and not isinstance(m, SystemMessage):
                m.pinned = True

        # HumanMessage as the summary anchor: ZAI and most OpenAI-compat
        # APIs require system → user → … so this shape is safe regardless
        # of what the kept window starts with. The summary text itself is
        # stored verbatim — no prefix — so it renders cleanly in the UI
        # divider; the ``is_summary=True`` flag is the marker the LLM and
        # the frontend both key off of.
        # The summariser's own usage (a real, billed model call) rides along
        # in ``extra["usage"]`` — the same shape every assistant row persists —
        # so the client's reload path (``sumUsageFromMessages``) keeps the
        # compaction cost in the session's running sum.
        summary_msg = HumanMessage(
            content=summary_text,
            is_summary=True,
            extra={"usage": summariser_usage} if summariser_usage else None,
        )
        state.messages.insert(first_kept_idx, summary_msg)
        # checkpointer.sync() (called by the loop after before_model)
        # persists the mutated state.messages.

        self._messages_at_last_summary = len(state.messages)

        kept = len(eligible) - len(to_summarise)
        span.set_attribute("summarization.summary_length", len(summary_text))
        span.set_attribute("summarization.kept", kept)
        span.set_status(StatusCode.OK)

        if emit_session_id:
            if summariser_usage:
                await self._emit_usage(emit_session_id, agent_name, summariser_usage)
            await self._emit_end(emit_session_id, agent_name, summary=summary_text)

        logger.info(
            "summarization_complete session_id={} agent={} "
            "summarised={} kept={} keep_last_assistants={} summary_length={}",
            ctx.session_id,
            ctx.agent_name,
            len(to_summarise),
            kept,
            self._keep_last_assistants,
            len(summary_text),
        )

    # ── SSE emission helpers ──────────────────────────────────────────────
    # Imported lazily inside each helper to mirror title_service / member /
    # checkpointer call sites and avoid pulling stream_store into modules
    # that import this hook at startup (e.g. agent.loader).

    async def _emit_start(self, session_id: str, agent: str) -> None:
        from app.services import memory_stream_store as stream_store

        try:
            await stream_store.push_event(
                session_id,
                StreamEnvelope.from_event(SummarizationStartEvent(agent=agent)),
            )
        except Exception as exc:
            logger.debug("summarization_emit_start_failed error={}", exc)

    async def _emit_end(
        self, session_id: str, agent: str, *, summary: str, error: bool = False
    ) -> None:
        from app.services import memory_stream_store as stream_store

        try:
            await stream_store.push_event(
                session_id,
                StreamEnvelope.from_event(
                    SummarizationEndEvent(
                        agent=agent,
                        summary=summary,
                        metadata={"error": True} if error else {},
                    )
                ),
            )
        except Exception as exc:
            logger.debug("summarization_emit_end_failed error={}", exc)

    async def _emit_usage(self, session_id: str, agent: str, usage: dict) -> None:
        """Publish the summariser call's usage so the live cost meter adds it.

        Mirrors ``StreamPublisherHook._publish_usage``: per-call values from
        the same dict the summary message persists, so the live running sum
        and a reload replay cannot disagree about the compaction cost.
        ``metadata.summarization`` lets the client treat the prompt size as
        the *pre-compaction* context rather than the current one.
        """
        from app.services import memory_stream_store as stream_store

        cost = usage.get("cost")
        estimated_cost = cost.get("estimated_usd") if isinstance(cost, dict) else None
        metadata: dict = {"agent": agent, "summarization": True}
        model_id = self._model_id or provider_cost_model_id(self._llm_provider)
        if isinstance(model_id, str) and model_id:
            metadata["model"] = model_id
        prompt_tokens = int(usage.get("input") or 0)
        completion_tokens = int(usage.get("output") or 0)
        try:
            await stream_store.push_event(
                session_id,
                StreamEnvelope.from_event(
                    UsageEvent(
                        prompt_tokens=prompt_tokens,
                        completion_tokens=completion_tokens,
                        total_tokens=prompt_tokens + completion_tokens,
                        cached_tokens=usage.get("cache"),
                        thoughts_tokens=usage.get("thoughts"),
                        estimated_cost_usd=estimated_cost,
                        metadata=metadata,
                    )
                ),
            )
        except Exception as exc:
            logger.debug("summarization_emit_usage_failed error={}", exc)

    def _make_delta_emitter(
        self, session_id: str, agent: str
    ) -> Callable[[str], Awaitable[None]]:
        from app.services import memory_stream_store as stream_store

        async def _emit(text: str) -> None:
            try:
                await stream_store.push_event(
                    session_id,
                    StreamEnvelope.from_event(
                        SummarizationContentEvent(agent=agent, text=text)
                    ),
                )
            except Exception as exc:
                logger.debug("summarization_emit_content_failed error={}", exc)

        return _emit

    async def _call_llm(
        self,
        ctx: "RunContext",
        messages,
        *,
        tools: list[dict] | None = None,
        on_delta: Callable[[str], Awaitable[None]] | None = None,
    ) -> tuple[str, dict | None]:
        """Stream the summariser LLM; return the full text and its usage dict.

        The usage dict is ``usage_to_dict``'s shape (input/output/cache/cost),
        or ``None`` when the provider never reported usage. Callers persist it
        on the summary message and publish it as a ``usage`` event so the
        summarisation cost enters the session's running cost sum.

        Passes max_token_length to the LLM provider if set. When ``on_delta``
        is supplied each non-empty content chunk is forwarded to it — used
        to publish ``summarization_content`` SSE events while the LLM is
        still generating.
        """
        # Inherit the agent's ``thinking_level`` — forcing ``"none"`` here
        # breaks Codex, whose endpoint rejects requests with no ``reasoning``.
        kwargs: dict = {}
        if self._max_token_length > 0:
            kwargs["max_tokens"] = self._max_token_length
        # Hard API-level guard: prevent the summariser from calling tools.
        # tool_choice="none" is enforced at the provider level so the model
        # cannot invoke tools even when state.tool_defs are present in the
        # payload — a tool_calls chunk would be ignored by this hook, yielding
        # an empty summary and wasting tokens.
        kwargs["tool_choice"] = "none"

        tracer = get_tracer()
        with tracer.start_as_current_span(
            "summarization_llm_call",
            kind=SpanKind.CLIENT,
        ) as span:
            t0 = time.monotonic()
            last_usage = None
            # Prefer the configured, fully-qualified `provider:model` id: cost
            # lookups resolve against the registry, and a provider's `.model`
            # is the bare id it builds request URLs from (e.g. "gpt-5.6-sol"
            # instead of "codex:gpt-5.6-sol"). A bare id misses the registry,
            # so `usage_to_dict` silently omits cost and the span records
            # tokens with no dollars. Fall back to `.model` only when no
            # model_id was configured.
            model_id = self._model_id or provider_cost_model_id(self._llm_provider)
            provider_name = getattr(self._llm_provider, "provider_name", None)
            span.set_attribute("gen_ai.operation.name", "summarization")
            if provider_name:
                span.set_attribute("gen_ai.provider.name", provider_name)
            if model_id:
                model_name: str = model_id
                if ":" in model_id:
                    parsed_provider, _, parsed_model = model_id.partition(":")
                    if not provider_name:
                        provider_name = parsed_provider
                    model_name = parsed_model or model_id
                span.set_attribute("gen_ai.request.model", model_name)
                if provider_name:
                    span.set_attribute("gen_ai.provider.name", provider_name)
            try:
                # No explicit prompt_cache_key: the main chat/coding turns rely
                # on the provider's automatic prefix caching (keyed on the token
                # prefix). Forcing a session-scoped key here routes the
                # summarization request to a different cache partition than the
                # conversation turns, so it cannot reuse the already-warmed
                # conversation prefix — a net cache *miss* on OpenAI/codex.
                # Letting it fall back to automatic prefix caching keeps it
                # consistent with the normal turns.
                #
                # Imported here, not at module top: ``app.agent.agent_loop``
                # imports ``app.agent.hooks`` (for ``BaseAgentHook``) and this
                # module is re-exported from ``app.agent.hooks``. A top-level
                # import closes that loop and only works while
                # ``hooks/__init__`` happens to bind ``BaseAgentHook`` first.
                from app.agent.agent_loop.retry import (
                    StreamRestart,
                    stream_with_retry,
                )

                stream = stream_with_retry(
                    primary_provider=self._llm_provider,
                    primary_label=model_id or "summarizer",
                    ctx=None,
                    state=None,
                    hooks=None,
                    messages=messages,
                    tools=tools,
                    **kwargs,
                )
                full_text = ""
                async for chunk in stream:
                    if isinstance(chunk, StreamRestart):
                        full_text = ""
                        continue
                    if chunk.usage is not None:
                        last_usage = chunk.usage
                    if not chunk.choices:
                        continue
                    delta = chunk.choices[0].delta
                    if delta.content:
                        full_text += delta.content
                        if on_delta is not None:
                            await on_delta(delta.content)
            except Exception as exc:
                span.set_attribute("error.type", type(exc).__name__)
                span.set_status(StatusCode.ERROR, str(exc))
                raise
            elapsed = time.monotonic() - t0
            span.set_attribute("summarization.llm_duration_s", round(elapsed, 3))
            span.set_attribute("summarization.response_length", len(full_text))
            usage_dict: dict | None = None
            if last_usage is not None:
                usage_dict = usage_to_dict(last_usage, model_id)
                logger.info(
                    "summarization_usage model={} input={} output={} cache={}",
                    model_id,
                    usage_dict.get("input"),
                    usage_dict.get("output"),
                    usage_dict.get("cache", 0),
                )
                set_usage_span_attributes(span, usage_dict)
            span.set_status(StatusCode.OK)
            return full_text.strip(), usage_dict
