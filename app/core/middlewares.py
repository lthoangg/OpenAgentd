"""Custom ASGI middlewares for OpenAgentd.

Add to the FastAPI app via ``app.add_middleware(...)`` in the application factory.

Usage::

    from app.core.middlewares import RequestSizeLimitMiddleware, SecurityHeadersMiddleware

    app.add_middleware(SecurityHeadersMiddleware)
    app.add_middleware(RequestSizeLimitMiddleware, max_bytes=56 * 1024 * 1024)
"""

from __future__ import annotations

from ipaddress import ip_address

from fastapi.responses import JSONResponse
from loguru import logger
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.cli.net import is_loopback_host
from app.core.config import settings
from app.core.desktop_auth import configured_access_token

# Default: 56 MB — the outer envelope, deliberately above the 50 MB
# attachment ceiling (``GLOBAL_SIZE_LIMIT`` in
# ``app/services/agent_service.py``). A message at the attachment limit still
# carries its text, mentions, and multipart framing in the same body, so a
# cap equal to the payload limit would reject a legal upload here — with a
# blunt "Request body too large" instead of the attachment layer's precise,
# per-file message.
_DEFAULT_MAX_BYTES = 56 * 1024 * 1024


class _RequestTooLarge(Exception):
    """Raised by the receive wrapper once a streaming body exceeds its limit."""


class NetworkBindGuard:
    """Reject unauthenticated requests accepted on non-loopback listeners."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        has_auth: bool | None = None,
        allow_insecure: bool | None = None,
    ) -> None:
        self.app = app
        self._has_auth = (
            bool(configured_access_token()) if has_auth is None else has_auth
        )
        self._allow_insecure = (
            settings.API_ALLOW_INSECURE_LAN
            if allow_insecure is None
            else allow_insecure
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] not in ("http", "websocket")
            or self._has_auth
            or self._allow_insecure
        ):
            await self.app(scope, receive, send)
            return

        server = scope.get("server")
        host = server[0] if server else None
        if host is None or is_loopback_host(host):
            await self.app(scope, receive, send)
            return
        try:
            ip_address(host)
        except ValueError:
            # ASGI test transports and Unix-socket deployments may expose a
            # synthetic server name rather than a listener IP. Uvicorn TCP
            # scopes provide the concrete local address, which is the boundary
            # this guard is responsible for enforcing.
            await self.app(scope, receive, send)
            return

        logger.error("non_loopback_bind_rejected host={}", host)
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 4403})
            return
        response = JSONResponse(
            status_code=503,
            content={"detail": "Non-loopback binding requires an access key."},
        )
        await response(scope, receive, send)


# ── Security headers ─────────────────────────────────────────────────────────
# openagentd is an on-machine single-owner app.  The bundled web UI is served
# as static assets from the same origin, so a strict same-origin CSP is
# sufficient and no third-party embedding is expected.
#
# - `connect-src` allows ws:/wss: for future SSE fallback clients; SSE itself
#   uses plain HTTP which is already covered by `default-src 'self'`.
# - `style-src` allows `'unsafe-inline'` because Vite injects critical CSS and
#   Tailwind's JIT occasionally emits inline styles.  A stricter nonce-based
#   policy would require rewriting index.html at request time.
# - `img-src` allows `data:` and `blob:` for user-uploaded previews and
#   assistant-rendered canvases.
# - `object-src 'none'` and `frame-ancestors 'none'`: nothing in the app uses
#   `<object>`/`<embed>` or needs to be framed. PDF previews render via
#   pdf.js to `<canvas>` (see `web/src/lib/pdfjs-loader.ts`) specifically so
#   we never need to relax either of these — native `<embed
#   type="application/pdf">` was tried first and required loosening this
#   policy (plus didn't work on iOS/Android, which have no PDF plugin to
#   embed at all), so canvas rendering is strictly better here.
_DEFAULT_CSP = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; "
    "font-src 'self' data:; "
    "connect-src 'self' ws: wss:; "
    "media-src 'self' blob:; "
    "object-src 'none'; "
    "base-uri 'self'; "
    "frame-ancestors 'none'; "
    "form-action 'self'"
)

_DEFAULT_SECURITY_HEADERS: dict[str, str] = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "geolocation=(), camera=(), microphone=(), payment=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Content-Security-Policy": _DEFAULT_CSP,
}


class SecurityHeadersMiddleware:
    """Attach defensive security headers to every response.

    Defaults are tuned for a same-origin, on-machine SPA + API.  HSTS is
    enabled only when ``enable_hsts=True`` because forcing HTTPS on a loopback
    install (``http://localhost:4082``) would make the site unreachable.

    Callers can override any individual header by passing ``extra_headers`` —
    values there win over the defaults.  Pass an empty string as the value to
    remove a default header entirely.

    Args:
        app: The ASGI application to wrap.
        extra_headers: Header overrides / additions.  Keys are
            case-insensitive; values take precedence over defaults.
        enable_hsts: If ``True``, adds a 1-year ``Strict-Transport-Security``
            header with ``includeSubDomains``.  Only enable behind TLS.
    """

    def __init__(
        self,
        app: ASGIApp,
        *,
        extra_headers: dict[str, str] | None = None,
        enable_hsts: bool = False,
    ) -> None:
        self.app = app
        headers = dict(_DEFAULT_SECURITY_HEADERS)
        if enable_hsts:
            headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        if extra_headers:
            for k, v in extra_headers.items():
                headers[k] = v
        # Drop keys explicitly cleared by caller (empty string value).
        self._headers = {k: v for k, v in headers.items() if v != ""}

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                existing_headers = {name.lower() for name, _ in headers}
                for name, value in self._headers.items():
                    name_bytes = name.encode("latin-1")
                    if name_bytes.lower() not in existing_headers:
                        headers.append((name_bytes, value.encode("latin-1")))
                message["headers"] = headers
            await send(message)

        await self.app(scope, receive, send_wrapper)


class RequestSizeLimitMiddleware:
    """Reject requests whose actual body exceeds ``max_bytes``.

    A declared oversized ``Content-Length`` is rejected before the body is read.
    All other HTTP request bodies, including chunked uploads and malformed or
    negative ``Content-Length`` values, are counted while they are received.

    Args:
        app: The ASGI application to wrap.
        max_bytes: Maximum allowed content length in bytes.  Defaults to 56 MB.
    """

    def __init__(self, app: ASGIApp, max_bytes: int = _DEFAULT_MAX_BYTES) -> None:
        self.app = app
        self._max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            headers = dict(scope.get("headers", []))
            content_length_bytes = headers.get(b"content-length")
            if content_length_bytes is not None:
                try:
                    content_length = int(content_length_bytes)
                except ValueError:
                    content_length = None
                if content_length is not None and content_length > self._max_bytes:
                    logger.warning(
                        "request_too_large content_length={} limit={}",
                        content_length,
                        self._max_bytes,
                    )
                    response = JSONResponse(
                        status_code=413,
                        content={"detail": "Request body too large."},
                    )
                    await response(scope, receive, send)
                    return

            received_bytes = 0
            request_complete = False
            buffered_requests: list[Message] = []

            async def consume_request() -> None:
                nonlocal received_bytes, request_complete
                while not request_complete:
                    message = await receive()
                    buffered_requests.append(message)
                    if message["type"] == "http.request":
                        received_bytes += len(message.get("body", b""))
                        if received_bytes > self._max_bytes:
                            raise _RequestTooLarge
                        request_complete = not message.get("more_body", False)
                    elif message["type"] == "http.disconnect":
                        request_complete = True

            async def send_wrapper(message: Message) -> None:
                # An app may send a response before it reads its body. Drain and
                # validate it first, so a late 413 never follows another start.
                if not request_complete:
                    await consume_request()
                await send(message)

            async def receive_wrapper() -> Message:
                nonlocal received_bytes, request_complete
                if buffered_requests:
                    return buffered_requests.pop(0)
                message = await receive()
                if message["type"] == "http.request":
                    received_bytes += len(message.get("body", b""))
                    if received_bytes > self._max_bytes:
                        raise _RequestTooLarge
                    request_complete = not message.get("more_body", False)
                elif message["type"] == "http.disconnect":
                    request_complete = True
                return message

            try:
                await self.app(scope, receive_wrapper, send_wrapper)
            except _RequestTooLarge:
                logger.warning(
                    "request_too_large received_bytes={} limit={}",
                    received_bytes,
                    self._max_bytes,
                )
                response = JSONResponse(
                    status_code=413,
                    content={"detail": "Request body too large."},
                )
                await response(scope, receive, send)
            return
        await self.app(scope, receive, send)
