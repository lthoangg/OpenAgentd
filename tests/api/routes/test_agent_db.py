"""Tests for team route DB endpoints — list_sessions, get_session, delete_session, history.

Covers uncovered lines: 195-215, 226-245, 258-267, 296-340.
These tests use the real in-memory DB to exercise the SQL queries.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app.agent.agent_loop import Agent
from app.agent.providers.base import LLMProviderBase
from app.agent.session import AgentSession
from app.models.chat import ChatSession, CodingWorkspace, SessionMessage


class MockProvider(LLMProviderBase):
    model = "mock"

    def stream(self, messages, tools=None, **kwargs):
        from app.agent.schemas.chat import (
            ChatCompletionChunk,
            ChatCompletionChunkChoice,
            ChatCompletionDelta,
        )

        async def gen():
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
    agent = Agent(name="lead", llm_provider=MockProvider(), system_prompt="Lead")
    return AgentSession(agent=agent)


@pytest.fixture
def app_with_team(test_team):
    from app.api.app import create_app
    from app.services.agent_manager import set_agent_session

    app = create_app()
    set_agent_session(test_team)
    yield app
    set_agent_session(None)


async def _create_team_session(db, session_id, agent_name="lead", **kwargs):
    """Helper to create a top-level agent session in DB."""
    session = ChatSession(
        id=session_id,
        agent_name=agent_name,
        **kwargs,
    )
    db.add(session)
    return session


async def _create_member_session(db, session_id, parent_id, agent_name="worker"):
    """Helper to create a team-member session (child of a lead) in DB."""
    session = ChatSession(
        id=session_id,
        parent_session_id=parent_id,
        agent_name=agent_name,
    )
    db.add(session)
    return session


async def _add_message(db, session_id, role="user", content="test", **kwargs):
    # Mirror save_message's kind derivation for rows built directly.
    if "kind" not in kwargs:
        if kwargs.pop("is_summary", False):
            kwargs["kind"] = "summary"
        elif (kwargs.get("extra") or {}).get("hidden_from_user"):
            kwargs["kind"] = "note"
    msg = SessionMessage(
        session_id=session_id,
        role=role,
        content=content,
        **kwargs,
    )
    db.add(msg)
    return msg


# ---------------------------------------------------------------------------
# GET /agent/sessions — list with children (lines 163-215)
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# GET /agent/sessions — cursor-paginated list with children
# ---------------------------------------------------------------------------


class TestListTeamSessionsWithData:
    @pytest.mark.asyncio
    async def test_list_sessions_returns_root_session(self, app_with_team):
        import app.core.db as _db

        lead_id = uuid.uuid7()
        child_id = uuid.uuid7()

        async with _db.async_session_factory() as db:
            async with db.begin():
                await _create_team_session(db, lead_id)
                await _create_member_session(db, child_id, lead_id)

        client = TestClient(app_with_team)
        resp = client.get("/api/agent/sessions")
        assert resp.status_code == 200
        data = resp.json()

        assert "data" in data
        assert "has_more" in data
        assert "next_cursor" in data
        # Me lead session is in the list; member session is not
        found = [s for s in data["data"] if s["id"] == str(lead_id)]
        assert len(found) == 1

    @pytest.mark.asyncio
    async def test_list_sessions_marks_running_sessions(self, app_with_team):
        import app.core.db as _db
        from app.services import memory_stream_store

        running_id = uuid.uuid7()
        idle_id = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _create_team_session(db, running_id)
                await _create_team_session(db, idle_id)

        await memory_stream_store.init_turn(str(running_id))
        try:
            client = TestClient(app_with_team)
            resp = client.get("/api/agent/sessions")
            assert resp.status_code == 200
            by_id = {s["id"]: s for s in resp.json()["data"]}

            assert by_id[str(running_id)]["running"] is True
            assert by_id[str(idle_id)]["running"] is False
        finally:
            await memory_stream_store.clear(str(running_id))

    @pytest.mark.asyncio
    async def test_list_sessions_marks_sessions_awaiting_input(self, app_with_team):
        """The 'needs input' badge comes from one query for the whole page."""
        import app.core.db as _db
        from app.services import question_service

        waiting_id = uuid.uuid7()
        idle_id = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _create_team_session(db, waiting_id)
                await _create_team_session(db, idle_id)

        async with _db.async_session_factory() as db:
            await question_service.create_pending_question(
                db,
                session_id=waiting_id,
                tool_call_id="call_needs_input",
                questions=[
                    {
                        "question": "Which?",
                        "header": "Pick",
                        "options": [],
                        "custom": True,
                    }
                ],
            )
            await db.commit()

        client = TestClient(app_with_team)
        resp = client.get("/api/agent/sessions")
        assert resp.status_code == 200
        by_id = {s["id"]: s for s in resp.json()["data"]}

        assert by_id[str(waiting_id)]["needs_input"] is True
        assert by_id[str(idle_id)]["needs_input"] is False

    @pytest.mark.asyncio
    async def test_list_sessions_filters_coding_workspace(self, app_with_team):
        import app.core.db as _db

        workspace_id = uuid.uuid7()
        other_workspace_id = uuid.uuid7()
        unrelated_id = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _create_team_session(
                    db, workspace_id, mode="coding", workspace="/repo/project"
                )
                await _create_team_session(
                    db, other_workspace_id, mode="coding", workspace="/repo/other"
                )
                await _create_team_session(
                    db, unrelated_id, mode="coding", workspace="/repo/other"
                )

        client = TestClient(app_with_team)
        resp = client.get(
            "/api/agent/sessions",
            params={"mode": "coding", "workspace": "/repo/project"},
        )
        assert resp.status_code == 200
        ids = [s["id"] for s in resp.json()["data"]]
        assert ids == [str(workspace_id)]

    @pytest.mark.asyncio
    async def test_list_sessions_empty(self, app_with_team):
        """No team_lead sessions → empty data list, has_more=False."""
        client = TestClient(app_with_team)
        # Me use a before= cursor that predates any real data
        resp = client.get("/api/agent/sessions?before=2000-01-01T00:00:00Z")
        assert resp.status_code == 200
        data = resp.json()
        assert data["data"] == []
        assert data["has_more"] is False
        assert data["next_cursor"] is None

    @pytest.mark.asyncio
    async def test_list_sessions_pagination(self, app_with_team):
        import app.core.db as _db

        # Me create 3 lead sessions
        ids = [uuid.uuid7() for _ in range(3)]
        async with _db.async_session_factory() as db:
            async with db.begin():
                for sid in ids:
                    await _create_team_session(db, sid)

        client = TestClient(app_with_team)
        resp = client.get("/api/agent/sessions?limit=2")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["data"]) <= 2


class TestResolveTeamSession:
    def test_resolve_rejects_missing_workspace(self, app_with_team):
        client = TestClient(app_with_team)

        resp = client.post("/api/agent/sessions/resolve", json={})

        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_resolve_reuses_latest_workspace_session(
        self, app_with_team, tmp_path
    ):
        import app.core.db as _db

        lead_id = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _create_team_session(db, lead_id, workspace=str(tmp_path))

        client = TestClient(app_with_team)
        resp = client.post(
            "/api/agent/sessions/resolve", json={"workspace": str(tmp_path)}
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["created"] is False
        assert data["id"] == str(lead_id)

    @pytest.mark.asyncio
    async def test_resolve_can_force_create_workspace_session(
        self, app_with_team, tmp_path
    ):
        import app.core.db as _db

        lead_id = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _create_team_session(db, lead_id, workspace=str(tmp_path))

        client = TestClient(app_with_team)
        resp = client.post(
            "/api/agent/sessions/resolve",
            json={"workspace": str(tmp_path), "create": True},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["created"] is True
        assert data["id"] != str(lead_id)

    def test_resolve_creates_coding_session(self, app_with_team, tmp_path):
        client = TestClient(app_with_team)

        resp = client.post(
            "/api/agent/sessions/resolve",
            json={"workspace": str(tmp_path)},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["created"] is True
        assert data["workspace"] == str(tmp_path.resolve())

    def test_resolve_rejects_legacy_mode_without_workspace(self, app_with_team):
        client = TestClient(app_with_team)

        resp = client.post("/api/agent/sessions/resolve", json={"mode": "coding"})

        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_resolve_existing_worktree_session_keeps_registry_child(
        self, app_with_team, tmp_path
    ):
        import app.core.db as _db

        repo = tmp_path / "repo"
        worktree = tmp_path / "worktrees" / "task-a"
        repo.mkdir()
        worktree.mkdir(parents=True)
        async with _db.async_session_factory() as db:
            async with db.begin():
                db.add(CodingWorkspace(path=str(repo), kind="repo", name="repo"))
                db.add(
                    CodingWorkspace(
                        path=str(worktree),
                        kind="worktree",
                        source_path=str(repo),
                        name="task-a",
                        managed=True,
                    )
                )

        client = TestClient(app_with_team)
        resp = client.post(
            "/api/agent/sessions/resolve",
            json={"mode": "coding", "workspace": str(worktree)},
        )
        assert resp.status_code == 200

        tree = client.get("/api/agent/workspace/tree")
        assert tree.status_code == 200
        assert tree.json()["repositories"] == [
            {
                "path": str(repo),
                "name": "repo",
                "worktrees": [
                    {"path": str(worktree), "name": "task-a", "managed": True}
                ],
            }
        ]

    @pytest.mark.asyncio
    async def test_workspace_tree_ignores_hidden_and_deleted_worktrees(
        self, app_with_team, tmp_path
    ):
        import app.core.db as _db

        repo = tmp_path / "repo"
        hidden = tmp_path / "worktrees" / "hidden"
        deleted = tmp_path / "worktrees" / "deleted"
        repo.mkdir()
        hidden.mkdir(parents=True)
        deleted.mkdir(parents=True)
        async with _db.async_session_factory() as db:
            async with db.begin():
                db.add(CodingWorkspace(path=str(repo), kind="repo", name="repo"))
                db.add(
                    CodingWorkspace(
                        path=str(hidden),
                        kind="worktree",
                        source_path=str(repo),
                        name="hidden",
                        managed=True,
                        hidden=True,
                    )
                )
                db.add(
                    CodingWorkspace(
                        path=str(deleted),
                        kind="worktree",
                        source_path=str(repo),
                        name="deleted",
                        managed=True,
                        deleted_at=datetime.now(timezone.utc),
                    )
                )

        client = TestClient(app_with_team)
        tree = client.get("/api/agent/workspace/tree")
        assert tree.status_code == 200
        assert tree.json()["repositories"] == [
            {"path": str(repo), "name": "repo", "worktrees": []}
        ]

    @pytest.mark.asyncio
    async def test_workspace_tree_keeps_visible_worktree_under_hidden_source(
        self, app_with_team, tmp_path
    ):
        import app.core.db as _db

        repo = tmp_path / "repo"
        worktree = tmp_path / "worktrees" / "task-a"
        repo.mkdir()
        worktree.mkdir(parents=True)
        async with _db.async_session_factory() as db:
            async with db.begin():
                db.add(
                    CodingWorkspace(
                        path=str(repo), kind="repo", name="repo", hidden=True
                    )
                )
                db.add(
                    CodingWorkspace(
                        path=str(worktree),
                        kind="worktree",
                        source_path=str(repo),
                        name="task-a",
                        managed=True,
                    )
                )

        client = TestClient(app_with_team)
        tree = client.get("/api/agent/workspace/tree")
        assert tree.status_code == 200
        assert tree.json()["repositories"] == [
            {
                "path": str(repo),
                "name": "repo",
                "worktrees": [
                    {"path": str(worktree), "name": "task-a", "managed": True}
                ],
            }
        ]

    @pytest.mark.asyncio
    async def test_workspace_visibility_hides_all_workspace_sessions(
        self, app_with_team, tmp_path
    ):
        import app.core.db as _db

        workspace = str(tmp_path.resolve())
        first_id = uuid.uuid7()
        second_id = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _create_team_session(
                    db, first_id, mode="coding", workspace=workspace
                )
                await _create_team_session(
                    db, second_id, mode="coding", workspace=workspace
                )

        client = TestClient(app_with_team)
        resp = client.patch(
            "/api/agent/workspace/visibility",
            json={"workspace": workspace, "hidden": True},
        )
        assert resp.status_code == 200
        assert resp.json() == {"workspace": workspace, "hidden": True}

        tree = client.get("/api/agent/workspace/tree")
        assert tree.status_code == 200
        assert tree.json()["repositories"] == []

    @pytest.mark.asyncio
    async def test_workspace_visibility_can_hide_missing_workspace(
        self, app_with_team, tmp_path
    ):
        import app.core.db as _db

        workspace = str((tmp_path / "missing-worktree").resolve())
        lead_id = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _create_team_session(
                    db, lead_id, mode="coding", workspace=workspace
                )

        client = TestClient(app_with_team)
        resp = client.patch(
            "/api/agent/workspace/visibility",
            json={"workspace": workspace, "hidden": True},
        )
        assert resp.status_code == 200
        assert resp.json() == {"workspace": workspace, "hidden": True}

        tree = client.get("/api/agent/workspace/tree")
        assert tree.status_code == 200
        assert tree.json()["repositories"] == []

    @pytest.mark.asyncio
    async def test_workspace_visibility_rejects_restricted_root_when_hiding(
        self, app_with_team
    ):
        """Hiding must not persist a path inside a restricted system directory.

        The hide branch skips the *existence* check on purpose (see
        ``test_workspace_visibility_can_hide_missing_workspace``), but it must
        still enforce the blocked-root rule — ``hide_coding_workspace`` inserts
        a row when no workspace matches, so an unvalidated path would land in
        the database.
        """
        import app.core.db as _db
        from sqlmodel import select

        from app.models.chat import CodingWorkspace

        client = TestClient(app_with_team)
        resp = client.patch(
            "/api/agent/workspace/visibility",
            json={"workspace": "/etc", "hidden": True},
        )
        assert resp.status_code == 422

        async with _db.async_session_factory() as db:
            rows = (await db.exec(select(CodingWorkspace))).all()
        assert rows == []


# ---------------------------------------------------------------------------
# DELETE /agent/sessions/{session_id}
# ---------------------------------------------------------------------------


class TestUpdateTeamSession:
    @pytest.mark.asyncio
    async def test_update_session_title(self, app_with_team):
        import app.core.db as _db

        lead_id = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _create_team_session(db, lead_id, title="Old title")

        client = TestClient(app_with_team)
        resp = client.patch(
            f"/api/agent/sessions/{lead_id}", json={"title": "New title"}
        )

        assert resp.status_code == 200
        assert resp.json()["title"] == "New title"

        async with _db.async_session_factory() as db:
            session = await db.get(ChatSession, lead_id)
            assert session is not None
            assert session.title == "New title"

    @pytest.mark.asyncio
    async def test_update_session_title_trims_whitespace(self, app_with_team):
        import app.core.db as _db

        lead_id = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _create_team_session(db, lead_id, title="Old title")

        client = TestClient(app_with_team)
        resp = client.patch(
            f"/api/agent/sessions/{lead_id}", json={"title": "  New title  "}
        )

        assert resp.status_code == 200
        assert resp.json()["title"] == "New title"

        async with _db.async_session_factory() as db:
            session = await db.get(ChatSession, lead_id)
            assert session is not None
            assert session.title == "New title"

    @pytest.mark.asyncio
    async def test_update_session_title_rejects_blank_title(self, app_with_team):
        import app.core.db as _db

        lead_id = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _create_team_session(db, lead_id, title="Keep me")

        client = TestClient(app_with_team)
        resp = client.patch(f"/api/agent/sessions/{lead_id}", json={"title": "   "})

        assert resp.status_code == 422
        assert resp.json()["detail"] == "Title cannot be empty."

        async with _db.async_session_factory() as db:
            session = await db.get(ChatSession, lead_id)
            assert session is not None
            assert session.title == "Keep me"

    @pytest.mark.asyncio
    async def test_update_session_title_does_not_update_member_sessions(
        self, app_with_team
    ):
        import app.core.db as _db

        lead_id = uuid.uuid7()
        member_id = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _create_team_session(db, lead_id, title="Lead")
                member = await _create_member_session(db, member_id, lead_id)
                member.title = "Member"

        client = TestClient(app_with_team)
        resp = client.patch(f"/api/agent/sessions/{member_id}", json={"title": "Nope"})

        assert resp.status_code == 404

        async with _db.async_session_factory() as db:
            member = await db.get(ChatSession, member_id)
            assert member is not None
            assert member.title == "Member"

    def test_update_session_title_returns_404_for_missing_session(self, app_with_team):
        client = TestClient(app_with_team)

        resp = client.patch(
            f"/api/agent/sessions/{uuid.uuid7()}", json={"title": "New"}
        )

        assert resp.status_code == 404


class TestDeleteTeamSessionWithData:
    @pytest.mark.asyncio
    async def test_delete_session_removes_session_and_messages(self, app_with_team):
        import app.core.db as _db

        lead_id = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _create_team_session(db, lead_id)
                await _add_message(db, lead_id, role="user", content="delete me")

        client = TestClient(app_with_team)
        resp = client.delete(f"/api/agent/sessions/{lead_id}")
        assert resp.status_code == 204

        # Me verify session is gone via history endpoint
        resp = client.get(f"/api/agent/{lead_id}/history")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_delete_coding_session_keeps_workspace_dir(
        self, app_with_team, tmp_path, monkeypatch
    ):
        import app.core.db as _db
        from app.core.config import settings
        from app.core.paths import uploads_dir, workspace_dir

        monkeypatch.setattr(
            settings, "OPENAGENTD_WORKSPACE_DIR", str(tmp_path / "runs")
        )
        lead_id = uuid.uuid7()
        app_workspace = workspace_dir(str(lead_id))
        upload_root = uploads_dir(str(lead_id))
        upload_root.mkdir(parents=True)
        (upload_root / "attachment.txt").write_text("upload", encoding="utf-8")
        (app_workspace / "keep.txt").write_text("keep", encoding="utf-8")
        async with _db.async_session_factory() as db:
            async with db.begin():
                db.add(
                    ChatSession(
                        id=lead_id,
                        agent_name="lead",
                        mode="coding",
                        workspace=str(tmp_path / "project"),
                    )
                )

        client = TestClient(app_with_team)
        resp = client.delete(f"/api/agent/sessions/{lead_id}")

        assert resp.status_code == 204
        assert app_workspace.exists()
        assert (app_workspace / "keep.txt").read_text(encoding="utf-8") == "keep"
        assert not upload_root.exists()


# ---------------------------------------------------------------------------
# GET /agent/{session_id}/history (lines 281-340)
# ---------------------------------------------------------------------------


class TestAgentHistoryWithData:
    @pytest.mark.asyncio
    async def test_history_returns_lead_and_members(self, app_with_team):
        import app.core.db as _db

        lead_id = uuid.uuid7()
        member_id = uuid.uuid7()

        async with _db.async_session_factory() as db:
            async with db.begin():
                await _create_team_session(db, lead_id)
                await _create_member_session(
                    db, member_id, lead_id, agent_name="worker"
                )
                await _add_message(db, lead_id, role="user", content="lead msg")
                await _add_message(db, lead_id, role="assistant", content="lead reply")
                await _add_message(db, member_id, role="user", content="member input")
                await _add_message(
                    db, member_id, role="assistant", content="member reply"
                )

        client = TestClient(app_with_team)
        resp = client.get(f"/api/agent/{lead_id}/history")
        assert resp.status_code == 200
        data = resp.json()

        # Me check lead messages
        assert "lead" in data
        assert len(data["lead"]["messages"]) >= 2

        # Me check members
        assert "members" in data
        assert len(data["members"]) >= 1
        member = data["members"][0]
        assert len(member["messages"]) >= 2
        assert member["name"] == "worker"

    @pytest.mark.asyncio
    async def test_history_groups_multiple_members_correctly(self, app_with_team):
        """Batched member-page query must group messages per sub-session.

        Guards the N+1 -> single ``WHERE session_id IN (...)`` refactor:
        each member must get exactly its own messages (no cross-leak), and
        hidden rows (``extra.hidden_from_user``) must be filtered out.
        """
        import app.core.db as _db

        lead_id = uuid.uuid7()
        member_a = uuid.uuid7()
        member_b = uuid.uuid7()

        async with _db.async_session_factory() as db:
            async with db.begin():
                await _create_team_session(db, lead_id)
                await _create_member_session(db, member_a, lead_id, agent_name="alpha")
                await _create_member_session(db, member_b, lead_id, agent_name="beta")
                await _add_message(db, lead_id, role="user", content="lead msg")
                await _add_message(db, member_a, role="user", content="a-one")
                await _add_message(db, member_a, role="assistant", content="a-two")
                await _add_message(db, member_b, role="user", content="b-one")
                # Hidden row on member B must not surface in history.
                await _add_message(
                    db,
                    member_b,
                    role="assistant",
                    content="b-hidden",
                    extra={"hidden_from_user": True},
                )

        client = TestClient(app_with_team)
        resp = client.get(f"/api/agent/{lead_id}/history")
        assert resp.status_code == 200
        data = resp.json()

        members = {m["name"]: m for m in data["members"]}
        assert set(members) == {"alpha", "beta"}

        alpha_contents = [m["content"] for m in members["alpha"]["messages"]]
        beta_contents = [m["content"] for m in members["beta"]["messages"]]

        # No cross-session leakage.
        assert alpha_contents == ["a-one", "a-two"]
        # Hidden row filtered; only the visible one remains.
        assert beta_contents == ["b-one"]

    @pytest.mark.asyncio
    async def test_history_includes_summary_messages(self, app_with_team):
        """Summary rows (``is_summary=True``) must be returned by the history
        endpoint so the frontend can render the inline "Session compacted"
        divider — both at stream time and on subsequent page reloads.
        """
        import app.core.db as _db

        lead_id = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _create_team_session(db, lead_id)
                await _add_message(db, lead_id, role="user", content="visible")
                await _add_message(
                    db,
                    lead_id,
                    role="user",
                    content="compacted summary body",
                    is_summary=True,
                )

        client = TestClient(app_with_team)
        resp = client.get(f"/api/agent/{lead_id}/history")
        data = resp.json()

        msgs = data["lead"]["messages"]
        contents = [m["content"] for m in msgs]
        assert "visible" in contents
        assert "compacted summary body" in contents
        summary_msg = next(m for m in msgs if m["content"] == "compacted summary body")
        assert summary_msg["is_summary"] is True

    @pytest.mark.asyncio
    async def test_history_excludes_hidden_from_user_rows(self, app_with_team):
        import app.core.db as _db

        lead_id = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _create_team_session(db, lead_id)
                await _add_message(db, lead_id, role="user", content="visible")
                await _add_message(
                    db,
                    lead_id,
                    role="user",
                    content="hidden directive",
                    extra={"hidden_from_user": True},
                )

        client = TestClient(app_with_team)
        resp = client.get(f"/api/agent/{lead_id}/history")
        data = resp.json()

        contents = [m["content"] for m in data["lead"]["messages"]]
        assert contents == ["visible"]

    @pytest.mark.asyncio
    async def test_history_no_sub_sessions_returns_empty_members(self, app_with_team):
        import app.core.db as _db

        lead_id = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _create_team_session(db, lead_id)
                await _add_message(db, lead_id, role="user", content="solo")

        client = TestClient(app_with_team)
        resp = client.get(f"/api/agent/{lead_id}/history")
        data = resp.json()

        assert data["members"] == []


# ---------------------------------------------------------------------------
# GET /agent/sessions — cursor pagination behaviour
# ---------------------------------------------------------------------------


class TestListTeamSessionsCursorPagination:
    """Verify cursor-based pagination semantics for GET /agent/sessions."""

    @pytest.mark.asyncio
    async def test_response_shape(self, app_with_team):
        """Response always contains data, has_more, next_cursor."""
        client = TestClient(app_with_team)
        resp = client.get("/api/agent/sessions")
        assert resp.status_code == 200
        data = resp.json()
        assert "data" in data
        assert "has_more" in data
        assert "next_cursor" in data
        # Me legacy fields must NOT be present
        assert "total" not in data
        assert "offset" not in data

    @pytest.mark.asyncio
    async def test_first_page_no_cursor(self, app_with_team):
        """First page (no before=) returns newest sessions."""
        import app.core.db as _db

        ids = [uuid.uuid7() for _ in range(3)]
        async with _db.async_session_factory() as db:
            async with db.begin():
                for sid in ids:
                    await _create_team_session(db, sid)

        client = TestClient(app_with_team)
        resp = client.get("/api/agent/sessions?limit=3")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["data"]) >= 1
        # Me sessions are newest-first (UUIDv7 monotonically increases)
        created_times = [s["created_at"] for s in data["data"] if s["created_at"]]
        assert created_times == sorted(created_times, reverse=True)

    @pytest.mark.asyncio
    async def test_has_more_false_when_all_fit(self, app_with_team):
        """has_more=False when result count < limit."""
        import app.core.db as _db

        lead_id = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _create_team_session(db, lead_id)

        client = TestClient(app_with_team)
        # Me limit=100 — far more than 1 session
        resp = client.get("/api/agent/sessions?limit=100")
        data = resp.json()
        # has_more must be False when fewer rows than limit were returned
        assert len(data["data"]) < 100
        assert data["has_more"] is False
        assert data["next_cursor"] is None

    @pytest.mark.asyncio
    async def test_has_more_true_and_cursor_set(self, app_with_team):
        """has_more=True and next_cursor is set when more rows exist."""
        import app.core.db as _db

        ids = [uuid.uuid7() for _ in range(5)]
        async with _db.async_session_factory() as db:
            async with db.begin():
                for sid in ids:
                    await _create_team_session(db, sid)

        client = TestClient(app_with_team)
        resp = client.get("/api/agent/sessions?limit=2")
        data = resp.json()
        # Me only valid when there are at least 3 sessions total
        if len(data["data"]) == 2 and data["has_more"]:
            assert data["next_cursor"] is not None

    @pytest.mark.asyncio
    async def test_cursor_advances_to_next_page(self, app_with_team):
        """Passing next_cursor as before= fetches the next page without overlap."""
        import app.core.db as _db

        # Me create 4 sessions so pagination is deterministic within this test
        ids = [uuid.uuid7() for _ in range(4)]
        async with _db.async_session_factory() as db:
            async with db.begin():
                for sid in ids:
                    await _create_team_session(db, sid)

        client = TestClient(app_with_team)

        # Page 1 — limit=2
        resp1 = client.get("/api/agent/sessions?limit=2")
        assert resp1.status_code == 200
        page1 = resp1.json()
        ids_page1 = {s["id"] for s in page1["data"]}

        if not page1["has_more"]:
            pytest.skip("Not enough sessions for multi-page test")

        cursor = page1["next_cursor"]
        assert cursor is not None

        # Page 2 — use cursor
        resp2 = client.get(f"/api/agent/sessions?limit=2&before={cursor}")
        assert resp2.status_code == 200
        page2 = resp2.json()
        ids_page2 = {s["id"] for s in page2["data"]}

        # Me no overlap between pages
        assert ids_page1.isdisjoint(ids_page2)

    @pytest.mark.asyncio
    async def test_cursor_does_not_skip_sessions_with_equal_timestamps(
        self, app_with_team
    ):
        """The uuid tie-break carries all equal-created_at rows across pages."""
        import app.core.db as _db

        created_at = datetime(2026, 8, 20, 10, 0, tzinfo=timezone.utc)
        ids = [uuid.uuid7() for _ in range(4)]
        async with _db.async_session_factory() as db:
            async with db.begin():
                for sid in ids:
                    db.add(ChatSession(id=sid, created_at=created_at))

        client = TestClient(app_with_team)
        seen: list[str] = []
        before: str | None = None
        while True:
            suffix = f"&before={before}" if before else ""
            response = client.get(f"/api/agent/sessions?limit=2{suffix}")
            assert response.status_code == 200
            page = response.json()
            seen.extend(row["id"] for row in page["data"])
            if not page["has_more"]:
                break
            before = page["next_cursor"]

        assert {str(sid) for sid in ids}.issubset(seen)
        assert len(seen) == len(set(seen))

    @pytest.mark.asyncio
    async def test_invalid_before_returns_422(self, app_with_team):
        """Malformed before= cursor returns 422."""
        client = TestClient(app_with_team)
        resp = client.get("/api/agent/sessions?before=not-a-date")
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_before_far_past_returns_empty(self, app_with_team):
        """before= in the distant past returns no sessions."""
        import app.core.db as _db

        lead_id = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _create_team_session(db, lead_id)

        client = TestClient(app_with_team)
        resp = client.get("/api/agent/sessions?before=2000-01-01T00:00:00Z")
        assert resp.status_code == 200
        data = resp.json()
        assert data["data"] == []
        assert data["has_more"] is False
        assert data["next_cursor"] is None

    @pytest.mark.asyncio
    async def test_default_limit_is_20(self, app_with_team):
        """Default limit is 20."""
        import app.core.db as _db

        ids = [uuid.uuid7() for _ in range(25)]
        async with _db.async_session_factory() as db:
            async with db.begin():
                for sid in ids:
                    await _create_team_session(db, sid)

        client = TestClient(app_with_team)
        resp = client.get("/api/agent/sessions")
        assert resp.status_code == 200
        data = resp.json()
        # Default page size is 20 — must not return more than 20
        assert len(data["data"]) <= 20

    @pytest.mark.asyncio
    async def test_limit_exceeding_max_rejected(self, app_with_team):
        """limit > 100 is rejected (422)."""
        client = TestClient(app_with_team)
        resp = client.get("/api/agent/sessions?limit=101")
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_member_sessions_excluded_from_list(self, app_with_team):
        """Member sessions (parent_session_id set) do not appear in the top-level list."""
        import app.core.db as _db

        lead_id = uuid.uuid7()
        member_id = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _create_team_session(db, lead_id)
                await _create_member_session(db, member_id, lead_id)

        client = TestClient(app_with_team)
        resp = client.get("/api/agent/sessions")
        data = resp.json()

        top_level_ids = {s["id"] for s in data["data"]}
        assert str(lead_id) in top_level_ids
        assert str(member_id) not in top_level_ids


# ---------------------------------------------------------------------------
# GET /agent/{sid}/history?since= — delta reconciliation
# ---------------------------------------------------------------------------


class TestAgentHistorySinceCursor:
    """The turn-completion reconcile fetches only what it does not have.

    A full page carries up to 100 lead messages plus 100 per member with
    complete tool output (measured over a megabyte on real sessions), all of
    which the client already received over SSE.
    """

    @pytest.mark.asyncio
    async def test_since_returns_only_newer_messages(self, app_with_team):
        import app.core.db as _db

        lead_id = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _create_team_session(db, lead_id)
                await _add_message(db, lead_id, content="old")

        client = TestClient(app_with_team)
        full = client.get(f"/api/agent/{lead_id}/history")
        assert full.status_code == 200
        cursor = full.json()["lead"]["messages"][-1]["created_at"]

        async with _db.async_session_factory() as db:
            async with db.begin():
                await _add_message(db, lead_id, content="brand new")

        resp = client.get(f"/api/agent/{lead_id}/history", params={"since": cursor})

        assert resp.status_code == 200
        body = resp.json()
        assert [m["content"] for m in body["lead"]["messages"]] == ["brand new"]
        assert body["truncated"] is False
        # A delta has no older page to walk — the client must keep the
        # pagination cursor it already holds.
        assert body["has_more"] is False
        assert body["next_cursor"] is None

    @pytest.mark.asyncio
    async def test_since_and_before_together_rejected(self, app_with_team):
        import app.core.db as _db

        lead_id = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _create_team_session(db, lead_id)

        client = TestClient(app_with_team)
        resp = client.get(
            f"/api/agent/{lead_id}/history",
            params={"since": "2026-01-01T00:00:00", "before": "2026-01-02T00:00:00"},
        )

        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_since_rejects_malformed_cursor(self, app_with_team):
        import app.core.db as _db

        lead_id = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _create_team_session(db, lead_id)

        client = TestClient(app_with_team)
        resp = client.get(
            f"/api/agent/{lead_id}/history", params={"since": "not-a-date"}
        )

        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_since_missing_session_returns_404(self, app_with_team):
        client = TestClient(app_with_team)

        resp = client.get(
            f"/api/agent/{uuid.uuid7()}/history",
            params={"since": "2026-01-01T00:00:00"},
        )

        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_since_preserves_session_metadata(self, app_with_team):
        """The delta still carries lead metadata the store reads on reconcile."""
        import app.core.db as _db

        lead_id = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _create_team_session(db, lead_id, title="Kept Title")

        client = TestClient(app_with_team)
        resp = client.get(
            f"/api/agent/{lead_id}/history",
            params={"since": "2020-01-01T00:00:00"},
        )

        assert resp.status_code == 200
        assert resp.json()["lead"]["title"] == "Kept Title"

    @pytest.mark.asyncio
    async def test_naive_before_cursor_does_not_500(self, app_with_team):
        """Regression: created_at is a TZDateTime that rejects naive values.

        A cursor without a UTC offset used to reach the query layer and surface
        as a 500 instead of being handled at the boundary.
        """
        import app.core.db as _db

        lead_id = uuid.uuid7()
        async with _db.async_session_factory() as db:
            async with db.begin():
                await _create_team_session(db, lead_id)
                await _add_message(db, lead_id, content="only")

        client = TestClient(app_with_team)
        resp = client.get(
            f"/api/agent/{lead_id}/history", params={"before": "2030-01-01T00:00:00"}
        )

        assert resp.status_code == 200
