#!/usr/bin/env python3
"""Audit which tools earn their keep: volume, latency, outcome quality, waste.

Usage:
    uv run python .openagentd/skills/oad/debug-prod/scripts/tool_usage.py [--days N]

Answers "is any tool underused, slow, or not useful?" by combining two sources:

  * OTEL spans  — call counts, durations, result sizes, run ids.
  * loguru logs — the arguments and the actual result text, which is what says
    whether a *successful* call was useful ("No matches" is a green span and a
    wasted turn).

Plain stdlib json rather than DuckDB (used by ``query_otel.py``): this script
joins spans to logs by tool-call id and classifies shell commands by regex, both
of which are shorter in Python than in generated SQL.

Three traps this encodes, learned by falling into them:

1. **Never divide errors by calls across different windows.** ``tool_error``
   records survive longer than ``tool_start`` records, which once produced a
   "grep fails 44% of the time" reading for a bug fixed weeks earlier. The
   FIXED-OR-LIVE section exists to catch that: it prints each tool's error dates
   so a historical problem cannot pose as a live one.
2. **Redundant work is only redundant within a run.** Counting identical calls
   across all sessions turns legitimate reuse (loading a skill in a new session)
   into fake waste, so duplicates are attributed per ``run_id``.
3. **Logged arguments are truncated at 500 chars** (``tool_executor.py``), so
   ``json.loads`` on them fails for 16% of shell calls — and precisely the long
   ones (heredocs, inline python). Dropping the unparseable ones inflated
   "shell is used to read files" to 78%, because short ``cat``/``head`` calls
   always parse. Never parse those args strictly; degrade to a regex.
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

STATE_DIRS = [
    Path.home() / ".local/state/openagentd",
    Path(".openagentd/dev/state"),
]
TOOL_EXECUTOR = "app.agent.agent_loop.tool_executor"
# A result that starts with one of these is a successful call that found nothing.
NO_HIT_PREFIXES = (
    "No matches for pattern",
    "No files matching",
    "No files found",
    "No background processes",
    "(no output)",
)
# What shell is standing in for, keyed by the *leading* command of a segment.
# Matching anywhere in the string instead would count every `... | head -20` as
# a file read, and `cat > file <<EOF` (a write) as one too.
SHELL_CLASSES = [
    (
        "read file (cat/head/tail/sed -n)",
        {"cat", "bat", "head", "tail", "less", "more"},
    ),
    ("search (rg/grep/ag)", {"rg", "grep", "egrep", "ag", "ack"}),
    ("find files", {"find", "fd", "locate"}),
    ("list dir (ls)", {"ls", "tree", "exa", "eza"}),
    ("git", {"git", "gh"}),
    (
        "tests/build",
        {
            "pytest",
            "bun",
            "npm",
            "yarn",
            "pnpm",
            "node",
            "make",
            "cargo",
            "uv",
            "ruff",
            "tsc",
        },
    ),
    ("python inline", {"python", "python3"}),
    (
        "process/system",
        {
            "ps",
            "kill",
            "lsof",
            "curl",
            "wget",
            "open",
            "du",
            "df",
            "chmod",
            "mkdir",
            "cp",
            "mv",
        },
    ),
]
# Segment prefixes that say nothing about intent.
SHELL_NOISE_TOKENS = {
    "cd",
    "set",
    "export",
    "source",
    ".",
    "(",
    "{",
    "then",
    "do",
    "if",
    "sudo",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Audit tool usage and usefulness.")
    parser.add_argument(
        "--days", type=int, default=7, help="Lookback window (default: 7)"
    )
    parser.add_argument(
        "--top", type=int, default=20, help="Rows per table (default: 20)"
    )
    return parser.parse_args()


def pct(values: list[float], p: int) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, round(p / 100 * (len(ordered) - 1)))]


def iter_span_files():
    for state in STATE_DIRS:
        yield from sorted((state / "otel/spans").glob("*.jsonl"))


def iter_log_records():
    """Yield ``(datetime, message)`` for tool-executor records, oldest first."""
    for state in STATE_DIRS:
        for path in sorted((state / "logs/app").glob("app*.log")):
            with path.open(errors="ignore") as handle:
                for line in handle:
                    if TOOL_EXECUTOR not in line:
                        continue
                    try:
                        rec = json.loads(line)["record"]
                    except Exception:
                        continue
                    if not rec.get("name", "").startswith(TOOL_EXECUTOR):
                        continue
                    yield (
                        datetime.fromtimestamp(rec["time"]["timestamp"], timezone.utc),
                        rec["message"],
                    )


def field(message: str, key: str) -> str:
    """Extract ``key=value`` from a logfmt-ish message."""
    if f"{key}=" not in message:
        return ""
    return message.split(f"{key}=", 1)[1].split()[0]


def shell_command(raw: str) -> str:
    """Recover the command from possibly-truncated logged args.

    Logged args are cut at 500 chars, so strict JSON parsing loses the longest
    16% of commands. Fall back to slicing after the ``"command":`` key.
    """
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return str(parsed.get("command", ""))
    except Exception:
        pass
    match = re.search(r'"command"\s*:\s*"(.*)', raw, re.DOTALL)
    if not match:
        return ""
    # Unescape just enough for token/regex classification.
    return match.group(1).replace("\\n", "\n").replace('\\"', '"').replace("\\\\", "\\")


def classify_shell(command: str) -> str:
    """Label a command by what it stands in for, using leading commands only."""
    for segment in re.split(r"&&|\|\||;|\n", command):
        # A pipeline tail (`| head -20`) shapes output; the head states intent.
        head = segment.split("|", 1)[0].strip()
        while re.match(r"^\w+=\S*\s", head):  # VAR=1 prefix
            head = head.split(None, 1)[1].strip()
        tokens = head.split()
        if not tokens:
            continue
        token = tokens[0].rsplit("/", 1)[-1]  # ./scripts/x.sh -> x.sh
        if token in SHELL_NOISE_TOKENS:
            continue
        write = "write via shell (>, tee, sed -i)"
        # A redirect to a file, not `2>&1` (fd dup) and not `>&2`.
        redirects = bool(re.search(r"(?<!\d)>>?\s*[^&\s]", head))
        if token == "tee" or (token == "sed" and "-i" in tokens):
            return write
        if token == "sed" and "-n" in tokens:
            return "read file (cat/head/tail/sed -n)"
        for label, leaders in SHELL_CLASSES:
            if token in leaders:
                # `cat > file <<EOF` writes despite the read verb; `make x > log`
                # is still a build, so only reads are overridden.
                return write if redirects and label.startswith("read file") else label
        return write if redirects else "other"
    return "other"


def main() -> None:
    args = parse_args()
    cutoff = datetime.now(timezone.utc) - timedelta(days=args.days)
    print(
        f"=== Tool Usage Audit (last {args.days}d, cutoff "
        f"{cutoff:%Y-%m-%d %H:%M UTC}) ==="
    )

    # ── spans: volume, latency, result size ─────────────────────────────────
    calls: Counter[str] = Counter()
    durations: dict[str, list[float]] = defaultdict(list)
    sizes: dict[str, list[int]] = defaultdict(list)
    run_of_call: dict[str, str] = {}
    runs: set[str] = set()

    for path in iter_span_files():
        with path.open(errors="ignore") as handle:
            for line in handle:
                try:
                    span = json.loads(line)
                except Exception:
                    continue
                if not span.get("name", "").startswith("execute_tool"):
                    continue
                if (
                    datetime.fromtimestamp(span["start_time"] / 1e9, timezone.utc)
                    < cutoff
                ):
                    continue
                attrs = span.get("attributes", {})
                tool = attrs.get("gen_ai.tool.name", "?")
                calls[tool] += 1
                durations[tool].append(span.get("duration_ms") or 0.0)
                if isinstance(attrs.get("tool.result.length"), int):
                    sizes[tool].append(attrs["tool.result.length"])
                run = attrs.get("run_id")
                if run:
                    runs.add(run)
                    if attrs.get("gen_ai.tool.call.id"):
                        run_of_call[attrs["gen_ai.tool.call.id"]] = run

    total = sum(calls.values())
    if not total:
        print("No tool spans in window.")
        return

    print(f"\n--- Volume & cost ({total} calls, {len(runs)} runs) ---")
    header = (
        f"{'tool':24}{'calls':>7}{'share':>7}{'p50ms':>8}{'p95ms':>9}"
        f"{'max_s':>8}{'res_p50':>9}{'res_p95':>9}{'MB':>7}"
    )
    print(header)
    print("-" * len(header))
    for tool, n in calls.most_common(args.top):
        print(
            f"{tool:24}{n:>7}{100 * n / total:>6.1f}%{pct(durations[tool], 50):>8.0f}"
            f"{pct(durations[tool], 95):>9.0f}{max(durations[tool]) / 1000:>8.1f}"
            f"{pct(sizes[tool], 50):>9.0f}{pct(sizes[tool], 95):>9.0f}"
            f"{sum(sizes[tool]) / 1e6:>7.1f}"
        )
    print(
        f"\ntotal tool output into context: {sum(sum(v) for v in sizes.values()) / 1e6:.1f} MB"
    )

    # ── logs: outcomes, arguments, error history ────────────────────────────
    log_calls: Counter[str] = Counter()
    no_hit: Counter[str] = Counter()
    errors_in_window: Counter[str] = Counter()
    error_text: dict[str, Counter[str]] = defaultdict(Counter)
    error_days: dict[str, Counter[str]] = defaultdict(Counter)
    unknown_tools: dict[str, list[str]] = defaultdict(list)
    unknown_in_window: Counter[str] = Counter()
    args_by_call: dict[str, tuple[str, str]] = {}
    shell_commands: list[str] = []
    previews: Counter[str] = Counter()

    for when, message in iter_log_records():
        tool = field(message, "tool") or "?"
        if message.startswith("tool_error"):
            detail = message.split("error=", 1)[1] if "error=" in message else message
            error_days[tool][f"{when:%Y-%m-%d}"] += 1
            if when >= cutoff:
                errors_in_window[tool] += 1
                error_text[tool][detail[:110]] += 1
            if detail.startswith("Tool '") and "not found" in detail:
                unknown_tools[tool].append(f"{when:%Y-%m-%d}")
                if when >= cutoff:
                    unknown_in_window[tool] += 1
            continue
        if when < cutoff:
            continue
        if message.startswith("tool_start"):
            log_calls[tool] += 1
            call_id, raw = field(message, "id"), ""
            if "args=" in message:
                raw = message.split("args=", 1)[1]
            if call_id:
                args_by_call[call_id] = (tool, raw)
            if tool == "shell":
                shell_commands.append(shell_command(raw))
        elif message.startswith("tool_result_preview"):
            # Previews carry no call id, and parallel calls interleave, so pair
            # them by tool in aggregate rather than to a specific start.
            previews[tool] += 1
            body = message.split("result=", 1)[1] if "result=" in message else ""
            if not body.strip() or body.lstrip().startswith(NO_HIT_PREFIXES):
                no_hit[tool] += 1

    print(f"\n--- Outcome quality ({sum(log_calls.values())} calls with logs) ---")
    print("no-hit rate is over previewed results, not starts (errors emit no preview)")
    header = (
        f"{'tool':24}{'calls':>7}{'previews':>10}{'no-hit':>8}{'rate':>7}"
        f"{'errors':>8}{'rate':>7}"
    )
    print(header)
    print("-" * len(header))
    for tool, n in log_calls.most_common(args.top):
        seen = previews[tool]
        print(
            f"{tool:24}{n:>7}{seen:>10}{no_hit[tool]:>8}"
            f"{100 * no_hit[tool] / seen if seen else 0:>6.0f}%"
            f"{errors_in_window[tool]:>8}{100 * errors_in_window[tool] / n:>6.0f}%"
        )

    print("\n--- Live errors in window ---")
    for tool, counter in sorted(
        error_text.items(), key=lambda kv: -sum(kv[1].values())
    ):
        print(f"  {tool} ({sum(counter.values())}):")
        for detail, n in counter.most_common(3):
            print(f"      x{n}: {detail}")

    # The guard: a tool whose errors stopped weeks ago is already fixed.
    print("\n--- Fixed or live? (error dates span the whole retention) ---")
    header = f"{'tool':24}{'errors_total':>13}{'in_window':>11}  first..last"
    print(header)
    print("-" * (len(header) + 12))
    for tool, days in sorted(error_days.items(), key=lambda kv: -sum(kv[1].values())):
        recent = errors_in_window[tool]
        verdict = "LIVE" if recent else "stale"
        print(
            f"{tool:24}{sum(days.values()):>13}{recent:>11}  "
            f"{min(days)}..{max(days)}  {verdict}"
        )

    if unknown_tools:
        print("\n--- Unknown tool names the model tried (wasted round-trips) ---")
        for tool, days in sorted(unknown_tools.items(), key=lambda kv: -len(kv[1])):
            recent = unknown_in_window[tool]
            verdict = f"LIVE x{recent} in window" if recent else "stale"
            print(f"  {tool:32} x{len(days):<4} {min(days)}..{max(days)}  {verdict}")

    # ── redundant work, attributed per run ──────────────────────────────────
    per_run: dict[str, Counter[tuple[str, str]]] = defaultdict(Counter)
    for call_id, (tool, raw) in args_by_call.items():
        run = run_of_call.get(call_id)
        if run:
            per_run[run][(tool, raw)] += 1

    redundant: Counter[str] = Counter()
    attributed: Counter[str] = Counter()
    worst: list[tuple[int, str, str]] = []
    for counter in per_run.values():
        for (tool, raw), n in counter.items():
            attributed[tool] += n
            if n > 1:
                redundant[tool] += n - 1
                worst.append((n, tool, raw[:90]))

    print("\n--- Repeated identical calls within one run ---")
    if not redundant:
        print("  none")
    for tool, n in redundant.most_common(10):
        print(
            f"  {tool:24}{n:>5} of {attributed[tool]:>5} calls ({100 * n / attributed[tool]:.0f}%)"
        )
    for n, tool, raw in sorted(worst, reverse=True)[:5]:
        print(f"      x{n} {tool}: {raw}")

    # ── what shell is standing in for ───────────────────────────────────────
    if shell_commands:
        classes: Counter[str] = Counter()
        for command in shell_commands:
            classes[classify_shell(command)] += 1
        chained = sum(1 for c in shell_commands if re.search(r"&&|\|\||;|\|", c))
        print(f"\n--- What {len(shell_commands)} shell calls are used for ---")
        for label, n in classes.most_common():
            print(f"  {label:36}{n:>6}{100 * n / len(shell_commands):>6.0f}%")
        print(
            f"\n  chained or piped: {chained} ({100 * chained / len(shell_commands):.0f}%)"
            "  <- high means shell is winning on round-trips, not capability"
        )


if __name__ == "__main__":
    main()
