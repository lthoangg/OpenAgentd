"""In-memory SSE stream store.

Design
------
- _state: dict[session_id, TurnState]  — accumulated turn blob (reconnect replay)
- _subscribers: dict[session_id, list[asyncio.Queue]]  — live fan-out to SSE clients
- _cleanup tasks expire state after STREAM_TTL seconds

Single-process only — no cross-worker fan-out. OpenAgentd's supported
sidecar and personal-server launchers intentionally run one Uvicorn worker;
do not start this app with ``--workers > 1`` because reconnect replay and live
subscribers must share this process-local store.
"""

from __future__ import annotations

import asyncio
from typing import Any, AsyncGenerator

from loguru import logger

from app.agent.schemas.events import (
    AgentNotConfiguredEvent,
    AgentStatusEvent,
    MessageEvent,
    SummarizationContentEvent,
    SummarizationEndEvent,
    SummarizationStartEvent,
    ThinkingEvent,
    ToolCallEvent,
    ToolEndEvent,
    ToolStartEvent,
)
from app.services._tool_state import match_tool_end, match_tool_start
from app.services.stream_envelope import StreamEnvelope

STREAM_TTL = 3600  # 1 hour

# Hard ceiling on a single turn's replay-state lifetime, independent of the
# sliding idle TTL above. ``_refresh_cleanup`` extends the deadline on every
# event, so a turn that keeps emitting indefinitely (stuck/runaway agent
# loop) would otherwise never expire and its accumulated content/thinking/
# tool_calls would grow without bound. This bounds that growth by forcing
# expiry ``_MAX_TURN_LIFETIME_SECONDS`` after the turn started, regardless
# of ongoing activity.
_MAX_TURN_LIFETIME_SECONDS = 4 * 60 * 60  # 4 hours

# Sentinel placed on subscriber queues when the turn finishes
_SENTINEL = object()


class _TurnState:
    """Accumulated state for one in-flight turn."""

    __slots__ = (
        "is_streaming",
        "content",
        "thinking",
        "tool_calls",
        "agent_statuses",
        "agent_errors",
        "summarization",
        "usage",
        "error",
        "agent_not_configured",
        "subscribers",
        "_cleanup_handle",
        "_cleanup_deadline",
        "_created_at",
    )

    def __init__(self) -> None:
        self.is_streaming: bool = True
        # Me per-agent accumulators — keyed by agent name so reconnect replay
        # can re-emit with correct attribution. A single-blob was ambiguous in
        # team turns where multiple agents stream text and the replayed event
        # went to agent="" (no UI panel renders that bucket).
        self.content: dict[str, list[str]] = {}
        self.thinking: dict[str, list[str]] = {}
        self.tool_calls: list[dict[str, Any]] = []
        # Me last-known lifecycle state per agent. Without this, a reconnect
        # mid-turn would never see `agent_status=working` and the composer's
        # isTeamWorking flag would stay false even while tokens were still
        # streaming in. Overwritten per event so only the latest sticks.
        self.agent_statuses: dict[str, str] = {}
        self.agent_errors: dict[str, dict[str, Any]] = {}
        # Me in-flight summarisation state per agent.  Carries the streaming
        # summary text and a done flag so a mid-compaction reconnect can
        # rebuild the "Session compacting" divider with the right state.
        # Cleared on a fresh ``init_turn`` (next turn) — the assistant
        # message persistence path doesn't apply here because summaries are
        # stored as DB rows and rehydrated separately on session load.
        self.summarization: dict[str, dict[str, Any]] = {}
        self.usage: dict | None = None
        self.error: str | None = None
        self.agent_not_configured: dict[str, Any] | None = None
        # Me keep list of queues — one per SSE client
        self.subscribers: list[asyncio.Queue] = []
        self._cleanup_handle: asyncio.TimerHandle | None = None
        self._cleanup_deadline: float = 0.0
        self._created_at: float = 0.0

    def reset_for_next_turn(self) -> None:
        self.is_streaming = True
        self.content = {}
        self.thinking = {}
        self.tool_calls = []
        self.agent_statuses = {}
        self.agent_errors = {}
        self.summarization = {}
        self.usage = None
        self.error = None
        self.agent_not_configured = None


# Me store all active turns here
_turns: dict[str, _TurnState] = {}


def _cancel_cleanup(state: _TurnState) -> None:
    if state._cleanup_handle is not None:
        state._cleanup_handle.cancel()
        state._cleanup_handle = None


def _schedule_cleanup(session_id: str, state: _TurnState) -> None:
    """Schedule automatic expiry after STREAM_TTL seconds. Marks turn start."""
    _cancel_cleanup(state)
    loop = asyncio.get_event_loop()
    state._created_at = loop.time()
    state._cleanup_deadline = loop.time() + STREAM_TTL
    state._cleanup_handle = loop.call_later(STREAM_TTL, _expire_turn, session_id, state)


def _refresh_cleanup(session_id: str, state: _TurnState) -> None:
    """Extend the sliding TTL without cancelling and recreating the timer.

    Capped at ``_created_at + _MAX_TURN_LIFETIME_SECONDS`` so a turn that
    keeps emitting events indefinitely still expires and releases its
    accumulated state instead of sliding forever.
    """
    loop = asyncio.get_event_loop()
    hard_deadline = state._created_at + _MAX_TURN_LIFETIME_SECONDS
    state._cleanup_deadline = min(loop.time() + STREAM_TTL, hard_deadline)
    if state._cleanup_handle is None:
        _schedule_cleanup(session_id, state)


def _expire_turn(session_id: str, state: _TurnState) -> None:
    """Expire only after the latest activity deadline for this state object."""
    if _turns.get(session_id) is not state:
        return
    loop = asyncio.get_event_loop()
    remaining = state._cleanup_deadline - loop.time()
    if remaining > 0:
        state._cleanup_handle = loop.call_later(
            remaining, _expire_turn, session_id, state
        )
        return
    state._cleanup_handle = None
    _turns.pop(session_id, None)


# ── Write side ────────────────────────────────────────────────────────────────


async def init_turn(session_id: str, *, keep_subscribers: bool = False) -> None:
    """Initialise a fresh state blob for a new turn."""
    try:
        # Me cancel old cleanup if session reused
        old = _turns.get(session_id)
        if old is not None:
            _cancel_cleanup(old)
            if keep_subscribers:
                old.reset_for_next_turn()
                _schedule_cleanup(session_id, old)
                return
            # Me drain old subscribers so they unblock
            for q in old.subscribers:
                try:
                    q.put_nowait(_SENTINEL)
                except asyncio.QueueFull:
                    pass

        state = _TurnState()
        _turns[session_id] = state
        _schedule_cleanup(session_id, state)
    except Exception as exc:
        logger.warning(
            "memory_store_init_turn_failed session_id={} error={}",
            session_id,
            exc,
        )


async def ensure_turn(session_id: str) -> None:
    """Create turn state for *session_id* only if it has none.

    A turn suspended on ``ask_user`` can be resumed long after the state that
    carried it was lost: the daemon restarts, or the sliding ``STREAM_TTL``
    expires because a waiting turn emits nothing to refresh it. Both leave
    ``_turns`` without an entry, and ``attach`` then returns immediately — so a
    client that correctly treats an open question as a live turn reconnects in a
    tight loop.

    Only needed before :func:`attach`; to *send* into a turn whose state may be
    gone, pass ``create_if_missing=True`` to :func:`push_event` instead of
    calling this first.

    Deliberately *not* ``init_turn``: when the suspension is still in memory,
    its accumulated content, tool calls and subscribers are what a mid-turn
    reconnect replays, and resetting them would blank the part of the turn that
    came before the question.
    """
    if _turns.get(session_id) is not None:
        return
    await init_turn(session_id)


async def push_event(
    session_id: str, envelope: StreamEnvelope, *, create_if_missing: bool = False
) -> None:
    """Update state and fan-out event to all live subscribers.

    ``envelope`` must be a :class:`StreamEnvelope` — raw dicts are rejected
    at the type boundary.  Producers build envelopes via
    :meth:`StreamEnvelope.from_event` (for typed ``*Event`` payloads) or
    :meth:`StreamEnvelope.from_parts` (for ad-hoc lifecycle events).

    Events for a session with no live turn are dropped by default: nobody is
    attached and there is no turn to replay them into, and creating state here
    would make a long-finished session read as running (see
    :func:`running_session_ids`, which treats any fresh state as streaming)
    until the TTL expired it.

    ``create_if_missing=True`` opts out, for the one case where the turn really
    is still open but the state proving it is gone — resolving a durable
    ``ask_user`` suspension, or closing a parked turn whose sliding TTL lapsed
    because it emitted nothing while it waited. Replaces having to call
    :func:`ensure_turn` first, which was easy to forget and silently dropped the
    event when it was.
    """
    try:
        state = _turns.get(session_id)
        if state is None:
            if not create_if_missing:
                return
            await ensure_turn(session_id)
            state = _turns.get(session_id)
        if state is None:  # pragma: no cover — init_turn swallowed a failure
            return

        event_type = envelope.event
        data = envelope.data

        # Me update state blob
        if event_type == "message" and data.get("text"):
            agent = envelope.agent
            state.content.setdefault(agent, []).append(data["text"])

        elif event_type == "thinking" and data.get("text"):
            agent = envelope.agent
            state.thinking.setdefault(agent, []).append(data["text"])

        elif event_type == "tool_call":
            state.tool_calls.append(
                {
                    "tool_call_id": data.get("tool_call_id"),
                    "name": data.get("name", ""),
                    "arguments": None,
                    "agent": envelope.agent,
                    "started": False,
                    "done": False,
                }
            )

        elif event_type == "tool_start":
            match_tool_start(
                state.tool_calls,
                data.get("tool_call_id"),
                data.get("name", ""),
                arguments=data.get("arguments"),
            )

        elif event_type == "tool_end":
            match_tool_end(
                state.tool_calls,
                data.get("tool_call_id"),
                data.get("name", ""),
                data.get("result"),
            )

        elif event_type == "usage":
            state.usage = data

        elif event_type == "error":
            state.error = data.get("message", "error")

        elif event_type == "done":
            state.is_streaming = False

        elif event_type == "agent_not_configured":
            state.agent_not_configured = data

        # Me inbox events are DB-persisted by _persist_inbox BEFORE being
        # emitted here, so the DB is always authoritative.  No replay state
        # is kept — live subscribers still receive the event via the fan-out
        # below.

        elif event_type == "agent_status":
            agent = envelope.agent
            status = data.get("status", "")
            if agent and status:
                state.agent_statuses[agent] = status
                if status == "error":
                    state.agent_errors[agent] = data.get("metadata", {})
                else:
                    state.agent_errors.pop(agent, None)

        elif event_type == "summarization_start":
            agent = envelope.agent
            if agent:
                state.summarization[agent] = {
                    "text": "",
                    "done": False,
                    "error": False,
                }

        elif event_type == "summarization_content":
            agent = envelope.agent
            text = data.get("text", "")
            if agent and text:
                entry = state.summarization.setdefault(
                    agent, {"text": "", "done": False, "error": False}
                )
                entry["text"] = entry.get("text", "") + text

        elif event_type == "summarization_end":
            agent = envelope.agent
            if agent:
                entry = state.summarization.setdefault(
                    agent, {"text": "", "done": False, "error": False}
                )
                # Final summary text supersedes accumulated deltas — the
                # ``end`` payload is authoritative (it carries the trimmed
                # full summary that was actually persisted).
                summary = data.get("summary", "")
                if summary:
                    entry["text"] = summary
                entry["done"] = True
                meta = data.get("metadata") or {}
                if isinstance(meta, dict) and meta.get("error"):
                    entry["error"] = True

        # Me extend TTL on every write without recreating the timer per delta.
        _refresh_cleanup(session_id, state)

        # Me fan-out to all live SSE clients.
        #
        # If a subscriber queue fills up, a slow/paused client (backgrounded
        # browser tab, stalled socket) is dropping events. Silently removing
        # the queue leaves the client's SSE coroutine blocked forever and
        # its live view stuck on the last delivered event (tool_call stays
        # "executing", `done` never arrives, etc.). To recover cleanly we
        # push a sentinel so `attach()` exits → the SSE coroutine yields →
        # the client's `onDone` fires → it reloads state from the DB.
        wire = envelope.to_wire() if state.subscribers else None
        dead: list[asyncio.Queue] = []
        for q in state.subscribers:
            try:
                q.put_nowait(wire)
            except asyncio.QueueFull:
                logger.warning(
                    "sse_subscriber_queue_full session_id={} event_type={} "
                    "dropping_client qsize={}",
                    session_id,
                    event_type,
                    q.qsize(),
                )
                # Me drain the oldest event to make room for the sentinel —
                # the client was going to miss it anyway, this is strictly
                # better than leaving the coroutine hung.
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    q.put_nowait(_SENTINEL)
                except asyncio.QueueFull:
                    pass
                dead.append(q)
        for q in dead:
            try:
                state.subscribers.remove(q)
            except ValueError:
                pass

    except Exception as exc:
        logger.warning(
            "memory_store_push_failed session_id={} error={}",
            session_id,
            exc,
        )


async def commit_agent_content(session_id: str, agent: str) -> None:
    """Drop ``content[agent]``, ``thinking[agent]`` and any ``tool_calls``
    owned by *agent* from the state blob. Also drop a completed summarization
    for that agent: its summary row is durable by the time this hook runs.

    Called by the checkpointer after an assistant message is persisted to
    the DB — once durable, a mid-turn reconnect must not replay it (the
    frontend loads the message from DB, replay would produce duplicates).
    """
    state = _turns.get(session_id)
    if state is None:
        return
    state.content.pop(agent, None)
    state.thinking.pop(agent, None)
    summary = state.summarization.get(agent)
    if summary and summary.get("done") and not summary.get("error"):
        state.summarization.pop(agent, None)
    # Me drop tool_calls owned by this agent.  AssistantMessage rows embed
    # their tool_calls as part of the assistant payload, so once that row is
    # in the DB the corresponding replay entries must go too — otherwise
    # parseTeamBlocks (DB → blocks) and the SSE replay (→ currentBlocks)
    # each produce a tool card and the frontend renders both.
    state.tool_calls = [tc for tc in state.tool_calls if tc.get("agent") != agent]


async def mark_done(session_id: str) -> None:
    """Flip is_streaming=False and unblock all subscribers."""
    try:
        state = _turns.get(session_id)
        if state is None:
            return
        state.is_streaming = False
        _refresh_cleanup(session_id, state)
        # Me send sentinel to all subscribers so they exit
        for q in list(state.subscribers):
            try:
                q.put_nowait(_SENTINEL)
            except asyncio.QueueFull:
                pass
    except Exception as exc:
        logger.warning(
            "memory_store_mark_done_failed session_id={} error={}",
            session_id,
            exc,
        )


async def clear(session_id: str) -> None:
    """Delete state for this session and unblock its SSE subscribers."""
    try:
        state = _turns.pop(session_id, None)
        if state is not None:
            _cancel_cleanup(state)
            for queue in state.subscribers:
                try:
                    queue.put_nowait(_SENTINEL)
                except asyncio.QueueFull:
                    try:
                        queue.get_nowait()
                    except asyncio.QueueEmpty:
                        pass
                    try:
                        queue.put_nowait(_SENTINEL)
                    except asyncio.QueueFull:
                        pass
    except Exception as exc:
        logger.warning(
            "memory_store_clear_failed session_id={} error={}",
            session_id,
            exc,
        )


# ── Read side ─────────────────────────────────────────────────────────────────


def running_session_ids() -> set[str]:
    """Return session ids that currently have an in-flight stream turn."""
    return {session_id for session_id, state in _turns.items() if state.is_streaming}


async def attach(session_id: str) -> AsyncGenerator[dict[str, str], None]:
    """Yield events in SSE wire shape for the current in-flight turn.

    Each yielded value is ``{"event": str, "data": str}`` — ready to hand to
    ``sse_starlette``.  Internally we build typed ``*Event`` models and
    :class:`StreamEnvelope` wrappers, then call ``to_wire()`` at the yield
    boundary so the on-the-wire shape is guaranteed consistent.

    Reconnect protocol:
    1. Read state — if not streaming, return (DB is authoritative).
    2. Register a subscriber queue BEFORE replaying state (no gap window).
    3. Replay accumulated state as synthetic events.
    4. Yield live events from queue until sentinel arrives.
    """
    try:
        state = _turns.get(session_id)
        if state is None:
            return

        if not state.is_streaming:
            return

        # Me register queue BEFORE replaying — no gap window.
        # maxsize=2048 gives ~4× headroom over the previous 512 for long
        # tool-heavy turns on healthy-but-slightly-lagging clients. A full
        # queue still triggers the drop-and-sentinel recovery in push_event()
        # so a genuinely stuck subscriber can't leak memory unboundedly.
        q: asyncio.Queue = asyncio.Queue(maxsize=2048)
        state.subscribers.append(q)

        try:
            # Me replay lifecycle state FIRST so the frontend composer flips
            # to the working indicator before any content events arrive.
            # Without this, a reconnect mid-turn would leave isTeamWorking
            # false (and the stop button hidden) until the next `done`
            # event — even as tokens continued streaming in.
            for agent, status in state.agent_statuses.items():
                if not agent or status not in ("idle", "working", "offline", "error"):
                    continue
                yield StreamEnvelope.from_event(
                    AgentStatusEvent(
                        agent=agent,
                        status=status,
                        metadata=state.agent_errors.get(agent, {}),
                    )
                ).to_wire()

            if state.agent_not_configured is not None:
                yield StreamEnvelope.from_event(
                    AgentNotConfiguredEvent.model_validate(state.agent_not_configured)
                ).to_wire()

            # Me replay summarisation state so a mid-compaction reconnect
            # shows the divider in its current state.  We replay as a
            # ``start`` + (optional accumulated ``content``) + (optional
            # ``end``) sequence — the frontend reducer treats each as
            # idempotent state transitions, so even a fully-completed
            # compaction re-arrives cleanly.
            for agent, entry in state.summarization.items():
                if not agent:
                    continue
                yield StreamEnvelope.from_event(
                    SummarizationStartEvent(agent=agent)
                ).to_wire()
                text = entry.get("text", "")
                if text and not entry.get("done"):
                    yield StreamEnvelope.from_event(
                        SummarizationContentEvent(agent=agent, text=text)
                    ).to_wire()
                if entry.get("done"):
                    yield StreamEnvelope.from_event(
                        SummarizationEndEvent(
                            agent=agent,
                            summary=text,
                            metadata={"error": True} if entry.get("error") else {},
                        )
                    ).to_wire()

            # Me replay accumulated thinking per-agent so the frontend can
            # route each chunk to the correct agent panel. A single empty-
            # agent event would land in agentStreams[""] which no UI renders.
            for agent, chunks in state.thinking.items():
                if not chunks:
                    continue
                yield StreamEnvelope.from_event(
                    ThinkingEvent(agent=agent, text="".join(chunks))
                ).to_wire()

            # Me inbox events are NOT replayed — they are DB-persisted by
            # _persist_inbox before emission, so the frontend's loadSession
            # already populates the user bubbles.  A live subscriber
            # connected mid-turn still receives them via the fan-out in
            # push_event.

            # Me replay accumulated content per-agent (see thinking note above).
            #
            # Content is replayed BEFORE the tool events on purpose: a model
            # iteration streams its preamble text and only then announces the
            # tool calls it wants to run, and the checkpointer drops both
            # (``commit_agent_content``) as soon as that assistant row is
            # persisted — so the un-committed blob replayed here is always
            # "text first, tools second". A client attaching with no live
            # state of its own (mid-turn reload, second tab, new device)
            # rebuilds its blocks straight from this order, so emitting the
            # tool events first rendered every tool card *above* the text that
            # preceded it, the reverse of what the persisted row produces on
            # the next full history load.
            for agent, chunks in state.content.items():
                if not chunks:
                    continue
                yield StreamEnvelope.from_event(
                    MessageEvent(agent=agent, text="".join(chunks))
                ).to_wire()

            # Me replay tool events
            for tc in state.tool_calls:
                yield StreamEnvelope.from_event(
                    ToolCallEvent(
                        agent=tc.get("agent", ""),
                        tool_call_id=tc.get("tool_call_id"),
                        name=tc["name"],
                    )
                ).to_wire()
                if tc.get("started"):
                    yield StreamEnvelope.from_event(
                        ToolStartEvent(
                            agent=tc.get("agent", ""),
                            tool_call_id=tc.get("tool_call_id"),
                            name=tc["name"],
                            arguments=tc.get("arguments"),
                        )
                    ).to_wire()
                if tc.get("done"):
                    yield StreamEnvelope.from_event(
                        ToolEndEvent(
                            agent=tc.get("agent", ""),
                            tool_call_id=tc.get("tool_call_id"),
                            name=tc["name"],
                            result=tc.get("result"),
                        )
                    ).to_wire()

            # Me drain live events until sentinel.  Items on the queue are
            # already in wire shape (populated by push_event via to_wire()).
            while True:
                item = await q.get()
                if item is _SENTINEL:
                    break
                yield item

        finally:
            try:
                state.subscribers.remove(q)
            except ValueError:
                pass

    except Exception as exc:
        logger.warning(
            "memory_store_attach_failed session_id={} error={}",
            session_id,
            exc,
        )


async def close() -> None:
    """Clear all state (called on server shutdown)."""
    for state in _turns.values():
        _cancel_cleanup(state)
    _turns.clear()
