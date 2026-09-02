"""``scripts.codehealth`` reports import-time coupling, not every import."""

from __future__ import annotations

from pathlib import Path

from scripts.codehealth.py_analyzer import analyze_python_file
from scripts.codehealth.ts_analyzer import analyze_ts_file


def _analyze(tmp_path: Path, source: str):
    pkg = tmp_path / "app" / "pkg"
    pkg.mkdir(parents=True)
    target = pkg / "mod.py"
    target.write_text(source, encoding="utf-8")
    return analyze_python_file(target, tmp_path)


def test_module_level_imports_are_edges(tmp_path):
    report = _analyze(
        tmp_path,
        "from app.a import x\nimport app.b\nfrom . import sibling\n",
    )
    assert report.imports == {"app.a", "app.b", "app.pkg"}


def test_deferred_imports_are_not_import_time_edges(tmp_path):
    """A function-body import is how a cycle is *broken*; counting it as an
    edge would report the fix as the bug. ``TYPE_CHECKING`` blocks never run.
    """
    report = _analyze(
        tmp_path,
        "from typing import TYPE_CHECKING\n"
        "from app.eager import y\n"
        "if TYPE_CHECKING:\n"
        "    from app.types_only import T\n"
        "def f():\n"
        "    from app.lazy import z\n"
        "    return z\n"
        "class C:\n"
        "    def m(self):\n"
        "        import app.lazy_method\n",
    )
    assert report.imports == {"app.eager"}


def test_ts_type_only_and_dynamic_imports_are_not_import_time_edges(tmp_path):
    """``import type`` is erased by the compiler and ``import()`` is deferred;
    neither can participate in a module-evaluation cycle."""
    src = tmp_path / "web" / "src"
    (src / "lib").mkdir(parents=True)
    for name in ("eager", "types_only", "lazy", "mixed"):
        (src / "lib" / f"{name}.ts").write_text(
            "export const x = 1\n", encoding="utf-8"
        )
    target = src / "lib" / "mod.ts"
    target.write_text(
        "import { a } from './eager'\n"
        "import type { T } from './types_only'\n"
        "import { type U, b } from './mixed'\n"
        "export async function load() { return import('./lazy') }\n",
        encoding="utf-8",
    )

    report = analyze_ts_file(target, tmp_path, src)

    assert report.imports == {"web/src/lib/eager.ts", "web/src/lib/mixed.ts"}
