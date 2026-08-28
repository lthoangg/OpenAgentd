"""Capture and verify the app-wide lifecycle SSE stream.

The global stream is intentionally live-only. This helper subscribes before it
performs optional actions so scheduler/title/notification events are observable.
It is complementary to ``manual.team_sse``; chat tokens never appear here.

Examples:
  uv run python -m manual.global_events --wait 30
  uv run python -m manual.global_events --trigger-task daily-check \
      --expect session_turn_started --expect desktop_notification
  uv run python -m manual.global_events --message "Explain Python context managers" \
      --expect title_update --expect desktop_notification --wait 180
  uv run python -m manual.global_events --out .openagentd/state/global-events.jsonl
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Any

import httpx

from manual._common import DEFAULT_BASE, require_dev_server

KNOWN_EVENTS = {"session_turn_started", "title_update", "desktop_notification"}


def format_event(event: str, data: dict[str, Any]) -> str:
    """Return a compact, human-readable global event summary."""
    session_id = data.get("session_id", "-")
    if event == "session_turn_started":
        return (
            f"session={session_id} source={data.get('source', '-')} "
            f"task={data.get('task_name', '-')}"
        )
    if event == "title_update":
        return f"session={session_id} title={data.get('title', '-')!r}"
    if event == "desktop_notification":
        return (
            f"session={session_id} kind={data.get('kind', '-')} "
            f"title={data.get('title', '-')!r}"
        )
    return json.dumps(data, ensure_ascii=False, sort_keys=True)


def missing_expected(events: list[dict[str, Any]], expected: list[str]) -> list[str]:
    """Return expected event names that were not observed."""
    observed = {str(item.get("event")) for item in events}
    return [event for event in expected if event not in observed]


def _headers(access_key: str | None) -> dict[str, str]:
    return {"Authorization": f"Bearer {access_key}"} if access_key else {}


def _perform_actions(
    base: str,
    headers: dict[str, str],
    trigger_task: str | None,
    message: str | None,
) -> None:
    if trigger_task:
        response = httpx.post(
            f"{base}/scheduler/tasks/{trigger_task}/trigger",
            headers=headers,
            timeout=30,
        )
        response.raise_for_status()
        print(f"triggered scheduled task: {trigger_task}")
    if message:
        response = httpx.post(
            f"{base}/session/chat",
            data={"message": message},
            headers=headers,
            timeout=30,
        )
        response.raise_for_status()
        print(f"started session: {response.json()['session_id']}")


def capture_events(
    base: str,
    *,
    wait: int,
    expected: list[str],
    trigger_task: str | None,
    message: str | None,
    out_path: Path | None,
    access_key: str | None,
) -> list[dict[str, Any]]:
    """Subscribe first, perform optional actions, then collect global events."""
    events: list[dict[str, Any]] = []
    headers = _headers(access_key)
    action_future: Future[None] | None = None
    started = time.monotonic()
    out_file = out_path.open("w", encoding="utf-8") if out_path else None

    try:
        with (
            httpx.stream(
                "GET",
                f"{base}/events/stream",
                headers=headers,
                timeout=wait + 5,
            ) as response,
            ThreadPoolExecutor(max_workers=1) as executor,
        ):
            response.raise_for_status()
            if trigger_task or message:
                action_future = executor.submit(
                    _perform_actions, base, headers, trigger_task, message
                )

            current_event = "message"
            data_lines: list[str] = []
            for line in response.iter_lines():
                elapsed = time.monotonic() - started
                if elapsed > wait:
                    break
                if line.startswith("event:"):
                    current_event = line[6:].strip()
                elif line.startswith("data:"):
                    data_lines.append(line[5:].strip())
                elif line == "" and data_lines:
                    raw = "\n".join(data_lines)
                    data_lines = []
                    try:
                        data = json.loads(raw)
                    except json.JSONDecodeError:
                        data = {"_raw": raw}
                    item = {"event": current_event, "data": data}
                    events.append(item)
                    print(
                        f"{elapsed:>7.2f}s  {current_event:22s} {format_event(current_event, data)}"
                    )
                    if out_file:
                        out_file.write(
                            json.dumps(
                                {"t": round(elapsed, 3), **item}, ensure_ascii=False
                            )
                            + "\n"
                        )
                        out_file.flush()
                    if expected and not missing_expected(events, expected):
                        break
    except httpx.ReadTimeout:
        pass
    finally:
        if out_file:
            out_file.close()

    if action_future:
        action_future.result()
    return events


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Capture app-global SSE lifecycle and metadata events"
    )
    parser.add_argument("--base", default=DEFAULT_BASE, help="API base URL")
    parser.add_argument("--wait", type=int, default=60, help="Maximum wait in seconds")
    parser.add_argument(
        "--expect", action="append", default=[], choices=sorted(KNOWN_EVENTS)
    )
    parser.add_argument(
        "--trigger-task",
        help="Trigger this existing scheduler task slug after subscribing",
    )
    parser.add_argument(
        "--message",
        help="Send a normal chat message after subscribing (can generate title/completion events)",
    )
    parser.add_argument("--out", type=Path, help="Write captured events as JSONL")
    parser.add_argument("--key", help="Optional backend access key")
    args = parser.parse_args()

    base = args.base.rstrip("/")
    require_dev_server(base, access_key=args.key)
    expected = list(args.expect)
    events = capture_events(
        base,
        wait=args.wait,
        expected=expected,
        trigger_task=args.trigger_task,
        message=args.message,
        out_path=args.out,
        access_key=args.key,
    )

    missing = missing_expected(events, expected)
    if missing:
        print(f"missing expected events: {', '.join(missing)}", file=sys.stderr)
        raise SystemExit(1)
    print(f"captured {len(events)} global event(s)")


if __name__ == "__main__":
    main()
