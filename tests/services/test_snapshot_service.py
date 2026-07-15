"""Unit tests for :mod:`app.services.snapshot_service`."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from app.services import snapshot_service


pytestmark = pytest.mark.skipif(
    shutil.which("git") is None, reason="git binary not available"
)


@pytest.fixture
def state_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Redirect ``OPENAGENTD_STATE_DIR`` so the snapshot repo lives in tmp."""
    from app.core.config import settings

    state = tmp_path / "state"
    state.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(settings, "OPENAGENTD_STATE_DIR", str(state))
    return state


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    ws = tmp_path / "workspace"
    ws.mkdir()
    return ws


def test_delete_extras_prunes_only_deleted_file_ancestors_and_contains_paths(
    workspace: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Restore cleanup must not scan the workspace or follow escaped paths."""
    deleted = workspace / "nested" / "child" / "gone.txt"
    deleted.parent.mkdir(parents=True)
    deleted.write_text("gone")
    retained = workspace / "unrelated" / "keep.txt"
    retained.parent.mkdir()
    retained.write_text("keep")
    outside = tmp_path / "outside.txt"
    outside.write_text("protected")

    def unexpected_walk(*args, **kwargs):
        raise AssertionError("cleanup must only visit deleted-file ancestors")

    monkeypatch.setattr(snapshot_service.os, "walk", unexpected_walk)

    snapshot_service._delete_extras(
        workspace, {"nested/child/gone.txt", "../outside.txt"}
    )

    assert not deleted.exists()
    assert not (workspace / "nested").exists()
    assert retained.read_text() == "keep"
    assert outside.read_text() == "protected"


def test_delete_extras_unlinks_workspace_symlink_without_touching_target(
    workspace: Path, tmp_path: Path
) -> None:
    outside = tmp_path / "outside.txt"
    outside.write_text("protected")
    link = workspace / "external-link"
    link.symlink_to(outside)

    snapshot_service._delete_extras(workspace, {"external-link"})

    assert not link.exists()
    assert not link.is_symlink()
    assert outside.read_text() == "protected"


@pytest.mark.asyncio
async def test_track_returns_tree_hash(state_dir: Path, workspace: Path) -> None:
    (workspace / "a.txt").write_text("hello")

    snapshot = await snapshot_service.track("sess-1", workspace)

    assert snapshot is not None
    assert len(snapshot) == 40
    assert snapshot_service.snapshot_dir("sess-1").exists()


@pytest.mark.asyncio
async def test_track_empty_workspace_returns_hash(
    state_dir: Path, workspace: Path
) -> None:
    snapshot = await snapshot_service.track("sess-empty", workspace)
    assert snapshot is not None
    assert len(snapshot) == 40


@pytest.mark.asyncio
async def test_track_missing_workspace_returns_none(
    state_dir: Path, tmp_path: Path
) -> None:
    missing = tmp_path / "does-not-exist"
    snapshot = await snapshot_service.track("sess-miss", missing)
    assert snapshot is None


@pytest.mark.asyncio
async def test_restore_reports_modified_added_removed_and_round_trips(
    state_dir: Path, workspace: Path
) -> None:
    """One real-git scenario covers restore partitions and redo-style replay."""
    modified = workspace / "config.txt"
    deleted = workspace / "deleted_by_agent.txt"
    new_file = workspace / "new_artifact.md"
    modified.write_text("v1")
    deleted.write_text("important")

    baseline = await snapshot_service.track("sess-restore", workspace)
    assert baseline is not None

    modified.write_text("v2-changed-by-tool")
    deleted.unlink()
    new_file.write_text("agent produced this")
    live_snapshot = await snapshot_service.track("sess-restore", workspace)
    assert live_snapshot is not None

    result = await snapshot_service.restore("sess-restore", workspace, baseline)
    assert result.ok is True
    assert modified.read_text() == "v1"
    assert deleted.read_text() == "important"
    assert not new_file.exists(), (
        "Newly-added file must be removed when restoring to a snapshot that predates it"
    )
    assert result.modified == ["config.txt"]
    assert result.added == ["deleted_by_agent.txt"]
    assert result.removed == ["new_artifact.md"]

    result = await snapshot_service.restore("sess-restore", workspace, live_snapshot)
    assert result.ok is True
    assert modified.read_text() == "v2-changed-by-tool"
    assert not deleted.exists()
    assert new_file.read_text() == "agent produced this"
    assert result.modified == ["config.txt"]
    assert result.added == ["new_artifact.md"]
    assert result.removed == ["deleted_by_agent.txt"]


@pytest.mark.asyncio
async def test_restore_no_repo_returns_false(state_dir: Path, workspace: Path) -> None:
    result = await snapshot_service.restore("sess-unknown", workspace, "0" * 40)
    assert result.ok is False
    assert result.added == []
    assert result.modified == []
    assert result.removed == []


@pytest.mark.asyncio
async def test_restore_unknown_hash_returns_false(
    state_dir: Path, workspace: Path
) -> None:
    (workspace / "a.txt").write_text("x")
    await snapshot_service.track("sess-bad-hash", workspace)
    result = await snapshot_service.restore("sess-bad-hash", workspace, "0" * 40)
    assert result.ok is False


@pytest.mark.asyncio
async def test_restore_preserves_main_index_stat_cache(
    state_dir: Path, workspace: Path
) -> None:
    """After ``restore``, the next ``track`` must remain O(changed paths)."""
    for i in range(10):
        (workspace / f"f{i}.txt").write_text(f"v1-{i}")
    snap_a = await snapshot_service.track("stat-cache", workspace)
    assert snap_a is not None

    (workspace / "f0.txt").write_text("v2-0")
    snap_b = await snapshot_service.track("stat-cache", workspace)
    assert snap_b is not None
    assert snap_b != snap_a

    result = await snapshot_service.restore("stat-cache", workspace, snap_a)
    assert result.ok is True
    assert (workspace / "f0.txt").read_text() == "v1-0"
    assert result.modified == ["f0.txt"]
    assert result.added == []
    assert result.removed == []

    gitdir = snapshot_service.snapshot_dir("stat-cache")
    candidates = await snapshot_service._list_candidate_paths(gitdir, workspace)
    assert candidates == ["f0.txt"], (
        f"next track would re-stage {len(candidates)} files; expected exactly "
        "['f0.txt']. If the count blew up to ~10, the main index stat-cache "
        "was wiped — check the temp-index (GIT_INDEX_FILE) wiring around "
        "read-tree + checkout-index in snapshot_service.restore."
    )


@pytest.mark.asyncio
async def test_remove_drops_repo(state_dir: Path, workspace: Path) -> None:
    (workspace / "a").write_text("x")
    await snapshot_service.track("doomed", workspace)
    repo = snapshot_service.snapshot_dir("doomed")
    assert repo.exists()

    await snapshot_service.remove("doomed")
    assert not repo.exists()


@pytest.mark.asyncio
async def test_track_skips_oversized_untracked_files(
    state_dir: Path, workspace: Path
) -> None:
    big = workspace / "huge.bin"
    big.write_bytes(b"x" * (2 * 1024 * 1024 + 1))
    small = workspace / "small.txt"
    small.write_text("ok")

    snapshot = await snapshot_service.track("sess-big", workspace)
    assert snapshot is not None

    small.write_text("changed")
    big.write_bytes(b"y" * (2 * 1024 * 1024 + 1))

    await snapshot_service.restore("sess-big", workspace, snapshot)
    assert small.read_text() == "ok"
    assert big.exists()
