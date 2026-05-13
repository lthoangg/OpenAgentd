"""Tests for app/agent/sandbox.py — SandboxConfig path validation.

The sandbox uses a **denylist** model: paths are allowed unless they resolve
under one of the denied roots (``OPENAGENTD_DATA_DIR``, ``OPENAGENTD_STATE_DIR``,
``OPENAGENTD_CACHE_DIR``).  Workspace and memory roots are always allowed —
even if they happen to live under a denied root.

Symlinks are allowed unless their target lands inside a denied root.
Tilde paths are always rejected.

Command validation lives in :mod:`app.agent.permission` and is not the
sandbox's responsibility.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.agent.sandbox import SandboxConfig


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_sandbox(
    tmp_path: Path,
    *,
    denied: list[Path] | None = None,
    denied_patterns: list[str] | None = None,
) -> SandboxConfig:
    """Build a sandbox rooted at *tmp_path* with no denied roots by default."""
    return SandboxConfig(
        workspace=str(tmp_path / "ws"),
        denied_roots=denied if denied is not None else [],
        denied_patterns=denied_patterns if denied_patterns is not None else [],
    )


# ---------------------------------------------------------------------------
# Basic path validation
# ---------------------------------------------------------------------------


def test_relative_path_resolved_to_workspace(tmp_path):
    sandbox = _make_sandbox(tmp_path)
    result = sandbox.validate_path("subdir/file.txt")
    assert result == (tmp_path / "ws" / "subdir" / "file.txt").resolve()


def test_absolute_path_inside_workspace_allowed(tmp_path):
    sandbox = _make_sandbox(tmp_path)
    target = tmp_path / "ws" / "allowed.txt"
    result = sandbox.validate_path(str(target))
    assert result == target.resolve()


def test_absolute_path_outside_workspace_allowed(tmp_path):
    """Under denylist semantics, paths outside workspace are allowed."""
    sandbox = _make_sandbox(tmp_path)
    outside = tmp_path.parent / "outside_file"
    outside.touch()
    result = sandbox.validate_path(str(outside))
    assert result == outside.resolve()


def test_metadata_path_is_session_scoped_when_session_id_present(tmp_path):
    sandbox = SandboxConfig(
        workspace=str(tmp_path / "ws"),
        session_id="session-1",
        denied_roots=[],
        denied_patterns=[],
    )

    result = sandbox.metadata_path(".todos.json")

    assert (
        result
        == tmp_path / "ws" / ".openagentd" / "sessions" / "session-1" / ".todos.json"
    )


def test_metadata_path_falls_back_to_workspace_metadata_without_session_id(tmp_path):
    sandbox = SandboxConfig(
        workspace=str(tmp_path / "ws"),
        denied_roots=[],
        denied_patterns=[],
    )

    result = sandbox.metadata_path(".shell_output")

    assert result == tmp_path / "ws" / ".openagentd" / ".shell_output"


def test_path_inside_denied_root_rejected(tmp_path):
    """Paths under a denied root must be rejected."""
    denied = tmp_path / "denied"
    denied.mkdir()
    sandbox = _make_sandbox(tmp_path, denied=[denied])
    with pytest.raises(PermissionError, match="denied sandbox root"):
        sandbox.validate_path(str(denied / "secret.txt"))


def test_workspace_under_denied_root_still_allowed(tmp_path):
    """If the workspace happens to live under a denied root, it's still allowed."""
    denied = tmp_path / "denied"
    denied.mkdir()
    workspace = denied / "ws"  # workspace is *inside* the denied root
    sandbox = SandboxConfig(
        workspace=str(workspace),
        memory=str(tmp_path / "mem"),
        denied_roots=[denied],
    )
    # Files inside workspace are fine
    sandbox.validate_path("file.txt")
    # Siblings of workspace under the denied root are not
    with pytest.raises(PermissionError, match="denied sandbox root"):
        sandbox.validate_path(str(denied / "other_file"))


# ---------------------------------------------------------------------------
# Tilde expansion
# ---------------------------------------------------------------------------


def test_tilde_prefix_rejected(tmp_path):
    """Paths starting with ~ are rejected — tilde expansion is a traversal risk."""
    sandbox = _make_sandbox(tmp_path)
    with pytest.raises(PermissionError, match="Tilde paths are not allowed"):
        sandbox.validate_path("~/foo")


# ---------------------------------------------------------------------------
# Symlink denial (target-based)
# ---------------------------------------------------------------------------


def test_symlink_to_allowed_path_is_ok(tmp_path):
    """Symlinks whose target is allowed are themselves allowed."""
    real = tmp_path / "real"
    real.mkdir()
    (real / "file.txt").touch()
    link = tmp_path / "link"
    link.symlink_to(real)

    sandbox = _make_sandbox(tmp_path)
    # Should not raise
    result = sandbox.validate_path(str(link / "file.txt"))
    assert result == (real / "file.txt").resolve()


def test_symlink_to_denied_root_rejected(tmp_path):
    """A symlink pointing into a denied root is rejected."""
    denied = tmp_path / "denied"
    denied.mkdir()
    (denied / "secret").touch()

    link = tmp_path / "link_to_secret"
    link.symlink_to(denied / "secret")

    sandbox = _make_sandbox(tmp_path, denied=[denied])
    with pytest.raises(PermissionError, match="Symlink target is inside a denied root"):
        sandbox.validate_path(str(link))


# ---------------------------------------------------------------------------
# display_path helpers
# ---------------------------------------------------------------------------


def test_display_path_workspace_relative(tmp_path):
    sandbox = _make_sandbox(tmp_path)
    target = tmp_path / "ws" / "subdir" / "file.txt"
    assert sandbox.display_path(target.resolve()) == "subdir/file.txt"


def test_display_path_outside_roots_returns_absolute(tmp_path):
    """Paths outside workspace render as absolute strings."""
    sandbox = _make_sandbox(tmp_path)
    outside = tmp_path / "outside.txt"
    outside.touch()
    assert sandbox.display_path(outside.resolve()) == str(outside.resolve())


# ---------------------------------------------------------------------------
# Sandbox no longer validates commands
# ---------------------------------------------------------------------------


def test_sandbox_has_no_validate_command(tmp_path):
    """The sandbox no longer has a validate_command method — permissions handle that."""
    sandbox = _make_sandbox(tmp_path)
    assert not hasattr(sandbox, "validate_command"), (
        "validate_command was removed from SandboxConfig. "
        "Use app.agent.permission.PermissionService instead."
    )
