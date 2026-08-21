"""Protocol tests for LSP navigation."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from app.services.lsp.manager import LspManager


async def test_python_navigation_falls_back_from_ruff_to_semantic_server(
    tmp_path: Path,
):
    manager = LspManager()

    def installed(command: str, *, path: str | None = None) -> str | None:
        del path
        if command in {"ruff", "pyright-langserver"}:
            return f"/usr/bin/{command}"
        return None

    with (
        patch(
            "app.services.lsp.manager.detect_project_lsp_commands",
            return_value=[["ruff", "server"]],
        ),
        patch("app.services.lsp.manager.shutil.which", side_effect=installed),
    ):
        commands = await manager._detect_commands(
            "python", tmp_path, semantic_only=True
        )

    assert commands == [["pyright-langserver", "--stdio"]]


async def test_python_navigation_skips_absolute_ruff_command(tmp_path: Path):
    manager = LspManager()

    def installed(command: str, *, path: str | None = None) -> str | None:
        del path
        if command == "/opt/openagentd/bin/ruff":
            return command
        if command == "pyright-langserver":
            return "/usr/bin/pyright-langserver"
        return None

    with (
        patch(
            "app.services.lsp.manager.detect_project_lsp_commands",
            return_value=[["/opt/openagentd/bin/ruff", "server"]],
        ),
        patch("app.services.lsp.manager.shutil.which", side_effect=installed),
    ):
        commands = await manager._detect_commands(
            "python", tmp_path, semantic_only=True
        )

    assert commands == [["pyright-langserver", "--stdio"]]


async def test_navigation_sends_definition_and_closes_document_on_timeout(
    tmp_path: Path,
):
    source = tmp_path / "main.py"
    source.write_text("answer()\n", encoding="utf-8")
    client = MagicMock()
    client.diagnostics_lock.return_value = __import__("asyncio").Lock()
    client.open_or_update_document = AsyncMock()
    client.close_document = AsyncMock()
    client.send_request = AsyncMock()
    client.send_request.side_effect = TimeoutError
    manager = LspManager()
    manager.get_clients = AsyncMock(return_value=[client])

    assert (
        await manager.navigation(
            "go_to_definition", tmp_path, file_path=source, line=3, character=4
        )
        == []
    )

    client.open_or_update_document.assert_awaited_once_with(
        source.as_uri(), "python", "answer()\n"
    )
    client.send_request.assert_awaited_once_with(
        "textDocument/definition",
        {
            "textDocument": {"uri": source.as_uri()},
            "position": {"line": 3, "character": 4},
        },
    )
    client.close_document.assert_awaited_once_with(source.as_uri())


async def test_navigation_uses_workspace_symbol_protocol_and_flattens_symbols(
    tmp_path: Path,
):
    source = tmp_path / "main.py"
    source.write_text("answer()\n", encoding="utf-8")
    client = MagicMock()
    client.diagnostics_lock.return_value = __import__("asyncio").Lock()
    client.open_or_update_document = AsyncMock()
    client.close_document = AsyncMock()
    client.send_request = AsyncMock(
        return_value=[
            {
                "name": "Parent",
                "range": {"start": {"line": 0, "character": 0}},
                "children": [
                    {
                        "name": "Child",
                        "range": {"start": {"line": 1, "character": 0}},
                    }
                ],
            }
        ]
    )
    manager = LspManager()
    manager.get_clients = AsyncMock(return_value=[client])

    symbols = await manager.navigation("document_symbol", tmp_path, file_path=source)

    client.send_request.assert_awaited_once_with(
        "textDocument/documentSymbol", {"textDocument": {"uri": source.as_uri()}}
    )
    assert [symbol["name"] for symbol in symbols] == ["Parent", "Child"]
    assert all(symbol["location"]["uri"] == source.as_uri() for symbol in symbols)


async def test_navigation_flattens_document_symbol_using_selection_range(
    tmp_path: Path,
):
    """A DocumentSymbol's ``range`` spans the whole declaration (e.g. starting

    at ``async``/``def``); ``selectionRange`` is just the identifier. Callers
    feed a reported location straight back into go_to_definition/hover, so
    the flattened location must point at the identifier, not the keyword.
    """
    source = tmp_path / "main.py"
    source.write_text("async def health_check():\n    ...\n", encoding="utf-8")
    client = MagicMock()
    client.diagnostics_lock.return_value = __import__("asyncio").Lock()
    client.open_or_update_document = AsyncMock()
    client.close_document = AsyncMock()
    client.send_request = AsyncMock(
        return_value=[
            {
                "name": "health_check",
                "range": {
                    "start": {"line": 23, "character": 0},
                    "end": {"line": 24, "character": 8},
                },
                "selectionRange": {
                    "start": {"line": 23, "character": 10},
                    "end": {"line": 23, "character": 22},
                },
            }
        ]
    )
    manager = LspManager()
    manager.get_clients = AsyncMock(return_value=[client])

    symbols = await manager.navigation("document_symbol", tmp_path, file_path=source)

    assert symbols[0]["location"]["range"]["start"] == {
        "line": 23,
        "character": 10,
    }


async def test_navigation_sends_references_context(tmp_path: Path):
    source = tmp_path / "main.py"
    source.write_text("answer()\n", encoding="utf-8")
    client = MagicMock()
    client.diagnostics_lock.return_value = __import__("asyncio").Lock()
    client.open_or_update_document = AsyncMock()
    client.close_document = AsyncMock()
    client.send_request = AsyncMock(return_value=[])
    manager = LspManager()
    manager.get_clients = AsyncMock(return_value=[client])

    await manager.navigation(
        "find_references", tmp_path, file_path=source, line=3, character=4
    )

    client.send_request.assert_awaited_once_with(
        "textDocument/references",
        {
            "textDocument": {"uri": source.as_uri()},
            "position": {"line": 3, "character": 4},
            "context": {"includeDeclaration": True},
        },
    )


async def test_navigation_sends_workspace_symbol_query(tmp_path: Path):
    source = tmp_path / "main.py"
    source.write_text("answer()\n", encoding="utf-8")
    client = MagicMock()
    client.diagnostics_lock.return_value = __import__("asyncio").Lock()
    client.open_or_update_document = AsyncMock()
    client.close_document = AsyncMock()
    client.send_request = AsyncMock(return_value=[])
    manager = LspManager()
    manager.get_clients = AsyncMock(return_value=[client])

    await manager.navigation(
        "workspace_symbol", tmp_path, file_path=source, query="answer"
    )

    client.send_request.assert_awaited_once_with(
        "workspace/symbol", {"query": "answer"}
    )


def test_ts_init_options_propagates_paths_and_baseurl(tmp_path: Path):
    from app.services.lsp.manager import _build_ts_init_options

    tsconfig = tmp_path / "tsconfig.json"
    tsconfig.write_text(
        '{"compilerOptions": {"baseUrl": ".", "paths": {"@/*": ["src/*"]}}}',
        encoding="utf-8",
    )

    options = _build_ts_init_options(tmp_path)
    compiler_opts = options.get("compilerOptions", {})
    assert compiler_opts.get("baseUrl") == "."
    assert compiler_opts.get("paths") == {"@/*": ["src/*"]}


def test_python_init_options_detects_virtualenv(tmp_path: Path):
    from app.services.lsp.manager import _build_python_init_options

    venv_bin = tmp_path / ".venv" / "bin"
    venv_bin.mkdir(parents=True)
    (venv_bin / "python").write_text("#!/bin/sh\n", encoding="utf-8")

    options = _build_python_init_options(tmp_path)
    assert options is not None
    assert str(tmp_path / ".venv" / "bin" / "python") in options.get("pythonPath", "")
    assert options.get("venv") == ".venv"
