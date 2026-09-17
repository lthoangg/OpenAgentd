from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from app.services.memory.manager import MemoryManager, reset_memory_manager
from app.services.memory.store import resolve_memory_scopes, write_page


@pytest.fixture(autouse=True)
def reset_mgr():
    reset_memory_manager()
    yield
    reset_memory_manager()


@pytest.fixture
def setup_scopes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    monkeypatch.setattr(
        "app.core.config.settings.OPENAGENTD_CONFIG_DIR", str(config_dir)
    )

    ws_a = tmp_path / "ws_a"
    ws_a.mkdir()
    ws_b = tmp_path / "ws_b"
    ws_b.mkdir()

    g_scope, ws_a_scope = resolve_memory_scopes(str(ws_a), is_chat=False)
    _, ws_b_scope = resolve_memory_scopes(str(ws_b), is_chat=False)

    assert ws_a_scope is not None
    assert ws_b_scope is not None

    return g_scope, ws_a_scope, ws_b_scope


@pytest.mark.asyncio
async def test_get_snapshot_caches_and_single_flights(setup_scopes):
    g_scope, ws_a_scope, _ = setup_scopes
    await write_page(ws_a_scope, "init.md", "# Init\nContent")

    manager = MemoryManager()
    # Concurrent requests single-flight and receive identical snapshot object
    snap1, snap2 = await asyncio.gather(
        manager.get_workspace_snapshot(ws_a_scope),
        manager.get_workspace_snapshot(ws_a_scope),
    )
    assert snap1 is snap2


@pytest.mark.asyncio
async def test_scope_invalidation_isolation(setup_scopes):
    g_scope, ws_a_scope, ws_b_scope = setup_scopes
    await write_page(g_scope, "pref.md", "# Pref\nGlobal")
    await write_page(ws_a_scope, "a.md", "# A\nWorkspace A")
    await write_page(ws_b_scope, "b.md", "# B\nWorkspace B")

    manager = MemoryManager()
    g_snap1 = await manager.get_global_snapshot(g_scope)
    _ = await manager.get_workspace_snapshot(ws_a_scope)
    b_snap1 = await manager.get_workspace_snapshot(ws_b_scope)

    # Mutating Workspace A invalidates Ws A, but NOT Global or Ws B
    manager.invalidate(ws_a_scope.scope_key)
    g_snap2 = await manager.get_global_snapshot(g_scope)
    b_snap2 = await manager.get_workspace_snapshot(ws_b_scope)
    assert g_snap2 is g_snap1
    assert b_snap2 is b_snap1

    # Mutating Global invalidates Global, but NOT Ws B
    manager.invalidate(g_scope.scope_key)
    b_snap3 = await manager.get_workspace_snapshot(ws_b_scope)
    assert b_snap3 is b_snap1


@pytest.mark.asyncio
async def test_epoch_race_protection(setup_scopes):
    _, ws_a_scope, _ = setup_scopes
    await write_page(ws_a_scope, "note.md", "# Note\nInitial")

    manager = MemoryManager()
    state = manager._get_state(ws_a_scope.scope_key)

    # Simulate mutation mid-flight
    orig_epoch = state.epoch
    manager.invalidate(ws_a_scope.scope_key)
    assert state.epoch == orig_epoch + 1


@pytest.mark.asyncio
async def test_non_destructive_reconcile(setup_scopes):
    _, ws_a_scope, _ = setup_scopes
    await write_page(ws_a_scope, "page.md", "# Page\nContent")

    manager = MemoryManager()
    snap1 = await manager.get_workspace_snapshot(ws_a_scope)

    # Reconciling unchanged disk files retains existing snapshot object identity
    snap2 = await manager.reconcile(ws_a_scope)
    assert snap2 is snap1
