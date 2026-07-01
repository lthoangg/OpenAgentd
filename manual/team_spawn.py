"""Drive a team turn that exercises team_manage spawn/dismiss and stream
per-agent content live.

Flow:
  1. Snapshot ``GET /team/agents`` — list lead + blueprints + live instances.
  2. POST a message that nudges the lead to spawn several members and ask
     each to produce streamed content.
  3. Subscribe to ``GET /team/{sid}/stream`` — print events bucketed per
     agent, with rolling content per ``message`` event.
  4. Re-snapshot ``/team/agents`` to show the resulting live-instance set.
  5. Print a per-agent summary: spawn / dismiss timeline + lifecycle status
     transitions + streamed character counts + token usage.

Usage:
  uv run python -m manual.team_spawn
  uv run python -m manual.team_spawn --session ID
  uv run python -m manual.team_spawn --message "your prompt"
  uv run python -m manual.team_spawn --wait 240 --out .openagentd/spawn.jsonl
  uv run python -m manual.team_spawn --no-color
"""

from __future__ import annotations

import argparse
import json
import time
from collections import Counter, defaultdict
from pathlib import Path

import httpx

from manual._common import DEFAULT_BASE
BASE = DEFAULT_BASE
DEFAULT_WAIT = 240

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

# Stable hash → color for unknown agents so multi-instance handles like
# ``executor#1`` and ``executor#2`` get distinct colors.
_PALETTE = [CYAN, MAGENTA, BLUE, GREEN, YELLOW, RED]

_USE_COLOR = True


def _c(color: str) -> str:
    return color if _USE_COLOR else ""


def _agent_color(name: str) -> str:
    if not _USE_COLOR:
        return ""
    if name == "-":
        return DIM
    return _PALETTE[hash(name) % len(_PALETTE)]


def _truncate(s: str, n: int = 90) -> str:
    s = s.replace("\n", " ")
    return s if len(s) <= n else s[: n - 1] + "…"


# ── Default prompt — designed to force multiple spawns ──────────────────────

DEFAULT_PROMPT = (
    "You are coordinating a smoke test of team_manage roster operations. "
    "Do all of the following, in order, in a single turn:\n"
    "1. Call team_manage(action='spawn', members=[...]) once with each "
    "available blueprint exactly once.\n"
    "2. If 'executor' is a blueprint, include 'executor' a second time in "
    "that same members list so two executor instances run in parallel.\n"
    "3. Send each spawned instance a short, distinct task via team_message "
    "(e.g. count to three, list three colors, name three cities). Make sure "
    "each member must reply with at least one full sentence so we get "
    "streamed content from every agent.\n"
    "4. Wait for everyone to reply.\n"
    "5. Call team_manage(action='dismiss', members=[...]) once with every "
    "explicit handle you spawned.\n"
    "6. Reply to the user with a one-line summary of who you spawned and "
    "what they reported.\n"
    "Do not skip any step."
)


# ── HTTP helpers ────────────────────────────────────────────────────────────


def fetch_agents(base: str) -> dict:
    r = httpx.get(f"{base}/team/agents", timeout=10)
    r.raise_for_status()
    return r.json()


def post_message(base: str, message: str, session_id: str | None) -> str:
    payload: dict = {"message": message}
    if session_id:
        payload["session_id"] = session_id
    r = httpx.post(f"{base}/team/chat", data=payload, timeout=10)
    r.raise_for_status()
    return r.json()["session_id"]


def fetch_history(base: str, sid: str) -> dict:
    r = httpx.get(f"{base}/team/{sid}/history", params={"limit": 1000}, timeout=20)
    r.raise_for_status()
    return r.json()


# ── Display ─────────────────────────────────────────────────────────────────


def print_agents_snapshot(snapshot: dict, *, label: str) -> None:
    print(f"\n{_c(BOLD)}── /team/agents — {label} ──{_c(RESET)}")
    for a in snapshot.get("agents", []):
        role = "lead" if a.get("is_lead") else "member"
        print(
            f"  {_c(_agent_color(a['name']))}{a['name']:24s}{_c(RESET)} "
            f"{_c(DIM)}[{role}] model={a.get('model') or a.get('model_id') or '?'}{_c(RESET)}"
        )
    bps = snapshot.get("blueprints") or []
    if bps:
        print(f"  {_c(DIM)}blueprints:{_c(RESET)}")
        for bp in bps:
            live = bp.get("live_instances") or []
            live_str = (
                f"{_c(GREEN)}live={live}{_c(RESET)}"
                if live
                else f"{_c(DIM)}live=[]{_c(RESET)}"
            )
            print(
                f"    - {_c(BOLD)}{bp['name']:14s}{_c(RESET)} "
                f"{_c(DIM)}{_truncate(bp.get('description') or '', 60)}{_c(RESET)} "
                f"{live_str}"
            )
    else:
        print(f"  {_c(DIM)}(no blueprints registered){_c(RESET)}")


def _fmt_event_line(t: float, evt: str, data: dict) -> str:
    agent = data.get("agent") or data.get("metadata", {}).get("agent") or "-"
    agent_str = f"{_c(_agent_color(agent))}{agent:18s}{_c(RESET)}"

    if evt == "agent_status":
        status = data.get("status", "?")
        body = f"→ {status}"
    elif evt == "inbox":
        frm = data.get("from_agent", "?")
        body = f"← {frm}: {_truncate(data.get('content', ''), 70)}"
    elif evt == "message":
        body = f"{_truncate(data.get('text', ''), 90)}"
    elif evt == "thinking":
        body = f"{_c(DIM)}thinks: {_truncate(data.get('text', ''), 70)}{_c(RESET)}"
    elif evt == "tool_start":
        name = data.get("name", "?")
        args = _truncate(data.get("arguments") or "", 70)
        body = f"{_c(BLUE)}▶ {name}({args}){_c(RESET)}"
    elif evt == "tool_end":
        name = data.get("name", "?")
        result = _truncate(str(data.get("result") or ""), 60)
        body = f"{_c(BLUE)}◀ {name} → {result}{_c(RESET)}"
    elif evt == "tool_call":
        body = f"{_c(BLUE)}call {data.get('name', '?')}{_c(RESET)}"
    elif evt == "usage":
        body = (
            f"{_c(DIM)}usage in={data.get('prompt_tokens', 0)} "
            f"out={data.get('completion_tokens', 0)} "
            f"total={data.get('total_tokens', 0)}{_c(RESET)}"
        )
    elif evt == "error":
        body = f"{_c(RED)}{_truncate(data.get('message', ''), 100)}{_c(RESET)}"
    elif evt == "done":
        body = f"{_c(GREEN)}turn complete{_c(RESET)}"
    elif evt == "session":
        body = f"{_c(DIM)}session_id={data.get('session_id', '?')}{_c(RESET)}"
    else:
        body = _truncate(json.dumps(data, ensure_ascii=False), 90)

    return f"{t:>6.2f}s  {evt:13s} {agent_str} {body}"


def stream_and_track(
    base: str, sid: str, timeout: int, out_path: Path | None
) -> dict:
    """Stream events and return a structured trace.

    Returns:
        {
            "events": Counter,
            "per_agent_events": dict[str, Counter],
            "agent_text": dict[str, str],
            "spawned": list[(t, handle)],
            "dismissed": list[(t, handle)],
            "statuses": list[(t, agent, status)],
            "usage": dict[str, dict],  # agent → {prompt, completion, total}
            "errors": list[str],
        }
    """
    events: Counter = Counter()
    per_agent_events: dict[str, Counter] = defaultdict(Counter)
    agent_text: dict[str, list[str]] = defaultdict(list)
    spawned: list[tuple[float, str]] = []
    dismissed: list[tuple[float, str]] = []
    statuses: list[tuple[float, str, str]] = []
    usage: dict[str, dict] = {}
    errors: list[str] = []

    out_fh = out_path.open("w", encoding="utf-8") if out_path else None
    start = time.monotonic()

    print(f"\n{_c(BOLD)}── live stream ──{_c(RESET)}")
    print(f"{_c(DIM)}{'time':>7s}  {'event':13s} {'agent':18s} body{_c(RESET)}")

    try:
        with httpx.stream(
            "GET", f"{base}/team/{sid}/stream", timeout=timeout + 5
        ) as resp:
            resp.raise_for_status()
            current_event = "message"
            data_buf: list[str] = []

            for line in resp.iter_lines():
                if time.monotonic() - start > timeout:
                    print(f"{_c(RED)}[timeout]{_c(RESET)}")
                    break

                if line.startswith("event:"):
                    current_event = line[6:].strip()
                    continue
                if line.startswith("data:"):
                    data_buf.append(line[5:].strip())
                    continue
                if line != "":
                    continue

                # End of SSE frame.
                if not data_buf:
                    continue
                raw = "\n".join(data_buf)
                data_buf = []
                try:
                    data = json.loads(raw)
                except json.JSONDecodeError:
                    data = {"_raw": raw}

                elapsed = time.monotonic() - start
                events[current_event] += 1

                agent = (
                    data.get("agent")
                    or data.get("metadata", {}).get("agent")
                    or "-"
                )
                per_agent_events[agent][current_event] += 1

                # Track streamed content per agent.
                if current_event == "message":
                    text = data.get("text") or ""
                    if text:
                        agent_text[agent].append(text)

                if current_event == "agent_status":
                    statuses.append((elapsed, agent, data.get("status", "?")))

                # Track spawn / dismiss roster operations.
                if current_event == "tool_start":
                    name = data.get("name", "")
                    args = data.get("arguments") or ""
                    if name == "team_manage":
                        if '"action":"spawn"' in args or '"action": "spawn"' in args:
                            spawned.append((elapsed, args))
                        elif '"action":"dismiss"' in args or '"action": "dismiss"' in args:
                            dismissed.append((elapsed, args))

                # Track usage per agent (turn_total only).
                if current_event == "usage":
                    meta = data.get("metadata") or {}
                    if meta.get("turn_total"):
                        usage[agent] = {
                            "prompt": data.get("prompt_tokens", 0),
                            "completion": data.get("completion_tokens", 0),
                            "total": data.get("total_tokens", 0),
                        }

                if current_event == "error":
                    errors.append(data.get("message") or raw)

                print(_fmt_event_line(elapsed, current_event, data))

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
        print(f"{_c(RED)}[read timeout]{_c(RESET)}")
    finally:
        if out_fh:
            out_fh.close()

    return {
        "events": events,
        "per_agent_events": dict(per_agent_events),
        "agent_text": {k: "".join(v) for k, v in agent_text.items()},
        "spawned": spawned,
        "dismissed": dismissed,
        "statuses": statuses,
        "usage": usage,
        "errors": errors,
    }


def print_streamed_content(agent_text: dict[str, str]) -> None:
    print(f"\n{_c(BOLD)}── streamed content per agent ──{_c(RESET)}")
    if not agent_text:
        print(f"  {_c(DIM)}(no message events captured){_c(RESET)}")
        return
    for name in sorted(agent_text):
        text = agent_text[name].strip()
        if not text:
            continue
        color = _agent_color(name)
        print(f"\n  {_c(color)}{_c(BOLD)}{name}{_c(RESET)} "
              f"{_c(DIM)}({len(agent_text[name])} chars streamed){_c(RESET)}")
        for ln in text.splitlines() or [""]:
            print(f"    {_c(color)}│{_c(RESET)} {ln}")


def print_spawn_timeline(trace: dict) -> None:
    print(f"\n{_c(BOLD)}── spawn / dismiss timeline ──{_c(RESET)}")
    timeline = [("spawn", t, args) for t, args in trace["spawned"]]
    timeline += [("dismiss", t, args) for t, args in trace["dismissed"]]
    timeline.sort(key=lambda x: x[1])
    if not timeline:
        print(f"  {_c(DIM)}(no team_manage spawn/dismiss tool calls){_c(RESET)}")
        return
    for kind, t, args in timeline:
        color = _c(GREEN) if kind == "spawn" else _c(YELLOW)
        print(f"  {t:>6.2f}s  {color}{kind:8s}{_c(RESET)} {_truncate(args, 100)}")


def print_status_timeline(trace: dict) -> None:
    print(f"\n{_c(BOLD)}── lifecycle status timeline ──{_c(RESET)}")
    statuses = trace["statuses"]
    if not statuses:
        print(f"  {_c(DIM)}(no agent_status events captured){_c(RESET)}")
        return

    for t, agent, status in statuses:
        color = {
            "working": YELLOW,
            "idle": GREEN,
            "offline": DIM,
            "error": RED,
        }.get(status, "")
        print(
            f"  {t:>6.2f}s  {_c(_agent_color(agent))}{agent:24s}{_c(RESET)} "
            f"{_c(color)}{status}{_c(RESET)}"
        )


def print_summary(trace: dict, history: dict | None) -> None:
    print(f"\n{_c(BOLD)}── per-agent summary ──{_c(RESET)}")
    all_agents = set(trace["per_agent_events"]) | set(trace["agent_text"])

    # Augment with history rows so dismissed agents (no longer in live roster
    # but still in DB history) still show up.
    if history:
        all_agents.add(history.get("lead", {}).get("agent_name", "-"))
        for mb in history.get("members", []):
            all_agents.add(mb.get("name"))
    all_agents.discard(None)
    all_agents.discard("-")

    for name in sorted(all_agents):
        ev_counts = trace["per_agent_events"].get(name, Counter())
        text = trace["agent_text"].get(name, "")
        u = trace["usage"].get(name, {})
        hist_count = ""
        if history:
            if history.get("lead", {}).get("agent_name") == name:
                hist_count = f"hist={len(history['lead']['messages'])}"
            else:
                for mb in history.get("members", []):
                    if mb.get("name") == name:
                        hist_count = f"hist={len(mb['messages'])}"
                        break
        events_str = " ".join(
            f"{k}={v}" for k, v in sorted(ev_counts.items()) if v
        )
        usage_str = (
            f"tokens={u['total']}" if u else ""
        )
        chars_str = f"chars={len(text)}" if text else ""
        bits = " ".join(s for s in [hist_count, chars_str, usage_str] if s)
        color = _c(_agent_color(name))
        print(
            f"  {color}{_c(BOLD)}{name:24s}{_c(RESET)} "
            f"{_c(DIM)}{events_str}{_c(RESET)} {bits}"
        )

    print(f"\n  {_c(DIM)}total events: "
          f"{sum(trace['events'].values())} ({dict(trace['events'])}){_c(RESET)}")
    if trace["errors"]:
        print(f"\n  {_c(RED)}{_c(BOLD)}errors:{_c(RESET)}")
        for e in trace["errors"]:
            print(f"    {_c(RED)}{e}{_c(RESET)}")


# ── Entrypoint ──────────────────────────────────────────────────────────────


def main() -> None:
    global _USE_COLOR

    p = argparse.ArgumentParser(
        description="Smoke-test team_manage spawn/dismiss and stream content"
    )
    p.add_argument("--message", default=DEFAULT_PROMPT, help="Prompt to send")
    p.add_argument("--session", default=None, help="Resume existing session id")
    p.add_argument("--wait", type=int, default=DEFAULT_WAIT, help="Max stream wait (s)")
    p.add_argument("--base", default=BASE)
    p.add_argument("--out", type=Path, help="Append raw events as JSONL to this file")
    p.add_argument("--no-color", action="store_true", help="Disable ANSI colors")
    p.add_argument(
        "--no-history",
        action="store_true",
        help="Skip the final GET /team/{sid}/history call",
    )
    args = p.parse_args()

    if args.no_color:
        _USE_COLOR = False

    base = args.base.rstrip("/")

    try:
        before = fetch_agents(base)
    except httpx.HTTPError as exc:
        print(f"{_c(RED)}cannot reach {base}/team/agents: {exc}{_c(RESET)}")
        return
    print_agents_snapshot(before, label="before")

    sid = post_message(base, args.message, args.session)
    print(f"\n{_c(BOLD)}session{_c(RESET)}: {sid}")
    print(f"{_c(DIM)}prompt:{_c(RESET)} {_truncate(args.message, 200)}")

    trace = stream_and_track(base, sid, args.wait, args.out)

    try:
        after = fetch_agents(base)
        print_agents_snapshot(after, label="after")
    except httpx.HTTPError as exc:
        print(f"{_c(RED)}post-run /team/agents failed: {exc}{_c(RESET)}")

    print_spawn_timeline(trace)
    print_status_timeline(trace)
    print_streamed_content(trace["agent_text"])

    history = None
    if not args.no_history:
        try:
            history = fetch_history(base, sid)
        except httpx.HTTPError as exc:
            print(f"{_c(RED)}history fetch failed: {exc}{_c(RESET)}")

    print_summary(trace, history)
    print(f"\n{_c(DIM)}session: {sid}{_c(RESET)}")


if __name__ == "__main__":
    main()
