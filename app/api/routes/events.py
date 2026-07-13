"""Live process-local application event stream."""

from __future__ import annotations

from collections.abc import AsyncGenerator

from fastapi import APIRouter, Request
from sse_starlette.sse import EventSourceResponse

from app.services import event_broadcaster

router = APIRouter()


@router.get("/stream")
async def global_events_stream(request: Request) -> EventSourceResponse:
    """Stream live global events; reconnects intentionally do not replay."""

    async def _gen() -> AsyncGenerator[dict[str, str], None]:
        async for event in event_broadcaster.attach():
            if await request.is_disconnected():
                break
            yield event

    return EventSourceResponse(_gen())
