"""Smoke-test coding-mode /loop controls.

Flow:
  1. Create a temporary coding workspace.
  2. Configure loop budget with ``/loop:set``.
  3. Start a loop with ``/loop \"prompt\"``.
  4. Wait until the exact prompt appears at least twice in lead history, proving
     backend reinjection happened after a completed team turn.
  5. Send ``/loop:stop`` and wait until the team is idle.

Usage:
  uv run python -m manual.loop_smoketest
  uv run python -m manual.loop_smoketest --workspace /path/to/repo --budget 5
"""

from __future__ import annotations

import argparse
import tempfile
import time
from pathlib import Path

import httpx

BASE = "http://localhost:8000/api"
DEFAULT_PROMPT = "Reply exactly LOOP-SMOKE-OK. Do not use tools."


def post_coding_message(
    base: str,
    message: str,
    *,
    workspace: Path,
    session_id: str | None = None,
) -> dict:
    data: dict[str, str] = {
        "message": message,
        "mode": "coding",
        "workspace": str(workspace),
    }
    if session_id:
        data["session_id"] = session_id
    response = httpx.post(f"{base}/team/chat", data=data, timeout=30)
    response.raise_for_status()
    return response.json()


def get_history(base: str, session_id: str) -> list[dict]:
    response = httpx.get(
        f"{base}/team/{session_id}/history",
        params={"limit": 1000},
        timeout=30,
    )
    response.raise_for_status()
    return response.json()["lead"]["messages"]


def count_prompt_messages(base: str, session_id: str, prompt: str) -> int:
    return sum(
        1
        for msg in get_history(base, session_id)
        if msg.get("role") == "user" and msg.get("content") == prompt
    )


def wait_for_prompt_count(
    base: str,
    session_id: str,
    *,
    prompt: str,
    minimum: int,
    timeout: int,
) -> int:
    deadline = time.monotonic() + timeout
    last_count = 0
    while time.monotonic() < deadline:
        last_count = count_prompt_messages(base, session_id, prompt)
        print(f"prompt_count={last_count}/{minimum}")
        if last_count >= minimum:
            return last_count
        time.sleep(2)
    raise SystemExit(
        f"Timed out waiting for {minimum} loop prompt messages; observed {last_count}."
    )


def wait_until_idle(base: str, session_id: str, timeout: int) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        response = httpx.get(f"{base}/team/sessions/{session_id}", timeout=30)
        response.raise_for_status()
        data = response.json()
        if not data.get("running", False):
            return
        time.sleep(2)
    raise SystemExit("Timed out waiting for team to become idle after /loop:stop.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Smoke-test coding-mode /loop")
    parser.add_argument("--base", default=BASE)
    parser.add_argument("--workspace", type=Path, default=None)
    parser.add_argument("--budget", type=int, choices=(5, 10, 20, 50), default=5)
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    parser.add_argument("--wait", type=int, default=180)
    args = parser.parse_args()

    base = args.base.rstrip("/")
    temp_ctx = None
    workspace = args.workspace
    if workspace is None:
        temp_ctx = tempfile.TemporaryDirectory(prefix="openagentd-loop-smoke-")
        workspace = Path(temp_ctx.name)
        (workspace / "README.md").write_text("# loop smoke\n", encoding="utf-8")
    workspace = workspace.expanduser().resolve()

    try:
        print(f"workspace={workspace}")
        configured = post_coding_message(
            base,
            f"/loop:set {args.budget}",
            workspace=workspace,
        )
        session_id = configured["session_id"]
        print(f"session={session_id}")

        wait_until_idle(base, session_id, 30)

        started = post_coding_message(
            base,
            f'/loop "{args.prompt}"',
            workspace=workspace,
            session_id=session_id,
        )
        print(f"start_status={started['status']}")

        observed = wait_for_prompt_count(
            base,
            session_id,
            prompt=args.prompt,
            minimum=2,
            timeout=args.wait,
        )
        print(f"observed loop reinjection: {observed} prompt messages")

        stopped = post_coding_message(
            base,
            "/loop:stop",
            workspace=workspace,
            session_id=session_id,
        )
        print(f"stop_status={stopped['status']}")
        wait_until_idle(base, session_id, args.wait)
        final_count = count_prompt_messages(base, session_id, args.prompt)
        print(f"final_prompt_count={final_count}")
        print("loop smoke: ok")
    finally:
        if temp_ctx is not None:
            temp_ctx.cleanup()


if __name__ == "__main__":
    main()
