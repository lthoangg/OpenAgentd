"""Tests for app/agent/tools/builtin/filesystem/_config_watch.py.

The module provides ``notify_fs_change`` — called by write/edit/patch/rm after
every successful mutation. When the changed path falls under *any* skill root
(global or project-local), it eagerly clears the ``_discover_skills_cached``
LRU so the next ``discover_skills()`` call reflects the mutation immediately,
without relying on filesystem mtime granularity (which is 1 s on most
platforms).

Roots covered:
  - ``settings.SKILLS_DIR``                     — global OpenAgentd skills
  - ``{workspace}/.openagentd/skills/``          — project-local (OpenAgentd-native)
  - ``{workspace}/.opencode/skills/``            — project-local (opencode reuse)

Paths outside all three roots must not trigger a cache clear.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from app.agent.denied_paths import (
    DeniedPathsConfig as SandboxConfig,
    _denied_paths_ctx as _sandbox_ctx,
    set_denied_paths as set_sandbox,
)
from app.core.config import settings
from app.agent.tools.builtin.filesystem._config_watch import (
    _skills_roots,
    notify_fs_change,
)
from app.agent.tools.builtin.skill import _discover_skills_cached


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _clear_skill_cache():
    """Ensure a clean LRU state before and after every test."""
    _discover_skills_cached.cache_clear()
    yield
    _discover_skills_cached.cache_clear()


@pytest.fixture
def sandbox(tmp_path):
    """Set an active sandbox whose workspace sits under tmp_path."""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    token = set_sandbox(SandboxConfig(workspace=str(workspace), session_id="s1"))
    yield workspace
    _sandbox_ctx.reset(token)


def _prime_cache() -> int:
    """Call _discover_skills_cached once so cache info shows a hit bucket.

    Returns the cache-size before the call (always 0 after a clear) so callers
    can assert the cache was populated.
    """
    _discover_skills_cached(("__sentinel__",), 0)
    return _discover_skills_cached.cache_info().currsize


# ---------------------------------------------------------------------------
# _skills_roots
# ---------------------------------------------------------------------------


class TestSkillsRoots:
    def test_includes_global_skills_dir(self, tmp_path, monkeypatch):
        global_dir = tmp_path / "global" / "skills"
        monkeypatch.setattr("app.core.config.settings.SKILLS_DIR", str(global_dir))

        roots = _skills_roots()

        assert global_dir.resolve() in roots

    def test_includes_openagentd_project_root(self, sandbox):
        roots = _skills_roots()

        assert (sandbox / ".openagentd" / "skills").resolve() in roots

    def test_includes_opencode_project_root(self, sandbox):
        roots = _skills_roots()

        assert (sandbox / ".opencode" / "skills").resolve() in roots

    def test_all_three_roots_present(self, sandbox, tmp_path, monkeypatch):
        global_dir = tmp_path / "global" / "skills"
        monkeypatch.setattr("app.core.config.settings.SKILLS_DIR", str(global_dir))

        roots = _skills_roots()

        assert len(roots) == 3
        assert global_dir.resolve() in roots
        assert (sandbox / ".openagentd" / "skills").resolve() in roots
        assert (sandbox / ".opencode" / "skills").resolve() in roots

    def test_returns_resolved_absolute_paths(self, sandbox):
        roots = _skills_roots()

        for root in roots:
            assert root.is_absolute(), f"expected absolute path, got {root}"

    def test_no_sandbox_still_returns_global(self, tmp_path, monkeypatch):
        """When no sandbox is active, global root is still returned."""
        global_dir = tmp_path / "global" / "skills"
        monkeypatch.setattr("app.core.config.settings.SKILLS_DIR", str(global_dir))
        # get_sandbox is imported lazily inside _skills_roots — patch at source
        monkeypatch.setattr(
            "app.agent.denied_paths.get_denied_paths",
            lambda: (_ for _ in ()).throw(LookupError("no sandbox")),
        )

        roots = _skills_roots()

        assert global_dir.resolve() in roots
        # Project roots must be absent — sandbox unavailable
        project_roots = [
            r for r in roots if ".openagentd" in str(r) or ".opencode" in str(r)
        ]
        assert project_roots == []


# ---------------------------------------------------------------------------
# notify_fs_change — cache clearing
# ---------------------------------------------------------------------------


class TestNotifyFsChange:
    # ── global SKILLS_DIR ─────────────────────────────────────────────────

    def test_clears_cache_for_global_skills_dir(self, tmp_path, monkeypatch):
        global_skills = tmp_path / "config" / "skills"
        global_skills.mkdir(parents=True)
        monkeypatch.setattr("app.core.config.settings.SKILLS_DIR", str(global_skills))
        _prime_cache()
        assert _discover_skills_cached.cache_info().currsize > 0

        skill_file = global_skills / "my-skill" / "SKILL.md"
        notify_fs_change(skill_file.resolve())

        assert _discover_skills_cached.cache_info().currsize == 0

    def test_clears_cache_for_nested_file_under_global_skills_dir(
        self, tmp_path, monkeypatch
    ):
        global_skills = tmp_path / "config" / "skills"
        global_skills.mkdir(parents=True)
        monkeypatch.setattr("app.core.config.settings.SKILLS_DIR", str(global_skills))
        _prime_cache()

        # Path several levels deep — still under the root
        deep_path = global_skills / "oad" / "commit" / "SKILL.md"
        notify_fs_change(deep_path.resolve())

        assert _discover_skills_cached.cache_info().currsize == 0

    # ── project-local .openagentd/skills ─────────────────────────────────

    def test_clears_cache_for_openagentd_project_skill(self, sandbox):
        _prime_cache()
        assert _discover_skills_cached.cache_info().currsize > 0

        skill_file = sandbox / ".openagentd" / "skills" / "oad" / "commit" / "SKILL.md"
        notify_fs_change(skill_file.resolve())

        assert _discover_skills_cached.cache_info().currsize == 0

    def test_clears_cache_for_flat_openagentd_project_skill(self, sandbox):
        _prime_cache()

        skill_file = sandbox / ".openagentd" / "skills" / "my-skill" / "SKILL.md"
        notify_fs_change(skill_file.resolve())

        assert _discover_skills_cached.cache_info().currsize == 0

    # ── project-local .opencode/skills ───────────────────────────────────

    def test_clears_cache_for_opencode_project_skill(self, sandbox):
        _prime_cache()
        assert _discover_skills_cached.cache_info().currsize > 0

        skill_file = sandbox / ".opencode" / "skills" / "research" / "SKILL.md"
        notify_fs_change(skill_file.resolve())

        assert _discover_skills_cached.cache_info().currsize == 0

    def test_clears_cache_for_nested_opencode_project_skill(self, sandbox):
        _prime_cache()

        skill_file = sandbox / ".opencode" / "skills" / "oad" / "debug" / "SKILL.md"
        notify_fs_change(skill_file.resolve())

        assert _discover_skills_cached.cache_info().currsize == 0

    # ── paths outside all skill roots ────────────────────────────────────

    def test_does_not_clear_cache_for_unrelated_path(
        self, tmp_path, monkeypatch, sandbox
    ):
        global_skills = tmp_path / "config" / "skills"
        monkeypatch.setattr("app.core.config.settings.SKILLS_DIR", str(global_skills))
        _prime_cache()
        before = _discover_skills_cached.cache_info().currsize

        unrelated = sandbox / "src" / "app" / "main.py"
        notify_fs_change(unrelated.resolve())

        assert _discover_skills_cached.cache_info().currsize == before

    def test_does_not_clear_cache_for_workspace_root_itself(
        self, tmp_path, monkeypatch, sandbox
    ):
        global_skills = tmp_path / "config" / "skills"
        monkeypatch.setattr("app.core.config.settings.SKILLS_DIR", str(global_skills))
        _prime_cache()
        before = _discover_skills_cached.cache_info().currsize

        # The workspace root is NOT a skill root
        notify_fs_change(sandbox.resolve())

        assert _discover_skills_cached.cache_info().currsize == before

    def test_does_not_clear_cache_for_dot_openagentd_dir_itself(
        self, tmp_path, monkeypatch, sandbox
    ):
        """Only paths *under* .openagentd/skills/ trigger the clear — not
        sibling dirs like .openagentd/commands/."""
        global_skills = tmp_path / "config" / "skills"
        monkeypatch.setattr("app.core.config.settings.SKILLS_DIR", str(global_skills))
        _prime_cache()
        before = _discover_skills_cached.cache_info().currsize

        commands_file = sandbox / ".openagentd" / "commands" / "oad" / "debug.md"
        notify_fs_change(commands_file.resolve())

        assert _discover_skills_cached.cache_info().currsize == before

    # ── robustness ────────────────────────────────────────────────────────

    def test_safe_when_settings_unavailable(self, monkeypatch):
        """When settings can't be loaded, _skills_roots() returns [] and
        notify_fs_change exits early without raising."""
        _prime_cache()
        before = _discover_skills_cached.cache_info().currsize

        # _skills_roots catches the settings ImportError internally and
        # returns an empty list — simulate that outcome directly.
        monkeypatch.setattr(
            "app.agent.tools.builtin.filesystem._config_watch._skills_roots",
            lambda: [],
        )

        # Must not raise
        notify_fs_change(Path("/any/path/SKILL.md"))

        # Cache untouched — no roots matched
        assert _discover_skills_cached.cache_info().currsize == before

    def test_safe_when_skill_cache_clear_fails(self, sandbox):
        """If clearing _discover_skills_cached raises, the function logs a
        warning but does not propagate — the write tool still succeeds."""
        skill_file = sandbox / ".openagentd" / "skills" / "x" / "SKILL.md"

        # _discover_skills_cached is imported lazily inside notify_fs_change
        # from app.agent.tools.builtin.skill — patch it there.
        with patch(
            "app.agent.tools.builtin.skill._discover_skills_cached.cache_clear",
            side_effect=Exception("cache broken"),
        ):
            # Must not raise even when the cache clear itself blows up
            notify_fs_change(skill_file.resolve())

    def test_no_roots_returns_early_without_error(self, monkeypatch):
        """When _skills_roots() returns an empty list, function exits cleanly."""
        monkeypatch.setattr(
            "app.agent.tools.builtin.filesystem._config_watch._skills_roots",
            lambda: [],
        )
        # Must not raise
        notify_fs_change(Path("/any/path/SKILL.md"))


# ---------------------------------------------------------------------------
# End-to-end: write a project skill → discover immediately sees it
# ---------------------------------------------------------------------------


class TestEndToEnd:
    """Verify that a project-local skill written during a session is visible
    in the next discover_skills() call in the same turn (sub-second window)."""

    def test_new_project_skill_visible_after_notify(
        self, sandbox, tmp_path, monkeypatch
    ):
        """Write a SKILL.md under .openagentd/skills/, call notify_fs_change,
        then discover_skills() — the skill must appear without a process restart."""
        global_skills = tmp_path / "global" / "skills"
        monkeypatch.setattr("app.core.config.settings.SKILLS_DIR", str(global_skills))

        from app.agent.tools.builtin.skill import discover_skills

        # Patch _iter_skill_roots so only the sandbox project root + global dir
        # are scanned (avoids leaking the developer's real skill library).
        project_oad = sandbox / ".openagentd" / "skills"
        monkeypatch.setattr(
            "app.agent.tools.builtin.skill._iter_skill_roots",
            lambda: [project_oad, global_skills],
        )

        # First discovery — no skills yet
        first = discover_skills()
        assert "oad/commit" not in first

        # Write the skill (simulating what write_file / skill-installer does)
        skill_dir = project_oad / "oad" / "commit"
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text(
            "---\nname: oad/commit\ndescription: Commit workflow.\n---\nBody."
        )

        # Simulate notify_fs_change being called by the write tool
        notify_fs_change((skill_dir / "SKILL.md").resolve())

        # Second discovery — must reflect the new file
        second = discover_skills()
        assert "oad/commit" in second
        assert second["oad/commit"]["description"] == "Commit workflow."

    def test_deleted_project_skill_gone_after_notify(
        self, sandbox, tmp_path, monkeypatch
    ):
        """Delete a SKILL.md, call notify_fs_change, then discover_skills()
        — the skill must no longer appear."""
        global_skills = tmp_path / "global" / "skills"
        monkeypatch.setattr("app.core.config.settings.SKILLS_DIR", str(global_skills))

        from app.agent.tools.builtin.skill import discover_skills

        project_oad = sandbox / ".openagentd" / "skills"
        skill_dir = project_oad / "my-skill"
        skill_dir.mkdir(parents=True)
        skill_file = skill_dir / "SKILL.md"
        skill_file.write_text("---\nname: my-skill\ndescription: A skill.\n---\nBody.")

        monkeypatch.setattr(
            "app.agent.tools.builtin.skill._iter_skill_roots",
            lambda: [project_oad, global_skills],
        )

        # Populate cache
        first = discover_skills()
        assert "my-skill" in first

        # Delete the skill file
        skill_file.unlink()
        notify_fs_change(skill_file.resolve())

        # Cache cleared — rescan must not include the deleted skill
        second = discover_skills()
        assert "my-skill" not in second

    def test_opencode_project_skill_visible_after_notify(
        self, sandbox, tmp_path, monkeypatch
    ):
        """Same end-to-end flow for the .opencode/skills/ project root."""
        global_skills = tmp_path / "global" / "skills"
        monkeypatch.setattr("app.core.config.settings.SKILLS_DIR", str(global_skills))

        from app.agent.tools.builtin.skill import discover_skills

        project_oc = sandbox / ".opencode" / "skills"
        monkeypatch.setattr(
            "app.agent.tools.builtin.skill._iter_skill_roots",
            lambda: [project_oc, global_skills],
        )

        first = discover_skills()
        assert "research" not in first

        skill_dir = project_oc / "research"
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text(
            "---\nname: research\ndescription: Research workflow.\n---\nBody."
        )
        notify_fs_change((skill_dir / "SKILL.md").resolve())

        second = discover_skills()
        assert "research" in second
        assert second["research"]["description"] == "Research workflow."


# ---------------------------------------------------------------------------
# _skills_roots — degraded resolution must not be silent
#
# Both root-resolution blocks are guarded by ``except Exception`` so that an
# optional cache-invalidation path can never fail a write/edit/rm tool call.
# The breadth is deliberate (settings construction and path resolution can
# fail in several unrelated ways), but swallowing without a trace meant a
# genuinely broken skills root silently stopped being watched — the cache then
# only self-heals on mtime granularity, which is the exact failure this module
# exists to avoid.
# ---------------------------------------------------------------------------


class TestSkillsRootsDegradedResolution:
    @pytest.fixture
    def caplog_loguru(self, caplog):
        from loguru import logger

        handler_id = logger.add(caplog.handler, format="{message}", level="DEBUG")
        yield caplog
        logger.remove(handler_id)

    def test_global_root_failure_is_logged_and_degrades_gracefully(
        self, sandbox, monkeypatch, caplog_loguru
    ):
        """A broken SKILLS_DIR still yields the project roots, and is logged."""
        broken = property(lambda self: (_ for _ in ()).throw(OSError("bad mount")))
        monkeypatch.setattr(type(settings), "SKILLS_DIR", broken, raising=False)

        roots = _skills_roots()

        # Project-local roots still resolved — graceful degradation preserved.
        assert (sandbox / ".openagentd" / "skills").resolve() in roots
        assert any(
            "config_watch_global_skills_root_failed" in m
            for m in caplog_loguru.messages
        ), f"global-root failure was swallowed silently: {caplog_loguru.messages}"

    def test_project_root_failure_is_logged_and_degrades_gracefully(
        self, tmp_path, monkeypatch, caplog_loguru
    ):
        """A failing sandbox lookup still yields the global root, and is logged."""
        global_dir = tmp_path / "global" / "skills"
        monkeypatch.setattr("app.core.config.settings.SKILLS_DIR", str(global_dir))
        monkeypatch.setattr(
            "app.agent.denied_paths.get_denied_paths",
            lambda: (_ for _ in ()).throw(RuntimeError("sandbox exploded")),
        )

        roots = _skills_roots()

        assert global_dir.resolve() in roots
        assert any(
            "config_watch_project_skills_roots_failed" in m
            for m in caplog_loguru.messages
        ), f"project-root failure was swallowed silently: {caplog_loguru.messages}"
