from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

import pytest
import yaml


REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = REPO_ROOT / ".github" / "workflows"


def _load(name: str) -> dict:
    return yaml.load((WORKFLOWS / name).read_text(), Loader=yaml.BaseLoader)


def _step(job: dict, name: str) -> dict:
    return next(step for step in job["steps"] if step.get("name") == name)


def _condition(job: dict, inputs: dict, results: dict) -> bool:
    """Evaluate a job's ``if:`` for the few expression forms the release uses."""
    expr = job["if"].strip()
    if expr.startswith("${{"):
        expr = expr[3:-2]
    values = {
        **{f"github.event.inputs.{k}": v for k, v in inputs.items()},
        **{f"needs.{k}.result": v for k, v in results.items()},
    }
    expr = re.sub(r"\b(?:github|needs)\.[\w.-]+", lambda m: repr(values[m.group(0)]), expr)
    expr = expr.replace("&&", " and ").replace("||", " or ")
    expr = re.sub(r"!(?!=)", " not ", expr)
    scope = {
        "always": lambda: True,
        "cancelled": lambda: False,
        "contains": lambda haystack, needle: needle in haystack,
        "fromJSON": json.loads,
    }
    return bool(eval(expr, scope))  # noqa: S307 - the workflow file is trusted


def test_release_dispatch_and_matrix_include_windows_x64_msi():
    workflow = _load("release-desktop.yml")
    options = workflow["on"]["workflow_dispatch"]["inputs"]["platform"]["options"]
    # The matrix-producing step is identified by id rather than display name.
    matrix_script = next(
        step["run"]
        for step in workflow["jobs"]["prepare"]["steps"]
        if step.get("id") == "matrix"
    )

    assert "windows" in options
    # One entry belongs to `all`, the other to the dedicated `windows` case.
    assert matrix_script.count('"runner":"windows-2025"') == 2
    assert matrix_script.count('"rust_target":"x86_64-pc-windows-msvc"') == 2
    assert matrix_script.count('"tauri_args":"--bundles msi --verbose"') == 2


def test_release_verifies_windows_installer_and_updater_signature():
    workflow = _load("release-desktop.yml")
    build = workflow["jobs"]["build"]
    verify_script = _step(build, "Verify Windows MSI")["run"]
    # The updater .sig is made by the sign job, which holds the key, from the
    # MSI that sign-windows uploads (signing changes the MSI's bytes).
    sig_step = _step(workflow["jobs"]["sign"], "Sign Windows updater artifact")
    sig_script = sig_step["run"]
    manifest_script = _step(
        workflow["jobs"]["publish"],
        "Generate latest.json (Tauri updater manifest)",
    )["run"]

    assert "Expected exactly one OpenAgentd MSI" in verify_script
    assert "_in/openagentd-desktop-windows-*/OpenAgentd_*.msi" in sig_step["if"]
    assert "_in/openagentd-desktop-windows-*/OpenAgentd_*.msi" in sig_script
    assert "cargo tauri signer sign" in sig_script
    assert "TAURI_SIGNING_PRIVATE_KEY is not set" in sig_script
    assert "--require-platform windows-x86_64" in manifest_script


def test_windows_build_artifact_is_never_published_unsigned():
    workflow = _load("release-desktop.yml")
    text = (WORKFLOWS / "release-desktop.yml").read_text()
    upload = workflow["jobs"]["build"]["steps"][-1]
    publish_download = next(
        step for step in workflow["jobs"]["publish"]["steps"]
        if step.get("uses", "").startswith("actions/download-artifact@")
    )

    assert upload["with"]["name"].startswith(
        "${{ matrix.platform == 'linux' && 'openagentd' || 'unsigned' }}-desktop-"
    )
    assert publish_download["with"]["pattern"] == "openagentd-desktop-*"
    # The self-managed certificate path is gone; SignPath signs instead.
    assert "Import Windows Authenticode certificate" not in text
    assert "WINDOWS_CERTIFICATE" not in text
    assert "signtool" not in text


def test_sign_windows_submits_to_signpath_from_repository_variables():
    workflow = _load("release-desktop.yml")
    text = (WORKFLOWS / "release-desktop.yml").read_text()
    job = workflow["jobs"]["sign-windows"]
    submit = _step(job, "Sign with SignPath")
    verify = _step(job, "Verify the signatures")["run"]
    output = job["steps"][-1]

    assert job["needs"] == ["prepare", "build"]
    assert job["runs-on"] == "windows-2025"
    assert job["permissions"] == {"contents": "read", "actions": "read"}
    assert "environment" not in job
    assert job["steps"][0]["with"]["name"] == "unsigned-desktop-windows-x86_64"
    assert submit["uses"].startswith("signpath/github-action-submit-signing-request@")
    assert submit["if"] == "steps.mode.outputs.submit == 'true'"
    inputs = submit["with"]
    assert inputs["api-token"] == "${{ secrets.SIGNPATH_API_TOKEN }}"
    # A secret, so GitHub masks the organization id in public logs.
    assert inputs["organization-id"] == "${{ secrets.SIGNPATH_ORGANIZATION_ID }}"
    for name, var in {
        "project-slug": "SIGNPATH_PROJECT_SLUG",
        "signing-policy-slug": "SIGNPATH_SIGNING_POLICY_SLUG",
        "artifact-configuration-slug": "SIGNPATH_ARTIFACT_CONFIGURATION_SLUG",
    }.items():
        assert inputs[name] == f"${{{{ vars.{var} }}}}"
    assert inputs["github-artifact-id"] == "${{ steps.upload.outputs.artifact-id }}"
    assert inputs["wait-for-completion"] == "true"
    assert inputs["wait-for-completion-timeout-in-seconds"] == "3600"
    assert inputs["output-artifact-directory"] == "_signed"
    assert "version: ${{ toJSON(needs.prepare.outputs.version) }}" in inputs["parameters"]
    # SignPath's artifact configuration names the MSI with that same version.
    assert _step(job, "Upload the signing request")["with"]["path"] == (
        "_in/OpenAgentd_${{ needs.prepare.outputs.version }}_x64_en-US.msi"
    )
    # The job outlives the 60 min wait, and no SignPath id is written here.
    assert int(job["timeout-minutes"]) > 60
    assert not re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", text)
    # All three files are checked; a published signature must be trusted.
    for name in ("OpenAgentd.exe", "agentd.exe", "msiexec.exe", "Get-AuthenticodeSignature"):
        assert name in verify
    assert "$env:POLICY -eq 'release-signing' -and $sig.Status -ne 'Valid'" in verify
    assert output["with"]["name"] == "openagentd-desktop-windows-x86_64"
    assert output["with"]["path"] == (
        "${{ steps.mode.outputs.submit == 'true' && '_signed' || '_in' }}/OpenAgentd_*.msi"
    )


@pytest.mark.parametrize(
    ("policy", "platform", "submit"),
    [
        ("", "all", "false"),
        ("off", "windows", "false"),
        # The test certificate only signs runs that cannot publish.
        ("test-signing", "all", "false"),
        ("test-signing", "windows", "true"),
        ("release-signing", "all", "true"),
        ("release-signing", "windows", "true"),
        ("typo", "all", None),
    ],
)
def test_signing_policy_selects_whether_a_request_is_sent(tmp_path, policy, platform, submit):
    script = _step(_load("release-desktop.yml")["jobs"]["sign-windows"], "Choose the signing mode")["run"]
    out = tmp_path / "out"
    result = subprocess.run(
        ["bash", "-c", script],
        env={"POLICY": policy, "PLATFORM": platform, "GITHUB_OUTPUT": str(out), "PATH": "/usr/bin:/bin"},
        capture_output=True,
        text=True,
        check=False,
    )
    if submit is None:
        assert result.returncode != 0
        assert "SIGNPATH_SIGNING_POLICY_SLUG must be" in result.stdout
    else:
        assert result.returncode == 0, result.stderr
        assert out.read_text() == f"submit={submit}\n"


OK = "success"
SKIP = "skipped"


@pytest.mark.parametrize(
    ("inputs", "results", "runs"),
    [
        # Full release: Windows is signed (or passed through) before sign and publish.
        (
            {"platform": "all", "run_id": ""},
            {"prepare": OK, "build": OK, "sign-windows": OK, "sign": OK},
            {"sign-windows": True, "sign": True, "publish": True},
        ),
        # A rejected or timed-out SignPath request stops the whole release.
        (
            {"platform": "all", "run_id": ""},
            {"prepare": OK, "build": OK, "sign-windows": "failure", "sign": SKIP},
            {"sign-windows": True, "sign": False, "publish": False},
        ),
        # The Windows-only test run signs but never reaches sign or publish.
        (
            {"platform": "windows", "run_id": ""},
            {"prepare": OK, "build": OK, "sign-windows": OK, "sign": SKIP},
            {"sign-windows": True, "sign": False, "publish": False},
        ),
        # macOS-only: no Windows MSI to sign, the sign job still runs.
        (
            {"platform": "macos", "run_id": ""},
            {"prepare": OK, "build": OK, "sign-windows": SKIP, "sign": OK},
            {"sign-windows": False, "sign": True, "publish": False},
        ),
        (
            {"platform": "linux", "run_id": ""},
            {"prepare": OK, "build": OK, "sign-windows": SKIP, "sign": SKIP},
            {"sign-windows": False, "sign": False, "publish": False},
        ),
        # Publishing an earlier run's artifacts runs neither signing job.
        (
            {"platform": "all", "run_id": "123"},
            {"prepare": OK, "build": SKIP, "sign-windows": SKIP, "sign": SKIP},
            {"sign-windows": False, "sign": False, "publish": True},
        ),
        (
            {"platform": "windows", "run_id": "123"},
            {"prepare": OK, "build": SKIP, "sign-windows": SKIP, "sign": SKIP},
            {"sign-windows": False, "sign": False, "publish": True},
        ),
    ],
)
def test_release_job_gating(inputs, results, runs):
    jobs = _load("release-desktop.yml")["jobs"]

    assert jobs["sign"]["needs"] == ["prepare", "build", "sign-windows"]
    assert jobs["publish"]["needs"] == ["prepare", "build", "sign-windows", "sign"]
    for job_id, expected in runs.items():
        assert _condition(jobs[job_id], inputs, results) is expected, job_id


def test_windows_ci_runs_native_rust_checks():
    tauri = _load("tauri.yml")
    native = tauri["jobs"]["desktop-windows"]

    assert native["runs-on"] == "windows-2025"
    assert _step(native, "Cargo check")["run"]
    assert _step(native, "Cargo test")["run"]
    assert _step(native, "Cargo clippy")["run"]
