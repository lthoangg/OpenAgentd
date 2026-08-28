"""Verify ToolResultOffloadHook offloads large tool results to disk.

Prerequisites: server running on http://localhost:8000 (dev API).

What it checks:
  1. Sends a prompt that triggers web_fetch on a large file (CPython
     argparse.py, ~114KB), which exceeds ToolResultOffloadHook's char
     threshold (40,000 chars).
  2. Verifies the tool_end SSE event for web_fetch carries the offload
     marker instead of the raw content.
  3. Confirms the full result was written under the session's
     ``.tool_results/{agent_name}/{tool_call_id}.txt`` artifact path.
  4. Asks the agent to `read` the offloaded path back and confirms that
     succeeds without re-triggering an offload (the hook special-cases
     ``read`` to avoid a circular offload-of-an-offload loop).

Usage:
  uv run python -m manual.tool_result_offload_test
  uv run python -m manual.tool_result_offload_test --base http://localhost:8000/api
  uv run python -m manual.tool_result_offload_test --wait 180
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import httpx

from app.agent.artifacts import tool_results_dir

from manual._common import DEFAULT_BASE
BASE = DEFAULT_BASE
DEFAULT_WAIT = 180
# Large file — CPython argparse.py (~114KB), well above the offload hook's
# 40,000-char threshold. ast.py (~27KB) used to be the fixture here but no
# longer clears the threshold and must not be reused for this test.
LARGE_FILE_URL = "https://raw.githubusercontent.com/python/cpython/main/Lib/argparse.py"
OFFLOAD_MARKER = "[Tool result offloaded"


def _post_turn(base: str, message: str, session_id: str | None) -> str:
    payload: dict[str, str] = {"message": message}
    if session_id:
        payload["session_id"] = session_id
    response = httpx.post(f"{base}/session/chat", data=payload, timeout=30)
    response.raise_for_status()
    return str(response.json()["session_id"])


def _stream_events(base: str, session_id: str, wait: int) -> list[dict]:
    """Drain the team SSE stream, returning every ``{event, data}`` pair seen."""
    events: list[dict] = []
    start = time.monotonic()
    current_event = "message"
    data_buf: list[str] = []
    with httpx.stream(
        "GET", f"{base}/session/{session_id}/stream", timeout=wait + 5
    ) as response:
        response.raise_for_status()
        for line in response.iter_lines():
            if time.monotonic() - start > wait:
                print("  [timeout while waiting for done]")
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
                events.append({"event": current_event, "data": data})
                if current_event == "done":
                    break
    return events


def _tool_ends(events: list[dict], name: str) -> list[dict]:
    return [
        e["data"]
        for e in events
        if e["event"] == "tool_end" and e["data"].get("name") == name
    ]


def _agent_name(base: str) -> str:
    """Return the lead agent's name (first entry of ``GET /session/agents``)."""
    response = httpx.get(f"{base}/session/agents", timeout=10)
    response.raise_for_status()
    agents = response.json().get("agents") or []
    if not agents:
        raise RuntimeError("GET /session/agents returned no agents")
    return str(agents[0]["name"])


def run(base: str, wait: int) -> int:
    print("=" * 60)
    print("ToolResultOffloadHook Manual Test")
    print("=" * 60)

    agent_name = _agent_name(base)
    print(f"Agent: {agent_name}")

    # ── Test 1: trigger offload via web_fetch ─────────────────────────────
    print("\n[1/3] Fetching large file to trigger offload...")
    prompt = (
        f"Use web_fetch to fetch {LARGE_FILE_URL} "
        "and tell me the first function defined in the file."
    )
    sid = _post_turn(base, prompt, None)
    print(f"  Session: {sid}")
    events = _stream_events(base, sid, wait)

    web_fetch_ends = _tool_ends(events, "web_fetch")
    offloaded_end = next(
        (e for e in web_fetch_ends if OFFLOAD_MARKER in (e.get("result") or "")),
        None,
    )
    if offloaded_end is None:
        print("  [FAIL] No offload marker found in any web_fetch tool_end event")
        for e in web_fetch_ends:
            print(f"         preview: {(e.get('result') or '')[:120]!r}")
        return 1
    tc_id = str(offloaded_end.get("tool_call_id") or "")
    print(f"  [PASS] tool_end carries offload marker (tool_call_id={tc_id[:16]}...)")

    # ── Test 2: check file on disk ────────────────────────────────────────
    print("\n[2/3] Checking session artifacts for the offloaded file...")
    offload_path: Path = tool_results_dir(agent_name, sid) / f"{tc_id}.txt"
    if offload_path.exists():
        size = offload_path.stat().st_size
        lines = sum(1 for _ in offload_path.open())
        print(f"  [PASS] File exists: {offload_path}")
        print(f"         Size: {size:,} bytes · {lines:,} lines")
        print(f"         First 100 chars: {offload_path.read_text()[:100]!r}")
        file_ok = True
    else:
        print(f"  [FAIL] Offload file not found: {offload_path}")
        file_ok = False

    # ── Test 3: agent can `read` the offloaded file (no circular loop) ────
    print("\n[3/3] Verifying the agent can `read` the offloaded path...")
    prompt2 = f"Use read to read '{offload_path}' and tell me the first 3 lines."
    sid = _post_turn(base, prompt2, sid)
    events2 = _stream_events(base, sid, wait)

    read_ends = _tool_ends(events2, "read")
    read_offloaded = any(
        OFFLOAD_MARKER in (e.get("result") or "") for e in read_ends
    )
    done_ok = any(e["event"] == "done" for e in events2)

    if done_ok and read_ends and not read_offloaded:
        print("  [PASS] read completed without triggering a second offload")
        read_ok = True
    elif read_offloaded:
        print("  [FAIL] read result was itself offloaded — circular loop bug!")
        read_ok = False
    else:
        print("  [FAIL] turn did not complete a `read` tool call as expected")
        read_ok = False
    if read_ends:
        print(f"  read result preview: {(read_ends[0].get('result') or '')[:200]!r}")

    print("\n" + "=" * 60)
    print(f"[{'PASS' if offloaded_end else 'FAIL'}] Offload fires on large web_fetch result")
    print(f"[{'PASS' if file_ok else 'FAIL'}] File written to session artifacts")
    print(f"[{'PASS' if read_ok else 'FAIL'}] read can access the offloaded file without looping")
    print("=" * 60)
    return 0 if (offloaded_end and file_ok and read_ok) else 1


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Test ToolResultOffloadHook")
    p.add_argument("--base", default=BASE, help="API base URL")
    p.add_argument(
        "--wait", type=int, default=DEFAULT_WAIT, help="Timeout per turn (seconds)"
    )
    args = p.parse_args()
    raise SystemExit(run(args.base.rstrip("/"), args.wait))
