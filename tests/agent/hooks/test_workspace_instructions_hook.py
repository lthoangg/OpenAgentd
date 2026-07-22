from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from app.agent.hooks.workspace_instructions import (
    MAX_AGENTS_MD_BYTES,
    WorkspaceInstructionsHook,
)


@pytest.mark.asyncio
async def test_workspace_instructions_hook_injects_agents_md(tmp_path):
    (tmp_path / "AGENTS.md").write_text("Follow project rules.", encoding="utf-8")
    hook = WorkspaceInstructionsHook(str(tmp_path))
    seen: dict[str, str] = {}

    class Request:
        system_prompt = "Base prompt"

        def override(self, **kwargs):
            return SimpleNamespace(**kwargs)

    async def handler(request):
        seen["prompt"] = request.system_prompt
        return SimpleNamespace(content="ok")

    await hook.wrap_model_call(None, None, Request(), handler)  # type: ignore[arg-type]

    assert "Base prompt" in seen["prompt"]
    assert "Follow project rules." in seen["prompt"]


@pytest.mark.asyncio
async def test_workspace_instructions_hook_caches_unchanged_agents_md(
    tmp_path, monkeypatch
):
    agents_md = tmp_path / "AGENTS.md"
    agents_md.write_text("Follow project rules.", encoding="utf-8")
    hook = WorkspaceInstructionsHook(str(tmp_path))
    read_count = 0
    original_read_text = Path.read_text

    def count_reads(path, *args, **kwargs):
        nonlocal read_count
        if path == agents_md:
            read_count += 1
        return original_read_text(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", count_reads)

    class Request:
        system_prompt = "Base prompt"

        def override(self, **kwargs):
            return SimpleNamespace(**kwargs)

    async def handler(request):
        return SimpleNamespace(content="ok")

    await hook.wrap_model_call(None, None, Request(), handler)  # type: ignore[arg-type]
    await hook.wrap_model_call(None, None, Request(), handler)  # type: ignore[arg-type]

    assert read_count == 1


@pytest.mark.asyncio
async def test_workspace_instructions_hook_refreshes_changed_agents_md(tmp_path):
    agents_md = tmp_path / "AGENTS.md"
    agents_md.write_text("Follow original rules.", encoding="utf-8")
    hook = WorkspaceInstructionsHook(str(tmp_path))
    prompts: list[str] = []

    class Request:
        system_prompt = "Base prompt"

        def override(self, **kwargs):
            return SimpleNamespace(**kwargs)

    async def handler(request):
        prompts.append(request.system_prompt)
        return SimpleNamespace(content="ok")

    await hook.wrap_model_call(None, None, Request(), handler)  # type: ignore[arg-type]
    agents_md.write_text("Follow revised rules.", encoding="utf-8")
    await hook.wrap_model_call(None, None, Request(), handler)  # type: ignore[arg-type]

    assert "Follow original rules." in prompts[0]
    assert "Follow revised rules." in prompts[1]
    assert "Follow original rules." not in prompts[1]


@pytest.mark.asyncio
async def test_workspace_instructions_hook_handles_agents_md_creation_and_removal(
    tmp_path,
):
    agents_md = tmp_path / "AGENTS.md"
    (tmp_path / "CLAUDE.md").write_text("Follow Claude rules.", encoding="utf-8")
    hook = WorkspaceInstructionsHook(str(tmp_path))
    prompts: list[str] = []

    class Request:
        system_prompt = "Base prompt"

        def override(self, **kwargs):
            return SimpleNamespace(**kwargs)

    async def handler(request):
        prompts.append(request.system_prompt)
        return SimpleNamespace(content="ok")

    await hook.wrap_model_call(None, None, Request(), handler)  # type: ignore[arg-type]
    agents_md.write_text("Follow AGENTS rules.", encoding="utf-8")
    await hook.wrap_model_call(None, None, Request(), handler)  # type: ignore[arg-type]
    agents_md.unlink()
    await hook.wrap_model_call(None, None, Request(), handler)  # type: ignore[arg-type]

    assert "Follow Claude rules." in prompts[0]
    assert "Follow AGENTS rules." in prompts[1]
    assert "Follow Claude rules." in prompts[2]


@pytest.mark.asyncio
async def test_workspace_instructions_hook_falls_back_to_claude_md(tmp_path):
    (tmp_path / "CLAUDE.md").write_text("Follow Claude rules.", encoding="utf-8")
    hook = WorkspaceInstructionsHook(str(tmp_path))
    seen: dict[str, str] = {}

    class Request:
        system_prompt = "Base prompt"

        def override(self, **kwargs):
            return SimpleNamespace(**kwargs)

    async def handler(request):
        seen["prompt"] = request.system_prompt
        return SimpleNamespace(content="ok")

    await hook.wrap_model_call(None, None, Request(), handler)  # type: ignore[arg-type]

    assert "Base prompt" in seen["prompt"]
    assert "Follow Claude rules." in seen["prompt"]


@pytest.mark.asyncio
async def test_workspace_instructions_hook_prefers_agents_md_over_claude_md(tmp_path):
    (tmp_path / "AGENTS.md").write_text("Follow project rules.", encoding="utf-8")
    (tmp_path / "CLAUDE.md").write_text("Follow Claude rules.", encoding="utf-8")
    hook = WorkspaceInstructionsHook(str(tmp_path))
    seen: dict[str, str] = {}

    class Request:
        system_prompt = "Base prompt"

        def override(self, **kwargs):
            return SimpleNamespace(**kwargs)

    async def handler(request):
        seen["prompt"] = request.system_prompt
        return SimpleNamespace(content="ok")

    await hook.wrap_model_call(None, None, Request(), handler)  # type: ignore[arg-type]

    assert "Follow project rules." in seen["prompt"]
    assert "Follow Claude rules." not in seen["prompt"]


@pytest.mark.asyncio
async def test_workspace_instructions_hook_skips_missing_instruction_files(tmp_path):
    hook = WorkspaceInstructionsHook(str(tmp_path))
    seen: dict[str, str] = {}

    class Request:
        system_prompt = "Base prompt"

        def override(self, **kwargs):
            return SimpleNamespace(**kwargs)

    async def handler(request):
        seen["prompt"] = request.system_prompt
        return SimpleNamespace(content="ok")

    await hook.wrap_model_call(None, None, Request(), handler)  # type: ignore[arg-type]

    assert seen["prompt"] == "Base prompt"


@pytest.mark.asyncio
async def test_workspace_instructions_hook_skips_blank_agents_md(tmp_path):
    (tmp_path / "AGENTS.md").write_text("\n  \t\n", encoding="utf-8")
    hook = WorkspaceInstructionsHook(str(tmp_path))
    seen: dict[str, str] = {}

    class Request:
        system_prompt = "Base prompt"

        def override(self, **kwargs):
            raise AssertionError("blank AGENTS.md should not override the request")

    async def handler(request):
        seen["prompt"] = request.system_prompt
        return SimpleNamespace(content="ok")

    await hook.wrap_model_call(None, None, Request(), handler)  # type: ignore[arg-type]

    assert seen["prompt"] == "Base prompt"


@pytest.mark.asyncio
async def test_workspace_instructions_hook_skips_oversized_agents_md(tmp_path):
    (tmp_path / "AGENTS.md").write_text(
        "x" * (MAX_AGENTS_MD_BYTES + 1), encoding="utf-8"
    )
    hook = WorkspaceInstructionsHook(str(tmp_path))
    seen: dict[str, str] = {}

    class Request:
        system_prompt = "Base prompt"

        def override(self, **kwargs):
            raise AssertionError("oversized AGENTS.md should not override the request")

    async def handler(request):
        seen["prompt"] = request.system_prompt
        return SimpleNamespace(content="ok")

    await hook.wrap_model_call(None, None, Request(), handler)  # type: ignore[arg-type]

    assert seen["prompt"] == "Base prompt"
