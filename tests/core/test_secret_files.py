"""Tests for the owner-only atomic secret writer."""

from __future__ import annotations

import os
import stat
import sys
from pathlib import Path

import pytest

from app.core.secret_files import write_secret_file


def _mode(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


def test_writes_content_and_creates_parent_dirs(tmp_path: Path):
    target = tmp_path / "nested" / "deeper" / ".env"

    write_secret_file(target, "KEY=value\n")

    assert target.read_text(encoding="utf-8") == "KEY=value\n"


def test_overwrites_existing_content(tmp_path: Path):
    target = tmp_path / ".env"
    write_secret_file(target, "KEY=old\n")

    write_secret_file(target, "KEY=new\n")

    assert target.read_text(encoding="utf-8") == "KEY=new\n"


def test_leaves_no_temporary_files_behind(tmp_path: Path):
    target = tmp_path / ".env"

    write_secret_file(target, "KEY=value\n")

    assert [p.name for p in tmp_path.iterdir()] == [".env"]


def test_failed_write_removes_temp_and_keeps_previous_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A crash mid-write must not leave a temp file or a truncated target."""
    target = tmp_path / ".env"
    write_secret_file(target, "KEY=original\n")

    def _boom(*_args, **_kwargs):
        raise RuntimeError("disk gave up")

    monkeypatch.setattr(os, "replace", _boom)
    with pytest.raises(RuntimeError):
        write_secret_file(target, "KEY=new\n")

    assert target.read_text(encoding="utf-8") == "KEY=original\n"
    assert [p.name for p in tmp_path.iterdir()] == [".env"]


@pytest.mark.skipif(
    sys.platform == "win32", reason="POSIX mode bits are not meaningful on Windows"
)
class TestPermissions:
    def test_new_file_is_owner_only(self, tmp_path: Path):
        target = tmp_path / ".env"

        write_secret_file(target, "KEY=value\n")

        assert _mode(target) == 0o600

    def test_existing_loose_file_is_tightened(self, tmp_path: Path):
        target = tmp_path / ".env"
        target.write_text("KEY=old\n", encoding="utf-8")
        target.chmod(0o644)

        write_secret_file(target, "KEY=new\n")

        assert _mode(target) == 0o600

    def test_secret_is_never_visible_under_a_wider_mode(self, tmp_path: Path):
        """The temp file must be created 0600, not chmodded after the fact."""
        target = tmp_path / ".env"
        observed: list[int] = []
        real_open = os.open

        def _spy(path, flags, mode=0o777, **kwargs):
            if str(path).endswith(".tmp"):
                observed.append(mode)
            return real_open(path, flags, mode, **kwargs)

        original = os.open
        os.open = _spy  # type: ignore[assignment]
        try:
            write_secret_file(target, "KEY=value\n")
        finally:
            os.open = original  # type: ignore[assignment]

        assert observed == [0o600]
