"""Custom ASGI middlewares for OpenAgentd.

Add to the FastAPI app via ``app.add_middleware(...)`` in the application factory.

Usage::

    from app.core.middlewares import RequestSizeLimitMiddleware, SecurityHeadersMiddleware

    app.add_middleware(SecurityHeadersMiddleware)
    app.add_middleware(RequestSizeLimitMiddleware, max_bytes=4 * 1024 * 1024)
"""

from __future__ import annotations

from fastapi.responses import JSONResponse
from loguru import logger
from starlette.types import ASGIApp, Message, Receive, Scope, Send

# Default: 4 MB
_DEFAULT_MAX_BYTES = 4 * 1024 * 1024

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
    """Reject requests whose ``Content-Length`` header exceeds ``max_bytes``.

    Returns HTTP 413 before the body is read, guarding against DoS via large
    payloads.  Requests without a ``Content-Length`` header are allowed through
    (chunked / streaming uploads are not blocked here).

    Args:
        app: The ASGI application to wrap.
        max_bytes: Maximum allowed content length in bytes.  Defaults to 4 MB.
    """

    def __init__(self, app: ASGIApp, max_bytes: int = _DEFAULT_MAX_BYTES) -> None:
        self.app = app
        self._max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            headers = dict(scope.get("headers", []))
            content_length_bytes = headers.get(b"content-length")
            if content_length_bytes:
                try:
                    content_length = int(content_length_bytes)
                except ValueError:
                    content_length = 0
                if content_length > self._max_bytes:
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
        await self.app(scope, receive, send)
