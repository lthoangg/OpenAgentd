"""Tests for read tool outline feature."""

from __future__ import annotations

import pytest

from app.agent.denied_paths import (
    DeniedPathsConfig as SandboxConfig,
    set_denied_paths as set_sandbox,
)
from app.agent.errors import ToolExecutionError
from app.agent.tools.builtin.filesystem import read_file


@pytest.fixture
def sandbox_workspace(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    config = SandboxConfig(workspace=str(workspace))
    set_sandbox(config)
    yield workspace


@pytest.mark.asyncio
async def test_read_outline_python(sandbox_workspace):
    code = (
        "import os\n"
        "\n"
        "GLOBAL_VAR: int = 42\n"
        "\n"
        "def helper_func(x: int, y: str = 'a') -> bool:\n"
        "    return True\n"
        "\n"
        "class MyService:\n"
        "    field: str\n"
        "\n"
        "    def __init__(self, name: str):\n"
        "        self.name = name\n"
        "\n"
        "    async def fetch_data(self, key: str) -> dict[str, Any]:\n"
        "        pass\n"
    )
    (sandbox_workspace / "service.py").write_text(code)

    result = await read_file.arun(path="service.py", outline=True)

    assert "[Outline of service.py" in result
    assert "Line 5: def helper_func(x: int, y: str = 'a') -> bool" in result
    assert "Line 8: class MyService:" in result
    assert "Line 11:   def __init__(self, name: str)" in result
    assert "Line 14:   async def fetch_data(self, key: str) -> dict[str, Any]" in result


@pytest.mark.asyncio
async def test_read_outline_rust(sandbox_workspace):
    code = (
        "pub struct Config {\n"
        "    pub port: u16,\n"
        "}\n"
        "\n"
        "pub enum Status {\n"
        "    Running,\n"
        "    Stopped,\n"
        "}\n"
        "\n"
        "pub async fn start_server(cfg: Config) -> Result<(), Error> {\n"
        "    Ok(())\n"
        "}\n"
    )
    (sandbox_workspace / "main.rs").write_text(code)

    result = await read_file.arun(path="main.rs", outline=True)

    assert "[Outline of main.rs" in result
    assert "Line 1: pub struct Config" in result
    assert "Line 5: pub enum Status" in result
    assert (
        "Line 10: pub async fn start_server(cfg: Config) -> Result<(), Error>" in result
    )


@pytest.mark.asyncio
async def test_read_outline_go(sandbox_workspace):
    code = (
        "package main\n"
        "\n"
        "type Server struct {\n"
        "    Port int\n"
        "}\n"
        "\n"
        "func NewServer(port int) *Server {\n"
        "    return &Server{Port: port}\n"
        "}\n"
    )
    (sandbox_workspace / "server.go").write_text(code)

    result = await read_file.arun(path="server.go", outline=True)

    assert "[Outline of server.go" in result
    assert "Line 3: type Server struct" in result
    assert "Line 7: func NewServer(port int) *Server" in result


@pytest.mark.asyncio
async def test_read_outline_python_syntax_error_fallback(sandbox_workspace):
    code = "def broken(\n  # invalid syntax\n"
    (sandbox_workspace / "bad.py").write_text(code)

    result = await read_file.arun(path="bad.py", outline=True)

    assert "[Outline of bad.py (2 lines): no symbol declarations found]" in result


@pytest.mark.asyncio
async def test_read_outline_typescript(sandbox_workspace):
    code = (
        "import React from 'react';\n"
        "\n"
        "export interface UserProps {\n"
        "  id: string;\n"
        "  name: string;\n"
        "}\n"
        "\n"
        "export type Status = 'active' | 'inactive';\n"
        "\n"
        "export function UserAvatar(props: UserProps) {\n"
        "  return <div />;\n"
        "}\n"
        "\n"
        "export class UserManager {\n"
        "  async getUser(id: string): Promise<UserProps> {}\n"
        "}\n"
    )
    (sandbox_workspace / "user.tsx").write_text(code)

    result = await read_file.arun(path="user.tsx", outline=True)

    assert "[Outline of user.tsx" in result
    assert "Line 3: export interface UserProps" in result
    assert "Line 8: export type Status = 'active' | 'inactive'" in result
    assert "Line 10: export function UserAvatar(props: UserProps)" in result
    assert "Line 14: export class UserManager" in result


@pytest.mark.asyncio
async def test_read_outline_markdown(sandbox_workspace):
    doc = (
        "# Project Title\n"
        "Intro text.\n"
        "## Architecture\n"
        "Details.\n"
        "### Subsystem A\n"
        "More details.\n"
        "## Setup Guide\n"
    )
    (sandbox_workspace / "README.md").write_text(doc)

    result = await read_file.arun(path="README.md", outline=True)

    assert "[Outline of README.md" in result
    assert "Line 1: # Project Title" in result
    assert "Line 3: ## Architecture" in result
    assert "Line 5: ### Subsystem A" in result
    assert "Line 7: ## Setup Guide" in result


@pytest.mark.asyncio
async def test_read_outline_no_symbols(sandbox_workspace):
    (sandbox_workspace / "plain.txt").write_text(
        "just plain text without symbols\nline 2\n"
    )

    result = await read_file.arun(path="plain.txt", outline=True)

    assert "[Outline of plain.txt" in result
    assert "no symbol declarations found" in result


@pytest.mark.asyncio
async def test_read_outline_empty_file(sandbox_workspace):
    (sandbox_workspace / "empty.py").write_text("")

    result = await read_file.arun(path="empty.py", outline=True)

    assert "[Outline of empty.py (empty file)]" in result


@pytest.mark.asyncio
async def test_read_outline_directory_falls_back_to_listing(sandbox_workspace):
    (sandbox_workspace / "pkg").mkdir()
    (sandbox_workspace / "pkg" / "a.py").write_text("print(1)")

    result = await read_file.arun(path="pkg", outline=True)

    assert "[f] a.py" in result


@pytest.mark.asyncio
async def test_read_outline_missing_file_raises(sandbox_workspace):
    with pytest.raises(ToolExecutionError):
        await read_file.arun(path="nonexistent.py", outline=True)
