"""Desktop session token authentication.

When the server is launched by the Tauri desktop shell, it is bound to
``127.0.0.1`` on an ephemeral port. Any other local process on the same
machine could otherwise reach the API. To prevent that, the shell
generates a random token per launch and passes it via the
``OPENAGENTD_DESKTOP_TOKEN`` environment variable.

When that env var is set, this middleware rejects any request whose
``Authorization: Bearer <token>`` header (or ``?_token=`` query param,
for raw browser navigations and ``<a download>`` links) does not match.

WebSocket upgrades on ``/api/*`` are held to the same rule. Browsers
cannot attach an ``Authorization`` header to the WS handshake, so the
``?_token=`` query-param fallback is the supported client mechanism
(non-browser clients may still use the Bearer header). Rejected
upgrades are closed before ``accept()`` — Starlette then responds with
HTTP 403 to the handshake.

When the env var is **not** set, the middleware is a no-op. CLI/server
users (``openagentd start``, etc.) keep the existing open-loopback
behaviour. This makes the desktop tier strictly opt-in.

Routes exempted from the check:

- ``/api/health/live``  — orchestrator probes need to work without auth.
- ``/api/health/ready`` — same.
- ``/metrics``          — Prometheus scrape target.
- ``/`` and SPA static assets — the bundled web UI needs to load *before*
  it can read the token and put it in its fetch headers.

The web UI receives the token via a script tag injected by the Tauri
shell into ``index.html`` (``window.__OAD_TOKEN__``) — see
``desktop/src-tauri`` for the injection logic.
"""

from __future__ import annotations

import hmac
import os

from fastapi import Request
from app.core.runtime_settings import load_runtime_settings
from fastapi.responses import JSONResponse
from loguru import logger
from starlette.types import ASGIApp, Receive, Scope, Send


_ENV_VAR = "OPENAGENTD_DESKTOP_TOKEN"
_ACCESS_KEY_ENV_VAR = "OPENAGENTD_ACCESS_KEY"

# Exact paths that never require auth. Entries are matched literally —
# **not** as prefixes — so ``/metrics-evil`` cannot impersonate
# ``/metrics``.
_EXEMPT_EXACT: frozenset[str] = frozenset(
    {
        "/metrics",
        "/api/health/live",
        "/api/health/ready",
        # SPA shell entry points the UI may navigate to before it's
        # had a chance to read the token.
        "/",
        "/index.html",
        "/favicon.ico",
        "/favicon.svg",
        "/vite.svg",
        "/robots.txt",
        "/manifest.json",
    }
)

# Prefixes that *do* require a trailing slash to match. Anything matching
# one of these is treated as a static asset / sub-resource of a
# whitelisted directory.
_EXEMPT_PREFIXES: tuple[str, ...] = (
    "/api/health/",  # /api/health/<anything> — orchestrator probes
    "/assets/",  # vite-built JS/CSS chunks
    "/static/",  # legacy static dir, if any
)

# Query-string param name used by `<a download>` links that can't carry
# an Authorization header. We strip this *after* extraction so downstream
# middleware (access logs, metrics) don't see the secret.
_QS_TOKEN_PARAM = "_token"


def configured_access_token() -> str:
    """Return the configured bearer credential, if any."""
    return (
        os.environ.get(_ENV_VAR, "")
        or os.environ.get(_ACCESS_KEY_ENV_VAR, "")
        or (load_runtime_settings().server.access_key or "")
    )


def _path_is_api(path: str) -> bool:
    return path == "/api" or path.startswith("/api/")


def _path_is_exempt(path: str) -> bool:
    if path in _EXEMPT_EXACT:
        return True
    if any(path.startswith(p) for p in _EXEMPT_PREFIXES):
        return True
    # Non-API paths are SPA shell routes — let them through; the UI will
    # then attach the token to its API/SSE calls.
    return not _path_is_api(path)


def _extract_token_from_scope(scope: Scope) -> str | None:
    """Scope-level token extraction — works for both http and websocket.

    Checks the ``Authorization: Bearer`` header first, then the
    ``?_token=`` query-string fallback (the only mechanism browsers
    support on a WebSocket handshake).
    """
    for name, value in scope.get("headers", []):
        if name == b"authorization":
            scheme, _, token = value.decode("latin-1").partition(" ")
            if scheme.lower() == "bearer" and token:
                return token.strip()
            break
    raw_qs = (scope.get("query_string") or b"").decode("latin-1")
    if raw_qs and _QS_TOKEN_PARAM in raw_qs:
        from urllib.parse import parse_qsl

        for k, v in parse_qsl(raw_qs, keep_blank_values=True):
            if k == _QS_TOKEN_PARAM and v:
                return v
    return None


def _strip_token_from_raw_scope(scope: Scope) -> None:
    """Remove ``?_token=…`` from a raw ASGI scope (http or websocket)."""
    raw = scope.get("query_string") or b""
    if not raw or _QS_TOKEN_PARAM.encode() not in raw:
        return
    from urllib.parse import parse_qsl, urlencode

    kept = [
        (k, v)
        for k, v in parse_qsl(raw.decode("latin-1"), keep_blank_values=True)
        if k != _QS_TOKEN_PARAM
    ]
    scope["query_string"] = urlencode(kept).encode("latin-1")


def _extract_token(request: Request) -> str | None:
    auth = request.headers.get("authorization")
    if auth:
        scheme, _, value = auth.partition(" ")
        if scheme.lower() == "bearer" and value:
            return value.strip()
    # Query-string fallback for things browsers cannot send custom
    # headers with: ``<a href="/api/...?_token=...">`` downloads, embedded
    # ``<img src>`` previews, etc.
    qs_token = request.query_params.get(_QS_TOKEN_PARAM)
    if qs_token:
        return qs_token
    return None


def _strip_token_from_scope(request: Request) -> None:
    """Remove ``?_token=…`` from the scope so downstream middleware can't log it.

    Starlette stores the raw query string as bytes in ``scope["query_string"]``
    and the parsed mapping in ``scope["query_params"]`` is lazily derived
    from it. Rewriting the bytes is sufficient — any downstream code that
    re-parses sees the cleaned version.
    """
    raw = request.scope.get("query_string") or b""
    if not raw or _QS_TOKEN_PARAM.encode() not in raw:
        return
    from urllib.parse import parse_qsl, urlencode

    kept = [
        (k, v)
        for k, v in parse_qsl(raw.decode("latin-1"), keep_blank_values=True)
        if k != _QS_TOKEN_PARAM
    ]
    request.scope["query_string"] = urlencode(kept).encode("latin-1")


class DesktopTokenMiddleware:
    """Reject unauthenticated API requests when a desktop token is configured.

    The expected token is read **once** at construction time so a leaked
    env var on a child process cannot bypass the check later, and so
    middleware behaviour is stable for the lifetime of the server.
    """

    def __init__(self, app: ASGIApp, *, expected_token: str | None = None) -> None:
        self.app = app
        self._token = (
            expected_token if expected_token is not None else configured_access_token()
        )
        self._enabled = bool(self._token)
        if self._enabled:
            logger.info("desktop_token_auth_enabled token_len={}", len(self._token))

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if not self._enabled or scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        if scope["type"] == "websocket":
            await self._handle_websocket(scope, receive, send)
            return

        request = Request(scope, receive)
        path = request.url.path
        if _path_is_exempt(path):
            await self.app(scope, receive, send)
            return

        token = _extract_token(request)
        if not token or not hmac.compare_digest(token, self._token):
            logger.warning(
                "desktop_token_rejected path={} has_token={}",
                path,
                bool(token),
            )
            response = JSONResponse(
                status_code=401,
                content={"detail": "Unauthorized — OpenAgentd access key required."},
            )
            await response(scope, receive, send)
            return

        # Scrub the QS-param token so it never reaches access logs,
        # metrics, or downstream handlers (which can log full URLs).
        _strip_token_from_scope(request)
        await self.app(scope, receive, send)

    async def _handle_websocket(
        self, scope: Scope, receive: Receive, send: Send
    ) -> None:
        """Enforce the token on WebSocket upgrades to /api/*.

        Non-API WS paths don't exist in this app; they still require the
        token (fail closed) rather than inheriting the SPA-route
        exemption, which exists only so index.html can bootstrap.
        """
        path = scope.get("path", "")
        if not _path_is_api(path):
            # Fail closed: no non-API WS surface is expected; reject
            # rather than allow an unauthenticated side channel.
            await send({"type": "websocket.close", "code": 4401})
            return

        token = _extract_token_from_scope(scope)
        if not token or not hmac.compare_digest(token, self._token):
            logger.warning(
                "desktop_token_rejected_ws path={} has_token={}",
                path,
                bool(token),
            )
            # Closing before accept → Starlette sends HTTP 403 on the
            # handshake; browsers see a failed connection.
            await send({"type": "websocket.close", "code": 4401})
            return

        _strip_token_from_raw_scope(scope)
        await self.app(scope, receive, send)
