#!/usr/bin/env python3
"""Analyze OpenAgentd production loguru JSON log files.

Usage:
    uv run python .openagentd/skills/oad/debug-prod/scripts/analyze_logs.py [--days N]
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Analyze OpenAgentd loguru JSON logs over a lookback window."
    )
    parser.add_argument(
        "--days",
        type=int,
        default=7,
        help="Number of lookback days to analyze (default: 7)",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    cutoff = datetime.now(timezone.utc) - timedelta(days=args.days)

    log_dirs = [
        Path.home() / ".local/state/openagentd/logs",
        Path(".openagentd/dev/state/logs"),
    ]

    all_errors: list[dict] = []
    log_file_count = 0

    for ld in log_dirs:
        if not ld.exists():
            continue
        for lf in ld.rglob("*.log*"):
            if not lf.is_file():
                continue
            log_file_count += 1
            with open(lf, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    line_str = line.strip()
                    if not line_str.startswith("{"):
                        continue
                    try:
                        data = json.loads(line_str)
                        rec = data.get("record", {})
                        lvl = rec.get("level", {}).get("name", "")
                        ts = rec.get("time", {}).get("timestamp", 0)
                        dt = (
                            datetime.fromtimestamp(ts, tz=timezone.utc)
                            if ts
                            else None
                        )
                        if dt and dt < cutoff:
                            continue
                        if lvl in ("ERROR", "CRITICAL"):
                            exc = rec.get("exception", {})
                            all_errors.append(
                                {
                                    "dt": str(dt),
                                    "mod": rec.get("name", ""),
                                    "func": rec.get("function", ""),
                                    "msg": rec.get("message", ""),
                                    "exc_type": exc.get("type") if exc else None,
                                    "exc_value": exc.get("value") if exc else None,
                                    "file": lf.name,
                                }
                            )
                    except Exception:
                        pass

    groups: dict[tuple, list] = defaultdict(list)
    for err in all_errors:
        exc = err["exc_type"] or "NoExc"
        mod = err["mod"] or "NoMod"
        key = (exc, mod, err["msg"][:120])
        groups[key].append(err)

    print(
        f"=== OpenAgentd Log Analysis (Last {args.days} Days: Cutoff {cutoff.strftime('%Y-%m-%d %H:%M UTC')}) ==="
    )
    print(f"Scanned {log_file_count} log files.")
    print(
        f"Total Errors: {len(all_errors)} | Distinct Error Categories: {len(groups)}\n"
    )

    for (exc, mod, msg_pattern), items in sorted(
        groups.items(), key=lambda x: len(x[1]), reverse=True
    ):
        print(
            f"Count: {len(items):>4} | Exc: {exc:<25} | Mod: {mod:<35} | Msg: {msg_pattern}"
        )
        sample = items[0]
        if sample.get("exc_value"):
            print(f"       Sample Value: {sample['exc_value'][:180]}")
        print("-" * 80)


if __name__ == "__main__":
    main()
