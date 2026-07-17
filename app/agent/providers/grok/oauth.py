"""Grok Build device OAuth and refreshable credential storage."""

from __future__ import annotations

import json
import os
import re
import secrets
import time
from collections.abc import Callable
from pathlib import Path
from threading import Lock
from typing import Any
from urllib.parse import urlparse

import httpx
from pydantic import BaseModel, SecretStr

from app.core.version import VERSION

CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
ISSUER = "https://auth.x.ai"
GROK_BUILD_API_BASE = "https://cli-chat-proxy.grok.com/v1"
DEFAULT_MODEL = "grok-4.5"

_SCOPES = (
    "openid",
    "profile",
    "email",
    "offline_access",
    "grok-cli:access",
    "api:access",
)
_DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code"
_USER_CODE = re.compile(r"[A-Za-z0-9-]+")
_REFRESH_LOCK = Lock()

EventSink = Callable[[str, dict[str, Any]], None]


def _default_oauth_file() -> Path:
    from app.core.config import settings

    return Path(settings.OPENAGENTD_CACHE_DIR) / "grok_oauth.json"


def _say(event_sink: EventSink | None, event: str, message: str, **data: Any) -> None:
    if event_sink is None:
        print(message)
        return
    event_sink(event, {"message": message, **data})


def _client_headers(surface: str) -> dict[str, str]:
    return {
        "x-grok-client-version": VERSION,
        "x-grok-client-surface": surface,
    }


def session_headers(access_token: str, *, model: str | None = None) -> dict[str, str]:
    """Return the session-proxy headers required by Grok Build."""
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        "X-XAI-Token-Auth": "xai-grok-cli",
        "x-authenticateresponse": "authenticate-response",
        "x-grok-client-version": VERSION,
        "x-grok-client-identifier": "openagentd",
        "x-grok-client-mode": "interactive",
    }
    if model:
        headers["x-grok-model-override"] = model
    return headers


class GrokOAuth(BaseModel):
    """Refreshable Grok Build OAuth credential persisted in OpenAgentd's cache."""

    access_token: SecretStr
    refresh_token: SecretStr | None = None
    expires_at: float

    @classmethod
    def load(cls, path: Path | None = None) -> GrokOAuth | None:
        token_path = path or _default_oauth_file()
        try:
            return cls.model_validate_json(token_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def save(self, path: Path | None = None) -> None:
        token_path = path or _default_oauth_file()
        token_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "access_token": self.access_token.get_secret_value(),
            "refresh_token": (
                self.refresh_token.get_secret_value() if self.refresh_token else None
            ),
            "expires_at": self.expires_at,
        }
        tmp_path = token_path.with_name(
            f".{token_path.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp"
        )
        fd = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp_path, token_path)
            os.chmod(token_path, 0o600)
        except BaseException:
            tmp_path.unlink(missing_ok=True)
            raise

    def is_expired(self) -> bool:
        return time.time() >= self.expires_at - 60

    def refresh(self, path: Path | None = None) -> GrokOAuth:
        token_path = path or _default_oauth_file()
        with _REFRESH_LOCK:
            current = GrokOAuth.load(token_path)
            if current is not None and not current.is_expired():
                return current
            source = current or self
            if source.refresh_token is None:
                raise ValueError(
                    "Grok Build OAuth session cannot be refreshed. Reconnect it."
                )
            response = httpx.post(
                f"{ISSUER}/oauth2/token",
                headers={"x-grok-client-version": VERSION},
                data={
                    "grant_type": "refresh_token",
                    "refresh_token": source.refresh_token.get_secret_value(),
                    "client_id": CLIENT_ID,
                },
                timeout=30.0,
            )
            response.raise_for_status()
            data = response.json()
            access_token = data.get("access_token")
            if not isinstance(access_token, str) or not access_token:
                raise ValueError("Grok Build token refresh returned no access token.")
            rotated = data.get("refresh_token")
            refreshed = GrokOAuth(
                access_token=SecretStr(access_token),
                refresh_token=SecretStr(
                    rotated
                    if isinstance(rotated, str) and rotated
                    else source.refresh_token.get_secret_value()
                ),
                expires_at=time.time()
                + _positive_seconds(data.get("expires_in"), 3600),
            )
            refreshed.save(token_path)
            return refreshed


def _positive_seconds(value: object, default: int) -> int:
    if isinstance(value, int) and not isinstance(value, bool) and value > 0:
        return value
    return default


def _validate_verification_uri(uri: str) -> None:
    parsed = urlparse(uri)
    if parsed.scheme == "https" and parsed.hostname in {"accounts.x.ai", "auth.x.ai"}:
        return
    if parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1"}:
        return
    raise ValueError("Grok Build returned an unsafe verification URI.")


def _verify_access(access_token: str) -> None:
    response = httpx.get(
        f"{GROK_BUILD_API_BASE}/models",
        headers=session_headers(access_token),
        timeout=15.0,
    )
    response.raise_for_status()


def _success(
    oauth: GrokOAuth,
    oauth_path: Path,
    event_sink: EventSink | None,
    *,
    already_authenticated: bool = False,
) -> None:
    _say(event_sink, "verifying", "Verifying Grok Build access...")
    try:
        _verify_access(oauth.access_token.get_secret_value())
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code in {401, 403}:
            raise ValueError("Grok Build rejected the saved OAuth session.") from exc
        _say(
            event_sink,
            "warning",
            "Authorization succeeded, but Grok Build could not be verified right now.",
        )
    except httpx.RequestError:
        _say(
            event_sink,
            "warning",
            "Authorization succeeded, but Grok Build could not be verified right now.",
        )
    oauth.save(oauth_path)
    _say(
        event_sink,
        "success",
        f"Grok Build connected. Saved credentials to {oauth_path}.",
        oauth_path=str(oauth_path),
        suggested_model=f"grok:{DEFAULT_MODEL}",
        already_authenticated=already_authenticated,
    )


def login(
    oauth_path: Path | None = None,
    *,
    event_sink: EventSink | None = None,
) -> None:
    """Authenticate a Grok subscription with xAI's RFC 8628 device flow."""
    oauth_path = oauth_path or _default_oauth_file()
    surface = "ui" if event_sink is not None else "cli"
    _say(event_sink, "started", "Starting Grok Build device login...")

    existing = GrokOAuth.load(oauth_path)
    if existing is not None:
        try:
            if existing.is_expired():
                existing = existing.refresh(oauth_path)
            _success(
                existing,
                oauth_path,
                event_sink,
                already_authenticated=True,
            )
            return
        except (httpx.HTTPError, ValueError):
            pass

    try:
        _say(event_sink, "requesting_device_code", "Requesting device code...")
        device_response = httpx.post(
            f"{ISSUER}/oauth2/device/code",
            headers=_client_headers(surface),
            data={
                "client_id": CLIENT_ID,
                "scope": " ".join(_SCOPES),
                "referrer": "openagentd",
            },
            timeout=30.0,
        )
        device_response.raise_for_status()
        device = device_response.json()
        device_code = device.get("device_code")
        user_code = device.get("user_code")
        verification_uri = device.get("verification_uri")
        complete_uri = device.get("verification_uri_complete")
        if not isinstance(device_code, str) or not device_code:
            raise ValueError("Grok Build returned no device code.")
        if not isinstance(user_code, str) or _USER_CODE.fullmatch(user_code) is None:
            raise ValueError("Grok Build returned an invalid user code.")
        if not isinstance(verification_uri, str):
            raise ValueError("Grok Build returned no verification URI.")
        _validate_verification_uri(verification_uri)
        if complete_uri is not None:
            if not isinstance(complete_uri, str):
                raise ValueError("Grok Build returned an invalid verification URI.")
            _validate_verification_uri(complete_uri)
        display_uri = complete_uri or verification_uri
        _say(
            event_sink,
            "device_code",
            f"Open: {display_uri}  Code: {user_code}",
            verification_uri=display_uri,
            user_code=user_code,
            expires_in=_positive_seconds(device.get("expires_in"), 600),
        )

        interval = _positive_seconds(device.get("interval"), 5)
        expires_in = _positive_seconds(device.get("expires_in"), 600)
        started = time.time()
        while time.time() - started < expires_in:
            time.sleep(interval)
            _say(
                event_sink,
                "polling",
                "Waiting for Grok authorization...",
                elapsed_s=int(time.time() - started),
            )
            token_response = httpx.post(
                f"{ISSUER}/oauth2/token",
                headers=_client_headers(surface),
                data={
                    "grant_type": _DEVICE_GRANT_TYPE,
                    "device_code": device_code,
                    "client_id": CLIENT_ID,
                },
                timeout=30.0,
            )
            if token_response.is_success:
                token_data = token_response.json()
                access_token = token_data.get("access_token")
                if not isinstance(access_token, str) or not access_token:
                    raise ValueError("Grok Build returned no access token.")
                refresh_token = token_data.get("refresh_token")
                oauth = GrokOAuth(
                    access_token=SecretStr(access_token),
                    refresh_token=(
                        SecretStr(refresh_token)
                        if isinstance(refresh_token, str) and refresh_token
                        else None
                    ),
                    expires_at=time.time()
                    + _positive_seconds(token_data.get("expires_in"), 3600),
                )
                _say(event_sink, "token_acquired", "Grok Build token received.")
                _success(oauth, oauth_path, event_sink)
                return

            try:
                error_data = token_response.json()
            except ValueError:
                token_response.raise_for_status()
                raise AssertionError("unreachable")
            error = error_data.get("error")
            if error == "authorization_pending":
                continue
            if error == "slow_down":
                interval += 5
                continue
            if error == "access_denied":
                raise ValueError("Grok Build authorization was denied.")
            if error == "expired_token":
                raise ValueError("Grok Build device code expired. Try again.")
            raise ValueError("Grok Build token exchange failed.")
        raise ValueError("Grok Build device code expired. Try again.")
    except Exception as exc:
        _say(event_sink, "failed", str(exc), reason="exception")
        raise
