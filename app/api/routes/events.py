"""Live process-local application event stream."""

from __future__ import annotations

from collections.abc import AsyncGenerator

from fastapi import APIRouter
from sse_starlette.sse import EventSourceResponse

from app.services import event_broadcaster

router = APIRouter()


@router.get("/stream")
async def global_events_stream() -> EventSourceResponse:
    """Stream live global events; reconnects intentionally do not replay."""

    async def _gen() -> AsyncGenerator[dict[str, str], None]:
        # Client disconnects cancel this generator via sse-starlette's
        # `_listen_for_disconnect` — see the note in `team_stream`.
        async for event in event_broadcaster.attach():
            yield event

    return EventSourceResponse(_gen())
