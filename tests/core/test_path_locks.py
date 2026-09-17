from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from app.core.path_locks import (
    acquire_all_locks,
    checkin_lock,
    checkout_lock,
    path_lock,
)


@pytest.mark.asyncio
async def test_checkout_and_checkin_lifecycle(tmp_path: Path):
    p = tmp_path / "foo.txt"
    lock1 = checkout_lock(p)
    lock2 = checkout_lock(p)
    assert lock1 is lock2

    checkin_lock(p)
    # Still referenced once
    lock3 = checkout_lock(p)
    assert lock3 is lock1

    checkin_lock(p)
    checkin_lock(p)
    # Fully checked in, next checkout may create fresh lock
    lock4 = checkout_lock(p)
    checkin_lock(p)
    assert isinstance(lock4, asyncio.Lock)


@pytest.mark.asyncio
async def test_path_lock_context_manager(tmp_path: Path):
    p = tmp_path / "bar.txt"
    async with path_lock(p) as lock:
        assert lock.locked()
    assert not lock.locked()


@pytest.mark.asyncio
async def test_acquire_all_locks_cancellation(tmp_path: Path):
    p1 = tmp_path / "1.txt"
    p2 = tmp_path / "2.txt"
    l1 = checkout_lock(p1)
    l2 = checkout_lock(p2)
    try:
        held = await acquire_all_locks([l1, l2])
        assert l1.locked() and l2.locked()
        for lock in reversed(held):
            lock.release()
    finally:
        checkin_lock(p1)
        checkin_lock(p2)
