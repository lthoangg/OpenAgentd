"""``tool_usage.py`` keeps what the model read apart from what a script read."""

from __future__ import annotations

import importlib.util
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parents[2] / ".agents/skills/oad/debug/scripts/tool_usage.py"
_spec = importlib.util.spec_from_file_location("tool_usage", _SCRIPT)
assert _spec is not None and _spec.loader is not None
tool_usage = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tool_usage)

NOW = datetime(2026, 11, 24, 12, 0, tzinfo=timezone.utc)
CUTOFF = NOW - timedelta(days=7)


def _span(name: str, span_id: str, parent_id: str, length: int | None = None, *, at: datetime = NOW - timedelta(hours=1)) -> str:
    attributes: dict = {"run_id": "run-1", "gen_ai.tool.call.id": f"call-{span_id}"}
    if name.startswith("execute_tool "):
        attributes["gen_ai.tool.name"] = name.split(" ", 1)[1]
    if length is not None:
        attributes["tool.result.length"] = length
    return json.dumps({"name": name, "span_id": span_id, "parent_id": parent_id, "start_time": int(at.timestamp() * 1e9), "duration_ms": 5.0, "attributes": attributes}) + "\n"


def _write(path: Path, *lines: str) -> Path:
    path.write_text("".join(lines), encoding="utf-8")
    return path


def test_a_result_a_script_read_is_not_counted_as_context(tmp_path):
    spans = _write(
        tmp_path / "a.jsonl",
        # A span is written when it ends, so a script's calls come before the script.
        _span("execute_tool web_fetch", "0xnested", "0xscript", 2_500_000),
        _span("execute_tool script", "0xscript", "0xturn", 1_200),
        _span("execute_tool web_fetch", "0xdirect", "0xturn", 1_500_000),
        _span("chat stub", "0xturn", "0xrun"),
    )
    stats = tool_usage.span_stats([spans], CUTOFF)
    assert stats.calls == {"web_fetch": 2, "script": 1}
    assert stats.direct == {"web_fetch": [1_500_000], "script": [1_200]}
    assert stats.nested == {"web_fetch": [2_500_000]}
    assert stats.context_chars() == 1_501_200


def test_the_script_may_be_in_another_file_or_older_than_the_window(tmp_path):
    older = _write(tmp_path / "2026-11-17-11.jsonl", _span("execute_tool script", "0xscript", "0xturn", 100, at=CUTOFF - timedelta(minutes=5)))
    newer = _write(tmp_path / "2026-11-17-12.jsonl", _span("execute_tool grep", "0xnested", "0xscript", 700))
    stats = tool_usage.span_stats([newer, older], CUTOFF)
    # The script started before the window, so only its call is in it.
    assert stats.calls == {"grep": 1}
    assert stats.nested == {"grep": [700]}
    assert stats.context_chars() == 0


def test_the_volume_table_has_a_column_for_each_and_totals_only_what_the_model_read(tmp_path, capsys):
    spans = _write(
        tmp_path / "a.jsonl",
        _span("execute_tool web_fetch", "0xnested", "0xscript", 2_500_000),
        _span("execute_tool script", "0xscript", "0xturn", 200_000),
        _span("execute_tool web_fetch", "0xdirect", "0xturn", 1_300_000),
    )
    tool_usage.print_volume(tool_usage.span_stats([spans], CUTOFF), top=20)
    out = capsys.readouterr().out
    header = next(line for line in out.splitlines() if line.startswith("tool"))
    assert header.split()[-2:] == ["ctx_MB", "nested_MB"]
    row = next(line for line in out.splitlines() if line.startswith("web_fetch"))
    assert row.split()[-2:] == ["1.3", "2.5"]
    assert "total tool output into context: 1.5 MB" in out
    assert "2.5 MB more went to scripts" in out
