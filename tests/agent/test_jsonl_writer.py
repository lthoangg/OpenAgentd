"""Tests for app/core/jsonl_writer.py — JsonlBatchWriter."""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest

from app.core.jsonl_writer import (
    JsonlBatchWriter,
    daily_partition,
    hourly_partition,
)


# ── Partition helpers ─────────────────────────────────────────────────────────


def test_hourly_partition_format():
    ts = datetime(2026, 4, 17, 14, 30, tzinfo=timezone.utc)
    assert hourly_partition(ts) == "2026-04-17-14"


def test_daily_partition_format():
    ts = datetime(2026, 4, 17, 14, 30, tzinfo=timezone.utc)
    assert daily_partition(ts) == "2026-04-17"


def test_partition_converts_non_utc_to_utc():
    # UTC+10 at 01:30 local → 15:30 UTC on previous day
    from datetime import timedelta, timezone as tz_mod

    aest = tz_mod(timedelta(hours=10))
    ts = datetime(2026, 4, 18, 1, 30, tzinfo=aest)
    assert hourly_partition(ts) == "2026-04-17-15"


# ── Writer: basic flush ───────────────────────────────────────────────────────


def _wait_for_file(path: Path, timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.exists() and path.stat().st_size > 0:
            return
        time.sleep(0.02)
    raise AssertionError(f"file never appeared: {path}")


def test_writer_flushes_single_record(tmp_path: Path):
    writer = JsonlBatchWriter(
        root=tmp_path,
        partition_fn=hourly_partition,
        flush_interval=0.05,
    )
    try:
        ts = datetime(2026, 4, 17, 14, 0, tzinfo=timezone.utc)
        assert writer.write({"hello": "world"}, ts=ts) is True
        path = tmp_path / "2026-04-17-14.jsonl"
        _wait_for_file(path)

        lines = path.read_text().strip().splitlines()
        assert len(lines) == 1
        assert json.loads(lines[0]) == {"hello": "world"}
    finally:
        writer.close()


def test_writer_groups_by_partition(tmp_path: Path):
    writer = JsonlBatchWriter(
        root=tmp_path,
        partition_fn=hourly_partition,
        flush_interval=0.05,
    )
    try:
        ts1 = datetime(2026, 4, 17, 14, 0, tzinfo=timezone.utc)
        ts2 = datetime(2026, 4, 17, 15, 0, tzinfo=timezone.utc)
        writer.write({"n": 1}, ts=ts1)
        writer.write({"n": 2}, ts=ts2)
        writer.write({"n": 3}, ts=ts1)

        _wait_for_file(tmp_path / "2026-04-17-14.jsonl")
        _wait_for_file(tmp_path / "2026-04-17-15.jsonl")

        h14 = (tmp_path / "2026-04-17-14.jsonl").read_text().strip().splitlines()
        h15 = (tmp_path / "2026-04-17-15.jsonl").read_text().strip().splitlines()
        assert len(h14) == 2
        assert len(h15) == 1
    finally:
        writer.close()


# ── Writer: backpressure ──────────────────────────────────────────────────────


def test_writer_drops_on_full_queue(tmp_path: Path):
    drops: list[int] = []
    # max_queue=1, batch_size huge, flush_interval big — the flusher thread
    # pulls one item then stays idle, so the second write will hit a full queue.
    writer = JsonlBatchWriter(
        root=tmp_path,
        partition_fn=hourly_partition,
        max_queue=1,
        batch_size=1_000,
        flush_interval=10.0,
        on_drop=lambda: drops.append(1),
    )
    try:
        # Race-proof: stuff the queue before the flusher has a chance to drain.
        results = [writer.write({"n": i}) for i in range(50)]
        # At least some drops must have occurred given max_queue=1.
        assert results.count(False) >= 1
        assert len(drops) == results.count(False)
    finally:
        writer.close()


def test_writer_on_write_callback_invoked(tmp_path: Path):
    counts: list[int] = []
    writer = JsonlBatchWriter(
        root=tmp_path,
        partition_fn=hourly_partition,
        flush_interval=0.05,
        on_write=counts.append,
    )
    try:
        writer.write({"a": 1})
        writer.write({"a": 2})
        # Wait for flush to happen
        deadline = time.monotonic() + 2.0
        while sum(counts) < 2 and time.monotonic() < deadline:
            time.sleep(0.02)
        assert sum(counts) == 2
    finally:
        writer.close()


def test_writer_close_flushes_pending(tmp_path: Path):
    writer = JsonlBatchWriter(
        root=tmp_path,
        partition_fn=hourly_partition,
        batch_size=1_000,
        flush_interval=10.0,  # never auto-flushes
    )
    ts = datetime(2026, 4, 17, 14, 0, tzinfo=timezone.utc)
    writer.write({"n": 1}, ts=ts)
    writer.write({"n": 2}, ts=ts)
    writer.close()

    path = tmp_path / "2026-04-17-14.jsonl"
    assert path.exists()
    lines = path.read_text().strip().splitlines()
    assert len(lines) == 2


def test_writer_creates_root_dir(tmp_path: Path):
    root = tmp_path / "nested" / "dir"
    writer = JsonlBatchWriter(
        root=root, partition_fn=hourly_partition, flush_interval=0.05
    )
    try:
        assert root.is_dir()
    finally:
        writer.close()


def test_writer_default_timestamp_is_now(tmp_path: Path):
    writer = JsonlBatchWriter(
        root=tmp_path,
        partition_fn=hourly_partition,
        flush_interval=0.05,
    )
    try:
        writer.write({"k": "v"})
        # Just assert that some partition file appears (named by current UTC hour).
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            if any(tmp_path.glob("*.jsonl")):
                break
            time.sleep(0.02)
        assert any(tmp_path.glob("*.jsonl"))
    finally:
        writer.close()


# ── Writer: callbacks never crash flusher ─────────────────────────────────────


def test_writer_on_drop_exception_swallowed(tmp_path: Path):
    def boom() -> None:
        raise RuntimeError("nope")

    writer = JsonlBatchWriter(
        root=tmp_path,
        partition_fn=hourly_partition,
        max_queue=1,
        batch_size=1_000,
        flush_interval=10.0,
        on_drop=boom,
    )
    try:
        # Spam the queue; should not raise.
        for i in range(20):
            writer.write({"n": i})
    finally:
        writer.close()


def test_writer_on_write_exception_swallowed(tmp_path: Path):
    def boom(_n: int) -> None:
        raise RuntimeError("nope")

    writer = JsonlBatchWriter(
        root=tmp_path,
        partition_fn=hourly_partition,
        flush_interval=0.05,
        on_write=boom,
    )
    try:
        writer.write({"n": 1})
        # Wait for the flusher to attempt one flush (flush_interval=0.05) and
        # swallow the on_write boom.  Poll the file for the record landing on
        # disk, which proves the flusher ran and the exception was swallowed.
        path = next(iter(tmp_path.glob("*.jsonl")), None)
        deadline = time.monotonic() + 1.0
        while time.monotonic() < deadline:
            files = list(tmp_path.glob("*.jsonl"))
            if files and files[0].stat().st_size > 0:
                path = files[0]
                break
            time.sleep(0.005)
        assert path is not None and path.stat().st_size > 0
        assert writer._thread.is_alive()
    finally:
        writer.close()


@pytest.mark.parametrize("ratio_text", ["0.1", "1.0", "0.0"])
def test_partition_functions_idempotent(ratio_text: str):
    # Sanity: calling partition fn twice yields the same string
    ts = datetime.now(timezone.utc)
    assert hourly_partition(ts) == hourly_partition(ts)
    assert daily_partition(ts) == daily_partition(ts)


# ── Metrics hooks must not fail silently ──────────────────────────────────────
#
# ``_on_write`` / ``_on_drop`` are caller-supplied metrics callbacks, wrapped in
# ``except Exception: pass`` so a broken hook can never crash the writer.  That
# is the right call — but with no log at all, a hook that raises every time
# silently disables telemetry with zero signal anywhere.  DEBUG keeps the fix
# from adding noise on a hot path.


def test_broken_on_write_hook_is_logged_and_does_not_crash(tmp_path, caplog):
    from loguru import logger

    calls: list[int] = []

    def exploding_on_write(count: int) -> None:
        calls.append(count)
        raise RuntimeError("metrics backend down")

    writer = JsonlBatchWriter(
        tmp_path, hourly_partition, flush_interval=0.05, on_write=exploding_on_write
    )
    handler_id = logger.add(caplog.handler, format="{message}", level="DEBUG")
    try:
        assert writer.write({"a": 1}) is True
        writer.close(timeout=2.0)
    finally:
        logger.remove(handler_id)

    assert calls, "the hook should have been invoked"
    # The record still lands on disk despite the broken hook.
    files = list(tmp_path.rglob("*.jsonl"))
    assert files and files[0].read_text().strip()
    assert any("jsonl_writer_on_write_hook_failed" in m for m in caplog.messages), (
        f"broken metrics hook was swallowed with no trace: {caplog.messages}"
    )


def test_broken_on_drop_hook_is_logged_and_does_not_crash(tmp_path, caplog):
    from loguru import logger

    def exploding_on_drop() -> None:
        raise RuntimeError("metrics backend down")

    # max_queue=1 with no flusher progress guarantees a drop.
    writer = JsonlBatchWriter(
        tmp_path,
        hourly_partition,
        max_queue=1,
        flush_interval=60.0,
        on_drop=exploding_on_drop,
    )
    handler_id = logger.add(caplog.handler, format="{message}", level="DEBUG")
    try:
        results = [writer.write({"n": i}) for i in range(50)]
        assert results.count(False) >= 1, "queue should have overflowed"
    finally:
        logger.remove(handler_id)
        writer.close(timeout=2.0)

    assert any("jsonl_writer_on_drop_hook_failed" in m for m in caplog.messages), (
        f"broken drop hook was swallowed with no trace: {caplog.messages}"
    )
