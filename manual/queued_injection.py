"""Smoke-test queued follow-up injection into a running turn.

Flow:
  1. Send a prompt that should keep the lead busy long enough to queue follow-ups.
  2. After a short delay, send one or more follow-up messages on the same session.
  3. Assert every follow-up POST returns ``status=queued``.
  4. Stream SSE and assert ``queued_turn_start`` for the queued messages arrives
     before ``done``.
  5. Read history and assert each queued row is now visible (no
     ``extra.queue_status=queued``).
  6. Assert the final assistant answer contains the expected exact tokens.

This covers the mid-turn splice path added by QueuedMessageInjectionHook.  It is
still a smoke test: the first prompt asks the agent to use a slow shell command,
so a misbehaving model that refuses tool use may finish before the follow-ups can
queue. In that case the script exits non-zero with the observed status.

Usage:
  uv run python -m manual.queued_injection
  uv run python -m manual.queued_injection --queue-delay 0.2 --between-delay 0.1
  uv run python -m manual.queued_injection --followup "include TOKEN-X" --expect TOKEN-X
  uv run python -m manual.queued_injection --base http://localhost:4082/api
"""

from __future__ import annotations

import argparse
import json
import sys
import time

import httpx


from manual._common import DEFAULT_BASE

BASE = DEFAULT_BASE
DEFAULT_INITIAL = (
    "You must call the shell tool before answering. Run exactly: "
    "sleep 8 && echo QUEUED_INJECTION_TOOL_DONE. Do not answer until the shell "
    "tool result is available. After the tool finishes, answer with a compact "
    "checklist that includes every queued instruction you received."
)
DEFAULT_FOLLOWUPS = [
    (
        "Additional instruction for this same running turn: include the exact "
        "token ALPHA-QUEUED-OK in your final answer."
    ),
    (
        "Additional instruction for this same running turn: include the exact "
        "token BETA-QUEUED-OK in your final answer."
    ),
    (
        "Additional instruction for this same running turn: answer this too: "
        "my name is Hoang."
    ),
]
DEFAULT_EXPECT = ["ALPHA-QUEUED-OK", "BETA-QUEUED-OK", "Hoang"]


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
    response = httpx.post(f"{base}/agent/chat", data=data, timeout=30)
    response.raise_for_status()
    return response.json()


def stream_until_done(base: str, session_id: str, wait: int) -> list[dict]:
    events: list[dict] = []
    start = time.monotonic()
    current_event = "message"
    data_buf: list[str] = []

    with httpx.stream(
        "GET", f"{base}/agent/{session_id}/stream", timeout=wait + 5
    ) as response:
        response.raise_for_status()
        for line in response.iter_lines():
            if time.monotonic() - start > wait:
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
    response = httpx.get(
        f"{base}/agent/{session_id}/history", params={"limit": 1000}, timeout=30
    )
    response.raise_for_status()
    return list(response.json()["lead"]["messages"])


def event_index(events: list[dict], event: str, message_id: str | None = None) -> int:
    for i, item in enumerate(events):
        if item["event"] != event:
            continue
        if message_id is None:
            return i
        ids = item.get("data", {}).get("message_ids") or []
        if message_id in ids:
            return i
    return -1


def _final_assistant_text(history: list[dict]) -> str:
    for row in reversed(history):
        if row.get("role") == "assistant":
            return str(row.get("content") or "")
    return ""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default=BASE)
    parser.add_argument("--model", default=None, help="Model override")
    parser.add_argument("--initial", default=DEFAULT_INITIAL)
    parser.add_argument(
        "--followup",
        action="append",
        help="Queued follow-up message. May be repeated. Defaults to three checks.",
    )
    parser.add_argument(
        "--expect",
        action="append",
        help="Exact token/text expected in the final assistant answer. May be repeated.",
    )
    parser.add_argument("--queue-delay", type=float, default=0.5)
    parser.add_argument("--between-delay", type=float, default=0.2)
    parser.add_argument("--wait", type=int, default=160)
    args = parser.parse_args()

    base = args.base.rstrip("/")
    followups = args.followup if args.followup is not None else DEFAULT_FOLLOWUPS
    expected = args.expect if args.expect is not None else DEFAULT_EXPECT

    print(f"sending initial prompt: {args.initial!r}")
    first = post_message(base, args.initial, model=args.model)
    session_id = str(first["session_id"])
    print(f"  session={session_id}")

    time.sleep(args.queue_delay)
    queued_ids: list[str] = []
    for index, followup in enumerate(followups, start=1):
        print(
            f"sending queued follow-up #{index} after delay "
            f"{args.queue_delay if index == 1 else args.between_delay}s: {followup!r}"
        )
        response = post_message(base, followup, session_id=session_id, model=args.model)
        print(f"  response={response}")
        if response.get("status") != "queued":
            print(
                "\n✗ follow-up was not queued; initial turn likely finished too quickly"
            )
            return 1
        queued_id = str(response.get("message_id") or "")
        if not queued_id:
            print("\n✗ backend queued response did not include message_id")
            return 1
        queued_ids.append(queued_id)
        if index != len(followups):
            time.sleep(args.between_delay)

    print("streaming until done...")
    events = stream_until_done(base, session_id, args.wait)
    counts: dict[str, int] = {}
    for item in events:
        counts[item["event"]] = counts.get(item["event"], 0) + 1
    print(f"  event counts={counts}")

    done_idx = event_index(events, "done")
    error_idx = event_index(events, "error")
    if error_idx >= 0:
        print(f"\n✗ stream emitted error: {events[error_idx].get('data')}")
        return 1
    if done_idx < 0:
        print("\n✗ stream did not complete with done")
        return 1

    for queued_id in queued_ids:
        queued_idx = event_index(events, "queued_turn_start", queued_id)
        if queued_idx < 0:
            print(f"\n✗ did not see queued_turn_start for queued message {queued_id}")
            return 1
        if queued_idx > done_idx:
            print(
                f"\n✗ queued_turn_start for {queued_id} arrived after done, "
                "not mid-running-turn"
            )
            return 1
        print(
            f"  queued_turn_start[{queued_id}] index={queued_idx}, done index={done_idx}"
        )

    history = get_history(base, session_id)
    roles = [m.get("role") for m in history]
    print(f"  history roles={roles}")

    for queued_id in queued_ids:
        queued_rows = [m for m in history if m.get("id") == queued_id]
        if len(queued_rows) != 1:
            print(
                f"\n✗ expected exactly one history row for queued id {queued_id}, "
                f"got {len(queued_rows)}"
            )
            return 1
        row = queued_rows[0]
        extra = row.get("extra") or {}
        if extra.get("queue_status") == "queued":
            print(f"\n✗ queued row {queued_id} is still marked queued after injection")
            return 1
        if row.get("exclude_from_context"):
            print(f"\n✗ queued row {queued_id} is still excluded from context")
            return 1

    final_text = _final_assistant_text(history)
    print(f"  final assistant: {final_text!r}")
    missing = [token for token in expected if token not in final_text]
    if missing:
        print(f"\n✗ final assistant answer is missing expected text: {missing}")
        return 1

    print(
        "\n✓ queued follow-ups were injected before turn completion, persisted visible, "
        "and covered by the final answer"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
