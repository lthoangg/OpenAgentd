from __future__ import annotations

import json

from manual.otel_inspect import _load_span_records


def test_load_span_records_reads_partitioned_span_files(tmp_path):
    spans_dir = tmp_path / "spans"
    spans_dir.mkdir()
    (spans_dir / "2026-07-17-09.jsonl").write_text(
        json.dumps({"name": "chat one"}) + "\n", encoding="utf-8"
    )
    (spans_dir / "2026-07-17-10.jsonl").write_text(
        json.dumps({"name": "chat two"}) + "\n", encoding="utf-8"
    )

    assert _load_span_records(spans_dir) == [
        {"name": "chat one"},
        {"name": "chat two"},
    ]


def test_load_span_records_reads_legacy_single_file(tmp_path):
    spans_file = tmp_path / "spans.jsonl"
    spans_file.write_text(json.dumps({"name": "chat"}) + "\n", encoding="utf-8")

    assert _load_span_records(spans_file) == [{"name": "chat"}]
