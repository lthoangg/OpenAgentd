"""Inspect the backend app log for recurring warnings/errors.

Reads the JSON log written to ``{STATE_DIR}/logs/app/app.log`` and prints a
compact summary of repeated warning/error messages plus sample records.

Usage:
  uv run python -m manual.backend_log
  uv run python -m manual.backend_log --env production
  uv run python -m manual.backend_log --level WARNING --limit 20
  uv run python -m manual.backend_log --contains drop_partial_tool_call_bad_json
  uv run python -m manual.backend_log --path /custom/app.log
"""

from __future__ import annotations

import argparse
import json
import os
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from manual._common import add_env_argument, apply_env_override

_LEVELS = ("WARNING", "ERROR", "CRITICAL")


def _default_log_path() -> Path:
    state_dir = os.getenv("OPENAGENTD_STATE_DIR")
    if state_dir:
        return Path(state_dir) / "logs" / "app" / "app.log"
    if os.getenv("APP_ENV", "development") == "production":
        return Path.home() / ".local" / "state" / "openagentd" / "logs" / "app" / "app.log"
    return Path(".openagentd") / "dev" / "state" / "logs" / "app" / "app.log"


def _iter_records(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    if not path.exists():
        return records
    with path.open(encoding="utf-8", errors="ignore") as fh:
        for raw in fh:
            raw = raw.strip()
            if not raw:
                continue
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                continue
            record = payload.get("record")
            if isinstance(record, dict):
                records.append(record)
    return records


def _sample_context(record: dict[str, Any]) -> str:
    pieces = [
        record.get("time", {}).get("repr"),
        record.get("name"),
        record.get("function"),
        str(record.get("line")) if record.get("line") is not None else None,
    ]
    return " | ".join(part for part in pieces if part)


def main() -> None:
    parser = argparse.ArgumentParser(description="Inspect repeated backend warnings/errors")
    add_env_argument(parser)
    # Parse --env first so apply_env_override can set APP_ENV before _default_log_path runs.
    args, remaining = parser.parse_known_args()
    apply_env_override(args)
    parser.add_argument("--path", type=Path, default=_default_log_path())
    parser.add_argument("--level", choices=_LEVELS, help="Only show one severity")
    parser.add_argument("--contains", help="Only include messages containing this substring")
    parser.add_argument("--limit", type=int, default=15, help="Max grouped messages to print")
    parser.add_argument(
        "--samples",
        type=int,
        default=3,
        help="Sample records to print for each grouped message",
    )
    args = parser.parse_args()

    records = _iter_records(args.path)
    if not records:
        print(f"No structured log records found in {args.path}")
        return

    grouped: Counter[tuple[str, str]] = Counter()
    samples: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)

    for record in records:
        level = ((record.get("level") or {}).get("name") or "").upper()
        if level not in _LEVELS:
            continue
        if args.level and level != args.level:
            continue
        message = record.get("message") or ""
        if args.contains and args.contains not in message:
            continue
        key = (level, message)
        grouped[key] += 1
        if len(samples[key]) < max(args.samples, 0):
            samples[key].append(record)

    if not grouped:
        suffix = f" containing {args.contains!r}" if args.contains else ""
        level = args.level or "/".join(_LEVELS)
        print(f"No {level} records found in {args.path}{suffix}")
        return

    print(f"log: {args.path}")
    print(f"grouped records: {len(grouped)}\n")

    for idx, ((level, message), count) in enumerate(grouped.most_common(args.limit), 1):
        print(f"{idx:>2}. [{level}] x{count} {message}")
        for sample in samples[(level, message)]:
            print(f"    - {_sample_context(sample)}")
        print()


if __name__ == "__main__":
    main()
