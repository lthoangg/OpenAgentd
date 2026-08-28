"""Tests for GET /api/session/sessions/{session_id}/todos endpoint.

Covers:
  GET /api/session/sessions/{session_id}/todos → retrieve todo list for session

Requirements validated:
  - session_id validated as UUID (400 on malformed)
  - Missing session-scoped .openagentd todo file returns empty list (fresh session)
  - Missing workspace dir returns empty list
  - Invalid JSON in session-scoped .openagentd todo file returns empty list
  - JSON list format (old format) returns empty list
  - Valid session-scoped .openagentd todo file returns TodosResponse with all items
  - Items missing required fields are skipped (caught by outer except)
  - Response schema matches TodoItemResponse
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.agent.tools.builtin.todo import TODOS_FILENAME

pytestmark = pytest.mark.usefixtures("setup_db")


@pytest.fixture(autouse=True)
def _isolate_data_dir(tmp_path, monkeypatch):
    """Pin session-artifact storage to a per-test dir.

    Session todos live under ``OPENAGENTD_DATA_DIR/sessions/<sid>``; without
    this each test would share the process-wide ``.tests/data`` default and
    leak todo state between tests.
    """
    monkeypatch.setattr(
        "app.core.config.settings.OPENAGENTD_DATA_DIR", str(tmp_path / "data")
    )


@pytest.fixture
def app_no_team():
    """Create FastAPI app without team."""
    from app.api.app import create_app
    from app.services.team_manager import set_team

    app = create_app()
    set_team(None)
    yield app
    set_team(None)


@pytest.fixture
def client(app_no_team, monkeypatch):
    """Create test client."""
    monkeypatch.delenv("OPENAGENTD_DESKTOP_TOKEN", raising=False)
    return TestClient(app_no_team)


@pytest.fixture
def session_id() -> str:
    """Generate a valid UUID session_id."""
    return str(uuid.uuid7())


def todos_path(root, session_id: str):
    """Resolve the session todo store the route actually reads.

    The route reads ``app.agent.artifacts.todos_path(session_id)`` —
    ``OPENAGENTD_DATA_DIR/sessions/<sid>/.todos.json`` — independent of the
    coding workspace.  ``root`` is retained for call-site compatibility but no
    longer affects the path; isolation comes from the per-test data dir pinned
    by the autouse ``_isolate_data_dir`` fixture and the unique ``session_id``.
    """
    from app.core.config import settings

    path = Path(settings.OPENAGENTD_DATA_DIR) / "sessions" / session_id / TODOS_FILENAME
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


class TestGetTodos:
    """Test suite for GET /api/session/sessions/{session_id}/todos."""

    def test_invalid_session_id_returns_400(self, client):
        """Malformed session_id (not a UUID) returns 400."""
        resp = client.get("/api/session/sessions/not-a-uuid/todos")
        assert resp.status_code == 400
        assert "Invalid session id" in resp.json()["detail"]

    def test_invalid_session_id_special_chars_returns_400(self, client):
        """Session_id with special characters returns 400."""
        resp = client.get("/api/session/sessions/not-uuid-format/todos")
        assert resp.status_code == 400
        assert "Invalid session id" in resp.json()["detail"]

    def test_invalid_session_id_malformed_uuid_returns_400(self, client):
        """Malformed UUID (wrong format) returns 400."""
        resp = client.get("/api/session/sessions/12345-67890/todos")
        assert resp.status_code == 400
        assert "Invalid session id" in resp.json()["detail"]

    def test_missing_todos_file_returns_empty_list(
        self, client, session_id, tmp_path, monkeypatch
    ):
        """Fresh session: session-scoped todo file doesn't exist → returns empty list."""
        fake_root = tmp_path / "ws"
        fake_root.mkdir(parents=True)

        resp = client.get(f"/api/session/sessions/{session_id}/todos")
        assert resp.status_code == 200
        body = resp.json()
        assert body == {"todos": []}

    def test_missing_workspace_dir_returns_empty_list(
        self, client, session_id, tmp_path, monkeypatch
    ):
        """Missing session artifact dir → returns empty list."""
        resp = client.get(f"/api/session/sessions/{session_id}/todos")
        assert resp.status_code == 200
        body = resp.json()
        assert body == {"todos": []}

    def test_invalid_json_in_todos_file_returns_empty_list(
        self, client, session_id, tmp_path, monkeypatch
    ):
        """Session-scoped todo file contains invalid JSON → returns empty list."""
        fake_root = tmp_path / "ws"
        fake_root.mkdir(parents=True)
        todos_path(fake_root, session_id).write_text("{ invalid json }")

        resp = client.get(f"/api/session/sessions/{session_id}/todos")
        assert resp.status_code == 200
        body = resp.json()
        assert body == {"todos": []}

    def test_json_list_format_returns_empty_list(
        self, client, session_id, tmp_path, monkeypatch
    ):
        """Old format: todo file is a JSON list (not dict) → returns empty list."""
        fake_root = tmp_path / "ws"
        fake_root.mkdir(parents=True)
        # Old format: just a list
        todos_path(fake_root, session_id).write_text(
            json.dumps(
                [
                    {
                        "task_id": "1",
                        "content": "task",
                        "status": "open",
                        "priority": "high",
                    }
                ]
            )
        )

        resp = client.get(f"/api/session/sessions/{session_id}/todos")
        assert resp.status_code == 200
        body = resp.json()
        assert body == {"todos": []}

    def test_valid_todos_file_with_single_item(
        self, client, session_id, tmp_path, monkeypatch
    ):
        """Valid session-scoped todo file with one item → returns TodosResponse."""
        fake_root = tmp_path / "ws"
        fake_root.mkdir(parents=True)
        todos_data = {
            "counter": 1,
            "items": [
                {
                    "task_id": "task-001",
                    "content": "Buy groceries",
                    "status": "open",
                    "priority": "high",
                }
            ],
        }
        todos_path(fake_root, session_id).write_text(json.dumps(todos_data))

        resp = client.get(f"/api/session/sessions/{session_id}/todos")
        assert resp.status_code == 200
        body = resp.json()
        assert len(body["todos"]) == 1
        assert body["todos"][0]["task_id"] == "task-001"
        assert body["todos"][0]["content"] == "Buy groceries"
        assert body["todos"][0]["status"] == "open"
        assert body["todos"][0]["priority"] == "high"

    def test_valid_todos_file_with_multiple_items(
        self, client, session_id, tmp_path, monkeypatch
    ):
        """Valid session-scoped todo file with multiple items → returns all items."""
        fake_root = tmp_path / "ws"
        fake_root.mkdir(parents=True)
        todos_data = {
            "counter": 3,
            "items": [
                {
                    "task_id": "task-001",
                    "content": "Buy groceries",
                    "status": "open",
                    "priority": "high",
                },
                {
                    "task_id": "task-002",
                    "content": "Write report",
                    "status": "in_progress",
                    "priority": "medium",
                },
                {
                    "task_id": "task-003",
                    "content": "Review PR",
                    "status": "done",
                    "priority": "low",
                },
            ],
        }
        todos_path(fake_root, session_id).write_text(json.dumps(todos_data))

        resp = client.get(f"/api/session/sessions/{session_id}/todos")
        assert resp.status_code == 200
        body = resp.json()
        assert len(body["todos"]) == 3
        # Verify all items are present
        task_ids = [item["task_id"] for item in body["todos"]]
        assert task_ids == ["task-001", "task-002", "task-003"]

    def test_todos_file_with_missing_task_id_field(
        self, client, session_id, tmp_path, monkeypatch
    ):
        """Item missing task_id field → entire list is discarded (caught by outer except)."""
        fake_root = tmp_path / "ws"
        fake_root.mkdir(parents=True)
        todos_data = {
            "counter": 2,
            "items": [
                {
                    "task_id": "task-001",
                    "content": "Valid item",
                    "status": "open",
                    "priority": "high",
                },
                {
                    # Missing task_id
                    "content": "Invalid item",
                    "status": "open",
                    "priority": "high",
                },
            ],
        }
        todos_path(fake_root, session_id).write_text(json.dumps(todos_data))

        resp = client.get(f"/api/session/sessions/{session_id}/todos")
        assert resp.status_code == 200
        body = resp.json()
        # When any item is invalid, the entire list is discarded
        assert body == {"todos": []}

    def test_todos_file_with_missing_content_field(
        self, client, session_id, tmp_path, monkeypatch
    ):
        """Item missing content field → entire list is discarded."""
        fake_root = tmp_path / "ws"
        fake_root.mkdir(parents=True)
        todos_data = {
            "counter": 2,
            "items": [
                {
                    "task_id": "task-001",
                    "content": "Valid item",
                    "status": "open",
                    "priority": "high",
                },
                {
                    "task_id": "task-002",
                    # Missing content
                    "status": "open",
                    "priority": "high",
                },
            ],
        }
        todos_path(fake_root, session_id).write_text(json.dumps(todos_data))

        resp = client.get(f"/api/session/sessions/{session_id}/todos")
        assert resp.status_code == 200
        body = resp.json()
        # When any item is invalid, the entire list is discarded
        assert body == {"todos": []}

    def test_todos_file_with_missing_status_field(
        self, client, session_id, tmp_path, monkeypatch
    ):
        """Item missing status field → entire list is discarded."""
        fake_root = tmp_path / "ws"
        fake_root.mkdir(parents=True)
        todos_data = {
            "counter": 2,
            "items": [
                {
                    "task_id": "task-001",
                    "content": "Valid item",
                    "status": "open",
                    "priority": "high",
                },
                {
                    "task_id": "task-002",
                    "content": "Invalid item",
                    # Missing status
                    "priority": "high",
                },
            ],
        }
        todos_path(fake_root, session_id).write_text(json.dumps(todos_data))

        resp = client.get(f"/api/session/sessions/{session_id}/todos")
        assert resp.status_code == 200
        body = resp.json()
        # When any item is invalid, the entire list is discarded
        assert body == {"todos": []}

    def test_todos_file_with_missing_priority_field(
        self, client, session_id, tmp_path, monkeypatch
    ):
        """Item missing priority field → entire list is discarded."""
        fake_root = tmp_path / "ws"
        fake_root.mkdir(parents=True)
        todos_data = {
            "counter": 2,
            "items": [
                {
                    "task_id": "task-001",
                    "content": "Valid item",
                    "status": "open",
                    "priority": "high",
                },
                {
                    "task_id": "task-002",
                    "content": "Invalid item",
                    "status": "open",
                    # Missing priority
                },
            ],
        }
        todos_path(fake_root, session_id).write_text(json.dumps(todos_data))

        resp = client.get(f"/api/session/sessions/{session_id}/todos")
        assert resp.status_code == 200
        body = resp.json()
        # When any item is invalid, the entire list is discarded
        assert body == {"todos": []}

    def test_todos_file_with_non_dict_items_are_skipped(
        self, client, session_id, tmp_path, monkeypatch
    ):
        """Items that are not dicts (e.g., strings, numbers) are skipped."""
        fake_root = tmp_path / "ws"
        fake_root.mkdir(parents=True)
        todos_data = {
            "counter": 3,
            "items": [
                {
                    "task_id": "task-001",
                    "content": "Valid item",
                    "status": "open",
                    "priority": "high",
                },
                "not a dict",  # String item
                123,  # Number item
            ],
        }
        todos_path(fake_root, session_id).write_text(json.dumps(todos_data))

        resp = client.get(f"/api/session/sessions/{session_id}/todos")
        assert resp.status_code == 200
        body = resp.json()
        assert len(body["todos"]) == 1
        assert body["todos"][0]["task_id"] == "task-001"

    def test_todos_file_with_empty_items_list(
        self, client, session_id, tmp_path, monkeypatch
    ):
        """Valid session-scoped todo file with empty items list → returns empty todos."""
        fake_root = tmp_path / "ws"
        fake_root.mkdir(parents=True)
        todos_data = {"counter": 0, "items": []}
        todos_path(fake_root, session_id).write_text(json.dumps(todos_data))

        resp = client.get(f"/api/session/sessions/{session_id}/todos")
        assert resp.status_code == 200
        body = resp.json()
        assert body == {"todos": []}

    def test_todos_file_missing_items_key(
        self, client, session_id, tmp_path, monkeypatch
    ):
        """Valid JSON dict but missing 'items' key → returns empty list."""
        fake_root = tmp_path / "ws"
        fake_root.mkdir(parents=True)
        todos_data = {"counter": 0}  # Missing 'items' key
        todos_path(fake_root, session_id).write_text(json.dumps(todos_data))

        resp = client.get(f"/api/session/sessions/{session_id}/todos")
        assert resp.status_code == 200
        body = resp.json()
        assert body == {"todos": []}

    def test_response_schema_has_required_fields(
        self, client, session_id, tmp_path, monkeypatch
    ):
        """Response items include dependency and claim metadata."""
        fake_root = tmp_path / "ws"
        fake_root.mkdir(parents=True)
        todos_data = {
            "counter": 1,
            "items": [
                {
                    "task_id": "task-001",
                    "content": "Test task",
                    "status": "open",
                    "priority": "high",
                }
            ],
        }
        todos_path(fake_root, session_id).write_text(json.dumps(todos_data))

        resp = client.get(f"/api/session/sessions/{session_id}/todos")
        assert resp.status_code == 200
        body = resp.json()
        item = body["todos"][0]
        # Verify all required fields are present
        assert "task_id" in item
        assert "content" in item
        assert "status" in item
        assert "priority" in item
        assert "dependencies" in item
        assert "assigned_to" in item
        assert "claimed_by" in item
        assert "instructions" in item
        assert "result" in item
        # Verify no extra fields (strict schema)
        assert set(item.keys()) == {
            "task_id",
            "content",
            "status",
            "priority",
            "dependencies",
            "assigned_to",
            "claimed_by",
            "instructions",
            "result",
        }

    def test_todos_file_with_extra_fields_in_items(
        self, client, session_id, tmp_path, monkeypatch
    ):
        """Items with extra fields beyond the required four → extra fields ignored."""
        fake_root = tmp_path / "ws"
        fake_root.mkdir(parents=True)
        todos_data = {
            "counter": 1,
            "items": [
                {
                    "task_id": "task-001",
                    "content": "Test task",
                    "status": "open",
                    "priority": "high",
                    "dependencies": ["task-000"],
                    "assigned_to": "member#1",
                    "claimed_by": "member#1",
                    "extra_field": "should be ignored",
                    "another_extra": 123,
                }
            ],
        }
        todos_path(fake_root, session_id).write_text(json.dumps(todos_data))

        resp = client.get(f"/api/session/sessions/{session_id}/todos")
        assert resp.status_code == 200
        body = resp.json()
        item = body["todos"][0]
        # Extra fields should not be in response (Pydantic strips them by default)
        assert set(item.keys()) == {
            "task_id",
            "content",
            "status",
            "priority",
            "dependencies",
            "assigned_to",
            "claimed_by",
            "instructions",
            "result",
        }
        assert item["task_id"] == "task-001"
        assert item["dependencies"] == ["task-000"]
        assert item["assigned_to"] == "member#1"
        assert item["claimed_by"] == "member#1"

    def test_different_session_ids_are_independent(self, client, tmp_path, monkeypatch):
        """Different session_ids read from different workspace dirs."""
        session_id_1 = str(uuid.uuid7())
        session_id_2 = str(uuid.uuid7())

        fake_root_1 = tmp_path / "ws1"
        fake_root_1.mkdir(parents=True)
        todos_data_1 = {
            "counter": 1,
            "items": [
                {
                    "task_id": "task-001",
                    "content": "Session 1 task",
                    "status": "open",
                    "priority": "high",
                }
            ],
        }
        todos_path(fake_root_1, session_id_1).write_text(json.dumps(todos_data_1))

        fake_root_2 = tmp_path / "ws2"
        fake_root_2.mkdir(parents=True)
        todos_data_2 = {
            "counter": 1,
            "items": [
                {
                    "task_id": "task-002",
                    "content": "Session 2 task",
                    "status": "done",
                    "priority": "low",
                }
            ],
        }
        todos_path(fake_root_2, session_id_2).write_text(json.dumps(todos_data_2))

        # Test session 1
        resp1 = client.get(f"/api/session/sessions/{session_id_1}/todos")
        assert resp1.status_code == 200
        body1 = resp1.json()
        assert len(body1["todos"]) == 1
        assert body1["todos"][0]["task_id"] == "task-001"
        assert body1["todos"][0]["content"] == "Session 1 task"

        # Test session 2
        resp2 = client.get(f"/api/session/sessions/{session_id_2}/todos")
        assert resp2.status_code == 200
        body2 = resp2.json()
        assert len(body2["todos"]) == 1
        assert body2["todos"][0]["task_id"] == "task-002"
        assert body2["todos"][0]["content"] == "Session 2 task"

    def test_same_coding_workspace_sessions_are_independent(
        self, client, tmp_path, monkeypatch
    ):
        """Coding sessions sharing one workspace must not share todo files."""
        session_id_1 = str(uuid.uuid7())
        session_id_2 = str(uuid.uuid7())
        shared_root = tmp_path / "project"
        shared_root.mkdir(parents=True)
        todos_path(shared_root, session_id_1).write_text(
            json.dumps(
                {
                    "counter": 1,
                    "items": [
                        {
                            "task_id": "task-001",
                            "content": "Only session 1",
                            "status": "pending",
                            "priority": "high",
                        }
                    ],
                }
            )
        )

        resp1 = client.get(f"/api/session/sessions/{session_id_1}/todos")
        resp2 = client.get(f"/api/session/sessions/{session_id_2}/todos")

        assert resp1.status_code == 200
        assert resp1.json()["todos"][0]["content"] == "Only session 1"
        assert resp2.status_code == 200
        assert resp2.json() == {"todos": []}
