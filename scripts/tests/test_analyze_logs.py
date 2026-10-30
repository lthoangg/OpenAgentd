"""``analyze_logs.py`` counts what the Rust server logs, once per record."""

from __future__ import annotations

import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path

_SCRIPT = (
    Path(__file__).resolve().parents[2]
    / ".agents/skills/oad/debug/scripts/analyze_logs.py"
)
_spec = importlib.util.spec_from_file_location("analyze_logs", _SCRIPT)
assert _spec is not None and _spec.loader is not None
analyze_logs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(analyze_logs)

NOW = datetime(2026, 10, 30, 12, 0, tzinfo=timezone.utc)


def _line(level: str, message: str, ts: float = NOW.timestamp() - 60) -> str:
    no = {"DEBUG": 10, "INFO": 20, "WARNING": 30, "ERROR": 40}[level]
    record = {
        "level": {"name": level, "no": no},
        "message": message,
        "name": "appv3_agent.snapshot",
        "function": "<module>",
        "exception": None,
        "time": {"timestamp": ts},
    }
    return json.dumps({"text": message, "record": record}) + "\n"


def _write(path: Path, *lines: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(lines), encoding="utf-8")


def test_warnings_are_counted_by_default(tmp_path):
    _write(
        tmp_path / "app" / "app.log",
        _line("WARNING", "snapshot_repack_failed gitdir=/a"),
        _line("INFO", "agent_run_done"),
    )
    files, groups = analyze_logs.analyze([tmp_path], days=7, min_level=30, now=NOW)
    assert files == 1
    assert [len(items) for items in groups.values()] == [1]


def test_error_log_copy_is_not_counted_twice(tmp_path):
    err = _line("ERROR", "agent_session_error name=code")
    _write(tmp_path / "app" / "app.log", err)
    _write(tmp_path / "app" / "app-error.log", err)
    files, groups = analyze_logs.analyze([tmp_path], days=7, min_level=30, now=NOW)
    assert files == 1
    assert sum(len(items) for items in groups.values()) == 1


def test_ids_numbers_and_paths_group_together(tmp_path):
    _write(
        tmp_path / "app" / "app.log",
        _line(
            "WARNING",
            "agent_empty_response_retry session=00000000-0000-7000-8000-000000000001 iteration=2 elapsed=5.31s",
        ),
        _line(
            "WARNING",
            "agent_empty_response_retry session=00000000-0000-7000-8000-000000000002 iteration=4 elapsed=9.06s",
        ),
    )
    _, groups = analyze_logs.analyze([tmp_path], days=7, min_level=30, now=NOW)
    assert [len(items) for items in groups.values()] == [2]


def test_records_before_the_window_are_skipped(tmp_path):
    old = NOW.timestamp() - 10 * 86_400
    _write(tmp_path / "app" / "app.log", _line("ERROR", "old_failure", ts=old))
    _, groups = analyze_logs.analyze([tmp_path], days=7, min_level=30, now=NOW)
    assert groups == {}
