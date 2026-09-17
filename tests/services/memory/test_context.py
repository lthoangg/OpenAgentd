from __future__ import annotations

from pathlib import Path

from app.services.memory.context import (
    MAX_TOTAL_CATALOG_CHARS,
    compile_global_snapshot,
    compose_memory_context,
    normalize_text,
    search_memory,
    xml_escape,
)
from app.services.memory.models import MemoryScope


def test_normalization_and_xml_escaping():
    text = "Line 1\r\nLine 2\r\nHello <world> & goodbye\x00\x07"
    normalized = normalize_text(text)
    assert "\r" not in normalized
    assert "\x00" not in normalized
    assert "\x07" not in normalized

    escaped = xml_escape(normalized)
    assert "&lt;world&gt;" in escaped
    assert "&amp;" in escaped


def test_compile_global_snapshot(tmp_path: Path):
    g_root = tmp_path / "global"
    g_root.mkdir()
    (g_root / "preferences.md").write_text(
        "# Preferences\nUser prefers concise functional Python with type annotations.",
        encoding="utf-8",
    )
    (g_root / "car.md").write_text(
        "# 2024 Tesla Model Y\nCharging limit set to 80% daily.",
        encoding="utf-8",
    )
    g_scope = MemoryScope(root=g_root)
    g_snap = compile_global_snapshot(g_scope)
    assert "concise functional Python" in g_snap.preferences_content
    # preferences.md should NOT be duplicated in knowledge_catalog
    assert "preferences" not in g_snap.knowledge_catalog
    assert (
        "[[global:car]]: 2024 Tesla Model Y — Charging limit set to 80% daily."
        in g_snap.knowledge_catalog
    )


def test_compose_memory_context(tmp_path: Path):
    g_root = tmp_path / "global"
    g_root.mkdir()

    (g_root / "preferences.md").write_text("Terse answers.", encoding="utf-8")
    (g_root / "tech.md").write_text("# Tech\nTypeScript.", encoding="utf-8")

    g_scope = MemoryScope(root=g_root)
    g_snap = compile_global_snapshot(g_scope)

    ctx = compose_memory_context(
        g_snap,
        global_root=g_root,
    )
    assert "<global_preferences>" in ctx
    assert "<global_knowledge>" in ctx
    assert "<workspace_knowledge>" not in ctx
    assert len(ctx) <= MAX_TOTAL_CATALOG_CHARS


def test_deterministic_search(tmp_path: Path):
    g_root = tmp_path / "global"
    g_root.mkdir()
    (g_root / "car.md").write_text("# Vehicle\nTesla Model Y", encoding="utf-8")
    g_scope = MemoryScope(root=g_root)

    results = search_memory(g_scope, "Tesla")
    assert len(results) == 1
    assert results[0]["path"] == "car.md"
    assert results[0]["title"] == "Vehicle"

    empty = search_memory(g_scope, "nonexistent_token")
    assert len(empty) == 0
