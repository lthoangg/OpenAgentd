#!/usr/bin/env python3
"""Query OpenAgentd OpenTelemetry (OTEL) span telemetry.

Usage:
    uv run python .openagentd/skills/oad/debug-prod/scripts/query_otel.py [--days N]
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    import orjson
    def _parse_json(b: bytes) -> dict: return orjson.loads(b)
except ImportError:
    import json
    def _parse_json(b: bytes) -> dict: return json.loads(b.decode("utf-8"))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Query OpenAgentd OTEL spans.")
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





    total_spans = 0
    error_spans = 0
    agent_runs = 0
    chat_calls = 0
    tool_calls = 0
    err_list = []

    for filepath in files:
        try:
            with open(filepath, "rb") as fp:
                for line in fp:
                    if not line.strip():
                        continue
                    try:
                        s = _parse_json(line)
                    except Exception:
                        continue
                    et = s.get("end_time")
                    if et is not None and et >= start_ns:
                        total_spans += 1
                        name = str(s.get("name") or "")
                        status = s.get("status")
                        if status == "ERROR":
                            error_spans += 1
                            attrs = s.get("attributes") or {}
                            err_list.append((
                                name,
                                attrs.get("error.type"),
                                attrs.get("gen_ai.provider.name"),
                                attrs.get("gen_ai.request.model"),
                                s.get("events"),
                            ))
                        if name.startswith("agent_run"):
                            agent_runs += 1
                        elif name.startswith("chat"):
                            chat_calls += 1
                        elif name.startswith("execute_tool"):
                            tool_calls += 1
        except OSError:
            continue

    print(
        f"Total Spans: {total_spans} | Errors: {error_spans} | Turns: {agent_runs} | Chat Calls: {chat_calls} | Tool Calls: {tool_calls}"
    )

    print(f"\n--- Error Spans ({len(err_list)}) ---")
    for idx, (name, err_type, provider, model, evts) in enumerate(err_list, 1):
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
