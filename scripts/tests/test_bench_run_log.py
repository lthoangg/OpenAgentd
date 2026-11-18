"""``scripts/bench/run_log.py`` totals an ``agentd run --json`` log."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parents[1] / "bench/run_log.py"
_spec = importlib.util.spec_from_file_location("run_log", _SCRIPT)
assert _spec and _spec.loader
run_log = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(run_log)


def _log(tmp_path: Path, lines: list) -> Path:
    path = tmp_path / "openagentd.jsonl"
    path.write_text("\n".join(line if isinstance(line, str) else json.dumps(line) for line in lines) + "\n", encoding="utf-8")
    return path


def _usage(prompt: int, completion: int, cached: int | None, cost: float | None) -> dict:
    return {"event": "usage", "data": {"type": "usage", "prompt_tokens": prompt, "completion_tokens": completion, "cached_tokens": cached, "estimated_cost_usd": cost}}


def test_usage_events_are_summed(tmp_path: Path) -> None:
    path = _log(
        tmp_path,
        [
            {"event": "session", "data": {"session_id": "abc"}},
            _usage(1000, 50, 800, 0.01),
            {"event": "message", "data": {"text": "hi"}},
            _usage(2000, 70, None, 0.02),
        ],
    )
    totals = run_log.summarize(path)
    assert totals["input_tokens"] == 3000
    assert totals["cached_tokens"] == 800
    assert totals["output_tokens"] == 120
    assert totals["model_calls"] == 2
    assert abs(totals["cost_usd"] - 0.03) < 1e-9
    assert totals["error"] is None


def test_cost_stays_unknown_without_an_estimate(tmp_path: Path) -> None:
    assert run_log.summarize(_log(tmp_path, [_usage(10, 5, None, None)]))["cost_usd"] is None


def test_the_last_error_is_kept_and_other_lines_are_skipped(tmp_path: Path) -> None:
    path = _log(
        tmp_path,
        [
            "not json",
            {"event": "x", "data": "a string"},
            {"event": "error", "data": {"code": "first"}},
            {"event": "error", "data": {"title": "Usage limit reached", "code": "usage_limit"}},
        ],
    )
    totals = run_log.summarize(path)
    assert totals["error"] == "Usage limit reached"
    assert totals["model_calls"] == 0
