"""Smoke-test opencode-style bang shell messages.

Prerequisites: server running on http://localhost:8000.

Usage:
  uv run python -m manual.bang_shell
  uv run python -m manual.bang_shell --command 'pwd && echo ok'
  uv run python -m manual.bang_shell --session ID
  uv run python -m manual.bang_shell --base http://localhost:4082/api
"""

from __future__ import annotations

import argparse
import json
import time
import uuid

import httpx


from manual._common import DEFAULT_BASE
BASE = DEFAULT_BASE
DEFAULT_COMMAND = "sleep 0.2; printf 'oad-bang-shell-ok\\n'"
DEFAULT_EXPECT = "oad-bang-shell-ok"


def _post_shell(base: str, command: str, session_id: str | None) -> str:
    message = command if command.startswith("!") else f"!{command}"
    payload: dict[str, str] = {"message": message, "shell": "true"}
    if session_id:
        payload["session_id"] = session_id
    response = httpx.post(f"{base}/team/chat", data=payload, timeout=30)
    response.raise_for_status()
    sid = str(response.json()["session_id"])
    print(f"session: {sid}")
    print(f"command: {command}")
    return sid


def _stream(base: str, session_id: str, wait: int) -> tuple[bool, bool, str]:
    with httpx.stream(
        "GET", f"{base}/team/{session_id}/stream", timeout=wait + 5
    ) as response:
        response.raise_for_status()
        return _parse_stream(response.iter_lines(), wait)


def _parse_stream(line_iter, wait: int) -> tuple[bool, bool, str]:
    start = time.monotonic()
    current_event = "message"
    data_buf: list[str] = []
    saw_shell_start = False
    saw_shell_end = False
    output_parts: list[str] = []

    for line in line_iter:
        if time.monotonic() - start > wait:
            print("timeout while waiting for done")
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
            if current_event == "tool_start" and data.get("name") == "shell":
                saw_shell_start = True
                print("tool_start: shell")
            elif current_event == "tool_output_delta" and data.get("name") == "shell":
                text = str(data.get("text") or "")
                output_parts.append(text)
                print(text, end="")
            elif current_event == "tool_end" and data.get("name") == "shell":
                saw_shell_end = True
                result = str(data.get("result") or "")
                output_parts.append(result)
                print("\ntool_end: shell")
            elif current_event == "done":
                print("done")
                break

    return saw_shell_start, saw_shell_end, "".join(output_parts)


def _history_has_shell(base: str, session_id: str, command: str, expect: str) -> bool:
    response = httpx.get(
        f"{base}/team/{session_id}/history", params={"limit": 1000}, timeout=30
    )
    response.raise_for_status()
    lead_messages = response.json()["lead"]["messages"]
    user_ok = any(
        msg.get("role") == "user"
        and (msg.get("content") or "").strip() == f"!{command.lstrip('!').strip()}"
        for msg in lead_messages
    )
    tool_call_ok = any(
        msg.get("role") == "assistant"
        and any(
            call.get("function", {}).get("name") == "shell"
            for call in msg.get("tool_calls") or []
        )
        for msg in lead_messages
    )
    tool_result_ok = any(
        msg.get("role") == "tool"
        and msg.get("name") == "shell"
        and expect in (msg.get("content") or "")
        for msg in lead_messages
    )
    print(
        "history: "
        f"user={'ok' if user_ok else 'missing'} "
        f"assistant_tool_call={'ok' if tool_call_ok else 'missing'} "
        f"tool_result={'ok' if tool_result_ok else 'missing'}"
    )
    return user_ok and tool_call_ok and tool_result_ok


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Smoke-test !message shell dispatch through /team/chat"
    )
    parser.add_argument("--base", default=DEFAULT_BASE)
    parser.add_argument("--command", default=DEFAULT_COMMAND)
    parser.add_argument("--expect", default=DEFAULT_EXPECT)
    parser.add_argument("--session", default=None)
    parser.add_argument("--wait", type=int, default=30)
    args = parser.parse_args()

    base = args.base.rstrip("/")
    command = args.command.lstrip("!").strip()
    expected = args.expect

    session_id = args.session or str(uuid.uuid7())
    session_id = _post_shell(base, command, session_id)
    saw_start, saw_end, output = _stream(base, session_id, args.wait)
    output_ok = expected in output
    history_ok = _history_has_shell(base, session_id, command, expected)

    print(
        "checks: "
        f"tool_start={'ok' if saw_start else 'missing'} "
        f"tool_end={'ok' if saw_end else 'missing'} "
        f"output={'ok' if output_ok else 'missing'} "
        f"history={'ok' if history_ok else 'missing'}"
    )
    raise SystemExit(0 if saw_start and saw_end and output_ok and history_ok else 1)


if __name__ == "__main__":
    main()
