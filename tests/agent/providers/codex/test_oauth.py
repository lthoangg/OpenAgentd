"""Tests for app/agent/providers/codex/oauth.py — CodexOAuth + token flows."""

from __future__ import annotations

import base64
import json
import stat
import sys
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import MagicMock, patch

import httpx
import pytest
import respx
from pydantic import SecretStr

from app.agent.providers.codex.oauth import (
    CODEX_ORIGINATOR,
    CLIENT_ID,
    ISSUER,
    CodexOAuth,
    _authorize_url,
    _challenge,
    _exchange_code,
    _extract_account_id,
    _generate_verifier,
    _refresh_access_token,
    _save_tokens,
    _state,
    login,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_jwt(payload: dict) -> str:
    """Build a fake JWT (only the payload segment matters here)."""
    header = base64.urlsafe_b64encode(b'{"alg":"none"}').rstrip(b"=").decode()
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
    sig = "sig"
    return f"{header}.{body}.{sig}"


# ---------------------------------------------------------------------------
# CodexOAuth.load
# ---------------------------------------------------------------------------


class TestCodexOAuthLoad:
    def test_missing_file_returns_none(self, tmp_path):
        result = CodexOAuth.load(tmp_path / "nope.json")
        assert result is None

    def test_invalid_json_returns_none(self, tmp_path):
        path = tmp_path / "bad.json"
        path.write_text("not json")
        assert CodexOAuth.load(path) is None

    def test_missing_required_field_returns_none(self, tmp_path):
        path = tmp_path / "incomplete.json"
        path.write_text(
            json.dumps({"access_token": "a"})
        )  # missing refresh_token, expires_at
        assert CodexOAuth.load(path) is None

    def test_valid_file_returns_model(self, tmp_path):
        path = tmp_path / "oauth.json"
        path.write_text(
            json.dumps(
                {
                    "access_token": "at",
                    "refresh_token": "rt",
                    "expires_at": 1234567890.0,
                    "account_id": "acct_1",
                }
            )
        )
        result = CodexOAuth.load(path)
        assert result is not None
        assert result.access_token.get_secret_value() == "at"
        assert result.refresh_token.get_secret_value() == "rt"
        assert result.expires_at == 1234567890.0
        assert result.account_id == "acct_1"


# ---------------------------------------------------------------------------
# CodexOAuth.save
# ---------------------------------------------------------------------------


class TestCodexOAuthSave:
    def test_writes_secrets_in_plaintext(self, tmp_path):
        path = tmp_path / "subdir" / "oauth.json"
        oauth = CodexOAuth(
            access_token=SecretStr("at_value"),
            refresh_token=SecretStr("rt_value"),
            expires_at=999.0,
            account_id="acct_42",
        )
        oauth.save(path)

        assert path.exists()
        data = json.loads(path.read_text())
        assert data["access_token"] == "at_value"
        assert data["refresh_token"] == "rt_value"
        assert data["expires_at"] == 999.0
        assert data["account_id"] == "acct_42"

    def test_creates_parent_directories(self, tmp_path):
        path = tmp_path / "a" / "b" / "c" / "oauth.json"
        oauth = CodexOAuth(
            access_token=SecretStr("at"),
            refresh_token=SecretStr("rt"),
            expires_at=0.0,
        )
        oauth.save(path)
        assert path.exists()

    def test_roundtrip_load_after_save(self, tmp_path):
        path = tmp_path / "oauth.json"
        oauth = CodexOAuth(
            access_token=SecretStr("at"),
            refresh_token=SecretStr("rt"),
            expires_at=42.0,
            account_id="acct_round",
        )
        oauth.save(path)
        loaded = CodexOAuth.load(path)
        assert loaded is not None
        assert loaded.access_token.get_secret_value() == "at"
        assert loaded.account_id == "acct_round"


# ---------------------------------------------------------------------------
# CodexOAuth.is_expired
# ---------------------------------------------------------------------------


class TestIsExpired:
    def test_expired_when_past(self):
        oauth = CodexOAuth(
            access_token=SecretStr("a"),
            refresh_token=SecretStr("r"),
            expires_at=time.time() - 100,
        )
        assert oauth.is_expired() is True

    def test_expired_within_60s_buffer(self):
        oauth = CodexOAuth(
            access_token=SecretStr("a"),
            refresh_token=SecretStr("r"),
            expires_at=time.time() + 30,  # 30s away — inside 60s buffer
        )
        assert oauth.is_expired() is True

    def test_not_expired_when_far_in_future(self):
        oauth = CodexOAuth(
            access_token=SecretStr("a"),
            refresh_token=SecretStr("r"),
            expires_at=time.time() + 3600,
        )
        assert oauth.is_expired() is False


# ---------------------------------------------------------------------------
# CodexOAuth.refresh
# ---------------------------------------------------------------------------


class TestRefresh:
    @respx.mock
    def test_refresh_persists_new_tokens(self, tmp_path):
        path = tmp_path / "oauth.json"
        old = CodexOAuth(
            access_token=SecretStr("old_at"),
            refresh_token=SecretStr("old_rt"),
            expires_at=time.time() - 10,
            account_id="acct_old",
        )
        respx.post(f"{ISSUER}/oauth/token").mock(
            return_value=httpx.Response(
                200,
                json={
                    "access_token": "new_at",
                    "refresh_token": "new_rt",
                    "expires_in": 7200,
                },
            )
        )
        new = old.refresh(path)
        assert new.access_token.get_secret_value() == "new_at"
        assert new.refresh_token.get_secret_value() == "new_rt"
        assert new.expires_at > time.time() + 7000  # ~+7200s
        # Old account_id preserved when not present in response
        assert new.account_id == "acct_old"
        # Persisted to disk
        assert path.exists()
        on_disk = json.loads(path.read_text())
        assert on_disk["access_token"] == "new_at"

    @respx.mock
    def test_refresh_keeps_old_refresh_token_if_omitted(self, tmp_path):
        path = tmp_path / "oauth.json"
        old = CodexOAuth(
            access_token=SecretStr("old_at"),
            refresh_token=SecretStr("rt_kept"),
            expires_at=time.time() - 10,
        )
        respx.post(f"{ISSUER}/oauth/token").mock(
            return_value=httpx.Response(
                200,
                json={"access_token": "new_at", "expires_in": 3600},
            )
        )
        new = old.refresh(path)
        assert new.refresh_token.get_secret_value() == "rt_kept"

    @respx.mock
    def test_refresh_raises_on_http_error(self, tmp_path):
        path = tmp_path / "oauth.json"
        old = CodexOAuth(
            access_token=SecretStr("at"),
            refresh_token=SecretStr("rt"),
            expires_at=0.0,
        )
        respx.post(f"{ISSUER}/oauth/token").mock(
            return_value=httpx.Response(401, json={"error": "invalid_grant"})
        )
        with pytest.raises(httpx.HTTPStatusError):
            old.refresh(path)

    def test_refresh_reuses_fresh_credentials_written_by_another_caller(self, tmp_path):
        path = tmp_path / "oauth.json"
        old = CodexOAuth(
            access_token=SecretStr("old_at"),
            refresh_token=SecretStr("old_rt"),
            expires_at=time.time() - 10,
        )
        old.save(path)
        calls = 0

        def refresh_token(_refresh_token: str) -> dict[str, object]:
            nonlocal calls
            calls += 1
            time.sleep(0.05)
            return {
                "access_token": "new_at",
                "refresh_token": "new_rt",
                "expires_in": 3600,
            }

        with patch(
            "app.agent.providers.codex.oauth._refresh_access_token",
            side_effect=refresh_token,
        ):
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(lambda _: old.refresh(path), range(2)))

        assert calls == 1
        assert [r.access_token.get_secret_value() for r in results] == [
            "new_at",
            "new_at",
        ]
        assert CodexOAuth.load(path).refresh_token.get_secret_value() == "new_rt"  # type: ignore[union-attr]


# ---------------------------------------------------------------------------
# PKCE helpers
# ---------------------------------------------------------------------------


class TestPKCEHelpers:
    def test_generate_verifier_length_43(self):
        verifier = _generate_verifier()
        assert len(verifier) == 43
        # Charset is the unreserved RFC 7636 set
        allowed = set(
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
        )
        assert set(verifier).issubset(allowed)

    def test_challenge_is_base64url_no_padding(self):
        challenge = _challenge("test_verifier")
        assert "=" not in challenge
        # Should decode cleanly back to 32 bytes (sha256 digest length)
        padded = challenge + "=" * (-len(challenge) % 4)
        assert len(base64.urlsafe_b64decode(padded)) == 32

    def test_state_is_unique(self):
        s1 = _state()
        s2 = _state()
        assert s1 != s2
        assert len(s1) > 20


class TestAuthorizeUrl:
    """Authorize URL must mirror upstream codex-rs/login/src/server.rs.

    Wire-level invariants for the ChatGPT OAuth flow.
    """

    def test_originator_identifies_openagentd(self):
        url = _authorize_url("http://localhost:1455/auth/callback", "v", "s")
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
        assert qs["originator"] == [CODEX_ORIGINATOR]

    def test_scope_includes_connectors(self):
        url = _authorize_url("http://localhost:1455/auth/callback", "v", "s")
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
        scope = qs["scope"][0]
        assert "openid" in scope
        assert "profile" in scope
        assert "email" in scope
        assert "offline_access" in scope
        assert "api.connectors.read" in scope
        assert "api.connectors.invoke" in scope


# ---------------------------------------------------------------------------
# _exchange_code / _refresh_access_token
# ---------------------------------------------------------------------------


class TestTokenExchange:
    @respx.mock
    def test_exchange_code_posts_grant_type_authorization_code(self):
        captured: dict[str, str] = {}

        def _capture(request: httpx.Request) -> httpx.Response:
            body = request.content.decode()
            captured["body"] = body
            return httpx.Response(
                200, json={"access_token": "at", "refresh_token": "rt"}
            )

        respx.post(f"{ISSUER}/oauth/token").mock(side_effect=_capture)
        result = _exchange_code(
            "the_code", "http://localhost:1455/auth/callback", "verifier"
        )
        assert result == {"access_token": "at", "refresh_token": "rt"}
        assert "grant_type=authorization_code" in captured["body"]
        assert "code=the_code" in captured["body"]
        assert f"client_id={CLIENT_ID}" in captured["body"]
        assert "code_verifier=verifier" in captured["body"]

    @respx.mock
    def test_exchange_code_raises_on_http_error(self):
        respx.post(f"{ISSUER}/oauth/token").mock(
            return_value=httpx.Response(400, json={"error": "invalid_request"})
        )
        with pytest.raises(httpx.HTTPStatusError):
            _exchange_code("bad", "http://x", "v")

    @respx.mock
    def test_refresh_access_token_uses_refresh_grant(self):
        captured: dict[str, str] = {}

        def _capture(request: httpx.Request) -> httpx.Response:
            captured["body"] = request.content.decode()
            return httpx.Response(200, json={"access_token": "at"})

        respx.post(f"{ISSUER}/oauth/token").mock(side_effect=_capture)
        _refresh_access_token("rt_input")
        assert "grant_type=refresh_token" in captured["body"]
        assert "refresh_token=rt_input" in captured["body"]


# ---------------------------------------------------------------------------
# _extract_account_id — JWT parsing
# ---------------------------------------------------------------------------


class TestExtractAccountId:
    def test_extracts_chatgpt_account_id_from_id_token(self):
        token = _make_jwt({"chatgpt_account_id": "acct_id_123"})
        assert _extract_account_id({"id_token": token}) == "acct_id_123"

    def test_extracts_from_namespaced_auth_claim(self):
        token = _make_jwt(
            {"https://api.openai.com/auth": {"chatgpt_account_id": "acct_ns_456"}}
        )
        assert _extract_account_id({"id_token": token}) == "acct_ns_456"

    def test_extracts_from_organizations_array(self):
        token = _make_jwt({"organizations": [{"id": "org_first"}]})
        assert _extract_account_id({"id_token": token}) == "org_first"

    def test_falls_through_to_access_token(self):
        token = _make_jwt({"chatgpt_account_id": "from_access"})
        assert (
            _extract_account_id({"access_token": token, "id_token": "x"})
            == "from_access"
        )

    def test_returns_none_when_no_tokens(self):
        assert _extract_account_id({}) is None

    def test_returns_none_for_malformed_jwt(self):
        assert _extract_account_id({"id_token": "not.a.jwt.at.all"}) is None
        assert _extract_account_id({"id_token": "noseparators"}) is None

    def test_returns_none_when_no_account_id_in_payload(self):
        token = _make_jwt({"sub": "user_1"})  # no account-id keys
        assert _extract_account_id({"id_token": token}) is None

    def test_handles_invalid_base64_gracefully(self):
        # Three segments but middle is not valid base64
        token = "h.@@@.s"
        assert _extract_account_id({"id_token": token}) is None


# ---------------------------------------------------------------------------
# _save_tokens
# ---------------------------------------------------------------------------


class TestSaveTokens:
    def test_writes_oauth_file_with_account_id(self, tmp_path, capsys):
        path = tmp_path / "oauth.json"
        token = _make_jwt({"chatgpt_account_id": "acct_save"})
        _save_tokens(
            {
                "access_token": token,
                "refresh_token": "rt",
                "expires_in": 1800,
                "id_token": token,
            },
            path,
        )
        assert path.exists()
        data = json.loads(path.read_text())
        assert data["access_token"] == token
        assert data["account_id"] == "acct_save"
        out = capsys.readouterr().out
        assert "acct_save" in out

    def test_default_expires_in_is_3600(self, tmp_path):
        path = tmp_path / "oauth.json"
        before = time.time()
        _save_tokens(
            {"access_token": "at", "refresh_token": "rt"},
            path,
        )
        data = json.loads(path.read_text())
        # expires_at ≈ now + 3600
        assert data["expires_at"] > before + 3590
        assert data["expires_at"] < before + 3610


# ---------------------------------------------------------------------------
# login() — orchestration short-circuits
# ---------------------------------------------------------------------------


class TestLogin:
    def test_valid_token_skips_relogin(self, tmp_path, capsys):
        path = tmp_path / "oauth.json"
        oauth = CodexOAuth(
            access_token=SecretStr("at"),
            refresh_token=SecretStr("rt"),
            expires_at=time.time() + 7200,  # well in future
        )
        oauth.save(path)

        # Should detect valid token and return without calling any flow.
        with (
            patch("app.agent.providers.codex.oauth._pkce_login") as mock_pkce,
            patch("app.agent.providers.codex.oauth._device_login") as mock_device,
        ):
            login(path)
            mock_pkce.assert_not_called()
            mock_device.assert_not_called()

        out = capsys.readouterr().out
        assert "Valid token found" in out

    def test_expired_token_triggers_refresh(self, tmp_path, capsys):
        path = tmp_path / "oauth.json"
        oauth = CodexOAuth(
            access_token=SecretStr("at"),
            refresh_token=SecretStr("rt"),
            expires_at=time.time() - 100,  # expired
        )
        oauth.save(path)

        # Refresh succeeds → login returns without flow.
        refreshed = MagicMock()
        with (
            patch.object(CodexOAuth, "refresh", return_value=refreshed) as mock_ref,
            patch("app.agent.providers.codex.oauth._pkce_login") as mock_pkce,
            patch("app.agent.providers.codex.oauth._device_login") as mock_device,
        ):
            login(path)
            mock_ref.assert_called_once_with(path)
            mock_pkce.assert_not_called()
            mock_device.assert_not_called()

        out = capsys.readouterr().out
        assert "refreshed successfully" in out.lower()

    def test_refresh_failure_falls_back_to_pkce(self, tmp_path, capsys):
        path = tmp_path / "oauth.json"
        oauth = CodexOAuth(
            access_token=SecretStr("at"),
            refresh_token=SecretStr("rt"),
            expires_at=time.time() - 100,
        )
        oauth.save(path)

        with (
            patch.object(CodexOAuth, "refresh", side_effect=RuntimeError("network")),
            patch("app.agent.providers.codex.oauth._pkce_login") as mock_pkce,
        ):
            login(path, device=False)
            mock_pkce.assert_called_once_with(path)

    def test_no_existing_credentials_runs_pkce(self, tmp_path):
        path = tmp_path / "oauth.json"  # missing
        with patch("app.agent.providers.codex.oauth._pkce_login") as mock_pkce:
            login(path, device=False)
            mock_pkce.assert_called_once_with(path)

    def test_device_flag_runs_device_flow(self, tmp_path):
        path = tmp_path / "oauth.json"  # missing
        with patch("app.agent.providers.codex.oauth._device_login") as mock_device:
            login(path, device=True)
            mock_device.assert_called_once_with(path)


@pytest.mark.skipif(
    sys.platform == "win32", reason="POSIX mode bits are not meaningful on Windows"
)
class TestTokenFilePermissions:
    """The file holds a live access token and a refresh token."""

    def test_saved_token_file_is_owner_only(self, tmp_path):
        path = tmp_path / "codex_oauth.json"
        CodexOAuth(
            access_token=SecretStr("access-token"),
            refresh_token=SecretStr("refresh-token"),
            expires_at=time.time() + 3600,
        ).save(path)

        assert stat.S_IMODE(path.stat().st_mode) == 0o600

    def test_existing_loose_token_file_is_tightened(self, tmp_path):
        """A file written before this rule existed must not stay readable."""
        path = tmp_path / "codex_oauth.json"
        path.write_text("{}", encoding="utf-8")
        path.chmod(0o644)

        CodexOAuth(
            access_token=SecretStr("access-token"),
            refresh_token=SecretStr("refresh-token"),
            expires_at=time.time() + 3600,
        ).save(path)

        assert stat.S_IMODE(path.stat().st_mode) == 0o600

    def test_save_round_trips_through_load(self, tmp_path):
        """Guard the on-disk format while changing how the file is written."""
        path = tmp_path / "codex_oauth.json"
        CodexOAuth(
            access_token=SecretStr("access-token"),
            refresh_token=SecretStr("refresh-token"),
            expires_at=1234.5,
            account_id="acct-1",
        ).save(path)

        loaded = CodexOAuth.load(path)
        assert loaded is not None
        assert loaded.access_token.get_secret_value() == "access-token"
        assert loaded.refresh_token.get_secret_value() == "refresh-token"
        assert loaded.expires_at == 1234.5
        assert loaded.account_id == "acct-1"
