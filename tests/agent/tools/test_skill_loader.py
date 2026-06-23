"""Tests for app/tools/builtin/skill.py."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from app.agent.sandbox import SandboxConfig, _sandbox_ctx, set_sandbox
from app.agent.tools.builtin.skill import (
    _builtin_skills_dir,
    _discover_skills_cached,
    _iter_skill_paths,
    _parse_frontmatter,
    _skill_tool_description,
    _skills_dir_signature,
    discover_skills,
    load_skill,
)


# ---------------------------------------------------------------------------
# _parse_frontmatter
# ---------------------------------------------------------------------------


class TestParseFrontmatter:
    def test_with_frontmatter(self):
        text = "---\nname: test\ndescription: A test skill\n---\nBody content here."
        meta, body = _parse_frontmatter(text)
        assert meta["name"] == "test"
        assert meta["description"] == "A test skill"
        assert body == "Body content here."

    def test_no_frontmatter(self):
        text = "Just plain markdown body."
        meta, body = _parse_frontmatter(text)
        assert meta == {}
        assert body == "Just plain markdown body."

    def test_empty_frontmatter(self):
        text = "---\n\n---\nBody after empty frontmatter."
        meta, body = _parse_frontmatter(text)
        assert meta == {}
        assert body == "Body after empty frontmatter."


# ---------------------------------------------------------------------------
# discover_skills
# ---------------------------------------------------------------------------


class TestDiscoverSkills:
    def test_discover_skills_from_dir(self, tmp_path):
        skill_dir = tmp_path / "example-skill"
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text(
            "---\nname: example-skill\ndescription: Example skill\n---\nInstructions."
        )
        result = discover_skills(skills_dir=tmp_path)
        assert "example-skill" in result
        assert result["example-skill"]["description"] == "Example skill"
        assert result["example-skill"]["file"] == "example-skill/SKILL.md"

    def test_discover_skills_empty_dir(self, tmp_path):
        result = discover_skills(skills_dir=tmp_path)
        assert result == {}

    def test_discover_skills_missing_dir(self, tmp_path):
        result = discover_skills(skills_dir=tmp_path / "nonexistent")
        assert result == {}

    def test_discover_skills_name_from_stem(self, tmp_path):
        """If frontmatter has no name, fall back to the subdirectory name."""
        skill_dir = tmp_path / "my-skill"
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text("---\ndescription: desc\n---\nBody.")
        result = discover_skills(skills_dir=tmp_path)
        assert "my-skill" in result

    def test_discover_multiple_skills(self, tmp_path):
        for name, body in [("alpha", "A instructions."), ("beta", "B instructions.")]:
            d = tmp_path / name
            d.mkdir()
            (d / "SKILL.md").write_text(f"---\nname: {name}\n---\n{body}")
        result = discover_skills(skills_dir=tmp_path)
        assert len(result) == 2
        assert "alpha" in result
        assert "beta" in result

    def test_subdir_without_skill_md_is_ignored(self, tmp_path):
        """A subdirectory that has no SKILL.md must not appear in results."""
        orphan = tmp_path / "orphan"
        orphan.mkdir()
        (orphan / "notes.md").write_text("not a skill")
        result = discover_skills(skills_dir=tmp_path)
        assert result == {}


# ---------------------------------------------------------------------------
# load_skill
# ---------------------------------------------------------------------------


class TestLoadSkill:
    @pytest.mark.asyncio
    async def test_load_skill_by_name(self, tmp_path, monkeypatch):
        d = tmp_path / "analysis"
        d.mkdir()
        (d / "SKILL.md").write_text("---\nname: analysis\n---\nAnalyse data carefully.")
        monkeypatch.setattr("app.agent.tools.builtin.skill._SKILLS_DIR", tmp_path)
        result = await load_skill("analysis")
        assert result == "Analyse data carefully."

    @pytest.mark.asyncio
    async def test_load_skill_reuses_visible_session_skill(self, tmp_path, monkeypatch):
        d = tmp_path / "analysis"
        d.mkdir()
        (d / "SKILL.md").write_text("---\nname: analysis\n---\nAnalyse data carefully.")
        monkeypatch.setattr("app.agent.tools.builtin.skill._SKILLS_DIR", tmp_path)
        state = SimpleNamespace(metadata={}, messages_for_llm=[])

        first = await load_skill("analysis", _state=state)
        second = await load_skill("analysis", _state=state)

        assert first == "Analyse data carefully."
        assert "already loaded" in second
        assert "Analyse data carefully" not in second

    @pytest.mark.asyncio
    async def test_load_skill_by_subdir_name(self, tmp_path, monkeypatch):
        """Match by subdirectory name when frontmatter name differs."""
        d = tmp_path / "my-skill"
        d.mkdir()
        (d / "SKILL.md").write_text("---\nname: different-name\n---\nBody content.")
        monkeypatch.setattr("app.agent.tools.builtin.skill._SKILLS_DIR", tmp_path)
        result = await load_skill("my-skill")
        assert result == "Body content."

    @pytest.mark.asyncio
    async def test_load_skill_not_found(self, tmp_path, monkeypatch):
        d = tmp_path / "existing"
        d.mkdir()
        (d / "SKILL.md").write_text("---\nname: existing\n---\nBody.")
        monkeypatch.setattr("app.agent.tools.builtin.skill._SKILLS_DIR", tmp_path)
        result = await load_skill("nonexistent")
        assert "not found" in result
        assert "existing" in result

    @pytest.mark.asyncio
    async def test_load_skill_dir_missing(self, tmp_path, monkeypatch):
        # Multi-root discovery means the "no roots" message is only
        # produced when *every* root is absent. Force all four to point
        # under tmp_path so the developer's real opencode-global library
        # doesn't leak in.
        gone = tmp_path / "gone"
        monkeypatch.setattr(
            "app.agent.tools.builtin.skill._iter_skill_roots", lambda: [gone]
        )
        result = await load_skill("anything")
        assert "Skills directory not found" in result

    def test_tool_description_tells_agent_not_to_reload_visible_skills(self):
        description = _skill_tool_description()
        assert "Call this at most once per skill." in description
        assert (
            "reuse those instructions instead of calling this tool again" in description
        )
        assert "repeated loads return the same content" in description


# ---------------------------------------------------------------------------
# Path-token substitution
#
# The skill tool replaces a small whitelist of ``{TOKEN}`` placeholders in
# both the discovered description (which gets injected into the agent's
# system prompt) and the body returned by ``load_skill``. This is what
# lets a skill say ``cat {OPENAGENTD_CONFIG_DIR}/mcp.json`` and have the
# agent receive a concrete absolute path it can hand to its file/shell
# tools without further interpretation.
#
# We invalidate the lru-cached discovery between tests because the cache
# key is the directory path, and ``_render_tokens`` reads ``settings``
# fresh on each call — but the cache hit would short-circuit that.
# ---------------------------------------------------------------------------


class TestTokenSubstitution:
    @pytest.fixture(autouse=True)
    def _clear_skill_cache(self):
        from app.agent.tools.builtin.skill import _discover_skills_cached

        _discover_skills_cached.cache_clear()
        yield
        _discover_skills_cached.cache_clear()

    def test_description_tokens_replaced_in_discovery(self, tmp_path, monkeypatch):
        monkeypatch.setattr("app.core.config.settings.OPENAGENTD_CONFIG_DIR", "/x/cfg")
        d = tmp_path / "demo"
        d.mkdir()
        (d / "SKILL.md").write_text(
            "---\nname: demo\ndescription: edits {OPENAGENTD_CONFIG_DIR}/mcp.json\n---\nBody."
        )

        result = discover_skills(skills_dir=tmp_path)

        # The literal placeholder must NOT survive into what the LLM sees.
        assert result["demo"]["description"] == "edits /x/cfg/mcp.json"
        # The new ``dir`` field exposes the skill's absolute directory
        # so callers don't need a second filesystem walk.
        assert result["demo"]["dir"] == str(d)

    def test_unknown_braces_in_description_preserved(self, tmp_path):
        """Anything not in the recognised whitelist (e.g. format-string
        placeholders in a description) must round-trip unchanged."""
        d = tmp_path / "demo"
        d.mkdir()
        # Quoted YAML scalar so the colon inside braces doesn't trip
        # the parser. ``{NOT_A_TOKEN}`` is what we actually want to test.
        (d / "SKILL.md").write_text(
            '---\nname: demo\ndescription: "see {NOT_A_TOKEN} for details"\n---\nBody.'
        )

        result = discover_skills(skills_dir=tmp_path)
        assert result["demo"]["description"] == "see {NOT_A_TOKEN} for details"

    @pytest.mark.asyncio
    async def test_body_tokens_replaced_on_load(self, tmp_path, monkeypatch):
        monkeypatch.setattr("app.core.config.settings.OPENAGENTD_CONFIG_DIR", "/x/cfg")
        monkeypatch.setattr("app.core.config.settings.AGENTS_DIR", "/x/cfg/agents")
        monkeypatch.setattr("app.core.config.settings.SKILLS_DIR", "/x/cfg/skills")
        d = tmp_path / "mcp-installer"
        d.mkdir()
        (d / "SKILL.md").write_text(
            "---\nname: mcp-installer\n---\n"
            "Edit {OPENAGENTD_CONFIG_DIR}/mcp.json. "
            "Agents live under {AGENTS_DIR}. "
            "Other skills under {SKILLS_DIR}. "
            "Run {SKILL_DIR}/scripts/mcp.py."
        )
        monkeypatch.setattr("app.agent.tools.builtin.skill._SKILLS_DIR", tmp_path)

        body = await load_skill("mcp-installer")

        assert "{OPENAGENTD_CONFIG_DIR}" not in body
        assert "{AGENTS_DIR}" not in body
        assert "{SKILLS_DIR}" not in body
        assert "{SKILL_DIR}" not in body
        assert "/x/cfg/mcp.json" in body
        assert "/x/cfg/agents" in body
        assert "/x/cfg/skills" in body
        # SKILL_DIR resolves to this skill's absolute directory.
        assert str(d.resolve()) in body

    @pytest.mark.asyncio
    async def test_body_unknown_braces_preserved(self, tmp_path, monkeypatch):
        """JSON examples and other ``{...}`` content inside the body must
        survive substitution untouched — only the four whitelisted token
        names are replaced."""
        d = tmp_path / "demo"
        d.mkdir()
        body_text = (
            'Use this payload: {"servers": {"name": "x"}}\n'
            "And refer to {NOT_A_TOKEN} for context."
        )
        (d / "SKILL.md").write_text(f"---\nname: demo\n---\n{body_text}")
        monkeypatch.setattr("app.agent.tools.builtin.skill._SKILLS_DIR", tmp_path)

        body = await load_skill("demo")
        assert body == body_text


# ---------------------------------------------------------------------------
# Multi-root discovery (project/global × openagentd/opencode)
#
# Skills are discovered from four roots in this precedence order:
#   1. {cwd}/.openagentd/skills/
#   2. {cwd}/.opencode/skills/
#   3. _SKILLS_DIR  (openagentd global, typically {CONFIG_DIR}/skills)
#   4. ~/.config/opencode/skills/
#
# We isolate every root under tmp_path by patching ``_iter_skill_roots``
# so the developer's real ``~/.config/opencode/skills/`` doesn't leak in.
# ---------------------------------------------------------------------------


class TestMultiRootDiscovery:
    @pytest.fixture(autouse=True)
    def _clear_cache(self):
        from app.agent.tools.builtin.skill import _discover_skills_cached

        _discover_skills_cached.cache_clear()
        yield
        _discover_skills_cached.cache_clear()

    @pytest.fixture
    def sandbox_workspace(self, tmp_path):
        workspace = tmp_path / "workspace"
        token = set_sandbox(SandboxConfig(workspace=str(workspace), session_id="s1"))
        try:
            yield workspace
        finally:
            _sandbox_ctx.reset(token)

    @pytest.fixture
    def roots(self, tmp_path, monkeypatch):
        """Patch ``_iter_skill_roots`` to a fresh four-root layout under tmp_path."""
        project_oad = tmp_path / "proj" / ".openagentd" / "skills"
        project_oc = tmp_path / "proj" / ".opencode" / "skills"
        global_oad = tmp_path / "config" / "skills"
        global_oc = tmp_path / "home" / ".config" / "opencode" / "skills"
        ordered = [project_oad, project_oc, global_oad, global_oc]
        monkeypatch.setattr(
            "app.agent.tools.builtin.skill._iter_skill_roots", lambda: ordered
        )
        return ordered

    def _write_skill(self, root, name, description, body):
        d = root / name
        d.mkdir(parents=True, exist_ok=True)
        (d / "SKILL.md").write_text(
            f"---\nname: {name}\ndescription: {description}\n---\n{body}"
        )

    def test_opencode_global_skill_discovered(self, roots):
        _project_oad, _project_oc, _global_oad, global_oc = roots
        self._write_skill(global_oc, "research", "From opencode", "Body.")

        result = discover_skills()

        assert "research" in result
        assert result["research"]["description"] == "From opencode"

    def test_precedence_openagentd_wins_over_opencode_on_collision(self, roots):
        project_oad, _project_oc, _global_oad, global_oc = roots
        self._write_skill(global_oc, "research", "opencode", "opencode body")
        self._write_skill(project_oad, "research", "openagentd", "openagentd body")

        result = discover_skills()

        assert result["research"]["description"] == "openagentd"
        assert result["research"]["file"] == "research/SKILL.md"
        # The winning ``dir`` must point at the openagentd-project copy.
        assert str(project_oad / "research") == result["research"]["dir"]

    def test_local_opencode_skill_wins_over_global_openagentd(self, roots):
        _project_oad, project_oc, global_oad, _global_oc = roots
        self._write_skill(global_oad, "research", "global openagentd", "global body")
        self._write_skill(project_oc, "research", "local opencode", "local body")

        result = discover_skills()

        assert result["research"]["description"] == "local opencode"
        assert str(project_oc / "research") == result["research"]["dir"]

    def test_skills_from_all_roots_merged(self, roots):
        project_oad, project_oc, global_oad, global_oc = roots
        self._write_skill(project_oad, "alpha", "a", "ab")
        self._write_skill(project_oc, "beta", "b", "bb")
        self._write_skill(global_oad, "gamma", "g", "gb")
        self._write_skill(global_oc, "delta", "d", "db")

        result = discover_skills()

        assert set(result.keys()) == {"alpha", "beta", "gamma", "delta"}

    def test_project_skills_use_active_sandbox_workspace(self, sandbox_workspace):
        project_oad = sandbox_workspace / ".openagentd" / "skills"
        self._write_skill(project_oad, "oad/commit", "Commit workflow", "Body.")

        result = discover_skills()

        assert "oad/commit" in result
        assert result["oad/commit"]["description"] == "Commit workflow"
        assert str(project_oad / "oad" / "commit") == result["oad/commit"]["dir"]

    def test_sandbox_project_skill_shadows_process_cwd_skill(
        self, tmp_path, monkeypatch, sandbox_workspace
    ):
        process_cwd = tmp_path / "process-cwd"
        self._write_skill(
            process_cwd / ".openagentd" / "skills",
            "oad/commit",
            "Wrong cwd skill",
            "Wrong body.",
        )
        self._write_skill(
            sandbox_workspace / ".openagentd" / "skills",
            "oad/commit",
            "Workspace skill",
            "Workspace body.",
        )
        monkeypatch.chdir(process_cwd)

        result = discover_skills()

        assert result["oad/commit"]["description"] == "Workspace skill"
        assert result["oad/commit"]["dir"] == str(
            sandbox_workspace / ".openagentd" / "skills" / "oad" / "commit"
        )

    def test_sandbox_project_skills_precede_global_openagentd(
        self, tmp_path, monkeypatch, sandbox_workspace
    ):
        global_oad = tmp_path / "config" / "skills"
        monkeypatch.setattr("app.agent.tools.builtin.skill._SKILLS_DIR", global_oad)
        monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path / "home"))
        self._write_skill(global_oad, "oad/commit", "Global skill", "Global body.")
        self._write_skill(
            sandbox_workspace / ".openagentd" / "skills",
            "oad/commit",
            "Workspace skill",
            "Workspace body.",
        )

        result = discover_skills()

        assert result["oad/commit"]["description"] == "Workspace skill"

    @pytest.mark.asyncio
    async def test_load_skill_reads_sandbox_project_body(self, sandbox_workspace):
        self._write_skill(
            sandbox_workspace / ".openagentd" / "skills",
            "oad/commit",
            "Commit workflow",
            "Workspace commit body.",
        )

        body = await load_skill("oad/commit")

        assert body == "Workspace commit body."

    @pytest.mark.asyncio
    async def test_load_skill_finds_opencode_skill(self, roots):
        _project_oad, _project_oc, _global_oad, global_oc = roots
        self._write_skill(global_oc, "research", "x", "Opencode body.")

        body = await load_skill("research")

        assert body == "Opencode body."

    @pytest.mark.asyncio
    async def test_load_skill_precedence_openagentd_wins(self, roots):
        project_oad, _project_oc, _global_oad, global_oc = roots
        self._write_skill(global_oc, "research", "x", "Opencode body.")
        self._write_skill(project_oad, "research", "x", "Openagentd body.")

        body = await load_skill("research")

        assert body == "Openagentd body."

    def test_cache_invalidates_when_opencode_root_changes(self, roots):
        _project_oad, _project_oc, _global_oad, global_oc = roots
        self._write_skill(global_oc, "alpha", "a", "ab")
        first = discover_skills()
        assert set(first.keys()) == {"alpha"}

        # Adding a skill to the opencode-global root must invalidate the
        # cache. We use ``write_text`` after a fresh mkdir to guarantee a
        # different signature; the directory mtime alone might tie at the
        # nanosecond on some filesystems.
        self._write_skill(global_oc, "beta", "b", "bb")
        second = discover_skills()

        assert set(second.keys()) == {"alpha", "beta"}


class TestBuiltinSkills:
    @pytest.fixture(autouse=True)
    def _builtin_only(self, monkeypatch):
        _discover_skills_cached.cache_clear()
        monkeypatch.setattr(
            "app.agent.tools.builtin.skill._iter_skill_roots",
            lambda: [_builtin_skills_dir()],
        )
        yield
        _discover_skills_cached.cache_clear()

    def test_operational_builtin_skills_are_discovered(self):
        result = discover_skills()

        assert {
            "self-healing",
            "skill-installer",
            "mcp-installer",
            "plugin-installer",
        }.issubset(result)
        assert (_builtin_skills_dir() / "mcp-installer" / "mcp_apply.py").is_file()

    @pytest.mark.asyncio
    async def test_builtin_skill_dir_points_at_auxiliary_files(self):
        body = await load_skill("mcp-installer")

        assert str(_builtin_skills_dir() / "mcp-installer" / "mcp_apply.py") in body


# ---------------------------------------------------------------------------
# Sub-skill support (one nested level)
#
# Skills may live one level deeper than the flat layout:
#   skills/{parent}/{sub}/SKILL.md  →  name "parent/sub"
#
# The parent directory itself may or may not have its own SKILL.md — both
# configurations are valid and must coexist.
# ---------------------------------------------------------------------------


class TestSubSkills:
    """Tests for one-level nested skill support."""

    @pytest.fixture(autouse=True)
    def _clear_cache(self):
        _discover_skills_cached.cache_clear()
        yield
        _discover_skills_cached.cache_clear()

    # ── _iter_skill_paths ────────────────────────────────────────────────

    def test_iter_yields_nested_skill(self, tmp_path):
        parent = tmp_path / "git"
        sub = parent / "commit"
        sub.mkdir(parents=True)
        (sub / "SKILL.md").write_text("---\nname: git/commit\n---\nBody.")

        results = list(_iter_skill_paths(tmp_path))

        assert len(results) == 1
        path, stem = results[0]
        assert stem == "git/commit"
        assert path == sub / "SKILL.md"

    def test_iter_yields_flat_and_nested_together(self, tmp_path):
        # Flat skill
        flat = tmp_path / "search"
        flat.mkdir()
        (flat / "SKILL.md").write_text("---\nname: search\n---\nSearch.")
        # Nested skill under the same parent
        nested = tmp_path / "git" / "commit"
        nested.mkdir(parents=True)
        (nested / "SKILL.md").write_text("---\nname: git/commit\n---\nCommit.")

        stems = {stem for _, stem in _iter_skill_paths(tmp_path)}

        assert stems == {"search", "git/commit"}

    def test_iter_parent_with_own_skill_md_and_sub_skills(self, tmp_path):
        """Parent dir can have its own SKILL.md AND nested sub-skills."""
        parent = tmp_path / "git"
        parent.mkdir()
        (parent / "SKILL.md").write_text("---\nname: git\n---\nGit overview.")
        sub = parent / "commit"
        sub.mkdir()
        (sub / "SKILL.md").write_text("---\nname: git/commit\n---\nCommit detail.")

        stems = {stem for _, stem in _iter_skill_paths(tmp_path)}

        assert stems == {"git", "git/commit"}

    def test_iter_ignores_directory_without_skill_md(self, tmp_path):
        """A sub-directory with no SKILL.md (e.g. scripts/) is never yielded."""
        parent = tmp_path / "git"
        scripts = parent / "scripts"
        scripts.mkdir(parents=True)
        (scripts / "helper.py").write_text("# helper")

        results = list(_iter_skill_paths(tmp_path))

        assert results == []

    # ── discover_skills ──────────────────────────────────────────────────

    def test_discover_nested_skill(self, tmp_path):
        sub = tmp_path / "git" / "commit"
        sub.mkdir(parents=True)
        (sub / "SKILL.md").write_text(
            "---\nname: git/commit\ndescription: Make a git commit.\n---\nBody."
        )

        result = discover_skills(skills_dir=tmp_path)

        assert "git/commit" in result
        assert result["git/commit"]["description"] == "Make a git commit."
        assert result["git/commit"]["file"] == "git/commit/SKILL.md"

    def test_discover_flat_and_nested_coexist(self, tmp_path):
        (tmp_path / "search").mkdir()
        (tmp_path / "search" / "SKILL.md").write_text(
            "---\nname: search\ndescription: Search.\n---\nSearch body."
        )
        sub = tmp_path / "git" / "push"
        sub.mkdir(parents=True)
        (sub / "SKILL.md").write_text(
            "---\nname: git/push\ndescription: Push commits.\n---\nPush body."
        )

        result = discover_skills(skills_dir=tmp_path)

        assert set(result.keys()) == {"search", "git/push"}

    def test_discover_nested_name_from_stem_when_no_frontmatter_name(self, tmp_path):
        """Stem ``parent/sub`` is used when frontmatter has no ``name`` key."""
        sub = tmp_path / "git" / "rebase"
        sub.mkdir(parents=True)
        (sub / "SKILL.md").write_text("---\ndescription: Rebase.\n---\nBody.")

        result = discover_skills(skills_dir=tmp_path)

        assert "git/rebase" in result

    def test_discover_precedence_flat_over_nested_same_name(self, tmp_path):
        """If a flat skill and a nested SKILL.md accidentally resolve to the
        same name, the flat one (discovered first in sorted order) wins."""
        flat = tmp_path / "git"
        flat.mkdir()
        (flat / "SKILL.md").write_text(
            "---\nname: git\ndescription: flat\n---\nFlat body."
        )
        sub = flat / "sub"
        sub.mkdir()
        (sub / "SKILL.md").write_text(
            "---\nname: git/sub\ndescription: nested\n---\nNested body."
        )

        result = discover_skills(skills_dir=tmp_path)

        # Both should appear under their distinct names.
        assert "git" in result
        assert "git/sub" in result

    # ── _skills_dir_signature ────────────────────────────────────────────

    def test_signature_changes_when_nested_skill_added(self, tmp_path):
        sig_before = _skills_dir_signature(tmp_path)

        sub = tmp_path / "git" / "commit"
        sub.mkdir(parents=True)
        (sub / "SKILL.md").write_text("---\nname: git/commit\n---\nBody.")

        sig_after = _skills_dir_signature(tmp_path)

        assert sig_after != sig_before

    def test_signature_changes_when_nested_skill_edited(self, tmp_path):
        sub = tmp_path / "git" / "commit"
        sub.mkdir(parents=True)
        skill_file = sub / "SKILL.md"
        skill_file.write_text("---\nname: git/commit\n---\nOriginal.")

        sig_before = _skills_dir_signature(tmp_path)

        import time

        time.sleep(0.01)  # ensure mtime changes on fast filesystems
        skill_file.write_text("---\nname: git/commit\n---\nEdited.")

        sig_after = _skills_dir_signature(tmp_path)

        assert sig_after != sig_before

    # ── load_skill ───────────────────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_load_nested_skill_by_slash_name(self, tmp_path, monkeypatch):
        sub = tmp_path / "git" / "commit"
        sub.mkdir(parents=True)
        (sub / "SKILL.md").write_text("---\nname: git/commit\n---\nCommit body.")
        monkeypatch.setattr("app.agent.tools.builtin.skill._SKILLS_DIR", tmp_path)

        result = await load_skill("git/commit")

        assert result == "Commit body."

    @pytest.mark.asyncio
    async def test_load_nested_skill_by_stem(self, tmp_path, monkeypatch):
        """When frontmatter name differs, the slash-stem is still matchable."""
        sub = tmp_path / "git" / "commit"
        sub.mkdir(parents=True)
        (sub / "SKILL.md").write_text(
            "---\nname: git-commit\n---\nCommit body by stem."
        )
        monkeypatch.setattr("app.agent.tools.builtin.skill._SKILLS_DIR", tmp_path)

        result = await load_skill("git/commit")

        assert result == "Commit body by stem."

    @pytest.mark.asyncio
    async def test_flat_and_nested_skill_both_loadable(self, tmp_path, monkeypatch):
        (tmp_path / "search").mkdir()
        (tmp_path / "search" / "SKILL.md").write_text(
            "---\nname: search\n---\nSearch body."
        )
        sub = tmp_path / "git" / "push"
        sub.mkdir(parents=True)
        (sub / "SKILL.md").write_text("---\nname: git/push\n---\nPush body.")
        monkeypatch.setattr("app.agent.tools.builtin.skill._SKILLS_DIR", tmp_path)

        assert await load_skill("search") == "Search body."
        assert await load_skill("git/push") == "Push body."
