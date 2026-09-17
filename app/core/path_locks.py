"""Centralized per-path asynchronous locking infrastructure.

Ensures mutual exclusion across concurrent filesystem mutations (e.g. patch tool,
memory store writes/deletes). Acquisition is sorted to prevent deadlocks when
multiple paths are locked. Reference counting removes lock entries when no task
holds or waits on them, preventing unbounded memory growth over the daemon's lifetime.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

_path_locks: dict[Path, asyncio.Lock] = {}
_path_lock_refs: dict[Path, int] = {}


def checkout_lock(path: Path) -> asyncio.Lock:
    """Borrow the asyncio.Lock for *path*, creating or bumping its reference count."""
    canonical = path.resolve()
    _path_lock_refs[canonical] = _path_lock_refs.get(canonical, 0) + 1
    return _path_locks.setdefault(canonical, asyncio.Lock())


def checkin_lock(path: Path) -> None:
    """Return the borrowed lock for *path*, pruning it from the table if unreferenced."""
    canonical = path.resolve()
    remaining = _path_lock_refs.get(canonical, 0) - 1
    if remaining <= 0:
        _path_lock_refs.pop(canonical, None)
        _path_locks.pop(canonical, None)
    else:
        _path_lock_refs[canonical] = remaining


async def acquire_all_locks(locks: list[asyncio.Lock]) -> list[asyncio.Lock]:
    """Acquire every lock in order; on cancellation or failure release the ones taken.

    A bare ``for lock in locks: await lock.acquire()`` leaks every lock taken
    before a cancelled one.
    """
    held: list[asyncio.Lock] = []
    try:
        for lock in locks:
            await lock.acquire()
            held.append(lock)
    except BaseException:
        for lock in reversed(held):
            lock.release()
        raise
    return held


@asynccontextmanager
async def path_lock(path: Path) -> AsyncIterator[asyncio.Lock]:
    """Async context manager locking a single path with reference counting."""
    canonical = path.resolve()
    lock = checkout_lock(canonical)
    await lock.acquire()
    try:
        yield lock
    finally:
        lock.release()
        checkin_lock(canonical)
