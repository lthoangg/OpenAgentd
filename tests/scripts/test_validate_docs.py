from __future__ import annotations

import importlib.util
from pathlib import Path


def _load_module():
    path = Path(__file__).resolve().parents[2] / "scripts" / "validate_docs.py"
    spec = importlib.util.spec_from_file_location("validate_docs", path)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _write_repo(tmp_path: Path) -> list[Path]:
    (tmp_path / "documents" / "adrs").mkdir(parents=True)
    (tmp_path / "documents" / "docs").mkdir()
    (tmp_path / "docs").mkdir()
    (tmp_path / "Makefile").write_text("test:\n\t@true\n\n.PHONY: test\n")
    (tmp_path / "AGENTS.md").write_text("See `docs/AGENTS.md`.\n")
    (tmp_path / "docs" / "AGENTS.md").write_text("# Local instructions\n")
    (tmp_path / "documents" / "docs" / "guide.md").write_text(
        "---\ntitle: Guide\ndescription: A guide\nstatus: stable\nupdated: 2026-07-14\n---\n"
        "[Home](../../README.md) [Section](#section) [URL](https://example.test) "
        "[Mail](mailto:docs@example.test) ![Logo](logo.png) `make test`\n"
    )
    (tmp_path / "README.md").write_text("# Home\n")
    (tmp_path / "documents" / "adrs" / "README.md").write_text(
        "| ADR | Title | Status | Date |\n| --- | --- | --- | --- |\n"
        "| [0001](0001-example.md) | Example | Accepted | 2026-07-14 |\n"
    )
    (tmp_path / "documents" / "adrs" / "0001-example.md").write_text("# ADR\n")
    return sorted(tmp_path.rglob("*.md"))


def test_validate_repository_accepts_coherent_documentation_contract(tmp_path):
    module = _load_module()
    tracked = _write_repo(tmp_path)

    assert module.validate_repository(tmp_path, tracked) == []


def test_validate_repository_reports_each_documentation_contract_violation(tmp_path):
    module = _load_module()
    tracked = _write_repo(tmp_path)
    (tmp_path / "documents" / "docs" / "guide.md").write_text(
        "---\ntitle: Guide\nstatus: stable\nupdated: 2026-07-14\n---\n"
        "[Missing](missing.md) `make missing`\n"
    )
    (tmp_path / "AGENTS.md").write_text("See `docs/missing/AGENTS.md`.\n")
    (tmp_path / "documents" / "adrs" / "README.md").write_text(
        "| ADR | Title | Status | Date |\n| --- | --- | --- | --- |\n"
        "| [0001](0001-example.md) | Example | Accepted | 2026-07-14 |\n"
        "| [0002](0002-missing.md) | Missing | Accepted | 2026-07-14 |\n"
    )
    (tmp_path / "documents" / "adrs" / "0003-orphan.md").write_text("# Orphan\n")

    errors = module.validate_repository(tmp_path, tracked)

    assert errors == sorted(
        [
            "AGENTS.md: referenced AGENTS path does not exist: docs/missing/AGENTS.md",
            "documents/docs/guide.md: missing frontmatter field: description",
            "documents/docs/guide.md: local link target does not exist: missing.md",
            "documents/docs/guide.md: documented Make target does not exist: missing",
            "documents/adrs/README.md: ADR entry target does not exist: 0002-missing.md",
            "documents/adrs/README.md: local link target does not exist: 0002-missing.md",
            "documents/adrs/0003-orphan.md: ADR file is missing from index",
        ]
    )


def test_main_returns_nonzero_and_prints_deterministic_errors(
    tmp_path, monkeypatch, capsys
):
    module = _load_module()
    tracked = _write_repo(tmp_path)
    (tmp_path / "documents" / "docs" / "guide.md").write_text("[Missing](missing.md)\n")
    monkeypatch.setattr(module, "tracked_markdown_files", lambda root: tracked)
    monkeypatch.setattr("sys.argv", ["validate_docs.py", "--root", str(tmp_path)])

    assert module.main() == 1
    assert (
        capsys.readouterr().err
        == "documents/docs/guide.md: local link target does not exist: missing.md\n"
    )
