"""Tests for :meth:`DeniedPathsConfig.check_command` — best-effort scan of
shell commands for arguments inside denied roots or matching deny
patterns.

The scanner is documented as best-effort: it tokenises the command with
:mod:`shlex` and checks tokens that look path-like. Adversarial
constructs (``$VAR``, ``$(...)``, base64) are explicitly out of scope.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from app.agent.denied_paths import DeniedPathsConfig, _looks_path_like
from app.core.config import settings


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make(
    tmp_path: Path,
    *,
    denied_roots: list[Path] | None = None,
    denied_patterns: list[str] | None = None,
) -> DeniedPathsConfig:
    return DeniedPathsConfig(
        workspace=str(tmp_path / "ws"),
        denied_roots=denied_roots if denied_roots is not None else [],
        denied_patterns=denied_patterns if denied_patterns is not None else [],
    )


# ---------------------------------------------------------------------------
# _looks_path_like — token classifier
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "token",
    [
        "/etc/passwd",
        "/Users/alice/.env",
        "~/.ssh/id_rsa",
        ".env",
        "./config",
        "../foo",
        "secrets/key",
        "a/b/c",
        r"C:\\Users\\alice\\.env",
        r"..\\secrets\\key.pem",
    ],
)
def test_looks_path_like_positive(token: str) -> None:
    assert _looks_path_like(token) is True


@pytest.mark.parametrize(
    "token",
    [
        "",
        "cat",
        "ls",
        "echo",
        "42",
        "--flag",
        "-a",
        "hello",
        "key=value",
    ],
)
def test_looks_path_like_negative(token: str) -> None:
    assert _looks_path_like(token) is False


# ---------------------------------------------------------------------------
# check_command — pattern matches
# ---------------------------------------------------------------------------


@pytest.mark.skipif(sys.platform != "win32", reason="native Windows path semantics")
def test_blocks_quoted_windows_path_under_denied_root(tmp_path: Path) -> None:
    forbidden = tmp_path / "secrets"
    forbidden.mkdir()
    denied_paths = _make(tmp_path, denied_roots=[forbidden])

    hit = denied_paths.check_command(f'Get-Content "{forbidden}\\key.pem"')

    assert hit is not None


def test_blocks_absolute_path_under_denied_root(tmp_path: Path) -> None:
    forbidden = tmp_path / "secrets"
    forbidden.mkdir()
    denied_paths = _make(tmp_path, denied_roots=[forbidden])

    hit = denied_paths.check_command(f"cat {forbidden}/key.pem")

    assert hit is not None


def test_blocks_dotfile_pattern_in_workspace(tmp_path: Path) -> None:
    project = tmp_path / "ws"
    project.mkdir()
    env_file = project / ".env"
    env_file.touch()

    denied_paths = _make(tmp_path, denied_patterns=["**/.env"])

    hit = denied_paths.check_command(f"cat {project}/.env")

    assert hit is not None


def test_blocks_tilde_expansion_to_denied_pattern(tmp_path: Path) -> None:
    denied_paths = _make(tmp_path, denied_patterns=["**/.aws/**"])
    hit = denied_paths.check_command("cat ~/.aws/credentials")
    assert hit is not None


def test_blocks_relative_path_in_workspace_matching_pattern(tmp_path: Path) -> None:
    project = tmp_path / "ws"
    project.mkdir()
    secret = project / "secrets" / "key.pem"
    secret.parent.mkdir()
    secret.touch()

    denied_paths = _make(tmp_path, denied_patterns=["**/secrets/**"])

    hit_workspace = denied_paths.check_command("cat secrets/key.pem")

    assert hit_workspace is not None


def test_allows_unmatched_path(tmp_path: Path) -> None:
    forbidden = tmp_path / "secrets"
    forbidden.mkdir()
    other = tmp_path / "public" / "file.txt"
    other.parent.mkdir()
    other.touch()

    denied_paths = _make(tmp_path, denied_roots=[forbidden])

    hit = denied_paths.check_command(f"cat {other}")
    assert hit is None


def test_handles_paths_with_spaces_and_quotes(tmp_path: Path) -> None:
    forbidden = tmp_path / "secrets"
    forbidden.mkdir()
    secret = forbidden / "key with spaces.txt"
    secret.touch()

    denied_paths = _make(tmp_path, denied_roots=[forbidden])

    hit = denied_paths.check_command(f"cat '{forbidden}/key with spaces.txt'")
    assert hit is not None


def test_allows_commands_without_path_tokens(tmp_path: Path) -> None:
    denied_paths = _make(tmp_path, denied_patterns=["**/.env"])

    assert denied_paths.check_command("echo hello world") is None
    assert denied_paths.check_command("date") is None
    assert denied_paths.check_command("") is None


def test_distinguishes_relative_and_absolute_tokens(tmp_path: Path) -> None:
    workspace = tmp_path / "ws"
    workspace.mkdir()
    (workspace / ".env").touch()

    denied_paths = _make(tmp_path, denied_patterns=["**/.env"])

    hit_abs = denied_paths.check_command(f"cat {workspace}/.env")
    assert hit_abs is not None

    hit_rel = denied_paths.check_command("cat .env")
    assert hit_rel is not None


def test_returns_none_for_unparseable_command(tmp_path: Path) -> None:
    denied_paths = _make(tmp_path, denied_patterns=["**/.env"])
    assert denied_paths.check_command("cat 'unclosed") is None


def test_system_paths_outside_workspace_allowed_when_not_denied(tmp_path: Path) -> None:
    denied_paths = _make(tmp_path)
    assert denied_paths.check_command("cat /etc/passwd") is None


def test_allowed_internal_roots_permit_command_path_tokens(tmp_path: Path) -> None:
    state_root = Path(settings.OPENAGENTD_STATE_DIR).resolve()
    log_path = state_root / "logs" / "app" / "openagentd.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.touch()

    denied_paths = _make(tmp_path, denied_roots=[state_root])

    assert denied_paths.check_command(f"tail -n 220 {log_path}") is None
