from __future__ import annotations

import subprocess
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from app.services.worktree_service import (
    InvalidBranchNameError,
    GitCommandError,
    NonGitWorkspaceError,
    UnmanagedWorktreeError,
    merge_worktree_to_source,
    candidate,
    create_worktree,
    current_managed_worktree_branch,
    find_managed_worktree_source,
    list_worktrees,
    remove_worktree,
    rename_worktree,
    require_git_repo,
    slugify,
    validate_branch,
    validate_name,
)


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True
    )


def _repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init")
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Test User")
    (repo / "README.md").write_text("hello\n", encoding="utf-8")
    _git(repo, "add", "README.md")
    _git(repo, "commit", "-m", "init")
    return repo


def test_slugify_and_validate_name() -> None:
    assert slugify("Feature Auth 123") == "feature-auth-123"
    assert slugify("   ---special---characters---   ") == "special-characters"
    assert validate_name("Feature 1") == "feature-1"
    assert validate_name(None) == "session"
    assert validate_name("") == "session"


async def test_require_git_repo(tmp_path: Path) -> None:
    repo = _repo(tmp_path)
    await require_git_repo(repo)

    non_git = tmp_path / "non_git"
    non_git.mkdir()
    with pytest.raises(NonGitWorkspaceError):
        await require_git_repo(non_git)


async def test_validate_branch(tmp_path: Path) -> None:
    repo = _repo(tmp_path)
    assert (
        await validate_branch(repo, None, name="feature-login", detached=False)
        == "openagentd/feature-login"
    )
    assert (
        await validate_branch(
            repo, "custom-branch", name="feature-login", detached=False
        )
        == "custom-branch"
    )
    assert (
        await validate_branch(repo, None, name="feature-login", detached=True) is None
    )

    with pytest.raises(InvalidBranchNameError):
        await validate_branch(repo, "bad..branch", name="feat", detached=False)
    with pytest.raises(InvalidBranchNameError):
        await validate_branch(repo, "-invalid", name="feat", detached=False)


async def test_candidate_and_create_worktree(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo = _repo(tmp_path)
    data_dir = tmp_path / "data"
    monkeypatch.setattr(
        "app.services.worktree_service.settings.OPENAGENTD_DATA_DIR",
        str(data_dir),
    )

    info = await candidate(repo, "feature-a", "openagentd/feature-a")
    assert info.name == "feature-a"
    assert info.branch == "openagentd/feature-a"
    assert info.managed is True

    res = await create_worktree(
        source_workspace=str(repo),
        name="feature-a",
    )
    assert res.name == "feature-a"
    assert res.branch == "openagentd/feature-a"
    assert res.managed is True
    assert (Path(res.directory) / "README.md").read_text(encoding="utf-8") == "hello\n"

    # Second candidate generates -1 suffix
    info2 = await candidate(repo, "feature-a", "openagentd/feature-a")
    assert info2.name == "feature-a-1"
    assert info2.branch == "openagentd/feature-a-1"


async def test_find_managed_worktree_source(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo = _repo(tmp_path)
    data_dir = tmp_path / "data"
    monkeypatch.setattr(
        "app.services.worktree_service.settings.OPENAGENTD_DATA_DIR",
        str(data_dir),
    )

    res = await create_worktree(
        source_workspace=str(repo),
        name="task",
    )
    assert await find_managed_worktree_source(Path(res.directory)) == str(
        repo.resolve()
    )
    assert await current_managed_worktree_branch(res.directory) == "openagentd/task"

    unmanaged = tmp_path / "unmanaged"
    _git(repo, "worktree", "add", "-b", "unmanaged", str(unmanaged))
    assert await find_managed_worktree_source(unmanaged) is None
    assert await current_managed_worktree_branch(unmanaged) is None


async def test_list_and_remove_worktree(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo = _repo(tmp_path)
    data_dir = tmp_path / "data"
    monkeypatch.setattr(
        "app.services.worktree_service.settings.OPENAGENTD_DATA_DIR",
        str(data_dir),
    )

    res = await create_worktree(
        source_workspace=str(repo),
        name="to-remove",
    )
    worktrees = await list_worktrees(str(repo))
    assert len(worktrees) == 1
    assert worktrees[0].name == "to-remove"

    # Try to remove unmanaged worktree
    unmanaged = tmp_path / "unmanaged"
    _git(repo, "worktree", "add", "-b", "unmanaged", str(unmanaged))
    with pytest.raises(UnmanagedWorktreeError):
        await remove_worktree(str(repo), str(unmanaged))

    # Remove managed worktree
    removed = await remove_worktree(str(repo), res.directory)
    assert removed is True
    assert not Path(res.directory).exists()

    worktrees_after = await list_worktrees(str(repo))
    assert len(worktrees_after) == 1
    assert worktrees_after[0].name == "unmanaged"


async def test_rename_worktree(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    repo = _repo(tmp_path)
    data_dir = tmp_path / "data"
    monkeypatch.setattr(
        "app.services.worktree_service.settings.OPENAGENTD_DATA_DIR",
        str(data_dir),
    )

    res = await create_worktree(
        source_workspace=str(repo),
        name="rename-me",
    )
    renamed = await rename_worktree(res.directory, "My Renamed Task")
    assert renamed.name == "My Renamed Task"
    assert renamed.directory == res.directory


async def test_merge_worktree_clean(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo = _repo(tmp_path)
    data_dir = tmp_path / "data"
    monkeypatch.setattr(
        "app.services.worktree_service.settings.OPENAGENTD_DATA_DIR",
        str(data_dir),
    )

    res = await create_worktree(source_workspace=str(repo), name="feature-clean")
    wt_dir = Path(res.directory)

    # Make a commit in worktree
    (wt_dir / "new_file.txt").write_text("created in worktree\n", encoding="utf-8")
    _git(wt_dir, "add", "new_file.txt")
    _git(wt_dir, "commit", "-m", "add new file")

    merge_res = await merge_worktree_to_source(
        worktree=str(wt_dir), delete_on_success=True
    )
    assert merge_res.status == "merged"
    assert (repo / "new_file.txt").read_text(
        encoding="utf-8"
    ) == "created in worktree\n"
    assert not wt_dir.exists()
    branch = subprocess.run(
        [
            "git",
            "-C",
            str(repo),
            "show-ref",
            "--verify",
            "--quiet",
            "refs/heads/openagentd/feature-clean",
        ],
        capture_output=True,
        check=False,
    )
    assert branch.returncode != 0


async def test_remove_worktree_deletes_agent_branch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo = _repo(tmp_path)
    monkeypatch.setattr(
        "app.services.worktree_service.settings.OPENAGENTD_DATA_DIR",
        str(tmp_path / "data"),
    )
    res = await create_worktree(
        source_workspace=str(repo), name="agent-task", branch="agent/task"
    )

    await remove_worktree(repo, res.directory, delete_branch=True)

    branch = subprocess.run(
        [
            "git",
            "-C",
            str(repo),
            "show-ref",
            "--verify",
            "--quiet",
            "refs/heads/agent/task",
        ],
        capture_output=True,
        check=False,
    )
    assert branch.returncode != 0


async def test_managed_grandchild_resolves_to_original_source(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo = _repo(tmp_path)
    data_dir = tmp_path / "data"
    monkeypatch.setattr(
        "app.services.worktree_service.settings.OPENAGENTD_DATA_DIR",
        str(data_dir),
    )

    child = await create_worktree(source_workspace=str(repo), name="child")
    grandchild = await create_worktree(
        source_workspace=child.directory, name="grandchild"
    )

    assert await find_managed_worktree_source(grandchild.directory) == str(
        repo.resolve()
    )


async def test_merge_worktree_dirty_worktree(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo = _repo(tmp_path)
    data_dir = tmp_path / "data"
    monkeypatch.setattr(
        "app.services.worktree_service.settings.OPENAGENTD_DATA_DIR",
        str(data_dir),
    )

    res = await create_worktree(source_workspace=str(repo), name="feature-dirty-wt")
    wt_dir = Path(res.directory)

    # Leave uncommitted file in worktree
    (wt_dir / "uncommitted.txt").write_text("uncommitted\n", encoding="utf-8")

    merge_res = await merge_worktree_to_source(worktree=str(wt_dir))
    assert merge_res.status == "dirty_worktree"


async def test_merge_worktree_dirty_source(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo = _repo(tmp_path)
    data_dir = tmp_path / "data"
    monkeypatch.setattr(
        "app.services.worktree_service.settings.OPENAGENTD_DATA_DIR",
        str(data_dir),
    )

    res = await create_worktree(source_workspace=str(repo), name="feature-dirty-src")
    wt_dir = Path(res.directory)

    (wt_dir / "file.txt").write_text("committed\n", encoding="utf-8")
    _git(wt_dir, "add", "file.txt")
    _git(wt_dir, "commit", "-m", "commit in wt")

    # Leave uncommitted file in source repo
    (repo / "dirty_in_source.txt").write_text("dirty\n", encoding="utf-8")

    merge_res = await merge_worktree_to_source(worktree=str(wt_dir))
    assert merge_res.status == "dirty_source"


async def test_merge_worktree_nothing_to_merge(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo = _repo(tmp_path)
    data_dir = tmp_path / "data"
    monkeypatch.setattr(
        "app.services.worktree_service.settings.OPENAGENTD_DATA_DIR",
        str(data_dir),
    )

    res = await create_worktree(source_workspace=str(repo), name="feature-no-changes")
    wt_dir = Path(res.directory)

    merge_res = await merge_worktree_to_source(worktree=str(wt_dir))
    assert merge_res.status == "nothing_to_merge"


async def test_merge_worktree_conflict(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo = _repo(tmp_path)
    data_dir = tmp_path / "data"
    monkeypatch.setattr(
        "app.services.worktree_service.settings.OPENAGENTD_DATA_DIR",
        str(data_dir),
    )

    res = await create_worktree(source_workspace=str(repo), name="feature-conflict")
    wt_dir = Path(res.directory)

    # Worktree changes README.md
    (wt_dir / "README.md").write_text("worktree version\n", encoding="utf-8")
    _git(wt_dir, "add", "README.md")
    _git(wt_dir, "commit", "-m", "wt edit")

    # Source repo changes README.md conflictingly
    (repo / "README.md").write_text("source version\n", encoding="utf-8")
    _git(repo, "add", "README.md")
    _git(repo, "commit", "-m", "source edit")

    merge_res = await merge_worktree_to_source(worktree=str(wt_dir))
    assert merge_res.status == "conflict"
    assert merge_res.conflicting_paths is not None

    # Source repo remains clean and untouched by failed merge
    assert (repo / "README.md").read_text(encoding="utf-8") == "source version\n"
    # Worktree is preserved for inspection
    assert wt_dir.exists()


async def test_merge_reports_success_when_cleanup_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo = _repo(tmp_path)
    monkeypatch.setattr(
        "app.services.worktree_service.settings.OPENAGENTD_DATA_DIR",
        str(tmp_path / "data"),
    )
    res = await create_worktree(source_workspace=str(repo), name="cleanup-failure")
    wt_dir = Path(res.directory)
    (wt_dir / "merged.txt").write_text("merged\n", encoding="utf-8")
    _git(wt_dir, "add", "merged.txt")
    _git(wt_dir, "commit", "-m", "merge me")

    with patch(
        "app.services.worktree_service.remove_worktree",
        AsyncMock(side_effect=GitCommandError("cleanup unavailable")),
    ):
        result = await merge_worktree_to_source(worktree=wt_dir)

    assert result.status == "merged"
    assert "cleanup failed" in result.detail
    assert (repo / "merged.txt").exists()


async def test_merge_rejects_detached_worktree(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo = _repo(tmp_path)
    monkeypatch.setattr(
        "app.services.worktree_service.settings.OPENAGENTD_DATA_DIR",
        str(tmp_path / "data"),
    )
    res = await create_worktree(
        source_workspace=str(repo), name="detached", detached=True
    )

    result = await merge_worktree_to_source(worktree=res.directory)

    assert result.status == "error"
    assert "Detached" in result.detail
