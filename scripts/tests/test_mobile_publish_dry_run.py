"""Tests for ``mobile/scripts/publish-ipa.sh`` and ``publish-apk.sh`` dry runs.

The release skill builds both mobile apps with ``DRY_RUN=1`` while the version
PR's CI runs, before ``release.yml`` has created the tag. v3.32.0's dry runs
built the apps and then stopped on "tag does not exist", so a dry run could
not pass before tagging. Real runs must still refuse a missing tag.

Each test runs the script in a throw-away git repository with a fake ``gh``
that knows no release, at version 9.9.9, which has no tag.
"""

from __future__ import annotations

import hashlib
import os
import plistlib
import shutil
import subprocess
import zipfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
VERSION = "9.9.9"

FAKE_GH = """#!/bin/sh
echo "$*" >> "$GH_LOG"
case "$1 $2" in
  "release view"|"release download") exit 1 ;;
  "release upload"|"release create"|"release edit") exit 99 ;;
esac
exit 0
"""

FAKE_APKSIGNER = """#!/bin/sh
echo "Signer #1 certificate DN: CN=OpenAgentd Release"
"""


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@t", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def _write_artifact(dist: Path, name: str, data: bytes) -> None:
    (dist / name).write_bytes(data)
    digest = hashlib.sha256(data).hexdigest()
    (dist / f"{name}.sha256").write_text(f"{digest}  {name}\n")


def _ipa_bytes(tmp_path: Path) -> bytes:
    ipa = tmp_path / "app.ipa"
    with zipfile.ZipFile(ipa, "w") as archive:
        archive.writestr(
            "Payload/OpenAgentd.app/Info.plist",
            plistlib.dumps(
                {
                    "CFBundleIdentifier": "com.openagentd.mobile",
                    "CFBundleShortVersionString": VERSION,
                    "CFBundleVersion": VERSION,
                }
            ),
        )
    return ipa.read_bytes()


@pytest.fixture
def sandbox(tmp_path: Path) -> dict:
    """A repo laid out like this one, its origin, and an environment for the scripts."""
    root = tmp_path / "repo"
    (root / "scripts").mkdir(parents=True)
    (root / "mobile" / "scripts").mkdir(parents=True)
    dist = root / "mobile" / "dist"
    dist.mkdir()
    for name in ("publish-ipa.sh", "publish-apk.sh"):
        shutil.copy(REPO_ROOT / "mobile" / "scripts" / name, root / "mobile" / "scripts" / name)
    shutil.copy(REPO_ROOT / "scripts" / "make_sidestore_source.py", root / "scripts")
    version_script = root / "scripts" / "release_version.sh"
    version_script.write_text(f"#!/bin/sh\necho {VERSION}\n")
    version_script.chmod(0o755)
    (root / ".gitignore").write_text("mobile/dist/\n")

    _git(tmp_path, "init", "-q", "--bare", "origin.git")
    _git(root.parent, "init", "-q", str(root))
    _git(root, "add", ".")
    _git(root, "commit", "-q", "-m", "init")
    _git(root, "remote", "add", "origin", str(tmp_path / "origin.git"))
    _git(root, "push", "-q", "origin", "HEAD")

    _write_artifact(dist, f"OpenAgentd_{VERSION}_iOS.ipa", _ipa_bytes(tmp_path))
    _write_artifact(dist, f"OpenAgentd_{VERSION}_Android.apk", b"apk")

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "gh").write_text(FAKE_GH)
    (bin_dir / "gh").chmod(0o755)
    build_tools = tmp_path / "android-sdk" / "build-tools" / "35.0.0"
    build_tools.mkdir(parents=True)
    (build_tools / "apksigner").write_text(FAKE_APKSIGNER)
    (build_tools / "apksigner").chmod(0o755)

    env = {
        **os.environ,
        "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
        "GH_LOG": str(tmp_path / "gh.log"),
        "ANDROID_HOME": str(tmp_path / "android-sdk"),
        "GIT_CONFIG_GLOBAL": os.devnull,
    }
    env.pop("DRY_RUN", None)
    return {"root": root, "env": env, "gh_log": tmp_path / "gh.log"}


def _publish(sandbox: dict, script: str, *, dry_run: bool) -> subprocess.CompletedProcess:
    env = dict(sandbox["env"])
    if dry_run:
        env["DRY_RUN"] = "1"
    return subprocess.run(
        [f"./scripts/{script}"],
        cwd=sandbox["root"] / "mobile",
        env=env,
        capture_output=True,
        text=True,
    )


def _gh_calls(sandbox: dict) -> str:
    log = sandbox["gh_log"]
    return log.read_text() if log.exists() else ""


@pytest.mark.parametrize("script", ["publish-ipa.sh", "publish-apk.sh"])
def test_dry_run_passes_before_the_tag_exists(sandbox: dict, script: str):
    result = _publish(sandbox, script, dry_run=True)

    assert result.returncode == 0, result.stderr
    assert "dry run complete" in result.stdout
    assert f"tag v{VERSION} does not exist yet" in result.stderr
    assert "release upload" not in _gh_calls(sandbox)


def test_ipa_dry_run_before_the_tag_still_writes_the_source_feed(sandbox: dict):
    result = _publish(sandbox, "publish-ipa.sh", dry_run=True)

    assert result.returncode == 0, result.stderr
    assert (sandbox["root"] / "mobile" / "dist" / "source.json").is_file()


@pytest.mark.parametrize("script", ["publish-ipa.sh", "publish-apk.sh"])
def test_real_run_refuses_a_missing_tag(sandbox: dict, script: str):
    result = _publish(sandbox, script, dry_run=False)

    assert result.returncode != 0
    assert f"tag v{VERSION} does not exist (run release.yml first)" in result.stderr


@pytest.mark.parametrize("script", ["publish-ipa.sh", "publish-apk.sh"])
def test_dry_run_still_refuses_a_head_that_is_not_the_tag(sandbox: dict, script: str):
    root = sandbox["root"]
    _git(root, "tag", f"v{VERSION}")
    _git(root, "push", "-q", "origin", f"v{VERSION}")
    _git(root, "commit", "-q", "--allow-empty", "-m", "after the tag")

    result = _publish(sandbox, script, dry_run=True)

    assert result.returncode != 0
    assert f"HEAD is not v{VERSION}" in result.stderr
