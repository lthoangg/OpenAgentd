"""Tests for :meth:`SandboxConfig.check_command` — best-effort scan of
shell commands for arguments inside denied roots or matching deny
patterns.

The scanner is documented as best-effort: it tokenises the command with
:mod:`shlex` and checks tokens that look path-like.  Adversarial
constructs (``$VAR``, ``$(...)``, base64) are explicitly out of scope.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.agent.sandbox import SandboxConfig, _looks_path_like
from app.core.config import settings


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make(
    tmp_path: Path,
    *,
    denied_roots: list[Path] | None = None,
    denied_patterns: list[str] | None = None,
) -> SandboxConfig:
    return SandboxConfig(
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


def test_blocks_absolute_path_under_denied_root(tmp_path: Path) -> None:
    forbidden = tmp_path / "secrets"
    forbidden.mkdir()
    sandbox = _make(tmp_path, denied_roots=[forbidden])

    hit = sandbox.check_command(f"cat {forbidden}/key.pem")
    assert hit is not None
    resolved, denied = hit
    assert resolved == forbidden / "key.pem"
    assert str(forbidden) in denied


def test_blocks_pattern_match_anywhere(tmp_path: Path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    sandbox = _make(tmp_path, denied_patterns=["**/.env"])

    hit = sandbox.check_command(f"cat {project}/.env")
    assert hit is not None
    _, denied = hit
    assert denied == "**/.env"


def test_expands_tilde_against_home(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Tokens starting with ~ are expanded — shells expand them before exec."""
    fake_home = tmp_path / "home" / "alice"
    fake_home.mkdir(parents=True)
    monkeypatch.setenv("HOME", str(fake_home))
    secrets = fake_home / ".aws" / "credentials"
    secrets.parent.mkdir()
    secrets.touch()

    sandbox = _make(tmp_path, denied_patterns=["**/.aws/**"])
    hit = sandbox.check_command("cat ~/.aws/credentials")
    assert hit is not None
    resolved, _ = hit
    assert resolved == secrets


def test_relative_path_resolves_against_workspace(tmp_path: Path) -> None:
    """Relative workspace paths should match user deny patterns too."""
    sandbox = _make(tmp_path, denied_patterns=["**/secrets/**"])
    workspace = tmp_path / "ws"
    (workspace / "secrets").mkdir()

    hit_workspace = sandbox.check_command("cat secrets/key.pem")
    assert hit_workspace is not None
    _, denied_workspace = hit_workspace
    assert denied_workspace == "**/secrets/**"

    # An absolute path to a non-workspace `secrets/` SHOULD also match.
    other = tmp_path / "other_proj" / "secrets" / "key.pem"
    other.parent.mkdir(parents=True)
    hit = sandbox.check_command(f"cat {other}")
    assert hit is not None


def test_quoted_path_is_tokenised_properly(tmp_path: Path) -> None:
    """shlex unquotes "‹path›" so a quoted denied path still matches."""
    forbidden = tmp_path / "secrets"
    forbidden.mkdir()
    sandbox = _make(tmp_path, denied_roots=[forbidden])

    hit = sandbox.check_command(f"cat '{forbidden}/key with spaces.txt'")
    assert hit is not None


# ---------------------------------------------------------------------------
# check_command — non-matches
# ---------------------------------------------------------------------------


def test_no_path_tokens_means_no_match(tmp_path: Path) -> None:
    sandbox = _make(tmp_path, denied_patterns=["**/.env"])
    assert sandbox.check_command("echo hello world") is None
    assert sandbox.check_command("date") is None
    assert sandbox.check_command("") is None


def test_workspace_paths_match_user_denied_patterns(tmp_path: Path) -> None:
    """Workspace paths should be flagged when they match a user deny pattern."""
    sandbox = _make(tmp_path, denied_patterns=["**/.env"])
    workspace = tmp_path / "ws"
    (workspace / ".env").touch()

    hit_abs = sandbox.check_command(f"cat {workspace}/.env")
    assert hit_abs is not None
    _, denied_abs = hit_abs
    assert denied_abs == "**/.env"

    hit_rel = sandbox.check_command("cat .env")
    assert hit_rel is not None
    _, denied_rel = hit_rel
    assert denied_rel == "**/.env"


def test_unbalanced_quotes_do_not_raise(tmp_path: Path) -> None:
    """Malformed shell syntax should fall through, not crash the wrapper."""
    sandbox = _make(tmp_path, denied_patterns=["**/.env"])
    # shlex.split raises ValueError on unbalanced quotes; we swallow it
    # and let the shell itself handle the syntax error.
    assert sandbox.check_command("cat 'unclosed") is None


def test_no_patterns_means_no_match(tmp_path: Path) -> None:
    sandbox = _make(tmp_path)
    assert sandbox.check_command("cat /etc/passwd") is None


def test_state_logs_are_exempt_from_denied_roots(tmp_path: Path) -> None:
    logs_root = Path(settings.OPENAGENTD_STATE_DIR).resolve() / "logs"
    log_path = logs_root / "app" / "app.log"
    sandbox = _make(tmp_path, denied_roots=[Path(settings.OPENAGENTD_STATE_DIR)])

    assert sandbox.check_command(f"tail -n 220 {log_path}") is None


def test_state_error_logs_are_exempt_from_denied_roots(tmp_path: Path) -> None:
    logs_root = Path(settings.OPENAGENTD_STATE_DIR).resolve() / "logs"
    log_path = logs_root / "app" / "app-error.log"
    sandbox = _make(tmp_path, denied_roots=[Path(settings.OPENAGENTD_STATE_DIR)])

    assert sandbox.check_command(f"tail -n 220 {log_path}") is None


def test_other_state_paths_remain_denied(tmp_path: Path) -> None:
    state_root = Path(settings.OPENAGENTD_STATE_DIR).resolve()
    sandbox = _make(tmp_path, denied_roots=[state_root])

    hit = sandbox.check_command(f"cat {state_root / 'secrets' / 'token'}")
    assert hit is not None


# ---------------------------------------------------------------------------
# check_command — known limitations
# ---------------------------------------------------------------------------


def test_dollar_var_evasion_is_documented(tmp_path: Path) -> None:
    """Documented limitation: $VAR expansion is NOT evaluated.

    This test exists to lock in the contract — if someone later adds
    variable expansion, the test will fail and the doc must be updated.
    """
    forbidden = tmp_path / "secrets"
    forbidden.mkdir()
    sandbox = _make(tmp_path, denied_roots=[forbidden])

    # `$HIDDEN` is not expanded; the literal token "$HIDDEN" doesn't
    # resolve under a denied root.
    assert sandbox.check_command("HIDDEN=secrets/key.pem cat $HIDDEN") is None
