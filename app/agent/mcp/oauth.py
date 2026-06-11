from __future__ import annotations

import asyncio
import json
import os
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Event, Thread
from typing import Any

import httpx
from loguru import logger
from mcp.client.auth import OAuthClientProvider
from mcp.shared.auth import OAuthClientInformationFull, OAuthClientMetadata, OAuthToken

from app.agent.mcp.config import HttpServerConfig, resolve_secret_refs
from app.core.config import settings


class OAuthRequiredError(RuntimeError):
    """Raised when an MCP server needs explicit OAuth connection."""


_interactive_oauth: set[str] = set()


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


def has_resolved_client_id(cfg: HttpServerConfig) -> bool:
    oauth = cfg.oauth
    if not oauth or not oauth.client_id:
        return False
    client_id = resolve_secret_refs(oauth.client_id)
    return bool(client_id and not _unresolved_secret_ref(oauth.client_id, client_id))


async def supports_dynamic_client_registration(cfg: HttpServerConfig) -> bool:
    origin = urllib.parse.urlunparse(
        urllib.parse.urlparse(cfg.url)._replace(
            path="", params="", query="", fragment=""
        )
    )
    metadata_url = f"{origin.rstrip('/')}/.well-known/oauth-authorization-server"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(metadata_url)
        if response.status_code != 200:
            return False
        metadata = response.json()
    except Exception:
        return False
    return bool(
        metadata.get("registration_endpoint")
        or metadata.get("client_id_metadata_document_supported")
    )


class LoopbackCallback:
    PATH = "/oauth/callback"

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

    async def wait(self) -> tuple[str, str | None]:
        thread = Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        try:
            ok = await asyncio.to_thread(self.done.wait, 300)
            if not ok:
                raise TimeoutError("Timed out waiting for OAuth callback.")
            if error := self.result.get("error"):
                raise RuntimeError(f"OAuth failed: {error}")
            return self.result.get("code", ""), self.result.get("state") or None
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
            raise RuntimeError(
                f"MCP server '{name}' needs OAuth. Use Settings -> MCP -> Connect OAuth."
            )
        logger.info("mcp_oauth_authorize name={} url={}", name, url)
        try:
            webbrowser.open(url)
        except Exception as exc:
            logger.warning("mcp_oauth_browser_open_failed name={} error={}", name, exc)

    async def callback_handler() -> tuple[str, str | None]:
        return await callback.wait()

    return OAuthClientProvider(
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
