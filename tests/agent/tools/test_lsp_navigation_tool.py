"""Tests for the coding-only LSP navigation tool."""

from __future__ import annotations
from pathlib import Path
from unittest.mock import AsyncMock, patch
import pytest
from app.agent.errors import ToolExecutionError
from app.agent.denied_paths import (
    DeniedPathsConfig as SandboxConfig,
    set_denied_paths as set_sandbox,
)
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
        "hover",
        "find_implementations",
    ]
    assert "path" in parameters["required"]
    assert parameters["properties"]["path"]["type"] == "string"


def test_description_guides_lsp_workflow_and_position_conventions():
    description = lsp_navigation.definition["function"]["description"]

    assert "document_symbol" in description
    assert "unfamiliar" in description
    assert "grep" in description and "glob" in description
    assert "known identifier" in description
    assert "one-based" in description
    assert "workspace-relative" in description


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

    with pytest.raises(ToolExecutionError, match="denied path"):
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
async def test_rejects_outside_path(tmp_path: Path):
    source = tmp_path / "symbols.py"
    source.write_text("", encoding="utf-8")
    _sandbox(tmp_path)
    with pytest.raises(ToolExecutionError, match="outside the coding workspace"):
        await lsp_navigation.arun(
            operation="document_symbol",
            path="../secret.py",
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
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
    assert result == "Widget (class) [exact] | widget.py:1:1"


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
async def test_unsupported_extension_short_circuits_without_starting_a_server(
    tmp_path: Path,
):
    """.rs/.md/.rb/etc have no EXTENSION_TO_LANG entry — fail fast with a clear
    reason instead of silently returning 'No results.', which would read as
    'this symbol doesn't exist' rather than 'this file type isn't supported'."""
    source = tmp_path / "notes.md"
    source.write_text("# Notes", encoding="utf-8")
    _sandbox(tmp_path)
    with patch(
        "app.agent.tools.builtin.lsp.lsp_manager.navigation",
        new_callable=AsyncMock,
    ) as navigation:
        result = await lsp_navigation.arun(
            operation="document_symbol",
            path="notes.md",
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
        )
    assert "no language server" in result.lower()
    assert ".md" in result
    navigation.assert_not_called()


@pytest.mark.asyncio
async def test_hover_formats_markup_content(tmp_path: Path):
    source = tmp_path / "main.py"
    source.write_text("answer()\n", encoding="utf-8")
    _sandbox(tmp_path)
    with patch(
        "app.agent.tools.builtin.lsp.lsp_manager.navigation",
        new_callable=AsyncMock,
        return_value=[
            {
                "contents": {
                    "kind": "markdown",
                    "value": "```python\ndef answer() -> int\n```",
                }
            }
        ],
    ):
        result = await lsp_navigation.arun(
            operation="hover",
            path="main.py",
            line=1,
            character=1,
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
        )
    assert result == "```python\ndef answer() -> int\n```"


@pytest.mark.asyncio
async def test_hover_formats_marked_string_array(tmp_path: Path):
    source = tmp_path / "main.py"
    source.write_text("answer()\n", encoding="utf-8")
    _sandbox(tmp_path)
    with patch(
        "app.agent.tools.builtin.lsp.lsp_manager.navigation",
        new_callable=AsyncMock,
        return_value=[
            {
                "contents": [
                    {"language": "python", "value": "def answer() -> int"},
                    "Returns the answer.",
                ]
            }
        ],
    ):
        result = await lsp_navigation.arun(
            operation="hover",
            path="main.py",
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
        )
    assert result == "def answer() -> int\n\nReturns the answer."


@pytest.mark.asyncio
async def test_hover_with_no_result_reports_no_information(tmp_path: Path):
    source = tmp_path / "main.py"
    source.write_text("answer()\n", encoding="utf-8")
    _sandbox(tmp_path)
    with patch(
        "app.agent.tools.builtin.lsp.lsp_manager.navigation",
        new_callable=AsyncMock,
        return_value=[],
    ):
        result = await lsp_navigation.arun(
            operation="hover",
            path="main.py",
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
        )
    assert result == "No hover information available."


@pytest.mark.asyncio
async def test_kind_filter_narrows_workspace_symbol_results(tmp_path: Path):
    source = tmp_path / "symbols.py"
    source.write_text("", encoding="utf-8")
    _sandbox(tmp_path)
    with patch(
        "app.agent.tools.builtin.lsp.lsp_manager.navigation",
        new_callable=AsyncMock,
        return_value=[
            {
                "name": "Widget",
                "kind": 5,  # Class
                "location": {
                    "uri": (tmp_path / "a.py").as_uri(),
                    "range": {"start": {"line": 0, "character": 0}},
                },
            },
            {
                "name": "make_widget",
                "kind": 12,  # Function
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
            kind="function",
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
        )
    assert result == "make_widget (function) | b.py:1:1"


@pytest.mark.asyncio
async def test_kind_filter_is_case_insensitive_and_ignored_for_location_operations(
    tmp_path: Path,
):
    source = tmp_path / "main.py"
    source.write_text("x", encoding="utf-8")
    target = tmp_path / "answer.py"
    target.write_text("x", encoding="utf-8")
    _sandbox(tmp_path)
    with patch(
        "app.agent.tools.builtin.lsp.lsp_manager.navigation",
        new_callable=AsyncMock,
        return_value=[
            {"uri": target.as_uri(), "range": {"start": {"line": 0, "character": 0}}}
        ],
    ):
        result = await lsp_navigation.arun(
            operation="go_to_definition",
            path="main.py",
            kind="Class",
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
        )
    # Location results carry the target's source line ("x" is the file body).
    assert result == "answer.py:1:1 | x"


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


@pytest.mark.asyncio
async def test_hover_combines_multiple_hover_items(tmp_path: Path):
    source = tmp_path / "main.py"
    source.write_text("def answer(): pass\n", encoding="utf-8")
    _sandbox(tmp_path)
    with patch(
        "app.agent.tools.builtin.lsp.lsp_manager.navigation",
        new_callable=AsyncMock,
        return_value=[
            {"contents": {"value": "def answer() -> int"}},
            {"contents": "Calculates the answer to everything."},
        ],
    ):
        result = await lsp_navigation.arun(
            operation="hover",
            path="main.py",
            line=1,
            character=5,
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
        )
    assert (
        result == "def answer() -> int\n\n---\n\nCalculates the answer to everything."
    )


@pytest.mark.asyncio
async def test_invalid_location_diagnostics_out_of_bounds_and_whitespace_and_comment(
    tmp_path: Path,
):
    source = tmp_path / "main.py"
    source.write_text("# A comment\nvar_a = 123  \n", encoding="utf-8")
    _sandbox(tmp_path)

    # Line out of bounds
    with patch(
        "app.agent.tools.builtin.lsp.lsp_manager.navigation",
        new_callable=AsyncMock,
        return_value=[],
    ):
        res_line_oob = await lsp_navigation.arun(
            operation="go_to_definition",
            path="main.py",
            line=10,
            character=1,
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
        )
    assert "out of bounds" in res_line_oob

    # Character out of bounds
    with patch(
        "app.agent.tools.builtin.lsp.lsp_manager.navigation",
        new_callable=AsyncMock,
        return_value=[],
    ):
        res_char_oob = await lsp_navigation.arun(
            operation="go_to_definition",
            path="main.py",
            line=2,
            character=50,
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
        )
    assert "beyond line length" in res_char_oob

    # On whitespace
    with patch(
        "app.agent.tools.builtin.lsp.lsp_manager.navigation",
        new_callable=AsyncMock,
        return_value=[],
    ):
        res_ws = await lsp_navigation.arun(
            operation="go_to_definition",
            path="main.py",
            line=2,
            character=14,
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
        )
    assert "whitespace" in res_ws

    # Inside comment
    with patch(
        "app.agent.tools.builtin.lsp.lsp_manager.navigation",
        new_callable=AsyncMock,
        return_value=[],
    ):
        res_comment = await lsp_navigation.arun(
            operation="go_to_definition",
            path="main.py",
            line=1,
            character=3,
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
        )
    assert "comment" in res_comment

    # Unresolved symbol
    with patch(
        "app.agent.tools.builtin.lsp.lsp_manager.navigation",
        new_callable=AsyncMock,
        return_value=[],
    ):
        res_unresolved = await lsp_navigation.arun(
            operation="go_to_definition",
            path="main.py",
            line=2,
            character=1,
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
        )
    assert "unresolved symbol 'var_a'" in res_unresolved


@pytest.mark.asyncio
async def test_find_references_classifies_roles(tmp_path: Path):
    source = tmp_path / "main.py"
    source.write_text("x = 1\nprint(x)\n", encoding="utf-8")
    _sandbox(tmp_path)
    with patch(
        "app.agent.tools.builtin.lsp.lsp_manager.navigation",
        new_callable=AsyncMock,
        return_value=[
            {
                "name": "x",
                "isDefinition": True,
                "location": {
                    "uri": source.as_uri(),
                    "range": {"start": {"line": 0, "character": 0}},
                },
            },
            {
                "name": "x",
                "role": "write",
                "location": {
                    "uri": source.as_uri(),
                    "range": {"start": {"line": 0, "character": 0}},
                },
            },
            {
                "name": "x",
                "role": "read",
                "location": {
                    "uri": source.as_uri(),
                    "range": {"start": {"line": 1, "character": 6}},
                },
            },
        ],
    ):
        result = await lsp_navigation.arun(
            operation="find_references",
            path="main.py",
            line=1,
            character=1,
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
        )
    assert "[definition]" in result
    assert "[write]" in result
    assert "[read]" in result


@pytest.mark.asyncio
async def test_kind_filter_supports_multiple_kinds_and_fuzzy_matching(tmp_path: Path):
    source = tmp_path / "symbols.py"
    source.write_text("", encoding="utf-8")
    _sandbox(tmp_path)
    with patch(
        "app.agent.tools.builtin.lsp.lsp_manager.navigation",
        new_callable=AsyncMock,
        return_value=[
            {
                "name": "Widget",
                "kind": 5,  # Class
                "location": {
                    "uri": source.as_uri(),
                    "range": {"start": {"line": 0, "character": 0}},
                },
            },
            {
                "name": "make_widget",
                "kind": 12,  # Function
                "location": {
                    "uri": source.as_uri(),
                    "range": {"start": {"line": 1, "character": 0}},
                },
            },
            {
                "name": "do_thing",
                "kind": 6,  # Method
                "location": {
                    "uri": source.as_uri(),
                    "range": {"start": {"line": 2, "character": 0}},
                },
            },
        ],
    ):
        # Multi-kind filter
        res_multi = await lsp_navigation.arun(
            operation="document_symbol",
            path="symbols.py",
            kind="function, method",
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
        )
        assert "make_widget" in res_multi
        assert "do_thing" in res_multi
        assert "Widget" not in res_multi

        # Fuzzy filter ("func")
        res_fuzzy = await lsp_navigation.arun(
            operation="document_symbol",
            path="symbols.py",
            kind="func",
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
        )
        assert "make_widget" in res_fuzzy
        assert "Widget" not in res_fuzzy


@pytest.mark.asyncio
async def test_find_implementations_operation(tmp_path: Path):
    source = tmp_path / "main.py"
    source.write_text("class Impl(Interface): pass\n", encoding="utf-8")
    _sandbox(tmp_path)

    with patch(
        "app.agent.tools.builtin.lsp.lsp_manager.navigation",
        new_callable=AsyncMock,
        return_value=[
            {
                "name": "Impl",
                "kind": 5,
                "location": {
                    "uri": source.as_uri(),
                    "range": {"start": {"line": 0, "character": 6}},
                },
            }
        ],
    ) as nav_mock:
        res = await lsp_navigation.arun(
            operation="find_implementations",
            path="main.py",
            line=1,
            character=15,
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
        )
        assert "Impl (class) | main.py:1:7" in res
        nav_mock.assert_awaited_once_with(
            "find_implementations",
            tmp_path.resolve(),
            file_path=source,
            line=0,
            character=14,
            query="",
        )


@pytest.mark.asyncio
async def test_go_to_definition_self_definition_feedback(tmp_path: Path):
    source = tmp_path / "main.py"
    source.write_text("def my_func(): pass\n", encoding="utf-8")
    _sandbox(tmp_path)

    with patch(
        "app.agent.tools.builtin.lsp.lsp_manager.navigation",
        new_callable=AsyncMock,
        return_value=[
            {
                "name": "my_func",
                "kind": 12,
                "location": {
                    "uri": source.as_uri(),
                    "range": {"start": {"line": 0, "character": 4}},
                },
            }
        ],
    ):
        res_text = await lsp_navigation.arun(
            operation="go_to_definition",
            path="main.py",
            line=1,
            character=5,
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
        )
        assert "already at its definition site" in res_text


@pytest.mark.asyncio
async def test_directory_path_raises_clear_error(tmp_path: Path):
    src_dir = tmp_path / "src"
    src_dir.mkdir()
    _sandbox(tmp_path)

    with pytest.raises(ToolExecutionError, match="received a directory"):
        await lsp_navigation.arun(
            operation="document_symbol",
            path="src",
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
        )


@pytest.mark.asyncio
async def test_keyword_landing_produces_keyword_diagnostic(tmp_path: Path):
    source = tmp_path / "main.py"
    source.write_text("import sys\n", encoding="utf-8")
    _sandbox(tmp_path)

    with patch(
        "app.agent.tools.builtin.lsp.lsp_manager.navigation",
        new_callable=AsyncMock,
        return_value=[],
    ):
        res = await lsp_navigation.arun(
            operation="go_to_definition",
            path="main.py",
            line=1,
            character=1,
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
        )
        assert "on keyword 'import'" in res


@pytest.mark.asyncio
async def test_find_references_appends_source_line_excerpts(tmp_path: Path):
    """References carry the matching source line so the agent can judge each
    hit (import vs. call vs. annotation) without a follow-up read."""
    source = tmp_path / "main.py"
    source.write_text("def answer():\n    return 42\n", encoding="utf-8")
    caller = tmp_path / "caller.py"
    caller.write_text(
        "from main import answer\n\nprint(answer())\n",
        encoding="utf-8",
    )
    _sandbox(tmp_path)
    with patch(
        "app.agent.tools.builtin.lsp.lsp_manager.navigation",
        new_callable=AsyncMock,
        return_value=[
            {
                "uri": caller.as_uri(),
                "range": {"start": {"line": 0, "character": 18}},
            },
            {
                "uri": caller.as_uri(),
                "range": {"start": {"line": 2, "character": 6}},
            },
        ],
    ):
        result = await lsp_navigation.arun(
            operation="find_references",
            path="main.py",
            line=1,
            character=5,
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
        )
    assert result == (
        "caller.py:1:19 | from main import answer\ncaller.py:3:7 | print(answer())"
    )


@pytest.mark.asyncio
async def test_excerpt_is_trimmed_and_skipped_for_symbol_operations(tmp_path: Path):
    source = tmp_path / "long.py"
    source.write_text(f"value = '{'a' * 300}'\n", encoding="utf-8")
    _sandbox(tmp_path)
    with patch(
        "app.agent.tools.builtin.lsp.lsp_manager.navigation",
        new_callable=AsyncMock,
        return_value=[
            {
                "name": "value",
                "kind": 13,
                "location": {
                    "uri": source.as_uri(),
                    "range": {"start": {"line": 0, "character": 0}},
                },
            }
        ],
    ):
        definition = await lsp_navigation.arun(
            operation="go_to_definition",
            path="long.py",
            line=2,
            character=1,
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
        )
        symbols = await lsp_navigation.arun(
            operation="document_symbol",
            path="long.py",
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
        )

    excerpt = definition.rsplit(" | ", 1)[-1]
    assert len(excerpt) == 120
    assert excerpt.endswith("…")
    # Named symbol listings already describe themselves — no excerpt noise.
    assert symbols == "value (variable) | long.py:1:1"


@pytest.mark.asyncio
async def test_results_over_the_cap_report_truncation(tmp_path: Path):
    source = tmp_path / "symbols.py"
    source.write_text("", encoding="utf-8")
    _sandbox(tmp_path)
    with patch(
        "app.agent.tools.builtin.lsp.lsp_manager.navigation",
        new_callable=AsyncMock,
        return_value=[
            {
                "name": f"sym_{index:03d}",
                "kind": 12,
                "location": {
                    "uri": (tmp_path / "a.py").as_uri(),
                    "range": {"start": {"line": index, "character": 0}},
                },
            }
            for index in range(62)
        ],
    ):
        result = await lsp_navigation.arun(
            operation="workspace_symbol",
            path="symbols.py",
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
        )

    lines = result.split("\n")
    assert len(lines) == 51
    assert lines[-1].startswith("… truncated: showing 50 of 62 results (12 omitted)")


@pytest.mark.asyncio
async def test_workspace_symbol_ranks_and_tags_match_quality(tmp_path: Path):
    source = tmp_path / "symbols.py"
    source.write_text("", encoding="utf-8")
    _sandbox(tmp_path)
    with patch(
        "app.agent.tools.builtin.lsp.lsp_manager.navigation",
        new_callable=AsyncMock,
        return_value=[
            {
                "name": "AbstractUserAdapter",  # fuzzy match only
                "location": {
                    "uri": (tmp_path / "a.py").as_uri(),
                    "range": {"start": {"line": 0, "character": 0}},
                },
            },
            {
                "name": "UserProfile",  # prefix match
                "location": {
                    "uri": (tmp_path / "b.py").as_uri(),
                    "range": {"start": {"line": 0, "character": 0}},
                },
            },
            {
                "name": "User",  # exact match
                "location": {
                    "uri": (tmp_path / "c.py").as_uri(),
                    "range": {"start": {"line": 0, "character": 0}},
                },
            },
        ],
    ):
        result = await lsp_navigation.arun(
            operation="workspace_symbol",
            path="symbols.py",
            query="user",
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
        )

    assert result == (
        "User [exact] | c.py:1:1\n"
        "UserProfile [prefix] | b.py:1:1\n"
        "AbstractUserAdapter | a.py:1:1"
    )


@pytest.mark.asyncio
async def test_find_implementations_reports_position_problem_over_overridability(
    tmp_path: Path,
):
    """Landing on whitespace is a position error, not evidence that the symbol
    has no implementations."""
    source = tmp_path / "main.py"
    source.write_text("class Base:  \n    pass\n", encoding="utf-8")
    _sandbox(tmp_path)
    with patch(
        "app.agent.tools.builtin.lsp.lsp_manager.navigation",
        new_callable=AsyncMock,
        return_value=[],
    ):
        whitespace = await lsp_navigation.arun(
            operation="find_implementations",
            path="main.py",
            line=1,
            character=12,
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
        )
        on_symbol = await lsp_navigation.arun(
            operation="find_implementations",
            path="main.py",
            line=1,
            character=7,
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
        )

    assert "whitespace" in whitespace
    assert "overridable" not in whitespace
    assert "symbol 'Base' is not an interface" in on_symbol


@pytest.mark.asyncio
async def test_missing_file_error_is_actionable(tmp_path: Path):
    _sandbox(tmp_path)
    with pytest.raises(ToolExecutionError, match="workspace-relative"):
        await lsp_navigation.arun(
            operation="document_symbol",
            path="src/apps/auth/models/user.py",
            _injected={"_mode": "coding", "_workspace": str(tmp_path)},
        )
