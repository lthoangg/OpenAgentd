"""Summarization cost must enter the session's running cost sum.

The session cost the client shows is ``previous cost + current turn cost``:
the live meter adds every published ``usage`` event's ``estimated_cost_usd``,
and a reload recomputes the same total from the usage dicts persisted on
messages (``sumUsageFromMessages``). The summariser's LLM call is a real,
billed model call — if its usage is neither published nor persisted, both
paths under-count the session and the running-sum invariant breaks.

These tests pin the two backend halves of that invariant:

1. The summary message carries the summariser call's usage (with cost) in
   ``extra["usage"]`` so the reload path can replay it.
2. A ``usage`` SSE event with the same cost is published so the live meter
   adds it the moment compaction happens.
"""

from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlmodel import col, select

from app.agent.checkpointer import SQLiteCheckpointer, _last_prompt_tokens_from_history
from app.agent.hooks.summarization import SummarizationHook
from app.agent.hooks.stream_publisher import StreamPublisherHook
from app.agent.providers.model_metadata import ModelCost
from app.agent.schemas.chat import (
    AssistantMessage,
    ChatCompletionChunk,
    ChatCompletionChunkChoice,
    ChatCompletionDelta,
    HumanMessage,
    Usage,
)
from app.agent.state import AgentState, ModelRequest, RunContext, UsageInfo
from app.agent.usage import usage_to_dict
from app.models.chat import ChatSession, SessionMessage

SUMMARY_PROMPT = "test summary prompt"
MODEL_ID = "mock:mock-model"

# Summariser call: 1000 prompt tokens @ $2/M + 100 completion tokens @ $5/M,
# cache reads priced at $0.5/M when the provider reports them.
PROMPT_TOKENS = 1_000
COMPLETION_TOKENS = 100
CACHED_TOKENS = 600
COST = ModelCost(input=2.0, output=5.0, cache_read=0.5)
EXPECTED_COST_USD = PROMPT_TOKENS * 2.0 / 1e6 + COMPLETION_TOKENS * 5.0 / 1e6
EXPECTED_CACHED_COST_USD = (
    (PROMPT_TOKENS - CACHED_TOKENS) * 2.0 / 1e6
    + CACHED_TOKENS * 0.5 / 1e6
    + COMPLETION_TOKENS * 5.0 / 1e6
)


def _make_ctx(session_id="sess-sum") -> RunContext:
    return RunContext(session_id=session_id, run_id="run-1", agent_name="lead")


def _make_state() -> AgentState:
    return AgentState(
        messages=[
            HumanMessage(content="first question"),
            AssistantMessage(content="first answer"),
            HumanMessage(content="second question"),
        ],
        usage=UsageInfo(last_prompt_tokens=9_999),
    )


def _make_provider(cached_tokens: int | None = None) -> MagicMock:
    """Provider whose stream yields summary text plus a final usage snapshot."""
    provider = MagicMock()

    usage = Usage(
        prompt_tokens=PROMPT_TOKENS,
        completion_tokens=COMPLETION_TOKENS,
        total_tokens=PROMPT_TOKENS + COMPLETION_TOKENS,
    )
    if cached_tokens is not None:
        object.__setattr__(usage, "cached_tokens", cached_tokens)

    async def _stream(*_, **__):
        yield ChatCompletionChunk(
            id="c1",
            created=1,
            model="mock-model",
            choices=[
                ChatCompletionChunkChoice(
                    index=0, delta=ChatCompletionDelta(content="Summary text.")
                )
            ],
            usage=None,
        )
        yield ChatCompletionChunk(
            id="c2",
            created=2,
            model="mock-model",
            choices=[],
            usage=usage,
        )

    provider.stream = lambda messages, **kw: _stream()
    return provider


def _make_hook(provider) -> SummarizationHook:
    return SummarizationHook(
        llm_provider=provider,
        summary_prompt=SUMMARY_PROMPT,
        model_id=MODEL_ID,
        prompt_token_threshold=1,
        keep_last_assistants=0,
        min_messages_since_last_summary=0,
    )


async def _noop_model_handler(request: ModelRequest) -> AssistantMessage:
    return AssistantMessage(content="done")


async def _run_compaction(hook, ctx, state) -> list:
    """Drive the hook through a full compaction; return pushed stream events."""
    pushed: list = []
    with (
        patch(
            "app.services.memory_stream_store.push_event",
            new_callable=AsyncMock,
            side_effect=lambda sid, env: pushed.append(env),
        ),
        patch(
            "app.agent.usage.get_model_cost",
            side_effect=lambda model_id: COST if model_id == MODEL_ID else ModelCost(),
        ),
    ):
        await hook.before_model(ctx, state)
        await hook.wrap_model_call(
            ctx,
            state,
            ModelRequest(
                messages=tuple(state.messages_for_llm),
                system_prompt=state.system_prompt,
            ),
            _noop_model_handler,
        )
    return pushed


async def test_summary_message_carries_summarizer_usage_with_cost():
    """The persisted summary row must hold the summariser call's usage dict.

    ``sumUsageFromMessages`` recomputes the session cost from persisted
    ``extra["usage"]`` on reload — without this, every reload silently drops
    the summarisation cost from the running sum.
    """
    state = _make_state()
    await _run_compaction(_make_hook(_make_provider()), _make_ctx(), state)

    summary = next(m for m in state.messages if m.is_summary)
    usage = (summary.extra or {}).get("usage")
    assert usage is not None, "summary message must carry the summariser usage"
    assert usage["input"] == PROMPT_TOKENS
    assert usage["output"] == COMPLETION_TOKENS
    assert "cache" not in usage, "no cache reads reported → no cache key"
    assert usage["cost"]["estimated_usd"] == pytest.approx(EXPECTED_COST_USD)


async def test_summarization_publishes_usage_event_with_cost():
    """The live meter adds every ``usage`` event's cost — compaction included."""
    pushed = await _run_compaction(
        _make_hook(_make_provider()), _make_ctx(), _make_state()
    )

    usage_events = [env for env in pushed if env.event == "usage"]
    assert len(usage_events) == 1
    data = usage_events[0].data
    assert data["prompt_tokens"] == PROMPT_TOKENS
    assert data["completion_tokens"] == COMPLETION_TOKENS
    assert data["cached_tokens"] is None
    assert data["estimated_cost_usd"] == pytest.approx(EXPECTED_COST_USD)
    # The reducer routes on metadata.agent and must be able to tell a
    # compaction frame from an ordinary model call (it must not treat the
    # pre-compaction context size as the current context).
    assert data["metadata"]["agent"] == "lead"
    assert data["metadata"]["summarization"] is True


async def test_summary_usage_with_cache_reads_prices_the_cache_bucket():
    """Cache reads reported by the summariser provider must survive both paths.

    The cost must be computed with the cache-read price carved out of the
    input bucket — pricing the whole prompt at the fresh-input rate would
    overstate the summarisation cost on every cache hit.
    """
    state = _make_state()
    pushed = await _run_compaction(
        _make_hook(_make_provider(cached_tokens=CACHED_TOKENS)), _make_ctx(), state
    )

    summary = next(m for m in state.messages if m.is_summary)
    usage = (summary.extra or {}).get("usage")
    assert usage is not None
    assert usage["cache"] == CACHED_TOKENS
    assert usage["cost"]["estimated_usd"] == pytest.approx(EXPECTED_CACHED_COST_USD)

    data = [env for env in pushed if env.event == "usage"][0].data
    assert data["cached_tokens"] == CACHED_TOKENS
    assert data["estimated_cost_usd"] == pytest.approx(EXPECTED_CACHED_COST_USD)


async def test_published_cost_matches_persisted_cost():
    """Live meter and reload replay must agree on the summarisation cost.

    Running sum invariant: after turn costs A and B with a compaction (cost S)
    in between, both paths must show A + S + B — so the one S published live
    must equal the one S persisted on the summary row.
    """
    state = _make_state()
    pushed = await _run_compaction(_make_hook(_make_provider()), _make_ctx(), state)

    published = sum(
        env.data["estimated_cost_usd"] or 0 for env in pushed if env.event == "usage"
    )
    summary = next(m for m in state.messages if m.is_summary)
    persisted = (
        (summary.extra or {}).get("usage", {}).get("cost", {}).get("estimated_usd", 0)
    )
    assert published == pytest.approx(EXPECTED_COST_USD)
    assert persisted == pytest.approx(published)


async def test_no_usage_event_when_provider_reports_no_usage():
    """A provider that never reports usage must not produce a zeroed event."""
    provider = MagicMock()

    async def _stream(*_, **__):
        yield ChatCompletionChunk(
            id="c1",
            created=1,
            model="mock-model",
            choices=[
                ChatCompletionChunkChoice(
                    index=0, delta=ChatCompletionDelta(content="Summary text.")
                )
            ],
            usage=None,
        )

    provider.stream = lambda messages, **kw: _stream()

    state = _make_state()
    pushed = await _run_compaction(_make_hook(provider), _make_ctx(), state)

    assert [env for env in pushed if env.event == "usage"] == []
    summary = next(m for m in state.messages if m.is_summary)
    assert not (summary.extra or {}).get("usage")


# ---------------------------------------------------------------------------
# Running sum across turns: previous cost + current turn cost
# ---------------------------------------------------------------------------


def _turn_response(prompt: int, completion: int) -> AssistantMessage:
    """Assistant message shaped like ``stream_and_assemble`` hands to hooks."""
    usage = Usage(
        prompt_tokens=prompt,
        completion_tokens=completion,
        total_tokens=prompt + completion,
    )
    return AssistantMessage(
        content="ok", extra={"usage": usage_to_dict(usage, MODEL_ID)}
    )


async def test_running_sum_across_turns_with_compaction_between():
    """Session cost after turn A, compaction S, turn B must be exactly A+S+B.

    The client's running sum is the plain sum of every published ``usage``
    event's cost, so the stream over two turns with a compaction in between
    must add up to the three calls' costs — nothing dropped, nothing doubled.
    """
    session_id = "sess-running-sum"
    publisher = StreamPublisherHook(session_id=session_id, agent_name="lead")
    summarizer = _make_hook(_make_provider())
    ctx = _make_ctx(session_id)
    state = _make_state()

    pushed: list = []
    with (
        patch(
            "app.services.memory_stream_store.push_event",
            new_callable=AsyncMock,
            side_effect=lambda sid, env: pushed.append(env),
        ),
        patch(
            "app.agent.usage.get_model_cost",
            side_effect=lambda model_id: COST if model_id == MODEL_ID else ModelCost(),
        ),
    ):
        # Turn 1: one model call, cost A.
        await publisher.after_model(ctx, state, _turn_response(100, 20))
        await publisher.after_agent(ctx, state, MagicMock())

        # Compaction fires before turn 2's model call, cost S.
        await summarizer.before_model(ctx, state)
        await summarizer.wrap_model_call(
            ctx,
            state,
            ModelRequest(
                messages=tuple(state.messages_for_llm),
                system_prompt=state.system_prompt,
            ),
            _noop_model_handler,
        )

        # Turn 2: one model call, cost B.
        await publisher.after_model(ctx, state, _turn_response(150, 30))
        await publisher.after_agent(ctx, state, MagicMock())

    cost_a = 100 * 2.0 / 1e6 + 20 * 5.0 / 1e6
    cost_b = 150 * 2.0 / 1e6 + 30 * 5.0 / 1e6
    published = sum(
        env.data["estimated_cost_usd"] or 0 for env in pushed if env.event == "usage"
    )
    assert published == pytest.approx(cost_a + EXPECTED_COST_USD + cost_b)


# ---------------------------------------------------------------------------
# DB persistence: the summariser usage must survive the checkpointer round-trip
# ---------------------------------------------------------------------------


async def test_summary_usage_is_persisted_to_db():
    """The summary row stores ``extra["usage"]`` so a reload can replay it.

    Whole chain: compaction attaches usage to the summary message →
    ``SQLiteCheckpointer.sync`` persists it → the stored row still carries the
    cost. This is what the history endpoint serves to ``sumUsageFromMessages``.
    """
    import app.core.db as _db

    sid = uuid.uuid7()
    async with _db.async_session_factory() as db:
        async with db.begin():
            db.add(ChatSession(id=sid))

    cp = SQLiteCheckpointer(_db.async_session_factory)
    ctx = _make_ctx(str(sid))
    state = _make_state()
    # Turn 1's assistant reply carries cost A in its usage extra.
    with patch(
        "app.agent.usage.get_model_cost",
        side_effect=lambda model_id: COST if model_id == MODEL_ID else ModelCost(),
    ):
        state.messages[1].extra = {
            "usage": usage_to_dict(
                Usage(prompt_tokens=100, completion_tokens=20, total_tokens=120),
                MODEL_ID,
            )
        }
    await cp.sync(ctx, state)

    await _run_compaction(_make_hook(_make_provider()), ctx, state)
    await cp.sync(ctx, state)

    async with _db.async_session_factory() as db:
        rows = (
            await db.exec(
                select(SessionMessage).where(col(SessionMessage.session_id) == sid)
            )
        ).all()

    summary_row = next(r for r in rows if r.is_summary)
    stored = (summary_row.extra or {}).get("usage")
    assert stored is not None, "summary row must persist the summariser usage"
    assert stored["input"] == PROMPT_TOKENS
    assert stored["output"] == COMPLETION_TOKENS
    assert stored["cost"]["estimated_usd"] == pytest.approx(EXPECTED_COST_USD)

    # Replaying every stored usage dict reproduces the full running sum —
    # turn cost A plus summarisation cost S.
    cost_a = 100 * 2.0 / 1e6 + 20 * 5.0 / 1e6
    replayed = sum(
        ((r.extra or {}).get("usage", {}).get("cost") or {}).get("estimated_usd", 0)
        for r in rows
    )
    assert replayed == pytest.approx(cost_a + EXPECTED_COST_USD)


async def test_resume_seed_ignores_summary_usage_input():
    """``last_prompt_tokens`` seeding must skip the summary row's usage.

    The summary's ``usage.input`` is the *pre-compaction* context size. Seeding
    the resume state with it would tell the SummarizationHook the context is
    still over threshold and re-trigger compaction of an already-compacted
    session on the very next turn.
    """
    kept = AssistantMessage(
        content="kept reply", extra={"usage": {"input": 2_000, "output": 10}}
    )
    summary = HumanMessage(
        content="summary",
        is_summary=True,
        extra={"usage": {"input": 250_000, "output": 400}},
    )

    # Coding mode compacts everything, so the summary can be the newest row.
    assert _last_prompt_tokens_from_history([kept, summary]) == 2_000
    # A summary-only window has no real model call to seed from.
    assert _last_prompt_tokens_from_history([summary]) == 0
