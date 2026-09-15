"""Tests for prompt-snippet discovery."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.services.snippets import discover_snippets


@pytest.fixture
def roots(tmp_path: Path, monkeypatch):
    cwd = tmp_path / "project"
    cwd.mkdir()
    project = cwd / ".openagentd" / "snippets"
    project_agents = cwd / ".agents" / "snippets"
    global_config = tmp_path / "config"
    global_root = global_config / "snippets"
    global_agents = tmp_path / "home" / ".agents" / "snippets"

    from app.core import config as config_module
    from app.services import snippets as snippets_module

    monkeypatch.setattr(
        config_module.settings, "OPENAGENTD_CONFIG_DIR", str(global_config)
    )
    monkeypatch.setattr(
        snippets_module.Path,
        "home",
        classmethod(lambda cls: tmp_path / "home"),
    )
    return cwd, project, project_agents, global_root, global_agents


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


VALID = """\
---
description: Review staged changes.
---
Review the current diff.
"""


def test_discover_snippets_requires_workspace_and_finds_project_and_global(roots):
    cwd, project, project_agents, global_root, global_agents = roots
    _write(project / "review.md", VALID)
    _write(project_agents / "test.md", VALID)
    _write(global_root / "explain.md", "Explain this code.\n")
    _write(global_agents / "refactor.md", "Refactor this code.\n")

    result = discover_snippets(cwd)

    assert set(result.keys()) == {"review", "test", "explain", "refactor"}
    assert result["review"].source == "project-openagentd"
    assert result["review"].description == "Review staged changes."
    assert result["test"].source == "project-agents"
    assert result["explain"].source == "global-openagentd"
    assert result["explain"].body == "Explain this code."
    assert result["refactor"].source == "global-agents"
    assert result["refactor"].body == "Refactor this code."


def test_project_snippet_wins_over_global(roots):
    cwd, project, project_agents, global_root, global_agents = roots
    _write(project / "review.md", "project body\n")
    _write(project_agents / "review.md", "project agents body\n")
    _write(global_root / "review.md", "global body\n")
    _write(global_agents / "review.md", "global agents body\n")

    result = discover_snippets(cwd)

    assert result["review"].source == "project-openagentd"
    assert result["review"].body == "project body"


def test_project_agents_snippet_wins_over_global(roots):
    cwd, _project, project_agents, global_root, global_agents = roots
    _write(project_agents / "review.md", "project agents body\n")
    _write(global_root / "review.md", "global body\n")
    _write(global_agents / "review.md", "global agents body\n")

    result = discover_snippets(cwd)

    assert result["review"].source == "project-agents"
    assert result["review"].body == "project agents body"


def test_global_openagentd_wins_over_global_agents(roots):
    cwd, _project, _project_agents, global_root, global_agents = roots
    _write(global_root / "review.md", "global body\n")
    _write(global_agents / "review.md", "global agents body\n")

    result = discover_snippets(cwd)

    assert result["review"].source == "global-openagentd"
    assert result["review"].body == "global body"


def test_nested_snippet_names_use_slash(roots):
    cwd, project, *_ = roots
    _write(project / "git" / "commit.md", VALID)

    result = discover_snippets(cwd)

    assert set(result.keys()) == {"git/commit"}


def test_chat_workspace_sees_global_snippets_only(roots, monkeypatch):
    """A chat workspace is not a project: its snippet roots are global-only."""
    _cwd, project, project_agents, global_root, global_agents = roots
    from app.core import config as config_module

    chat_root = global_agents.parents[1] / "chat"
    chat_root.mkdir(parents=True)
    monkeypatch.setattr(config_module.settings, "CHAT_WORKSPACE_DIR", str(chat_root))

    _write(project / "review.md", "project body\n")
    _write(project_agents / "agents.md", "project agents body\n")
    _write(global_root / "review.md", "global body\n")
    _write(global_agents / "agents.md", "global agents body\n")
    # A file that would look project-local if the chat root counted as one.
    _write(chat_root / ".openagentd" / "snippets" / "chat.md", "chat project body\n")

    result = discover_snippets(chat_root)

    assert set(result.keys()) == {"review", "agents"}
    assert result["review"].source == "global-openagentd"
    assert result["agents"].source == "global-agents"
