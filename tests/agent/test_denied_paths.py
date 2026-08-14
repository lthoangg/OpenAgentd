"""Tests for app/agent/denied_paths.py — DeniedPathsConfig path validation.

The path denylist uses a **denylist** model: paths are allowed unless they resolve
under one of the denied roots (``OPENAGENTD_DATA_DIR``, ``OPENAGENTD_STATE_DIR``,
``OPENAGENTD_CACHE_DIR``) or match a user-defined glob pattern. Workspace and memory
roots are always allowed — even if they happen to live under a denied root.

Symlinks are allowed unless their target lands inside a denied root.
Tilde paths are always rejected.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.agent.denied_paths import DeniedPathsConfig, SandboxConfig
from app.core.config import settings


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_denied_paths(
    tmp_path: Path,
    *,
    denied: list[Path] | None = None,
    denied_patterns: list[str] | None = None,
) -> DeniedPathsConfig:
    """Build a DeniedPathsConfig rooted at *tmp_path* with no denied roots by default."""
    return DeniedPathsConfig(
        workspace=str(tmp_path / "ws"),
        denied_roots=denied if denied is not None else [],
        denied_patterns=denied_patterns if denied_patterns is not None else [],
    )


# ---------------------------------------------------------------------------
# Basic path validation
# ---------------------------------------------------------------------------


def test_relative_path_resolved_to_workspace(tmp_path):
    denied_paths = _make_denied_paths(tmp_path)
    result = denied_paths.validate_path("subdir/file.txt")
    assert result == (tmp_path / "ws" / "subdir" / "file.txt").resolve()


def test_absolute_path_inside_workspace_allowed(tmp_path):
    denied_paths = _make_denied_paths(tmp_path)
    target = tmp_path / "ws" / "allowed.txt"
    result = denied_paths.validate_path(str(target))
    assert result == target.resolve()


def test_absolute_path_outside_workspace_allowed(tmp_path):
    """Under denylist semantics, paths outside workspace are allowed."""
    denied_paths = _make_denied_paths(tmp_path)
    outside = tmp_path.parent / "outside_file"
    outside.touch()
    result = denied_paths.validate_path(str(outside))
    assert result == outside.resolve()


def test_metadata_path_is_session_scoped_when_session_id_present(tmp_path):
    denied_paths = DeniedPathsConfig(
        workspace=str(tmp_path / "ws"),
        session_id="session-1",
        denied_roots=[],
        denied_patterns=[],
    )

    result = denied_paths.metadata_path(".todos.json")

    assert result == (
        Path(settings.OPENAGENTD_DATA_DIR) / "sessions" / "session-1" / ".todos.json"
    )
    assert str(tmp_path / "ws") not in str(result)


def test_metadata_path_falls_back_to_data_sessions_without_session_id(tmp_path):
    denied_paths = DeniedPathsConfig(
        workspace=str(tmp_path / "ws"),
        denied_roots=[],
        denied_patterns=[],
    )

    result = denied_paths.metadata_path(".tool_results")

    assert result.name == ".tool_results"


# ---------------------------------------------------------------------------
# Denied root enforcement
# ---------------------------------------------------------------------------


def test_denied_root_rejected(tmp_path):
    denied = tmp_path / "data"
    denied.mkdir()
    denied_paths = _make_denied_paths(tmp_path, denied=[denied])

    with pytest.raises(PermissionError, match="inside a denied root"):
        denied_paths.validate_path(str(denied / "secret.txt"))


def test_workspace_inside_denied_root_allowed(tmp_path):
    """If workspace itself is inside a denied root, workspace files are allowed."""
    denied = tmp_path / "data"
    ws = denied / "workspace"
    ws.mkdir(parents=True)

    denied_paths = DeniedPathsConfig(
        workspace=str(ws),
        denied_roots=[denied],
        denied_patterns=[],
    )

    # Files inside workspace should succeed
    denied_paths.validate_path("file.txt")

    # Files in denied root OUTSIDE workspace should fail
    with pytest.raises(PermissionError, match="inside a denied root"):
        denied_paths.validate_path(str(denied / "other_file"))


def test_allowed_internal_roots_logs(tmp_path):
    state_root = Path(settings.OPENAGENTD_STATE_DIR).resolve()
    log_path = state_root / "logs" / "app" / "openagentd.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.touch()

    denied_paths = DeniedPathsConfig(
        workspace=str(tmp_path / "ws"),
        session_id="s1",
        denied_roots=[state_root],
        denied_patterns=[],
    )

    assert denied_paths.validate_path(str(log_path)) == log_path


def test_allowed_internal_roots_otel(tmp_path):
    state_root = Path(settings.OPENAGENTD_STATE_DIR).resolve()
    span_path = state_root / "otel" / "spans.duckdb"
    span_path.parent.mkdir(parents=True, exist_ok=True)
    span_path.touch()

    denied_paths = DeniedPathsConfig(
        workspace=str(tmp_path / "ws"),
        session_id="s1",
        denied_roots=[state_root],
        denied_patterns=[],
    )

    assert denied_paths.validate_path(str(span_path)) == span_path


def test_allowed_internal_roots_telemetry(tmp_path):
    state_root = Path(settings.OPENAGENTD_STATE_DIR).resolve()
    dump_path = state_root / "telemetry" / "turn-1.json"
    dump_path.parent.mkdir(parents=True, exist_ok=True)
    dump_path.touch()

    denied_paths = DeniedPathsConfig(
        workspace=str(tmp_path / "ws"),
        session_id="s1",
        denied_roots=[state_root],
        denied_patterns=[],
    )

    assert denied_paths.validate_path(str(dump_path)) == dump_path


def test_allowed_internal_roots_session_artifact_dir(tmp_path):
    data_root = Path(settings.OPENAGENTD_DATA_DIR).resolve()
    artifact_dir = data_root / "sessions" / "s1"
    artifact_dir.mkdir(parents=True, exist_ok=True)
    artifact_path = artifact_dir / ".todos.json"
    artifact_path.touch()

    denied_paths = DeniedPathsConfig(
        workspace=str(tmp_path / "ws"),
        session_id="s1",
        denied_roots=[data_root],
        denied_patterns=[],
    )

    assert denied_paths.validate_path(str(artifact_path)) == artifact_path


def test_other_session_artifact_dir_denied(tmp_path):
    data_root = tmp_path / "data"
    other_dir = data_root / "sessions" / "s2"
    other_dir.mkdir(parents=True, exist_ok=True)
    other_path = other_dir / ".todos.json"
    other_path.touch()

    denied_paths = DeniedPathsConfig(
        workspace=str(tmp_path / "ws"),
        session_id="s1",
        denied_roots=[data_root],
        denied_patterns=[],
    )

    with pytest.raises(PermissionError, match="inside a denied root"):
        denied_paths.validate_path(str(other_path))


def test_sqlite_db_denied(tmp_path):
    data_root = tmp_path / "data"
    db_path = data_root / "openagentd.db"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    db_path.touch()

    denied_paths = DeniedPathsConfig(
        workspace=str(tmp_path / "ws"),
        session_id="s1",
        denied_roots=[data_root],
        denied_patterns=[],
    )

    with pytest.raises(PermissionError, match="inside a denied root"):
        denied_paths.validate_path(str(db_path))


# ---------------------------------------------------------------------------
# Tilde rejection
# ---------------------------------------------------------------------------


def test_tilde_paths_rejected(tmp_path):
    denied_paths = _make_denied_paths(tmp_path)
    with pytest.raises(PermissionError, match="Tilde paths are not allowed"):
        denied_paths.validate_path("~/foo")


# ---------------------------------------------------------------------------
# Symlinks
# ---------------------------------------------------------------------------


def test_symlink_to_allowed_target_succeeds(tmp_path):
    (tmp_path / "ws").mkdir(parents=True, exist_ok=True)
    target = tmp_path / "ws" / "real_file.txt"
    target.touch()
    link = tmp_path / "ws" / "link.txt"
    link.symlink_to(target)

    denied_paths = _make_denied_paths(tmp_path)
    result = denied_paths.validate_path(str(link))
    assert result == target.resolve()


def test_symlink_to_denied_target_rejected(tmp_path):
    (tmp_path / "ws").mkdir(parents=True, exist_ok=True)
    denied = tmp_path / "secret_dir"
    denied.mkdir()
    target = denied / "secret.txt"
    target.touch()

    link = tmp_path / "ws" / "sneak_link.txt"
    link.symlink_to(target)

    denied_paths = _make_denied_paths(tmp_path, denied=[denied])

    with pytest.raises(PermissionError, match="inside a denied root"):
        denied_paths.validate_path(str(link))


# ---------------------------------------------------------------------------
# Display path formatting
# ---------------------------------------------------------------------------


def test_display_path_relative_inside_workspace(tmp_path):
    denied_paths = _make_denied_paths(tmp_path)
    target = tmp_path / "ws" / "subdir" / "file.txt"
    assert denied_paths.display_path(target.resolve()) == "subdir/file.txt"


def test_display_path_absolute_outside_workspace(tmp_path):
    denied_paths = _make_denied_paths(tmp_path)
    outside = tmp_path / "outside.txt"
    assert denied_paths.display_path(outside.resolve()) == str(outside.resolve())


def test_sandbox_alias_compatibility(tmp_path):
    config = SandboxConfig(
        workspace=str(tmp_path / "ws"), denied_roots=[], denied_patterns=[]
    )
    assert isinstance(config, DeniedPathsConfig)
