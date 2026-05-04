from __future__ import annotations

from pathlib import Path

import pytest

from app.cli.commands.migrate import migrate_hermes_agent, migrate_openclaw_agent


def test_migrate_openclaw_agent_imports_prompt_files(tmp_path: Path):
    source = tmp_path / "openclaw-workspace"
    source.mkdir()
    (source / "AGENTS.md").write_text(
        "---\ntitle: AGENTS template\n---\n\nAgent instructions",
        encoding="utf-8",
    )
    (source / "SOULS.md").write_text("Soul instructions", encoding="utf-8")
    (source / "TOOLS.md").write_text("Tool instructions", encoding="utf-8")

    result = migrate_openclaw_agent(
        source,
        tmp_path / "config",
        name="clawd",
        model="openai:gpt-5.5",
    )

    assert result.imported_files == ["AGENTS.md", "SOULS.md", "TOOLS.md"]
    assert result.target == tmp_path / "config" / "agents" / "clawd.md"
    content = result.target.read_text(encoding="utf-8")
    assert "name: clawd" in content
    assert "role: lead" in content
    assert "model: openai:gpt-5.5" in content
    assert "# Imported from AGENTS.md" in content
    assert "Agent instructions" in content
    assert "title: AGENTS template" not in content
    assert "# Imported from SOULS.md" in content
    assert "Soul instructions" in content


def test_migrate_openclaw_agent_refuses_existing_target(tmp_path: Path):
    source = tmp_path / "openclaw-workspace"
    source.mkdir()
    (source / "SOUL.md").write_text("Soul instructions", encoding="utf-8")
    target = tmp_path / "config" / "agents" / "openclaw.md"
    target.parent.mkdir(parents=True)
    target.write_text("existing", encoding="utf-8")

    with pytest.raises(FileExistsError, match="Pass --force"):
        migrate_openclaw_agent(
            source,
            tmp_path / "config",
            name="openclaw",
            model="openai:gpt-5.5",
        )

    assert target.read_text(encoding="utf-8") == "existing"


def test_migrate_openclaw_agent_requires_prompt_file(tmp_path: Path):
    source = tmp_path / "openclaw-workspace"
    source.mkdir()

    with pytest.raises(ValueError, match="No OpenClaw prompt files found"):
        migrate_openclaw_agent(
            source,
            tmp_path / "config",
            name="openclaw",
            model="openai:gpt-5.5",
        )


def test_migrate_openclaw_agent_rejects_path_name(tmp_path: Path):
    source = tmp_path / "openclaw-workspace"
    source.mkdir()
    (source / "SOUL.md").write_text("Soul instructions", encoding="utf-8")

    with pytest.raises(ValueError, match="filename"):
        migrate_openclaw_agent(
            source,
            tmp_path / "config",
            name="../openclaw",
            model="openai:gpt-5.5",
        )


def test_migrate_hermes_agent_imports_context_files(tmp_path: Path):
    source = tmp_path / "hermes-home"
    source.mkdir()
    (source / "SOUL.md").write_text("Hermes identity", encoding="utf-8")
    (source / ".hermes.md").write_text("Project context", encoding="utf-8")
    (source / "AGENTS.md").write_text("Agent conventions", encoding="utf-8")

    result = migrate_hermes_agent(
        source,
        tmp_path / "config",
        name="hermes",
        model="openai:gpt-5.5",
    )

    assert result.imported_files == ["SOUL.md", ".hermes.md", "AGENTS.md"]
    assert result.target == tmp_path / "config" / "agents" / "hermes.md"
    content = result.target.read_text(encoding="utf-8")
    assert "name: hermes" in content
    assert "role: lead" in content
    assert "model: openai:gpt-5.5" in content
    assert "# Imported from SOUL.md" in content
    assert "Hermes identity" in content
    assert "# Imported from .hermes.md" in content
    assert "Project context" in content


def test_migrate_hermes_agent_requires_context_file(tmp_path: Path):
    source = tmp_path / "hermes-home"
    source.mkdir()

    with pytest.raises(ValueError, match="No Hermes context files found"):
        migrate_hermes_agent(
            source,
            tmp_path / "config",
            name="hermes",
            model="openai:gpt-5.5",
        )
