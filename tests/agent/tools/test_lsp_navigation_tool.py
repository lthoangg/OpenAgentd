"""Tests for the coding-only LSP navigation tool."""

from __future__ import annotations
from pathlib import Path
from unittest.mock import AsyncMock, patch
import pytest
from app.agent.errors import ToolExecutionError
from app.agent.sandbox import SandboxConfig, set_sandbox
from app.agent.tools.builtin.lsp import lsp_navigation


def _sandbox(workspace: Path) -> None:
    set_sandbox(SandboxConfig(workspace=str(workspace)))


def test_schema_exposes_only_snake_case_operations():
    parameters = lsp_navigation.definition["function"]["parameters"]
    operation = parameters["properties"]["operation"]

    assert operation["enum"] == [
        "go_to_definition",
        "find_references",
        "document_symbol",
        "workspace_symbol",
    ]
    assert "path" in parameters["required"]
    assert parameters["properties"]["path"]["type"] == "string"


@pytest.mark.asyncio
async def test_definition_formats_workspace_location_and_converts_position(
    tmp_path: Path,
):
    source = tmp_path / "src/main.py"
    source.parent.mkdir()
    source.write_text("x", encoding="utf-8")
    target = tmp_path / "src/answer.py"
    target.write_text("x", encoding="utf-8")
    _sandbox(tmp_path)
    with patch(
        "app.agent.tools.builtin.lsp.lsp_manager.navigation",
        new_callable=AsyncMock,
        return_value=[
            {"uri": target.as_uri(), "range": {"start": {"line": 2, "character": 4}}}
        ],
    ) as navigation:
        result = await lsp_navigation.arun(
            operation="go_to_definition",
            path="src/main.py",
            line=1,
            character=1,
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
        )
    assert result == "src/answer.py:3:5"
    assert navigation.await_args.kwargs["line"] == 0
    assert navigation.await_args.kwargs["character"] == 0


async def test_definition_formats_location_link_target_range(tmp_path: Path):
    source = tmp_path / "src/main.py"
    source.parent.mkdir()
    source.write_text("x", encoding="utf-8")
    target = tmp_path / "src/answer.py"
    target.write_text("x", encoding="utf-8")
    _sandbox(tmp_path)
    with patch(
        "app.agent.tools.builtin.lsp.lsp_manager.navigation",
        new_callable=AsyncMock,
        return_value=[
            {
                "targetUri": target.as_uri(),
                "targetRange": {"start": {"line": 2, "character": 4}},
            }
        ],
    ):
        result = await lsp_navigation.arun(
            operation="go_to_definition",
            path="src/main.py",
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
        )

    assert result == "src/answer.py:3:5"


@pytest.mark.asyncio
async def test_workspace_symbol_sorts_and_filters_external_locations(tmp_path: Path):
    source = tmp_path / "symbols.py"
    source.write_text("", encoding="utf-8")
    set_sandbox(
        SandboxConfig(
            workspace=str(tmp_path),
            denied_roots=[],
            denied_patterns=["**/denied.py"],
        )
    )
    with patch(
        "app.agent.tools.builtin.lsp.lsp_manager.navigation",
        new_callable=AsyncMock,
        return_value=[
            {
                "name": "Zoo",
                "location": {
                    "uri": (tmp_path / "z.py").as_uri(),
                    "range": {"start": {"line": 4, "character": 0}},
                },
            },
            {
                "name": "Alpha",
                "location": {
                    "uri": (tmp_path / "a.py").as_uri(),
                    "range": {"start": {"line": 0, "character": 1}},
                },
            },
            {
                "name": "secret",
                "location": {
                    "uri": "file:///tmp/secret.py",
                    "range": {"start": {"line": 0, "character": 0}},
                },
            },
            {
                "name": "denied",
                "location": {
                    "uri": (tmp_path / "denied.py").as_uri(),
                    "range": {"start": {"line": 0, "character": 0}},
                },
            },
        ],
    ):
        result = await lsp_navigation.arun(
            operation="workspace_symbol",
            path="symbols.py",
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
        )
    assert result == "Alpha | a.py:1:2\nZoo | z.py:5:1"


async def test_rejects_denied_source_symlink_and_filters_denied_result_symlink(
    tmp_path: Path,
):
    source = tmp_path / "symbols.py"
    source.write_text("", encoding="utf-8")
    denied_source = tmp_path / "denied-source.py"
    denied_source.symlink_to(source)
    target = tmp_path / "target.py"
    target.write_text("", encoding="utf-8")
    denied_target = tmp_path / "denied-target.py"
    denied_target.symlink_to(target)
    set_sandbox(
        SandboxConfig(
            workspace=str(tmp_path),
            denied_roots=[],
            denied_patterns=["**/denied-*.py"],
        )
    )

    with pytest.raises(ToolExecutionError, match="denied sandbox"):
        await lsp_navigation.arun(
            operation="document_symbol",
            path="denied-source.py",
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
        )

    with patch(
        "app.agent.tools.builtin.lsp.lsp_manager.navigation",
        new_callable=AsyncMock,
        return_value=[
            {
                "name": "Denied",
                "location": {
                    "uri": denied_target.as_uri(),
                    "range": {"start": {"line": 0, "character": 0}},
                },
            }
        ],
    ):
        result = await lsp_navigation.arun(
            operation="workspace_symbol",
            path="symbols.py",
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
        )

    assert result == "No results."


@pytest.mark.asyncio
async def test_rejects_outside_path_and_normal_mode(tmp_path: Path):
    source = tmp_path / "symbols.py"
    source.write_text("", encoding="utf-8")
    _sandbox(tmp_path)
    with pytest.raises(ToolExecutionError, match="outside the coding workspace"):
        await lsp_navigation.arun(
            operation="document_symbol",
            path="../secret.py",
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
        )
    with pytest.raises(ToolExecutionError, match="only available in coding mode"):
        await lsp_navigation.arun(
            operation="workspace_symbol",
            path="symbols.py",
            _injected={"_mode": "normal", "_workspace": str(tmp_path)},
        )


async def test_rejects_mismatched_injected_and_sandbox_workspaces(tmp_path: Path):
    source = tmp_path / "symbols.py"
    source.write_text("", encoding="utf-8")
    _sandbox(tmp_path)

    with pytest.raises(ToolExecutionError, match="coding workspace is unavailable"):
        await lsp_navigation.arun(
            operation="workspace_symbol",
            path="symbols.py",
            _injected={
                "_mode": "coding",
                "_workspace": str(tmp_path / "another-workspace"),
            },
        )


@pytest.mark.asyncio
async def test_workspace_symbol_appends_readable_kind_label(tmp_path: Path):
    source = tmp_path / "symbols.py"
    source.write_text("", encoding="utf-8")
    _sandbox(tmp_path)
    with patch(
        "app.agent.tools.builtin.lsp.lsp_manager.navigation",
        new_callable=AsyncMock,
        return_value=[
            {
                "name": "Widget",
                "kind": 5,  # SymbolKind.Class
                "location": {
                    "uri": (tmp_path / "widget.py").as_uri(),
                    "range": {"start": {"line": 0, "character": 0}},
                },
            },
        ],
    ):
        result = await lsp_navigation.arun(
            operation="workspace_symbol",
            path="symbols.py",
            query="Widget",
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
        )
    assert result == "Widget (class) | widget.py:1:1"


@pytest.mark.asyncio
async def test_workspace_symbol_omits_kind_label_for_unknown_or_missing_kind(
    tmp_path: Path,
):
    source = tmp_path / "symbols.py"
    source.write_text("", encoding="utf-8")
    _sandbox(tmp_path)
    with patch(
        "app.agent.tools.builtin.lsp.lsp_manager.navigation",
        new_callable=AsyncMock,
        return_value=[
            {
                "name": "NoKind",
                "location": {
                    "uri": (tmp_path / "a.py").as_uri(),
                    "range": {"start": {"line": 0, "character": 0}},
                },
            },
            {
                "name": "WeirdKind",
                "kind": 9999,
                "location": {
                    "uri": (tmp_path / "b.py").as_uri(),
                    "range": {"start": {"line": 0, "character": 0}},
                },
            },
        ],
    ):
        result = await lsp_navigation.arun(
            operation="workspace_symbol",
            path="symbols.py",
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
        )
    assert result == "NoKind | a.py:1:1\nWeirdKind | b.py:1:1"


@pytest.mark.asyncio
async def test_document_symbol_orders_by_source_position_not_alphabetically(
    tmp_path: Path,
):
    """A file's symbols read top-to-bottom, not A-to-Z — unlike workspace_symbol
    (which spans many files and has no single natural reading order), a single
    document's outline is most useful in the order it appears in the file."""
    source = tmp_path / "module.py"
    source.write_text("", encoding="utf-8")
    _sandbox(tmp_path)
    with patch(
        "app.agent.tools.builtin.lsp.lsp_manager.navigation",
        new_callable=AsyncMock,
        return_value=[
            {
                "name": "zeta_last",
                "kind": 12,  # Function
                "location": {
                    "uri": source.as_uri(),
                    "range": {"start": {"line": 9, "character": 0}},
                },
            },
            {
                "name": "alpha_first",
                "kind": 5,  # Class
                "location": {
                    "uri": source.as_uri(),
                    "range": {"start": {"line": 0, "character": 0}},
                },
            },
        ],
    ):
        result = await lsp_navigation.arun(
            operation="document_symbol",
            path="module.py",
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
        )
    assert result == (
        "alpha_first (class) | module.py:1:1\nzeta_last (function) | module.py:10:1"
    )
