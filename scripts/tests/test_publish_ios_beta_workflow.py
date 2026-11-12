"""publish-ios-beta.yml sends an uploaded iOS build to the Public Beta, and nothing else."""

from __future__ import annotations

from pathlib import Path

import yaml

WORKFLOW = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "publish-ios-beta.yml"


def _job() -> dict:
    return yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))["jobs"]["publish"]


def test_it_needs_the_typed_confirmation_and_the_release_approval() -> None:
    job = _job()
    assert job["if"] == "inputs.confirm == 'release-ios'"
    assert job["environment"] == "release-ios"


def test_what_the_maintainer_types_reaches_the_shell_only_as_data() -> None:
    # An input pasted into a script would run as shell, next to the key.
    for step in _job()["steps"]:
        assert "${{" not in step.get("run", ""), step.get("name")


def test_the_version_and_build_are_checked_before_the_key_is_read() -> None:
    steps = _job()["steps"]
    reads_key = [i for i, s in enumerate(steps) if "secrets." in yaml.safe_dump(s)]
    checks = [i for i, s in enumerate(steps) if "version must look like" in s.get("run", "")]
    assert checks and reads_key and checks[0] < reads_key[0]


def test_the_key_file_is_removed_whatever_happens() -> None:
    last = _job()["steps"][-1]
    assert last["if"] == "always()"
    assert 'rm -rf "$RUNNER_TEMP/asc"' in last["run"]


def test_it_never_builds_signs_or_uploads() -> None:
    text = WORKFLOW.read_text(encoding="utf-8")
    assert "mobile/scripts/asc-public-beta.py" in text
    for word in ("altool", "codesign", "IOS_DIST_CERTIFICATE", "IOS_PROFILE", "KEYCHAIN"):
        assert word not in text, word
