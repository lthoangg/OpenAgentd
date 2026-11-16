"""`make verify-changed` picks the gates for a change, and CI runs the same
gates for the same paths."""

from __future__ import annotations

import importlib.util
import re
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "verify_changed.py"
WORKFLOWS = REPO_ROOT / ".github" / "workflows"

spec = importlib.util.spec_from_file_location("verify_changed", SCRIPT)
assert spec and spec.loader
mod = importlib.util.module_from_spec(spec)
sys.modules["verify_changed"] = mod
spec.loader.exec_module(mod)

# The workflow that runs each gate's checks in CI, and for tauri.yml the
# paths-filter output that switches the gate's job on.
CI = {
    "verify-v3": ("appv3.yml", None),
    "verify-web": ("web.yml", None),
    "verify-cloud": ("cloud.yml", None),
    "verify-scripts": ("docs.yml", None),
    "verify-shell-core": ("tauri.yml", "shell_core"),
    "verify-desktop": ("tauri.yml", "desktop"),
    "verify-mobile": ("tauri.yml", "mobile"),
}


def _workflow(name: str) -> dict:
    # BaseLoader keeps the `on` key a string (YAML 1.1 reads it as true).
    return yaml.load((WORKFLOWS / name).read_text(encoding="utf-8"), Loader=yaml.BaseLoader)


def _path_filters(name: str, job_filter: str | None) -> list[list[str]]:
    """Every path list a change must pass for the workflow's job to run."""
    workflow = _workflow(name)
    filters = [event["paths"] for event in workflow["on"].values() if isinstance(event, dict) and "paths" in event]
    if job_filter:
        steps = [step for job in workflow["jobs"].values() for step in job["steps"]]
        (block,) = [step["with"]["filters"] for step in steps if "paths-filter" in step.get("uses", "")]
        filters.append(yaml.safe_load(block)[job_filter])
    return filters


def _example(glob: str) -> str:
    return glob.replace("**", "some/file").replace("*", "some")


def test_a_change_selects_every_surface_that_builds_or_reads_it():
    assert mod.targets_for(["web/src/App.tsx"]) == ["verify-web"]
    assert mod.targets_for(["appv3/crates/api/src/lib.rs"]) == ["verify-v3"]
    # The backend and the phone link the protocol crate.
    assert mod.targets_for(["native/cloud/src/lib.rs"]) == ["verify-cloud", "verify-v3", "verify-mobile"]
    # Web tests hold the menu's shortcuts to the in-app table.
    assert mod.targets_for(["desktop/src-tauri/src/menu.rs"]) == ["verify-scripts", "verify-web", "verify-desktop"]
    assert mod.targets_for(["appv3/crates/agent/data/sse_events.json"]) == ["verify-web", "verify-v3"]
    assert mod.targets_for(["install.sh", "mobile/scripts/publish-apk.sh"]) == ["verify-scripts"]
    # verify-quick, which always runs, covers these.
    assert mod.targets_for(["README.md", "documents/docs/features.md", "LICENSE"]) == []


def test_globs_follow_workflow_path_syntax():
    assert mod.glob_matches("web/**", "web/src/api/client/index.ts")
    assert not mod.glob_matches("web/**", "webview/a.ts")
    assert mod.glob_matches("**/*.md", "README.md")
    assert mod.glob_matches("**/*.md", "documents/docs/features.md")
    assert mod.glob_matches("desktop/src-tauri/tauri*.conf.json", "desktop/src-tauri/tauri.dev.conf.json")
    assert not mod.glob_matches("desktop/src-tauri/*.json", "desktop/src-tauri/capabilities/default.json")
    assert not mod.glob_matches("Makefile", "mobile/Makefile")


def test_every_gate_is_a_make_target_with_a_place_in_the_run_order():
    makefile = (REPO_ROOT / "Makefile").read_text(encoding="utf-8")
    gates = {target for _, targets in mod.RULES for target in targets}
    assert gates == set(mod.ORDER) == set(CI)
    for gate in (*gates, "verify-quick", "verify-changed"):
        assert re.search(rf"^{gate}:", makefile, re.MULTILINE), gate


@pytest.mark.parametrize(("glob", "gate"), [(glob, gate) for glob, gates in mod.RULES for gate in gates])
def test_ci_runs_a_gate_for_every_path_that_selects_it(glob: str, gate: str):
    workflow, job_filter = CI[gate]
    for paths in _path_filters(workflow, job_filter):
        assert any(mod.glob_matches(path, _example(glob)) for path in paths), (
            f"{workflow} does not run for {glob}, so CI skips what `make {gate}` checks"
        )


def test_every_source_a_web_test_reads_outside_web_selects_the_web_gate():
    read = set()
    for test in (REPO_ROOT / "web" / "src" / "__tests__").rglob("*.ts*"):
        text = test.read_text(encoding="utf-8")
        for prefix in re.findall(r"(?:\.\./){4}([\w./-]*)", text):
            if prefix == "" or prefix.endswith("/"):
                # A `read(path)` helper: the paths are its arguments.
                read.update(prefix + path for path in re.findall(r"\bread\(['\"]([\w./-]+)['\"]\)", text))
            else:
                read.add(prefix)
    outside = sorted(path for path in read if not path.startswith("web/"))
    assert "appv3/crates/agent/data/sse_events.json" in outside
    assert "mobile/ios-widget/Extension/OpenAgentdWidgets.swift" in outside
    assert [path for path in outside if "verify-web" not in mod.targets_for([path])] == []


def _git(root: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(root), "-c", "user.name=t", "-c", "user.email=t@t", *args], check=True, capture_output=True)


def test_the_change_is_commits_since_the_base_plus_uncommitted_and_untracked_files(tmp_path: Path):
    _git(tmp_path, "init", "-q")
    for name in ("kept.txt", "edited.txt"):
        (tmp_path / name).write_text("one\n")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-qm", "base")
    (tmp_path / "committed.txt").write_text("two\n")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-qm", "change")
    (tmp_path / "edited.txt").write_text("changed\n")
    (tmp_path / "new dir").mkdir()
    (tmp_path / "new dir" / "untracked.txt").write_text("three\n")

    assert mod.changed_files(tmp_path, "HEAD~1") == ["committed.txt", "edited.txt", "new dir/untracked.txt"]
    assert mod.default_base(tmp_path) == "origin/main"
    with pytest.raises(RuntimeError, match="no merge base with origin/main"):
        mod.changed_files(tmp_path, "origin/main")
