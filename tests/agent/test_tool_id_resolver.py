"""ToolIdResolver — tc_id resolution under retries and parallel calls.

The resolver pairs delta-sourced tool_call ids (what the frontend saw in the
``tool_call`` SSE event) with the assembled ``ToolCall.id`` used at dispatch
time, so ``tool_start`` / ``tool_end`` reach the same card the ``tool_call``
event created.
"""

from app.agent.tool_id_resolver import ToolIdResolver


def test_fifo_fallback_when_internal_id_unknown():
    """Id-less providers get synthetic delta ids; dispatch pairs them FIFO."""
    resolver = ToolIdResolver()
    resolver.register("web_search", "delta-a")
    resolver.register("web_search", "delta-b")

    assert resolver.resolve_start("web_search", "int-1") == "delta-a"
    assert resolver.resolve_start("web_search", "int-2") == "delta-b"
    assert resolver.resolve_end("int-1") == "delta-a"
    assert resolver.resolve_end("int-2") == "delta-b"


def test_exact_match_wins_over_fifo_after_stream_retry():
    """A mid-stream provider retry re-emits tool_call deltas with fresh ids
    while the aborted attempt's ids are still queued.

    The assembled ``ToolCall.id`` comes from the *successful* attempt, so it
    must win over FIFO order — otherwise ``tool_start``/``tool_end`` are
    emitted under the dead attempt's id and the frontend card created for the
    real id never completes (stuck "running" tool until reload).
    """
    resolver = ToolIdResolver()
    resolver.register("shell", "call-attempt-1")  # aborted stream attempt
    resolver.register("shell", "call-attempt-2")  # successful retry

    assert resolver.resolve_start("shell", "call-attempt-2") == "call-attempt-2"
    assert resolver.resolve_end("call-attempt-2") == "call-attempt-2"


def test_missing_registration_falls_back_to_internal_id():
    resolver = ToolIdResolver()
    assert resolver.resolve_start("shell", "int-9") == "int-9"
    assert resolver.resolve_end("int-9") == "int-9"


def test_exact_match_does_not_disturb_other_queued_ids():
    """Parallel same-name calls: each dispatch picks its own id regardless of
    execution start order."""
    resolver = ToolIdResolver()
    resolver.register("shell", "id-A")
    resolver.register("shell", "id-B")

    # Second call happens to start first — exact match keeps pairing correct.
    assert resolver.resolve_start("shell", "id-B") == "id-B"
    assert resolver.resolve_start("shell", "id-A") == "id-A"
