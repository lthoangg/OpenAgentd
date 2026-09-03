from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from app.agent.hooks.workspace_instructions import (
    MAX_AGENTS_MD_BYTES,
    WorkspaceInstructionsHook,
    global_instructions_path,
)


class _Request:
    system_prompt = "Base prompt"

    def override(self, **kwargs):
        return SimpleNamespace(**kwargs)


async def _capture(hook: WorkspaceInstructionsHook) -> str:
    seen: dict[str, str] = {}

    async def handler(request):
        seen["prompt"] = request.system_prompt
        return SimpleNamespace(content="ok")

    await hook.wrap_model_call(None, None, _Request(), handler)  # type: ignore[arg-type]
    return seen["prompt"]


@pytest.mark.asyncio
async def test_global_agents_md_is_injected_before_workspace_instructions(tmp_path):
    workspace = tmp_path / "ws"
    workspace.mkdir()
    (workspace / "AGENTS.md").write_text("Project rule.", encoding="utf-8")
    global_md = tmp_path / "config" / "AGENTS.md"
    global_md.parent.mkdir()
    global_md.write_text("Global rule.", encoding="utf-8")

    hook = WorkspaceInstructionsHook(str(workspace), global_instructions=global_md)
    prompt = await _capture(hook)

    assert "## Global Instructions" in prompt
    assert "Global rule." in prompt
    assert "Project rule." in prompt
    # Broad guidance first, scoped guidance after — matches how peers
    # (pi, opencode, codex) order global → project.
    assert prompt.index("Global rule.") < prompt.index("Project rule.")


@pytest.mark.asyncio
async def test_global_agents_md_applies_without_a_workspace(tmp_path):
    global_md = tmp_path / "AGENTS.md"
    global_md.write_text("Always be terse.", encoding="utf-8")

    hook = WorkspaceInstructionsHook(None, global_instructions=global_md)
    prompt = await _capture(hook)

    assert "Always be terse." in prompt
    assert "## Workspace" not in prompt


@pytest.mark.asyncio
async def test_missing_global_agents_md_injects_no_global_block(tmp_path):
    hook = WorkspaceInstructionsHook(
        str(tmp_path), global_instructions=tmp_path / "nope" / "AGENTS.md"
    )
    prompt = await _capture(hook)

    assert "## Global Instructions" not in prompt
    assert "## Workspace" in prompt


def test_global_instructions_path_lives_in_the_config_dir(monkeypatch, tmp_path):
    from app.core import config as config_module

    monkeypatch.setattr(
        config_module.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path / "cfg")
    )
    assert global_instructions_path() == tmp_path / "cfg" / "AGENTS.md"


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
async def test_workspace_instructions_hook_injects_workspace_root_even_without_agents_md(
    tmp_path,
):
    """The absolute workspace root is injected unconditionally in coding mode

    (no AGENTS.md/CLAUDE.md required) so read/ls/grep/glob/edit/write/shell
    calls can use workspace-relative paths without guessing the root.
    """
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
    assert str(tmp_path.resolve()) in seen["prompt"]


@pytest.mark.asyncio
async def test_workspace_instructions_hook_skips_blank_agents_md(tmp_path):
    (tmp_path / "AGENTS.md").write_text("\n  \t\n", encoding="utf-8")
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
    assert "\t" not in seen["prompt"]


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
            return SimpleNamespace(**kwargs)

    async def handler(request):
        seen["prompt"] = request.system_prompt
        return SimpleNamespace(content="ok")

    await hook.wrap_model_call(None, None, Request(), handler)  # type: ignore[arg-type]

    assert "Base prompt" in seen["prompt"]
    assert "x" * 100 not in seen["prompt"]


@pytest.mark.asyncio
async def test_workspace_instructions_hook_is_noop_without_a_workspace():
    hook = WorkspaceInstructionsHook(None)
    seen: dict[str, str] = {}

    class Request:
        system_prompt = "Base prompt"

        def override(self, **kwargs):
            raise AssertionError("no workspace configured — must not override")

    async def handler(request):
        seen["prompt"] = request.system_prompt
        return SimpleNamespace(content="ok")

    await hook.wrap_model_call(None, None, Request(), handler)  # type: ignore[arg-type]

    assert seen["prompt"] == "Base prompt"
