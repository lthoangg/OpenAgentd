#!/usr/bin/env python3
"""Audit which tools earn their keep: volume, latency, outcome quality, waste.

Usage:
    python3 .agents/skills/oad/debug/scripts/tool_usage.py [--days N]

Answers "is any tool underused, slow, or not useful?" by combining two sources:

  * OTEL spans  — call counts, durations, result sizes, run ids.
  * loguru logs — the arguments and the actual result text, which is what says
    whether a *successful* call was useful ("No matches" is a green span and a
    wasted turn).

Plain stdlib json: this script joins spans to logs by tool-call id and
classifies shell commands by regex. v3 logs no ``tool_result_preview``
records, so the no-hit columns only fill from older v2 logs.

Four traps this encodes, learned by falling into them:

1. **Never divide errors by calls across different windows.** ``tool_error``
   records survive longer than ``tool_start`` records, so a bug fixed weeks
   earlier can read as a tool that still fails much of the time. The
   FIXED-OR-LIVE section exists to catch that: it prints each tool's error dates
   so a historical problem cannot pose as a live one.
2. **Redundant work is only redundant within a run.** Counting identical calls
   across all sessions turns legitimate reuse (loading a skill in a new session)
   into fake waste, so duplicates are attributed per ``run_id``.
3. **Logged arguments are truncated at 500 chars** (``tool_start`` in
   ``appv3/crates/tools/src/lib.rs``), so
   ``json.loads`` on them fails for precisely the long shell calls (heredocs,
   inline python). Dropping the unparseable ones inflates "shell is used to
   read files", because short ``cat``/``head`` calls always parse. Never parse
   those args strictly; degrade to a regex.
4. **A call a ``script`` makes is not context.** It has its own span, but its
   result goes to the script, never to the model, and is not offloaded.
   Summing every span's result counts, as "into context", output that never
   reached a model. A span whose parent is a tool span is counted apart
   (``nested_MB``).
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from collections.abc import Sequence
from datetime import datetime, timedelta, timezone
from pathlib import Path

STATE_DIRS = [
    Path.home() / ".local/state/openagentd",
    Path(".openagentd/dev/state"),
]
# Loggers that write ``tool_start`` / ``tool_error`` records: the v3 tools
# crate (module path ``appv3_tools``), then the v2 Python executor for old logs.
TOOL_LOGGERS = ("appv3_tools", "app.agent.agent_loop.tool_executor")
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


def pct(values: Sequence[float], p: int) -> float:
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
                    if not any(name in line for name in TOOL_LOGGERS):
                        continue
                    try:
                        rec = json.loads(line)["record"]
                    except Exception:
                        continue
                    if not rec.get("name", "").startswith(TOOL_LOGGERS):
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
    commands. Fall back to slicing after the ``"command":`` key.
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


class SpanStats:
    """Per-tool volume from ``execute_tool`` spans in the window."""

    def __init__(self) -> None:
        self.calls: Counter[str] = Counter()
        self.durations: dict[str, list[float]] = {}
        # Result sizes (characters) of calls the model made, and of calls a
        # tool made (a ``script``): only the first reach a model.
        self.direct: dict[str, list[int]] = {}
        self.nested: dict[str, list[int]] = {}
        self.run_of_call: dict[str, str] = {}
        self.runs: set[str] = set()

    def context_chars(self) -> int:
        return sum(sum(sizes) for sizes in self.direct.values())

    def nested_chars(self) -> int:
        return sum(sum(sizes) for sizes in self.nested.values())


def span_stats(paths: list[Path], cutoff: datetime) -> SpanStats:
    stats = SpanStats()
    # Every tool span's id, whatever its age: a call in the window may belong
    # to a script that started before it, and a child is written before its
    # parent (a span is written when it ends).
    tool_span_ids: set[str] = set()
    in_window: list[dict] = []
    for path in paths:
        with path.open(errors="ignore") as handle:
            for line in handle:
                try:
                    span = json.loads(line)
                except Exception:
                    continue
                if not span.get("name", "").startswith("execute_tool"):
                    continue
                tool_span_ids.add(span.get("span_id"))
                if datetime.fromtimestamp(span["start_time"] / 1e9, timezone.utc) >= cutoff:
                    in_window.append(span)
    for span in in_window:
        attrs = span.get("attributes", {})
        tool = attrs.get("gen_ai.tool.name", "?")
        stats.calls[tool] += 1
        stats.durations.setdefault(tool, []).append(span.get("duration_ms") or 0.0)
        if isinstance(attrs.get("tool.result.length"), int):
            sizes = stats.nested if span.get("parent_id") in tool_span_ids else stats.direct
            sizes.setdefault(tool, []).append(attrs["tool.result.length"])
        run = attrs.get("run_id")
        if run:
            stats.runs.add(run)
            if attrs.get("gen_ai.tool.call.id"):
                stats.run_of_call[attrs["gen_ai.tool.call.id"]] = run
    return stats


def print_volume(stats: SpanStats, top: int) -> None:
    total = sum(stats.calls.values())
    print(f"\n--- Volume & cost ({total} calls, {len(stats.runs)} runs) ---")
    print("res_* and ctx_MB: results the model read; nested_MB: results a script's own calls returned to it")
    header = (
        f"{'tool':24}{'calls':>7}{'share':>7}{'p50ms':>8}{'p95ms':>9}"
        f"{'max_s':>8}{'res_p50':>9}{'res_p95':>9}{'ctx_MB':>8}{'nested_MB':>11}"
    )
    print(header)
    print("-" * len(header))
    for tool, n in stats.calls.most_common(top):
        durations = stats.durations[tool]
        direct = stats.direct.get(tool, [])
        print(
            f"{tool:24}{n:>7}{100 * n / total:>6.1f}%{pct(durations, 50):>8.0f}"
            f"{pct(durations, 95):>9.0f}{max(durations) / 1000:>8.1f}"
            f"{pct(direct, 50):>9.0f}{pct(direct, 95):>9.0f}"
            f"{sum(direct) / 1e6:>8.1f}{sum(stats.nested.get(tool, [])) / 1e6:>11.1f}"
        )
    print(
        f"\ntotal tool output into context: {stats.context_chars() / 1e6:.1f} MB"
        f" ({stats.nested_chars() / 1e6:.1f} MB more went to scripts that called tools, not to a model)"
    )


def main() -> None:
    args = parse_args()
    cutoff = datetime.now(timezone.utc) - timedelta(days=args.days)
    print(
        f"=== Tool Usage Audit (last {args.days}d, cutoff "
        f"{cutoff:%Y-%m-%d %H:%M UTC}) ==="
    )

    # ── spans: volume, latency, result size ─────────────────────────────────
    stats = span_stats(list(iter_span_files()), cutoff)
    run_of_call = stats.run_of_call
    if not stats.calls:
        print("No tool spans in window.")
        return
    print_volume(stats, args.top)

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
