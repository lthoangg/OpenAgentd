"""Permission request list/reply endpoints."""

from __future__ import annotations

from typing import Literal, cast

from fastapi import APIRouter, HTTPException
from loguru import logger

from app.api.schemas.agent import (
    PermissionListResponse,
    PermissionReplyRequest,
    PermissionReplyResponse,
    PermissionRequestResponse,
)

router = APIRouter()


@router.get("/{session_id}/permissions")
async def list_permissions(session_id: str) -> PermissionListResponse:
    """Return all pending permission requests for *session_id*.

    Permissions accumulate while a tool execution is blocked awaiting user
    approval.  Poll this endpoint or listen to ``permission_asked`` SSE events.
    """
    from app.agent.permission import get_permission_service

    service = get_permission_service()
    if service.session_id != session_id:
        return PermissionListResponse(permissions=[])

    pending = service.list_pending()
    return PermissionListResponse(
        permissions=[
            PermissionRequestResponse(
                id=req.id,
                session_id=req.session_id,
                tool=req.tool,
                patterns=req.patterns,
                metadata=req.metadata,
            )
            for req in pending
        ]
    )


@router.post("/{session_id}/permissions/{request_id}/reply", status_code=200)
async def reply_permission(
    session_id: str,
    request_id: str,
    body: PermissionReplyRequest,
) -> PermissionReplyResponse:
    """Reply to a pending permission request.

    ``reply`` must be one of:
    - ``"once"``   — allow this single invocation
    - ``"always"`` — allow this command pattern for the rest of the session
    - ``"reject"`` — deny this invocation and raise an error to the agent
    """
    from app.agent.permission import get_permission_service

    valid_replies = {"once", "always", "reject"}
    if body.reply not in valid_replies:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid reply '{body.reply}'. Must be one of: {sorted(valid_replies)}",
        )

    service = get_permission_service()
    # Validation above guarantees ``body.reply`` is one of the literal values.
    resolved = service.reply(
        request_id,
        cast(Literal["once", "always", "reject"], body.reply),
        session_id=session_id,
    )
    if not resolved:
        raise HTTPException(
            status_code=404,
            detail=f"Permission request '{request_id}' not found or already resolved.",
        )

    logger.info(
        "permission_replied session_id={} request_id={} reply={}",
        session_id,
        request_id,
        body.reply,
    )
    return PermissionReplyResponse(status="ok", request_id=request_id, reply=body.reply)
