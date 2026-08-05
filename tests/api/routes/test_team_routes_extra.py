"""Extra tests for app/api/routes/team.py — covers sessions, delete, agents, history."""

from __future__ import annotations

import asyncio
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.agent.agent_loop import Agent
from app.agent.providers.base import LLMProviderBase
from app.agent.mode.team.member import TeamLead, TeamMember
from app.agent.mode.team.team import AgentTeam, MemberBlueprint
from app.models.chat import ChatSession


async def _save_chat_session(session: ChatSession) -> None:
    from app.core.db import async_session_factory

    async with async_session_factory() as db:
        db.add(session)
        await db.commit()


class MockProvider(LLMProviderBase):
    model = "mock"

    def stream(self, messages, tools=None, **kwargs):
        async def gen():
            from app.agent.schemas.chat import (
                ChatCompletionChunk,
                ChatCompletionChunkChoice,
                ChatCompletionDelta,
            )

            yield ChatCompletionChunk(
                id="1",
                created=1000,
                model="mock",
                choices=[
                    ChatCompletionChunkChoice(
                        index=0,
                        delta=ChatCompletionDelta(content="OK"),
                        finish_reason="stop",
                    )
                ],
            )

        return gen()

    async def chat(self, messages, tools=None, **kwargs):
        from app.agent.schemas.chat import AssistantMessage

        return AssistantMessage(content="OK")


@pytest.fixture
def test_team():
    lead = TeamLead(
        Agent(name="lead", llm_provider=MockProvider(), system_prompt="Lead")
    )
    worker = TeamMember(
        Agent(name="worker", llm_provider=MockProvider(), system_prompt="Worker")
    )
    return AgentTeam(lead=lead, members={"worker": worker})


@pytest.fixture
def app_with_team(test_team):
    from app.api.app import create_app
    from app.services.team_manager import set_team

    app = create_app()
    set_team(test_team)
    yield app
    set_team(None)


@pytest.fixture
def app_without_team():
    from app.api.app import create_app
    from app.services.team_manager import set_team

    app = create_app()
    set_team(None)
    return app


# ---------------------------------------------------------------------------
# GET /team/agents (lines 143-160)
# ---------------------------------------------------------------------------


class TestTeamAgentsRouteExtra:
    def test_agents_no_team_returns_404(self, app_without_team):
        client = TestClient(app_without_team)
        assert client.get("/api/team/agents").status_code == 404

    def test_agents_returns_lead_and_members(self, app_with_team):
        client = TestClient(app_with_team)
        resp = client.get("/api/team/agents")
        assert resp.status_code == 200
        data = resp.json()
        assert "agents" in data
        names = [a["name"] for a in data["agents"]]
        assert "lead" in names
        assert "worker" in names

    def test_agents_lead_has_is_lead_true(self, app_with_team):
        client = TestClient(app_with_team)
        data = client.get("/api/team/agents").json()
        lead_entry = next(a for a in data["agents"] if a["name"] == "lead")
        assert lead_entry["is_lead"] is True

    def test_agents_worker_has_is_lead_false(self, app_with_team):
        client = TestClient(app_with_team)
        data = client.get("/api/team/agents").json()
        worker_entry = next(a for a in data["agents"] if a["name"] == "worker")
        assert worker_entry["is_lead"] is False

    def test_agents_response_has_tools_and_mcp_servers_keys(self, app_with_team):
        client = TestClient(app_with_team)
        data = client.get("/api/team/agents").json()
        for agent in data["agents"]:
            assert "tools" in agent
            assert "mcp_servers" in agent
            assert "model" in agent

    def test_agents_blueprints_include_agent_details_and_live_instances(
        self, app_with_team, test_team, tmp_path
    ):
        test_team.blueprints["executor"] = MemberBlueprint(
            name="executor",
            description="writes code",
            source_path=tmp_path / "executor.md",
        )
        test_team.members["executor#1"] = TeamMember(
            Agent(
                name="executor#1", llm_provider=MockProvider(), system_prompt="Worker"
            )
        )
        blueprint_agent = Agent(
            name="executor", llm_provider=MockProvider(), system_prompt="Blueprint"
        )
        blueprint_agent.description = "writes code"

        with patch(
            "app.agent.loader.rebuild_agent_from_disk", return_value=blueprint_agent
        ):
            data = TestClient(app_with_team).get("/api/team/agents").json()

        blueprint = next(bp for bp in data["blueprints"] if bp["name"] == "executor")
        assert blueprint["description"] == "writes code"
        assert blueprint["live_instances"] == ["executor#1"]
        assert "tools" in blueprint
        assert "mcp_servers" in blueprint
        assert "model" in blueprint
        assert "capabilities" in blueprint

    def test_agents_caches_unchanged_blueprint_rebuilds_and_invalidates_on_edit(
        self, app_with_team, test_team, tmp_path, monkeypatch
    ):
        from app.core.config import settings

        source_path = tmp_path / "executor.md"
        source_path.write_text(
            "---\nname: executor\nrole: member\nmodel: mock:model\n---\nfirst\n",
            encoding="utf-8",
        )
        monkeypatch.setattr(settings, "AGENTS_DIR", str(tmp_path))
        test_team.blueprints["executor"] = MemberBlueprint(
            name="executor", description="writes code", source_path=source_path
        )
        blueprint_agent = Agent(
            name="executor", llm_provider=MockProvider(), system_prompt="Blueprint"
        )

        with patch(
            "app.agent.loader.rebuild_agent_from_disk", return_value=blueprint_agent
        ) as rebuild:
            client = TestClient(app_with_team)
            assert client.get("/api/team/agents").status_code == 200
            assert client.get("/api/team/agents").status_code == 200
            assert rebuild.call_count == 1

            source_path.write_text(
                "---\nname: executor\nrole: member\nmodel: mock:model\n---\nedited\n",
                encoding="utf-8",
            )
            assert client.get("/api/team/agents").status_code == 200

        assert rebuild.call_count == 2

    def test_agents_reads_settings_once_regardless_of_agent_count(
        self, app_with_team, test_team, tmp_path
    ):
        """settings.yaml is read once per request, not once per serialized agent.

        ``_serialize_agent`` used to call ``load_runtime_settings()`` itself, so
        a request paid a file read plus a YAML parse for every member *and*
        every blueprint. The route now hoists it and threads the value down.
        """
        source_path = tmp_path / "executor.md"
        source_path.write_text(
            "---\nname: executor\nrole: member\nmodel: mock:model\n---\nBlueprint\n",
            encoding="utf-8",
        )
        test_team.blueprints["executor"] = MemberBlueprint(
            name="executor", description="writes code", source_path=source_path
        )
        blueprint_agent = Agent(
            name="executor", llm_provider=MockProvider(), system_prompt="Blueprint"
        )

        from app.core.runtime_settings import RuntimeSettings

        with (
            patch(
                "app.agent.loader.rebuild_agent_from_disk",
                return_value=blueprint_agent,
            ),
            patch(
                "app.core.runtime_settings.load_runtime_settings",
                return_value=RuntimeSettings(),
            ) as load_settings,
        ):
            client = TestClient(app_with_team)
            resp = client.get("/api/team/agents")

        assert resp.status_code == 200
        # lead + worker + 1 blueprint would previously have been 3 reads.
        assert len(resp.json()["agents"]) >= 2
        assert len(resp.json()["blueprints"]) == 1
        assert load_settings.call_count == 1

    def test_agents_still_applies_custom_summary_threshold(self, app_with_team):
        """Hoisting the settings read must not drop the user's override."""
        from app.core.runtime_settings import RuntimeSettings

        settings = RuntimeSettings()
        settings.summarization.prompt_token_threshold = 4242

        with patch(
            "app.core.runtime_settings.load_runtime_settings", return_value=settings
        ):
            data = TestClient(app_with_team).get("/api/team/agents").json()

        assert data["agents"], "expected at least one serialized agent"
        for agent in data["agents"]:
            assert agent["summary_trigger_tokens"] == 4242

    def test_agents_workspace_returns_coding_team(
        self, app_without_team, test_team, monkeypatch
    ):
        async def fake_get_or_start_coding_team(workspace: str, session_id: str):
            test_team.mode = "coding"
            test_team.workspace = workspace
            return test_team

        monkeypatch.setattr(
            "app.api.routes.team.chat.team_manager.get_or_start_coding_team",
            fake_get_or_start_coding_team,
        )

        client = TestClient(app_without_team)
        data = client.get(
            "/api/team/agents", params={"workspace": "/tmp/project"}
        ).json()

        assert data["mode"] == "coding"
        assert data["workspace"] == "/tmp/project"

    def test_agents_workspace_validation_error_returns_422(
        self, app_without_team, monkeypatch
    ):
        async def fake_get_or_start_coding_team(workspace: str, session_id: str):
            raise ValueError("bad workspace")

        monkeypatch.setattr(
            "app.api.routes.team.chat.team_manager.get_or_start_coding_team",
            fake_get_or_start_coding_team,
        )

        client = TestClient(app_without_team)
        resp = client.get("/api/team/agents", params={"workspace": "/nope"})

        assert resp.status_code == 422

    def test_agents_picks_up_new_blueprint_file_without_restart(
        self, app_with_team, test_team, tmp_path, monkeypatch
    ):
        """End-to-end guard for the hot-reload fix: a member ``.md`` file
        created on disk after the team is built must appear in
        ``GET /api/team/agents`` on the next request, with no server
        restart or team reload."""
        from app.core.config import settings

        monkeypatch.setattr(settings, "AGENTS_DIR", str(tmp_path))
        (tmp_path / "newcomer.md").write_text(
            "---\nname: newcomer\nrole: member\nmodel: mock:model\n"
            "description: just arrived\n---\nbody\n",
            encoding="utf-8",
        )

        # ``_serialize_blueprint`` calls ``rebuild_agent_from_disk`` for
        # each blueprint; stub it so we don't need a working provider.
        blueprint_agent = Agent(
            name="newcomer", llm_provider=MockProvider(), system_prompt="Newcomer"
        )
        blueprint_agent.description = "just arrived"
        with patch(
            "app.agent.loader.rebuild_agent_from_disk", return_value=blueprint_agent
        ):
            data = TestClient(app_with_team).get("/api/team/agents").json()

        names = [bp["name"] for bp in data["blueprints"]]
        assert "newcomer" in names

    def test_coding_chat_rejects_session_workspace_mismatch(
        self, app_without_team, tmp_path
    ):
        session_id = uuid.uuid7()
        workspace = tmp_path / "project"
        other_workspace = tmp_path / "other"
        workspace.mkdir()
        other_workspace.mkdir()
        asyncio.run(
            _save_chat_session(
                ChatSession(
                    id=session_id,
                    title="Coding task",
                    agent_name="lead",
                    mode="coding",
                    workspace=str(workspace),
                )
            )
        )

        client = TestClient(app_without_team)
        resp = client.post(
            "/api/team/chat",
            data={
                "message": "continue",
                "mode": "coding",
                "workspace": str(other_workspace),
                "session_id": str(session_id),
            },
        )

        assert resp.status_code == 409

    def test_coding_chat_restores_persisted_session_workspace(
        self, app_without_team, test_team, monkeypatch, tmp_path
    ):
        session_id = uuid.uuid7()
        workspace = tmp_path / "project"
        workspace.mkdir()
        asyncio.run(
            _save_chat_session(
                ChatSession(
                    id=session_id,
                    title="Coding task",
                    agent_name="lead",
                    mode="coding",
                    workspace=str(workspace),
                )
            )
        )
        test_team.handle_user_message = AsyncMock(
            return_value=(str(session_id), str(uuid.uuid7()))
        )

        async def fake_get_or_start_coding_team(
            requested_workspace: str, requested_session_id: str
        ):
            test_team.mode = "coding"
            test_team.workspace = requested_workspace
            return test_team

        monkeypatch.setattr(
            "app.api.routes.team.chat.team_manager.get_or_start_coding_team",
            fake_get_or_start_coding_team,
        )

        client = TestClient(app_without_team)
        resp = client.post(
            "/api/team/chat",
            data={"message": "continue", "session_id": str(session_id)},
        )

        assert resp.status_code == 202
        assert test_team.handle_user_message.call_args.kwargs["mode"] == "coding"
        assert test_team.handle_user_message.call_args.kwargs["workspace"] == str(
            workspace.resolve()
        )

    def test_workspace_validate_returns_resolved_path(self, app_without_team, tmp_path):
        workspace = tmp_path / "project"
        workspace.mkdir()
        client = TestClient(app_without_team)

        resp = client.get(
            "/api/team/workspace/validate", params={"workspace": str(workspace)}
        )

        assert resp.status_code == 200
        assert resp.json() == {"workspace": str(workspace.resolve())}

    def test_workspace_validate_missing_path_returns_422(
        self, app_without_team, tmp_path
    ):
        client = TestClient(app_without_team)

        resp = client.get(
            "/api/team/workspace/validate", params={"workspace": str(tmp_path / "nope")}
        )

        assert resp.status_code == 422

    def test_workspace_browse_lists_child_directories(self, app_without_team, tmp_path):
        (tmp_path / "project").mkdir()
        (tmp_path / "notes.txt").write_text("skip", encoding="utf-8")
        client = TestClient(app_without_team)

        resp = client.get("/api/team/workspace/browse", params={"path": str(tmp_path)})

        assert resp.status_code == 200
        data = resp.json()
        assert data["path"] == str(tmp_path.resolve())
        assert {entry["name"] for entry in data["directories"]} == {"project"}

    async def test_workspace_browse_offloads_filesystem_work(
        self, tmp_path, monkeypatch
    ):
        """Directory enumeration, stat, and resolution must not block the loop."""
        from app.api.routes.team import chat as chat_routes

        (tmp_path / "project").mkdir()
        calls = []

        async def recording_to_thread(function, /, *args, **kwargs):
            calls.append((function, args, kwargs))
            return function(*args, **kwargs)

        monkeypatch.setattr(chat_routes.asyncio, "to_thread", recording_to_thread)

        result = await chat_routes.browse_coding_workspace(str(tmp_path))

        assert result.path == str(tmp_path.resolve())
        assert [folder.name for folder in result.directories] == ["project"]
        assert calls == [(chat_routes._browse_coding_workspace, (str(tmp_path),), {})]

    def test_workspace_files_lists_selected_workspace(self, app_without_team, tmp_path):
        (tmp_path / "src").mkdir()
        (tmp_path / "src" / "app.py").write_text("print('ok')", encoding="utf-8")
        client = TestClient(app_without_team)

        resp = client.get(
            "/api/team/workspace/files/list", params={"workspace": str(tmp_path)}
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["workspace"] == str(tmp_path.resolve())
        assert {entry["path"] for entry in body["files"]} == {"src/app.py"}

    def test_workspace_git_diff_non_repo(self, app_without_team, tmp_path):
        client = TestClient(app_without_team)

        resp = client.get(
            "/api/team/workspace/git-diff/view", params={"workspace": str(tmp_path)}
        )

        assert resp.status_code == 200
        assert resp.json()["is_git_repo"] is False

    def test_workspace_git_diff_is_truncated(
        self, app_without_team, tmp_path, monkeypatch
    ):
        (tmp_path / ".git").mkdir()
        monkeypatch.setattr(
            "app.api.routes.team.files._MAX_GIT_DIFF_CHARS",
            10,
        )
        monkeypatch.setattr(
            "app.api.routes.team.files.subprocess.run",
            lambda *args, **kwargs: SimpleNamespace(
                returncode=0,
                stdout="x" * 20,
                stderr="",
            ),
        )
        client = TestClient(app_without_team)

        resp = client.get(
            "/api/team/workspace/git-diff/view", params={"workspace": str(tmp_path)}
        )

        assert resp.status_code == 200
        assert resp.json()["diff"] == "x" * 10
        assert resp.json()["truncated"] is True

    def test_workspace_git_diff_includes_untracked(
        self, app_without_team, tmp_path, monkeypatch
    ):
        (tmp_path / ".git").mkdir()
        (tmp_path / "test.py").write_text('print("hello")\n', encoding="utf-8")

        def fake_run(*args, **kwargs):
            command = args[0]
            if command[3:6] == ["ls-files", "--others", "--exclude-standard"]:
                return SimpleNamespace(returncode=0, stdout="test.py\n", stderr="")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        monkeypatch.setattr("app.api.routes.team.files.subprocess.run", fake_run)
        client = TestClient(app_without_team)

        resp = client.get(
            "/api/team/workspace/git-diff/view", params={"workspace": str(tmp_path)}
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["untracked"] == ["test.py"]
        assert "diff --git a/test.py b/test.py" in body["diff"]
        assert "--- /dev/null\n+++ b/test.py\n@@" in body["diff"]
        assert '+print("hello")' in body["diff"]

    def test_workspace_git_diff_includes_staged(self, app_without_team, tmp_path):
        """A staged (``git add``-ed) tracked change must still appear.

        Plain ``git diff`` only reports unstaged changes, so a file vanished
        from the panel once staged. The route uses ``git diff HEAD`` so staged
        and unstaged tracked changes both show. Uses a real git repo.
        """
        import shutil
        import subprocess

        if shutil.which("git") is None:
            pytest.skip("git not available")

        env = {
            "GIT_AUTHOR_NAME": "t",
            "GIT_AUTHOR_EMAIL": "t@t",
            "GIT_COMMITTER_NAME": "t",
            "GIT_COMMITTER_EMAIL": "t@t",
        }

        def git(*args):
            subprocess.run(
                ["git", "-C", str(tmp_path), *args],
                check=True,
                capture_output=True,
                env={**__import__("os").environ, **env},
            )

        git("init")
        tracked = tmp_path / "tracked.py"
        tracked.write_text("original\n", encoding="utf-8")
        git("add", "tracked.py")
        git("commit", "-m", "initial")

        # Modify the committed file and stage the modification.
        tracked.write_text("changed\n", encoding="utf-8")
        git("add", "tracked.py")

        client = TestClient(app_without_team)
        resp = client.get(
            "/api/team/workspace/git-diff/view", params={"workspace": str(tmp_path)}
        )

        assert resp.status_code == 200
        body = resp.json()
        # The staged modification is present in the diff even though plain
        # ``git diff`` would report nothing.
        assert "diff --git a/tracked.py b/tracked.py" in body["diff"]
        assert "-original" in body["diff"]
        assert "+changed" in body["diff"]

    def test_workspace_git_diff_scoped_paths(
        self, app_without_team, tmp_path, monkeypatch
    ):
        """``paths=`` scopes both the tracked diff and the untracked scan."""
        (tmp_path / ".git").mkdir()
        (tmp_path / "wanted.py").write_text("a", encoding="utf-8")
        (tmp_path / "ignored.py").write_text("b", encoding="utf-8")

        captured_diff_args: list[list[str]] = []

        def fake_run(*args, **kwargs):
            command = args[0]
            # ``git diff -- <pathspecs>``
            if "diff" in command:
                captured_diff_args.append(command)
                return SimpleNamespace(returncode=0, stdout="", stderr="")
            if command[3:6] == ["ls-files", "--others", "--exclude-standard"]:
                # Both files are untracked; the route must filter to the
                # ones the caller asked about.
                return SimpleNamespace(
                    returncode=0,
                    stdout="wanted.py\nignored.py\n",
                    stderr="",
                )
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        monkeypatch.setattr("app.api.routes.team.files.subprocess.run", fake_run)
        client = TestClient(app_without_team)

        resp = client.get(
            "/api/team/workspace/git-diff/view",
            params={"workspace": str(tmp_path), "paths": ["wanted.py"]},
        )

        assert resp.status_code == 200
        body = resp.json()
        # ``git diff`` invoked with the scoped pathspec, not ``.``
        assert captured_diff_args, "git diff was not called"
        diff_cmd = captured_diff_args[0]
        assert "--" in diff_cmd
        sep = diff_cmd.index("--")
        assert diff_cmd[sep + 1 :] == ["wanted.py"]
        # Untracked scan filtered to the requested path only.
        assert body["untracked"] == ["wanted.py"]

    def test_workspace_git_diff_rejects_path_traversal(
        self, app_without_team, tmp_path, monkeypatch
    ):
        """``paths=../etc/passwd`` must not leak diffs outside the workspace."""
        (tmp_path / ".git").mkdir()
        monkeypatch.setattr(
            "app.api.routes.team.files.subprocess.run",
            lambda *a, **kw: SimpleNamespace(returncode=0, stdout="", stderr=""),
        )
        client = TestClient(app_without_team)

        resp = client.get(
            "/api/team/workspace/git-diff/view",
            params={"workspace": str(tmp_path), "paths": ["../etc/passwd"]},
        )

        assert resp.status_code == 422
        assert "invalid path" in resp.json()["detail"].lower()

    def test_workspace_status_non_repo(self, app_without_team, tmp_path):
        client = TestClient(app_without_team)

        resp = client.get(
            "/api/team/workspace/status", params={"workspace": str(tmp_path)}
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["is_git_repo"] is False
        assert body["workspace"] == str(tmp_path.resolve())
        assert body["name"] == tmp_path.name

    def test_workspace_status_git_repo(self, app_without_team, tmp_path, monkeypatch):
        (tmp_path / ".git").mkdir()

        # Two git calls: status (porcelain v2) then log. Order matches the
        # endpoint's call order so a queue is the simplest fake.
        outputs = [
            # status --porcelain=v2 --branch
            "# branch.head main\n1 M. N... 100644 100644 100644 a a fileA\n? newfile.txt\n",
            # log -1
            "abc1234\x00fix scroll\x001700000000\n",
            # rev-list --count HEAD ^@{u}
            "2\n",
            # rev-list --count @{u} ^HEAD
            "1\n",
        ]

        def fake_run(*args, **kwargs):
            stdout = outputs.pop(0) if outputs else ""
            return SimpleNamespace(returncode=0, stdout=stdout, stderr="")

        monkeypatch.setattr("app.api.routes.team.files.subprocess.run", fake_run)

        client = TestClient(app_without_team)
        resp = client.get(
            "/api/team/workspace/status", params={"workspace": str(tmp_path)}
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["is_git_repo"] is True
        assert body["branch"] == "main"
        assert body["dirty"] == {"staged": 1, "unstaged": 0, "untracked": 1}
        assert body["head"] == {
            "sha": "abc1234",
            "subject": "fix scroll",
            "timestamp": 1700000000,
        }
        assert body["commits_ahead"] == 2
        assert body["commits_behind"] == 1

    def test_workspace_status_git_repo_no_upstream_fallback(
        self, app_without_team, tmp_path, monkeypatch
    ):
        (tmp_path / ".git").mkdir()

        def fake_run(cmd, *args, **kwargs):
            git_args = cmd[3:] if len(cmd) > 3 else []
            args_str = " ".join(git_args)
            if args_str.startswith("status"):
                return SimpleNamespace(
                    returncode=0, stdout="# branch.head branch-A\n", stderr=""
                )
            if args_str.startswith("log"):
                return SimpleNamespace(
                    returncode=0,
                    stdout="def456\x00new branch feature\x001700000000\n",
                    stderr="",
                )
            if "^@{u}" in args_str:
                return SimpleNamespace(
                    returncode=128, stdout="", stderr="fatal: no upstream configured"
                )
            if "origin/branch-A" in args_str:
                return SimpleNamespace(
                    returncode=128, stdout="", stderr="fatal: needed a single revision"
                )
            if "rev-parse" in args_str and "origin/HEAD" in args_str:
                return SimpleNamespace(returncode=0, stdout="123456\n", stderr="")
            if "rev-list" in args_str and "^origin/HEAD" in args_str:
                return SimpleNamespace(returncode=0, stdout="3\n", stderr="")
            if (
                "rev-list" in args_str
                and "origin/HEAD" in args_str
                and "^HEAD" in args_str
            ):
                return SimpleNamespace(returncode=0, stdout="0\n", stderr="")
            return SimpleNamespace(returncode=1, stdout="", stderr="error")

        monkeypatch.setattr("app.api.routes.team.files.subprocess.run", fake_run)

        client = TestClient(app_without_team)
        resp = client.get(
            "/api/team/workspace/status", params={"workspace": str(tmp_path)}
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["is_git_repo"] is True
        assert body["branch"] == "branch-A"
        assert body["commits_ahead"] == 3
        assert body["commits_behind"] == 0
        assert body["upstream"] == "origin/HEAD"


# ---------------------------------------------------------------------------
# GET /team/sessions (lines 163-215)
# ---------------------------------------------------------------------------


class TestListTeamSessions:
    def test_list_sessions_returns_200(self, app_with_team):
        client = TestClient(app_with_team)
        resp = client.get("/api/team/sessions")
        assert resp.status_code == 200
        data = resp.json()
        assert "data" in data
        assert "has_more" in data
        assert "next_cursor" in data
        # Me legacy offset/total fields must not be present
        assert "total" not in data
        assert "offset" not in data

    def test_list_sessions_limit_param(self, app_with_team):
        client = TestClient(app_with_team)
        resp = client.get("/api/team/sessions?limit=5")
        assert resp.status_code == 200

    def test_list_sessions_invalid_limit_returns_422(self, app_with_team):
        client = TestClient(app_with_team)
        resp = client.get("/api/team/sessions?limit=0")
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# GET /team/sessions/{session_id}
# ---------------------------------------------------------------------------


class TestGetTeamSessionDetail:
    def test_session_detail_returns_coding_workspace_for_direct_route_restore(
        self, app_without_team, monkeypatch, tmp_path
    ):
        session_id = uuid.uuid7()
        workspace = str(tmp_path / "project")
        lead_session = ChatSession(
            id=session_id,
            title="Coding task",
            agent_name="lead",
            mode="coding",
            workspace=workspace,
        )

        async def fake_get_team_history(db, requested_id, offset=0, limit=1000):
            assert requested_id == session_id
            assert offset == 0
            assert limit == 1000
            return SimpleNamespace(
                lead_session=lead_session, lead_messages=[], members=[]
            )

        monkeypatch.setattr(
            "app.api.routes.team.chat.get_team_history",
            fake_get_team_history,
        )

        client = TestClient(app_without_team)
        resp = client.get(f"/api/team/sessions/{session_id}")

        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == str(session_id)
        assert data["mode"] == "coding"
        assert data["workspace"] == workspace
        assert data["messages"] == []

    @pytest.mark.asyncio
    async def test_session_detail_marks_running_session(
        self, app_without_team, monkeypatch
    ):
        from app.services import memory_stream_store

        session_id = uuid.uuid7()
        lead_session = ChatSession(
            id=session_id,
            title="Running task",
            agent_name="lead",
        )

        async def fake_get_team_history(db, requested_id, offset=0, limit=1000):
            assert requested_id == session_id
            return SimpleNamespace(
                lead_session=lead_session, lead_messages=[], members=[]
            )

        monkeypatch.setattr(
            "app.api.routes.team.chat.get_team_history",
            fake_get_team_history,
        )

        await memory_stream_store.init_turn(str(session_id))
        try:
            client = TestClient(app_without_team)
            resp = client.get(f"/api/team/sessions/{session_id}")
        finally:
            await memory_stream_store.clear(str(session_id))

        assert resp.status_code == 200
        assert resp.json()["running"] is True

    def test_session_detail_missing_session_returns_404(
        self, app_without_team, monkeypatch
    ):
        async def fake_get_team_history(db, requested_id, offset=0, limit=1000):
            return None

        monkeypatch.setattr(
            "app.api.routes.team.chat.get_team_history",
            fake_get_team_history,
        )

        client = TestClient(app_without_team)
        resp = client.get(f"/api/team/sessions/{uuid.uuid7()}")

        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# DELETE /team/sessions/{session_id}
# ---------------------------------------------------------------------------


class TestDeleteTeamSession:
    def test_delete_session_not_found_returns_404(self, app_with_team):
        client = TestClient(app_with_team)
        resp = client.delete(f"/api/team/sessions/{uuid.uuid7()}")
        assert resp.status_code == 404

    def test_delete_session_invalid_uuid_returns_422(self, app_with_team):
        client = TestClient(app_with_team)
        resp = client.delete("/api/team/sessions/bad-uuid")
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# GET /team/{session_id}/history (lines 294-338)
# ---------------------------------------------------------------------------


class TestTeamHistoryRouteExtra:
    def test_history_no_team_returns_404(self, app_without_team):
        client = TestClient(app_without_team)
        resp = client.get(f"/api/team/{uuid.uuid7()}/history")
        assert resp.status_code == 404

    def test_history_session_not_found_returns_404(self, app_with_team):
        client = TestClient(app_with_team)
        resp = client.get(f"/api/team/{uuid.uuid7()}/history")
        assert resp.status_code == 404

    def test_history_valid_unknown_uuid_returns_404(self, app_with_team):
        client = TestClient(app_with_team)
        resp = client.get(f"/api/team/{uuid.uuid7()}/history")
        assert resp.status_code == 404

    def test_history_before_cursor_accepts_compound_and_legacy_forms(
        self, app_with_team, monkeypatch
    ):
        """``before`` accepts ``<iso>|<uuid>`` and a bare ISO timestamp."""
        captured: dict[str, object] = {}

        async def fake_get_team_history(
            db, requested_id, *, before=None, before_id=None
        ):
            captured["before"] = before
            captured["before_id"] = before_id
            return None  # 404s out; we only care about cursor parsing

        monkeypatch.setattr(
            "app.api.routes.team.chat.get_team_history", fake_get_team_history
        )
        client = TestClient(app_with_team)
        sid = uuid.uuid7()
        msg_id = uuid.uuid7()

        resp = client.get(
            f"/api/team/{sid}/history",
            params={"before": f"2025-01-01T00:00:00+00:00|{msg_id}"},
        )
        assert resp.status_code == 404
        assert captured["before_id"] == msg_id
        assert captured["before"].year == 2025

        resp = client.get(
            f"/api/team/{sid}/history", params={"before": "2025-01-01T00:00:00+00:00"}
        )
        assert resp.status_code == 404
        assert captured["before_id"] is None

    def test_history_before_cursor_rejects_malformed_id(self, app_with_team):
        client = TestClient(app_with_team)
        resp = client.get(
            f"/api/team/{uuid.uuid7()}/history",
            params={"before": "2025-01-01T00:00:00+00:00|not-a-uuid"},
        )
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Workspace file ignore helpers
# ---------------------------------------------------------------------------


class TestWorkspaceFileIgnoreHelpers:
    def test_gitignore_rules_skip_files_and_directories(self, tmp_path):
        from app.api.routes.team.files import _is_gitignored, _load_gitignore_rules

        (tmp_path / ".gitignore").write_text(
            "dist/\n*.log\n!important.log\n/docs/private.md\n",
            encoding="utf-8",
        )

        rules = _load_gitignore_rules(tmp_path)

        assert _is_gitignored("dist", is_dir=True, rules=rules) is True
        assert _is_gitignored("dist/app.js", is_dir=False, rules=rules) is True
        assert _is_gitignored("logs/app.log", is_dir=False, rules=rules) is True
        assert _is_gitignored("important.log", is_dir=False, rules=rules) is False
        assert _is_gitignored("docs/private.md", is_dir=False, rules=rules) is True
        assert _is_gitignored("docs/public.md", is_dir=False, rules=rules) is False


# ---------------------------------------------------------------------------
# _serialize_agent helper
# ---------------------------------------------------------------------------


class TestSerializeAgent:
    def test_serialize_includes_model_id(self):
        from app.api.routes.team import _serialize_agent
        from app.agent.agent_loop import Agent

        provider = MagicMock()
        agent = Agent(
            llm_provider=provider, name="bot", model_id="openrouter:qwen/qwen3"
        )
        result = _serialize_agent(agent, is_lead=True)
        assert result["model"] == "openrouter:qwen/qwen3"
        assert result["is_lead"] is True
        assert result["name"] == "bot"

    def test_serialize_none_model_id(self):
        from app.api.routes.team import _serialize_agent
        from app.agent.agent_loop import Agent

        provider = MagicMock()
        agent = Agent(llm_provider=provider, name="bot")
        result = _serialize_agent(agent, is_lead=False)
        assert result["model"] is None

    def test_serialize_mcp_servers_present_in_response(self):
        from app.api.routes.team import _serialize_agent
        from app.agent.agent_loop import Agent

        provider = MagicMock()
        agent = Agent(llm_provider=provider, name="bot", mcp_servers=["my-server"])
        result = _serialize_agent(agent)
        assert "mcp_servers" in result
        assert result["mcp_servers"] == ["my-server"]

    def test_serialize_skill_description_includes_project_skills(self, tmp_path):
        """The ``skill`` tool description is computed via ``get_sandbox()``.

        Without binding the sandbox to the coding ``workspace`` for the
        duration of serialization, project-local skills under
        ``{workspace}/.openagentd/skills`` never show up — the endpoint
        would silently fall back to the process-default temp sandbox.
        """
        from app.agent.agent_loop import Agent
        from app.agent.tools.builtin.skill import load_skill
        from app.api.routes.team import _serialize_agent

        project_skills = tmp_path / ".openagentd" / "skills" / "proj-skill"
        project_skills.mkdir(parents=True)
        (project_skills / "SKILL.md").write_text(
            "---\nname: proj-skill\ndescription: A project-local skill.\n---\nBody.\n"
        )

        agent = Agent(llm_provider=MagicMock(), name="bot", tools=[load_skill])
        result = _serialize_agent(agent, workspace=str(tmp_path))

        skill_tool = next(t for t in result["tools"] if t["name"] == "skill")
        assert "proj-skill" in skill_tool["description"]

    def test_serialize_includes_mcp_servers(self):
        """Configured MCP servers surface even when they contribute zero tools.

        The UI uses this list to render server sections (and group their tools
        by the `<server>_<tool>` naming convention), so servers that exist
        in config but aren't ready still need to round-trip.
        """
        from app.agent.agent_loop import Agent
        from app.api.routes.team import _serialize_agent

        agent = Agent(
            llm_provider=MagicMock(), name="bot", mcp_servers=["context7", "filesystem"]
        )
        result = _serialize_agent(agent)
        assert result["mcp_servers"] == ["context7", "filesystem"]
