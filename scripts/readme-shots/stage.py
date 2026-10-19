"""Run the demo agent sessions the README screenshots show.

    stage.py          stage every session (run once, right after ``run.sh up``)
    stage.py hero     discard the hero's changes and re-run only the hero session
                      (the deleted run still shows in Telemetry; prefer a fresh ``up``)

Talks only to the sandbox backend started by ``run.sh up``. Makes real model
calls (a few cents). Writes ``$SHOTS_DIR/sessions.json`` mapping scene names to
session ids for ``capture.mjs``.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.request

API = os.environ["API"]
SHOTS_DIR = os.environ["SHOTS_DIR"]
LINKLY = f"{SHOTS_DIR}/code/linkly"
BUDGET = f"{SHOTS_DIR}/code/pocket-budget"
SESSIONS_FILE = f"{SHOTS_DIR}/sessions.json"

HERO_PROMPT = (
    "Add per-IP rate limiting to POST /api/shorten: at most 10 requests per minute per client, then respond "
    "429 with a Retry-After header. Keep it dependency-free in its own module, add tests, and run the full "
    "suite. Track your steps with todos. Leave the changes uncommitted so I can review them."
)
SIDE_QUESTION = "Why a fixed window instead of a token bucket here?"


def req(method: str, path: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(f"{API}{path}", data=data, method=method, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=60) as resp:
        raw = resp.read()
    try:
        return json.loads(raw) if raw else {}
    except ValueError:  # e.g. /btw answers with a stream, not JSON
        return {}


def chat(workspace: str, message: str, mode: str = "code", thinking: str | None = None) -> str:
    args = ["curl", "-sf", "-X", "POST", f"{API}/agent/chat", "-F", f"workspace={workspace}", "-F", f"message={message}"]
    args += ["-F", f"interaction_mode={mode}"]
    if thinking:
        args += ["-F", f"thinking_level={thinking}"]
    out = subprocess.run(args, check=True, capture_output=True, text=True).stdout
    return json.loads(out)["session_id"]


def settled(sid: str) -> bool:
    h = req("GET", f"/agent/{sid}/history")
    lead = h["lead"]
    return (not lead["running"]) or lead.get("needs_input") or bool(h.get("pending_question"))


def wait(sids: dict[str, str], timeout: float = 900) -> None:
    pending = dict(sids)
    deadline = time.time() + timeout
    while pending and time.time() < deadline:
        for name, sid in list(pending.items()):
            if settled(sid):
                print(f"  ✓ {name}", flush=True)
                del pending[name]
        time.sleep(3)
    if pending:
        sys.exit(f"timed out waiting for: {', '.join(pending)}")


def run_hero() -> str:
    """The main screenshot. Low thinking keeps reasoning summaries short, so tool rows and diffs carry the story."""
    sid = chat(LINKLY, HERO_PROMPT, thinking="low")
    wait({"hero": sid})
    todos = req("GET", f"/agent/sessions/{sid}/todos")["todos"]
    if not todos or any(t["status"] != "completed" for t in todos):
        sys.exit(
            "hero session left its task list unfinished (model slip). For clean Telemetry, start over:\n"
            "  scripts/readme-shots/run.sh up && scripts/readme-shots/run.sh stage"
        )
    req("POST", f"/agent/sessions/{sid}/btw", {"question": SIDE_QUESTION})
    req("PATCH", f"/agent/sessions/{sid}", {"pinned": True})
    return sid


def stage_all() -> dict[str, str]:
    sessions: dict[str, str] = {}

    # Hero first: it is the one shot that must be right, so fail before spending on the rest.
    print("staging hero session…", flush=True)
    sessions["hero"] = run_hero()

    print("staging the other sessions…", flush=True)
    sessions["budget"] = chat(
        BUDGET,
        "Add a `--month YYYY-MM` option to `budget report` that only totals entries from that month. "
        "Add a test for it, then check it by running `python3 -m budget report --month 2026-10`.",
    )
    sessions["chat"] = chat(
        req("GET", "/agent/workspace/tree")["chat"]["path"],
        "For a URL shortener, should redirects be 301, 302 or 308? Give me a short recommendation with the trade-offs.",
    )
    sessions["audit"] = chat(
        LINKLY,
        "Delegate this to the explorer subagent: audit how slugs are generated and validated in src/slug.ts and "
        "src/server.ts. Can collisions, modulo bias, or ambiguous characters slip through? Wait for its report "
        "without messaging it again, then summarise the findings for me with file:line references. Don't change "
        "any code.",
    )
    sessions["plan"] = chat(
        LINKLY,
        "Links disappear whenever the server restarts. Plan moving storage from the in-memory LinkStore to SQLite "
        "with bun:sqlite, keeping the LinkStore API so server.ts barely changes. Cover the schema, counting visits "
        "atomically, and tests.",
        mode="plan",
    )
    wait({k: v for k, v in sessions.items() if k != "hero"})
    messages = req("GET", f"/agent/{sessions['audit']}/history")["lead"]["messages"]
    reports = [m for m in messages if m["role"] == "user" and (m.get("extra") or {}).get("from_agent")]
    if len(reports) != 1:
        sys.exit(
            f"audit session got {len(reports)} subagent reports instead of 1 (the lead kept messaging it). "
            "Start over: scripts/readme-shots/run.sh up && scripts/readme-shots/run.sh stage"
        )

    for task in (
        {"name": "Nightly test run", "workspace": LINKLY, "schedule_type": "cron", "cron_expression": "0 2 * * *",
         "prompt": "Run `bun test` and report any failures with a suggested fix."},
        {"name": "Weekly dependency check", "workspace": LINKLY, "schedule_type": "cron", "cron_expression": "0 9 * * 1",
         "prompt": "Check for outdated or vulnerable dependencies and summarise what to upgrade."},
        {"name": "Monthly budget report", "workspace": BUDGET, "schedule_type": "cron", "cron_expression": "0 8 1 * *",
         "prompt": "Run `python3 -m budget report` for last month and point out unusual spending."},
    ):
        req("POST", "/scheduler/tasks", task)
    return sessions


def restage_hero() -> dict[str, str]:
    with open(SESSIONS_FILE) as fh:
        sessions = json.load(fh)
    subprocess.run(["git", "checkout", "-q", "--", "."], cwd=LINKLY, check=True)
    subprocess.run(["git", "clean", "-fdq"], cwd=LINKLY, check=True)
    req("DELETE", f"/agent/sessions/{sessions['hero']}")
    sessions["hero"] = run_hero()
    return sessions


def main() -> None:
    sessions = restage_hero() if sys.argv[1:] == ["hero"] else stage_all()
    with open(SESSIONS_FILE, "w") as fh:
        json.dump(sessions, fh, indent=2)
    time.sleep(8)  # let the /btw answer land before anyone captures
    print(json.dumps(sessions, indent=2))


if __name__ == "__main__":
    main()
