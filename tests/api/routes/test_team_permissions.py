"""Tests for the team permission HTTP routes.

Covers the request/reply round-trip that previously had no route-level
coverage:

- ``GET  /{session_id}/permissions``                       — list pending
- ``POST /{session_id}/permissions/{request_id}/reply``    — resolve one

These exercise the route layer against a real :class:`PermissionService`
(not the auto-allow default), so list/reply, session scoping, validation,
and the not-found path are all verified end to end.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.agent import permission as permission_module
from app.agent.permission import PermissionService, set_permission_service
from app.api.routes.team.permissions import router as permissions_router


@pytest.fixture
def app() -> FastAPI:
    app = FastAPI()
    app.include_router(permissions_router)
    return app


@pytest.fixture
async def client(app: FastAPI):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


class _Harness:
    """A real permission service plus tracking for parked ``ask`` tasks."""

    def __init__(self, svc: PermissionService) -> None:
        self.svc = svc
        self._tasks: list[asyncio.Task] = []

    async def make_pending(
        self, tool: str = "bash", pattern: str = "rm -rf build"
    ) -> str:
        """Drive ``ask`` until it parks a pending request; return its id."""
        task = asyncio.create_task(self.svc.ask(tool, [pattern]))
        self._tasks.append(task)
        for _ in range(100):
            await asyncio.sleep(0)
            if self.svc.list_pending():
                break
        pending = self.svc.list_pending()
        assert pending, "expected ask() to register a pending request"
        return pending[0].id

    async def drain(self) -> None:
        """Resolve and await any still-parked ``ask`` tasks so none leak."""
        for req in self.svc.list_pending():
            self.svc.reply(req.id, "reject")
        for task in self._tasks:
            try:
                await task
            except permission_module.PermissionRejectedError:
                pass
        self._tasks.clear()


@pytest.fixture
async def service(monkeypatch):
    """Install a real (non-auto-allow) service for session ``s1``.

    Routes call the module-level ``get_permission_service()``; the contextvar
    set by ``set_permission_service`` is not visible across the route's task,
    so we also pin the module default to the same instance.
    """
    svc = PermissionService(session_id="s1")
    set_permission_service(svc)
    monkeypatch.setattr(permission_module, "_default_service", svc, raising=False)
    harness = _Harness(svc)
    yield harness
    await harness.drain()


# ── GET list ────────────────────────────────────────────────────────────────


async def test_list_empty_when_no_pending(client: AsyncClient, service):
    resp = await client.get("/s1/permissions")
    assert resp.status_code == 200
    assert resp.json() == {"permissions": []}


async def test_list_returns_pending_request(client: AsyncClient, service):
    req_id = await service.make_pending()
    resp = await client.get("/s1/permissions")
    assert resp.status_code == 200
    perms = resp.json()["permissions"]
    assert len(perms) == 1
    assert perms[0]["id"] == req_id
    assert perms[0]["tool"] == "bash"
    assert perms[0]["session_id"] == "s1"
    assert perms[0]["patterns"] == ["rm -rf build"]


async def test_list_scoped_to_session(client: AsyncClient, service):
    """A different session id must not see this session's pending requests."""
    await service.make_pending()
    resp = await client.get("/other-session/permissions")
    assert resp.status_code == 200
    assert resp.json() == {"permissions": []}


# ── POST reply ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("reply", ["once", "always", "reject"])
async def test_reply_resolves_pending(client: AsyncClient, service, reply):
    req_id = await service.make_pending()
    resp = await client.post(f"/s1/permissions/{req_id}/reply", json={"reply": reply})
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok", "request_id": req_id, "reply": reply}
    # Let the parked ask() task observe the reply and run its cleanup.
    await service.drain()
    assert service.svc.list_pending() == []


async def test_reply_always_adds_session_rule(client: AsyncClient, service):
    """An ``always`` reply must persist an allow rule for the session."""
    req_id = await service.make_pending()
    resp = await client.post(
        f"/s1/permissions/{req_id}/reply", json={"reply": "always"}
    )
    assert resp.status_code == 200
    # Drain the parked ask() task so the always-rule is appended.
    await service.drain()
    assert any(
        r.action == "allow" and r.permission == "bash"
        for r in service.svc.session_ruleset
    )


async def test_reply_invalid_value_is_422(client: AsyncClient, service):
    req_id = await service.make_pending()
    resp = await client.post(f"/s1/permissions/{req_id}/reply", json={"reply": "maybe"})
    assert resp.status_code == 422


async def test_reply_unknown_request_is_404(client: AsyncClient, service):
    resp = await client.post(
        "/s1/permissions/does-not-exist/reply", json={"reply": "once"}
    )
    assert resp.status_code == 404
