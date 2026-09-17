from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from app.services.memory.manager import MemoryManager, reset_memory_manager
from app.services.memory.store import resolve_memory_scope, write_page


@pytest.fixture(autouse=True)
def reset_mgr():
    reset_memory_manager()
    yield
    reset_memory_manager()


@pytest.fixture
def setup_scope(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    monkeypatch.setattr(
        "app.core.config.settings.OPENAGENTD_CONFIG_DIR", str(config_dir)
    )
    g_scope = resolve_memory_scope()
    g_scope.root.mkdir(parents=True, exist_ok=True)
    return g_scope


@pytest.mark.asyncio
async def test_get_snapshot_caches_and_single_flights(setup_scope):
    g_scope = setup_scope
    await write_page(g_scope, "init.md", "# Init\nContent")

    manager = MemoryManager()
    # Concurrent requests single-flight and receive identical snapshot object
    snap1, snap2 = await asyncio.gather(
        manager.get_global_snapshot(g_scope),
        manager.get_global_snapshot(g_scope),
    )
    assert snap1 is snap2


@pytest.mark.asyncio
async def test_scope_invalidation(setup_scope):
    g_scope = setup_scope
    page1, _ = await write_page(g_scope, "pref.md", "# Pref\nGlobal")

    manager = MemoryManager()
    g_snap1 = await manager.get_global_snapshot(g_scope)

    # Invalidation clears snapshot and bumps epoch
    manager.invalidate(g_scope.scope_key)
    assert manager._get_state(g_scope.scope_key).snapshot is None

    await write_page(g_scope, "pref.md", "# Pref\nUpdated Global", if_match=page1.etag)
    g_snap2 = await manager.get_global_snapshot(g_scope)
    assert g_snap2 is not g_snap1


@pytest.mark.asyncio
async def test_epoch_race_protection(setup_scope):
    g_scope = setup_scope
    await write_page(g_scope, "note.md", "# Note\nInitial")

    manager = MemoryManager()
    state = manager._get_state(g_scope.scope_key)

    # Simulate mutation mid-flight
    orig_epoch = state.epoch
    manager.invalidate(g_scope.scope_key)
    assert state.epoch == orig_epoch + 1


@pytest.mark.asyncio
async def test_non_destructive_reconcile(setup_scope):
    g_scope = setup_scope
    await write_page(g_scope, "page.md", "# Page\nContent")

    manager = MemoryManager()
    snap1 = await manager.get_global_snapshot(g_scope)

    # Reconciling unchanged disk files retains existing snapshot object identity
    snap2 = await manager.reconcile(g_scope)
    assert snap2 is snap1
