from __future__ import annotations

from pathlib import Path

from app.core.workspace_init import ensure_workspace_initialized


def _patch_workspace_paths(monkeypatch, tmp_path: Path) -> Path:
    import app.core.workspace_init as workspace_init

    config = tmp_path / "config"
    monkeypatch.setattr(
        workspace_init.settings, "OPENAGENTD_DATA_DIR", str(tmp_path / "data")
    )
    monkeypatch.setattr(workspace_init.settings, "OPENAGENTD_CONFIG_DIR", str(config))
    monkeypatch.setattr(
        workspace_init.settings, "OPENAGENTD_STATE_DIR", str(tmp_path / "state")
    )
    monkeypatch.setattr(
        workspace_init.settings, "OPENAGENTD_CACHE_DIR", str(tmp_path / "cache")
    )
    monkeypatch.setattr(
        workspace_init.settings, "OPENAGENTD_WORKSPACE_DIR", str(tmp_path / "workspace")
    )
    monkeypatch.setattr(workspace_init.settings, "AGENTS_DIR", str(config / "agents"))
    monkeypatch.setattr(workspace_init.settings, "SKILLS_DIR", str(config / "skills"))
    monkeypatch.setattr(
        workspace_init.settings, "OPENAGENTD_PLUGINS_DIRS", str(config / "plugins")
    )
    return config


def test_ensure_workspace_initialized_creates_roots_and_builtin_defaults(
    monkeypatch,
    tmp_path: Path,
) -> None:
    config = _patch_workspace_paths(monkeypatch, tmp_path)

    ensure_workspace_initialized()

    assert (config / "agents").is_dir()
    assert (config / "skills").is_dir()
    assert (config / "plugins").is_dir()
    assert (tmp_path / "cache").is_dir()
    assert (config / "agents" / "code.md").is_file()
    assert not (config / "agents" / "coding").exists()
    assert (config / "settings.yaml").is_file()
    assert (config / "multimodal.yaml").is_file()

    default_model = "opencode:deepseek-v4-flash-free"
    for agent_file in (config / "agents").rglob("*.md"):
        assert f"model: {default_model}" in agent_file.read_text(encoding="utf-8")
    assert f"model: {default_model}" in (config / "settings.yaml").read_text(
        encoding="utf-8"
    )


def test_ensure_workspace_initialized_preserves_existing_agents(
    monkeypatch,
    tmp_path: Path,
) -> None:
    config = _patch_workspace_paths(monkeypatch, tmp_path)
    agents = config / "agents"
    agents.mkdir(parents=True)
    existing = agents / "code.md"
    existing.write_text(
        "---\nname: code\nrole: lead\nmodel: openai:gpt-5\n---\n",
        encoding="utf-8",
    )

    ensure_workspace_initialized()

    assert "model: openai:gpt-5" in existing.read_text(encoding="utf-8")


def test_ensure_workspace_initialized_restores_missing_default_agent(
    monkeypatch,
    tmp_path: Path,
) -> None:
    config = _patch_workspace_paths(monkeypatch, tmp_path)
    agents = config / "agents"
    agents.mkdir(parents=True)
    (agents / "executor.md").write_text(
        "---\nname: executor\nrole: member\nmodel: openai:gpt-5\n---\n",
        encoding="utf-8",
    )

    ensure_workspace_initialized()

    lead = agents / "code.md"
    assert lead.is_file()
    text = lead.read_text(encoding="utf-8")
    assert "role: lead" in text
    assert "model: opencode:deepseek-v4-flash-free" in text
