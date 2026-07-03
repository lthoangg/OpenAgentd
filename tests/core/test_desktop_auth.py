"""Tests for app/core/desktop_auth.py — token middleware for desktop mode."""

from __future__ import annotations

import pytest
from fastapi import FastAPI, Request, WebSocket
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.core.desktop_auth import DesktopTokenMiddleware


def _make_app(token: str | None) -> FastAPI:
    app = FastAPI()
    app.add_middleware(DesktopTokenMiddleware, expected_token=token)

    @app.websocket("/api/ws-echo")
    async def ws_echo(websocket: WebSocket) -> None:
        await websocket.accept()
        # Echo the (post-middleware) query string so tests can verify
        # the token was scrubbed before reaching the handler.
        await websocket.send_json(
            {"qs": websocket.scope.get("query_string", b"").decode("latin-1")}
        )
        await websocket.close()

    @app.get("/api/health/live")
    def live() -> dict:
        return {"status": "ok"}

    @app.get("/api/team/status")
    def status() -> dict:
        return {"team": "ok"}

    @app.get("/api/auth/check")
    def auth_check() -> dict:
        return {"ok": True}

    @app.get("/")
    def root() -> dict:
        return {"hello": "world"}

    @app.get("/index.html")
    def index() -> dict:
        return {"index": True}

    @app.get("/assets/app.js")
    def asset() -> dict:
        return {"asset": True}

    @app.get("/metrics")
    def metrics() -> dict:
        return {"metrics": True}

    return app


class TestMiddlewareDisabled:
    """When no token is configured, every request passes through."""

    def test_protected_api_accessible_without_token(self):
        app = _make_app(token=None)
        client = TestClient(app)
        assert client.get("/api/team/status").status_code == 200

    def test_empty_token_disables_middleware(self):
        app = _make_app(token="")
        client = TestClient(app)
        assert client.get("/api/team/status").status_code == 200

    def test_access_key_env_enables_middleware(self, monkeypatch):
        monkeypatch.setenv("OPENAGENTD_ACCESS_KEY", "lan-secret")
        app = _make_app(token=None)
        client = TestClient(app)
        assert client.get("/api/team/status").status_code == 401
        r = client.get(
            "/api/team/status", headers={"Authorization": "Bearer lan-secret"}
        )
        assert r.status_code == 200

    def test_access_key_settings_yaml_enables_middleware(self, monkeypatch, tmp_path):
        (tmp_path / "settings.yaml").write_text(
            "server:\n  access_key: lan-secret\n", encoding="utf-8"
        )
        from app.core.config import settings

        monkeypatch.setattr(settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path))
        app = _make_app(token=None)
        client = TestClient(app)
        assert client.get("/api/team/status").status_code == 401
        r = client.get(
            "/api/team/status", headers={"Authorization": "Bearer lan-secret"}
        )
        assert r.status_code == 200


class TestMiddlewareEnabled:
    """When a token is configured, API requests must present it."""

    def test_api_without_token_rejected(self):
        app = _make_app(token="secret")
        client = TestClient(app)
        r = client.get("/api/team/status")
        assert r.status_code == 401
        assert "access key" in r.json()["detail"].lower()

    def test_api_with_wrong_token_rejected(self):
        app = _make_app(token="secret")
        client = TestClient(app)
        r = client.get("/api/team/status", headers={"Authorization": "Bearer wrong"})
        assert r.status_code == 401

    def test_api_with_correct_bearer_accepted(self):
        app = _make_app(token="secret")
        client = TestClient(app)
        r = client.get("/api/team/status", headers={"Authorization": "Bearer secret"})
        assert r.status_code == 200

    def test_auth_check_requires_token(self):
        app = _make_app(token="secret")
        client = TestClient(app)
        assert client.get("/api/auth/check").status_code == 401
        r = client.get("/api/auth/check", headers={"Authorization": "Bearer secret"})
        assert r.status_code == 200
        assert r.json() == {"ok": True}

    def test_api_with_query_param_token_accepted(self):
        app = _make_app(token="secret")
        client = TestClient(app)
        r = client.get("/api/team/status?_token=secret")
        assert r.status_code == 200

    def test_query_param_takes_precedence_path_filter(self):
        """Query param works even when Authorization header is missing."""
        app = _make_app(token="secret")
        client = TestClient(app)
        r = client.get("/api/team/status?_token=wrong")
        assert r.status_code == 401

    def test_health_live_does_not_require_token(self):
        app = _make_app(token="secret")
        client = TestClient(app)
        assert client.get("/api/health/live").status_code == 200

    def test_metrics_does_not_require_token(self):
        app = _make_app(token="secret")
        client = TestClient(app)
        assert client.get("/metrics").status_code == 200

    def test_spa_root_does_not_require_token(self):
        app = _make_app(token="secret")
        client = TestClient(app)
        assert client.get("/").status_code == 200

    def test_spa_assets_do_not_require_token(self):
        app = _make_app(token="secret")
        client = TestClient(app)
        assert client.get("/assets/app.js").status_code == 200

    def test_non_api_spa_route_does_not_require_token(self):
        app = _make_app(token="secret")
        client = TestClient(app)
        # SPA fallback routes like /chat, /settings — these are GETs
        # for the index.html shell, not API.
        assert client.get("/index.html").status_code == 200

    def test_token_uses_constant_time_compare(self):
        """Smoke check: tokens that differ in length still 401."""
        app = _make_app(token="secret")
        client = TestClient(app)
        for bad in ("", "s", "secret_extra", "SECRET"):
            r = client.get(
                "/api/team/status", headers={"Authorization": f"Bearer {bad}"}
            )
            assert r.status_code == 401, f"expected 401 for {bad!r}"

    def test_exempt_prefix_does_not_extend_to_sibling_api_path(self):
        """`/api/health/live` is exempt; `/api/health-evil` must not be.

        The exemption list uses prefix-matching for ``/api/health/`` (the
        orchestrator probe namespace). A sibling path that *starts with*
        the same characters but isn't actually under that namespace
        (e.g. ``/api/health-evil``) must require auth — otherwise an
        attacker could carve out an unauthenticated route by picking a
        clever name.
        """
        app = _make_app(token="secret")

        @app.get("/api/health-evil")
        def evil() -> dict:
            return {"pwned": True}

        client = TestClient(app)
        # No token → should 401, not 200.
        assert client.get("/api/health-evil").status_code == 401
        # With token → reaches the route.
        r = client.get("/api/health-evil", headers={"Authorization": "Bearer secret"})
        assert r.status_code == 200
        assert r.json() == {"pwned": True}

    def test_query_param_token_stripped_from_scope(self):
        """`_token=…` must not survive into downstream handlers / logs."""
        app = _make_app(token="secret")

        @app.get("/api/echo")
        def echo(request: Request) -> dict:
            # Re-read query params after middleware ran.
            return {
                "raw_qs": request.url.query,
                "has_token": "_token" in request.url.query,
                "has_other": "foo" in dict(request.query_params),
            }

        client = TestClient(app)
        r = client.get("/api/echo?_token=secret&foo=bar")
        assert r.status_code == 200
        body = r.json()
        assert body["has_token"] is False, "_token leaked downstream"
        assert body["has_other"] is True, "non-token params must be preserved"


class TestWebSocketAuth:
    """WebSocket upgrades on /api/* must obey the same token rules as HTTP.

    Browsers cannot attach an ``Authorization`` header to the WS
    handshake, so the query-param fallback (``?_token=…``) is the
    supported client mechanism.
    """

    def test_ws_without_token_rejected(self):
        app = _make_app(token="secret")
        client = TestClient(app)
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/api/ws-echo"):
                pass

    def test_ws_with_wrong_query_token_rejected(self):
        app = _make_app(token="secret")
        client = TestClient(app)
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/api/ws-echo?_token=wrong"):
                pass

    def test_ws_with_correct_query_token_accepted(self):
        app = _make_app(token="secret")
        client = TestClient(app)
        with client.websocket_connect("/api/ws-echo?_token=secret") as ws:
            assert "qs" in ws.receive_json()

    def test_ws_with_correct_bearer_header_accepted(self):
        """Non-browser clients (tests, native shells) can still use headers."""
        app = _make_app(token="secret")
        client = TestClient(app)
        with client.websocket_connect(
            "/api/ws-echo", headers={"Authorization": "Bearer secret"}
        ) as ws:
            assert "qs" in ws.receive_json()

    def test_ws_token_stripped_from_scope(self):
        """The WS handler must not see ``_token`` in its query string."""
        app = _make_app(token="secret")
        client = TestClient(app)
        with client.websocket_connect("/api/ws-echo?_token=secret&foo=bar") as ws:
            qs = ws.receive_json()["qs"]
            assert "_token" not in qs, "_token leaked into WS scope"
            assert "foo=bar" in qs, "non-token params must be preserved"

    def test_ws_disabled_middleware_passes_through(self):
        app = _make_app(token=None)
        client = TestClient(app)
        with client.websocket_connect("/api/ws-echo") as ws:
            assert "qs" in ws.receive_json()

    def test_ws_constant_time_compare_variants(self):
        app = _make_app(token="secret")
        client = TestClient(app)
        for bad in ("", "s", "secret_extra", "SECRET"):
            with pytest.raises(WebSocketDisconnect):
                with client.websocket_connect(f"/api/ws-echo?_token={bad}"):
                    pass
