from __future__ import annotations

from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = REPO_ROOT / ".github" / "workflows"


def _load(name: str) -> dict:
    return yaml.load((WORKFLOWS / name).read_text(), Loader=yaml.BaseLoader)


def _step(job: dict, name: str) -> dict:
    return next(step for step in job["steps"] if step.get("name") == name)


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
    verify_script = _step(build, "Verify Windows MSI and signatures")["run"]
    manifest_script = _step(
        workflow["jobs"]["publish"],
        "Generate latest.json (Tauri updater manifest)",
    )["run"]

    assert "Expected exactly one OpenAgentd MSI" in verify_script
    assert "signtool verify /pa /all" in verify_script
    assert "Missing Tauri updater signature" in verify_script
    assert "--require-platform windows-x86_64" in manifest_script


def test_windows_ci_runs_native_shell_sandbox_and_rust_checks():
    core = _load("core.yml")
    smoke = core["jobs"]["windows-smoke"]
    smoke_script = _step(smoke, "Verify sidecar imports and Windows runtime helpers")[
        "run"
    ]
    tauri = _load("tauri.yml")
    native = tauri["jobs"]["desktop-windows"]

    assert smoke["runs-on"] == "windows-2025"
    assert "test_windows_shell_executes_native_command" in smoke_script
    assert "test_blocks_quoted_windows_path_under_denied_root" in smoke_script
    assert native["runs-on"] == "windows-2025"
    assert _step(native, "Cargo check")["run"]
    assert _step(native, "Cargo test")["run"]
    assert _step(native, "Cargo clippy")["run"]
