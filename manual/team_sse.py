"""Capture and pretty-print every SSE event from a team turn.

Subscribes to /api/team/{session_id}/stream, parses each event, and prints a
structured trace with timing, per-agent attribution, and truncated payloads.

Useful for:
  - Debugging event ordering across lead/member activations
  - Verifying lifecycle states: idle, working, offline, error
  - Verifying frontend handles every event type the backend emits
  - Spotting unhandled/unknown event types (default branch)

Usage:
  uv run python -m manual.team_sse "research python 3.14 release notes"
  uv run python -m manual.team_sse "msg" --session ID            # existing session
  uv run python -m manual.team_sse "msg" --out .openagentd/state/sse.jsonl  # save raw events
  uv run python -m manual.team_sse "msg" --wait 60
  uv run python -m manual.team_sse "msg" --no-summary             # skip counts table
"""

from __future__ import annotations

import argparse
import json
import time
from collections import Counter
from pathlib import Path

import httpx

from manual._common import DEFAULT_BASE, require_dev_server

BASE = DEFAULT_BASE
DEFAULT_WAIT = 180

# ── Colors ──────────────────────────────────────────────────────────────────
RESET = "\033[0m"
DIM = "\033[2m"
BOLD = "\033[1m"
RED = "\033[31m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
BLUE = "\033[34m"
MAGENTA = "\033[35m"
CYAN = "\033[36m"

EVENT_COLORS: dict[str, str] = {
    "agent_status": MAGENTA,
    "inbox": CYAN,
    "message": "",
    "thinking": DIM,
    "tool_call": BLUE,
    "tool_start": BLUE,
    "tool_output_delta": BLUE,
    "tool_end": BLUE,
    "usage": DIM,
    "rate_limit": YELLOW,
    "error": RED,
    "done": GREEN,
    "title_update": YELLOW,
    "session": DIM,
    "permission_asked": YELLOW,
    "permission_replied": GREEN,
}


def _truncate(s: str, n: int = 100) -> str:
    s = s.replace("\n", " ")
    return s if len(s) <= n else s[: n - 1] + "…"


def _fmt_event(evt: str, data: dict) -> str:
    """Return a one-line summary of an event."""
    agent = data.get("agent") or data.get("metadata", {}).get("agent") or "-"
    color = EVENT_COLORS.get(evt, "")

    if evt == "agent_status":
        status = data.get("status", "?")
        meta = data.get("metadata") or {}
        extra = f" msg={meta.get('message')!r}" if meta.get("message") else ""
        body = f"{agent} → {status}{extra}"
    elif evt == "inbox":
        frm = data.get("from_agent", "?")
        body = f"{agent} ← {frm}: {_truncate(data.get('content', ''), 80)}"
    elif evt == "message":
        body = f"{agent}: {_truncate(data.get('text', ''), 90)}"
    elif evt == "thinking":
        body = f"{agent} thinks: {_truncate(data.get('text', ''), 80)}"
    elif evt == "tool_call":
        body = f"{agent} → {data.get('name', '?')}() [id={data.get('tool_call_id', '?')[:8]}]"
    elif evt == "tool_start":
        args = data.get("arguments") or ""
        body = f"{agent} ▶ {data.get('name', '?')}({_truncate(args, 70)})"
    elif evt == "tool_output_delta":
        text = data.get("text") or ""
        body = f"{agent} ▷ {data.get('name', '?')} output {_truncate(str(text), 70)}"
    elif evt == "tool_end":
        result = data.get("result") or ""
        body = f"{agent} ◀ {data.get('name', '?')} → {_truncate(str(result), 70)}"
    elif evt == "usage":
        meta = data.get("metadata") or {}
        turn_total = "TURN_TOTAL " if meta.get("turn_total") else ""
        body = (
            f"{agent} {turn_total}in={data.get('prompt_tokens', 0)} "
            f"out={data.get('completion_tokens', 0)} "
            f"total={data.get('total_tokens', 0)}"
        )
    elif evt == "rate_limit":
        body = (
            f"retry_after={data.get('retry_after')}s "
            f"attempt={data.get('attempt')}/{data.get('max_attempts')}"
        )
    elif evt == "error":
        body = f"{RED}{_truncate(data.get('message', ''), 120)}{RESET}"
    elif evt == "done":
        body = "turn complete"
    elif evt == "title_update":
        body = f"title = {data.get('title', '?')!r}"
    elif evt == "session":
        body = f"session_id = {data.get('session_id', '?')}"
    else:
        body = _truncate(json.dumps(data, ensure_ascii=False), 100)

    return f"{color}{evt:13s}{RESET} {body}"


def post_message(base: str, message: str, session_id: str | None) -> str:
    payload: dict = {"message": message}
    if session_id:
        payload["session_id"] = session_id
    r = httpx.post(f"{base}/team/chat", data=payload)
    r.raise_for_status()
    sid = r.json()["session_id"]
    print(f"{BOLD}session{RESET}: {sid}")
    return sid


def stream_events(
    base: str,
    sid: str,
    timeout: int,
    out_path: Path | None,
) -> tuple[Counter, Counter]:
    """Subscribe and print events. Returns (event_counter, per_agent_counter)."""
    event_counts: Counter = Counter()
    per_agent: Counter = Counter()
    unknown_types: set[str] = set()
    known = set(EVENT_COLORS)

    out_fh = out_path.open("w", encoding="utf-8") if out_path else None
    start = time.monotonic()

    print(f"{DIM}{'time':>7s}  event         details{RESET}")
    print(f"{DIM}{'-' * 7}  {'-' * 13} {'-' * 60}{RESET}")

    try:
        with httpx.stream(
            "GET", f"{base}/team/{sid}/stream", timeout=timeout + 5
        ) as resp:
            resp.raise_for_status()
            current_event = "message"
            data_buf: list[str] = []

            for line in resp.iter_lines():
                if time.monotonic() - start > timeout:
                    print(f"{RED}[timeout]{RESET}")
                    break

                # SSE frame: `event: X\ndata: Y\n\n`
                if line.startswith("event:"):
                    current_event = line[6:].strip()
                elif line.startswith("data:"):
                    data_buf.append(line[5:].strip())
                elif line == "":
                    # End of frame
                    if not data_buf:
                        continue
                    raw = "\n".join(data_buf)
                    data_buf = []
                    try:
                        data = json.loads(raw)
                    except json.JSONDecodeError:
                        data = {"_raw": raw}

                    event_counts[current_event] += 1
                    agent = data.get("agent") or data.get("metadata", {}).get("agent")
                    if agent:
                        per_agent[f"{agent}/{current_event}"] += 1
                    if current_event not in known:
                        unknown_types.add(current_event)

                    elapsed = time.monotonic() - start
                    print(f"{elapsed:>6.2f}s  {_fmt_event(current_event, data)}")

                    if out_fh:
                        out_fh.write(
                            json.dumps(
                                {
                                    "t": round(elapsed, 3),
                                    "event": current_event,
                                    "data": data,
                                },
                                ensure_ascii=False,
                            )
                            + "\n"
                        )

                    if current_event == "done":
                        break
    except httpx.ReadTimeout:
        print(f"{RED}[read timeout]{RESET}")
    finally:
        if out_fh:
            out_fh.close()

    if unknown_types:
        print(
            f"\n{YELLOW}unknown event types (not in EVENT_COLORS):{RESET} "
            f"{sorted(unknown_types)}"
        )
    return event_counts, per_agent


def print_summary(event_counts: Counter, per_agent: Counter) -> None:
    print(f"\n{BOLD}Event counts{RESET}")
    for evt, n in event_counts.most_common():
        color = EVENT_COLORS.get(evt, "")
        print(f"  {color}{evt:13s}{RESET} {n}")
    print(f"  {'-' * 13} {sum(event_counts.values())} total")

    if per_agent:
        print(f"\n{BOLD}Per-agent events{RESET}")
        for key, n in sorted(per_agent.items()):
            print(f"  {key:40s} {n}")


def main() -> None:
    p = argparse.ArgumentParser(description="Capture and print team SSE events")
    p.add_argument("message", help="Message to send to the team")
    p.add_argument("--session", default=None, help="Resume existing session id")
    p.add_argument("--wait", type=int, default=DEFAULT_WAIT, help="Max stream wait (s)")
    p.add_argument("--base", default=BASE)
    p.add_argument("--out", type=Path, help="Append raw events as JSONL to this file")
    p.add_argument("--no-summary", action="store_true", help="Skip counts table")
    args = p.parse_args()

    base = args.base.rstrip("/")
    require_dev_server(base)
    sid = post_message(base, args.message, args.session)
    event_counts, per_agent = stream_events(base, sid, args.wait, args.out)
    if not args.no_summary:
        print_summary(event_counts, per_agent)
    print(f"\n{DIM}session: {sid}{RESET}")


if __name__ == "__main__":
    main()
