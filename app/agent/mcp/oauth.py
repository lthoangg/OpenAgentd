from __future__ import annotations

import asyncio
import json
import os
import urllib.parse
import webbrowser
from collections.abc import AsyncGenerator
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Event, Thread
from typing import Any

import httpx2
from loguru import logger
from mcp.client.auth import OAuthClientProvider
from mcp.shared.auth import (
    AuthorizationCodeResult,
    OAuthClientInformationFull,
    OAuthClientMetadata,
    OAuthToken,
)

from app.agent.mcp.config import HttpServerConfig, resolve_secret_refs
from app.core.config import settings


class OAuthRequiredError(RuntimeError):
    """Raised when an MCP server needs explicit OAuth connection."""


_interactive_oauth: set[str] = set()


def _root_slash_variant(left: str, right: str) -> bool:
    left_url = urllib.parse.urlsplit(left)
    right_url = urllib.parse.urlsplit(right)
    return (
        left != right
        and left_url.path in ("", "/")
        and right_url.path in ("", "/")
        and not left_url.query
        and not left_url.fragment
        and not right_url.query
        and not right_url.fragment
        and left_url._replace(path="") == right_url._replace(path="")
    )


class _CompatibleOAuthClientProvider(OAuthClientProvider):
    """Keep strict issuer validation while tolerating an empty root-path mismatch."""

    async def _normalize_root_issuer(
        self, response: httpx2.Response
    ) -> httpx2.Response:
        expected = self.context.auth_server_url
        request_path = response.request.url.path
        if (
            response.status_code != 200
            or expected is None
            or not (
                "/.well-known/oauth-authorization-server" in request_path
                or "/.well-known/openid-configuration" in request_path
            )
        ):
            return response
        try:
            await response.aread()
            metadata = response.json()
        except (json.JSONDecodeError, UnicodeDecodeError):
            return response
        actual = metadata.get("issuer") if isinstance(metadata, dict) else None
        if not isinstance(actual, str) or not _root_slash_variant(actual, expected):
            return response

        metadata["issuer"] = expected
        headers = dict(response.headers)
        headers.pop("content-length", None)
        logger.debug(
            "mcp_oauth_normalized_root_issuer actual={} expected={}", actual, expected
        )
        return httpx2.Response(
            response.status_code,
            headers=headers,
            json=metadata,
            request=response.request,
            extensions=response.extensions,
        )

    async def async_auth_flow(
        self, request: httpx2.Request
    ) -> AsyncGenerator[httpx2.Request, httpx2.Response]:
        flow = super().async_auth_flow(request)
        try:
            next_request = await anext(flow)
            while True:
                response = yield next_request
                next_request = await flow.asend(
                    await self._normalize_root_issuer(response)
                )
        except StopAsyncIteration:
            return
        finally:
            await flow.aclose()


def _unresolved_secret_ref(raw: str, resolved: str) -> bool:
    return raw.startswith("$") and raw == resolved


def allow_interactive_oauth(name: str) -> None:
    _interactive_oauth.add(name)


def disallow_interactive_oauth(name: str) -> None:
    _interactive_oauth.discard(name)


def interactive_oauth_allowed(name: str) -> bool:
    return name in _interactive_oauth


def has_cached_oauth_tokens(name: str) -> bool:
    path = Path(settings.OPENAGENTD_CACHE_DIR) / "mcp-oauth" / f"{name}.json"
    if not path.is_file():
        return False
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return False
    return bool(data.get("tokens"))


def clear_cached_oauth(name: str) -> None:
    """Remove cached MCP OAuth state for ``name`` if present.

    The MCP SDK persists dynamically registered client information together
    with tokens. That client information includes loopback redirect URIs, which
    can become stale when the desktop sidecar/backend is restarted. An explicit
    reconnect must therefore start from a clean OAuth file rather than reusing
    the old client registration.
    """
    path = Path(settings.OPENAGENTD_CACHE_DIR) / "mcp-oauth" / f"{name}.json"
    try:
        path.unlink()
    except FileNotFoundError:
        return


def has_resolved_client_id(cfg: HttpServerConfig) -> bool:
    oauth = cfg.oauth
    if not oauth or not oauth.client_id:
        return False
    client_id = resolve_secret_refs(oauth.client_id)
    return bool(client_id and not _unresolved_secret_ref(oauth.client_id, client_id))


class LoopbackCallback:
    PATH = "/callback"

    def __init__(self) -> None:
        self.result: dict[str, str] = {}
        self.done = Event()

        callback = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: Any) -> None:
                pass

            def do_GET(self) -> None:
                parsed = urllib.parse.urlparse(self.path)
                qs = urllib.parse.parse_qs(parsed.query)
                if parsed.path != callback.PATH:
                    self.send_response(404)
                    self.end_headers()
                    return

                if qs.get("error"):
                    callback.result["error"] = qs["error"][0]
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html")
                    self.end_headers()
                    self.wfile.write(
                        b"<h1>Authorization failed</h1><p>You can close this window.</p>"
                    )
                    callback.done.set()
                    return

                code = (qs.get("code") or [""])[0]
                state = (qs.get("state") or [""])[0]
                callback.result["code"] = code
                callback.result["state"] = state
                # RFC 9207: the SDK compares this against the AS issuer and
                # rejects a missing value when the server advertised
                # `authorization_response_iss_parameter_supported`.
                if iss := (qs.get("iss") or [""])[0]:
                    callback.result["iss"] = iss
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(
                    b"<h1>Authorization successful</h1><p>You can close this window.</p>"
                    b"<script>setTimeout(()=>window.close(),2000)</script>"
                )
                callback.done.set()

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.redirect_uri = f"http://localhost:{self.server.server_port}{self.PATH}"

    async def wait(self) -> AuthorizationCodeResult:
        thread = Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        try:
            ok = await asyncio.to_thread(self.done.wait, 300)
            if not ok:
                raise TimeoutError("Timed out waiting for OAuth callback.")
            if error := self.result.get("error"):
                raise RuntimeError(f"OAuth failed: {error}")
            return AuthorizationCodeResult(
                code=self.result.get("code", ""),
                state=self.result.get("state") or None,
                iss=self.result.get("iss") or None,
            )
        finally:
            self.server.shutdown()
            self.server.server_close()


class FileTokenStorage:
    def __init__(self, name: str, cfg: HttpServerConfig) -> None:
        self._path = Path(settings.OPENAGENTD_CACHE_DIR) / "mcp-oauth" / f"{name}.json"
        self._cfg = cfg

    async def get_tokens(self) -> OAuthToken | None:
        data = await asyncio.to_thread(self._read)
        raw = data.get("tokens")
        return OAuthToken.model_validate(raw) if raw else None

    async def set_tokens(self, tokens: OAuthToken) -> None:
        data = await asyncio.to_thread(self._read)
        data["tokens"] = tokens.model_dump(mode="json")
        await asyncio.to_thread(self._write, data)

    async def get_client_info(self) -> OAuthClientInformationFull | None:
        data = await asyncio.to_thread(self._read)
        raw = data.get("client_info")
        if raw:
            return OAuthClientInformationFull.model_validate(raw)
        oauth = self._cfg.oauth
        if not oauth or not oauth.client_id:
            return None
        client_id = resolve_secret_refs(oauth.client_id)
        client_secret = (
            resolve_secret_refs(oauth.client_secret) if oauth.client_secret else None
        )
        if not client_id or _unresolved_secret_ref(oauth.client_id, client_id):
            return None
        if (
            oauth.client_secret
            and client_secret
            and _unresolved_secret_ref(oauth.client_secret, client_secret)
        ):
            client_secret = None
        return OAuthClientInformationFull.model_validate(
            {
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uris": None,
                "token_endpoint_auth_method": "client_secret_post"
                if client_secret
                else "none",
            }
        )

    async def set_client_info(self, client_info: OAuthClientInformationFull) -> None:
        data = await asyncio.to_thread(self._read)
        data["client_info"] = client_info.model_dump(mode="json")
        await asyncio.to_thread(self._write, data)

    def _read(self) -> dict[str, object]:
        if not self._path.is_file():
            return {}
        return json.loads(self._path.read_text(encoding="utf-8"))

    def _write(self, data: dict[str, object]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        os.chmod(self._path, 0o600)


def build_oauth_provider(
    name: str, cfg: HttpServerConfig
) -> OAuthClientProvider | None:
    if cfg.oauth is None:
        return None

    callback = LoopbackCallback()

    async def redirect_handler(url: str) -> None:
        if name not in _interactive_oauth:
            raise OAuthRequiredError(
                f"MCP server '{name}' needs OAuth. Use Settings -> MCP -> Connect OAuth."
            )
        logger.info("mcp_oauth_authorize name={} url={}", name, url)
        try:
            webbrowser.open(url)
        except Exception as exc:
            logger.warning("mcp_oauth_browser_open_failed name={} error={}", name, exc)

    async def callback_handler() -> AuthorizationCodeResult:
        return await callback.wait()

    return _CompatibleOAuthClientProvider(
        server_url=cfg.url,
        client_metadata=OAuthClientMetadata.model_validate(
            {
                "redirect_uris": [callback.redirect_uri],
                "token_endpoint_auth_method": "client_secret_post"
                if cfg.oauth.client_secret
                else "none",
                "client_name": "OpenAgentd",
            }
        ),
        storage=FileTokenStorage(name, cfg),
        redirect_handler=redirect_handler,
        callback_handler=callback_handler,
    )
