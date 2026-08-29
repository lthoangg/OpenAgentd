"""Agent endpoints — all under /agent.

Router groups (split across modules to keep each file focused on one
resource):

- :mod:`app.api.routes.agent.chat` — POST /chat, GET /{sid}/stream,
  GET /agents, GET /sessions, DELETE /sessions/{sid}, GET /{sid}/history
- :mod:`app.api.routes.agent.files` — GET /{sid}/uploads/{filename},
  GET /{sid}/media/{path}, GET /{sid}/files
- :mod:`app.api.routes.agent.todos` — GET /sessions/{sid}/todos
- :mod:`app.api.routes.agent.permissions` — GET /{sid}/permissions,
  POST /{sid}/permissions/{request_id}/reply
- :mod:`app.api.routes.agent.questions` — GET /{sid}/question,
  POST /{sid}/question/{qid}/answer, POST /{sid}/question/{qid}/dismiss

The combined :data:`router` is mounted under ``/api/agent`` by
:func:`app.api.app.create_app`.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.api.routes.agent import (
    chat,
    files,
    permissions,
    questions,
    todos,
    worktrees,
)

router = APIRouter()
router.include_router(chat.router)
router.include_router(files.router)
router.include_router(todos.router)
router.include_router(permissions.router)
router.include_router(questions.router)
router.include_router(worktrees.router)

__all__ = ["router"]
