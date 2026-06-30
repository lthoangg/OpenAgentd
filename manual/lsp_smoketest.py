"""Smoke-test LSP diagnostics injection in a live chat session.

Flow:
  1. Start a new session by sending a prompt asking the agent to write a file
     with a syntax error (e.g., "Write a file named `test_syntax_error.py` containing only `def foo(`").
  2. Stream the SSE response until the turn is done.
  3. Fetch the session history.
  4. Find the tool call for `write` and verify that the tool response includes
     the `[LSP Diagnostics]` block.
  5. Verify that the assistant's subsequent response acknowledges the error.

Usage:
  uv run python -m manual.lsp_smoketest
  uv run python -m manual.lsp_smoketest --base http://localhost:8000/api
"""

from __future__ import annotations

import argparse
import json
import sys
import time

import httpx

BASE = "http://localhost:8000/api"
PROMPT = (
    "Please use the write tool to write a python file named `test_syntax_error.py` "
    "containing exactly: `def foo(` and nothing else. Do not fix the syntax error; "
    "we want to test if our system detects it."
)


def post_message(base: str, message: str, session_id: str | None = None) -> dict:
    data: dict[str, str] = {"message": message}
    if session_id:
        data["session_id"] = session_id
    response = httpx.post(f"{base}/team/chat", data=data, timeout=30)
    response.raise_for_status()
    return response.json()


def stream_until_done(base: str, session_id: str, wait: int) -> list[dict]:
    events: list[dict] = []
    start = time.monotonic()
    current_event = "message"
    data_buf: list[str] = []

    with httpx.stream(
        "GET", f"{base}/team/{session_id}/stream", timeout=wait + 5
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
        f"{base}/team/{session_id}/history", params={"limit": 1000}, timeout=30
    )
    response.raise_for_status()
    return list(response.json()["lead"]["messages"])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default=BASE)
    parser.add_argument("--wait", type=int, default=120)
    args = parser.parse_args()

    base = args.base.rstrip("/")

    # Check if server is running
    try:
        r = httpx.get(f"{base}/health/ready")
        r.raise_for_status()
    except Exception as e:
        print(f"✗ Dev server is not running or unreachable at {base}. Start it with `make dev` or `uv run python -m app.server` first.")
        return 1

    print(f"Starting session with prompt: {PROMPT!r}")
    first = post_message(base, PROMPT)
    session_id = str(first["session_id"])
    print(f"  session_id={session_id}")

    print("Streaming turn until done...")
    events = stream_until_done(base, session_id, args.wait)

    # Check for errors in the stream
    for item in events:
        if item["event"] == "error":
            print(f"✗ Stream error: {item['data']}")
            return 1

    print("Fetching session history...")
    history = get_history(base, session_id)

    # Look for the tool response of the write tool
    tool_response_text = None
    for msg in history:
        if msg.get("role") == "tool":
            tool_response_text = msg.get("content") or ""
            break

    if not tool_response_text:
        print("✗ Did not find any tool response in history. Did the agent call the write tool?")
        return 1

    print(f"\nObserved tool response:\n{tool_response_text}\n")

    if "[LSP Diagnostics]" not in tool_response_text:
        print("✗ [LSP Diagnostics] block was NOT found in the tool response.")
        print("  Make sure an LSP server (like ruff, pyright-langserver, or pylsp) is installed and available in the server's path.")
        return 1

    print("✓ [LSP Diagnostics] block was successfully injected into the tool response!")

    # Check if the assistant saw the diagnostics in the subsequent turn
    assistant_msgs = [m for m in history if m.get("role") == "assistant"]
    if assistant_msgs:
        final_assistant = assistant_msgs[-1].get("content") or ""
        print(f"Final assistant message:\n{final_assistant}\n")

    print("✓ LSP diagnostics smoke test completed successfully!")
    return 0


if __name__ == "__main__":
    sys.exit(main())
