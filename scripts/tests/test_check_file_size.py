from __future__ import annotations

import importlib.util
from pathlib import Path


def _load_module():
    path = Path(__file__).resolve().parents[2] / "scripts" / "check_file_size.py"
    spec = importlib.util.spec_from_file_location("check_file_size", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


mod = _load_module()
WEB = ("web app file", 800)


def _check(tmp_path: Path, name: str, text: str, rule=WEB) -> list[str]:
    path = tmp_path / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return mod.check_repository(tmp_path, {name: rule})


def test_a_file_within_the_limit_passes(tmp_path):
    assert _check(tmp_path, "web/src/a.ts", "x\n" * 800) == []


def test_a_new_file_over_the_limit_is_told_how_to_fix_it(tmp_path):
    assert _check(tmp_path, "web/src/a.ts", "x\n" * 801) == [
        "web/src/a.ts: 801 lines, over the 800-line limit for a web app file. "
        "Move one body of knowledge into its own module (with its tests, and no re-export left behind). "
        "If it has no seam, say so in a first-line comment: // size-ceiling: 801 — <why it stays whole>"
    ]


def test_a_file_with_a_ceiling_may_not_grow_past_it(tmp_path):
    header = "// size-ceiling: 900 — split the list from the menus\n"
    assert _check(tmp_path, "web/src/a.tsx", header + "x\n" * 899) == []
    assert _check(tmp_path, "web/src/a.tsx", header + "x\n" * 900) == [
        "web/src/a.tsx: 901 lines, over its size ceiling of 900. "
        "Its first lines say where to split: split the list from the menus. "
        "Do that, or raise the ceiling there if this change cannot (a reviewer sees the line)"
    ]


def test_a_ceiling_is_deleted_once_the_file_fits(tmp_path):
    assert _check(tmp_path, "web/src/a.ts", "// size-ceiling: 900 — split it\n" + "x\n" * 700) == [
        "web/src/a.ts: 701 lines, under the 800-line limit: delete its size-ceiling comment"
    ]


def test_the_ceiling_is_read_from_the_first_lines_only(tmp_path):
    late = "x\n" * 10 + "// size-ceiling: 5000 — hidden\n" + "x\n" * 1000
    assert len(_check(tmp_path, "appv3/crates/a/src/lib.rs", late, ("Rust file", 1000))) == 1


def test_tests_generated_and_vendored_files_are_not_measured():
    assert mod.is_source("web/src/components/Sidebar.tsx")
    assert mod.is_source("appv3/crates/agent/src/session.rs")
    for name in (
        "web/src/__tests__/components/Sidebar.test.tsx",
        "web/src/components/Sidebar.test.tsx",
        "web/src/vite-env.d.ts",
        "appv3/crates/api/tests/http_api.rs",
        "appv3/vendor/anydoc/src/lib.rs",
        "mobile/src-tauri/gen/android/x.rs",
    ):
        assert not mod.is_source(name), name


def test_the_repository_holds_to_its_own_limits():
    root = Path(__file__).resolve().parents[2]
    files = mod.source_files(root)
    # Not vacuous: both kinds of file are being measured.
    assert sum(1 for kind, _ in files.values() if kind == "web app file") > 300
    assert sum(1 for kind, _ in files.values() if kind == "Rust file") > 200
    assert mod.check_repository(root, files) == []
