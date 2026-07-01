"""Manual smoke test for the agent-facing patch tool.

Usage:
  uv run python -m manual.patch_tool
  uv run python -m manual.patch_tool --base http://localhost:8000/api
"""

from __future__ import annotations

import argparse
import time
import uuid

import httpx

from manual._common import DEFAULT_BASE
BASE = DEFAULT_BASE
DEFAULT_WAIT = 180


def _post_turn(base: str, message: str) -> str:
    response = httpx.post(f"{base}/team/chat", data={"message": message}, timeout=30)
    response.raise_for_status()
    return str(response.json()["session_id"])


def _wait_for_done(base: str, session_id: str, wait: int) -> None:
    deadline = time.monotonic() + wait
    with httpx.stream(
        "GET", f"{base}/team/{session_id}/stream", timeout=wait + 5
    ) as response:
        response.raise_for_status()
        for line in response.iter_lines():
            if time.monotonic() > deadline:
                raise TimeoutError(f"Timed out waiting for session {session_id}")
            if line.startswith("event:") and line[6:].strip() == "done":
                return


def _history(base: str, session_id: str) -> dict:
    response = httpx.get(f"{base}/team/{session_id}/history", params={"limit": 1000})
    response.raise_for_status()
    return response.json()


def _saw_patch_call(history: dict) -> bool:
    agents = [history["lead"], *history.get("members", [])]
    for agent in agents:
        for message in agent.get("messages", []):
            for tool_call in message.get("tool_calls") or []:
                if tool_call.get("function", {}).get("name") == "patch":
                    return True
    return False


def main() -> None:
    parser = argparse.ArgumentParser(description="Agent-facing patch tool smoke test")
    parser.add_argument("--base", default=BASE)
    parser.add_argument("--wait", type=int, default=DEFAULT_WAIT)
    args = parser.parse_args()
    base = args.base.rstrip("/")

    filename = f"manual_patch_smoke_{uuid.uuid4().hex[:8]}.txt"
    message = (
        "Use the patch tool exactly once to create a file named "
        f"{filename} with exactly this content: patch smoke ok. "
        "Do not use write or edit. After the patch tool succeeds, reply with only: PATCH_SMOKE_DONE"
    )
    session_id = _post_turn(base, message)
    print(f"session: {session_id}")
    _wait_for_done(base, session_id, args.wait)
    history = _history(base, session_id)
    if not _saw_patch_call(history):
        print("[FAIL] no patch tool call found in session history")
        raise SystemExit(1)
    print(f"[PASS] agent used patch tool for {filename}")


if __name__ == "__main__":
    main()
