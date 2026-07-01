"""Smoke-test team roster isolation and stop (interrupt) behavior.

Flow:
  1. Start a fresh team session with a prompt that should not spawn members.
     Verify ``/team/agents`` shows only the lead for that new session.
  2. If a blueprint exists, start another fresh session that asks the lead to
     spawn one member and give it a long task.
  3. As soon as a non-lead member reports ``agent_status=working``, POST an
     interrupt-only request and verify that the member returns to ``idle``
     (NOT ``offline``). Since commit ``6ad0205 "fix: keep stopped members
     live"`` interrupt no longer dismisses live members — only explicit
     ``team_manage(action="dismiss")`` removes a member from the live
     roster and emits ``offline``. The member must remain in
     ``/team/agents`` so it is available for follow-up work.
  4. Verify the lead inbox received a ``Stopped before completing assigned
     work`` notice attributed to the interrupted member.
  5. Verify any claimed in-progress todo for that member was released back
     to ``pending`` and unassigned.

Usage:
  uv run python -m manual.team_roster_lifecycle
  uv run python -m manual.team_roster_lifecycle --wait 120
  uv run python -m manual.team_roster_lifecycle --base http://localhost:8000/api
"""

from __future__ import annotations

import argparse
import json
import time
from dataclasses import dataclass
from typing import Any

import httpx

from manual._common import DEFAULT_BASE
BASE = DEFAULT_BASE
DEFAULT_WAIT = 90


@dataclass
class Event:
    name: str
    data: dict[str, Any]


def fetch_agents(client: httpx.Client, base: str) -> dict[str, Any]:
    res = client.get(f"{base}/team/agents")
    res.raise_for_status()
    return res.json()


def live_member_names(snapshot: dict[str, Any]) -> list[str]:
    agents = snapshot.get("agents") or []
    return [a["name"] for a in agents if not a.get("is_lead")]


def lead_name(snapshot: dict[str, Any]) -> str:
    agents = snapshot.get("agents") or []
    for agent in agents:
        if agent.get("is_lead"):
            return str(agent["name"])
    return "lead"


def blueprint_names(snapshot: dict[str, Any]) -> list[str]:
    return [bp["name"] for bp in snapshot.get("blueprints") or []]


def post_message(client: httpx.Client, base: str, message: str) -> str:
    res = client.post(f"{base}/team/chat", data={"message": message})
    res.raise_for_status()
    return str(res.json()["session_id"])


def post_interrupt(client: httpx.Client, base: str, session_id: str) -> None:
    res = client.post(
        f"{base}/team/chat",
        data={"session_id": session_id, "interrupt": "true"},
    )
    res.raise_for_status()


def fetch_history(client: httpx.Client, base: str, session_id: str) -> dict[str, Any]:
    res = client.get(f"{base}/team/{session_id}/history")
    res.raise_for_status()
    return res.json()


def fetch_todos(client: httpx.Client, base: str, session_id: str) -> list[dict[str, Any]]:
    res = client.get(f"{base}/team/sessions/{session_id}/todos")
    res.raise_for_status()
    data = res.json()
    todos = data.get("todos", [])
    return [todo for todo in todos if isinstance(todo, dict)]


def iter_sse(
    client: httpx.Client,
    base: str,
    session_id: str,
    *,
    wait: int,
):
    start = time.monotonic()
    with client.stream("GET", f"{base}/team/{session_id}/stream") as res:
        res.raise_for_status()
        event_name = "message"
        data_lines: list[str] = []
        for line in res.iter_lines():
            if time.monotonic() - start > wait:
                return
            if line.startswith("event:"):
                event_name = line[6:].strip()
            elif line.startswith("data:"):
                data_lines.append(line[5:].strip())
            elif line == "":
                if not data_lines:
                    continue
                raw = "\n".join(data_lines)
                data_lines = []
                try:
                    data = json.loads(raw)
                except json.JSONDecodeError:
                    data = {"_raw": raw}
                yield Event(event_name, data)
                if event_name == "done":
                    return


def drain_turn(client: httpx.Client, base: str, session_id: str, *, wait: int) -> None:
    for event in iter_sse(client, base, session_id, wait=wait):
        if event.name == "agent_status":
            print(f"  status {event.data.get('agent')} -> {event.data.get('status')}")
        elif event.name == "done":
            print("  done")


def verify_fresh_session_roster(client: httpx.Client, base: str, wait: int) -> bool:
    print("\n[1] fresh session should start with lead-only roster")
    sid = post_message(
        client,
        base,
        "Smoke test: reply directly with 'fresh session ok'. Do not spawn or message any team members.",
    )
    print(f"  session: {sid}")
    drain_turn(client, base, sid, wait=wait)
    members = live_member_names(fetch_agents(client, base))
    if members:
        print(f"  FAIL: live members leaked into fresh session: {members}")
        return False
    print("  PASS: no live members after fresh lead-only session")
    return True


def verify_stop_keeps_member_live(client: httpx.Client, base: str, wait: int) -> bool:
    snapshot = fetch_agents(client, base)
    lead = lead_name(snapshot)
    blueprints = blueprint_names(snapshot)
    if not blueprints:
        print("\n[2] SKIP: no team blueprints configured")
        return True

    blueprint = blueprints[0]
    print(
        f"\n[2] stop should interrupt running member to idle (blueprint={blueprint})"
    )
    sid = post_message(
        client,
        base,
        "Smoke test: call team_manage(action='spawn', members=['{bp}']), "
        "create one high-priority todo assigned_to the spawned handle, then message "
        "that member and explicitly tell it to claim the todo before working. The "
        "task is to write numbers 1 through 80, one per line. Do not dismiss the "
        "member yourself.".format(bp=blueprint),
    )
    print(f"  session: {sid}")

    interrupted = False
    working_agent: str | None = None
    idle_after_interrupt = False
    start = time.monotonic()

    for event in iter_sse(client, base, sid, wait=wait):
        if event.name != "agent_status":
            continue
        agent = str(event.data.get("agent") or "")
        status = str(event.data.get("status") or "")
        print(f"  status {agent} -> {status}")
        if agent != lead and status == "working" and not interrupted:
            working_agent = agent
            post_interrupt(client, base, sid)
            interrupted = True
            print(f"  interrupt posted for {agent}")
            continue
        # After interrupt, the working member must return to idle (NOT
        # offline). Only explicit team_manage(action="dismiss") emits
        # offline — see commit 6ad0205 "fix: keep stopped members live".
        if interrupted and working_agent and agent == working_agent:
            if status == "idle":
                idle_after_interrupt = True
                break
            if status == "offline":
                print(
                    f"  FAIL: {agent} emitted offline after stop; "
                    "interrupt should NOT dismiss live members."
                )
                return False
        if time.monotonic() - start > wait:
            break

    members = live_member_names(fetch_agents(client, base))
    if not interrupted:
        print("  FAIL: no running member was observed before timeout")
        return False
    if not idle_after_interrupt:
        print(f"  FAIL: {working_agent} did not return to idle after stop")
        return False
    if working_agent not in members:
        print(
            f"  FAIL: {working_agent} was dismissed from /team/agents after stop; "
            f"interrupt must keep the member live. live={members}"
        )
        return False
    history = fetch_history(client, base, sid)
    lead_messages = history.get("lead", {}).get("messages", [])
    has_notice = any(
        msg.get("role") == "user"
        and (msg.get("extra") or {}).get("from_agent") == working_agent
        and "Stopped before completing assigned work" in str(msg.get("content") or "")
        for msg in lead_messages
    )
    if not has_notice:
        print(f"  FAIL: lead history has no stop notice from {working_agent}")
        return False
    todos = fetch_todos(client, base, sid)
    touched = [
        todo
        for todo in todos
        if working_agent in {todo.get("assigned_to"), todo.get("claimed_by")}
        or "write numbers" in str(todo.get("content") or "").lower()
    ]
    if not touched:
        print("  WARN: no matching todo was created; skipped todo release check")
    else:
        unreleased = [
            todo
            for todo in touched
            if todo.get("status") == "in_progress"
            or todo.get("claimed_by") == working_agent
            or todo.get("assigned_to") == working_agent
        ]
        if unreleased:
            print(f"  FAIL: todos still tied to stopped member: {unreleased}")
            return False
        print("  PASS: stopped member todos released to pending/unassigned")
    print(
        f"  PASS: {working_agent} returned to idle, remained live, "
        "stop notice delivered"
    )
    return True


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default=BASE)
    parser.add_argument("--wait", type=int, default=DEFAULT_WAIT)
    args = parser.parse_args()

    with httpx.Client(timeout=args.wait + 10) as client:
        try:
            fetch_agents(client, args.base)
        except httpx.HTTPError as exc:
            raise SystemExit(f"server unavailable at {args.base}: {exc}") from exc

        ok = True
        ok = verify_fresh_session_roster(client, args.base, args.wait) and ok
        ok = verify_stop_keeps_member_live(client, args.base, args.wait) and ok
        if not ok:
            raise SystemExit(1)


if __name__ == "__main__":
    main()
