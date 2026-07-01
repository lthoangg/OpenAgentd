"""Smoke-test ``/continue`` end-to-end.

Flow:

1. Send a chat message asking the AI to respond with ~200 words.
2. Wait 3 seconds — long enough for the first deltas to land but well
   before the assistant's reply is complete.
3. Interrupt the turn (``POST /team/chat`` with ``interrupt=true``) —
   simulates the user pressing Stop.
4. Print the last assistant message in the session.  It should be
   partial (cut mid-thought) — that's the state ``/continue`` resumes
   from.
5. Send ``POST /team/commands {"command": "continue"}``.  Stream the
   SSE feed until ``done``, printing each content delta inline so you
   can see the continuation arriving live.
6. Print the full message history.  The newest assistant row should
   carry ``extra.is_continuation == true`` and the prior assistant row
   should be the one truncated in step 3.

Usage:
  uv run python -m manual.continue_smoketest
  uv run python -m manual.continue_smoketest --wait-before-stop 5
  uv run python -m manual.continue_smoketest --base http://localhost:8000/api

Prerequisites:
  Server running (``make dev`` or ``make run``).
"""

from __future__ import annotations

import argparse
import json
import time

import httpx

from manual._common import DEFAULT_BASE
BASE = DEFAULT_BASE
PROMPT = (
    "Please write a detailed, ~200 word response describing the history "
    "and evolution of the Python programming language, from its creation "
    "by Guido van Rossum through to the most recent major release. "
    "Cover key versions, design philosophy, and major ecosystem shifts."
)
DEFAULT_WAIT_BEFORE_STOP = 3.0
DEFAULT_FINAL_WAIT = 180


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────


def post_message(base: str, message: str) -> str:
    """Send a normal chat message; return the session_id."""
    r = httpx.post(f"{base}/team/chat", data={"message": message})
    r.raise_for_status()
    sid = r.json()["session_id"]
    print(f"  session: {sid}")
    return sid


def post_interrupt(base: str, session_id: str) -> None:
    """Send a Stop request — interrupts the working lead/members."""
    r = httpx.post(
        f"{base}/team/chat", data={"session_id": session_id, "interrupt": "true"}
    )
    r.raise_for_status()
    print(f"  interrupt response: {r.json()}")


def post_continue(base: str, session_id: str) -> None:
    """Dispatch ``/continue`` via the new commands endpoint."""
    r = httpx.post(
        f"{base}/team/commands",
        json={"command": "continue", "session_id": session_id},
    )
    if r.status_code != 202:
        print(f"  ERROR {r.status_code}: {r.text}")
        r.raise_for_status()
    print(f"  continue accepted: {r.json()}")


def stream_until_done(
    base: str, sid: str, *, timeout: int, label: str
) -> tuple[bool, str]:
    """Stream SSE events, printing assistant content deltas inline.

    The content event is named ``message`` and carries ``{"text": "..."}``
    per :class:`MessageEvent` in ``app/agent/schemas/events.py``.  Returns
    ``(done, accumulated_text)``; ``done=False`` on timeout.
    """
    print(f"  [{label}] streaming (max {timeout}s)...")
    start = time.monotonic()
    accumulated: list[str] = []
    current_event: str | None = None

    try:
        with httpx.stream(
            "GET", f"{base}/team/{sid}/stream", timeout=timeout + 5
        ) as resp:
            print("  → ", end="", flush=True)
            for line in resp.iter_lines():
                if time.monotonic() - start > timeout:
                    print(f"\n  [{label}] TIMEOUT")
                    return False, "".join(accumulated)

                # SSE event framing: "event: <name>", "data: <json>", blank.
                if line.startswith("event:"):
                    current_event = line[6:].strip()
                    if current_event == "done":
                        elapsed = time.monotonic() - start
                        print(f"\n  [{label}] done ({elapsed:.1f}s)")
                        return True, "".join(accumulated)
                    continue
                if line.startswith("data:") and current_event == "message":
                    payload_str = line[5:].strip()
                    try:
                        payload = json.loads(payload_str)
                    except json.JSONDecodeError:
                        continue
                    delta = payload.get("text") or ""
                    if delta:
                        accumulated.append(delta)
                        print(delta, end="", flush=True)
    except httpx.ReadTimeout:
        print(f"\n  [{label}] read timeout")
        return False, "".join(accumulated)

    elapsed = time.monotonic() - start
    print(f"\n  [{label}] stream closed ({elapsed:.1f}s)")
    return True, "".join(accumulated)


def get_last_assistant(base: str, sid: str) -> dict | None:
    """Return the most recent assistant message dict from history, or None."""
    r = httpx.get(f"{base}/team/{sid}/history", params={"limit": 1000})
    r.raise_for_status()
    messages = r.json()["lead"]["messages"]
    for m in reversed(messages):
        if m["role"] == "assistant":
            return m
    return None


def poll_for_last_assistant(
    base: str, sid: str, *, timeout: float = 5.0, interval: float = 0.1
) -> dict | None:
    """Poll ``get_last_assistant`` until a row exists or *timeout* elapses.

    Replaces a fixed ``time.sleep`` after Stop — the checkpointer writes the
    interrupted assistant row asynchronously, so a hard sleep is either too
    short (test flakes) or too long (test slow).
    """
    deadline = time.monotonic() + timeout
    while True:
        msg = get_last_assistant(base, sid)
        if msg is not None:
            return msg
        if time.monotonic() >= deadline:
            return None
        time.sleep(interval)


def print_history(base: str, sid: str) -> None:
    r = httpx.get(f"{base}/team/{sid}/history", params={"limit": 1000})
    r.raise_for_status()
    data = r.json()
    messages = data["lead"]["messages"]

    print(f"\n{'=' * 70}")
    print(f"  Full history for session {sid}")
    print(f"  {len(messages)} message(s)")
    print(f"{'=' * 70}")
    for i, m in enumerate(messages):
        role = m["role"]
        content = (m.get("content") or "").strip()
        # Truncate long content for readability.
        if len(content) > 240:
            content = content[:240] + "…"
        extra = m.get("extra") or {}
        markers: list[str] = []
        if extra.get("is_continuation"):
            markers.append("CONTINUATION")
        if m.get("is_summary"):
            markers.append("SUMMARY")
        if m.get("tool_calls"):
            markers.append(f"TOOL_CALLS={len(m['tool_calls'])}")
        marker_str = f"  [{', '.join(markers)}]" if markers else ""
        print(f"\n  #{i + 1}  role={role}{marker_str}")
        print(f"      {content}")


# ─────────────────────────────────────────────────────────────────────────────
# Main flow
# ─────────────────────────────────────────────────────────────────────────────


def main() -> None:
    p = argparse.ArgumentParser(description="End-to-end /continue smoke test")
    p.add_argument("--base", default=BASE, help="API base URL")
    p.add_argument(
        "--wait-before-stop",
        type=float,
        default=DEFAULT_WAIT_BEFORE_STOP,
        help="Seconds to wait after sending before pressing Stop (default: 3.0)",
    )
    p.add_argument(
        "--wait",
        type=int,
        default=DEFAULT_FINAL_WAIT,
        help="Max seconds to wait for /continue stream completion",
    )
    args = p.parse_args()
    base = args.base.rstrip("/")

    print(f"\n{'=' * 70}")
    print("  [1] Sending initial message — asking for ~200 words")
    print(f"{'=' * 70}")
    sid = post_message(base, PROMPT)

    print(f"\n{'=' * 70}")
    print(f"  [2] Waiting {args.wait_before_stop}s, then sending Stop")
    print(f"{'=' * 70}")
    time.sleep(args.wait_before_stop)
    post_interrupt(base, sid)

    print(f"\n{'=' * 70}")
    print("  [3] Last assistant message after Stop")
    print(f"{'=' * 70}")
    # Checkpointer persists asynchronously; poll up to 5s for the row.
    last = poll_for_last_assistant(base, sid)
    if last is None:
        print("  WARNING: no assistant message found — the model may not have")
        print("           produced any content before Stop fired.  /continue")
        print("           will 409.  Try increasing --wait-before-stop.")
        return
    content = last.get("content") or ""
    print(f"  length: {len(content)} chars")
    print(f"  ends with: ...{content[-160:]!r}")

    print(f"\n{'=' * 70}")
    print("  [4] Dispatching /continue")
    print(f"{'=' * 70}")
    post_continue(base, sid)

    print(f"\n{'=' * 70}")
    print("  [5] Streaming continuation tokens live")
    print(f"{'=' * 70}")
    _done, continued_text = stream_until_done(
        base, sid, timeout=args.wait, label="continue"
    )
    print(f"\n  appended {len(continued_text)} chars from continuation stream")

    print_history(base, sid)


if __name__ == "__main__":
    main()
