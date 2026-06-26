"""Smoke-test for provider support_interrupt flag.

Verifies two contracts:

  CONTRACT A — Interruptible provider (default, support_interrupt=True):
    A Stop mid-stream halts streaming promptly. The history snapshot taken
    immediately after Stop must be stable (not growing), confirming the turn
    was actually cancelled.

  CONTRACT B — Non-interruptible provider (support_interrupt=False):
    A Stop mid-stream does NOT cut the current LLM call short. The stream
    completes in full, the assistant message is assembled, and only then
    does the loop exit. The follow-up turn runs cleanly after.

CONTRACT B is exercised via the direct (no-server) path: we wire up an in-
process agent with a NonInterruptibleProvider, fire the interrupt_event mid-
stream, and verify all chunks were assembled before run() returned.

CONTRACT A is exercised via the same direct path (DefaultProvider).

The live-server path exercises CONTRACT A end-to-end against the real API,
mirroring what stop_mid_stream.py does, but for a single scenario. It is only
run when ``--live`` is passed (server required).

Usage:
  # Direct mode (no server required) — both contracts
  uv run python -m manual.support_interrupt

  # Live mode (server required) — CONTRACT A against the real API
  uv run python -m manual.support_interrupt --live
  uv run python -m manual.support_interrupt --live --base http://localhost:8000/api
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
from typing import AsyncIterator

import httpx

from app.agent.agent_loop import Agent
from app.agent.agent_loop.streaming import stream_and_assemble
from app.agent.providers.base import LLMProviderBase
from app.agent.schemas.chat import (
    AssistantMessage,
    ChatCompletionChunk,
    ChatCompletionChunkChoice,
    ChatCompletionDelta,
    ChatMessage,
    HumanMessage,
)
from app.agent.state import ModelRequest, RunContext

BASE = "http://localhost:8000/api"

# ── In-process provider helpers ─────────────────────────────────────────────


def _make_chunk(text: str) -> ChatCompletionChunk:
    return ChatCompletionChunk(
        id="chunk",
        created=1_000_000,
        model="mock-model",
        choices=[
            ChatCompletionChunkChoice(
                index=0,
                delta=ChatCompletionDelta(content=text),
                finish_reason="stop",
            )
        ],
    )


class _SlowProvider(LLMProviderBase):
    """Streams N single-char chunks with a short pause between each."""

    model = "mock-model"

    def __init__(self, chars: str, *, pause: float = 0.05):
        super().__init__()
        self._chars = chars
        self._pause = pause
        self.yielded: list[str] = []

    def stream(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ) -> AsyncIterator[ChatCompletionChunk]:
        async def _gen() -> AsyncIterator[ChatCompletionChunk]:
            for ch in self._chars:
                self.yielded.append(ch)
                yield _make_chunk(ch)
                await asyncio.sleep(self._pause)

        return _gen()

    async def chat(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ) -> AssistantMessage:
        return AssistantMessage(content="mock")


class DefaultProvider(_SlowProvider):
    """support_interrupt=True (the inherited default)."""
    pass


class NonInterruptibleProvider(_SlowProvider):
    """support_interrupt=False — simulates agy and similar stateful providers."""
    support_interrupt = False


def _make_ctx() -> RunContext:
    return RunContext(
        session_id="manual-test",
        run_id="manual-run",
        agent_name="smoke-agent",
    )


def _make_req() -> ModelRequest:
    return ModelRequest(
        messages=(HumanMessage(content="go"),),
        system_prompt="You are a test assistant.",
        context=None,
    )


# ── CONTRACT A — interruptible provider stops mid-stream ────────────────────


async def _run_contract_a_direct() -> bool:
    print("\n── CONTRACT A (direct): interruptible provider stops mid-stream")
    chars = "abcdefghij"  # 10 chars
    provider = DefaultProvider(chars, pause=0.04)
    event = asyncio.Event()

    async def _set_after_three():
        while len(provider.yielded) < 3:
            await asyncio.sleep(0.005)
        event.set()

    setter = asyncio.create_task(_set_after_three())
    msg, _ = await stream_and_assemble(
        req=_make_req(),
        ctx=_make_ctx(),
        state=None,  # type: ignore[arg-type]
        hooks=[],
        interrupt_event=event,
        tool_defs=[],
        primary_provider=provider,
        primary_label="mock",
        fallback_provider=None,
        fallback_label="",
        agent_name="smoke-agent",
        agent_id="smoke-id",
    )
    await setter

    content = msg.content or ""
    yielded_count = len(provider.yielded)
    print(f"   yielded={yielded_count}/{len(chars)}  assembled={len(content)!r} chars")

    if yielded_count >= len(chars):
        print("   ✗ FAIL: all chunks were yielded — stream was not interrupted")
        return False
    if len(content) > yielded_count:
        print("   ✗ FAIL: assembled more content than was yielded (impossible)")
        return False

    print(f"   ✓ stream stopped at chunk {yielded_count} (< {len(chars)})")
    return True


# ── CONTRACT B — non-interruptible provider always finishes ─────────────────


async def _run_contract_b_direct() -> bool:
    print("\n── CONTRACT B (direct): non-interruptible provider completes despite interrupt")
    chars = "xyz123"  # 6 chars
    provider = NonInterruptibleProvider(chars, pause=0.03)
    event = asyncio.Event()

    # Set interrupt after first chunk — for a normal provider this would abort
    async def _set_after_first():
        while len(provider.yielded) < 1:
            await asyncio.sleep(0.005)
        event.set()

    setter = asyncio.create_task(_set_after_first())
    msg, _ = await stream_and_assemble(
        req=_make_req(),
        ctx=_make_ctx(),
        state=None,  # type: ignore[arg-type]
        hooks=[],
        interrupt_event=event,
        tool_defs=[],
        primary_provider=provider,
        primary_label="mock",
        fallback_provider=None,
        fallback_label="",
        agent_name="smoke-agent",
        agent_id="smoke-id",
    )
    await setter

    content = msg.content or ""
    yielded_count = len(provider.yielded)
    print(f"   yielded={yielded_count}/{len(chars)}  assembled={content!r}")

    if yielded_count != len(chars):
        print(
            f"   ✗ FAIL: expected all {len(chars)} chunks, got {yielded_count} — "
            "stream was interrupted despite support_interrupt=False"
        )
        return False
    if content != chars:
        print(f"   ✗ FAIL: assembled {content!r} != expected {chars!r}")
        return False

    print(f"   ✓ all {len(chars)} chunks assembled in full")
    return True


async def _run_contract_b_agent_loop() -> bool:
    """Verify the agent loop itself exits cleanly after a non-interruptible stream."""
    print("\n── CONTRACT B (agent loop): run() exits cleanly after non-interruptible stream finishes")
    chars = "pqr"
    provider = NonInterruptibleProvider(chars, pause=0.02)
    agent = Agent(name="smoke-bot", llm_provider=provider)
    event = asyncio.Event()

    async def _set_after_first():
        while len(provider.yielded) < 1:
            await asyncio.sleep(0.005)
        event.set()

    setter = asyncio.create_task(_set_after_first())
    msgs = await agent.run([HumanMessage(content="go")], interrupt_event=event)
    await setter

    yielded_count = len(provider.yielded)
    assistant = next((m for m in reversed(msgs) if isinstance(m, AssistantMessage)), None)
    content = assistant.content if assistant else None
    print(f"   yielded={yielded_count}/{len(chars)}  assembled={content!r}  msgs={len(msgs)}")

    if yielded_count != len(chars):
        print(f"   ✗ FAIL: expected all {len(chars)} chunks yielded, got {yielded_count}")
        return False
    if content != chars:
        print(f"   ✗ FAIL: assembled {content!r} != {chars!r}")
        return False

    print(f"   ✓ agent loop exited cleanly after completing {len(chars)}-chunk stream")
    return True


# ── CONTRACT A — live-server path ───────────────────────────────────────────


def _post_message(base: str, message: str, session_id: str | None = None) -> str:
    data: dict[str, str] = {"message": message}
    if session_id:
        data["session_id"] = session_id
    r = httpx.post(f"{base}/team/chat", data=data, timeout=20)
    r.raise_for_status()
    return r.json()["session_id"]


def _post_interrupt(base: str, session_id: str) -> None:
    r = httpx.post(
        f"{base}/team/chat",
        data={"session_id": session_id, "interrupt": "true"},
        timeout=10,
    )
    r.raise_for_status()


def _get_history(base: str, session_id: str) -> list[dict]:
    r = httpx.get(f"{base}/team/{session_id}/history", params={"limit": 1000}, timeout=10)
    r.raise_for_status()
    return r.json()["lead"]["messages"]


def _stream_until_done(base: str, sid: str, *, timeout: int) -> tuple[bool, bool]:
    """Return (done, saw_error)."""
    deadline = time.monotonic() + timeout
    saw_error = False
    try:
        with httpx.stream("GET", f"{base}/team/{sid}/stream", timeout=timeout + 5) as r:
            current_event = ""
            for line in r.iter_lines():
                if time.monotonic() > deadline:
                    return False, saw_error
                if line.startswith("event:"):
                    current_event = line[6:].strip()
                    if current_event == "error":
                        saw_error = True
                    if current_event == "done":
                        return True, saw_error
    except httpx.ReadTimeout:
        return False, saw_error
    return False, saw_error


def _history_sig(messages: list[dict]) -> tuple:
    if not messages:
        return (0,)
    tail = messages[-1]
    return (len(messages), tail.get("role"), len(tail.get("content") or ""))


def _run_contract_a_live(base: str) -> bool:
    print("\n── CONTRACT A (live): Stop mid-stream halts the turn (default provider)")
    prompt = (
        "Write a detailed 300-word explanation of how the Python GIL works. "
        "Take your time."
    )
    wait_before_stop = 1.5

    sid = _post_message(base, prompt)
    print(f"   session={sid}  waiting {wait_before_stop}s before Stop...")
    time.sleep(wait_before_stop)
    _post_interrupt(base, sid)
    print("   Stop sent")

    snap_a = _get_history(base, sid)
    time.sleep(3.0)  # settle
    snap_b = _get_history(base, sid)

    stop_held = _history_sig(snap_a) == _history_sig(snap_b)
    msgs_count = len(snap_b)
    print(f"   stop_held={stop_held}  msgs={msgs_count}")

    if not stop_held:
        print("   ✗ FAIL: history kept growing after Stop — turn was not interrupted")
        return False

    # Follow-up turn must complete cleanly
    print("   sending follow-up...")
    _post_message(base, "Reply with just the word DONE.", session_id=sid)
    done, saw_error = _stream_until_done(base, sid, timeout=60)
    print(f"   follow-up done={done}  error={saw_error}")

    if not done or saw_error:
        print("   ✗ FAIL: follow-up turn did not complete cleanly")
        return False

    print("   ✓ Stop held and follow-up turn completed cleanly")
    return True


# ── Main ────────────────────────────────────────────────────────────────────


async def _run_direct() -> int:
    results: list[tuple[str, bool]] = []

    ok = await _run_contract_a_direct()
    results.append(("CONTRACT A (direct): interruptible stops mid-stream", ok))

    ok = await _run_contract_b_direct()
    results.append(("CONTRACT B (direct): non-interruptible completes in full", ok))

    ok = await _run_contract_b_agent_loop()
    results.append(("CONTRACT B (agent loop): run() exits cleanly after stream", ok))

    print("\n" + "=" * 60)
    print("  support_interrupt smoke-test summary")
    print("=" * 60)
    all_ok = True
    for label, passed in results:
        status = "✓ PASS" if passed else "✗ FAIL"
        print(f"  {status}  {label}")
        all_ok = all_ok and passed
    return 0 if all_ok else 1


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--live", action="store_true", help="Also run live-server CONTRACT A")
    p.add_argument("--base", default=BASE, help="API base URL (live mode only)")
    args = p.parse_args()

    rc = asyncio.run(_run_direct())

    if args.live:
        base = args.base.rstrip("/")
        try:
            httpx.get(f"{base.rsplit('/', 1)[0]}/health/ready", timeout=5)
        except httpx.HTTPError as exc:
            print(f"\nserver unreachable at {base}: {exc}", file=sys.stderr)
            return 2
        ok = _run_contract_a_live(base)
        if not ok:
            rc = 1
        print("\n  ✓ PASS  CONTRACT A (live): Stop mid-stream halts the turn" if ok else
              "\n  ✗ FAIL  CONTRACT A (live): Stop mid-stream did not halt the turn")

    return rc


if __name__ == "__main__":
    sys.exit(main())
