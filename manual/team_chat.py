"""Send a chat message, poll stream until done, print history.

Usage:
  uv run python -m manual.team_chat "your message here"
  uv run python -m manual.team_chat "msg" --session ID   # resume session
  uv run python -m manual.team_chat "msg" --wait 120     # custom timeout
"""

import argparse
import time

import httpx

from manual._common import DEFAULT_BASE

BASE = DEFAULT_BASE
DEFAULT_WAIT = 180  # seconds


def post_message(
    base: str,
    message: str,
    session_id: str | None,
    model: str | None = None,
    thinking_level: str | None = None,
) -> str:
    payload: dict = {"message": message, "workspace": "."}
    if session_id:
        payload["session_id"] = session_id
    if model:
        payload["model"] = model
    if thinking_level:
        payload["thinking_level"] = thinking_level
    r = httpx.post(f"{base}/agent/chat", data=payload)
    r.raise_for_status()
    data = r.json()
    sid = data["session_id"]
    print(f"session: {sid}")
    return sid


def wait_for_done(base: str, sid: str, timeout: int) -> bool:
    """Poll the SSE stream until 'done' event or timeout."""
    print(f"waiting (max {timeout}s)...", end="", flush=True)
    start = time.monotonic()
    try:
        with httpx.stream(
            "GET", f"{base}/agent/{sid}/stream", timeout=timeout + 5
        ) as resp:
            for line in resp.iter_lines():
                if time.monotonic() - start > timeout:
                    print(" timeout")
                    return False
                if line.startswith("event:") and "done" in line:
                    elapsed = time.monotonic() - start
                    print(f" done ({elapsed:.1f}s)")
                    return True
    except httpx.ReadTimeout:
        print(" timeout")
        return False
    elapsed = time.monotonic() - start
    print(f" stream closed ({elapsed:.1f}s)")
    return True


def print_history(base: str, sid: str):
    r = httpx.get(f"{base}/agent/{sid}/history", params={"limit": 1000})
    r.raise_for_status()
    data = r.json()

    lead = data["lead"]
    lead_name = lead.get("agent_name") or lead.get("name") or "openagentd"
    _print_agent(lead_name, lead["messages"])

    total = len(lead["messages"])
    print(f"\ntotal: {total} msgs")


def _print_agent(name: str, messages: list):
    print(f"\n{'=' * 60}")
    print(f"  {name}: {len(messages)} msgs")
    print("=" * 60)
    for m in messages:
        role = m["role"]
        content = (m.get("content") or "")[:140]
        tc = m.get("tool_calls")

        if tc:
            for t in tc:
                fn = t["function"]["name"]
                args = t["function"]["arguments"][:100]
                print(f"  [{role}] CALL {fn}({args})")
        else:
            print(f"  [{role}] {content}")


def main():
    p = argparse.ArgumentParser(description="Single-agent chat smoke test")
    p.add_argument("message", help="Message to send")
    p.add_argument("--session", default=None, help="Resume existing session")
    p.add_argument(
        "--model", default=None, help="Model override (e.g. opencode:hy3-free)"
    )
    p.add_argument(
        "--thinking-level", default=None, help="Reasoning effort / thinking level"
    )
    p.add_argument("--wait", type=int, default=DEFAULT_WAIT, help="Max wait seconds")
    p.add_argument("--base", default=BASE)
    args = p.parse_args()
    base = args.base.rstrip("/")

    sid = post_message(
        base,
        args.message,
        args.session,
        model=args.model,
        thinking_level=args.thinking_level,
    )
    wait_for_done(base, sid, args.wait)
    print_history(base, sid)


if __name__ == "__main__":
    main()
