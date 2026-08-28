"""Verify Stop + additional-message stacking semantic.

Sends ``msg_A`` ("Reply with the exact word HELLO"), waits briefly, presses
Stop, then sends ``msg_B`` ("Also reply with the exact word WORLD"). After
the follow-up turn completes we read history and check whether the final
assistant reply contains **both** words — which is the contract for the
"I forgot to add..." pattern (consecutive user rows are additive context,
not a replace).

Three outcomes are possible:

* ``[user_A, asst_with_HELLO, user_B, asst_with_WORLD]`` — turn 1 finished
  before Stop landed. Final asst content should contain ``WORLD``; the
  earlier asst already had ``HELLO``. Additive contract holds across rows.
* ``[user_A, user_B, asst]`` — Stop caught before any token of turn 1
  was emitted. Final asst should contain **both** ``HELLO`` and
  ``WORLD``. This is the case we care about most.
* anything else — investigate.

Usage:
  uv run python -m manual.stop_additive
  uv run python -m manual.stop_additive --wait 0.3      # force user/user case
  uv run python -m manual.stop_additive --wait 5        # likely fall-through
"""

from __future__ import annotations

import argparse
import sys
import time

import httpx

from manual._common import DEFAULT_BASE
BASE = DEFAULT_BASE
MSG_A = "Include the word HELLO in your reply."
MSG_B = "Also include the word WORLD."
FOLLOWUP_TIMEOUT = 120


def post_message(base: str, message: str, session_id: str | None = None) -> str:
    data: dict[str, str] = {"message": message}
    if session_id:
        data["session_id"] = session_id
    r = httpx.post(f"{base}/session/chat", data=data, timeout=20)
    r.raise_for_status()
    return r.json()["session_id"]


def post_interrupt(base: str, sid: str) -> None:
    r = httpx.post(
        f"{base}/session/chat", data={"session_id": sid, "interrupt": "true"}, timeout=20
    )
    r.raise_for_status()


def wait_for_done(base: str, sid: str, timeout: int) -> str:
    deadline = time.monotonic() + timeout
    with httpx.stream("GET", f"{base}/session/{sid}/stream", timeout=timeout + 5) as r:
        current = ""
        for line in r.iter_lines():
            if time.monotonic() > deadline:
                return "timeout"
            if line.startswith("event:"):
                current = line[6:].strip()
                if current in ("done", "error"):
                    return current
    return current


def get_history(base: str, sid: str) -> list[dict]:
    r = httpx.get(f"{base}/session/{sid}/history", params={"limit": 1000}, timeout=20)
    r.raise_for_status()
    return r.json()["session"]["messages"]


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--base", default=BASE)
    p.add_argument("--wait", type=float, default=0.3,
                   help="Seconds between sending msg_A and pressing Stop (default 0.3)")
    args = p.parse_args()
    base = args.base.rstrip("/")

    print(f"sending msg_A: {MSG_A!r}")
    sid = post_message(base, MSG_A)
    print(f"  session={sid}")

    time.sleep(args.wait)
    print(f"after {args.wait}s — pressing Stop")
    post_interrupt(base, sid)
    time.sleep(3.0)  # let the interrupt settle + checkpointer flush

    print(f"sending msg_B: {MSG_B!r}")
    post_message(base, MSG_B, session_id=sid)
    outcome = wait_for_done(base, sid, FOLLOWUP_TIMEOUT)
    print(f"follow-up stream result: {outcome!r}")

    msgs = get_history(base, sid)
    print(f"\nfinal history ({len(msgs)} msgs):")
    for i, m in enumerate(msgs):
        role = m.get("role", "?")
        content = (m.get("content") or "").replace("\n", " ")[:120]
        tcn = len(m.get("tool_calls") or [])
        marker = f" [tool_calls={tcn}]" if tcn else ""
        print(f"  #{i} {role:<10}{marker} {content!r}")

    # Classify shape.
    roles = [m.get("role") for m in msgs]
    text_blobs = [
        (m.get("content") or "").upper() for m in msgs if m.get("role") == "assistant"
    ]
    all_asst = " ".join(text_blobs)

    has_hello = "HELLO" in all_asst
    has_world = "WORLD" in all_asst

    print(f"\nroles: {roles}")
    print(f"HELLO present in any assistant content: {has_hello}")
    print(f"WORLD present in any assistant content: {has_world}")

    # Verdict.
    if has_hello and has_world:
        print("\n✓ ADDITIVE CONTRACT HELD — both words appear across the conversation.")
        return 0
    if has_world and not has_hello:
        # OK iff turn 1 actually completed before Stop and msg_A's reply is missing.
        # Otherwise msg_A's intent was dropped.
        print("\n✗ ADDITIVE CONTRACT VIOLATED — msg_A's instruction (HELLO) was dropped.")
        return 1
    if has_hello and not has_world:
        print("\n✗ msg_B was ignored entirely (no WORLD).")
        return 1
    print("\n✗ Neither word present — agent didn't follow either instruction.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
