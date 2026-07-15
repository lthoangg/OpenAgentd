from __future__ import annotations

import importlib.util
import json
from pathlib import Path


def _load_manifest_module():
    path = Path(__file__).resolve().parents[2] / "scripts" / "make_updater_manifest.py"
    spec = importlib.util.spec_from_file_location("make_updater_manifest", path)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_default_manifest_urls_point_at_shared_release_tag(tmp_path, monkeypatch):
    module = _load_manifest_module()
    artefact_dir = tmp_path / "artefacts"
    artefact_dir.mkdir()
    (artefact_dir / "OpenAgentd.app.tar.gz").write_text("tar")
    (artefact_dir / "OpenAgentd.app.tar.gz.sig").write_text("minisign-signature")
    out = tmp_path / "latest.json"

    monkeypatch.setattr(
        "sys.argv",
        [
            "make_updater_manifest.py",
            "--version",
            "1.2.0",
            "--artefact-dir",
            str(artefact_dir),
            "--out",
            str(out),
            "--require-platform",
            "darwin-aarch64",
        ],
    )
    monkeypatch.setenv("GITHUB_REPOSITORY", "lthoangg/OpenAgentd")

    assert module.main() == 0

    manifest = json.loads(out.read_text())
    assert manifest["platforms"]["darwin-aarch64"]["url"] == (
        "https://github.com/lthoangg/OpenAgentd/releases/download/"
        "v1.2.0/OpenAgentd.app.tar.gz"
    )
    assert manifest["platforms"]["darwin-aarch64"]["signature"] == "minisign-signature"


def test_manifest_includes_windows_nsis_updater(tmp_path, monkeypatch):
    module = _load_manifest_module()
    monkeypatch.delenv("GITHUB_REPOSITORY", raising=False)
    artefact_dir = tmp_path / "artefacts"
    artefact_dir.mkdir()
    installer = artefact_dir / "OpenAgentd_1.2.0_x64-setup.exe"
    installer.write_text("nsis")
    (artefact_dir / f"{installer.name}.sig").write_text("windows-signature")
    out = tmp_path / "latest.json"

    monkeypatch.setattr(
        "sys.argv",
        [
            "make_updater_manifest.py",
            "--version",
            "1.2.0",
            "--artefact-dir",
            str(artefact_dir),
            "--out",
            str(out),
            "--require-platform",
            "windows-x86_64",
        ],
    )

    assert module.main() == 0

    manifest = json.loads(out.read_text())
    assert manifest["platforms"]["windows-x86_64"] == {
        "url": (
            "https://github.com/lthoangg/openagentd/releases/download/"
            "v1.2.0/OpenAgentd_1.2.0_x64-setup.exe"
        ),
        "signature": "windows-signature",
    }


def test_manifest_includes_windows_msi_updater(tmp_path, monkeypatch):
    module = _load_manifest_module()
    monkeypatch.delenv("GITHUB_REPOSITORY", raising=False)
    artefact_dir = tmp_path / "artefacts"
    artefact_dir.mkdir()
    installer = artefact_dir / "OpenAgentd_1.2.0_x64_en-US.msi"
    installer.write_text("msi")
    (artefact_dir / f"{installer.name}.sig").write_text("msi-signature")
    out = tmp_path / "latest.json"

    monkeypatch.setattr(
        "sys.argv",
        [
            "make_updater_manifest.py",
            "--version",
            "1.2.0",
            "--artefact-dir",
            str(artefact_dir),
            "--out",
            str(out),
            "--require-platform",
            "windows-x86_64",
        ],
    )

    assert module.main() == 0

    manifest = json.loads(out.read_text())
    assert manifest["platforms"]["windows-x86_64"] == {
        "url": (
            "https://github.com/lthoangg/openagentd/releases/download/"
            "v1.2.0/OpenAgentd_1.2.0_x64_en-US.msi"
        ),
        "signature": "msi-signature",
    }


def test_manifest_combines_macos_and_windows_release_artifacts(tmp_path):
    module = _load_manifest_module()
    artifacts = [
        tmp_path / "OpenAgentd.app.tar.gz",
        tmp_path / "OpenAgentd_1.2.0_x64_en-US.msi",
    ]
    for artifact in artifacts:
        artifact.write_text("artifact")
        (tmp_path / f"{artifact.name}.sig").write_text("signature")

    platforms = module._build_platforms(tmp_path, "https://example.invalid")

    assert set(platforms) == {"darwin-aarch64", "windows-x86_64"}


def test_manifest_prefers_nsis_when_both_windows_installers_exist(tmp_path):
    module = _load_manifest_module()
    nsis = tmp_path / "OpenAgentd_1.2.0_x64-setup.exe"
    msi = tmp_path / "OpenAgentd_1.2.0_x64_en-US.msi"
    for artefact in (nsis, msi):
        artefact.write_text("installer")
        (tmp_path / f"{artefact.name}.sig").write_text(f"sig-{artefact.suffix}")

    platforms = module._build_platforms(tmp_path, "https://example.invalid")

    assert platforms["windows-x86_64"]["url"].endswith(nsis.name)


def test_manifest_fails_when_updater_signature_is_missing(
    tmp_path, monkeypatch, capsys
):
    module = _load_manifest_module()
    artefact_dir = tmp_path / "artefacts"
    artefact_dir.mkdir()
    (artefact_dir / "OpenAgentd.app.tar.gz").write_text("tar")
    out = tmp_path / "latest.json"

    monkeypatch.setattr(
        "sys.argv",
        [
            "make_updater_manifest.py",
            "--version",
            "1.2.0",
            "--artefact-dir",
            str(artefact_dir),
            "--out",
            str(out),
        ],
    )

    assert module.main() == 1
    assert (
        "missing updater signature for OpenAgentd.app.tar.gz" in capsys.readouterr().err
    )
    assert not out.exists()


def test_manifest_fails_when_required_platform_is_missing(
    tmp_path, monkeypatch, capsys
):
    module = _load_manifest_module()
    artefact_dir = tmp_path / "artefacts"
    artefact_dir.mkdir()
    # Provide a Linux artefact so the script *does* build a non-empty
    # platform map; the assertion is then that requiring a missing
    # platform (darwin-aarch64) is what trips the failure.
    (artefact_dir / "OpenAgentd_1.2.0_amd64.AppImage").write_text("appimage")
    (artefact_dir / "OpenAgentd_1.2.0_amd64.AppImage.sig").write_text("sig")
    out = tmp_path / "latest.json"

    monkeypatch.setattr(
        "sys.argv",
        [
            "make_updater_manifest.py",
            "--version",
            "1.2.0",
            "--artefact-dir",
            str(artefact_dir),
            "--out",
            str(out),
            "--require-platform",
            "darwin-aarch64",
        ],
    )

    assert module.main() == 1
    assert (
        "missing required updater platform(s): darwin-aarch64"
        in capsys.readouterr().err
    )
    assert not out.exists()
