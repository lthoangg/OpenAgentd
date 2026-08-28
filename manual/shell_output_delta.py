"""Manual smoke test for live shell tool output deltas.

Prerequisites: server running on http://localhost:8000.

Usage:
  uv run python -m manual.shell_output_delta
  uv run python -m manual.shell_output_delta --base http://localhost:4082/api
"""

from __future__ import annotations

import argparse
import json
import time

import httpx


from manual._common import DEFAULT_BASE
BASE = DEFAULT_BASE
DEFAULT_MESSAGE = (
    "Use the shell tool to run exactly: "
    "for i in 1 2 3; do echo delta-$i; sleep 1; done"
)


def _post_turn(base: str, message: str) -> str:
    response = httpx.post(f"{base}/session/chat", data={"message": message}, timeout=30)
    response.raise_for_status()
    return str(response.json()["session_id"])


def _stream(base: str, session_id: str, wait: int) -> bool:
    start = time.monotonic()
    saw_delta = False
    current_event = "message"
    data_buf: list[str] = []

    with httpx.stream(
        "GET", f"{base}/session/{session_id}/stream", timeout=wait + 5
    ) as response:
        response.raise_for_status()
        for line in response.iter_lines():
            if time.monotonic() - start > wait:
                break
            if line.startswith("event:"):
                current_event = line[6:].strip()
            elif line.startswith("data:"):
                data_buf.append(line[5:].strip())
            elif line == "":
                if not data_buf:
                    continue
                data = json.loads("\n".join(data_buf))
                data_buf = []
                if current_event == "tool_output_delta":
                    saw_delta = True
                    print(data.get("text", ""), end="")
                elif current_event == "done":
                    break

    return saw_delta


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default=DEFAULT_BASE)
    parser.add_argument("--message", default=DEFAULT_MESSAGE)
    parser.add_argument("--wait", type=int, default=90)
    args = parser.parse_args()

    session_id = _post_turn(args.base, args.message)
    print(f"session: {session_id}")
    saw_delta = _stream(args.base, session_id, args.wait)
    print(f"\ntool_output_delta: {'seen' if saw_delta else 'missing'}")
    raise SystemExit(0 if saw_delta else 1)


if __name__ == "__main__":
    main()
