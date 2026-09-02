"""OpenAI Codex OAuth login — PKCE browser flow and device-code headless flow.

Credentials live in ``{CACHE_DIR}/codex_oauth.json``.

Called by ``app.cli.commands.auth`` central dispatcher::

    openagentd auth codex           # opens browser (PKCE)
    openagentd auth codex --device  # headless device-code flow

Ported from opencode's codex.ts plugin (anomalyco/opencode).
"""

from __future__ import annotations

import json
import secrets
import sys
import time
import urllib.parse
import webbrowser
from base64 import urlsafe_b64encode
from collections.abc import Callable
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Event, Lock, Thread
from typing import Any

import httpx
from pydantic import BaseModel, SecretStr

from app.core.secret_files import write_secret_file
from app.core.version import VERSION

# -- Constants ----------------------------------------------------------------

CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
ISSUER = "https://auth.openai.com"
OAUTH_PORT = 1455
_USER_AGENT = f"openagentd/{VERSION}"
CODEX_ORIGINATOR = "openagentd"
_REFRESH_LOCK = Lock()


# Mirrors app.agent.providers.copilot.oauth.EventSink — kept duplicated
# rather than imported because they're independent flows that happen to
# share a callback shape.
EventSink = Callable[[str, dict[str, Any]], None]


def _say(event_sink: EventSink | None, event: str, message: str, **data: Any) -> None:
    """Dual stdout/event-sink emitter — see copilot/oauth.py._say."""
    if event_sink is None:
        print(message)
        return
    payload = {"message": message, **data}
    event_sink(event, payload)


# -- Persistence --------------------------------------------------------------


def _default_oauth_file() -> Path:
    from app.core.config import settings

    return Path(settings.OPENAGENTD_CACHE_DIR) / "codex_oauth.json"


class CodexOAuth(BaseModel):
    """Persisted OpenAI Codex OAuth credentials."""

    access_token: SecretStr
    refresh_token: SecretStr
    expires_at: float  # unix timestamp
    account_id: str | None = None

    @classmethod
    def load(cls, path: Path | None = None) -> CodexOAuth | None:
        p = path or _default_oauth_file()
        if not p.exists():
            return None
        try:
            return cls.model_validate_json(p.read_text())
        except Exception:
            return None

    def save(self, path: Path | None = None) -> None:
        p = path or _default_oauth_file()
        data = {
            "access_token": self.access_token.get_secret_value(),
            "refresh_token": self.refresh_token.get_secret_value(),
            "expires_at": self.expires_at,
            "account_id": self.account_id,
        }
        write_secret_file(p, json.dumps(data, indent=2) + "\n")

    def is_expired(self) -> bool:
        return time.time() >= self.expires_at - 60  # 60s buffer

    def refresh(self, path: Path | None = None) -> CodexOAuth:
        """Exchange refresh_token for a new access_token and persist it.

        Refresh tokens can rotate.  If concurrent requests all notice expiry at
        once, only the first should call the token endpoint; later callers reuse
        the fresh credentials written by the first refresh.
        """
        p = path or _default_oauth_file()
        with _REFRESH_LOCK:
            current = CodexOAuth.load(p)
            if current and not current.is_expired():
                return current

            source = current or self
            tokens = _refresh_access_token(source.refresh_token.get_secret_value())
            new = CodexOAuth(
                access_token=SecretStr(tokens["access_token"]),
                refresh_token=SecretStr(
                    tokens.get("refresh_token")
                    or source.refresh_token.get_secret_value()
                ),
                expires_at=time.time() + tokens.get("expires_in", 3600),
                account_id=_extract_account_id(tokens) or source.account_id,
            )
            new.save(p)
            return new


# -- PKCE helpers -------------------------------------------------------------


def _generate_verifier() -> str:
    chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
    return "".join(chars[b % len(chars)] for b in secrets.token_bytes(43))


def _challenge(verifier: str) -> str:
    digest = sha256(verifier.encode()).digest()
    return urlsafe_b64encode(digest).rstrip(b"=").decode()


def _state() -> str:
    return urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()


def _authorize_url(redirect_uri: str, verifier: str, state: str) -> str:
    # Mirrors upstream codex-rs/login/src/server.rs::build_authorize_url.
    params = urllib.parse.urlencode(
        {
            "response_type": "code",
            "client_id": CLIENT_ID,
            "redirect_uri": redirect_uri,
            "scope": (
                "openid profile email offline_access"
                " api.connectors.read api.connectors.invoke"
            ),
            "code_challenge": _challenge(verifier),
            "code_challenge_method": "S256",
            "id_token_add_organizations": "true",
            "codex_cli_simplified_flow": "true",
            "state": state,
            "originator": CODEX_ORIGINATOR,
        }
    )
    return f"{ISSUER}/oauth/authorize?{params}"


# -- Token exchange -----------------------------------------------------------


def _exchange_code(code: str, redirect_uri: str, verifier: str) -> dict[str, Any]:
    r = httpx.post(
        f"{ISSUER}/oauth/token",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        content=urllib.parse.urlencode(
            {
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri,
                "client_id": CLIENT_ID,
                "code_verifier": verifier,
            }
        ).encode(),
        timeout=30.0,
    )
    r.raise_for_status()
    return r.json()


def _refresh_access_token(refresh_token: str) -> dict[str, Any]:
    r = httpx.post(
        f"{ISSUER}/oauth/token",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        content=urllib.parse.urlencode(
            {
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
                "client_id": CLIENT_ID,
            }
        ).encode(),
        timeout=30.0,
    )
    r.raise_for_status()
    return r.json()


def _extract_account_id(tokens: dict[str, Any]) -> str | None:
    import base64

    for key in ("id_token", "access_token"):
        token = tokens.get(key)
        if not token:
            continue
        parts = token.split(".")
        if len(parts) != 3:
            continue
        try:
            padding = 4 - len(parts[1]) % 4
            payload = json.loads(
                base64.urlsafe_b64decode(parts[1] + "=" * padding).decode()
            )
            account_id = (
                payload.get("chatgpt_account_id")
                or (payload.get("https://api.openai.com/auth") or {}).get(
                    "chatgpt_account_id"
                )
                or (payload.get("organizations") or [{}])[0].get("id")
            )
            if account_id:
                return account_id
        except Exception:
            continue
    return None


# -- PKCE browser flow --------------------------------------------------------


def _pkce_login(
    oauth_path: Path | None = None, *, event_sink: EventSink | None = None
) -> None:
    """Full PKCE browser-based login flow."""
    oauth_path = oauth_path or _default_oauth_file()
    redirect_uri = f"http://localhost:{OAUTH_PORT}/auth/callback"
    verifier = _generate_verifier()
    state = _state()
    auth_url = _authorize_url(redirect_uri, verifier, state)

    result: dict[str, Any] = {}
    done = Event()

    class _Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:  # suppress server logs
            pass

        def do_GET(self) -> None:
            parsed = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qs(parsed.query)

            if parsed.path != "/auth/callback":
                self.send_response(404)
                self.end_headers()
                return

            if qs.get("error"):
                result["error"] = qs["error"][0]
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(
                    b"<h1>Authorization failed</h1><p>You can close this window.</p>"
                )
                done.set()
                return

            code = (qs.get("code") or [None])[0]
            got_state = (qs.get("state") or [None])[0]
            if not code or got_state != state:
                result["error"] = "invalid_state_or_missing_code"
                self.send_response(400)
                self.end_headers()
                done.set()
                return

            result["code"] = code
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(
                b"<h1>Authorization successful</h1><p>You can close this window and return to the terminal.</p>"
                b"<script>setTimeout(()=>window.close(),2000)</script>"
            )
            done.set()

    server = HTTPServer(("localhost", OAUTH_PORT), _Handler)
    Thread(target=server.serve_forever, daemon=True).start()

    _say(
        event_sink,
        "browser_auth",
        f"Opening browser for authorization: {auth_url}",
        verification_uri=auth_url,
    )
    if event_sink is None:
        webbrowser.open(auth_url)

    if not done.wait(timeout=300):
        server.shutdown()
        _say(event_sink, "failed", "Timed out waiting for browser authorization.")
        if event_sink is not None:
            raise RuntimeError("Timed out waiting for browser authorization.")
        sys.exit(1)

    server.shutdown()

    if result.get("error"):
        _say(event_sink, "failed", f"Authorization failed: {result['error']}")
        if event_sink is not None:
            raise RuntimeError(f"Authorization failed: {result['error']}")
        sys.exit(1)

    tokens = _exchange_code(result["code"], redirect_uri, verifier)
    _save_tokens(tokens, oauth_path, event_sink=event_sink)


# -- Device-code headless flow ------------------------------------------------


def _device_login(
    oauth_path: Path | None = None, *, event_sink: EventSink | None = None
) -> None:
    """Headless device-code flow (no browser required on this machine)."""
    oauth_path = oauth_path or _default_oauth_file()

    r = httpx.post(
        f"{ISSUER}/api/accounts/deviceauth/usercode",
        headers={
            "Content-Type": "application/json",
            "User-Agent": _USER_AGENT,
        },
        json={"client_id": CLIENT_ID},
        timeout=30.0,
    )
    try:
        r.raise_for_status()
    except httpx.HTTPStatusError as exc:
        if event_sink is not None and exc.response.status_code == 403:
            _pkce_login(oauth_path, event_sink=event_sink)
            return
        raise
    device_data = r.json()

    device_auth_id: str = device_data["device_auth_id"]
    user_code: str = device_data["user_code"]
    interval: int = max(int(device_data.get("interval", 5)), 1)

    verification_uri = f"{ISSUER}/codex/device"
    _say(
        event_sink,
        "device_code",
        f"Open: {verification_uri}  Code: {user_code}",
        verification_uri=verification_uri,
        user_code=user_code,
    )
    _say(event_sink, "polling_started", "Polling for authorization...")

    started = time.time()
    while True:
        time.sleep(interval + 3)  # +3s safety margin
        if event_sink is not None:
            _say(
                event_sink,
                "polling",
                f"Waiting for authorization… {int(time.time() - started)}s",
                elapsed_s=int(time.time() - started),
            )
        poll = httpx.post(
            f"{ISSUER}/api/accounts/deviceauth/token",
            headers={
                "Content-Type": "application/json",
                "User-Agent": _USER_AGENT,
            },
            json={"device_auth_id": device_auth_id, "user_code": user_code},
            timeout=30.0,
        )

        if poll.status_code == 200:
            data = poll.json()
            # Exchange the authorization_code returned by device poll
            token_r = httpx.post(
                f"{ISSUER}/oauth/token",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                content=urllib.parse.urlencode(
                    {
                        "grant_type": "authorization_code",
                        "code": data["authorization_code"],
                        "redirect_uri": f"{ISSUER}/deviceauth/callback",
                        "client_id": CLIENT_ID,
                        "code_verifier": data["code_verifier"],
                    }
                ).encode(),
                timeout=30.0,
            )
            token_r.raise_for_status()
            _save_tokens(token_r.json(), oauth_path, event_sink=event_sink)
            return

        if poll.status_code not in (403, 404):
            msg = f"Unexpected poll response: {poll.status_code}"
            _say(event_sink, "failed", msg, status=poll.status_code)
            if event_sink is not None:
                raise RuntimeError(msg)
            sys.exit(1)
        # 403/404 → still pending, keep polling


def _save_tokens(
    tokens: dict[str, Any],
    oauth_path: Path,
    *,
    event_sink: EventSink | None = None,
) -> None:
    account_id = _extract_account_id(tokens)
    oauth = CodexOAuth(
        access_token=SecretStr(tokens["access_token"]),
        refresh_token=SecretStr(tokens["refresh_token"]),
        expires_at=time.time() + tokens.get("expires_in", 3600),
        account_id=account_id,
    )
    oauth.save(oauth_path)
    suffix = f" (account: {account_id})" if account_id else ""
    _say(
        event_sink,
        "success",
        f"Saved to {oauth_path}{suffix}. Use model: codex:gpt-5.4",
        oauth_path=str(oauth_path),
        account_id=account_id or "",
        suggested_model="codex:gpt-5.4",
    )


# -- Public login function ----------------------------------------------------


def login(
    oauth_path: Path | None = None,
    *,
    device: bool = False,
    browser: bool = False,
    event_sink: EventSink | None = None,
) -> None:
    """Run the OpenAI Codex OAuth login.

    When ``event_sink`` is provided, the device-code flow is always used —
    PKCE requires a local HTTP callback that the SSE-driven UI can't
    consume directly. The ``device`` argument is ignored in that case.
    """
    oauth_path = oauth_path or _default_oauth_file()

    _say(event_sink, "started", "=== OpenAI Codex OAuth Login ===")

    existing = CodexOAuth.load(oauth_path)
    if existing and not existing.is_expired():
        _say(
            event_sink,
            "success",
            f"Valid token found in {oauth_path}",
            already_authenticated=True,
        )
        return
    if existing and existing.is_expired():
        _say(event_sink, "refreshing", "Token expired. Refreshing...")
        try:
            existing.refresh(oauth_path)
            _say(event_sink, "success", "Token refreshed successfully.")
            return
        except Exception as e:
            _say(
                event_sink,
                "refresh_failed",
                f"Refresh failed ({e}), re-authenticating...",
                detail=str(e),
            )

    if browser:
        _pkce_login(oauth_path, event_sink=event_sink)
        return

    # SSE flow defaults to device path, with browser PKCE available as an
    # explicit fallback for workspaces that block device-code auth in-page.
    use_device = device or event_sink is not None
    if use_device:
        # Pass ``event_sink`` only when set so the CLI call signature
        # exactly matches the existing tests (``_device_login(path)``).
        if event_sink is None:
            _device_login(oauth_path)
        else:
            _device_login(oauth_path, event_sink=event_sink)
    else:
        _pkce_login(oauth_path)
