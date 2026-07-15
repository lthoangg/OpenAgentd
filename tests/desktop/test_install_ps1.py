"""Contract tests for the root Windows desktop installer."""

from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "install.ps1"


def test_windows_installer_uses_the_official_release_msi_and_msiexec():
    """The one-command installer downloads a validated release then elevates MSI."""
    text = SCRIPT.read_text()

    assert "lthoangg/openagentd" in text
    assert "releases/latest" in text
    assert "OpenAgentd_${resolvedVersion}_x64_en-US.msi" in text
    assert "Invoke-WebRequest" in text
    assert "Start-Process" in text
    assert "msiexec.exe" in text
    assert "-ArgumentList" in text
    assert '`"$installerPath`"' in text


def test_windows_installer_rejects_unsafe_versions_and_cleans_up_downloads():
    """A version cannot alter the release URL or leave a downloaded MSI behind."""
    text = SCRIPT.read_text()

    assert "^[A-Za-z0-9._-]+$" in text
    assert "finally" in text
    assert "Remove-Item -LiteralPath $installerPath" in text
    assert "Unblock-File -LiteralPath $installerPath" in text
