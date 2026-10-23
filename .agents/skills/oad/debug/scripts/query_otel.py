#!/usr/bin/env python3
"""Query OpenAgentd OpenTelemetry (OTEL) span telemetry.

Usage:
    python3 .agents/skills/oad/debug/scripts/query_otel.py [--days N]
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
    chats: list[tuple[int, dict]] = []

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
                            chats.append((int(s.get("start_time") or 0), s.get("attributes") or {}))
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

    report_cache_busts(chats)


def report_cache_busts(chats: list[tuple[int, dict]]) -> None:
    """Calls that re-wrote a cache the previous call of the same agent had built.

    A bust: a large prompt (>20k tokens) read less than half of the previous
    call's prompt from cache within 5 minutes (the default cache TTL). The
    cause comes from `openagentd.request.prefix_change` (tools, system,
    messages@N); spans written before that attribute existed show `unknown`.
    """
    chats.sort(key=lambda c: c[0])
    prev: dict[tuple, tuple[int, int]] = {}
    busts: list[tuple[str, int, float, str]] = []
    for start, a in chats:
        key = (a.get("gen_ai.conversation.id"), a.get("gen_ai.agent.name"))
        inp = int(a.get("gen_ai.usage.input_tokens") or 0)
        read = int(a.get("gen_ai.usage.cache_read.input_tokens") or 0)
        p = prev.get(key)
        prev[key] = (start, inp)
        if not p or inp <= 20_000 or start - p[0] > 300e9 or read >= 0.5 * p[1]:
            continue
        if inp < 0.5 * p[1]:
            cause = "summarized"  # the prompt shrank: a compaction, expected
        else:
            cause = str(a.get("openagentd.request.prefix_change") or "unknown")
        busts.append((str(a.get("gen_ai.request.model")), inp, float(a.get("gen_ai.usage.estimated_cost_usd") or 0), cause))
    print(f"\n--- Prompt-cache busts ({len(busts)}, ${sum(b[2] for b in busts):.2f}) ---")
    by_cause: dict[str, list] = {}
    for b in busts:
        cause = b[3].split("@")[0] if b[3].startswith("messages@") else b[3]
        by_cause.setdefault(cause, []).append(b)
    for cause, items in sorted(by_cause.items(), key=lambda kv: -len(kv[1])):
        print(f"  {cause:<24} x{len(items):<4} ${sum(i[2] for i in items):7.2f}  avg prompt {sum(i[1] for i in items) / len(items) / 1000:.0f}k")


if __name__ == "__main__":
    main()
