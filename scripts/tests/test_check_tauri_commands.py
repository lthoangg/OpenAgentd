from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "check_tauri_commands.py"

spec = importlib.util.spec_from_file_location("check_tauri_commands", SCRIPT)
assert spec and spec.loader
mod = importlib.util.module_from_spec(spec)
sys.modules["check_tauri_commands"] = mod
spec.loader.exec_module(mod)


def make_shell(
    tmp_path: Path,
    handler: list[str],
    manifest: list[str],
    capabilities: dict[str, list[object]],
) -> Path:
    shell = tmp_path / "src-tauri"
    (shell / "src").mkdir(parents=True)
    (shell / "capabilities").mkdir()
    items = ",\n".join(f"            {name}" for name in handler)
    (shell / "src" / "lib.rs").write_text(
        "pub fn run() {\n"
        "    tauri::Builder::default()\n"
        "        // generate_handler![commented_out]\n"
        f"        .invoke_handler(tauri::generate_handler![\n{items},\n        ])\n"
        "}\n"
    )
    listed = "\n".join(f'                "{name}",' for name in manifest)
    (shell / "build.rs").write_text(
        "fn main() {\n"
        "    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(\n"
        "        // a comment with \"quoted\" text\n"
        f"        tauri_build::AppManifest::new().commands(&[\n{listed}\n            ]),\n"
        "    ))\n"
        "    .expect(\"failed\");\n"
        "}\n"
    )
    for name, permissions in capabilities.items():
        (shell / "capabilities" / f"{name}.json").write_text(
            json.dumps({"identifier": name, "permissions": permissions})
        )
    return shell


def test_consistent_shell_passes(tmp_path: Path) -> None:
    shell = make_shell(
        tmp_path,
        handler=["app_status", "cloud::cloud_sign_in", "pet::pet_fit"],
        manifest=["app_status", "cloud_sign_in", "pet_fit"],
        capabilities={
            "default": ["core:default", "allow-app-status", "allow-cloud-sign-in"],
            "pet": [{"identifier": "allow-pet-fit"}],
        },
    )
    report = mod.check_shell(shell, "src/lib.rs")
    assert report.registered == ["app_status", "cloud_sign_in", "pet_fit"]
    assert report.errors == []


def test_command_missing_from_build_rs_and_capabilities_fails(tmp_path: Path) -> None:
    shell = make_shell(
        tmp_path,
        handler=["app_status", "cloud::cloud_status"],
        manifest=["app_status"],
        capabilities={"default": ["allow-app-status"]},
    )
    errors = mod.check_shell(shell, "src/lib.rs").errors
    assert any("cloud_status" in e and "missing from build.rs" in e for e in errors)
    assert any("allow-cloud-status" in e for e in errors)
    assert len(errors) == 2


def test_command_in_build_rs_but_not_granted_fails(tmp_path: Path) -> None:
    shell = make_shell(
        tmp_path,
        handler=["cloud_status"],
        manifest=["cloud_status"],
        capabilities={"default": ["core:default"]},
    )
    errors = mod.check_shell(shell, "src/lib.rs").errors
    assert errors == [
        "cloud_status: registered in src/lib.rs but no capability grants allow-cloud-status"
    ]


def test_stale_build_rs_entry_fails(tmp_path: Path) -> None:
    shell = make_shell(
        tmp_path,
        handler=["app_status"],
        manifest=["app_status", "removed_command"],
        capabilities={"default": ["allow-app-status"]},
    )
    errors = mod.check_shell(shell, "src/lib.rs").errors
    assert errors == ["removed_command: listed in build.rs but not registered in src/lib.rs"]


def test_repository_shells_allow_every_registered_command() -> None:
    result = subprocess.run(
        [sys.executable, str(SCRIPT)], capture_output=True, text=True, cwd=REPO_ROOT
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "mobile/src-tauri: all" in result.stdout
    assert "desktop/src-tauri: all" in result.stdout
