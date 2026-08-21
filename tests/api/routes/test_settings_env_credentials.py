"""Permission tests for the provider credentials ``.env`` writer.

``_write_env_credentials`` persists provider API keys to the same
``{CONFIG_DIR}/.env`` that ``app.api.routes.mcp._save_env_values`` writes.
That sibling writer chmods the file to ``0600``; this one did not, so the
resulting mode depended on which endpoint happened to write last.
"""

from __future__ import annotations

import stat
import sys
from pathlib import Path

import pytest

from app.api.routes.settings import _write_env_credentials

pytestmark = pytest.mark.skipif(
    sys.platform == "win32",
    reason="POSIX mode bits are not meaningful on Windows",
)


def _mode(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


def test_created_env_file_is_owner_only(tmp_path: Path):
    env_file = tmp_path / "config" / ".env"

    _write_env_credentials(env_file, {"OPENAI_API_KEY": "sk-secret"})

    assert "sk-secret" in env_file.read_text(encoding="utf-8")
    assert _mode(env_file) == 0o600


def test_existing_loose_env_file_is_tightened(tmp_path: Path):
    """A file created before this rule existed must not stay world-readable."""
    env_file = tmp_path / ".env"
    env_file.write_text("APP_ENV=production\n", encoding="utf-8")
    env_file.chmod(0o644)

    _write_env_credentials(env_file, {"ANTHROPIC_API_KEY": "sk-ant-secret"})

    assert "sk-ant-secret" in env_file.read_text(encoding="utf-8")
    assert _mode(env_file) == 0o600


def test_merge_preserves_unrelated_lines(tmp_path: Path):
    """Guard the existing merge behaviour while changing how the file is written."""
    env_file = tmp_path / ".env"
    env_file.write_text(
        "# comment\nAPP_ENV=production\nOPENAI_API_KEY=old\n", encoding="utf-8"
    )

    _write_env_credentials(env_file, {"OPENAI_API_KEY": "new"})

    body = env_file.read_text(encoding="utf-8")
    assert "# comment" in body
    assert "APP_ENV=production" in body
    assert "OPENAI_API_KEY=new" in body
    assert "OPENAI_API_KEY=old" not in body
