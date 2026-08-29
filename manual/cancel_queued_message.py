"""Smoke-test DELETE /agent/sessions/{session_id}/queued-messages/{message_id}.

Flow:
  1. Send a slow initial prompt so the lead stays busy long enough to queue.
  2. Queue a follow-up message, capturing its message_id.
  3. Immediately DELETE that queued message via the cancel endpoint.
  4. Assert the DELETE returns 204.
  5. Assert a second DELETE on the same id returns 404 (row is gone).
  6. Stream until done and assert no ``queued_turn_start`` event for the
     cancelled id — the message was never injected.
  7. Read history and assert the cancelled message id is absent — it was
     hard-deleted from the database.

Usage:
  uv run python -m manual.cancel_queued_message
  uv run python -m manual.cancel_queued_message --queue-delay 0.3
  uv run python -m manual.cancel_queued_message --base http://localhost:4082/api
"""

from __future__ import annotations

import argparse
import json
import sys
import time

import httpx

from manual._common import DEFAULT_BASE

BASE = DEFAULT_BASE
INITIAL_PROMPT = (
    "You must call the shell tool before answering. "
    "Run exactly: sleep 8 && echo CANCEL_QUEUE_SMOKE_DONE. "
    "Do not answer until the shell tool result is available."
)
FOLLOWUP = "Additional instruction: include the token SHOULD_NOT_APPEAR in your reply."
STREAM_WAIT = 60


def post_message(
    base: str,
    message: str,
    session_id: str | None = None,
    model: str | None = None,
) -> dict:
    data: dict[str, str] = {"message": message, "workspace": "."}
    if session_id:
        data["session_id"] = session_id
    if model:
        data["model"] = model
    r = httpx.post(f"{base}/agent/chat", data=data, timeout=20)
    r.raise_for_status()
    return r.json()


def delete_queued(base: str, session_id: str, message_id: str) -> int:
    r = httpx.delete(
        f"{base}/agent/sessions/{session_id}/queued-messages/{message_id}",
        timeout=10,
    )
    return r.status_code


def stream_until_done(base: str, session_id: str, wait: int) -> list[dict]:
    events: list[dict] = []
    deadline = time.monotonic() + wait
    current_event = "message"
    data_buf: list[str] = []
    with httpx.stream("GET", f"{base}/agent/{session_id}/stream", timeout=wait + 5) as r:
        r.raise_for_status()
        for line in r.iter_lines():
            if time.monotonic() > deadline:
                events.append({"event": "timeout", "data": {}})
                break
            if line.startswith("event:"):
                current_event = line[6:].strip()
            elif line.startswith("data:"):
                data_buf.append(line[5:].strip())
            elif line == "":
                if not data_buf:
                    continue
                raw = "\n".join(data_buf)
                data_buf = []
                try:
                    data = json.loads(raw)
                except json.JSONDecodeError:
                    data = {"_raw": raw}
                events.append({"event": current_event, "data": data})
                if current_event in {"done", "error"}:
                    break
    return events


def get_history(base: str, session_id: str) -> list[dict]:
    r = httpx.get(
        f"{base}/agent/{session_id}/history", params={"limit": 1000}, timeout=20
    )
    r.raise_for_status()
    return list(r.json()["lead"]["messages"])


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--base", default=BASE)
    p.add_argument("--model", default=None, help="Model override")
    p.add_argument(
        "--queue-delay",
        type=float,
        default=0.5,
        help="Seconds to wait before queuing the follow-up (default 0.5)",
    )
    args = p.parse_args()
    base = args.base.rstrip("/")

    print(f"sending initial prompt: {INITIAL_PROMPT!r}")
    first = post_message(base, INITIAL_PROMPT, model=args.model)
    session_id = str(first["session_id"])
    print(f"  session={session_id}")

    time.sleep(args.queue_delay)

    print(f"queuing follow-up after {args.queue_delay}s: {FOLLOWUP!r}")
    queued = post_message(base, FOLLOWUP, session_id=session_id, model=args.model)
    print(f"  response={queued}")
    if queued.get("status") != "queued":
        print("\n✗ follow-up was not queued — initial turn likely finished too quickly")
        return 1
    message_id = str(queued.get("message_id") or "")
    if not message_id:
        print("\n✗ backend queued response did not include message_id")
        return 1
    print(f"  message_id={message_id}")

    print("cancelling via DELETE...")
    status = delete_queued(base, session_id, message_id)
    print(f"  DELETE status={status}")
    if status != 204:
        print(f"\n✗ expected 204, got {status}")
        return 1
    print("  ✓ 204 No Content")

    print("second DELETE on same id (must be 404)...")
    status2 = delete_queued(base, session_id, message_id)
    print(f"  DELETE status={status2}")
    if status2 != 404:
        print(
            f"\n✗ expected 404 on second delete, got {status2} — row was not hard-deleted"
        )
        return 1
    print("  ✓ 404 Not Found (row gone from DB)")

    print(f"streaming until done (max {STREAM_WAIT}s)...")
    events = stream_until_done(base, session_id, STREAM_WAIT)
    counts: dict[str, int] = {}
    for item in events:
        counts[item["event"]] = counts.get(item["event"], 0) + 1
    print(f"  event counts={counts}")

    if any(item["event"] == "error" for item in events):
        err = next(item for item in events if item["event"] == "error")
        print(f"\n✗ stream emitted error: {err.get('data')}")
        return 1
    if not any(item["event"] == "done" for item in events):
        print("\n✗ stream did not complete with done")
        return 1

    injected = any(
        item["event"] == "queued_turn_start"
        and message_id in (item.get("data", {}).get("message_ids") or [])
        for item in events
    )
    if injected:
        print(f"\n✗ cancelled message {message_id} was injected as queued_turn_start")
        return 1
    print("  ✓ no queued_turn_start for cancelled message")

    print("checking history...")
    history = get_history(base, session_id)
    ids_in_history = {str(m.get("id")) for m in history}
    if message_id in ids_in_history:
        print(
            f"\n✗ cancelled message {message_id} still appears in history — not deleted from DB"
        )
        return 1
    print("  ✓ cancelled message absent from history (hard-deleted)")

    print("\n✓ cancel-queued-message smoke passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
