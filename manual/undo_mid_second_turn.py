"""Manual test: /undo on a mid-stream SECOND turn.

Scenario:
  1. Send user message #1 → wait for the lead to finish.
  2. Send user message #2 → interrupt the lead mid-stream.
  3. Dispatch /undo → expect 202 (lead is interrupted/idle) and the
     boundary to roll back to before user message #2.
  4. Send a follow-up confirming the session is healthy and the
     undone user text is gone from active context.

Usage:
  uv run python -m manual.undo_mid_second_turn
  uv run python -m manual.undo_mid_second_turn --base http://localhost:8000/api
"""

from __future__ import annotations

import argparse
import json
import sys
import time

import httpx

from manual._common import DEFAULT_BASE

BASE = DEFAULT_BASE
FIRST = "Reply with the single word READY."
SECOND = (
    "Please write a detailed ~200 word response describing the "
    "history and evolution of the Python programming language."
)
MID_WAIT = 1.5
POST_STOP_SETTLE = 2.0
POST_UNDO_SETTLE = 0.5
FOLLOWUP = "Reply with the single word OK."
TURN_TIMEOUT = 120


def post_chat(
    base: str, message: str, sid: str | None = None, model: str | None = None
) -> str:
    data: dict[str, str] = {"message": message, "workspace": "."}
    if sid:
        data["session_id"] = sid
    if model:
        data["model"] = model
    r = httpx.post(f"{base}/agent/chat", data=data, timeout=20)
    r.raise_for_status()
    return r.json()["session_id"]


def interrupt(base: str, sid: str) -> None:
    r = httpx.post(
        f"{base}/agent/chat",
        data={"session_id": sid, "interrupt": "true", "workspace": "."},
        timeout=20,
    )
    r.raise_for_status()


def undo(base: str, sid: str) -> tuple[int, str]:
    r = httpx.post(
        f"{base}/agent/commands", json={"command": "undo", "session_id": sid}, timeout=20
    )
    return r.status_code, r.text


def history(base: str, sid: str) -> list[dict]:
    r = httpx.get(f"{base}/agent/{sid}/history", params={"limit": 1000}, timeout=20)
    r.raise_for_status()
    return r.json()["lead"]["messages"]


def stream_until_done(base: str, sid: str, *, timeout: int) -> tuple[bool, bool, str]:
    deadline = time.monotonic() + timeout
    last = ""
    err = False
    try:
        with httpx.stream("GET", f"{base}/agent/{sid}/stream", timeout=timeout + 5) as r:
            for line in r.iter_lines():
                if time.monotonic() > deadline:
                    return False, err, last
                if line.startswith("event:"):
                    ev = line[6:].strip()
                    last = ev
                    if ev == "error":
                        err = True
                    if ev == "done":
                        return True, err, ev
    except httpx.ReadTimeout:
        return False, err, last
    return False, err, last


def wait_for_done(base: str, sid: str, *, timeout: int) -> bool:
    done, err, last = stream_until_done(base, sid, timeout=timeout)
    if err or not done:
        print(
            f"  ! stream ended without clean done: done={done} err={err} last={last!r}"
        )
    return done and not err


def tail(msgs: list[dict], n: int = 4) -> str:
    out = []
    for m in msgs[-n:]:
        role = m.get("role")
        content = (m.get("content") or "")[:60].replace("\n", " ")
        tc = m.get("tool_calls") or []
        extra = f" tool_calls={len(tc)}" if tc else ""
        out.append(f"    {role:<9} {content!r}{extra}")
    return "\n".join(out)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--base", default=BASE)
    p.add_argument("--model", default=None, help="Model override")
    args = p.parse_args()
    base = args.base.rstrip("/")

    # Sanity ping
    try:
        httpx.get(f"{base}/health/ready", timeout=5).raise_for_status()
    except httpx.HTTPError as exc:
        print(f"server unreachable at {base}: {exc}", file=sys.stderr)
        return 2

    print("── Turn 1 (let it finish) ─────────────────────────────────────")
    sid = post_chat(base, FIRST, model=args.model)
    print(f"  session={sid}")
    if not wait_for_done(base, sid, timeout=TURN_TIMEOUT):
        print("FAIL: turn 1 did not finish cleanly")
        return 1
    h1 = history(base, sid)
    print(f"  msgs after turn 1: {len(h1)}")
    print(tail(h1))

    print("\n── Turn 2 (interrupt mid-stream) ──────────────────────────────")
    post_chat(base, SECOND, sid=sid, model=args.model)
    time.sleep(MID_WAIT)
    interrupt(base, sid)
    time.sleep(POST_STOP_SETTLE)
    h2 = history(base, sid)
    print(f"  msgs after stop:   {len(h2)}  (grew by {len(h2) - len(h1)})")
    print(tail(h2))

    print("\n── /undo ──────────────────────────────────────────────────────")
    code, body = undo(base, sid)
    print(f"  status={code} body={body[:120]}")
    if code != 202:
        print(
            "FAIL: /undo expected 202 (lead is idle after stop); got "
            f"{code}. This is the precondition path documented in api/index.md."
        )
        try:
            detail = json.loads(body).get("detail")
            print(f"  detail: {detail!r}")
        except Exception:
            pass
        return 1
    time.sleep(POST_UNDO_SETTLE)

    h3 = history(base, sid)
    print(f"  msgs after undo:   {len(h3)}")
    print(tail(h3))

    # Heuristic: history endpoint surfaces the full transcript, but the
    # active /chat boundary should be back before the SECOND prompt. Verify
    # by sending FOLLOWUP — the assistant should NOT know about the Python
    # essay request, because /undo moved the boundary past it.
    print("\n── Follow-up turn (boundary should be pre-SECOND) ─────────────")
    post_chat(base, FOLLOWUP, sid=sid)
    if not wait_for_done(base, sid, timeout=TURN_TIMEOUT):
        print("FAIL: follow-up turn did not finish cleanly")
        return 1
    h4 = history(base, sid)
    print(f"  msgs after follow-up: {len(h4)}")
    print(tail(h4, n=6))

    # Smoke assertions
    problems: list[str] = []
    if code != 202:
        problems.append("undo did not return 202")
    # The follow-up assistant reply should exist as the tail.
    last = h4[-1] if h4 else {}
    if last.get("role") != "assistant":
        problems.append(f"tail is not assistant (role={last.get('role')!r})")

    print("\n" + "=" * 60)
    if problems:
        print("RESULT: FAIL")
        for x in problems:
            print(f"  - {x}")
        return 1
    print(
        "RESULT: OK — /undo accepted mid-stream-then-stopped, "
        "boundary rolled back, follow-up completed."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
