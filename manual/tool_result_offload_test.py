"""Test ToolResultOffloadHook — verifies large tool results are offloaded to workspace.

Usage:
  uv run python -m manual.tool_result_offload_test
  uv run python -m manual.tool_result_offload_test --base http://localhost:8000
  uv run python -m manual.tool_result_offload_test --wait 90

What it checks:
  1. Sends a prompt that triggers web_fetch on a large file (CPython ast.py ~25KB)
  2. Verifies the tool_end SSE event contains the offload marker
  3. Checks the workspace for the .tool_results/ file
  4. Verifies the agent can read the offloaded file via read_file (no circular loop)
  5. Reports PASS / FAIL with details
"""

import argparse
import json
import time
from pathlib import Path

import httpx

from app.core.paths import workspace_dir

from manual._common import DEFAULT_BASE
BASE = DEFAULT_BASE
DEFAULT_WAIT = 120
# Me large file — CPython ast.py is ~25KB, well above 8000-char threshold
LARGE_FILE_URL = "https://raw.githubusercontent.com/python/cpython/main/Lib/ast.py"


def post_and_wait(
    base: str, message: str, session_id: str | None, timeout: int
) -> tuple[str, list[dict]]:
    """Send a message and wait for done, returning (session_id, events)."""
    payload: dict = {"message": message}
    if session_id:
        payload["session_id"] = session_id
    r = httpx.post(f"{base}/chat", data=payload)
    r.raise_for_status()
    sid = r.json()["session_id"]

    events = []
    deadline = time.time() + timeout
    with httpx.stream("GET", f"{base}/chat/stream/{sid}", timeout=timeout + 5) as resp:
        for line in resp.iter_lines():
            if time.time() > deadline:
                print("  [TIMEOUT]")
                break
            if line.startswith("data:"):
                raw = line[5:].strip()
                if not raw:
                    continue
                try:
                    ev = json.loads(raw)
                    events.append(ev)
                    if ev.get("type") == "done":
                        break
                except json.JSONDecodeError:
                    pass
    return sid, events


def check_offload_in_events(events: list[dict]) -> tuple[bool, str]:
    """Return (found, tool_call_id) if any tool_end has the offload marker."""
    for ev in events:
        if ev.get("type") == "tool_end":
            result = ev.get("result", "") or ""
            if "[Tool result offloaded" in result:
                tc_id = ev.get("tool_call_id", "")
                return True, tc_id
    return False, ""


def check_workspace_file(
    session_id: str, agent_name: str, tool_call_id: str
) -> tuple[bool, Path | None]:
    """Check if the offloaded file exists on disk."""
    workspace = workspace_dir(session_id) / agent_name / ".tool_results"
    expected = workspace / f"{tool_call_id}.txt"
    if expected.exists():
        return True, expected
    # Me scan dir if tool_call_id partial match
    if workspace.exists():
        matches = list(workspace.glob(f"{tool_call_id[:8]}*.txt"))
        if matches:
            return True, matches[0]
        # Me list all files found
        all_files = list(workspace.glob("*.txt"))
        if all_files:
            return True, all_files[0]
    return False, None


def get_agent_name(base: str) -> str:
    try:
        r = httpx.get(f"{base}/chat/agent", timeout=5)
        r.raise_for_status()
        return r.json().get("name", "assistant")
    except Exception:
        return "assistant"


def run(base: str, wait: int) -> None:
    print("=" * 60)
    print("ToolResultOffloadHook Manual Test")
    print("=" * 60)

    agent_name = get_agent_name(base)
    print(f"Agent: {agent_name}")

    # ── Test 1: trigger offload via web_fetch ─────────────────────────────
    print("\n[1/3] Fetching large file to trigger offload...")
    prompt = (
        f"Use web_fetch to fetch {LARGE_FILE_URL} "
        "and tell me the first function defined in the file."
    )
    sid, events = post_and_wait(base, prompt, None, wait)
    print(f"  Session: {sid}")

    offloaded, tc_id = check_offload_in_events(events)
    if offloaded:
        print(
            f"  [PASS] tool_end contains offload marker (tool_call_id prefix: {tc_id[:16]}...)"
        )
    else:
        print("  [FAIL] No offload marker found in tool_end events")
        print("         Either result was < threshold or hook not registered")
        tool_ends = [e for e in events if e.get("type") == "tool_end"]
        for te in tool_ends:
            result_preview = (te.get("result") or "")[:120]
            print(f"         tool_end result preview: {result_preview!r}")
        return

    # ── Test 2: check file on disk ────────────────────────────────────────
    print("\n[2/3] Checking workspace for offloaded file...")
    found, offload_path = check_workspace_file(sid, agent_name, tc_id)
    if found and offload_path:
        size = offload_path.stat().st_size
        lines = sum(1 for _ in offload_path.open())
        print(f"  [PASS] File exists: {offload_path}")
        print(f"         Size: {size:,} bytes · {lines:,} lines")
        print(f"         First 100 chars: {offload_path.read_text()[:100]!r}")
    else:
        workspace = workspace_dir(sid) / agent_name / ".tool_results"
        print(f"  [FAIL] Offload file not found under: {workspace}")
        print(f"         (workspace exists: {workspace.exists()})")
        if workspace.exists():
            print(f"         Files: {list(workspace.iterdir())}")

    # ── Test 3: agent can read offloaded file (no circular loop) ──────────
    print("\n[3/3] Verifying agent can read_file the offloaded path...")
    rel_path = (
        f"{agent_name}/.tool_results/{offload_path.name}"
        if offload_path
        else f"{agent_name}/.tool_results/{tc_id}.txt"
    )
    prompt2 = f"Use read_file to read '{rel_path}' and tell me the first 3 lines."
    _, events2 = post_and_wait(base, prompt2, sid, wait)

    # Me check no offload in read_file result — that would be the circular loop bug
    read_offloaded, _ = check_offload_in_events(events2)
    read_ends = [
        e
        for e in events2
        if e.get("type") == "tool_end" and e.get("tool_name") == "read_file"
    ]
    done_ok = any(e.get("type") == "done" for e in events2)

    if done_ok and not read_offloaded:
        print(
            "  [PASS] read_file completed without triggering offload (no circular loop)"
        )
    elif read_offloaded:
        print("  [FAIL] read_file result was also offloaded — circular loop bug!")
    elif not done_ok:
        print("  [FAIL] Did not reach done event — agent may be stuck in loop")

    if read_ends:
        preview = (read_ends[0].get("result") or "")[:200]
        print(f"  read_file result preview: {preview!r}")

    # ── Summary ───────────────────────────────────────────────────────────
    print("\n" + "=" * 60)
    t1 = "PASS" if offloaded else "FAIL"
    t2 = "PASS" if (found and offload_path) else "FAIL"
    t3 = "PASS" if (done_ok and not read_offloaded) else "FAIL"
    print(f"[{t1}] Offload fires on large web_fetch result")
    print(f"[{t2}] File written to workspace")
    print(f"[{t3}] read_file can access offloaded file without loop")
    print("=" * 60)


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Test ToolResultOffloadHook")
    p.add_argument("--base", default=BASE, help="Backend URL")
    p.add_argument(
        "--wait", type=int, default=DEFAULT_WAIT, help="Timeout per request (seconds)"
    )
    args = p.parse_args()
    run(args.base, args.wait)
