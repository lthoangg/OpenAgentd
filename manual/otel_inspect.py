"""Inspect OTel spans and metrics from the OTel JSONL output directory.

Reads span/metric partition files written by the OTel exporter and prints
them in a human-readable format.  No server needed — reads files directly.

Default location follows XDG_STATE_HOME:
  - development : ``.openagentd/dev/state/otel/``  (default)
  - production  : ``~/.local/state/openagentd/otel/``
Override with ``OPENAGENTD_STATE_DIR``, ``--env production``, or pass
``--spans`` / ``--metrics-file`` directly.

Usage:
  uv run python -m manual.otel_inspect                          # last 20 spans
  uv run python -m manual.otel_inspect --env production        # production state dir
  uv run python -m manual.otel_inspect --limit 50              # last 50 spans
  uv run python -m manual.otel_inspect --session SESSION_ID    # filter by session
  uv run python -m manual.otel_inspect --agent researcher      # filter by agent name
  uv run python -m manual.otel_inspect --trace TRACE_ID        # full trace tree
  uv run python -m manual.otel_inspect --op chat               # only LLM call spans
  uv run python -m manual.otel_inspect --metrics               # metrics summary
  uv run python -m manual.otel_inspect --summary               # duration breakdown by operation
  uv run python -m manual.otel_inspect --spans path/to/spans.jsonl
"""

from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
from typing import Any

from manual._common import add_env_argument, apply_env_override

# ── Defaults ──────────────────────────────────────────────────────────────────


def _default_state_dir() -> Path:
    """Resolve the OTel state directory without booting full settings."""
    env = os.getenv("OPENAGENTD_STATE_DIR")
    if env:
        return Path(env)
    if os.getenv("APP_ENV", "development") == "production":
        return Path.home() / ".local" / "state" / "openagentd"
    return Path(".openagentd") / "dev" / "state"


# ── Helpers ───────────────────────────────────────────────────────────────────


def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    records = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return records


def _load_span_records(path: Path) -> list[dict[str, Any]]:
    """Load either a legacy JSONL file or the current partitioned span directory."""
    if path.is_dir():
        return [
            record
            for partition in sorted(path.glob("*.jsonl"))
            for record in _load_jsonl(partition)
        ]
    return _load_jsonl(path)


def _short_id(hex_id: str | None, length: int = 12) -> str:
    if not hex_id:
        return "none"
    # Me strip 0x prefix then shorten
    raw = hex_id.lstrip("0x").lstrip("0")
    return raw[:length] if raw else "0"


def _duration_str(ms: float | None) -> str:
    if ms is None:
        return "?"
    if ms < 1000:
        return f"{ms:.1f}ms"
    return f"{ms / 1000:.2f}s"


def _status_icon(status: str) -> str:
    return "✓" if status == "OK" else "✗"


def _indent_tree(spans: list[dict], span: dict, depth: int = 0) -> list[str]:
    """Recursively build tree lines for a span and its children."""
    sid = span.get("span_id")
    prefix = "  " * depth + ("└── " if depth > 0 else "")
    attrs = span.get("attributes", {})

    # Me build compact attribute summary
    attr_parts = []
    for key in (
        "gen_ai.agent.name",
        "gen_ai.request.model",
        "gen_ai.response.model",
        "gen_ai.conversation.id",
        "run_id",
        "gen_ai.usage.input_tokens",
        "gen_ai.usage.output_tokens",
        "gen_ai.tool.name",
        "error.type",
    ):
        if key in attrs:
            short_key = key.split(".")[-1]
            attr_parts.append(f"{short_key}={attrs[key]}")

    status = span.get("status", "?")
    icon = _status_icon(status)
    dur = _duration_str(span.get("duration_ms"))
    attr_str = "  " + "  ".join(attr_parts) if attr_parts else ""

    lines = [f"{prefix}{icon} {span['name']}  [{dur}]{attr_str}"]

    # Me find direct children
    children = [s for s in spans if s.get("parent_id") == sid]
    for child in children:
        lines.extend(_indent_tree(spans, child, depth + 1))

    return lines


# ── Span display ──────────────────────────────────────────────────────────────


def print_spans(
    spans: list[dict],
    *,
    session: str | None,
    agent: str | None,
    trace_id: str | None,
    op: str | None,
    limit: int,
) -> None:
    # Me apply filters
    filtered = spans

    if session:
        filtered = [
            s
            for s in filtered
            if s.get("attributes", {})
            .get("gen_ai.conversation.id", "")
            .startswith(session)
        ]
    if agent:
        filtered = [
            s
            for s in filtered
            if s.get("attributes", {}).get("gen_ai.agent.name", "") == agent
        ]
    if trace_id:
        filtered = [
            s
            for s in filtered
            if (s.get("trace_id") or "").lstrip("0x").startswith(trace_id.lstrip("0x"))
        ]
    if op:
        filtered = [
            s
            for s in filtered
            if s.get("attributes", {}).get("gen_ai.operation.name", "") == op
            or op in s.get("name", "")
        ]

    if not filtered:
        print("no spans matched filters")
        return

    # Me group by trace for tree view when trace_id is specified, else flat list
    if trace_id:
        _print_trace_tree(filtered)
        return

    # Me flat list — newest last, capped at limit
    recent = filtered[-limit:]
    print(f"spans ({len(recent)} of {len(filtered)} matched)\n{'─' * 60}")
    for span in recent:
        attrs = span.get("attributes", {})
        tid = _short_id(span.get("trace_id"), 16)
        sid = _short_id(span.get("span_id"), 12)
        pid = _short_id(span.get("parent_id"), 12)
        dur = _duration_str(span.get("duration_ms"))
        status = span.get("status", "?")
        icon = _status_icon(status)

        print(f"{icon} {span['name']}  [{dur}]")
        print(f"   trace={tid}  span={sid}  parent={pid}")

        # Me print relevant attributes
        for key, val in attrs.items():
            print(f"   {key}: {val}")

        if span.get("events"):
            for ev in span["events"]:
                print(f"   event: {ev['name']}  {ev.get('attributes', {})}")
        print()


def _print_trace_tree(spans: list[dict]) -> None:
    """Print spans as a nested tree grouped by trace_id."""
    # Me group by trace
    by_trace: dict[str, list[dict]] = {}
    for s in spans:
        tid = s.get("trace_id") or "unknown"
        by_trace.setdefault(tid, []).append(s)

    for tid, trace_spans in by_trace.items():
        roots = [s for s in trace_spans if not s.get("parent_id")]
        print(f"trace {_short_id(tid, 32)}\n{'─' * 60}")
        for root in roots:
            for line in _indent_tree(trace_spans, root):
                print(line)
        print()


# ── Metrics display ───────────────────────────────────────────────────────────


def print_metrics(metrics_records: list[dict]) -> None:
    if not metrics_records:
        print("no metrics found")
        return

    # Me collect all data_points across all records for summary
    totals: dict[str, dict] = {}  # metric_name → {attrs_key → {sum, count, min, max}}

    for record in metrics_records:
        for m in record.get("metrics", []):
            name = m.get("name", "?")
            # Me parse data string — it's repr() of OTel data object, not pure JSON
            # Just show raw summary line
            totals.setdefault(name, {"records": 0})
            totals[name]["records"] += 1

    print(f"metrics ({len(metrics_records)} export cycles)\n{'─' * 60}")

    # Me print last record in detail
    last = metrics_records[-1]
    print("latest export cycle:")
    for m in last.get("metrics", []):
        print(f"  {m['name']}  [{m.get('unit', '?')}]")
        if m.get("description"):
            print(f"    {m['description']}")

    print(f"\ntotal export cycles: {len(metrics_records)}")
    print("metric names seen:")
    for name, info in sorted(totals.items()):
        print(f"  {name}  ({info['records']} cycles)")


# ── Summary / duration breakdown ─────────────────────────────────────────────


def _stats(values: list[float]) -> dict:
    if not values:
        return {
            "count": 0,
            "min": 0.0,
            "max": 0.0,
            "avg": 0.0,
            "p50": 0.0,
            "p95": 0.0,
            "p99": 0.0,
            "total": 0.0,
        }
    s = sorted(values)
    n = len(s)
    return {
        "count": n,
        "min": s[0],
        "max": s[-1],
        "avg": sum(s) / n,
        "p50": s[int(n * 0.50)],
        "p95": s[min(int(n * 0.95), n - 1)],
        "p99": s[min(int(n * 0.99), n - 1)],
        "total": sum(s),
    }


def _fmt_ms(ms: float) -> str:
    if ms >= 1000:
        return f"{ms / 1000:.2f}s"
    return f"{ms:.1f}ms"


def print_summary(spans: list[dict], *, session: str | None, agent: str | None) -> None:
    """Print duration statistics grouped by operation (agent_run, chat model, tool name)."""
    filtered = spans

    if session:
        filtered = [
            s
            for s in filtered
            if s.get("attributes", {})
            .get("gen_ai.conversation.id", "")
            .startswith(session)
        ]
    if agent:
        filtered = [
            s
            for s in filtered
            if s.get("attributes", {}).get("gen_ai.agent.name", "") == agent
        ]

    if not filtered:
        print("no spans matched filters")
        return

    # Bucket durations by category
    buckets: dict[str, list[float]] = {}

    for span in filtered:
        dur = span.get("duration_ms")
        if dur is None:
            continue
        name: str = span.get("name", "")
        attrs = span.get("attributes", {})

        if name.startswith("agent_run"):
            key = f"[agent_run]  {attrs.get('gen_ai.agent.name', name)}"
        elif name.startswith("chat"):
            model = attrs.get("gen_ai.request.model") or re.sub(r"^chat\s+", "", name)
            provider = attrs.get("gen_ai.provider.name", "")
            key = (
                f"[llm]        {provider}/{model}"
                if provider
                else f"[llm]        {model}"
            )
        elif name.startswith("execute_tool"):
            tool = attrs.get("gen_ai.tool.name") or re.sub(
                r"^execute_tool\s+", "", name
            )
            key = f"[tool]       {tool}"
        elif name == "summarization":
            agent = attrs.get("gen_ai.agent.name", "")
            key = f"[summarize]  {agent}" if agent else "[summarize]  (unknown)"
        elif name == "summarization_llm_call":
            key = "[summarize]  (llm_call)"
        elif name == "title_generation":
            key = "[title_gen]  title_generation"
        else:
            key = f"[other]      {name}"

        buckets.setdefault(key, []).append(dur)

    if not buckets:
        print("no spans with duration found")
        return

    scope = ""
    if session:
        scope += f"  session={session}"
    if agent:
        scope += f"  agent={agent}"
    print(f"duration summary ({len(filtered)} spans){scope}\n{'─' * 90}")

    header = f"{'operation':<48}  {'n':>5}  {'avg':>8}  {'p50':>8}  {'p95':>8}  {'p99':>8}  {'max':>8}  {'total':>9}"
    print(header)
    print("─" * 90)

    # Sort: agent_run first, then llm, then tools, alphabetically within each
    def sort_key(k: str) -> tuple:
        if k.startswith("[agent_run]"):
            return (0, k)
        if k.startswith("[llm]"):
            return (1, k)
        if k.startswith("[tool]"):
            return (2, k)
        if k.startswith("[summarize]"):
            return (3, k)
        if k.startswith("[title_gen]"):
            return (4, k)
        return (5, k)

    for key in sorted(buckets, key=sort_key):
        st = _stats(buckets[key])
        label = key[:48]
        print(
            f"{label:<48}  {st['count']:>5}  "
            f"{_fmt_ms(st['avg']):>8}  {_fmt_ms(st['p50']):>8}  "
            f"{_fmt_ms(st['p95']):>8}  {_fmt_ms(st['p99']):>8}  "
            f"{_fmt_ms(st['max']):>8}  {_fmt_ms(st['total']):>9}"
        )

    print()

    # Overall totals per category group
    group_totals: dict[str, list[float]] = {}
    for key, vals in buckets.items():
        group = key.split("]")[0].strip("[")
        group_totals.setdefault(group, []).extend(vals)

    print("totals by category:")
    for group in ("agent_run", "llm", "tool", "summarize", "title_gen", "other"):
        if group not in group_totals:
            continue
        vals = group_totals[group]
        st = _stats(vals)
        print(
            f"  {group:<12}  count={st['count']:>5}  total={_fmt_ms(st['total']):>10}  avg={_fmt_ms(st['avg']):>8}"
        )


# ── Main ──────────────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Inspect OTel spans and metrics from the state directory"
    )
    add_env_argument(parser)
    # Two-pass: resolve --env before computing path defaults (which read APP_ENV).
    args, _ = parser.parse_known_args()
    apply_env_override(args)
    state_dir = _default_state_dir()
    default_spans = state_dir / "otel" / "spans"
    default_metrics = state_dir / "otel" / "metrics.jsonl"

    parser.add_argument(
        "--spans",
        type=Path,
        default=default_spans,
        help=f"spans JSONL file (default: {default_spans})",
    )
    parser.add_argument(
        "--metrics-file",
        type=Path,
        default=default_metrics,
        help=f"metrics JSONL file (default: {default_metrics})",
    )
    parser.add_argument(
        "--session", metavar="ID", help="filter spans by gen_ai.conversation.id prefix"
    )
    parser.add_argument(
        "--agent", metavar="NAME", help="filter spans by gen_ai.agent.name"
    )
    parser.add_argument(
        "--trace", metavar="TRACE_ID", help="show full trace tree for a trace_id prefix"
    )
    parser.add_argument(
        "--op",
        metavar="OP",
        help="filter by operation name or span name substring (chat, execute_tool, agent_run)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=20,
        help="max spans to show in flat view (default: 20)",
    )
    parser.add_argument(
        "--metrics", action="store_true", help="show metrics summary instead of spans"
    )
    parser.add_argument(
        "--summary",
        action="store_true",
        help="show duration breakdown table by operation/model/tool (combinable with --session, --agent)",
    )
    args = parser.parse_args()

    if args.metrics:
        records = _load_jsonl(args.metrics_file)
        print(f"metrics file: {args.metrics_file}\n")
        print_metrics(records)
        return

    spans = _load_span_records(args.spans)
    print(f"spans file: {args.spans}  ({len(spans)} total)\n")

    if args.summary:
        print_summary(spans, session=args.session, agent=args.agent)
        return

    print_spans(
        spans,
        session=args.session,
        agent=args.agent,
        trace_id=args.trace,
        op=args.op,
        limit=args.limit,
    )


if __name__ == "__main__":
    main()
