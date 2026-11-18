"""The iOS archive is built with an SDK App Store Connect still accepts.

Apple warned on build 49 (ITMS-90725) that from April 2027 uploads need the
iOS 27 SDK (Xcode 27). The build job runs on GitHub's xcode-27 image, and the
Package step refuses an archive built with an older SDK, so a runner change
cannot slip an old SDK through unnoticed.
"""

from __future__ import annotations

from pathlib import Path

import yaml


WORKFLOW = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "release-ios.yml"


def _build_job() -> dict:
    return yaml.load(WORKFLOW.read_text(), Loader=yaml.BaseLoader)["jobs"]["build"]


def test_the_archive_is_built_on_the_xcode_27_image():
    assert _build_job()["runs-on"] == "xcode-27"


def test_packaging_refuses_an_archive_from_an_sdk_older_than_ios_27():
    package = next(step["run"] for step in _build_job()["steps"] if step.get("name") == "Package")
    assert "DTPlatformVersion" in package
    assert "MIN_IOS_SDK=27" in package
