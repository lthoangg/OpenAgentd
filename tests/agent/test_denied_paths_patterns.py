"""Tests for user-defined glob deny-patterns in :class:`DeniedPathsConfig`.

Patterns are matched with :func:`fnmatch.fnmatchcase` against the
resolved absolute path string, so ``**/.env`` blocks ``.env`` files
anywhere on disk.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.agent.denied_paths import DeniedPathsConfig


def _make(tmp_path: Path, patterns: list[str]) -> DeniedPathsConfig:
    return DeniedPathsConfig(
        workspace=str(tmp_path / "ws"),
        memory=str(tmp_path / "mem"),
        denied_roots=[],
        denied_patterns=patterns,
    )


def test_pattern_blocks_matching_path(tmp_path: Path) -> None:
    target = tmp_path / "secrets" / "key.txt"
    target.parent.mkdir(parents=True)
    target.touch()

    denied_paths = _make(tmp_path, ["**/secrets/**"])
    with pytest.raises(PermissionError, match="inside a denied root"):
        denied_paths.validate_path(str(target))


def test_pattern_does_not_block_non_matching_path(tmp_path: Path) -> None:
    target = tmp_path / "public" / "file.txt"
    target.parent.mkdir(parents=True)
    target.touch()

    denied_paths = _make(tmp_path, ["**/secrets/**"])
    assert denied_paths.validate_path(str(target)) == target.resolve()


def test_dotfile_glob_blocks_env_anywhere(tmp_path: Path) -> None:
    """The seed pattern ``**/.env`` must block ``.env`` files anywhere."""
    env_file = tmp_path / "project" / ".env"
    env_file.parent.mkdir()
    env_file.touch()

    denied_paths = _make(tmp_path, ["**/.env"])
    with pytest.raises(PermissionError):
        denied_paths.validate_path(str(env_file))


def test_pattern_blocks_workspace_paths_too(tmp_path: Path) -> None:
    """User deny patterns must also apply inside the workspace."""
    workspace = tmp_path / "ws"
    workspace.mkdir()
    inside = workspace / ".env"
    inside.touch()

    denied_paths = _make(tmp_path, ["**/.env"])
    with pytest.raises(PermissionError, match="inside a denied root"):
        denied_paths.validate_path(str(inside))


def test_denied_root_does_not_override_workspace_allowance(tmp_path: Path) -> None:
    """Workspace remains reachable when its parent denied root would match."""
    denied = tmp_path / "parent"
    workspace = denied / "ws"
    workspace.mkdir(parents=True)
    inside = workspace / "file.txt"
    inside.touch()

    denied_paths = DeniedPathsConfig(
        workspace=str(workspace),
        denied_roots=[denied],
        denied_patterns=[],
    )

    assert denied_paths.validate_path(str(inside)) == inside.resolve()


def test_empty_patterns_means_no_extra_denials(tmp_path: Path) -> None:
    target = tmp_path / "anything.txt"
    target.touch()
    denied_paths = _make(tmp_path, [])
    assert denied_paths.validate_path(str(target)) == target.resolve()
