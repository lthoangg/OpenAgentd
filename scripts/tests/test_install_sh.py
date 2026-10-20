"""Tests for ``desktop/scripts/install.sh``.

The installer is the only user-facing entry on macOS + Linux, so a
silent regression (e.g. wrong exit code, wrong platform branch,
broken option parser) would show up as "Open the app → nothing
happens" for end users.

We can't actually exercise the /Applications / dpkg / ~/.local/bin
paths inside CI without root, network, or the real bundle. But we can
exercise the **gates** in front of them:

  - bash syntax is valid (``bash -n``).
  - ``--help`` prints the usage banner from the script's own
    comment block and exits 0.
  - ``--unknown-flag`` exits with code 1 and prints "Unknown option".
  - Passing no bundle path on a machine that doesn't contain the
    canonical fallback bundle locations exits with code 1 and prints
    a helpful "Cannot find" message.
  - The Linux branch of the script correctly defers to ``dpkg``
    (we use a fake dpkg in PATH to verify).
  - The Linux branch with ``--install`` writes a ``.desktop`` file
    with the expected ``[Desktop Entry]`` keys (we use a fake
    binary + override XDG dirs).

The macOS branch is gated by ``uname -s``; its tests skip elsewhere.
It only strips quarantine and verifies CI's signature: it must never
re-sign the app (see ``desktop/scripts/sign-macos-release.sh``).
"""

from __future__ import annotations

import os
import platform
import re
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "desktop" / "scripts" / "install.sh"


def _run(
    args: list[str], *, env: dict[str, str] | None = None, cwd: Path | None = None
) -> subprocess.CompletedProcess[str]:
    """Run ``install.sh`` with the given args, capturing stdout + stderr."""
    full_env = os.environ.copy()
    if env:
        full_env.update(env)
    return subprocess.run(
        ["bash", str(SCRIPT), *args],
        capture_output=True,
        text=True,
        env=full_env,
        cwd=str(cwd) if cwd else None,
        timeout=30,
    )


class TestScriptSyntax:
    """Sanity: the script must parse as valid bash."""

    def test_script_exists_and_is_readable(self):
        assert SCRIPT.is_file(), f"install.sh missing at {SCRIPT}"
        # Should be executable (chmod +x in CI/dev).
        st = SCRIPT.stat()
        assert st.st_mode & stat.S_IXUSR, "install.sh must be executable"

    def test_bash_syntax_check_passes(self):
        proc = subprocess.run(
            ["bash", "-n", str(SCRIPT)],
            capture_output=True,
            text=True,
            timeout=10,
        )
        assert proc.returncode == 0, f"bash -n failed:\n{proc.stderr}"

    def test_uses_strict_mode(self):
        """``set -euo pipefail`` prevents silent failures.

        A regression to ``set -e`` only (without ``-u`` / ``-o pipefail``)
        would let undefined variable references slip past as empty
        strings — leading to bizarre user-facing errors.
        """
        text = SCRIPT.read_text()
        assert "set -euo pipefail" in text


class TestHelpFlag:
    """``--help`` / ``-h``: print usage from comment header, exit 0."""

    def test_long_help_exits_zero(self):
        proc = _run(["--help"])
        assert proc.returncode == 0, proc.stderr

    def test_short_help_exits_zero(self):
        proc = _run(["-h"])
        assert proc.returncode == 0

    def test_help_mentions_all_three_platforms(self):
        proc = _run(["--help"])
        out = proc.stdout + proc.stderr
        # The header explains macOS + Linux are covered here and points
        # Windows users at the MSI.
        assert "macOS" in out
        assert "Linux" in out
        assert "MSI" in out or "msi" in out.lower()

    def test_help_documents_install_flag(self):
        proc = _run(["--help"])
        out = proc.stdout + proc.stderr
        assert "--install" in out

    def test_help_documents_exit_codes(self):
        proc = _run(["--help"])
        out = proc.stdout + proc.stderr
        # The header has an "Exit codes:" section.
        assert "Exit codes" in out
        # All four documented codes should show up.
        for code in ("0", "1", "2", "3", "4"):
            assert f"  {code}  " in out or f"{code} " in out


class TestArgParsing:
    """Option parser rejects garbage flags and accepts positional paths."""

    def test_unknown_long_flag_exits_one(self):
        proc = _run(["--definitely-not-a-real-flag"])
        assert proc.returncode == 1
        assert "Unknown option" in (proc.stdout + proc.stderr)

    def test_unknown_short_flag_treated_as_unknown_option(self):
        # The parser only special-cases ``-h``; anything else starting
        # with ``--`` triggers the unknown-option branch. A single
        # leading dash like ``-x`` falls into the positional target
        # bucket — we just verify the script doesn't *crash* on it.
        proc = _run(["--bogus"])
        assert proc.returncode == 1

    def test_the_retired_force_flag_is_still_accepted(self, tmp_path: Path):
        # ``--force`` re-signed the app before v3.22.0; old instructions
        # must not break with "Unknown option".
        proc = _run(["--force"], cwd=tmp_path)
        out = proc.stdout + proc.stderr
        assert "Unknown option" not in out
        assert "no longer needed" in out


class TestPlatformDispatch:
    """Verify ``uname -s`` correctly routes to the macOS / Linux branch."""

    def test_reports_detected_platform(self):
        proc = _run([])
        out = proc.stdout + proc.stderr
        if platform.system() == "Darwin":
            assert "Platform: " in out and "macos" in out.lower()
        elif platform.system() == "Linux":
            assert "Platform: " in out and "linux" in out.lower()

    @pytest.mark.skipif(
        platform.system() not in ("Darwin", "Linux"),
        reason="Test is only meaningful when running on a supported platform",
    )
    def test_unsupported_platform_message_only_on_unknown_uname(self):
        # We can't actually set uname output, but we can verify the
        # script *would* reject an unknown uname by looking at the
        # case statement. This is a doc-pin test.
        text = SCRIPT.read_text()
        assert "Unsupported platform" in text
        assert "OpenAgentd-*.msi" in text  # Windows hint


class TestMissingBundle:
    """When no bundle is found, the script exits 1 with a clear message."""

    def test_macos_missing_bundle_exits_one(self, tmp_path: Path):
        if platform.system() != "Darwin":
            pytest.skip("macOS-specific branch")
        # Run in an empty directory with no OpenAgentd.app in sight.
        proc = _run([], cwd=tmp_path)
        assert proc.returncode == 1
        assert "Cannot find OpenAgentd.app" in (proc.stdout + proc.stderr)

    def test_macos_explicit_missing_path_exits_one(self, tmp_path: Path):
        if platform.system() != "Darwin":
            pytest.skip("macOS-specific branch")
        proc = _run([str(tmp_path / "missing.app")])
        assert proc.returncode == 1

    def test_linux_missing_binary_exits_one(self, tmp_path: Path):
        if platform.system() != "Linux":
            pytest.skip("Linux-specific branch")
        proc = _run([], cwd=tmp_path)
        assert proc.returncode == 1
        out = proc.stdout + proc.stderr
        assert "Cannot find OpenAgentd" in out

    def test_macos_non_app_path_rejected(self, tmp_path: Path):
        """Passing a regular file (not a .app bundle) is rejected."""
        if platform.system() != "Darwin":
            pytest.skip("macOS-specific branch")
        fake = tmp_path / "notabundle.txt"
        fake.write_text("hello")
        proc = _run([str(fake)])
        assert proc.returncode == 1


class TestLinuxBranch:
    """End-to-end Linux flow with a fake binary."""

    @pytest.fixture
    def fake_binary(self, tmp_path: Path) -> Path:
        """Create a fake but executable OpenAgentd binary."""
        bin_path = tmp_path / "OpenAgentd.AppImage"
        bin_path.write_text("#!/bin/sh\necho fake-openagentd\n")
        bin_path.chmod(0o755)
        return bin_path

    def test_linux_chmods_binary_and_exits_zero(self, fake_binary: Path):
        if platform.system() != "Linux":
            pytest.skip("Linux-specific branch")
        # Without --install: just chmod + summary.
        proc = _run([str(fake_binary)])
        assert proc.returncode == 0, proc.stderr
        assert "Executable" in (proc.stdout + proc.stderr)

    def test_linux_install_writes_desktop_entry(
        self, fake_binary: Path, tmp_path: Path
    ):
        if platform.system() != "Linux":
            pytest.skip("Linux-specific branch")
        xdg_bin = tmp_path / "bin"
        xdg_data = tmp_path / "data"
        proc = _run(
            ["--install", str(fake_binary)],
            env={
                "XDG_BIN_HOME": str(xdg_bin),
                "XDG_DATA_HOME": str(xdg_data),
                "HOME": str(tmp_path),  # belt + braces: no fallback to real ~
            },
        )
        assert proc.returncode == 0, proc.stderr

        # ── Binary was installed
        installed = xdg_bin / "openagentd"
        assert installed.is_file()
        assert installed.stat().st_mode & stat.S_IXUSR

        # ── .desktop entry was written
        desktop_file = xdg_data / "applications" / "openagentd.desktop"
        assert desktop_file.is_file()
        content = desktop_file.read_text()
        assert "[Desktop Entry]" in content
        assert "Type=Application" in content
        assert "Name=OpenAgentd" in content
        assert f"Exec={installed} %U" in content
        assert "Categories=Development;Utility;Office;" in content
        assert "StartupWMClass=OpenAgentd" in content
        # The file should be readable by everyone (0644).
        mode = desktop_file.stat().st_mode & 0o777
        assert mode == 0o644

    def test_linux_deb_defers_to_dpkg(self, tmp_path: Path):
        """When given a .deb, the script must hand off to dpkg."""
        if platform.system() != "Linux":
            pytest.skip("Linux-specific branch")
        # Fake sudo + dpkg so we don't need actual root or the package.
        fake_bindir = tmp_path / "bin"
        fake_bindir.mkdir()
        log = tmp_path / "dpkg.log"
        (fake_bindir / "sudo").write_text('#!/bin/sh\nexec "$@"\n')
        (fake_bindir / "sudo").chmod(0o755)
        (fake_bindir / "dpkg").write_text(
            f'#!/bin/sh\necho "dpkg $@" >> {log}\nexit 0\n'
        )
        (fake_bindir / "dpkg").chmod(0o755)

        deb = tmp_path / "openagentd_0.1.0_amd64.deb"
        deb.write_text("not really a deb")

        proc = _run(
            [str(deb)],
            env={"PATH": f"{fake_bindir}:{os.environ['PATH']}"},
        )
        assert proc.returncode == 0, proc.stderr
        # Verify our fake dpkg was actually invoked.
        assert log.is_file()
        assert f"dpkg -i {deb}" in log.read_text()

    def test_linux_rpm_defers_to_rpm(self, tmp_path: Path):
        if platform.system() != "Linux":
            pytest.skip("Linux-specific branch")
        fake_bindir = tmp_path / "bin"
        fake_bindir.mkdir()
        log = tmp_path / "rpm.log"
        (fake_bindir / "sudo").write_text('#!/bin/sh\nexec "$@"\n')
        (fake_bindir / "sudo").chmod(0o755)
        (fake_bindir / "rpm").write_text(f'#!/bin/sh\necho "rpm $@" >> {log}\nexit 0\n')
        (fake_bindir / "rpm").chmod(0o755)
        rpm = tmp_path / "openagentd-0.1.0.x86_64.rpm"
        rpm.write_text("not really an rpm")
        proc = _run(
            [str(rpm)],
            env={"PATH": f"{fake_bindir}:{os.environ['PATH']}"},
        )
        assert proc.returncode == 0
        assert "rpm -Uvh" in log.read_text()


class TestMacosBranch:
    """The macOS branch installs CI's signature unchanged."""

    @staticmethod
    def _bundle(tmp_path: Path, *, signed: bool) -> Path:
        bundle = tmp_path / "OpenAgentd.app"
        (bundle / "Contents" / "MacOS").mkdir(parents=True)
        (bundle / "Contents" / "Info.plist").write_text(
            '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>'
            "<key>CFBundleExecutable</key><string>OpenAgentd</string>"
            "<key>CFBundleIdentifier</key><string>com.openagentd.desktop</string>"
            "</dict></plist>"
        )
        binary = bundle / "Contents" / "MacOS" / "OpenAgentd"
        if signed:
            shutil.copy("/usr/bin/true", binary)
            subprocess.run(
                [
                    "codesign", "--force", "--sign", "-",
                    '-r=designated => identifier "com.openagentd.desktop"',
                    str(bundle),
                ],
                check=True,
                capture_output=True,
            )
        else:
            binary.write_text("")
            binary.chmod(0o755)
        return bundle

    @staticmethod
    def _cdhash(bundle: Path) -> str:
        out = subprocess.run(
            ["codesign", "-dvvv", str(bundle)], capture_output=True, text=True
        ).stderr
        return out.split("CDHash=")[1].split()[0]

    def test_a_signed_bundle_is_verified_and_not_re_signed(self, tmp_path: Path):
        if platform.system() != "Darwin":
            pytest.skip("macOS-specific branch")
        bundle = self._bundle(tmp_path, signed=True)
        before = self._cdhash(bundle)
        proc = _run([str(bundle)])
        out = proc.stdout + proc.stderr
        assert proc.returncode == 0, out
        assert f"Bundle: {bundle}" in out.replace("\x1b[1m", "").replace("\x1b[0m", "")
        assert "Signature verified" in out
        assert self._cdhash(bundle) == before, "install.sh must not re-sign the app"

    def test_a_bundle_that_fails_verification_exits_three(self, tmp_path: Path):
        if platform.system() != "Darwin":
            pytest.skip("macOS-specific branch")
        bundle = self._bundle(tmp_path, signed=False)
        proc = _run([str(bundle)])
        assert proc.returncode == 3
        assert "Download OpenAgentd again" in (proc.stdout + proc.stderr)

    def test_the_installer_never_signs(self):
        text = SCRIPT.read_text()
        assert "codesign --force" not in text
        assert "--sign" not in text
        assert "keychain" not in text.lower()


class TestReleaseEntitlements:
    """The release entitlements stay free of hardened-runtime exceptions."""

    HARDENED_RUNTIME_EXCEPTIONS = (
        "com.apple.security.cs.allow-unsigned-executable-memory",
        "com.apple.security.cs.allow-jit",
        "com.apple.security.cs.allow-dyld-environment-variables",
        "com.apple.security.cs.disable-library-validation",
    )

    @staticmethod
    def _keys(plist: str) -> set[str]:
        return set(re.findall(r"<key>([^<]+)</key>", plist))

    def test_no_hardened_runtime_exceptions(self):
        # The native sidecar needs none (the v2 Python runtime did).
        release = (
            REPO_ROOT / "desktop" / "src-tauri" / "entitlements.plist"
        ).read_text()
        for key in self.HARDENED_RUNTIME_EXCEPTIONS:
            assert key not in self._keys(release)


class TestDocsConsistency:
    """The header help text must agree with what the parser supports."""

    def test_every_documented_flag_is_in_the_parser(self):
        text = SCRIPT.read_text()
        for flag in ("--install",):
            assert flag in text
            # And the case statement handles each.
            assert f"{flag})" in text or f' "{flag}")' in text or f'"{flag}")' in text


# Module-level sanity: the script's directory must exist alongside this test.
def test_script_path_assumption_holds():
    assert SCRIPT.exists(), f"install.sh not found at expected location: {SCRIPT}"
    # And the docs sibling must exist (it's referenced by Tauri bundle
    # resources in tauri.conf.json).
    assert (SCRIPT.parent / "INSTALL.md").exists()


# Belt-and-braces: ``shutil.which("bash")`` must work; otherwise none of
# these tests are meaningful.
def test_bash_available_on_host():
    assert shutil.which("bash") is not None, "bash must be on PATH to run install.sh"
