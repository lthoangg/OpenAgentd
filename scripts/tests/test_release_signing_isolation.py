"""Signing secrets stay out of release build jobs.

Build jobs run third-party code (build.rs, npm scripts), so only the short
signing jobs, gated by a protected environment, may read the Apple
certificates, notary/App Store Connect keys and the updater key.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

WORKFLOWS = Path(__file__).resolve().parents[2] / ".github" / "workflows"
SIGNING_SECRET = re.compile(
    r"secrets\.(APPLE_\w+|ASC_\w+|IOS_\w+|KEYCHAIN_PASSWORD|TAURI_SIGNING_\w+)"
)
# workflow -> {signing job: environment}
SIGNING_JOBS = {
    "release-desktop.yml": {"sign": "release-macos"},
    # internal builds sign in an unreviewed environment, public ones in the
    # approved one; the build job still never sees a secret.
    "release-ios.yml": {
        "sign": "${{ inputs.channel == 'public' && 'release-ios' || 'testflight-internal' }}"
    },
}


def _jobs(name: str) -> dict:
    return yaml.safe_load((WORKFLOWS / name).read_text(encoding="utf-8"))["jobs"]


@pytest.mark.parametrize("workflow", sorted(SIGNING_JOBS))
def test_only_the_signing_job_reads_signing_secrets(workflow: str) -> None:
    for job_id, job in _jobs(workflow).items():
        text = yaml.safe_dump(job)
        if job_id in SIGNING_JOBS[workflow]:
            assert job.get("environment") == SIGNING_JOBS[workflow][job_id]
            continue
        assert "environment" not in job, f"{workflow}:{job_id} must not use an environment"
        assert not SIGNING_SECRET.search(text), f"{workflow}:{job_id} reads a signing secret"


def test_no_other_workflow_reads_signing_secrets() -> None:
    for path in WORKFLOWS.glob("*.yml"):
        if path.name in SIGNING_JOBS:
            continue
        assert not SIGNING_SECRET.search(path.read_text(encoding="utf-8")), path.name
