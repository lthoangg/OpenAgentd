"""Todo list endpoint — reads the per-session todo metadata file."""

from __future__ import annotations

import json
import uuid

from fastapi import APIRouter, HTTPException

from app.agent.tools.builtin.todo import TODOS_FILENAME
from app.api.schemas.team import TodoItemResponse, TodosResponse
from app.core.paths import workspace_dir

router = APIRouter()


@router.get("/sessions/{session_id}/todos")
async def get_todos(session_id: str) -> TodosResponse:
    """Return the current todo list for the session.

    Reads todos from the session metadata directory.  Returns an empty list
    when the file does not exist (no todos written yet).
    """
    try:
        uuid.UUID(session_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid session id.")

    root = workspace_dir(session_id)
    path = root / ".openagentd" / "sessions" / session_id / TODOS_FILENAME
    if not path.exists():
        return TodosResponse(todos=[])
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        items = data.get("items", []) if isinstance(data, dict) else []
        todos = [TodoItemResponse(**item) for item in items if isinstance(item, dict)]
    except Exception:
        todos = []
    return TodosResponse(todos=todos)
