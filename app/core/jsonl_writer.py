"""Bounded-queue JSONL batch writer with drop-on-backpressure.

Used by:
- OTEL span exporter (hourly partitions: ``spans/YYYY-MM-DD-HH.jsonl``)
- OTEL metric exporter (daily partitions: ``metrics/YYYY-MM-DD.jsonl``)
- UsageEventHook (monthly partitions: ``usage_events/YYYY-MM.jsonl``)

Design goals
------------
- **Never block the hot path.** Producers (agent loop, OTEL BatchSpanProcessor
  worker thread) call :py:meth:`write` which only performs a bounded
  ``queue.put_nowait`` — no disk I/O in producer context.
- **Drop on backpressure.** Queue full → silently drop the record and invoke
  the optional drop callback. Loss is acceptable; lock contention is not.
- **Daemon flusher thread.** Drains the queue in batches and appends to
  a partitioned file.  Partition key is recomputed per record from UTC.
- **Clean shutdown.** :py:meth:`close` flushes pending records and joins the
  thread.  Safe to call multiple times.

This module deliberately does **not** depend on asyncio — the OTEL worker
thread is synchronous and FastAPI's event loop is already busy with streaming
work.
"""

from __future__ import annotations

import json
import queue
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from loguru import logger

# ── Partition helpers ─────────────────────────────────────────────────────────


def hourly_partition(ts: datetime) -> str:
    """``2026-04-17-14`` — one file per UTC hour."""
    return ts.astimezone(timezone.utc).strftime("%Y-%m-%d-%H")


def daily_partition(ts: datetime) -> str:
    """``2026-04-17`` — one file per UTC day."""
    return ts.astimezone(timezone.utc).strftime("%Y-%m-%d")


# ── Writer ────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class _QueueItem:
    obj: dict
    ts: datetime


# Pushed by close() to unblock queue.get immediately. Typed as ``_QueueItem``
# so it shares the queue type; the flusher distinguishes it via identity (``is``).
_STOP_SENTINEL = _QueueItem(obj={}, ts=datetime.fromtimestamp(0, tz=timezone.utc))


class JsonlBatchWriter:
    """Thread-safe, bounded, async-flushed JSONL writer.

    Args:
        root: Directory where partitioned files live.  Created on first write.
        partition_fn: Maps a UTC ``datetime`` to a partition key.  Use
            :func:`hourly_partition` or :func:`daily_partition`.
        max_queue: Maximum pending records.  On overflow records are dropped
            and ``on_drop`` is invoked (one call per dropped record).
        batch_size: Flush when this many records are buffered.
        flush_interval: Flush at least this often (seconds) even if the batch
            is not full.
        on_write: Optional callback invoked with the count after each
            successful flush.
        on_drop: Optional callback invoked once per dropped record.
        name: Human-readable identifier for log lines ("spans", "metrics", …).
    """

    def __init__(
        self,
        root: Path,
        partition_fn: Callable[[datetime], str],
        *,
        max_queue: int = 10_000,
        batch_size: int = 128,
        flush_interval: float = 1.0,
        on_write: Callable[[int], None] | None = None,
        on_drop: Callable[[], None] | None = None,
        name: str = "jsonl",
    ) -> None:
        self._root = root
        self._partition_fn = partition_fn
        self._batch_size = batch_size
        self._flush_interval = flush_interval
        self._on_write = on_write
        self._on_drop = on_drop
        self._name = name

        self._queue: queue.Queue[_QueueItem] = queue.Queue(maxsize=max_queue)
        self._stop = threading.Event()
        self._root.mkdir(parents=True, exist_ok=True)

        self._thread = threading.Thread(
            target=self._run,
            name=f"jsonl-writer-{name}",
            daemon=True,
        )
        self._thread.start()

    # ── Public API ────────────────────────────────────────────────────────

    def write(self, obj: dict, ts: datetime | None = None) -> bool:
        """Enqueue one record.

        Returns ``True`` if queued, ``False`` if dropped due to backpressure.
        Non-blocking.
        """
        item = _QueueItem(obj=obj, ts=ts or datetime.now(timezone.utc))
        try:
            self._queue.put_nowait(item)
            return True
        except queue.Full:
            if self._on_drop is not None:
                try:
                    self._on_drop()
                except Exception:
                    pass  # never let metrics hooks crash the writer
            return False

    def close(self, timeout: float = 5.0) -> None:
        """Flush pending records and stop the flusher thread."""
        self._stop.set()
        # Push a sentinel to unblock queue.get() immediately instead of waiting
        # up to flush_interval seconds for the timeout to expire.
        try:
            self._queue.put_nowait(_STOP_SENTINEL)
        except queue.Full:
            pass  # thread will notice _stop on its next natural wake-up
        self._thread.join(timeout=timeout)
        if self._thread.is_alive():
            logger.warning("jsonl_writer_close_timeout name={}", self._name)

    # ── Flusher ───────────────────────────────────────────────────────────

    def _run(self) -> None:
        batch: list[_QueueItem] = []
        last_flush = time.monotonic()

        while not self._stop.is_set():
            timeout = max(0.05, self._flush_interval - (time.monotonic() - last_flush))
            try:
                item = self._queue.get(timeout=timeout)
                if item is _STOP_SENTINEL:
                    break
                batch.append(item)
            except queue.Empty:
                pass

            # Drain any additional records opportunistically to form a batch.
            while len(batch) < self._batch_size:
                try:
                    item = self._queue.get_nowait()
                    if item is _STOP_SENTINEL:
                        break
                    batch.append(item)
                except queue.Empty:
                    break

            now = time.monotonic()
            if batch and (
                len(batch) >= self._batch_size
                or (now - last_flush) >= self._flush_interval
            ):
                self._flush(batch)
                batch = []
                last_flush = now

        # Drain remaining records on shutdown.
        while True:
            try:
                item = self._queue.get_nowait()
                if item is not _STOP_SENTINEL:
                    batch.append(item)
            except queue.Empty:
                break
        if batch:
            self._flush(batch)

    def _flush(self, batch: list[_QueueItem]) -> None:
        """Group records by partition and append to the matching file."""
        by_partition: dict[str, list[dict]] = {}
        for item in batch:
            key = self._partition_fn(item.ts)
            by_partition.setdefault(key, []).append(item.obj)

        written = 0
        for key, objs in by_partition.items():
            path = self._root / f"{key}.jsonl"
            try:
                with path.open("a", encoding="utf-8") as f:
                    for obj in objs:
                        f.write(json.dumps(obj, ensure_ascii=False, default=str))
                        f.write("\n")
                written += len(objs)
            except OSError as exc:
                logger.warning(
                    "jsonl_writer_flush_failed name={} path={} error={}",
                    self._name,
                    path,
                    exc,
                )

        if written and self._on_write is not None:
            try:
                self._on_write(written)
            except Exception:
                pass  # never let metrics hooks crash the writer
