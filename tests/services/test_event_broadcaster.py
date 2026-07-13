"""Tests for process-local global SSE event fan-out."""

from __future__ import annotations

import asyncio
import json

import pytest

from app.services import event_broadcaster


@pytest.fixture(autouse=True)
async def _clear_broadcaster():
    await event_broadcaster.close()
    yield
    await event_broadcaster.close()


async def test_publish_fans_out_a_typed_event_without_replay():
    first = event_broadcaster.attach()
    second = event_broadcaster.attach()
    first_event = asyncio.create_task(anext(first))
    second_event = asyncio.create_task(anext(second))
    await asyncio.sleep(0)

    payload = {"session_id": "session-1", "title": "New title", "updated_at": "now"}
    await event_broadcaster.publish("title_update", payload)

    expected = {"event": "title_update", "data": json.dumps(payload)}
    assert await first_event == expected
    assert await second_event == expected
    await first.aclose()
    await second.aclose()


async def test_events_published_before_subscription_are_not_replayed():
    await event_broadcaster.publish("title_update", {"session_id": "session-1"})
    stream = event_broadcaster.attach()
    pending = asyncio.create_task(anext(stream))
    await asyncio.sleep(0)
    assert not pending.done()

    payload = {"session_id": "session-2"}
    await event_broadcaster.publish("title_update", payload)
    assert await pending == {"event": "title_update", "data": json.dumps(payload)}
    await stream.aclose()


def test_global_events_stream_route_is_registered():
    from app.api.app import create_app

    app = create_app()
    assert app.url_path_for("global_events_stream") == "/api/events/stream"
