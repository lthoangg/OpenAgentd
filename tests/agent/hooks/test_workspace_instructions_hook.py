from __future__ import annotations

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
