from __future__ import annotations

from pathlib import Path

from app.services.memory.lint import lint_memory_scope
from app.services.memory.models import MemoryScope
from app.services.memory.store import MAX_MEMORY_PAGE_BYTES


def test_lint_broken_wikilink(tmp_path: Path):
    root = tmp_path / "ws"
    root.mkdir()
    (root / "page1.md").write_text(
        "See [[missing_page]] for details.", encoding="utf-8"
    )
    scope = MemoryScope(root=root)

    findings = lint_memory_scope(scope)
    assert len(findings) == 1
    assert findings[0].code == "BROKEN_LINK"
    assert "missing_page" in findings[0].message


def test_lint_skips_code_fences(tmp_path: Path):
    root = tmp_path / "ws"
    root.mkdir()
    content = (
        "# Title\n"
        "```markdown\n"
        "Example: [[not_a_real_link]]\n"
        "```\n"
        "Actual text has no links."
    )
    (root / "page.md").write_text(content, encoding="utf-8")
    scope = MemoryScope(root=root)

    findings = lint_memory_scope(scope)
    assert len(findings) == 0


def test_lint_forbids_workspace_wikilinks(tmp_path: Path):
    g_root = tmp_path / "global"
    g_root.mkdir()
    (g_root / "pref.md").write_text("Check [[workspace:auth]]", encoding="utf-8")
    g_scope = MemoryScope(root=g_root)

    findings = lint_memory_scope(g_scope)
    assert any(f.code == "INVALID_WIKILINK_TARGET" for f in findings)


def test_lint_malformed_frontmatter(tmp_path: Path):
    root = tmp_path / "ws"
    root.mkdir()
    (root / "bad.md").write_text("---\n: invalid : : yaml\n---\nBody", encoding="utf-8")
    scope = MemoryScope(root=root)

    findings = lint_memory_scope(scope)
    assert any(f.code == "INVALID_FRONTMATTER" for f in findings)


def test_lint_oversized_page(tmp_path: Path):
    root = tmp_path / "ws"
    root.mkdir()
    (root / "huge.md").write_text("x" * (MAX_MEMORY_PAGE_BYTES + 50), encoding="utf-8")
    scope = MemoryScope(root=root)

    findings = lint_memory_scope(scope)
    assert any(f.code == "PAGE_TOO_LARGE" for f in findings)
