"""Tests for the slash-command discovery + render service."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from app.services.commands import (
    discover_commands,
    get_builtin_command,
    render_command,
)


# ── Fixture ─────────────────────────────────────────────────────────────────


@pytest.fixture
def roots(tmp_path: Path, monkeypatch):
    """Redirect every command-discovery root into an isolated tmp tree.

    Returns ``(cwd, proj_oad, proj_oc, global_oad, global_oc)`` so tests
    can populate exactly the roots they care about.
    """
    cwd = tmp_path / "project"
    cwd.mkdir()
    proj_oad = cwd / ".openagentd" / "commands"
    proj_oc = cwd / ".opencode" / "commands"
    global_config = tmp_path / "config"
    global_oad = global_config / "commands"
    global_oc = tmp_path / "home" / ".config" / "opencode" / "commands"

    from app.core import config as config_module
    from app.services import commands as commands_module

    monkeypatch.setattr(
        config_module.settings, "OPENAGENTD_CONFIG_DIR", str(global_config)
    )
    # Pin Path.home() inside the service so the opencode-global root lands
    # under tmp_path instead of the real user home. Patching the module's
    # ``Path`` would be too coarse; the service only calls ``Path.home``.
    monkeypatch.setattr(
        commands_module.Path,
        "home",
        classmethod(lambda cls: tmp_path / "home"),
    )
    return cwd, proj_oad, proj_oc, global_oad, global_oc


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


VALID = """\
---
description: Make a commit.
---
Commit body.
"""

NO_FRONTMATTER = "Just a body, no metadata.\n"

WITH_ARGS = """\
---
description: Use args.
---
Hello $ARGUMENTS, welcome.
"""


# ── discover_commands ───────────────────────────────────────────────────────


def test_discover_returns_empty_when_no_roots(roots):
    cwd, *_ = roots
    assert discover_commands(workspace=cwd) == {}


def test_discover_finds_command_in_each_root(roots):
    cwd, proj_oad, proj_oc, global_oad, global_oc = roots
    _write(proj_oad / "a.md", VALID)
    _write(proj_oc / "b.md", VALID)
    _write(global_oad / "c.md", VALID)
    _write(global_oc / "d.md", VALID)

    result = discover_commands(workspace=cwd)

    assert set(result.keys()) == {"a", "b", "c", "d"}
    assert result["a"].source == "project-openagentd"
    assert result["b"].source == "project-opencode"
    assert result["c"].source == "global-openagentd"
    assert result["d"].source == "global-opencode"


def test_precedence_project_openagentd_wins_over_global(roots):
    cwd, proj_oad, proj_oc, global_oad, global_oc = roots
    _write(
        proj_oad / "commit.md",
        "---\ndescription: project-oad\n---\nproject-oad body\n",
    )
    _write(
        proj_oc / "commit.md",
        "---\ndescription: project-oc\n---\nproject-oc body\n",
    )
    _write(
        global_oad / "commit.md",
        "---\ndescription: global-oad\n---\nglobal-oad body\n",
    )
    _write(
        global_oc / "commit.md",
        "---\ndescription: global-oc\n---\nglobal-oc body\n",
    )

    result = discover_commands(workspace=cwd)

    assert result["commit"].source == "project-openagentd"
    assert result["commit"].description == "project-oad"
    assert "project-oad body" in result["commit"].body


def test_nested_folders_become_slashed_names(roots):
    cwd, proj_oad, *_ = roots
    _write(proj_oad / "git" / "commit.md", VALID)
    _write(proj_oad / "git" / "push.md", VALID)
    _write(proj_oad / "review.md", VALID)

    result = discover_commands(workspace=cwd)

    assert set(result.keys()) == {"git/commit", "git/push", "review"}


def test_missing_frontmatter_yields_empty_description_and_full_body(roots):
    cwd, proj_oad, *_ = roots
    _write(proj_oad / "raw.md", NO_FRONTMATTER)

    result = discover_commands(workspace=cwd)

    assert result["raw"].description == ""
    assert result["raw"].body == "Just a body, no metadata."


def test_non_dict_frontmatter_is_ignored_gracefully(roots):
    cwd, proj_oad, *_ = roots
    _write(proj_oad / "weird.md", "---\n- just a list\n---\nbody\n")

    result = discover_commands(workspace=cwd)

    assert result["weird"].description == ""
    assert result["weird"].body == "body"


def test_discover_reuses_unchanged_command_parse(roots, monkeypatch):
    """An unchanged discovered file is not read and parsed again."""
    cwd, proj_oad, *_ = roots
    command_path = proj_oad / "commit.md"
    _write(command_path, VALID)

    reads = 0
    parses = 0
    original_read_text = Path.read_text
    from app.services import commands as commands_module

    original_parse = commands_module._parse_frontmatter

    def count_read_text(path: Path, *args, **kwargs) -> str:
        nonlocal reads
        if path == command_path:
            reads += 1
        return original_read_text(path, *args, **kwargs)

    def count_parse(text: str) -> tuple[dict, str]:
        nonlocal parses
        parses += 1
        return original_parse(text)

    monkeypatch.setattr(Path, "read_text", count_read_text)
    monkeypatch.setattr(commands_module, "_parse_frontmatter", count_parse)

    first = discover_commands(workspace=cwd)
    second = discover_commands(workspace=cwd)

    assert first == second
    assert reads == 1
    assert parses == 1


def test_discover_does_not_cache_oversized_command(roots, monkeypatch):
    cwd, proj_oad, *_ = roots
    command_path = proj_oad / "large.md"
    _write(
        command_path,
        "---\ndescription: Large command.\n---\n" + ("x" * 200_000),
    )
    reads = 0
    original_read_text = Path.read_text

    def count_read_text(path: Path, *args, **kwargs) -> str:
        nonlocal reads
        if path == command_path:
            reads += 1
        return original_read_text(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", count_read_text)

    assert "large" in discover_commands(workspace=cwd)
    assert "large" in discover_commands(workspace=cwd)
    assert reads == 2


def test_discover_invalidates_same_size_edit_with_new_mtime(roots):
    cwd, proj_oad, *_ = roots
    command_path = proj_oad / "commit.md"
    original = "---\ndescription: first!\n---\nfirst!\n"
    updated = "---\ndescription: later!\n---\nlater!\n"
    assert len(original) == len(updated)
    _write(command_path, original)

    assert discover_commands(workspace=cwd)["commit"].description == "first!"
    command_path.write_text(updated, encoding="utf-8")
    stat = command_path.stat()
    os.utime(command_path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1))

    assert discover_commands(workspace=cwd)["commit"].description == "later!"


def test_discover_invalidates_atomic_replacement_with_matching_mtime(
    roots, monkeypatch
):
    cwd, proj_oad, *_ = roots
    command_path = proj_oad / "commit.md"
    _write(command_path, VALID)
    reads = 0
    original_read_text = Path.read_text

    def count_read_text(path: Path, *args, **kwargs) -> str:
        nonlocal reads
        if path == command_path:
            reads += 1
        return original_read_text(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", count_read_text)

    discover_commands(workspace=cwd)
    original_stat = command_path.stat()
    replacement = command_path.with_suffix(".replacement")
    _write(replacement, VALID)
    os.utime(
        replacement,
        ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns),
    )
    replacement.replace(command_path)
    discover_commands(workspace=cwd)

    assert reads == 2


def test_discover_reflects_create_delete_rename_and_precedence(roots):
    cwd, proj_oad, _, global_oad, _ = roots
    global_command = global_oad / "commit.md"
    project_command = proj_oad / "commit.md"
    _write(global_command, "---\ndescription: global\n---\nglobal\n")

    assert discover_commands(workspace=cwd)["commit"].source == "global-openagentd"
    _write(project_command, "---\ndescription: project\n---\nproject\n")
    assert discover_commands(workspace=cwd)["commit"].source == "project-openagentd"
    project_command.rename(proj_oad / "renamed.md")
    discovered = discover_commands(workspace=cwd)
    assert discovered["commit"].source == "global-openagentd"
    assert discovered["renamed"].source == "project-openagentd"
    global_command.unlink()
    assert set(discover_commands(workspace=cwd)) == {"renamed"}


def test_discover_does_not_cache_transient_parse_failures(roots, monkeypatch):
    cwd, proj_oad, *_ = roots
    _write(proj_oad / "commit.md", VALID)
    from app.services import commands as commands_module

    original_parse = commands_module._parse_frontmatter
    failed = False

    def fail_once(text: str) -> tuple[dict, str]:
        nonlocal failed
        if not failed:
            failed = True
            raise ValueError("temporary parser failure")
        return original_parse(text)

    monkeypatch.setattr(commands_module, "_parse_frontmatter", fail_once)
    with pytest.raises(ValueError, match="temporary parser failure"):
        discover_commands(workspace=cwd)

    assert discover_commands(workspace=cwd)["commit"].description == "Make a commit."


def test_discover_does_not_cache_transient_read_failures(roots, monkeypatch):
    cwd, proj_oad, *_ = roots
    command_path = proj_oad / "commit.md"
    _write(command_path, VALID)
    original_read_text = Path.read_text
    failed = False

    def fail_once(path: Path, *args, **kwargs) -> str:
        nonlocal failed
        if path == command_path and not failed:
            failed = True
            raise OSError("temporary read failure")
        return original_read_text(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", fail_once)

    assert discover_commands(workspace=cwd) == {}
    assert discover_commands(workspace=cwd)["commit"].description == "Make a commit."


# ── render_command ──────────────────────────────────────────────────────────


def test_render_substitutes_arguments_placeholder(roots):
    cwd, proj_oad, *_ = roots
    _write(proj_oad / "greet.md", WITH_ARGS)

    cmd = discover_commands(workspace=cwd)["greet"]

    assert render_command(cmd, "world") == "Hello world, welcome."


def test_render_appends_arguments_when_no_placeholder(roots):
    cwd, proj_oad, *_ = roots
    _write(proj_oad / "commit.md", VALID)

    cmd = discover_commands(workspace=cwd)["commit"]

    rendered = render_command(cmd, "fix bug")
    assert rendered.startswith("Commit body.")
    assert rendered.endswith("fix bug")


def test_render_with_no_arguments_leaves_body_unchanged(roots):
    cwd, proj_oad, *_ = roots
    _write(proj_oad / "commit.md", VALID)

    cmd = discover_commands(workspace=cwd)["commit"]

    assert render_command(cmd, "") == "Commit body."


def test_render_substitutes_all_occurrences(roots):
    cwd, proj_oad, *_ = roots
    _write(
        proj_oad / "echo.md",
        "---\ndescription: x\n---\n$ARGUMENTS / $ARGUMENTS\n",
    )

    cmd = discover_commands(workspace=cwd)["echo"]

    assert render_command(cmd, "hi") == "hi / hi"


# ── One-level nesting enforcement ────────────────────────────────────────────


def test_commands_two_levels_deep_are_silently_ignored(roots):
    """Files more than one level deep must never appear in the listing."""
    cwd, proj_oad, *_ = roots
    _write(proj_oad / "a" / "b" / "deep.md", "---\ndescription: too deep\n---\nbody\n")
    _write(proj_oad / "commit.md", VALID)

    result = discover_commands(workspace=cwd)

    assert "a/b/deep" not in result
    assert "commit" in result


def test_commands_one_level_deep_is_discovered(roots):
    """Exactly one level of nesting is supported."""
    cwd, proj_oad, *_ = roots
    _write(proj_oad / "git" / "commit.md", VALID)

    result = discover_commands(workspace=cwd)

    assert "git/commit" in result


def test_commands_only_one_level_when_both_present(roots):
    """A mix of flat, 1-level-nested, and deeply-nested files in the same root:
    only the first two kinds must appear."""
    cwd, proj_oad, *_ = roots
    _write(proj_oad / "flat.md", VALID)
    _write(proj_oad / "git" / "commit.md", VALID)
    _write(proj_oad / "git" / "branch" / "new.md", VALID)  # too deep

    result = discover_commands(workspace=cwd)

    assert set(result.keys()) == {"flat", "git/commit"}


def test_commands_three_levels_deep_ignored(roots):
    """Three levels of nesting must be ignored, not raise."""
    cwd, proj_oad, *_ = roots
    _write(proj_oad / "a" / "b" / "c" / "cmd.md", "---\ndescription: x\n---\nbody\n")

    result = discover_commands(workspace=cwd)

    assert result == {}


# ── Builtin commands ────────────────────────────────────────────────────────


def test_get_builtin_command_init():
    cmd = get_builtin_command("init")
    assert cmd is not None
    assert cmd.name == "init"
    assert cmd.source == "builtin"
    assert cmd.description == "Create or update AGENTS.md for this project."
    assert "# AGENTS.md Repository Analyzer & Generator" in cmd.body
    assert "operational map for coding agents" in cmd.body
    assert "1. Core Principles" in cmd.body
    assert "1.1 Evidence Over Assumptions" in cmd.body
    assert "1.2 Prefer Executable Truth" in cmd.body
    assert "1.3 Root = Defaults, Child = Delta" in cmd.body
    assert "1.4 Keep Context Small" in cmd.body
    assert "1.5 Document Meaning, Not Trivia" in cmd.body
    assert "2. Phase One — Discover Existing Instructions" in cmd.body
    assert "3. Phase Two — Inspect Repository Tooling" in cmd.body
    assert "4. Phase Three — Build an Internal Repository Model" in cmd.body
    assert "5. Phase Four — Determine Instruction Scopes" in cmd.body
    assert "14. Verify Commands" in cmd.body
    assert "22. AGENTS.md Quality Gate" in cmd.body
    assert "23. Fresh-Agent Usability Test" in cmd.body
    assert "30. Final Response" in cmd.body
    assert "## AGENTS.md Changes" in cmd.body
    assert "## Repository Conventions Discovered" in cmd.body
    assert "## Verification" in cmd.body
    assert "## Conflicts or Drift" in cmd.body
    assert "## Mechanical Enforcement Candidates" in cmd.body
    assert "31. Execution Requirement" in cmd.body


def test_get_builtin_command_unknown():
    assert get_builtin_command("unknown") is None
