"""Tests for team_manage tool — runtime member capability management.

Covers:
- Lead-only injection (members do not get the tool)
- list / add / remove flow against on-disk .md frontmatter
- Idempotency (add already-present, remove not-present)
- Validation (unknown skill / tool / mcp / member)
- Protected tool names (skill, team_message, lead-only tools) cannot be granted
- Lead is not a manageable target
- The lead cannot manage agents that have no source .md (in-memory)
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from unittest.mock import patch

import yaml

from app.agent.agent_loop import Agent
from app.agent.loader import parse_agent_md
from app.agent.mode.team.manage import make_team_manage_tool
from app.agent.mode.team.member import TeamLead, TeamMember
from app.agent.mode.team.team import AgentTeam


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_member_md(
    path: Path,
    *,
    name: str,
    skills: list[str] | None = None,
    tools: list[str] | None = None,
    mcp: list[str] | None = None,
) -> Path:
    """Write a minimal valid member .md file at *path* and return the path."""
    meta: dict = {"name": name, "role": "member"}
    if skills is not None:
        meta["skills"] = skills
    if tools is not None:
        meta["tools"] = tools
    if mcp is not None:
        meta["mcp"] = mcp
    yaml_block = yaml.safe_dump(meta, sort_keys=False).strip()
    body = f"---\n{yaml_block}\n---\nYou are {name}.\n"
    path.write_text(body, encoding="utf-8")
    return path


def _make_team_with_file_backed_member(
    tmp_path: Path,
    *,
    member_name: str = "executor",
    skills: list[str] | None = None,
    tools: list[str] | None = None,
    mcp: list[str] | None = None,
) -> tuple[AgentTeam, Path]:
    """Construct a 1-lead-1-member team where the member's agent has a real source_path."""
    from tests.agent.mode.team.conftest import MockTeamProvider

    member_md = _write_member_md(
        tmp_path / f"{member_name}.md",
        name=member_name,
        skills=skills,
        tools=tools,
        mcp=mcp,
    )

    lead_agent = Agent(name="lead", llm_provider=MockTeamProvider("ok"))
    lead = TeamLead(lead_agent)

    member_agent = Agent(name=member_name, llm_provider=MockTeamProvider("ok"))
    member_agent.source_path = member_md
    member_agent.skills = list(skills or [])
    member_agent.mcp_servers = list(mcp or [])
    member = TeamMember(member_agent)

    team = AgentTeam(lead=lead, members={member_name: member})
    return team, member_md


# ---------------------------------------------------------------------------
# Injection
# ---------------------------------------------------------------------------


class TestTeamManageInjection:
    """Lead-only injection."""

    async def test_lead_gets_team_manage(self, basic_team):
        injected = basic_team.get_injected_tools(basic_team.lead.name)
        names = {t.name for t in injected}
        assert "team_manage" in names
        assert "team_message" in names

    async def test_member_does_not_get_team_manage(self, basic_team):
        injected = basic_team.get_injected_tools("member_a")
        names = {t.name for t in injected}
        assert "team_manage" not in names
        assert "team_message" in names


# ---------------------------------------------------------------------------
# list action
# ---------------------------------------------------------------------------


class TestTeamManageList:
    async def test_list_reads_from_disk(self, tmp_path):
        team, _ = _make_team_with_file_backed_member(
            tmp_path,
            skills=["web-research"],
            tools=["read"],
            mcp=["context7"],
        )
        tool = make_team_manage_tool(team)

        result = await tool(member="executor", action="list")

        assert "web-research" in result
        assert "read" in result
        assert "context7" in result
        assert "executor.md" in result

    async def test_list_unknown_member(self, tmp_path):
        team, _ = _make_team_with_file_backed_member(tmp_path)
        tool = make_team_manage_tool(team)

        result = await tool(member="ghost", action="list")

        assert "not found" in result
        assert "executor" in result  # available members listed


# ---------------------------------------------------------------------------
# add action
# ---------------------------------------------------------------------------


class TestTeamManageAdd:
    async def test_add_skill_writes_frontmatter(self, tmp_path):
        team, md = _make_team_with_file_backed_member(tmp_path, skills=[])
        tool = make_team_manage_tool(team)

        with patch(
            "app.agent.tools.builtin.skill.discover_skills",
            return_value={"web-research": {}},
        ):
            result = await tool(
                member="executor",
                action="add",
                kind="skill",
                name="web-research",
            )

        assert "Added" in result
        cfg = parse_agent_md(md)
        assert "web-research" in cfg.skills

    async def test_add_mcp_writes_frontmatter(self, tmp_path):
        team, md = _make_team_with_file_backed_member(tmp_path, mcp=[])
        tool = make_team_manage_tool(team)

        with patch("app.agent.mcp.mcp_manager.server_names", return_value=["shadcn"]):
            result = await tool(
                member="executor",
                action="add",
                kind="mcp",
                name="shadcn",
            )

        assert "Added" in result
        cfg = parse_agent_md(md)
        assert "shadcn" in cfg.mcp

    async def test_add_tool_writes_frontmatter(self, tmp_path):
        team, md = _make_team_with_file_backed_member(tmp_path, tools=[])
        tool = make_team_manage_tool(team)

        result = await tool(
            member="executor",
            action="add",
            kind="tool",
            name="web_search",
        )

        assert "Added" in result
        cfg = parse_agent_md(md)
        assert "web_search" in cfg.tools

    async def test_add_already_present_is_idempotent(self, tmp_path):
        team, md = _make_team_with_file_backed_member(tmp_path, mcp=["shadcn"])
        tool = make_team_manage_tool(team)

        with patch("app.agent.mcp.mcp_manager.server_names", return_value=["shadcn"]):
            result = await tool(
                member="executor",
                action="add",
                kind="mcp",
                name="shadcn",
            )

        assert "already" in result.lower()
        # File still parses, list unchanged
        cfg = parse_agent_md(md)
        assert cfg.mcp == ["shadcn"]


# ---------------------------------------------------------------------------
# remove action
# ---------------------------------------------------------------------------


class TestTeamManageRemove:
    async def test_remove_mcp_writes_frontmatter(self, tmp_path):
        team, md = _make_team_with_file_backed_member(
            tmp_path, mcp=["shadcn", "context7"]
        )
        tool = make_team_manage_tool(team)

        with patch(
            "app.agent.mcp.mcp_manager.server_names",
            return_value=["shadcn", "context7"],
        ):
            result = await tool(
                member="executor",
                action="remove",
                kind="mcp",
                name="shadcn",
            )

        assert "Removed" in result
        cfg = parse_agent_md(md)
        assert "shadcn" not in cfg.mcp
        assert "context7" in cfg.mcp

    async def test_remove_not_present_is_idempotent(self, tmp_path):
        team, md = _make_team_with_file_backed_member(tmp_path, skills=[])
        tool = make_team_manage_tool(team)

        with patch(
            "app.agent.tools.builtin.skill.discover_skills",
            return_value={"web-research": {}},
        ):
            result = await tool(
                member="executor",
                action="remove",
                kind="skill",
                name="web-research",
            )

        assert "not in" in result
        cfg = parse_agent_md(md)
        assert cfg.skills == []


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


class TestTeamManageValidation:
    async def test_unknown_skill_rejected(self, tmp_path):
        team, _ = _make_team_with_file_backed_member(tmp_path)
        tool = make_team_manage_tool(team)

        with patch(
            "app.agent.tools.builtin.skill.discover_skills",
            return_value={"web-research": {}},
        ):
            result = await tool(
                member="executor",
                action="add",
                kind="skill",
                name="nope",
            )

        assert "Unknown skill" in result

    async def test_unknown_tool_rejected(self, tmp_path):
        team, _ = _make_team_with_file_backed_member(tmp_path)
        tool = make_team_manage_tool(team)

        result = await tool(
            member="executor",
            action="add",
            kind="tool",
            name="not_a_real_tool",
        )

        assert "Unknown tool" in result

    async def test_unknown_mcp_rejected(self, tmp_path):
        team, _ = _make_team_with_file_backed_member(tmp_path)
        tool = make_team_manage_tool(team)

        with patch("app.agent.mcp.mcp_manager.server_names", return_value=["shadcn"]):
            result = await tool(
                member="executor",
                action="add",
                kind="mcp",
                name="missing",
            )

        assert "Unknown MCP server" in result

    async def test_protected_tool_rejected(self, tmp_path):
        """Always-on / lead-only tools cannot be granted."""
        team, _ = _make_team_with_file_backed_member(tmp_path)
        tool = make_team_manage_tool(team)

        result = await tool(
            member="executor",
            action="add",
            kind="tool",
            name="todo_manage",
        )

        assert "protected" in result.lower()

    async def test_lead_is_not_a_target(self, tmp_path):
        """The lead cannot be managed via team_manage."""
        team, _ = _make_team_with_file_backed_member(tmp_path)
        tool = make_team_manage_tool(team)

        result = await tool(
            member="lead",
            action="list",
        )

        assert "not found" in result

    async def test_in_memory_member_rejected(self, basic_team):
        """A member whose agent has no source_path cannot be managed."""
        # basic_team's members are in-memory (no source_path set).
        tool = make_team_manage_tool(basic_team)

        result = await tool(member="member_a", action="list")

        assert "no source" in result.lower()

    async def test_add_without_kind_or_name(self, tmp_path):
        team, _ = _make_team_with_file_backed_member(tmp_path)
        tool = make_team_manage_tool(team)

        result = await tool(member="executor", action="add")

        assert "kind" in result and "name" in result


# ---------------------------------------------------------------------------
# Frontmatter edge cases
# ---------------------------------------------------------------------------


class TestTeamManageFrontmatterEdgeCases:
    """Cover .md shapes the happy-path tests don't exercise."""

    async def test_add_creates_missing_key(self, tmp_path):
        """Frontmatter has skills/tools but no mcp key — add must create it."""
        # _write_member_md only emits keys we pass; omit mcp entirely.
        team, md = _make_team_with_file_backed_member(
            tmp_path, skills=["web-research"], tools=["read"]
        )
        # Sanity: parsed config initially has empty mcp list.
        assert parse_agent_md(md).mcp == []

        tool = make_team_manage_tool(team)
        with patch("app.agent.mcp.mcp_manager.server_names", return_value=["shadcn"]):
            result = await tool(
                member="executor", action="add", kind="mcp", name="shadcn"
            )

        assert "Added" in result
        assert parse_agent_md(md).mcp == ["shadcn"]

    async def test_remove_from_missing_key_is_idempotent(self, tmp_path):
        """Frontmatter has no mcp key — remove reports 'not in' without writing."""
        team, md = _make_team_with_file_backed_member(tmp_path, skills=[])
        before = md.read_text()

        tool = make_team_manage_tool(team)
        with patch("app.agent.mcp.mcp_manager.server_names", return_value=["shadcn"]):
            result = await tool(
                member="executor", action="remove", kind="mcp", name="shadcn"
            )

        assert "not in" in result
        # No write should have happened.
        assert md.read_text() == before

    async def test_empty_list_in_frontmatter_round_trips(self, tmp_path):
        """`mcp: []` is the canonical empty form — add must turn it into a real list."""
        team, md = _make_team_with_file_backed_member(tmp_path, mcp=[])
        # Sanity: parsed config sees an empty list.
        assert parse_agent_md(md).mcp == []

        tool = make_team_manage_tool(team)
        with patch("app.agent.mcp.mcp_manager.server_names", return_value=["shadcn"]):
            result = await tool(
                member="executor", action="add", kind="mcp", name="shadcn"
            )

        assert "Added" in result
        assert parse_agent_md(md).mcp == ["shadcn"]

    async def test_yaml_null_list_returns_clean_error(self, tmp_path):
        """`mcp: ~` is rejected by AgentConfig; team_manage must fail safely.

        The schema treats `None` for a list field as invalid, not as an empty
        list. team_manage's `list` action re-parses via parse_agent_md and so
        surfaces the validation error as a user-visible failure string,
        without corrupting the .md.
        """
        member_md = tmp_path / "executor.md"
        original = "---\nname: executor\nrole: member\nmcp: ~\n---\nbody\n"
        member_md.write_text(original, encoding="utf-8")

        from tests.agent.mode.team.conftest import MockTeamProvider

        lead = TeamLead(Agent(name="lead", llm_provider=MockTeamProvider("ok")))
        member_agent = Agent(name="executor", llm_provider=MockTeamProvider("ok"))
        member_agent.source_path = member_md
        team = AgentTeam(lead=lead, members={"executor": TeamMember(member_agent)})

        tool = make_team_manage_tool(team)
        result = await tool(member="executor", action="list")

        # Surfaces as an error rather than crashing or silently corrupting.
        assert "Failed" in result or "error" in result.lower()
        assert member_md.read_text() == original

    async def test_body_with_horizontal_rules_is_preserved(self, tmp_path):
        """Body contains '---' separators — only the leading frontmatter is parsed."""
        member_md = tmp_path / "executor.md"
        body = (
            "You are executor.\n"
            "\n"
            "## Section A\n"
            "First.\n"
            "\n"
            "---\n"  # horizontal rule in markdown body
            "\n"
            "## Section B\n"
            "Second.\n"
        )
        member_md.write_text(
            f"---\nname: executor\nrole: member\nmcp: []\n---\n{body}",
            encoding="utf-8",
        )

        from tests.agent.mode.team.conftest import MockTeamProvider

        lead = TeamLead(Agent(name="lead", llm_provider=MockTeamProvider("ok")))
        member_agent = Agent(name="executor", llm_provider=MockTeamProvider("ok"))
        member_agent.source_path = member_md
        team = AgentTeam(lead=lead, members={"executor": TeamMember(member_agent)})

        tool = make_team_manage_tool(team)
        with patch("app.agent.mcp.mcp_manager.server_names", return_value=["shadcn"]):
            await tool(member="executor", action="add", kind="mcp", name="shadcn")

        new_text = member_md.read_text()
        # Body, including the horizontal rule, must survive verbatim.
        assert body in new_text
        # And the horizontal-rule line was not consumed by frontmatter.
        cfg = parse_agent_md(member_md)
        assert cfg.mcp == ["shadcn"]
        assert "Section A" not in str(cfg.skills)  # body did not leak into config

    async def test_missing_frontmatter_returns_clean_error(self, tmp_path):
        """File has no frontmatter at all — error string, file untouched."""
        member_md = tmp_path / "executor.md"
        original = "Just markdown, no frontmatter at all.\n"
        member_md.write_text(original, encoding="utf-8")

        from tests.agent.mode.team.conftest import MockTeamProvider

        lead = TeamLead(Agent(name="lead", llm_provider=MockTeamProvider("ok")))
        member_agent = Agent(name="executor", llm_provider=MockTeamProvider("ok"))
        member_agent.source_path = member_md
        team = AgentTeam(lead=lead, members={"executor": TeamMember(member_agent)})

        tool = make_team_manage_tool(team)
        with patch("app.agent.mcp.mcp_manager.server_names", return_value=["shadcn"]):
            result = await tool(
                member="executor", action="add", kind="mcp", name="shadcn"
            )

        # User-visible error, no exception leaked.
        assert "Failed" in result and "frontmatter" in result.lower()
        # File MUST be byte-identical to its original state.
        assert member_md.read_text() == original

    async def test_sequential_adds_accumulate(self, tmp_path):
        """Two adds in a row both end up in the file."""
        team, md = _make_team_with_file_backed_member(tmp_path, skills=[])
        tool = make_team_manage_tool(team)

        with patch(
            "app.agent.tools.builtin.skill.discover_skills",
            return_value={"web-research": {}, "self-healing": {}},
        ):
            r1 = await tool(
                member="executor", action="add", kind="skill", name="web-research"
            )
            r2 = await tool(
                member="executor", action="add", kind="skill", name="self-healing"
            )

        assert "Added" in r1 and "Added" in r2
        assert parse_agent_md(md).skills == ["web-research", "self-healing"]

    async def test_round_trip_preserves_logical_config(self, tmp_path):
        """add(X) then remove(X) yields a config field equal to the original."""
        team, md = _make_team_with_file_backed_member(
            tmp_path, skills=["web-research"], tools=["read"], mcp=[]
        )
        before = parse_agent_md(md)

        tool = make_team_manage_tool(team)
        with patch("app.agent.mcp.mcp_manager.server_names", return_value=["shadcn"]):
            await tool(member="executor", action="add", kind="mcp", name="shadcn")
            await tool(member="executor", action="remove", kind="mcp", name="shadcn")

        after = parse_agent_md(md)
        # YAML formatting may differ, but the parsed config must match.
        assert after.skills == before.skills
        assert after.tools == before.tools
        assert after.mcp == before.mcp
        assert after.system_prompt == before.system_prompt

    async def test_list_reflects_pending_changes_before_reload(self, tmp_path):
        """list() reads disk, so it shows changes the member hasn't reloaded yet."""
        team, _md = _make_team_with_file_backed_member(tmp_path, mcp=[])
        tool = make_team_manage_tool(team)

        # Member's in-memory agent.mcp_servers is still []. After add, list()
        # must show shadcn even though no member turn has run.
        with patch("app.agent.mcp.mcp_manager.server_names", return_value=["shadcn"]):
            await tool(member="executor", action="add", kind="mcp", name="shadcn")
            result = await tool(member="executor", action="list")

        assert "shadcn" in result
        # And the in-memory agent state was NOT mutated by team_manage.
        assert team.members["executor"].agent.mcp_servers == []


# ---------------------------------------------------------------------------
# Integration: team_manage write → drift detection → in-place rebuild
# ---------------------------------------------------------------------------


class TestTeamManageDriftIntegration:
    """Close the loop: file rewrite must trigger refresh_if_dirty rebuild."""

    @staticmethod
    def _build_real_member(
        tmp_path: Path,
        monkeypatch,
        *,
        mcp: list[str] | None = None,
    ):
        """Build a TeamMember backed by a real Agent with a real config_stamp.

        The agent's ``.md`` carries a fake ``provider:model`` and we monkeypatch
        ``build_provider`` so ``rebuild_agent_from_disk`` (called by
        ``refresh_if_dirty``) can construct an agent without hitting any real
        provider. ``mcp_manager`` is patched at the module level for the same
        reason — no live MCP runners during tests.
        """
        from app.agent.loader import _build_agent, parse_agent_md
        from tests.agent.mode.team.conftest import MockTeamProvider

        # Stub the global provider factory so loader.rebuild_agent_from_disk
        # gets a MockTeamProvider for our test model string.
        def fake_build_provider(model_id, **_kw):
            return MockTeamProvider("ok")

        # ``loader.rebuild_agent_from_disk`` looks up ``build_provider`` via
        # its module-level import, so we patch the name *in loader's module*,
        # not at the factory's source.
        monkeypatch.setattr("app.agent.loader.build_provider", fake_build_provider)
        monkeypatch.setattr(
            "app.agent.providers.factory.build_provider", fake_build_provider
        )
        # Stub mcp_manager so any mcp: server name resolves to an empty tool
        # list (server known, but no tools yet).
        monkeypatch.setattr(
            "app.agent.mcp.mcp_manager.server_names",
            lambda: ["shadcn", "context7"],
        )
        monkeypatch.setattr(
            "app.agent.mcp.mcp_manager.get_tools_for_server", lambda _name: []
        )

        member_md = tmp_path / "executor.md"
        meta: dict = {
            "name": "executor",
            "role": "member",
            "model": "mock:tester",
            "tools": [],
        }
        if mcp is not None:
            meta["mcp"] = mcp
        member_md.write_text(
            f"---\n{yaml.safe_dump(meta, sort_keys=False).strip()}\n---\nbody\n",
            encoding="utf-8",
        )

        cfg = parse_agent_md(member_md)
        agent = _build_agent(
            cfg,
            tool_registry={},
            provider_factory=fake_build_provider,
            source_path=member_md,
        )

        lead = TeamLead(Agent(name="lead", llm_provider=MockTeamProvider("ok")))
        member = TeamMember(agent)
        team = AgentTeam(lead=lead, members={"executor": member})
        return team, member, member_md

    async def test_add_tool_rebuilds_member_agent(self, tmp_path, monkeypatch):
        """team_manage add(tool) → refresh_if_dirty() → tool present on agent."""
        team, member, md = self._build_real_member(tmp_path, monkeypatch)
        assert "web_search" not in member.agent._tools

        tool = make_team_manage_tool(team)
        result = await tool(
            member="executor", action="add", kind="tool", name="web_search"
        )
        assert "Added" in result

        # Bump file mtime so drift is detected even when the OS rounds mtimes.
        future = time.time() + 1.0
        os.utime(md, (future, future))

        assert member.refresh_if_dirty() is True
        assert "web_search" in member.agent._tools

    async def test_remove_tool_rebuilds_member_agent(self, tmp_path, monkeypatch):
        """add then remove → after refresh, tool is gone."""
        team, member, md = self._build_real_member(tmp_path, monkeypatch)
        tool = make_team_manage_tool(team)

        await tool(member="executor", action="add", kind="tool", name="web_search")
        future = time.time() + 1.0
        os.utime(md, (future, future))
        member.refresh_if_dirty()
        assert "web_search" in member.agent._tools

        await tool(member="executor", action="remove", kind="tool", name="web_search")
        future += 1.0
        os.utime(md, (future, future))
        member.refresh_if_dirty()
        assert "web_search" not in member.agent._tools

    async def test_idempotent_add_does_not_dirty_file(self, tmp_path, monkeypatch):
        """add on an already-present capability skips the write — no drift."""
        team, member, md = self._build_real_member(tmp_path, monkeypatch, mcp=[])
        tool = make_team_manage_tool(team)

        await tool(member="executor", action="add", kind="mcp", name="shadcn")

        # Bump mtime so the first rebuild sees drift, then refresh once.
        future = time.time() + 1.0
        os.utime(md, (future, future))
        assert member.refresh_if_dirty() is True

        # Second add for the SAME server is a no-op — file unchanged, next
        # refresh returns False.
        mtime_before = md.stat().st_mtime_ns
        result = await tool(member="executor", action="add", kind="mcp", name="shadcn")

        assert "already" in result.lower()
        assert md.stat().st_mtime_ns == mtime_before
        assert member.refresh_if_dirty() is False

    async def test_list_does_not_trigger_drift(self, tmp_path, monkeypatch):
        """list() is read-only — refresh_if_dirty stays False."""
        team, member, md = self._build_real_member(tmp_path, monkeypatch)
        tool = make_team_manage_tool(team)

        # Reset stamp to current disk state so any pre-test mtime is baseline.
        member._config_dirty = False
        member.agent.config_stamp = {
            **member.agent.config_stamp,
            str(md): md.stat().st_mtime_ns,
        }

        await tool(member="executor", action="list")

        assert member.refresh_if_dirty() is False


# ---------------------------------------------------------------------------
# Tool object metadata
# ---------------------------------------------------------------------------


class TestTeamManageToolMetadata:
    """The factory must return a properly-named, discoverable Tool."""

    def test_tool_has_expected_name(self, basic_team):
        tool = make_team_manage_tool(basic_team)
        assert tool.name == "team_manage"

    def test_tool_has_non_empty_description(self, basic_team):
        """Description is shown to the LLM — must clearly state the contract."""
        tool = make_team_manage_tool(basic_team)
        assert tool.description
        # The description should mention the three action verbs so the LLM
        # can pick the right one without reading the source.
        text = tool.description.lower()
        assert "list" in text
        assert "add" in text or "grant" in text
        assert "remove" in text or "revoke" in text

    def test_each_call_returns_a_fresh_tool(self, basic_team):
        """Factory is pure — successive calls return new objects.

        This matters because ``get_injected_tools`` is called per agent.run()
        and we don't want shared mutable state across calls.
        """
        a = make_team_manage_tool(basic_team)
        b = make_team_manage_tool(basic_team)
        assert a is not b
        assert a.name == b.name


# ---------------------------------------------------------------------------
# Validation precedence
# ---------------------------------------------------------------------------


class TestTeamManageValidationPrecedence:
    """Order of checks: member-exists > has-source > kind/name > capability-known.

    Each branch is tested in isolation by other classes; here we pin the
    *order* so that a malformed call that hits multiple problems surfaces
    the most useful (highest-precedence) error first.
    """

    async def test_unknown_member_beats_missing_kind_and_name(self, tmp_path):
        """Even with no kind/name, an unknown member is reported first."""
        team, _ = _make_team_with_file_backed_member(tmp_path)
        tool = make_team_manage_tool(team)

        result = await tool(member="ghost", action="add")

        assert "not found" in result
        # Must NOT mention the missing-args hint — that would mislead the
        # caller into thinking the member was valid.
        assert "kind" not in result.lower()

    async def test_unknown_member_beats_unknown_capability(self, tmp_path):
        team, _ = _make_team_with_file_backed_member(tmp_path)
        tool = make_team_manage_tool(team)

        result = await tool(member="ghost", action="add", kind="tool", name="not_real")

        assert "not found" in result
        assert "Unknown tool" not in result

    async def test_in_memory_member_beats_unknown_capability(self, basic_team):
        """No-source check fires before capability validation."""
        tool = make_team_manage_tool(basic_team)

        result = await tool(
            member="member_a", action="add", kind="tool", name="not_real"
        )

        assert "no source" in result.lower()
        assert "Unknown tool" not in result

    async def test_missing_kind_or_name_beats_capability_check(self, tmp_path):
        """For real member with source: missing kind/name fires before validation."""
        team, _ = _make_team_with_file_backed_member(tmp_path)
        tool = make_team_manage_tool(team)

        # name supplied but kind missing → must complain about kind+name,
        # not about whether 'foo' is a known anything.
        result = await tool(member="executor", action="add", name="foo")

        assert "kind" in result and "name" in result
        assert "Unknown" not in result


# ---------------------------------------------------------------------------
# Tool kind: MCP-prefixed names are not configurable as 'tool'
# ---------------------------------------------------------------------------


class TestTeamManageMcpPrefixFiltering:
    """``kind='tool'`` must not accept ``mcp_<server>_<tool>`` names.

    These tools are managed implicitly by ``kind='mcp'`` (granting a server
    grants all of its tools). Letting the lead pin a single mcp_* tool
    by name in ``tools:`` would create a stale reference the moment the
    server's tool list shifts.
    """

    async def test_mcp_prefixed_tool_rejected_with_helpful_message(self, tmp_path):
        team, _ = _make_team_with_file_backed_member(tmp_path)
        tool = make_team_manage_tool(team)

        # Even if the registry happens to contain the name, it must be
        # filtered out of the *configurable* set.
        from app.agent.tools.registry import Tool as ToolCls

        async def _stub() -> str:
            return "stub"

        fake_registry = {
            "web_search": ToolCls(_stub, name="web_search"),
            "mcp_shadcn_get_component": ToolCls(_stub, name="mcp_shadcn_get_component"),
        }
        with patch(
            "app.agent.loader._default_tool_registry", return_value=fake_registry
        ):
            result = await tool(
                member="executor",
                action="add",
                kind="tool",
                name="mcp_shadcn_get_component",
            )

        assert "Unknown tool" in result
        # The error mentions the offending name once (the user's input),
        # but the *available* list must NOT advertise the mcp_-prefixed
        # tool. Check that web_search appears but no mcp_* in the list.
        _, _, available_part = result.partition("Available tools:")
        assert "web_search" in available_part
        assert "mcp_shadcn_get_component" not in available_part
        assert "mcp_" not in available_part

    async def test_mcp_kind_still_works_for_server(self, tmp_path):
        """Sanity: the same capability is reachable via kind='mcp'."""
        team, md = _make_team_with_file_backed_member(tmp_path, mcp=[])
        tool = make_team_manage_tool(team)

        with patch("app.agent.mcp.mcp_manager.server_names", return_value=["shadcn"]):
            result = await tool(
                member="executor", action="add", kind="mcp", name="shadcn"
            )

        assert "Added" in result
        assert "shadcn" in parse_agent_md(md).mcp


# ---------------------------------------------------------------------------
# Filesystem failure paths
# ---------------------------------------------------------------------------


class TestTeamManageFilesystemFailures:
    """Disk errors must surface as user-visible strings, never exceptions.

    The LLM is the caller; an unhandled exception aborts the whole turn,
    so every IO path through ``team_manage`` is wrapped to return a
    diagnostic string instead.
    """

    async def test_write_failure_is_caught_and_reported(self, tmp_path):
        """Simulate Path.write_text raising — surface as 'Failed to update'."""
        team, _md = _make_team_with_file_backed_member(tmp_path, skills=[])
        tool = make_team_manage_tool(team)

        boom = PermissionError("read-only filesystem")
        with (
            patch(
                "app.agent.tools.builtin.skill.discover_skills",
                return_value={"web-research": {}},
            ),
            patch("app.agent.mode.team.manage.Path.write_text", side_effect=boom),
        ):
            result = await tool(
                member="executor",
                action="add",
                kind="skill",
                name="web-research",
            )

        assert "Failed to update" in result
        assert "executor" in result
        assert "read-only filesystem" in result

    async def test_source_file_deleted_between_setup_and_call(self, tmp_path):
        """Member's .md is gone at runtime — list/add both surface a clean error."""
        team, md = _make_team_with_file_backed_member(tmp_path, mcp=[])
        md.unlink()

        tool = make_team_manage_tool(team)

        list_result = await tool(member="executor", action="list")
        # list() catches all exceptions from parse_agent_md.
        assert "Failed to read" in list_result

        with patch("app.agent.mcp.mcp_manager.server_names", return_value=["shadcn"]):
            add_result = await tool(
                member="executor", action="add", kind="mcp", name="shadcn"
            )
        # add() surfaces the IO error via its own try/except.
        assert "Failed to update" in add_result

    async def test_corrupt_yaml_in_frontmatter_surfaces_on_add(self, tmp_path):
        """Malformed YAML inside frontmatter — add() reports 'Failed', no crash."""
        member_md = tmp_path / "executor.md"
        # ``key: : value`` is invalid YAML.
        member_md.write_text(
            "---\nname: executor\nrole: member\nbroken: : oops\n---\nbody\n",
            encoding="utf-8",
        )
        from tests.agent.mode.team.conftest import MockTeamProvider

        lead = TeamLead(Agent(name="lead", llm_provider=MockTeamProvider("ok")))
        member_agent = Agent(name="executor", llm_provider=MockTeamProvider("ok"))
        member_agent.source_path = member_md
        team = AgentTeam(lead=lead, members={"executor": TeamMember(member_agent)})

        tool = make_team_manage_tool(team)
        with patch("app.agent.mcp.mcp_manager.server_names", return_value=["shadcn"]):
            result = await tool(
                member="executor", action="add", kind="mcp", name="shadcn"
            )

        assert "Failed to update" in result


# ---------------------------------------------------------------------------
# list action: stricter contract
# ---------------------------------------------------------------------------


class TestTeamManageListContract:
    async def test_list_ignores_extra_kind_and_name(self, tmp_path):
        """Per the docstring, list ignores kind/name when supplied."""
        team, _ = _make_team_with_file_backed_member(
            tmp_path, skills=["web-research"], tools=[], mcp=[]
        )
        tool = make_team_manage_tool(team)

        # Pass garbage that would fail validation if list routed through it.
        result = await tool(
            member="executor",
            action="list",
            kind="tool",
            name="not_a_real_tool_at_all",
        )

        # Successful list output, NOT a validation error.
        assert "web-research" in result
        assert "Unknown" not in result

    async def test_list_output_is_sorted_for_stable_diffing(self, tmp_path):
        """Listed capabilities must be sorted — LLM-consumable, diff-friendly."""
        team, _ = _make_team_with_file_backed_member(
            tmp_path,
            skills=["zeta", "alpha", "mu"],
            tools=["read", "write"],
            mcp=["context7", "shadcn"],
        )
        tool = make_team_manage_tool(team)

        result = await tool(member="executor", action="list")

        # Sorted skills: alpha < mu < zeta
        a, m, z = result.find("alpha"), result.find("mu"), result.find("zeta")
        assert -1 < a < m < z


# ---------------------------------------------------------------------------
# Frontmatter mutation: more shapes
# ---------------------------------------------------------------------------


class TestTeamManageFrontmatterMoreShapes:
    async def test_remove_last_item_leaves_empty_list(self, tmp_path):
        """Removing the only entry must leave ``key: []`` (still parseable)."""
        team, md = _make_team_with_file_backed_member(tmp_path, mcp=["shadcn"])
        tool = make_team_manage_tool(team)

        with patch("app.agent.mcp.mcp_manager.server_names", return_value=["shadcn"]):
            result = await tool(
                member="executor", action="remove", kind="mcp", name="shadcn"
            )

        assert "Removed" in result
        cfg = parse_agent_md(md)
        assert cfg.mcp == []
        # And a subsequent add still works on the now-empty list.
        with patch("app.agent.mcp.mcp_manager.server_names", return_value=["shadcn"]):
            await tool(member="executor", action="add", kind="mcp", name="shadcn")
        assert parse_agent_md(md).mcp == ["shadcn"]

    async def test_unicode_body_preserved_byte_for_byte(self, tmp_path):
        """Non-ASCII body content must round-trip through write."""
        member_md = tmp_path / "executor.md"
        body = "你好, world! Café — naïve façade. 🚀\n\n## Steps\n1. é\n2. ñ\n"
        member_md.write_text(
            f"---\nname: executor\nrole: member\nmcp: []\n---\n{body}",
            encoding="utf-8",
        )
        from tests.agent.mode.team.conftest import MockTeamProvider

        lead = TeamLead(Agent(name="lead", llm_provider=MockTeamProvider("ok")))
        member_agent = Agent(name="executor", llm_provider=MockTeamProvider("ok"))
        member_agent.source_path = member_md
        team = AgentTeam(lead=lead, members={"executor": TeamMember(member_agent)})

        tool = make_team_manage_tool(team)
        with patch("app.agent.mcp.mcp_manager.server_names", return_value=["shadcn"]):
            await tool(member="executor", action="add", kind="mcp", name="shadcn")

        new_text = member_md.read_text(encoding="utf-8")
        # The body, including the unicode characters, is byte-identical.
        assert new_text.endswith(body)
        # And the frontmatter changed as expected.
        assert parse_agent_md(member_md).mcp == ["shadcn"]

    async def test_yaml_special_chars_in_values_round_trip(self, tmp_path):
        """Capability names that look YAML-special must round-trip safely.

        We don't currently allow `:` in skill ids, but the MUTATION layer
        shouldn't rely on that — quoting must be handled by yaml.safe_dump.
        Simulate by injecting a name with a colon via a stubbed registry.
        """
        team, md = _make_team_with_file_backed_member(tmp_path, skills=[])
        tool = make_team_manage_tool(team)

        weird_name = "skill:with:colons"
        with patch(
            "app.agent.tools.builtin.skill.discover_skills",
            return_value={weird_name: {}},
        ):
            result = await tool(
                member="executor", action="add", kind="skill", name=weird_name
            )

        assert "Added" in result
        # File still parses, name preserved exactly.
        cfg = parse_agent_md(md)
        assert weird_name in cfg.skills


# ---------------------------------------------------------------------------
# Integration: loader soft-skip after team_manage grants then registry shifts
# ---------------------------------------------------------------------------


class TestTeamManageLoaderSoftSkip:
    """End-to-end: lead grants X, environment loses X, member must still load.

    This is the core robustness contract that motivated the loader
    soft-skip change. team_manage validates names *up front* against the
    current registry, but between grant time and rebuild time the registry
    can shift (server crash, plugin uninstall). The agent must still build.
    """

    async def test_unknown_tool_after_grant_is_warned_and_skipped(
        self, tmp_path, monkeypatch, caplog
    ):
        """Lead adds 'web_search' → registry no longer has it → rebuild succeeds."""
        team, member, md = TestTeamManageDriftIntegration._build_real_member(
            tmp_path, monkeypatch
        )
        tool = make_team_manage_tool(team)

        # Grant succeeds against the live registry.
        result = await tool(
            member="executor", action="add", kind="tool", name="web_search"
        )
        assert "Added" in result

        # Now the registry forgets web_search before rebuild.
        from app.agent.tools.registry import Tool as ToolCls

        async def _stub() -> str:
            return "stub"

        empty_registry = {"skill": ToolCls(_stub, name="skill")}
        monkeypatch.setattr(
            "app.agent.loader._default_tool_registry", lambda: empty_registry
        )

        future = time.time() + 1.0
        os.utime(md, (future, future))

        # Rebuild must succeed; warning is emitted.
        with caplog.at_level("WARNING"):
            assert member.refresh_if_dirty() is True

        # Tool absent (gracefully skipped), agent still alive.
        assert "web_search" not in member.agent._tools
        assert member.agent is not None

    async def test_unknown_mcp_server_after_grant_is_warned_and_skipped(
        self, tmp_path, monkeypatch
    ):
        """Lead adds 'shadcn' MCP → server later disappears → rebuild succeeds."""
        team, member, md = TestTeamManageDriftIntegration._build_real_member(
            tmp_path, monkeypatch, mcp=[]
        )
        tool = make_team_manage_tool(team)

        await tool(member="executor", action="add", kind="mcp", name="shadcn")

        # Server name still validates at grant time (the helper stubs
        # server_names to include shadcn). Now drop it from the resolver.
        monkeypatch.setattr(
            "app.agent.mcp.mcp_manager.get_tools_for_server",
            lambda _name: None,  # mimic "server not ready / unknown"
        )

        future = time.time() + 1.0
        os.utime(md, (future, future))

        assert member.refresh_if_dirty() is True
        # mcp_servers list still records the grant (so the lead's view is
        # consistent), but no tools were attached.
        assert "shadcn" in member.agent.mcp_servers
        assert not any(
            t_name.startswith("mcp_shadcn_") for t_name in member.agent._tools
        )
