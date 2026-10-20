"""Tests for ``desktop/scripts/sign-macos-release.sh``.

CI signs the macOS app once; the updater, install.sh and the Homebrew cask
install it unchanged. So the app in the updater archive and the app in the
DMG must both verify and carry the identifier-only designated requirement
(installed v3.19-v3.21 apps re-sign anything else, which fails the updater's
signature check). v3.21.0 shipped a DMG whose app still had Tauri's
``cdhash`` requirement.
"""

from __future__ import annotations

import platform
import shutil
import subprocess
import tarfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "desktop" / "scripts" / "sign-macos-release.sh"
BUNDLE_ID = "com.openagentd.desktop"
STABLE = f'designated => identifier "{BUNDLE_ID}"'

pytestmark = pytest.mark.skipif(
    platform.system() != "Darwin" or shutil.which("hdiutil") is None,
    reason="needs macOS codesign and hdiutil",
)


def _designated(app: Path) -> str:
    out = subprocess.run(
        ["codesign", "-d", "-r", "-", str(app)], capture_output=True, text=True
    )
    for line in (out.stdout + out.stderr).splitlines():
        line = line.removeprefix("# ").strip()
        if line.startswith("designated =>"):
            return line
    return ""


def _fake_app(macos_dir: Path) -> Path:
    """A minimal app, signed ad hoc the way Tauri signs it (cdhash requirement)."""
    app = macos_dir / "OpenAgentd.app"
    (app / "Contents" / "MacOS").mkdir(parents=True)
    (app / "Contents" / "Resources").mkdir()
    shutil.copy("/usr/bin/true", app / "Contents" / "MacOS" / "OpenAgentd")
    (app / "Contents" / "Info.plist").write_text(
        '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>'
        "<key>CFBundleExecutable</key><string>OpenAgentd</string>"
        f"<key>CFBundleIdentifier</key><string>{BUNDLE_ID}</string>"
        "<key>CFBundlePackageType</key><string>APPL</string>"
        "</dict></plist>"
    )
    shutil.copy(
        REPO_ROOT / "desktop" / "src-tauri" / "entitlements.plist",
        app / "Contents" / "Resources" / "entitlements.plist",
    )
    subprocess.run(
        ["codesign", "--force", "--deep", "--options", "runtime", "--sign", "-", str(app)],
        check=True,
        capture_output=True,
    )
    assert "cdhash" in _designated(app)
    return app


@pytest.fixture
def bundle_dir(tmp_path: Path) -> Path:
    bundle = tmp_path / "bundle"
    macos_dir = bundle / "macos"
    macos_dir.mkdir(parents=True)
    app = _fake_app(macos_dir)
    with tarfile.open(macos_dir / "OpenAgentd.app.tar.gz", "w:gz") as tar:
        tar.add(app, arcname=app.name)
    # Tauri's DMG: the app next to an Applications link.
    staging = tmp_path / "staging"
    staging.mkdir()
    subprocess.run(["ditto", str(app), str(staging / app.name)], check=True)
    (staging / "Applications").symlink_to("/Applications")
    (bundle / "dmg").mkdir()
    subprocess.run(
        [
            "hdiutil", "create", "-quiet", "-volname", "OpenAgentd",
            "-srcfolder", str(staging), "-format", "UDZO",
            str(bundle / "dmg" / "OpenAgentd_0.0.0_aarch64.dmg"),
        ],
        check=True,
    )
    return bundle


def _run(bundle: Path) -> subprocess.CompletedProcess[str]:
    env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}  # no Tauri signing key
    return subprocess.run(
        ["bash", str(SCRIPT), str(bundle), BUNDLE_ID],
        capture_output=True,
        text=True,
        env=env,
        timeout=120,
    )


def test_archive_and_dmg_carry_the_same_stable_signature(bundle_dir: Path, tmp_path: Path):
    proc = _run(bundle_dir)
    assert proc.returncode == 0, proc.stdout + proc.stderr

    unpacked = tmp_path / "unpacked"
    unpacked.mkdir()
    with tarfile.open(bundle_dir / "macos" / "OpenAgentd.app.tar.gz") as tar:
        names = tar.getnames()
        tar.extractall(unpacked)
    assert not any(Path(n).name.startswith("._") for n in names)
    archived = unpacked / "OpenAgentd.app"
    assert _designated(archived) == STABLE

    dmg = next((bundle_dir / "dmg").glob("*.dmg"))
    mount = tmp_path / "mnt"
    mount.mkdir()
    subprocess.run(
        ["hdiutil", "attach", "-quiet", "-readonly", "-nobrowse", "-mountpoint", str(mount), str(dmg)],
        check=True,
    )
    try:
        in_dmg = mount / "OpenAgentd.app"
        subprocess.run(["codesign", "--verify", "--deep", "--strict", str(in_dmg)], check=True)
        assert _designated(in_dmg) == STABLE
        assert (mount / "Applications").is_symlink(), "the DMG layout is kept"
        cdhash = lambda app: subprocess.run(  # noqa: E731
            ["codesign", "-dvvv", str(app)], capture_output=True, text=True
        ).stderr.split("CDHash=")[1].split()[0]
        assert cdhash(in_dmg) == cdhash(archived), "both ship the same signed app"
    finally:
        subprocess.run(["hdiutil", "detach", "-quiet", str(mount)], check=False)


def test_a_stale_updater_signature_is_never_shipped(bundle_dir: Path):
    (bundle_dir / "macos" / "OpenAgentd.app.tar.gz.sig").write_text("old")
    proc = _run(bundle_dir)
    assert proc.returncode != 0
    assert "TAURI_SIGNING_PRIVATE_KEY" in proc.stderr
    assert not (bundle_dir / "macos" / "OpenAgentd.app.tar.gz.sig").exists()
