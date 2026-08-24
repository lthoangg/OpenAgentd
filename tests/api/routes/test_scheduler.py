"""Tests for app/api/routes/scheduler.py — REST endpoints for scheduled tasks."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import tempfile

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

import app.core.db as _db_module
from app.api.routes.scheduler import get_scheduler, router
from app.scheduler.scheduler import TaskScheduler


_UTC = timezone.utc


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def fresh_scheduler():
    """An isolated scheduler bound to the in-memory test DB."""
    return TaskScheduler(db_factory=_db_module.async_session_factory)


@pytest.fixture
async def client(fresh_scheduler):
    app = FastAPI()
    app.include_router(router, prefix="/api/scheduler")
    app.dependency_overrides[get_scheduler] = lambda: fresh_scheduler

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as c:
        yield c

    await fresh_scheduler.stop()


def _create_payload(**overrides) -> dict:
    payload = {
        "name": "task1",
        "workspace": tempfile.mkdtemp(prefix="openagentd-test-workspace-"),
        "schedule_type": "every",
        "every_seconds": 60,
        "prompt": "hello",
    }
    payload.update(overrides)
    return payload


# ---------------------------------------------------------------------------
# POST /tasks
# ---------------------------------------------------------------------------


class TestCreate:
    async def test_creates_task_201(self, client):
        resp = await client.post("/api/scheduler/tasks", json=_create_payload())
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["name"] == "task1"
        assert body["workspace"]
        assert body["schedule_type"] == "every"
        assert body["every_seconds"] == 60
        assert body["enabled"] is True
        assert body["status"] == "pending"
        assert body["next_fire_at"] is not None

    async def test_coding_mode_invalid_workspace_422(self, client, tmp_path):
        # Workspace must exist on disk.
        ghost = tmp_path / "does-not-exist"
        resp = await client.post(
            "/api/scheduler/tasks",
            json=_create_payload(mode="coding", workspace=str(ghost)),
        )
        assert resp.status_code == 422
        assert "Workspace does not exist" in resp.json()["detail"]

    async def test_coding_mode_with_valid_workspace_201(self, client, tmp_path):
        ws = tmp_path / "ws"
        ws.mkdir()
        resp = await client.post(
            "/api/scheduler/tasks",
            json=_create_payload(name="c1", mode="coding", workspace=str(ws)),
        )
        assert resp.status_code == 201, resp.text
        body = resp.json()
        # Server normalises the workspace path (resolves symlinks, etc.) so
        # compare loosely.
        assert body["workspace"].endswith("ws")

    async def test_duplicate_name_returns_409(self, client):
        first = await client.post(
            "/api/scheduler/tasks", json=_create_payload(name="dup")
        )
        assert first.status_code == 201
        second = await client.post(
            "/api/scheduler/tasks", json=_create_payload(name="dup")
        )
        assert second.status_code == 409
        assert "already exists" in second.json()["detail"]

    async def test_invalid_schedule_returns_422(self, client):
        # at without at_datetime
        resp = await client.post(
            "/api/scheduler/tasks",
            json={
                "name": "bad",
                "workspace": tempfile.mkdtemp(prefix="openagentd-test-workspace-"),
                "schedule_type": "at",
                "prompt": "hi",
            },
        )
        assert resp.status_code == 422

    async def test_create_accepts_max_runs(self, client):
        resp = await client.post(
            "/api/scheduler/tasks",
            json=_create_payload(name="finite", max_runs=3),
        )
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["max_runs"] == 3
        assert body["run_count"] == 0

    async def test_create_rejects_non_positive_max_runs(self, client):
        resp = await client.post(
            "/api/scheduler/tasks",
            json=_create_payload(name="bad_max", max_runs=0),
        )
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# GET /tasks
# ---------------------------------------------------------------------------


class TestList:
    async def test_empty_list(self, client):
        resp = await client.get("/api/scheduler/tasks")
        assert resp.status_code == 200
        assert resp.json() == {"tasks": []}

    async def test_returns_persisted_tasks(self, client):
        await client.post("/api/scheduler/tasks", json=_create_payload(name="a"))
        await client.post("/api/scheduler/tasks", json=_create_payload(name="b"))
        resp = await client.get("/api/scheduler/tasks")
        assert resp.status_code == 200
        names = sorted(t["name"] for t in resp.json()["tasks"])
        assert names == ["a", "b"]


# ---------------------------------------------------------------------------
# GET /tasks/{task_id}
# ---------------------------------------------------------------------------


class TestGet:
    async def test_returns_task(self, client):
        created = await client.post(
            "/api/scheduler/tasks", json=_create_payload(name="findable")
        )
        task_slug = created.json()["slug"]

        resp = await client.get(f"/api/scheduler/tasks/{task_slug}")
        assert resp.status_code == 200
        assert resp.json()["name"] == "findable"

    async def test_unknown_slug_returns_404(self, client):
        resp = await client.get("/api/scheduler/tasks/some-unknown-slug")
        assert resp.status_code == 404
        assert "not found" in resp.json()["detail"].lower()


# ---------------------------------------------------------------------------
# PUT /tasks/{slug}
# ---------------------------------------------------------------------------


class TestUpdate:
    async def test_updates_fields(self, client):
        created = await client.post(
            "/api/scheduler/tasks", json=_create_payload(name="upd")
        )
        task_slug = created.json()["slug"]

        resp = await client.put(
            f"/api/scheduler/tasks/{task_slug}",
            json={"every_seconds": 30, "prompt": "new prompt"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["every_seconds"] == 30
        assert body["prompt"] == "new prompt"

    async def test_updates_max_runs(self, client):
        created = await client.post(
            "/api/scheduler/tasks", json=_create_payload(name="upd_max")
        )
        task_slug = created.json()["slug"]

        resp = await client.put(
            f"/api/scheduler/tasks/{task_slug}",
            json={"max_runs": 2},
        )
        assert resp.status_code == 200
        assert resp.json()["max_runs"] == 2

    async def test_clears_max_runs(self, client):
        created = await client.post(
            "/api/scheduler/tasks",
            json=_create_payload(name="clear_max", max_runs=2),
        )
        task_slug = created.json()["slug"]

        resp = await client.put(
            f"/api/scheduler/tasks/{task_slug}",
            json={"max_runs": None},
        )
        assert resp.status_code == 200
        assert resp.json()["max_runs"] is None

    async def test_update_to_coding_with_workspace(self, client, tmp_path):
        ws = tmp_path / "ws"
        ws.mkdir()
        created = await client.post(
            "/api/scheduler/tasks", json=_create_payload(name="upd3")
        )
        task_slug = created.json()["slug"]

        resp = await client.put(
            f"/api/scheduler/tasks/{task_slug}",
            json={"workspace": str(ws)},
        )
        assert resp.status_code == 200

    async def test_schedule_type_change_requires_its_schedule_field(self, client):
        created = await client.post(
            "/api/scheduler/tasks", json=_create_payload(name="change_type")
        )

        resp = await client.put(
            f"/api/scheduler/tasks/{created.json()['slug']}",
            json={"schedule_type": "cron"},
        )

        assert resp.status_code == 422

    async def test_schedule_type_change_clears_stale_fields(self, client):
        created = await client.post(
            "/api/scheduler/tasks", json=_create_payload(name="complete_change")
        )

        resp = await client.put(
            f"/api/scheduler/tasks/{created.json()['slug']}",
            json={"schedule_type": "cron", "cron_expression": "0 0 * * *"},
        )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["schedule_type"] == "cron"
        assert body["cron_expression"] == "0 0 * * *"
        assert body["every_seconds"] is None
        assert body["at_datetime"] is None

    async def test_unknown_slug_returns_404(self, client):
        resp = await client.put(
            "/api/scheduler/tasks/some-unknown-slug",
            json={"prompt": "x"},
        )
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# DELETE /tasks/{slug}
# ---------------------------------------------------------------------------


class TestDelete:
    async def test_deletes_task_204(self, client, fresh_scheduler):
        created = await client.post(
            "/api/scheduler/tasks", json=_create_payload(name="del")
        )
        task_slug = created.json()["slug"]

        resp = await client.delete(f"/api/scheduler/tasks/{task_slug}")
        assert resp.status_code == 204

        # Confirm gone
        get_resp = await client.get(f"/api/scheduler/tasks/{task_slug}")
        assert get_resp.status_code == 404

    async def test_unknown_slug_returns_404(self, client):
        resp = await client.delete("/api/scheduler/tasks/some-unknown-slug")
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# POST /tasks/{slug}/pause + /resume
# ---------------------------------------------------------------------------


class TestPauseResume:
    async def test_pause_sets_paused(self, client):
        created = await client.post(
            "/api/scheduler/tasks", json=_create_payload(name="p")
        )
        task_slug = created.json()["slug"]
        resp = await client.post(f"/api/scheduler/tasks/{task_slug}/pause")
        assert resp.status_code == 200
        body = resp.json()
        assert body["enabled"] is False
        assert body["status"] == "paused"

    async def test_resume_re_enables(self, client):
        created = await client.post(
            "/api/scheduler/tasks", json=_create_payload(name="r")
        )
        task_slug = created.json()["slug"]
        await client.post(f"/api/scheduler/tasks/{task_slug}/pause")
        resp = await client.post(f"/api/scheduler/tasks/{task_slug}/resume")
        assert resp.status_code == 200
        body = resp.json()
        assert body["enabled"] is True
        assert body["status"] == "pending"

    async def test_pause_unknown_slug_404(self, client):
        resp = await client.post("/api/scheduler/tasks/some-unknown-slug/pause")
        assert resp.status_code == 404

    async def test_resume_unknown_slug_404(self, client):
        resp = await client.post("/api/scheduler/tasks/some-unknown-slug/resume")
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# POST /tasks/{slug}/trigger
# ---------------------------------------------------------------------------


class TestTrigger:
    async def test_returns_202_and_dispatched_status(self, client, monkeypatch):
        # Stub _fire_task so the test doesn't actually invoke any team logic.
        async def _noop(task):
            return None

        monkeypatch.setattr(
            "app.scheduler.scheduler.TaskScheduler._fire_task",
            lambda self, task, fire_version=None: _noop(task),
        )

        created = await client.post(
            "/api/scheduler/tasks", json=_create_payload(name="trig")
        )
        task_slug = created.json()["slug"]
        resp = await client.post(f"/api/scheduler/tasks/{task_slug}/trigger")
        assert resp.status_code == 202
        assert resp.json() == {"status": "dispatched"}

    async def test_unknown_slug_returns_404(self, client):
        resp = await client.post("/api/scheduler/tasks/some-unknown-slug/trigger")
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Schedule type "at" — round-trip
# ---------------------------------------------------------------------------


class TestAtTask:
    async def test_create_at_with_future_datetime(self, client):
        target = (datetime.now(_UTC) + timedelta(hours=1)).isoformat()
        resp = await client.post(
            "/api/scheduler/tasks",
            json={
                "name": "at_one",
                "workspace": tempfile.mkdtemp(prefix="openagentd-test-workspace-"),
                "schedule_type": "at",
                "at_datetime": target,
                "prompt": "hi",
            },
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["schedule_type"] == "at"
        assert body["at_datetime"] is not None
        assert body["next_fire_at"] is not None


# ---------------------------------------------------------------------------
# Schedule type "cron" — round-trip
# ---------------------------------------------------------------------------


class TestCronTask:
    async def test_create_with_valid_cron(self, client):
        resp = await client.post(
            "/api/scheduler/tasks",
            json={
                "name": "cron_one",
                "workspace": tempfile.mkdtemp(prefix="openagentd-test-workspace-"),
                "schedule_type": "cron",
                "cron_expression": "0 0 * * *",
                "prompt": "hi",
            },
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["schedule_type"] == "cron"
        assert body["cron_expression"] == "0 0 * * *"

    async def test_invalid_cron_rejected_422(self, client):
        resp = await client.post(
            "/api/scheduler/tasks",
            json={
                "name": "bad_cron",
                "workspace": tempfile.mkdtemp(prefix="openagentd-test-workspace-"),
                "schedule_type": "cron",
                "cron_expression": "totally bogus",
                "prompt": "hi",
            },
        )
        assert resp.status_code == 422
