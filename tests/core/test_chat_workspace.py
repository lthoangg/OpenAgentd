"""Tests for :mod:`app.core.chat_workspace` — the prebuilt Chat root."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.core.chat_workspace import (
    CHAT_WORKSPACE_NAME,
    chat_workspace_root,
    is_chat_workspace,
    workspace_mode,
)
from app.core.config import settings


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Pin ``Path.home()`` so the default chat root is a temp directory."""
    home_dir = tmp_path / "home"
    home_dir.mkdir()
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home_dir))
    monkeypatch.setattr(settings, "CHAT_WORKSPACE_DIR", "")
    return home_dir


def test_default_root_is_the_home_directory(home: Path) -> None:
    assert chat_workspace_root() == home.resolve()


def test_configured_root_wins(home: Path, tmp_path: Path) -> None:
    configured = tmp_path / "chat-root"
    settings.CHAT_WORKSPACE_DIR = str(configured)
    assert chat_workspace_root() == configured.resolve()
    assert not is_chat_workspace(home)
    assert is_chat_workspace(configured)


def test_configured_root_expands_user(home: Path, tmp_path: Path) -> None:
    settings.CHAT_WORKSPACE_DIR = "~/elsewhere"
    assert chat_workspace_root() == (home / "elsewhere").resolve()


def test_bare_tilde_means_the_home_default(home: Path) -> None:
    settings.CHAT_WORKSPACE_DIR = "~"
    assert chat_workspace_root() == home.resolve()


def test_is_chat_workspace_matches_only_the_root(home: Path) -> None:
    assert is_chat_workspace(home)
    assert is_chat_workspace(str(home) + "/")
    assert not is_chat_workspace(home / "Projects")
    assert not is_chat_workspace("/some/other/dir")


def test_is_chat_workspace_tolerates_empty_and_missing_inputs(home: Path) -> None:
    assert not is_chat_workspace(None)
    assert not is_chat_workspace("")
    assert not is_chat_workspace("   ")


def test_workspace_mode_label(home: Path, tmp_path: Path) -> None:
    assert workspace_mode(home) == "chat"
    assert workspace_mode(home / "nested") == "coding"
    assert workspace_mode(str(tmp_path / "repo")) == "coding"
    assert workspace_mode(None) == "coding"


def test_chat_workspace_name_is_stable() -> None:
    assert CHAT_WORKSPACE_NAME == "Chat"
