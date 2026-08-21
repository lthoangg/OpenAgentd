"""Tests for app/agent/providers/copilot/oauth.py — CopilotOAuth + device flow."""

from __future__ import annotations

import json
import stat
import sys
from unittest.mock import MagicMock, patch

import httpx
import pytest
import respx
from pydantic import SecretStr

from app.agent.providers.copilot.oauth import (
    CopilotOAuth,
    _CLIENT_ID,
    _DEVICE_CODE_URL,
    _COPILOT_MODELS_URL,
    _poll_for_token,
    _request_device_code,
    _verify_copilot_access,
    copilot_api_base,
    github_device_urls,
    login,
    normalize_enterprise_url,
)


# ---------------------------------------------------------------------------
# CopilotOAuth.load
# ---------------------------------------------------------------------------


class TestCopilotOAuthLoad:
    def test_missing_file_returns_none(self, tmp_path):
        path = tmp_path / "missing.json"
        result = CopilotOAuth.load(path)
        assert result is None

    def test_invalid_json_returns_none(self, tmp_path):
        path = tmp_path / "bad.json"
        path.write_text("not valid json")
        result = CopilotOAuth.load(path)
        assert result is None

    def test_valid_file_returns_model(self, tmp_path):
        path = tmp_path / "oauth.json"
        path.write_text(json.dumps({"github_token": "gho_test_token"}))
        result = CopilotOAuth.load(path)
        assert result is not None
        assert result.github_token.get_secret_value() == "gho_test_token"

    def test_valid_file_normalizes_enterprise_url(self, tmp_path):
        path = tmp_path / "oauth.json"
        path.write_text(
            json.dumps(
                {"github_token": "gho_test_token", "enterprise_url": "ghe.example.com/"}
            )
        )
        result = CopilotOAuth.load(path)
        assert result is not None
        assert result.enterprise_url == "https://ghe.example.com"

    def test_missing_required_field_returns_none(self, tmp_path):
        path = tmp_path / "bad_schema.json"
        path.write_text(json.dumps({"other_field": "value"}))
        result = CopilotOAuth.load(path)
        assert result is None


# ---------------------------------------------------------------------------
# CopilotOAuth.save
# ---------------------------------------------------------------------------


class TestCopilotOAuthSave:
    def test_writes_json_with_token_exposed(self, tmp_path):
        path = tmp_path / "subdir" / "oauth.json"
        oauth = CopilotOAuth(github_token=SecretStr("gho_my_token"))
        oauth.save(path)

        assert path.exists()
        data = json.loads(path.read_text())
        assert data["github_token"] == "gho_my_token"

    def test_writes_normalized_enterprise_url(self, tmp_path):
        path = tmp_path / "oauth.json"
        oauth = CopilotOAuth(
            github_token=SecretStr("gho_my_token"), enterprise_url="ghe.example.com/"
        )
        oauth.save(path)
        data = json.loads(path.read_text())
        assert data["enterprise_url"] == "https://ghe.example.com"

    def test_creates_parent_directories(self, tmp_path):
        path = tmp_path / "a" / "b" / "c" / "oauth.json"
        oauth = CopilotOAuth(github_token=SecretStr("gho_tok"))
        oauth.save(path)
        assert path.exists()

    def test_roundtrip_load_after_save(self, tmp_path):
        path = tmp_path / "oauth.json"
        oauth = CopilotOAuth(github_token=SecretStr("gho_roundtrip"))
        oauth.save(path)
        loaded = CopilotOAuth.load(path)
        assert loaded is not None
        assert loaded.github_token.get_secret_value() == "gho_roundtrip"


# ---------------------------------------------------------------------------
# _request_device_code
# ---------------------------------------------------------------------------


class TestHelpers:
    def test_normalize_enterprise_url(self):
        assert normalize_enterprise_url("ghe.example.com/") == "https://ghe.example.com"
        assert (
            normalize_enterprise_url("https://ghe.example.com")
            == "https://ghe.example.com"
        )
        assert normalize_enterprise_url(None) is None

    def test_copilot_api_base_for_enterprise(self):
        assert (
            copilot_api_base("ghe.example.com") == "https://copilot-api.ghe.example.com"
        )

    def test_github_device_urls_for_enterprise(self):
        assert github_device_urls("ghe.example.com") == (
            "https://ghe.example.com/login/device/code",
            "https://ghe.example.com/login/oauth/access_token",
        )


class TestRequestDeviceCode:
    @respx.mock
    def test_returns_json_response(self):
        expected = {
            "device_code": "dev_code_123",
            "user_code": "ABCD-1234",
            "verification_uri": "https://github.com/login/device",
            "interval": 5,
            "expires_in": 900,
        }
        respx.post(_DEVICE_CODE_URL).mock(
            return_value=httpx.Response(200, json=expected)
        )
        result = _request_device_code()
        assert result["device_code"] == "dev_code_123"
        assert result["user_code"] == "ABCD-1234"
        request = respx.calls.last.request
        body = json.loads(request.content)
        assert body["client_id"] == _CLIENT_ID
        assert body["scope"] == "read:user"

    @respx.mock
    def test_raises_on_http_error(self):
        respx.post(_DEVICE_CODE_URL).mock(
            return_value=httpx.Response(400, json={"error": "bad_request"})
        )
        with pytest.raises(httpx.HTTPStatusError):
            _request_device_code()


# ---------------------------------------------------------------------------
# _poll_for_token
# ---------------------------------------------------------------------------


class TestPollForToken:
    def test_success_on_first_poll(self):
        with patch("httpx.post") as mock_post:
            mock_post.return_value = MagicMock(
                status_code=200,
                json=MagicMock(return_value={"access_token": "gho_success"}),
            )
            mock_post.return_value.raise_for_status = MagicMock()
            with patch("app.agent.providers.copilot.oauth.time") as mock_time:
                mock_time.time.return_value = 0
                mock_time.sleep = MagicMock()
                result = _poll_for_token("dev_code", interval=1, expires_in=60)
        assert result == "gho_success"

    def test_authorization_pending_then_success(self):
        responses = [
            MagicMock(
                json=MagicMock(return_value={"error": "authorization_pending"}),
                raise_for_status=MagicMock(),
            ),
            MagicMock(
                json=MagicMock(return_value={"access_token": "gho_final"}),
                raise_for_status=MagicMock(),
            ),
        ]
        with patch("httpx.post", side_effect=responses):
            with patch("app.agent.providers.copilot.oauth.time") as mock_time:
                mock_time.time.return_value = 0
                mock_time.sleep = MagicMock()
                result = _poll_for_token("dev_code", interval=1, expires_in=60)
        assert result == "gho_final"

    def test_slow_down_increases_interval(self):
        """Me slow_down error increases interval and continues."""
        call_count = [0]
        sleep_calls = []

        def fake_sleep(n):
            sleep_calls.append(n)

        def fake_post(*args, **kwargs):
            call_count[0] += 1
            m = MagicMock()
            m.raise_for_status = MagicMock()
            if call_count[0] == 1:
                m.json.return_value = {"error": "slow_down"}
            else:
                m.json.return_value = {"access_token": "gho_slow"}
            return m

        with patch("httpx.post", side_effect=fake_post):
            with patch("app.agent.providers.copilot.oauth.time") as mock_time:
                mock_time.time.return_value = 0  # Me never expire
                mock_time.sleep.side_effect = fake_sleep
                result = _poll_for_token("dev_code", interval=5, expires_in=60)

        assert result == "gho_slow"
        # Me second sleep should be longer (interval + 5)
        assert sleep_calls[1] > sleep_calls[0]

    def test_expired_token_exits(self):
        with patch("httpx.post") as mock_post:
            mock_post.return_value = MagicMock(
                json=MagicMock(return_value={"error": "expired_token"}),
                raise_for_status=MagicMock(),
            )
            with patch("app.agent.providers.copilot.oauth.time") as mock_time:
                mock_time.time.return_value = 0
                mock_time.sleep = MagicMock()
                with pytest.raises(SystemExit) as exc_info:
                    _poll_for_token("dev_code", interval=1, expires_in=60)
        assert exc_info.value.code == 1

    def test_access_denied_exits(self):
        with patch("httpx.post") as mock_post:
            mock_post.return_value = MagicMock(
                json=MagicMock(return_value={"error": "access_denied"}),
                raise_for_status=MagicMock(),
            )
            with patch("app.agent.providers.copilot.oauth.time") as mock_time:
                mock_time.time.return_value = 0
                mock_time.sleep = MagicMock()
                with pytest.raises(SystemExit) as exc_info:
                    _poll_for_token("dev_code", interval=1, expires_in=60)
        assert exc_info.value.code == 1

    def test_timeout_exits(self):
        """Me deadline passed → sys.exit(1).

        time.time() called twice: once for deadline=time.time()+expires_in,
        once for while time.time() < deadline check.
        First call returns 0 (sets deadline=1), second returns 1000 (past deadline).
        """
        with patch("app.agent.providers.copilot.oauth.time") as mock_time:
            mock_time.time.side_effect = [0, 1000]  # Me deadline=1, check=1000 → exit
            mock_time.sleep = lambda n: None
            with pytest.raises(SystemExit) as exc_info:
                _poll_for_token("dev_code", interval=1, expires_in=1)
        assert exc_info.value.code == 1

    def test_unexpected_error_exits(self):
        with patch("httpx.post") as mock_post:
            mock_post.return_value = MagicMock(
                json=MagicMock(return_value={"error": "some_unknown_error"}),
                raise_for_status=MagicMock(),
            )
            with patch("app.agent.providers.copilot.oauth.time") as mock_time:
                mock_time.time.return_value = 0
                mock_time.sleep = MagicMock()
                with pytest.raises(SystemExit) as exc_info:
                    _poll_for_token("dev_code", interval=1, expires_in=60)
        assert exc_info.value.code == 1


# ---------------------------------------------------------------------------
# _verify_copilot_access
# ---------------------------------------------------------------------------


class TestVerifyCopilotAccess:
    @respx.mock
    def test_success_200_with_models(self, capsys):
        respx.get(_COPILOT_MODELS_URL).mock(
            return_value=httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "id": "gpt-5-mini",
                            "model_picker_enabled": True,
                            "supported_endpoints": ["chat/completions"],
                        }
                    ]
                },
            )
        )
        result = _verify_copilot_access("gho_test")
        assert result is True
        out = capsys.readouterr().out
        assert "Copilot OK" in out

    @respx.mock
    def test_non_200_returns_false(self, capsys):
        respx.get(_COPILOT_MODELS_URL).mock(
            return_value=httpx.Response(403, json={"error": "Forbidden"})
        )
        result = _verify_copilot_access("gho_bad")
        assert result is False
        out = capsys.readouterr().out
        assert "failed" in out.lower() or "403" in out

    def test_exception_returns_false(self, capsys):
        with patch("httpx.get", side_effect=Exception("network error")):
            result = _verify_copilot_access("gho_test")
        assert result is False
        out = capsys.readouterr().out
        assert "error" in out.lower()


# ---------------------------------------------------------------------------
# login()
# ---------------------------------------------------------------------------


class TestLogin:
    def test_existing_valid_token_skips_flow(self, tmp_path, capsys):
        """Me existing valid token → no new device flow."""
        path = tmp_path / "oauth.json"
        path.write_text(json.dumps({"github_token": "gho_existing"}))

        with patch(
            "app.agent.providers.copilot.oauth._verify_copilot_access",
            return_value=True,
        ):
            login(oauth_path=path)

        out = capsys.readouterr().out
        assert "Existing token" in out
        assert "still valid" in out

    def test_existing_invalid_token_triggers_reauth(self, tmp_path, capsys):
        """Me existing invalid token → re-authenticate."""
        path = tmp_path / "oauth.json"
        path.write_text(json.dumps({"github_token": "gho_expired"}))

        device_data = {
            "device_code": "dev_code",
            "user_code": "ABCD-1234",
            "verification_uri": "https://github.com/login/device",
            "interval": 1,
            "expires_in": 60,
        }

        with (
            patch(
                "app.agent.providers.copilot.oauth._verify_copilot_access",
                side_effect=[False, True],
            ),
            patch(
                "app.agent.providers.copilot.oauth._request_device_code",
                return_value=device_data,
            ),
            patch(
                "app.agent.providers.copilot.oauth._poll_for_token",
                return_value="gho_new_token",
            ),
        ):
            login(oauth_path=path)

        out = capsys.readouterr().out
        assert "invalid" in out.lower() or "Re-authenticating" in out

    def test_full_flow_saves_token(self, tmp_path, capsys):
        """Me full flow: no existing token → device flow → save."""
        path = tmp_path / "oauth.json"

        device_data = {
            "device_code": "dev_code",
            "user_code": "ABCD-1234",
            "verification_uri": "https://github.com/login/device",
            "interval": 1,
            "expires_in": 60,
        }

        with (
            patch(
                "app.agent.providers.copilot.oauth._request_device_code",
                return_value=device_data,
            ),
            patch(
                "app.agent.providers.copilot.oauth._poll_for_token",
                return_value="gho_brand_new",
            ),
            patch(
                "app.agent.providers.copilot.oauth._verify_copilot_access",
                return_value=True,
            ),
        ):
            login(oauth_path=path)

        assert path.exists()
        data = json.loads(path.read_text())
        assert data["github_token"] == "gho_brand_new"

    def test_full_flow_prints_user_code(self, tmp_path, capsys):
        """Me user code printed so user can authorize."""
        path = tmp_path / "oauth.json"

        device_data = {
            "device_code": "dev_code",
            "user_code": "WXYZ-5678",
            "verification_uri": "https://github.com/login/device",
            "interval": 1,
            "expires_in": 60,
        }

        with (
            patch(
                "app.agent.providers.copilot.oauth._request_device_code",
                return_value=device_data,
            ),
            patch(
                "app.agent.providers.copilot.oauth._poll_for_token",
                return_value="gho_tok",
            ),
            patch(
                "app.agent.providers.copilot.oauth._verify_copilot_access",
                return_value=True,
            ),
        ):
            login(oauth_path=path)

        out = capsys.readouterr().out
        assert "WXYZ-5678" in out

    def test_new_token_saved_even_when_verification_fails(self, tmp_path, capsys):
        """Lines 192-194: _verify_copilot_access returns False after new token → warning printed, token still saved."""
        path = tmp_path / "oauth.json"

        device_data = {
            "device_code": "dev_code",
            "user_code": "ABCD-9999",
            "verification_uri": "https://github.com/login/device",
            "interval": 1,
            "expires_in": 60,
        }

        with (
            patch(
                "app.agent.providers.copilot.oauth._request_device_code",
                return_value=device_data,
            ),
            patch(
                "app.agent.providers.copilot.oauth._poll_for_token",
                return_value="gho_unverified_token",
            ),
            patch(
                "app.agent.providers.copilot.oauth._verify_copilot_access",
                return_value=False,
            ),
        ):
            login(oauth_path=path)

        out = capsys.readouterr().out
        # Me warning printed
        assert "WARNING" in out or "failed" in out.lower() or "Copilot access" in out
        # Me token still saved despite failed verification
        assert path.exists()
        import json as _json

        data = _json.loads(path.read_text())
        assert data["github_token"] == "gho_unverified_token"


@pytest.mark.skipif(
    sys.platform == "win32", reason="POSIX mode bits are not meaningful on Windows"
)
class TestTokenFilePermissions:
    """The file holds a long-lived GitHub token."""

    def test_saved_token_file_is_owner_only(self, tmp_path):
        path = tmp_path / "copilot_oauth.json"
        CopilotOAuth(github_token=SecretStr("gho_secret")).save(path)

        assert stat.S_IMODE(path.stat().st_mode) == 0o600

    def test_existing_loose_token_file_is_tightened(self, tmp_path):
        """A file written before this rule existed must not stay readable."""
        path = tmp_path / "copilot_oauth.json"
        path.write_text("{}", encoding="utf-8")
        path.chmod(0o644)

        CopilotOAuth(github_token=SecretStr("gho_secret")).save(path)

        assert stat.S_IMODE(path.stat().st_mode) == 0o600

    def test_save_round_trips_through_load(self, tmp_path):
        """Guard the on-disk format while changing how the file is written."""
        path = tmp_path / "copilot_oauth.json"
        CopilotOAuth(
            github_token=SecretStr("gho_secret"),
            enterprise_url="https://ghe.example.com",
        ).save(path)

        loaded = CopilotOAuth.load(path)
        assert loaded is not None
        assert loaded.github_token.get_secret_value() == "gho_secret"
        assert loaded.enterprise_url == "https://ghe.example.com"
