from __future__ import annotations

import stat
import time

import httpx
import pytest
import respx

from app.agent.providers.grok.oauth import (
    CLIENT_ID,
    ISSUER,
    GrokOAuth,
    _validate_verification_uri,
    login,
)


@respx.mock
def test_device_login_saves_refreshable_credentials_and_emits_ui_events(
    tmp_path, monkeypatch
) -> None:
    oauth_path = tmp_path / "grok_oauth.json"
    events: list[tuple[str, dict[str, object]]] = []
    monkeypatch.setattr(time, "sleep", lambda _seconds: None)

    device_route = respx.post(f"{ISSUER}/oauth2/device/code").mock(
        return_value=httpx.Response(
            200,
            json={
                "device_code": "device-secret",
                "user_code": "ABCD-EFGH",
                "verification_uri": "https://accounts.x.ai/device",
                "verification_uri_complete": "https://accounts.x.ai/device?user_code=ABCD-EFGH",
                "expires_in": 600,
                "interval": 1,
            },
        )
    )
    token_route = respx.post(f"{ISSUER}/oauth2/token").mock(
        return_value=httpx.Response(
            200,
            json={
                "access_token": "session-access-token",
                "refresh_token": "session-refresh-token",
                "expires_in": 3600,
            },
        )
    )
    models_route = respx.get("https://cli-chat-proxy.grok.com/v1/models").mock(
        return_value=httpx.Response(200, json={"data": [{"id": "grok-4.5"}]})
    )

    login(
        oauth_path=oauth_path,
        event_sink=lambda event, data: events.append((event, data)),
    )

    saved = GrokOAuth.load(oauth_path)
    assert saved is not None
    assert saved.access_token.get_secret_value() == "session-access-token"
    assert saved.refresh_token is not None
    assert saved.refresh_token.get_secret_value() == "session-refresh-token"
    assert stat.S_IMODE(oauth_path.stat().st_mode) == 0o600
    assert [event for event, _ in events] == [
        "started",
        "requesting_device_code",
        "device_code",
        "polling",
        "token_acquired",
        "verifying",
        "success",
    ]
    assert events[-1][1]["suggested_model"] == "grok:grok-4.5"

    device_request = device_route.calls[0].request
    assert device_request.headers["x-grok-client-surface"] == "ui"
    assert f"client_id={CLIENT_ID}" in device_request.content.decode()
    assert "grok-cli%3Aaccess" in device_request.content.decode()

    token_request = token_route.calls[0].request
    assert "device_code=device-secret" in token_request.content.decode()
    assert (
        "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code"
        in token_request.content.decode()
    )

    model_request = models_route.calls[0].request
    assert model_request.headers["Authorization"] == "Bearer session-access-token"
    assert model_request.headers["X-XAI-Token-Auth"] == "xai-grok-cli"


@respx.mock
def test_expired_oauth_refreshes_and_rotates_refresh_token(
    tmp_path, monkeypatch
) -> None:
    oauth_path = tmp_path / "grok_oauth.json"
    oauth = GrokOAuth(
        access_token="expired-access",
        refresh_token="old-refresh",
        expires_at=1,
    )
    oauth.save(oauth_path)
    monkeypatch.setattr(time, "time", lambda: 1000)
    route = respx.post(f"{ISSUER}/oauth2/token").mock(
        return_value=httpx.Response(
            200,
            json={
                "access_token": "fresh-access",
                "refresh_token": "fresh-refresh",
                "expires_in": 7200,
            },
        )
    )

    refreshed = oauth.refresh(oauth_path)

    assert refreshed.access_token.get_secret_value() == "fresh-access"
    assert refreshed.refresh_token is not None
    assert refreshed.refresh_token.get_secret_value() == "fresh-refresh"
    assert "refresh_token=old-refresh" in route.calls[0].request.content.decode()
    assert GrokOAuth.load(oauth_path) == refreshed


@respx.mock
def test_device_login_does_not_persist_a_proxy_rejected_session(
    tmp_path, monkeypatch
) -> None:
    oauth_path = tmp_path / "grok_oauth.json"
    events: list[str] = []
    monkeypatch.setattr(time, "sleep", lambda _seconds: None)
    respx.post(f"{ISSUER}/oauth2/device/code").mock(
        return_value=httpx.Response(
            200,
            json={
                "device_code": "device-secret",
                "user_code": "ABCD-EFGH",
                "verification_uri": "https://accounts.x.ai/oauth2/device",
                "expires_in": 600,
                "interval": 1,
            },
        )
    )
    respx.post(f"{ISSUER}/oauth2/token").mock(
        return_value=httpx.Response(
            200,
            json={
                "access_token": "rejected-session-token",
                "refresh_token": "session-refresh-token",
                "expires_in": 3600,
            },
        )
    )
    respx.get("https://cli-chat-proxy.grok.com/v1/models").mock(
        return_value=httpx.Response(401, json={"error": "unauthorized"})
    )

    with pytest.raises(ValueError, match="rejected"):
        login(
            oauth_path=oauth_path,
            event_sink=lambda event, _data: events.append(event),
        )

    assert not oauth_path.exists()
    assert events[-1] == "failed"


def test_verification_uri_rejects_non_https_remote_urls() -> None:
    with pytest.raises(ValueError, match="verification URI"):
        _validate_verification_uri("javascript:alert(1)")
    with pytest.raises(ValueError, match="verification URI"):
        _validate_verification_uri("http://attacker.example/device")
    with pytest.raises(ValueError, match="verification URI"):
        _validate_verification_uri("https://attacker.example/device")

    _validate_verification_uri("https://accounts.x.ai/device")
    _validate_verification_uri("http://127.0.0.1:8080/device")
