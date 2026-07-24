#!/usr/bin/env python3
"""Query OpenAgentd OpenTelemetry (OTEL) span telemetry via DuckDB.

Usage:
    uv run python .openagentd/skills/oad/debug-prod/scripts/query_otel.py [--days N]
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
from pathlib import Path

import duckdb


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Query OpenAgentd OTEL spans using DuckDB."
    )
    parser.add_argument(
        "--days",
        type=int,
        default=7,
        help="Number of lookback days to query (default: 7)",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    window_start = datetime.now(timezone.utc) - timedelta(days=args.days)
    cutoff_key = window_start.strftime("%Y-%m-%d-%H")
    start_ns = int(window_start.timestamp() * 1e9)

    spans_dirs = [
        Path.home() / ".local/state/openagentd/otel/spans",
        Path(".openagentd/dev/state/otel/spans"),
    ]

    files: list[str] = []
    for sd in spans_dirs:
        if sd.exists():
            for p in sd.glob("*.jsonl"):
                if p.stem >= cutoff_key:
                    files.append(str(p))

    print(
        f"=== OpenAgentd OTEL Telemetry Query (Last {args.days} Days: Cutoff {window_start.strftime('%Y-%m-%d %H:%M UTC')}) ==="
    )
    print(f"Found {len(files)} candidate span files.")

    if not files:
        print("No telemetry files found for window.")
        return

    con = duckdb.connect(":memory:")
    escaped_files = ", ".join(f"'{f}'" for f in files)

    # 1. Aggregate Totals
    totals = con.execute(
        f"""
        SELECT
            count(*) as total_spans,
            count_if(status = 'ERROR') as error_spans,
            count_if(name LIKE 'agent_run%') as agent_runs,
            count_if(name LIKE 'chat%') as chat_calls,
            count_if(name LIKE 'execute_tool%') as tool_calls
        FROM read_json([{escaped_files}], union_by_name=true)
        WHERE end_time >= {start_ns}
    """
    ).fetchone()

    if totals:
        print(
            f"Total Spans: {totals[0]} | Errors: {totals[1]} | Turns: {totals[2]} | Chat Calls: {totals[3]} | Tool Calls: {totals[4]}"
        )

    # 2. Detailed Error Spans
    err_spans = con.execute(
        f"""
        SELECT
            name,
            attributes['error.type'] as error_type,
            attributes['gen_ai.provider.name'] as provider,
            attributes['gen_ai.request.model'] as model,
            events
        FROM read_json([{escaped_files}], union_by_name=true)
        WHERE status = 'ERROR'
          AND end_time >= {start_ns}
    """
    ).fetchall()

    print(f"\n--- Error Spans ({len(err_spans)}) ---")
    for idx, (name, err_type, provider, model, evts) in enumerate(err_spans, 1):
        print(
            f"[{idx:>2}] {name:<45} | ErrType: {str(err_type):<22} | Provider: {str(provider):<8} | Model: {str(model)}"
        )
        if evts:
            for e in evts:
                e_attr = e.get("attributes", {})
                exc_type = e_attr.get("exception.type")
                exc_msg = e_attr.get("exception.message")
                if exc_type or exc_msg:
                    print(f"     Exception: {exc_type} -> {exc_msg}")
        print("-" * 80)


if __name__ == "__main__":
    main()
