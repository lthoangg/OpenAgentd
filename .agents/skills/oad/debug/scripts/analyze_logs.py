#!/usr/bin/env python3
"""Analyze OpenAgentd production loguru JSON log files.

Groups WARNING and above (the Rust server logs most problems as warnings)
by message shape: ids, numbers and paths are masked so repeats of one
problem land in one group.

Usage:
    python3 .agents/skills/oad/debug/scripts/analyze_logs.py [--days N]
        [--level WARNING|ERROR|INFO] [--log-dir DIR ...]
"""

from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

LEVELS = {"DEBUG": 10, "INFO": 20, "WARNING": 30, "ERROR": 40, "CRITICAL": 50}
DEFAULT_DIRS = [
    Path.home() / ".local/state/openagentd/logs",
    Path(".openagentd/dev/state/logs"),
]

_MASKS = [
    (re.compile(r"[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}", re.I), "<id>"),
    (re.compile(r"\b[0-9a-f]{16,}\b", re.I), "<hex>"),
    (re.compile(r"(?<![\w.])(?:/[\w.@+-]+){2,}/?"), "<path>"),
    (re.compile(r"\d+(?:\.\d+)?"), "<n>"),
]


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
    parser.add_argument(
        "--level",
        choices=list(LEVELS),
        default="WARNING",
        help="Lowest level to count (default: WARNING)",
    )
    parser.add_argument(
        "--log-dir",
        action="append",
        type=Path,
        help="Log directory to scan, repeatable (default: prod and dev logs)",
    )
    return parser.parse_args()


def shape(message: str) -> str:
    """The message with ids, numbers and paths masked, first line only."""
    first = message.strip().splitlines()[0] if message.strip() else ""
    for rx, repl in _MASKS:
        first = rx.sub(repl, first)
    return first[:140]


def log_files(log_dirs: list[Path]) -> list[Path]:
    """Every log file, minus ``app-error.log*`` beside an ``app.log``: the
    error sink repeats the ERROR records the main sink already holds."""
    files: list[Path] = []
    for ld in log_dirs:
        if not ld.exists():
            continue
        for lf in sorted(ld.rglob("*.log*")):
            if not lf.is_file():
                continue
            if lf.name.startswith("app-error.log") and (lf.parent / "app.log").exists():
                continue
            files.append(lf)
    return files


def analyze(
    log_dirs: list[Path], days: int, min_level: int, now: datetime
) -> tuple[int, dict[tuple[str, str, str], list[dict]]]:
    """``(files scanned, {(level, module, shape): [records]})``."""
    cutoff = now - timedelta(days=days)
    files = log_files(log_dirs)
    groups: dict[tuple[str, str, str], list[dict]] = defaultdict(list)
    for lf in files:
        with open(lf, encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if not line.startswith("{"):
                    continue
                try:
                    rec = json.loads(line).get("record", {})
                except json.JSONDecodeError:
                    continue
                level = rec.get("level", {}) or {}
                no = level.get("no") or LEVELS.get(level.get("name", ""), 0)
                if no < min_level:
                    continue
                ts = (rec.get("time", {}) or {}).get("timestamp")
                dt = datetime.fromtimestamp(ts, tz=timezone.utc) if ts else None
                if dt is None or dt < cutoff:
                    continue
                msg = rec.get("message", "") or ""
                exc = rec.get("exception") or {}
                key = (level.get("name", "?"), rec.get("name", "") or "?", shape(msg))
                groups[key].append(
                    {
                        "dt": dt,
                        "msg": msg,
                        "exc_type": exc.get("type") if isinstance(exc, dict) else None,
                        "exc_value": exc.get("value") if isinstance(exc, dict) else None,
                        "file": lf.name,
                    }
                )
    return len(files), dict(groups)


def main() -> None:
    args = parse_args()
    now = datetime.now(timezone.utc)
    files, groups = analyze(
        args.log_dir or DEFAULT_DIRS, args.days, LEVELS[args.level], now
    )
    cutoff = now - timedelta(days=args.days)
    total = sum(len(v) for v in groups.values())
    print(
        f"=== OpenAgentd Log Analysis (Last {args.days} Days, >= {args.level}: "
        f"Cutoff {cutoff.strftime('%Y-%m-%d %H:%M UTC')}) ==="
    )
    print(f"Scanned {files} log files.")
    print(f"Total records: {total} | Distinct shapes: {len(groups)}\n")
    for (level, mod, pattern), items in sorted(
        groups.items(), key=lambda kv: len(kv[1]), reverse=True
    ):
        last = max(i["dt"] for i in items).strftime("%m-%d %H:%M")
        print(f"Count: {len(items):>5} | {level:<8} | last {last} | {mod}")
        print(f"       {pattern}")
        sample = items[0]
        if sample.get("exc_value"):
            print(f"       Exception: {sample['exc_type']}: {sample['exc_value'][:180]}")
        else:
            print(f"       Sample: {sample['msg'][:200]!r}")
        print("-" * 80)


if __name__ == "__main__":
    main()
