"""Tests for MemoryContextHook and session memory lifecycle integration."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from app.agent.hooks.memory_context import MemoryContextHook
from app.agent.schemas.chat import HumanMessage
from app.agent.state import AgentState, RunContext
from app.core.config import settings
from app.services.memory import get_memory_manager
from app.services.memory.manager import reset_memory_manager


@pytest.fixture(autouse=True)
def _clean_memory_manager():
    reset_memory_manager()
    yield
    reset_memory_manager()


def make_state(prompt: str = "Base prompt.") -> AgentState:
    return AgentState(
        messages=[HumanMessage(content="hello")],
        system_prompt=prompt,
    )


def make_ctx() -> RunContext:
    return RunContext(
        session_id="test-session", run_id="test-run", agent_name="openagentd"
    )


@pytest.mark.asyncio
async def test_memory_context_hook_injects_prompt(tmp_path: Path, monkeypatch):
    config_dir = tmp_path / "config"
    monkeypatch.setattr(settings, "OPENAGENTD_CONFIG_DIR", str(config_dir))
    pref_file = config_dir / "memory" / "preferences.md"
    pref_file.parent.mkdir(parents=True, exist_ok=True)
    pref_file.write_text("Always write concise code.\n")
    (config_dir / "memory" / "auth.md").write_text("# Auth\nUse JWT tokens.\n")

    ws = tmp_path / "ws"
    ws.mkdir(parents=True, exist_ok=True)

    session = MagicMock()
    session.workspace = str(ws)
    session.memory_context_snapshot = None

    # Bind real ensure_memory_context_current behavior to session mock
    from app.agent.session import AgentSession

    session.ensure_memory_context_current = (
        AgentSession.ensure_memory_context_current.__get__(session, AgentSession)
    )

    hook = MemoryContextHook(session)
    state = make_state("You are a helpful coding assistant.")
    ctx = make_ctx()

    await hook.before_agent(ctx, state)

    assert "<openagentd_memory>" in state.system_prompt
    assert "<global_preferences>" in state.system_prompt
    assert "Always write concise code." in state.system_prompt
    assert "[[global:auth]]" in state.system_prompt
    assert "Use JWT tokens." in state.system_prompt
    assert "</openagentd_memory>" in state.system_prompt


@pytest.mark.asyncio
async def test_memory_context_snapshot_caching_across_runs(tmp_path: Path, monkeypatch):
    config_dir = tmp_path / "config"
    monkeypatch.setattr(settings, "OPENAGENTD_CONFIG_DIR", str(config_dir))
    pref_file = config_dir / "memory" / "preferences.md"
    pref_file.parent.mkdir(parents=True, exist_ok=True)
    pref_file.write_text("Be fast.\n")

    ws = tmp_path / "ws"
    ws.mkdir(parents=True, exist_ok=True)

    session = MagicMock()
    session.workspace = str(ws)
    session.memory_context_snapshot = None

    from app.agent.session import AgentSession

    session.ensure_memory_context_current = (
        AgentSession.ensure_memory_context_current.__get__(session, AgentSession)
    )

    snap1 = await session.ensure_memory_context_current()
    snap2 = await session.ensure_memory_context_current()

    # Exact same snapshot object returned from cache (zero disk reads)
    assert snap1 is snap2
    assert snap1.content_hash == snap2.content_hash


@pytest.mark.asyncio
async def test_memory_context_invalidation_updates_snapshot(
    tmp_path: Path, monkeypatch
):
    config_dir = tmp_path / "config"
    monkeypatch.setattr(settings, "OPENAGENTD_CONFIG_DIR", str(config_dir))
    pref_file = config_dir / "memory" / "preferences.md"
    pref_file.parent.mkdir(parents=True, exist_ok=True)
    pref_file.write_text("V1.\n")

    ws = tmp_path / "ws"
    ws.mkdir(parents=True, exist_ok=True)

    session = MagicMock()
    session.workspace = str(ws)
    session.memory_context_snapshot = None

    from app.agent.session import AgentSession

    session.ensure_memory_context_current = (
        AgentSession.ensure_memory_context_current.__get__(session, AgentSession)
    )

    snap1 = await session.ensure_memory_context_current()
    assert "V1." in snap1.content

    # Mutate and invalidate
    pref_file.write_text("V2.\n")
    manager = get_memory_manager()
    manager.invalidate("global")

    snap2 = await session.ensure_memory_context_current()
    assert snap1 is not snap2
    assert "V2." in snap2.content
