"""Tests for app/core/middlewares.py — RequestSizeLimitMiddleware + SecurityHeadersMiddleware."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.middlewares import RequestSizeLimitMiddleware, SecurityHeadersMiddleware


def _make_app(max_bytes: int = 100) -> FastAPI:
    app = FastAPI()
    app.add_middleware(RequestSizeLimitMiddleware, max_bytes=max_bytes)

    @app.post("/upload")
    async def upload():
        return {"ok": True}

    return app


class TestRequestSizeLimitMiddleware:
    def test_request_within_limit_passes_through(self):
        client = TestClient(_make_app(max_bytes=100))
        resp = client.post(
            "/upload",
            content=b"x" * 50,
            headers={"Content-Length": "50"},
        )
        assert resp.status_code == 200

    def test_request_exactly_at_limit_passes_through(self):
        client = TestClient(_make_app(max_bytes=100))
        resp = client.post(
            "/upload",
            content=b"x" * 100,
            headers={"Content-Length": "100"},
        )
        assert resp.status_code == 200

    def test_request_exceeding_limit_returns_413(self):
        client = TestClient(_make_app(max_bytes=100))
        resp = client.post(
            "/upload",
            content=b"x" * 101,
            headers={"Content-Length": "101"},
        )
        assert resp.status_code == 413

    def test_413_body_contains_detail(self):
        client = TestClient(_make_app(max_bytes=10))
        resp = client.post(
            "/upload",
            content=b"x" * 20,
            headers={"Content-Length": "20"},
        )
        assert resp.json() == {"detail": "Request body too large."}

    def test_no_content_length_header_passes_through(self):
        """Requests without Content-Length (chunked) are allowed."""
        app = FastAPI()
        app.add_middleware(RequestSizeLimitMiddleware, max_bytes=10)

        @app.post("/upload")
        async def upload():
            return {"ok": True}

        client = TestClient(app)
        # Send without explicit Content-Length by using params-based body
        resp = client.post("/upload")
        assert resp.status_code == 200

    async def test_streaming_body_without_content_length_is_limited_cumulatively(self):
        received = bytearray()

        async def app(scope, receive, send):
            while True:
                message = await receive()
                received.extend(message.get("body", b""))
                if not message.get("more_body", False):
                    break
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"ok"})

        messages = iter(
            [
                {"type": "http.request", "body": b"12345", "more_body": True},
                {"type": "http.request", "body": b"67890", "more_body": True},
                {"type": "http.request", "body": b"!", "more_body": False},
            ]
        )
        sent = []

        async def receive():
            return next(messages)

        async def send(message):
            sent.append(message)

        middleware = RequestSizeLimitMiddleware(app, max_bytes=10)
        await middleware({"type": "http", "headers": []}, receive, send)

        assert received == b"1234567890"
        assert sent[0]["status"] == 413

    async def test_malformed_or_negative_content_length_cannot_bypass_stream_limit(
        self,
    ):
        async def app(scope, receive, send):
            while (await receive()).get("more_body", False):
                pass

        for content_length in (b"not-a-number", b"-1"):
            messages = iter(
                [
                    {
                        "type": "http.request",
                        "body": b"12345678901",
                        "more_body": False,
                    },
                ]
            )
            sent = []

            async def receive():
                return next(messages)

            async def send(message):
                sent.append(message)

            middleware = RequestSizeLimitMiddleware(app, max_bytes=10)
            await middleware(
                {"type": "http", "headers": [(b"content-length", content_length)]},
                receive,
                send,
            )

            assert sent[0]["status"] == 413

    async def test_early_response_with_disconnect_does_not_read_past_disconnect(self):
        received = []

        async def app(scope, receive, send):
            await send({"type": "http.response.start", "status": 200, "headers": []})
            received.append(await receive())
            await send({"type": "http.response.body", "body": b"ok"})

        messages = iter([{"type": "http.disconnect"}])
        sent = []

        async def receive():
            return next(messages)

        async def send(message):
            sent.append(message)

        middleware = RequestSizeLimitMiddleware(app, max_bytes=10)
        await middleware({"type": "http", "headers": []}, receive, send)

        assert received == [{"type": "http.disconnect"}]
        assert sent[0]["status"] == 200

    async def test_disconnect_read_by_app_does_not_trigger_second_receive(self):
        received = []

        async def app(scope, receive, send):
            received.append(await receive())
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"ok"})

        messages = iter([{"type": "http.disconnect"}])
        sent = []

        async def receive():
            return next(messages)

        async def send(message):
            sent.append(message)

        middleware = RequestSizeLimitMiddleware(app, max_bytes=10)
        await middleware({"type": "http", "headers": []}, receive, send)

        assert received == [{"type": "http.disconnect"}]
        assert sent[0]["status"] == 200

    async def test_oversized_body_replaces_response_started_before_body_read(self):
        async def app(scope, receive, send):
            await send({"type": "http.response.start", "status": 200, "headers": []})
            while (await receive()).get("more_body", False):
                pass
            await send({"type": "http.response.body", "body": b"ok"})

        messages = iter(
            [
                {"type": "http.request", "body": b"12345678901", "more_body": False},
            ]
        )
        sent = []

        async def receive():
            return next(messages)

        async def send(message):
            sent.append(message)

        middleware = RequestSizeLimitMiddleware(app, max_bytes=10)
        await middleware({"type": "http", "headers": []}, receive, send)

        assert [message["type"] for message in sent] == [
            "http.response.start",
            "http.response.body",
        ]
        assert sent[0]["status"] == 413

    async def test_false_content_length_is_counted_from_stream(self):
        async def app(scope, receive, send):
            while (await receive()).get("more_body", False):
                pass

        sent = []

        async def receive():
            return {"type": "http.request", "body": b"12345678901", "more_body": False}

        async def send(message):
            sent.append(message)

        middleware = RequestSizeLimitMiddleware(app, max_bytes=10)
        await middleware(
            {"type": "http", "headers": [(b"content-length", b"1")]}, receive, send
        )

        assert sent[0]["status"] == 413

    def test_default_max_bytes_is_4mb(self):
        middleware = RequestSizeLimitMiddleware(app=FastAPI())
        assert middleware._max_bytes == 4 * 1024 * 1024

    def test_custom_max_bytes_stored(self):
        middleware = RequestSizeLimitMiddleware(app=FastAPI(), max_bytes=1024)
        assert middleware._max_bytes == 1024


# ── SecurityHeadersMiddleware ────────────────────────────────────────────────


def _make_secure_app(**kwargs) -> FastAPI:
    app = FastAPI()
    app.add_middleware(SecurityHeadersMiddleware, **kwargs)

    @app.get("/ping")
    async def ping():
        return {"ok": True}

    @app.get("/custom-csp")
    async def custom():
        from fastapi.responses import JSONResponse

        return JSONResponse(
            {"ok": True},
            headers={"Content-Security-Policy": "default-src 'none'"},
        )

    return app


class TestSecurityHeadersMiddleware:
    def test_default_headers_present(self):
        client = TestClient(_make_secure_app())
        resp = client.get("/ping")
        assert resp.status_code == 200
        assert resp.headers["X-Content-Type-Options"] == "nosniff"
        assert resp.headers["X-Frame-Options"] == "DENY"
        assert resp.headers["Referrer-Policy"] == "no-referrer"
        assert "geolocation=()" in resp.headers["Permissions-Policy"]
        assert resp.headers["Cross-Origin-Opener-Policy"] == "same-origin"
        assert resp.headers["Cross-Origin-Resource-Policy"] == "cross-origin"
        assert "default-src 'self'" in resp.headers["Content-Security-Policy"]
        assert "frame-ancestors 'none'" in resp.headers["Content-Security-Policy"]

    def test_hsts_disabled_by_default(self):
        client = TestClient(_make_secure_app())
        resp = client.get("/ping")
        assert "Strict-Transport-Security" not in resp.headers

    def test_hsts_enabled_on_request(self):
        client = TestClient(_make_secure_app(enable_hsts=True))
        resp = client.get("/ping")
        assert resp.headers["Strict-Transport-Security"].startswith("max-age=")
        assert "includeSubDomains" in resp.headers["Strict-Transport-Security"]

    def test_extra_headers_override_defaults(self):
        client = TestClient(
            _make_secure_app(extra_headers={"Referrer-Policy": "same-origin"})
        )
        resp = client.get("/ping")
        assert resp.headers["Referrer-Policy"] == "same-origin"

    def test_extra_headers_empty_string_removes_default(self):
        client = TestClient(_make_secure_app(extra_headers={"X-Frame-Options": ""}))
        resp = client.get("/ping")
        assert "X-Frame-Options" not in resp.headers
        # Other defaults still there.
        assert resp.headers["X-Content-Type-Options"] == "nosniff"

    def test_route_set_header_is_not_overwritten(self):
        """If the route already sets CSP, middleware must not clobber it."""
        client = TestClient(_make_secure_app())
        resp = client.get("/custom-csp")
        assert resp.headers["Content-Security-Policy"] == "default-src 'none'"
        # But other defaults still attached.
        assert resp.headers["X-Content-Type-Options"] == "nosniff"
