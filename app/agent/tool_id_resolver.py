"""ToolIdResolver — FIFO tool_call_id resolution for streaming tool events.

Streaming LLM providers emit tool_call deltas with ``tc_id`` values that may
differ from the internal ``ToolCall.id`` used at dispatch time.  This class
maintains a per-function-name FIFO queue of delta-sourced IDs and maps them
to internal IDs at ``tool_start`` / ``tool_end`` time.

Used by both the agent chat route and ``StreamPublisherHook``
streaming paths — one source of truth for the resolution algorithm.
"""

from __future__ import annotations


class ToolIdResolver:
    """FIFO tool_call_id resolution for streaming tool events.

    Lifecycle per tool call::

        1. ``register(fn_name, tc_id)``   — called when delta chunk arrives
        2. ``resolve_start(fn_name, id)``  — called at tool_start (pops FIFO)
        3. ``resolve_end(internal_id)``    — called at tool_end (reads mapping)
    """

    __slots__ = ("_queues", "_resolved")

    def __init__(self) -> None:
        # Me keep fn_name → queue of tc_ids from delta chunks (FIFO order)
        self._queues: dict[str, list[str]] = {}
        # Me keep internal_id → resolved tc_id for tool_end lookup
        self._resolved: dict[str, str] = {}

    def register(self, fn_name: str, tc_id: str) -> bool:
        """Register a tc_id from a delta chunk.  Returns ``False`` if duplicate."""
        queue = self._queues.setdefault(fn_name, [])
        if tc_id in queue:
            return False
        queue.append(tc_id)
        return True

    def resolve_start(self, fn_name: str, internal_id: str) -> str:
        """Pop the delta id paired with this dispatch, stash mapping for tool_end.

        Exact match first: the assembled ``ToolCall.id`` comes from the deltas
        of the *successful* stream attempt, so when it is present in the queue
        it is the id the frontend's tool card was created with.  A mid-stream
        provider retry leaves the aborted attempt's ids queued ahead of it —
        blind FIFO would pop one of those and emit ``tool_start``/``tool_end``
        under a dead id, leaving the real card stuck "running" until reload.
        FIFO remains the fallback for providers that omit delta ids (their
        synthetic ids never equal the assembled internal id).
        """
        queue = self._queues.get(fn_name, [])
        if internal_id in queue:
            queue.remove(internal_id)
            tc_id = internal_id
        else:
            # Me pop front — each parallel call gets its own id
            tc_id = queue.pop(0) if queue else internal_id
        if not queue:
            self._queues.pop(fn_name, None)
        self._resolved[internal_id] = tc_id
        return tc_id

    def resolve_end(self, internal_id: str) -> str:
        """Look up resolved tc_id for tool_end."""
        return self._resolved.pop(internal_id, internal_id)
