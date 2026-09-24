"""v2 end-of-life notice."""

import io

import pytest

from app.cli import sunset


class _Tty(io.StringIO):
    def isatty(self) -> bool:
        return True


def test_notice_points_to_v3_installer(monkeypatch):
    monkeypatch.delenv(sunset.HIDE_ENV, raising=False)
    out = _Tty()
    assert sunset.print_notice(out)
    text = out.getvalue()
    assert "no longer supported" in text
    assert "openagentd upgrade" in text
    assert "install.sh | sh -s -- --cli" in text or "install.ps1" in text


def test_notice_skips_non_tty_and_hide_env(monkeypatch):
    monkeypatch.delenv(sunset.HIDE_ENV, raising=False)
    assert not sunset.print_notice(io.StringIO())
    monkeypatch.setenv(sunset.HIDE_ENV, "1")
    assert not sunset.print_notice(_Tty(), force=True)


@pytest.mark.parametrize(
    ("manager", "expected"),
    [
        ("pip", "-m pip uninstall -y openagentd"),
        ("brew", "brew upgrade"),
    ],
)
def test_notice_names_manager_specific_step(manager, expected):
    assert any(expected in line for line in sunset.notice_lines(manager))
