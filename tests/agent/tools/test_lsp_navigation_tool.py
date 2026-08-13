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
