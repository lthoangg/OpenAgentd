"""Contract tests for the root Windows desktop installer."""

from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "install.ps1"


def test_windows_installer_uses_the_official_release_msi_and_msiexec():
    """The one-command installer downloads a validated release then elevates MSI."""
    text = SCRIPT.read_text()

    assert "lthoangg/openagentd" in text
    # The releases base URL is overridable for tests; latest resolves under it.
    assert '"https://github.com/$repo/releases"' in text
    assert '"$releasesUrl/latest"' in text
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


def test_windows_installer_says_what_happened_when_the_install_did_not_run():
    """A declined permission prompt and a cancelled install each get a sentence."""
    text = SCRIPT.read_text()
    start = text.index("Start-Process -FilePath")

    # Start-Process throws when the UAC prompt is declined.
    assert text.rindex("try {", 0, start) > text.index("==> Opening Windows Installer")
    assert "run the installer again and choose Yes" in text
    assert "$process.ExitCode -eq 1602" in text
    assert "the installation was cancelled" in text


def test_windows_installer_tells_arm_and_32_bit_machines_what_to_expect():
    """The MSI is x64: ARM runs it under emulation, 32-bit Windows cannot."""
    text = SCRIPT.read_text()
    desktop = text[text.index("$asset = \"OpenAgentd_${resolvedVersion}_x64_en-US.msi\"") - 700 :]

    assert '$arch -eq "ARM64"' in desktop
    assert "runs under emulation" in desktop
    assert '$arch -eq "x86"' in desktop
    assert "needs 64-bit Windows" in desktop


def test_windows_installer_does_not_pass_a_flag_start_no_longer_needs():
    assert "server start --wait" not in SCRIPT.read_text()
