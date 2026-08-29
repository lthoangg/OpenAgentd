"""Smoke-test the summarization SSE events.

Drives the team chat until the SummarizationHook fires, captures the
``summarization_start`` / ``summarization_content`` / ``summarization_end``
events on the team stream, and reports whether the lifecycle was complete
and the deltas concatenate into the final summary.

Useful for:
  - Verifying the backend publishes start → N deltas → end on success
  - Verifying ``metadata.error=True`` lands on failure paths
  - Sanity-checking that the streamed deltas, joined, equal the final summary
  - Spotting missing replay/fan-out coverage when reconnecting mid-compaction

Prerequisites:
  - Server running (``make run`` / ``uv run python -m app.server``)
  - Lower ``DEFAULT_PROMPT_TOKEN_THRESHOLD`` in
    ``app/agent/hooks/summarization.py`` to a small value (e.g. ``2000``)
    and restart the server so summarisation actually fires during the
    warm-up turns. There is no file-based configuration for this threshold.

Usage:
  uv run python -m manual.summarization_sse
  uv run python -m manual.summarization_sse --session ID         # follow-up turn on an existing session
  uv run python -m manual.summarization_sse --out .openagentd/state/summ_sse.jsonl
  uv run python -m manual.summarization_sse --wait 120
  uv run python -m manual.summarization_sse --warmup 8           # send N warm-up turns first
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import httpx

from manual._common import DEFAULT_BASE

BASE = DEFAULT_BASE
DEFAULT_WAIT = 180

# ── Colors ──────────────────────────────────────────────────────────────────
RESET = "\033[0m"
DIM = "\033[2m"
BOLD = "\033[1m"
RED = "\033[31m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
CYAN = "\033[36m"

# Long prompts that burn tokens fast
WARMUP_PROMPTS = [
    "Write a detailed 250-word biography of Albert Einstein.",
    "Write a detailed 250-word summary of the theory of relativity.",
    "Write 250 words about the photoelectric effect and its importance.",
    "Explain quantum entanglement in 250 words with concrete examples.",
    "Summarize the Manhattan Project in 250 words.",
    "Describe the history of computing from ENIAC to modern CPUs in 250 words.",
    "Outline the major events of the 20th century in 250 words.",
    "Describe the structure of DNA in 250 words.",
]


# ── HTTP helpers ────────────────────────────────────────────────────────────


def post_agent_message(
    base: str, message: str, session_id: str | None, model: str | None = None
) -> str:
    payload: dict = {"message": message, "workspace": "."}
    if session_id:
        payload["session_id"] = session_id
    if model:
        payload["model"] = model
    r = httpx.post(f"{base}/agent/chat", data=payload)
    r.raise_for_status()
    return r.json()["session_id"]


def wait_for_done(base: str, sid: str, timeout: int) -> bool:
    """Drain the SSE stream until ``done`` arrives. Returns True on clean exit."""
    start = time.monotonic()
    try:
        with httpx.stream(
            "GET", f"{base}/agent/{sid}/stream", timeout=timeout + 5
        ) as resp:
            resp.raise_for_status()
            for line in resp.iter_lines():
                if time.monotonic() - start > timeout:
                    return False
                if line.startswith("event:") and line[6:].strip() == "done":
                    return True
    except httpx.ReadTimeout:
        return False
    return False


# ── SSE capture (summarisation focused) ─────────────────────────────────────


def capture_summarisation(
    base: str, sid: str, timeout: int, out_path: Path | None
) -> dict:
    """Stream the turn, isolating summarisation_* events.

    Returns a dict::

        {
            "start":   [{agent, t}],
            "content": [{agent, text, t}],
            "end":     [{agent, summary, error, t}],
            "other":   Counter of other event types seen (for sanity),
            "done":    bool,
        }
    """
    captured: dict = {"start": [], "content": [], "end": [], "other": {}, "done": False}
    out_fh = out_path.open("a", encoding="utf-8") if out_path else None
    start_t = time.monotonic()

    print(f"{DIM}{'time':>7s}  event                  details{RESET}")
    print(f"{DIM}{'-' * 7}  {'-' * 22} {'-' * 60}{RESET}")

    try:
        with httpx.stream(
            "GET", f"{base}/agent/{sid}/stream", timeout=timeout + 5
        ) as resp:
            resp.raise_for_status()
            current_event = "message"
            data_buf: list[str] = []

            for line in resp.iter_lines():
                if time.monotonic() - start_t > timeout:
                    print(f"{RED}[timeout]{RESET}")
                    break

                if line.startswith("event:"):
                    current_event = line[6:].strip()
                elif line.startswith("data:"):
                    data_buf.append(line[5:].strip())
                elif line == "":
                    if not data_buf:
                        continue
                    raw = "\n".join(data_buf)
                    data_buf = []
                    try:
                        data = json.loads(raw)
                    except json.JSONDecodeError:
                        continue

                    elapsed = round(time.monotonic() - start_t, 3)

                    if current_event == "summarization_start":
                        captured["start"].append(
                            {"agent": data.get("agent", ""), "t": elapsed}
                        )
                        print(
                            f"{elapsed:>6.2f}s  {YELLOW}{current_event:22s}{RESET} "
                            f"agent={data.get('agent', '?')}"
                        )
                    elif current_event == "summarization_content":
                        text = data.get("text", "")
                        captured["content"].append(
                            {
                                "agent": data.get("agent", ""),
                                "text": text,
                                "t": elapsed,
                            }
                        )
                        preview = text.replace("\n", " ")
                        if len(preview) > 60:
                            preview = preview[:59] + "…"
                        print(
                            f"{elapsed:>6.2f}s  {DIM}{current_event:22s}{RESET} "
                            f"{DIM}{preview!r}{RESET}"
                        )
                    elif current_event == "summarization_end":
                        meta = data.get("metadata") or {}
                        err = bool(meta.get("error"))
                        captured["end"].append(
                            {
                                "agent": data.get("agent", ""),
                                "summary": data.get("summary", ""),
                                "error": err,
                                "t": elapsed,
                            }
                        )
                        tag = f"{RED}error{RESET}" if err else f"{GREEN}ok{RESET}"
                        print(
                            f"{elapsed:>6.2f}s  {GREEN}{current_event:22s}{RESET} "
                            f"agent={data.get('agent', '?')} {tag} "
                            f"summary_len={len(data.get('summary', ''))}"
                        )
                    elif current_event == "done":
                        captured["done"] = True
                        print(
                            f"{elapsed:>6.2f}s  {CYAN}{'done':22s}{RESET} turn complete"
                        )
                        if out_fh:
                            out_fh.write(
                                json.dumps(
                                    {"t": elapsed, "event": "done", "data": data},
                                    ensure_ascii=False,
                                )
                                + "\n"
                            )
                        break
                    else:
                        captured["other"][current_event] = (
                            captured["other"].get(current_event, 0) + 1
                        )

                    if out_fh and current_event.startswith("summarization_"):
                        out_fh.write(
                            json.dumps(
                                {
                                    "t": elapsed,
                                    "event": current_event,
                                    "data": data,
                                },
                                ensure_ascii=False,
                            )
                            + "\n"
                        )
    except httpx.ReadTimeout:
        print(f"{RED}[read timeout]{RESET}")
    finally:
        if out_fh:
            out_fh.close()

    return captured


# ── Reporting ────────────────────────────────────────────────────────────────


def report(captured: dict) -> int:
    """Pretty-print the capture summary; return process exit code."""
    starts = captured["start"]
    contents = captured["content"]
    ends = captured["end"]

    print(f"\n{BOLD}Summarisation events captured{RESET}")
    print(f"  start:   {len(starts)}")
    print(f"  content: {len(contents)}")
    print(f"  end:     {len(ends)}")
    print(f"  done:    {captured['done']}")
    if captured["other"]:
        other_str = ", ".join(f"{k}={v}" for k, v in sorted(captured["other"].items()))
        print(f"  {DIM}other:   {other_str}{RESET}")

    if not starts:
        print(
            f"\n{YELLOW}WARN: no summarization_start events seen.{RESET}\n"
            "  Did you lower DEFAULT_PROMPT_TOKEN_THRESHOLD in "
            "app/agent/hooks/summarization.py and restart the server,\n"
            "  and send enough warm-up turns?"
        )
        return 1

    failed = False

    # Per-agent lifecycle sanity check — every start should have a matching end.
    start_agents = [s["agent"] for s in starts]
    end_agents = [e["agent"] for e in ends]
    if sorted(start_agents) != sorted(end_agents):
        print(
            f"\n{RED}FAIL: start agents {start_agents} != end agents {end_agents}{RESET}"
        )
        failed = True
    else:
        print(f"\n{GREEN}OK: every start has a matching end.{RESET}")

    # Delta concatenation check — the joined content should be a prefix of the
    # final summary (the backend may strip trailing whitespace at end time).
    for end in ends:
        agent = end["agent"]
        joined = "".join(c["text"] for c in contents if c["agent"] == agent)
        summary = end["summary"]
        if end["error"]:
            print(
                f"  {YELLOW}{agent}: end carries error=True, skipping delta check{RESET}"
            )
            continue
        if not joined:
            print(
                f"  {YELLOW}{agent}: no content deltas captured (provider may not stream){RESET}"
            )
            continue
        # The end summary is .strip()ed in the hook so allow trailing whitespace drift.
        if summary.strip() == joined.strip():
            print(
                f"  {GREEN}{agent}: deltas reconstruct the final summary ({len(joined)} chars){RESET}"
            )
        elif summary.strip().startswith(joined.strip()[: min(len(joined), 200)]):
            print(
                f"  {YELLOW}{agent}: deltas are a prefix of the summary "
                f"(delta_len={len(joined)}, summary_len={len(summary)}){RESET}"
            )
        else:
            print(
                f"  {RED}{agent}: deltas do NOT reconstruct the summary "
                f"(delta_len={len(joined)}, summary_len={len(summary)}){RESET}"
            )
            failed = True

    return 1 if failed else 0


# ── Main ─────────────────────────────────────────────────────────────────────


def main() -> int:
    p = argparse.ArgumentParser(
        description="Capture and verify summarisation SSE events"
    )
    p.add_argument(
        "--session",
        default=None,
        help="Reuse an existing team session id (skip warm-up turns)",
    )
    p.add_argument(
        "--warmup",
        type=int,
        default=len(WARMUP_PROMPTS),
        help=f"Number of warm-up turns to send (default {len(WARMUP_PROMPTS)})",
    )
    p.add_argument(
        "--wait",
        type=int,
        default=DEFAULT_WAIT,
        help="Max seconds to wait for the streaming turn",
    )
    p.add_argument("--base", default=BASE, help="API base URL")
    p.add_argument("--model", default=None, help="Model override")
    p.add_argument(
        "--out",
        type=Path,
        help="Append captured summarization_* events as JSONL to this file",
    )
    args = p.parse_args()
    base = args.base.rstrip("/")

    sid = args.session
    if sid is None:
        if args.warmup <= 0:
            print(f"{RED}--warmup must be > 0 when no --session is provided{RESET}")
            return 2
        print(f"{BOLD}sending {args.warmup} warm-up turn(s) to grow context{RESET}")
        for i, msg in enumerate(WARMUP_PROMPTS[: args.warmup], 1):
            print(f"  [{i}/{args.warmup}] {msg[:60]}…", end="", flush=True)
            sid = post_agent_message(base, msg, sid, model=args.model)
            ok = wait_for_done(base, sid, args.wait)
            print(f" {'ok' if ok else 'TIMEOUT'}")
        print(f"\n{BOLD}session{RESET}: {sid}")

    # Trigger fresh turn whose ``before_model`` will fire summarisation.
    trigger = "Now write 250 words about the future of artificial general intelligence."
    print(f"\n{BOLD}trigger turn{RESET}: {trigger}")
    sid = post_agent_message(base, trigger, sid, model=args.model)
    print(f"{DIM}session: {sid}{RESET}\n")

    captured = capture_summarisation(base, sid, args.wait, args.out)
    code = report(captured)
    print(f"\n{DIM}session: {sid}{RESET}")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
