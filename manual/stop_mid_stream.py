"""Drive the user-stop-mid-stream matrix and report invariant violations.

Scenarios (each run uses a fresh session):

  * ``early`` — short wait → likely catches the stream before any content
    has been emitted; tests the "empty assistant row" path.
  * ``text``  — long wait + a "write 200 words" prompt → stops in the
    middle of streaming assistant text.
  * ``tool``  — wait + a prompt that biases toward a filesystem read →
    stops while the model is emitting a tool call (the case fixed in
    ``stream_and_assemble``).

Each scenario runs twice: once where the follow-up message is sent
straight after the Stop, and once where ``/undo`` is dispatched first.

After every run the script inspects the persisted history and the
follow-up SSE stream, then evaluates phase-agnostic invariants:

  I0 Stop actually halted the turn — history snapshot 3s after the
     interrupt must equal the snapshot taken immediately after
  I1 every persisted ``tool_call.arguments`` parses as JSON (or is "")
  I2 every assistant ``tool_call_id`` has a matching ``tool`` role row
  I3 the follow-up turn produced no SSE ``error`` event
  I4 the follow-up turn reached SSE ``done``
  I5 history role ordering is sane — every ``tool`` row follows an
     assistant row with ``tool_calls`` (no orphan tool rows), and no two
     consecutive ``assistant`` rows. Consecutive ``user`` rows are
     intentionally allowed: a user can press Stop and send an additional
     message (the "I forgot to add..." pattern) — both messages are then
     in context for the next turn.

Note: ``/undo`` correctness is *not* asserted here. ``/undo`` moves a soft
"boundary" in the chat session that the ``/session/{sid}/history`` endpoint
doesn't surface, so this script can't tell from the response whether the
boundary moved. We verify ``/undo`` returned 202 (i.e. wasn't rejected
with 409 because the lead was still working); the actual revert semantics
are covered by integration tests in ``tests/services/test_chat_service.py``.

The script exits non-zero if any invariant fails on any run.

Usage:
  uv run python -m manual.stop_mid_stream
  uv run python -m manual.stop_mid_stream --base http://localhost:8000/api
  uv run python -m manual.stop_mid_stream --only text --only tool
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import dataclass, field

import httpx

from manual._common import DEFAULT_BASE
BASE = DEFAULT_BASE
FOLLOWUP = "Reply with the single word OK."
FOLLOWUP_TIMEOUT = 120
POST_STOP_SETTLE = 3.0          # how long Stop has to actually halt + flush
POST_UNDO_SETTLE = 0.5

PROMPTS: dict[str, tuple[str, float]] = {
    "early": (
        "Please summarise the history of Python in roughly 200 words.",
        0.3,
    ),
    "text": (
        "Please write a detailed ~200 word response describing the history "
        "and evolution of the Python programming language.",
        2.0,
    ),
    "tool": (
        "Use your read_file (or filesystem read) tool to read app/main.py "
        "from this repo and then summarise it.",
        1.5,
    ),
}


# ── HTTP helpers ────────────────────────────────────────────────────────────


def post_message(base: str, message: str, session_id: str | None = None) -> str:
    data: dict[str, str] = {"message": message}
    if session_id:
        data["session_id"] = session_id
    r = httpx.post(f"{base}/session/chat", data=data, timeout=20)
    r.raise_for_status()
    return r.json()["session_id"]


def post_interrupt(base: str, session_id: str) -> None:
    r = httpx.post(
        f"{base}/session/chat",
        data={"session_id": session_id, "interrupt": "true"},
        timeout=20,
    )
    r.raise_for_status()


def post_undo(base: str, session_id: str) -> dict | None:
    r = httpx.post(
        f"{base}/session/commands",
        json={"command": "undo", "session_id": session_id},
        timeout=20,
    )
    if r.status_code != 202:
        return {"error": f"{r.status_code}: {r.text}"}
    return r.json()


def get_history(base: str, session_id: str) -> list[dict]:
    r = httpx.get(
        f"{base}/session/{session_id}/history", params={"limit": 1000}, timeout=20
    )
    r.raise_for_status()
    return r.json()["session"]["messages"]


def stream_until_done(
    base: str, sid: str, *, timeout: int
) -> tuple[bool, bool, str]:
    """Return ``(done, saw_error, last_event)``.

    Reads SSE on ``/session/{sid}/stream`` until a ``done`` event arrives, an
    ``error`` event arrives, or ``timeout`` elapses.
    """
    deadline = time.monotonic() + timeout
    last_event = ""
    saw_error = False
    try:
        with httpx.stream("GET", f"{base}/session/{sid}/stream", timeout=timeout + 5) as r:
            current_event = ""
            for line in r.iter_lines():
                if time.monotonic() > deadline:
                    return False, saw_error, last_event
                if line.startswith("event:"):
                    current_event = line[6:].strip()
                    last_event = current_event
                    if current_event == "error":
                        saw_error = True
                    if current_event == "done":
                        return True, saw_error, current_event
    except httpx.ReadTimeout:
        return False, saw_error, last_event
    return False, saw_error, last_event


# ── Phase classification ────────────────────────────────────────────────────


def classify_stop_phase(messages: list[dict]) -> str:
    """Inspect the tail to guess which streaming phase Stop interrupted."""
    if not messages:
        return "no_assistant_row"
    tail = messages[-1]
    if tail.get("role") != "assistant":
        return f"tail_role={tail.get('role')}"

    tool_calls = tail.get("tool_calls") or []
    content = (tail.get("content") or "").strip()
    reasoning = (tail.get("reasoning") or "").strip()

    if tool_calls:
        bad = sum(1 for tc in tool_calls if not _args_ok(tc))
        return f"tool_call(n={len(tool_calls)}, bad_args={bad})"
    if content:
        return f"text(len={len(content)})"
    if reasoning:
        return f"reasoning_only(len={len(reasoning)})"
    return "empty_row"


def _args_ok(tc: dict) -> bool:
    """Return True if a persisted tool_call's arguments are JSON-loadable or ''."""
    args = (tc.get("function") or {}).get("arguments")
    if args is None or args == "":
        return True
    if not isinstance(args, str):
        return False
    try:
        json.loads(args)
    except json.JSONDecodeError:
        return False
    return True


# ── Invariants ──────────────────────────────────────────────────────────────


@dataclass
class RunReport:
    name: str
    session_id: str
    stop_phase: str
    undid: bool
    stop_held: bool = True           # I0 — Stop actually halted the turn
    undo_409: bool = False           # /undo refused because lead was still working
    pre_undo_count: int = 0
    post_undo_count: int = 0
    followup_done: bool = False
    followup_error: bool = False
    last_event: str = ""
    final_count: int = 0
    violations: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.violations


def _history_signature(messages: list[dict]) -> tuple:
    """A stable digest of message count + tail content/tool_call shape.

    Used by I0 to decide whether the agent kept working after Stop. We don't
    compare full payloads — just count, last-role, last-content length, and
    tool_call ids — because the checkpointer may rewrite microsecond-level
    fields without semantic change.
    """
    if not messages:
        return (0,)
    tail = messages[-1]
    tc = tail.get("tool_calls") or []
    return (
        len(messages),
        tail.get("role"),
        len((tail.get("content") or "")),
        len((tail.get("reasoning") or "")),
        tuple(t.get("id") for t in tc),
    )


def check_invariants(report: RunReport, messages: list[dict]) -> None:
    v = report.violations

    # I0: Stop actually halted the turn.
    if not report.stop_held:
        v.append("I0: Stop did not halt the turn — history kept growing after interrupt")

    # I1: every persisted tool_call.arguments parses as JSON or is "".
    for i, m in enumerate(messages):
        for tc in m.get("tool_calls") or []:
            if not _args_ok(tc):
                args = (tc.get("function") or {}).get("arguments")
                prefix = (args or "")[:80]
                v.append(f"I1: msg#{i} tool_call has bad args prefix={prefix!r}")

    # I2: every assistant tool_call.id has a paired tool message.
    tool_ids: list[str] = []
    for m in messages:
        if m.get("role") == "assistant":
            for tc in m.get("tool_calls") or []:
                tid = tc.get("id")
                if tid:
                    tool_ids.append(tid)
    paired = {m.get("tool_call_id") for m in messages if m.get("role") == "tool"}
    for tid in tool_ids:
        if tid not in paired:
            v.append(f"I2: tool_call_id={tid} has no matching tool reply")

    # I3 / I4: follow-up turn must reach done without error.
    if report.followup_error:
        v.append(f"I3: follow-up SSE emitted error (last_event={report.last_event})")
    if not report.followup_done:
        v.append(f"I4: follow-up SSE never reached done (last_event={report.last_event})")

    # I5: role ordering — no two consecutive assistant rows; every ``tool``
    #     row must follow an assistant row with tool_calls. Consecutive
    #     ``user`` rows are allowed (Stop + additional-message pattern).
    prev_role: str | None = None
    for i, m in enumerate(messages):
        role = m.get("role")
        if role == "assistant" and prev_role == "assistant":
            v.append(f"I5: consecutive assistant rows at msg#{i}")
        if role == "tool":
            # The preceding non-tool ancestor must be an assistant with tool_calls.
            j = i - 1
            while j >= 0 and messages[j].get("role") == "tool":
                j -= 1
            if j < 0 or messages[j].get("role") != "assistant":
                v.append(f"I5: orphan tool row at msg#{i} (no assistant ancestor)")
            elif not (messages[j].get("tool_calls") or []):
                v.append(f"I5: tool row at msg#{i} but assistant ancestor has no tool_calls")
        prev_role = role

    # I6 intentionally dropped — see module docstring.


# ── Single run ──────────────────────────────────────────────────────────────


def run_one(base: str, scenario: str, *, undo: bool) -> RunReport:
    prompt, wait = PROMPTS[scenario]
    label = f"{scenario}{'+undo' if undo else ''}"
    print(f"\n── {label} ── prompt={prompt[:60]!r}... wait={wait}s")

    sid = post_message(base, prompt)
    print(f"   session={sid}")
    time.sleep(wait)
    post_interrupt(base, sid)

    # I0: snapshot now and again after a settle window. If the snapshot
    # changed, Stop did not actually cancel the turn.
    snap_a = get_history(base, sid)
    time.sleep(POST_STOP_SETTLE)
    snap_b = get_history(base, sid)
    stop_held = _history_signature(snap_a) == _history_signature(snap_b)
    pre = snap_b
    phase = classify_stop_phase(pre)
    print(
        f"   stop_held={stop_held} stop_phase={phase} msgs={len(pre)}"
        + ("" if stop_held else f" (grew {len(snap_a)} -> {len(snap_b)})")
    )

    report = RunReport(
        name=label, session_id=sid, stop_phase=phase, undid=undo,
        stop_held=stop_held, pre_undo_count=len(pre),
    )

    if undo:
        result = post_undo(base, sid)
        time.sleep(POST_UNDO_SETTLE)
        post = get_history(base, sid)
        report.post_undo_count = len(post)
        if result and "error" in result:
            report.undo_409 = "409" in result["error"]
            print(f"   undo FAILED: {result['error']}")
        else:
            print(f"   undo ok: {report.pre_undo_count} -> {report.post_undo_count}")
    else:
        report.post_undo_count = report.pre_undo_count

    post_message(base, FOLLOWUP, session_id=sid)
    done, saw_error, last = stream_until_done(base, sid, timeout=FOLLOWUP_TIMEOUT)
    report.followup_done = done
    report.followup_error = saw_error
    report.last_event = last
    print(f"   followup done={done} error={saw_error} last_event={last!r}")

    final = get_history(base, sid)
    report.final_count = len(final)
    check_invariants(report, final)
    return report


# ── Reporting ───────────────────────────────────────────────────────────────


def print_summary(reports: list[RunReport]) -> None:
    print("\n" + "=" * 78)
    print(f"  Stop-mid-stream summary — {len(reports)} run(s)")
    print("=" * 78)
    print(f"  {'scenario':<14} {'phase':<28} {'msgs':>4}  {'follow-up':<11}  result")
    print(f"  {'-' * 14} {'-' * 28} {'-' * 4}  {'-' * 11}  ------")
    for r in reports:
        fu = "done" if r.followup_done else ("error" if r.followup_error else "stalled")
        result = "OK" if r.ok else f"FAIL ({len(r.violations)})"
        print(
            f"  {r.name:<14} {r.stop_phase:<28} {r.final_count:>4}  "
            f"{fu:<11}  {result}"
        )
    failures = [r for r in reports if not r.ok]
    if failures:
        print(f"\n  {len(failures)} run(s) violated invariants:")
        for r in failures:
            print(f"\n  ▸ {r.name}  (session {r.session_id})")
            for line in r.violations:
                print(f"      - {line}")


# ── Main ────────────────────────────────────────────────────────────────────


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--base", default=BASE, help="API base URL")
    p.add_argument(
        "--only",
        action="append",
        choices=sorted(PROMPTS),
        help="Run only the named scenario(s). Repeatable. Default: all.",
    )
    p.add_argument(
        "--skip-undo", action="store_true", help="Skip the /undo variant of each run."
    )
    args = p.parse_args()
    base = args.base.rstrip("/")
    scenarios = args.only or sorted(PROMPTS)

    # Sanity ping.
    try:
        httpx.get(f"{base.rsplit('/', 1)[0]}/health/ready", timeout=5)
    except httpx.HTTPError as exc:
        print(f"server unreachable at {base}: {exc}", file=sys.stderr)
        return 2

    reports: list[RunReport] = []
    for scenario in scenarios:
        reports.append(run_one(base, scenario, undo=False))
        if not args.skip_undo:
            reports.append(run_one(base, scenario, undo=True))

    print_summary(reports)
    return 0 if all(r.ok for r in reports) else 1


if __name__ == "__main__":
    sys.exit(main())
