"""Tests for OpenAI Codex provider (OAuth, token loading, request building).

Covers:
- CodexOAuth: load/save/refresh/is_expired
- _extract_account_id: JWT parsing from id_token and access_token
- _load_token: token loading and refresh logic
- _CodexResponsesHandler.build_request: system message extraction and request building
- CodexProvider.__init__: header setup and token loading
- app.cli.commands.auth._run_login: device flag forwarding
"""

from __future__ import annotations

import json
import time
from typing import Any
from unittest.mock import MagicMock, patch
from base64 import urlsafe_b64encode

import httpx
import pytest
import respx
from pydantic import SecretStr

from app.agent.providers.codex.oauth import (
    CODEX_ORIGINATOR,
    CodexOAuth,
    _device_login,
    _extract_account_id,
)
from app.core.version import VERSION
from app.agent.providers.codex.codex import (
    CODEX_STREAM_IDLE_TIMEOUT_SECONDS,
    _load_token,
    _CodexResponsesHandler,
    CodexProvider,
)
from app.agent.schemas.chat import (
    SystemMessage,
    HumanMessage,
    AssistantMessage,
    ChatCompletionChunk,
    ChatCompletionChunkChoice,
    ChatCompletionDelta,
    EncryptedReasoningItem,
    ToolMessage,
    ToolCallDelta,
    ToolCall,
    FunctionCall,
    FunctionCallDelta,
)
from app.cli.commands.auth import _run_login


# ============================================================================
# CodexOAuth Tests
# ============================================================================


class TestCodexOAuthLoad:
    """Test CodexOAuth.load() — file I/O and error handling."""

    def test_load_returns_none_when_file_missing(self, tmp_path):
        """load() returns None when oauth file does not exist."""
        oauth_file = tmp_path / "codex_oauth.json"
        result = CodexOAuth.load(oauth_file)
        assert result is None

    def test_load_returns_none_when_file_malformed_json(self, tmp_path):
        """load() returns None when file contains invalid JSON."""
        oauth_file = tmp_path / "codex_oauth.json"
        oauth_file.write_text("{ invalid json }")
        result = CodexOAuth.load(oauth_file)
        assert result is None

    def test_load_returns_none_when_file_missing_required_fields(self, tmp_path):
        """load() returns None when JSON is missing required fields."""
        oauth_file = tmp_path / "codex_oauth.json"
        oauth_file.write_text(json.dumps({"access_token": "token"}))
        result = CodexOAuth.load(oauth_file)
        assert result is None

    def test_load_returns_oauth_when_file_valid(self, tmp_path):
        """load() returns CodexOAuth when file is valid."""
        oauth_file = tmp_path / "codex_oauth.json"
        data = {
            "access_token": "access_123",
            "refresh_token": "refresh_456",
            "expires_at": time.time() + 3600,
            "account_id": "account_789",
        }
        oauth_file.write_text(json.dumps(data))
        result = CodexOAuth.load(oauth_file)
        assert result is not None
        assert result.access_token.get_secret_value() == "access_123"
        assert result.refresh_token.get_secret_value() == "refresh_456"
        assert result.account_id == "account_789"

    def test_load_returns_oauth_without_account_id(self, tmp_path):
        """load() returns CodexOAuth even when account_id is null."""
        oauth_file = tmp_path / "codex_oauth.json"
        data = {
            "access_token": "access_123",
            "refresh_token": "refresh_456",
            "expires_at": time.time() + 3600,
            "account_id": None,
        }
        oauth_file.write_text(json.dumps(data))
        result = CodexOAuth.load(oauth_file)
        assert result is not None
        assert result.account_id is None


class TestCodexOAuthSave:
    """Test CodexOAuth.save() — file writing."""

    def test_save_creates_parent_directories(self, tmp_path):
        """save() creates parent directories if they don't exist."""
        oauth_file = tmp_path / "nested" / "dir" / "codex_oauth.json"
        oauth = CodexOAuth(
            access_token=SecretStr("access_123"),
            refresh_token=SecretStr("refresh_456"),
            expires_at=time.time() + 3600,
            account_id="account_789",
        )
        oauth.save(oauth_file)
        assert oauth_file.exists()
        assert oauth_file.parent.exists()

    def test_save_writes_correct_json_structure(self, tmp_path):
        """save() writes correct JSON with all fields."""
        oauth_file = tmp_path / "codex_oauth.json"
        expires_at = time.time() + 3600
        oauth = CodexOAuth(
            access_token=SecretStr("access_123"),
            refresh_token=SecretStr("refresh_456"),
            expires_at=expires_at,
            account_id="account_789",
        )
        oauth.save(oauth_file)

        data = json.loads(oauth_file.read_text())
        assert data["access_token"] == "access_123"
        assert data["refresh_token"] == "refresh_456"
        assert data["expires_at"] == expires_at
        assert data["account_id"] == "account_789"

    def test_save_writes_json_with_newline(self, tmp_path):
        """save() writes JSON with trailing newline."""
        oauth_file = tmp_path / "codex_oauth.json"
        oauth = CodexOAuth(
            access_token=SecretStr("access_123"),
            refresh_token=SecretStr("refresh_456"),
            expires_at=time.time() + 3600,
        )
        oauth.save(oauth_file)
        content = oauth_file.read_text()
        assert content.endswith("\n")

    def test_save_roundtrip(self, tmp_path):
        """save() and load() roundtrip correctly."""
        oauth_file = tmp_path / "codex_oauth.json"
        original = CodexOAuth(
            access_token=SecretStr("access_123"),
            refresh_token=SecretStr("refresh_456"),
            expires_at=time.time() + 3600,
            account_id="account_789",
        )
        original.save(oauth_file)
        loaded = CodexOAuth.load(oauth_file)
        assert loaded is not None
        assert (
            loaded.access_token.get_secret_value()
            == original.access_token.get_secret_value()
        )
        assert (
            loaded.refresh_token.get_secret_value()
            == original.refresh_token.get_secret_value()
        )
        assert loaded.account_id == original.account_id


class TestCodexOAuthIsExpired:
    """Test CodexOAuth.is_expired() — expiration logic."""

    def test_is_expired_returns_false_when_token_fresh(self):
        """is_expired() returns False when token expires far in future."""
        oauth = CodexOAuth(
            access_token=SecretStr("token"),
            refresh_token=SecretStr("refresh"),
            expires_at=time.time() + 3600,  # 1 hour from now
        )
        assert oauth.is_expired() is False

    def test_is_expired_returns_true_when_token_expired(self):
        """is_expired() returns True when token has expired."""
        oauth = CodexOAuth(
            access_token=SecretStr("token"),
            refresh_token=SecretStr("refresh"),
            expires_at=time.time() - 100,  # 100 seconds ago
        )
        assert oauth.is_expired() is True

    def test_is_expired_returns_true_within_60s_buffer(self):
        """is_expired() returns True when token expires within 60s buffer."""
        oauth = CodexOAuth(
            access_token=SecretStr("token"),
            refresh_token=SecretStr("refresh"),
            expires_at=time.time() + 30,  # 30 seconds from now (within 60s buffer)
        )
        assert oauth.is_expired() is True

    def test_is_expired_returns_false_just_outside_buffer(self):
        """is_expired() returns False when token expires just outside 60s buffer."""
        oauth = CodexOAuth(
            access_token=SecretStr("token"),
            refresh_token=SecretStr("refresh"),
            expires_at=time.time() + 61,  # 61 seconds from now (outside 60s buffer)
        )
        assert oauth.is_expired() is False


class TestCodexOAuthRefresh:
    """Test CodexOAuth.refresh() — token refresh logic."""

    def test_refresh_calls_token_endpoint(self, tmp_path):
        """refresh() calls the token endpoint with correct parameters."""
        oauth_file = tmp_path / "codex_oauth.json"
        oauth = CodexOAuth(
            access_token=SecretStr("old_access"),
            refresh_token=SecretStr("refresh_token_123"),
            expires_at=time.time() - 100,
        )

        mock_response = {
            "access_token": "new_access",
            "refresh_token": "new_refresh",
            "expires_in": 3600,
        }

        with patch(
            "app.agent.providers.codex.oauth._refresh_access_token"
        ) as mock_refresh:
            mock_refresh.return_value = mock_response
            result = oauth.refresh(oauth_file)

            mock_refresh.assert_called_once_with("refresh_token_123")
            assert result.access_token.get_secret_value() == "new_access"
            assert result.refresh_token.get_secret_value() == "new_refresh"

    def test_refresh_preserves_refresh_token_when_not_returned(self, tmp_path):
        """refresh() preserves original refresh_token when endpoint doesn't return one."""
        oauth_file = tmp_path / "codex_oauth.json"
        oauth = CodexOAuth(
            access_token=SecretStr("old_access"),
            refresh_token=SecretStr("original_refresh"),
            expires_at=time.time() - 100,
        )

        mock_response = {
            "access_token": "new_access",
            "expires_in": 3600,
            # No refresh_token in response
        }

        with patch(
            "app.agent.providers.codex.oauth._refresh_access_token"
        ) as mock_refresh:
            mock_refresh.return_value = mock_response
            result = oauth.refresh(oauth_file)

            assert result.refresh_token.get_secret_value() == "original_refresh"

    def test_refresh_saves_to_file(self, tmp_path):
        """refresh() saves updated credentials to file."""
        oauth_file = tmp_path / "codex_oauth.json"
        oauth = CodexOAuth(
            access_token=SecretStr("old_access"),
            refresh_token=SecretStr("refresh_token_123"),
            expires_at=time.time() - 100,
        )

        mock_response = {
            "access_token": "new_access",
            "refresh_token": "new_refresh",
            "expires_in": 3600,
        }

        with patch(
            "app.agent.providers.codex.oauth._refresh_access_token"
        ) as mock_refresh:
            mock_refresh.return_value = mock_response
            oauth.refresh(oauth_file)

            # Verify file was written
            assert oauth_file.exists()
            loaded = CodexOAuth.load(oauth_file)
            assert loaded is not None
            assert loaded.access_token.get_secret_value() == "new_access"

    def test_refresh_updates_expires_at(self, tmp_path):
        """refresh() updates expires_at based on expires_in."""
        oauth_file = tmp_path / "codex_oauth.json"
        oauth = CodexOAuth(
            access_token=SecretStr("old_access"),
            refresh_token=SecretStr("refresh_token_123"),
            expires_at=time.time() - 100,
        )

        before = time.time()
        mock_response = {
            "access_token": "new_access",
            "refresh_token": "new_refresh",
            "expires_in": 7200,  # 2 hours
        }

        with patch(
            "app.agent.providers.codex.oauth._refresh_access_token"
        ) as mock_refresh:
            mock_refresh.return_value = mock_response
            result = oauth.refresh(oauth_file)
            after = time.time()

            # expires_at should be approximately now + 7200
            assert before + 7200 <= result.expires_at <= after + 7200

    def test_refresh_extracts_account_id_from_response(self, tmp_path):
        """refresh() extracts account_id from token response."""
        oauth_file = tmp_path / "codex_oauth.json"
        oauth = CodexOAuth(
            access_token=SecretStr("old_access"),
            refresh_token=SecretStr("refresh_token_123"),
            expires_at=time.time() - 100,
            account_id="old_account",
        )

        # Create a valid JWT with account_id
        header = urlsafe_b64encode(b'{"alg":"HS256"}').rstrip(b"=").decode()
        payload = (
            urlsafe_b64encode(b'{"chatgpt_account_id":"new_account"}')
            .rstrip(b"=")
            .decode()
        )
        signature = "sig"
        new_token = f"{header}.{payload}.{signature}"

        mock_response = {
            "access_token": "new_access",
            "refresh_token": "new_refresh",
            "expires_in": 3600,
            "id_token": new_token,
        }

        with patch(
            "app.agent.providers.codex.oauth._refresh_access_token"
        ) as mock_refresh:
            mock_refresh.return_value = mock_response
            result = oauth.refresh(oauth_file)

            assert result.account_id == "new_account"

    def test_refresh_preserves_account_id_when_not_in_response(self, tmp_path):
        """refresh() preserves account_id when not extracted from response."""
        oauth_file = tmp_path / "codex_oauth.json"
        oauth = CodexOAuth(
            access_token=SecretStr("old_access"),
            refresh_token=SecretStr("refresh_token_123"),
            expires_at=time.time() - 100,
            account_id="original_account",
        )

        mock_response = {
            "access_token": "new_access",
            "refresh_token": "new_refresh",
            "expires_in": 3600,
            # No id_token or account_id
        }

        with patch(
            "app.agent.providers.codex.oauth._refresh_access_token"
        ) as mock_refresh:
            mock_refresh.return_value = mock_response
            result = oauth.refresh(oauth_file)

            assert result.account_id == "original_account"


def test_device_login_falls_back_to_pkce_when_device_code_disabled(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """Business accounts can reject device-code auth; UI should get PKCE fallback."""
    import httpx

    events: list[tuple[str, dict[str, Any]]] = []

    def sink(event: str, data: dict[str, Any]) -> None:
        events.append((event, data))

    request = httpx.Request("POST", "https://auth.openai.com/test")
    response = httpx.Response(
        403,
        request=request,
    )

    monkeypatch.setattr(
        "app.agent.providers.codex.oauth.httpx.post", lambda *_args, **_kwargs: response
    )
    pkce_login = MagicMock()
    monkeypatch.setattr("app.agent.providers.codex.oauth._pkce_login", pkce_login)

    _device_login(tmp_path / "oauth.json", event_sink=sink)

    pkce_login.assert_called_once()
    assert pkce_login.call_args.kwargs["event_sink"] is sink


# ============================================================================
# _extract_account_id Tests
# ============================================================================


class TestExtractAccountId:
    """Test _extract_account_id() — JWT parsing."""

    def _make_jwt(self, payload: dict) -> str:
        """Helper to create a valid JWT with given payload."""
        header = urlsafe_b64encode(b'{"alg":"HS256"}').rstrip(b"=").decode()
        payload_json = json.dumps(payload).encode()
        payload_b64 = urlsafe_b64encode(payload_json).rstrip(b"=").decode()
        signature = "sig"
        return f"{header}.{payload_b64}.{signature}"

    def test_extract_from_id_token_chatgpt_account_id(self):
        """Extracts chatgpt_account_id from id_token."""
        token = self._make_jwt({"chatgpt_account_id": "account_123"})
        result = _extract_account_id({"id_token": token})
        assert result == "account_123"

    def test_extract_from_id_token_nested_claim(self):
        """Extracts from https://api.openai.com/auth nested claim in id_token."""
        token = self._make_jwt(
            {"https://api.openai.com/auth": {"chatgpt_account_id": "account_456"}}
        )
        result = _extract_account_id({"id_token": token})
        assert result == "account_456"

    def test_extract_from_id_token_organizations(self):
        """Extracts from organizations[0].id in id_token."""
        token = self._make_jwt({"organizations": [{"id": "org_789"}]})
        result = _extract_account_id({"id_token": token})
        assert result == "org_789"

    def test_extract_prefers_chatgpt_account_id_over_nested(self):
        """Prefers chatgpt_account_id over nested claim."""
        token = self._make_jwt(
            {
                "chatgpt_account_id": "direct",
                "https://api.openai.com/auth": {"chatgpt_account_id": "nested"},
            }
        )
        result = _extract_account_id({"id_token": token})
        assert result == "direct"

    def test_extract_prefers_nested_over_organizations(self):
        """Prefers nested claim over organizations."""
        token = self._make_jwt(
            {
                "https://api.openai.com/auth": {"chatgpt_account_id": "nested"},
                "organizations": [{"id": "org_789"}],
            }
        )
        result = _extract_account_id({"id_token": token})
        assert result == "nested"

    def test_extract_falls_back_to_access_token(self):
        """Falls back to access_token when id_token is absent."""
        token = self._make_jwt({"chatgpt_account_id": "from_access"})
        result = _extract_account_id({"access_token": token})
        assert result == "from_access"

    def test_extract_returns_none_when_no_tokens(self):
        """Returns None when neither id_token nor access_token present."""
        result = _extract_account_id({})
        assert result is None

    def test_extract_returns_none_when_tokens_empty(self):
        """Returns None when tokens are empty strings."""
        result = _extract_account_id({"id_token": "", "access_token": ""})
        assert result is None

    def test_extract_returns_none_when_jwt_malformed(self):
        """Returns None when JWT has wrong number of parts."""
        result = _extract_account_id({"id_token": "not.a.valid.jwt.token"})
        assert result is None

    def test_extract_returns_none_when_payload_invalid_json(self):
        """Returns None when JWT payload is not valid JSON."""
        header = urlsafe_b64encode(b'{"alg":"HS256"}').rstrip(b"=").decode()
        bad_payload = urlsafe_b64encode(b"not json").rstrip(b"=").decode()
        signature = "sig"
        token = f"{header}.{bad_payload}.{signature}"
        result = _extract_account_id({"id_token": token})
        assert result is None

    def test_extract_returns_none_when_no_account_id_in_payload(self):
        """Returns None when JWT payload has no account_id fields."""
        token = self._make_jwt({"sub": "user_123", "aud": "client_id"})
        result = _extract_account_id({"id_token": token})
        assert result is None

    def test_extract_handles_padding_correctly(self):
        """Handles JWT payload padding correctly."""
        # Create payload with length that requires padding
        payload = {"chatgpt_account_id": "test"}
        payload_json = json.dumps(payload).encode()
        payload_b64 = urlsafe_b64encode(payload_json).rstrip(b"=").decode()
        header = urlsafe_b64encode(b'{"alg":"HS256"}').rstrip(b"=").decode()
        token = f"{header}.{payload_b64}.sig"
        result = _extract_account_id({"id_token": token})
        assert result == "test"


# ============================================================================
# _load_token Tests
# ============================================================================


class TestLoadToken:
    """Test _load_token() — token loading and refresh."""

    def test_load_token_raises_when_no_oauth_file(self):
        """_load_token() raises ValueError when no oauth file exists."""
        with patch("app.agent.providers.codex.codex.CodexOAuth.load") as mock_load:
            mock_load.return_value = None
            with pytest.raises(ValueError, match="Codex OAuth credentials not found"):
                _load_token()

    def test_load_token_returns_fresh_token(self):
        """_load_token() returns (access_token, account_id) when token is fresh."""
        oauth = CodexOAuth(
            access_token=SecretStr("access_123"),
            refresh_token=SecretStr("refresh_456"),
            expires_at=time.time() + 3600,
            account_id="account_789",
        )
        with patch("app.agent.providers.codex.codex.CodexOAuth.load") as mock_load:
            mock_load.return_value = oauth
            token, account_id = _load_token()

            assert token == "access_123"
            assert account_id == "account_789"

    def test_load_token_returns_none_account_id_when_not_set(self):
        """_load_token() returns None for account_id when not set."""
        oauth = CodexOAuth(
            access_token=SecretStr("access_123"),
            refresh_token=SecretStr("refresh_456"),
            expires_at=time.time() + 3600,
            account_id=None,
        )
        with patch("app.agent.providers.codex.codex.CodexOAuth.load") as mock_load:
            mock_load.return_value = oauth
            token, account_id = _load_token()

            assert token == "access_123"
            assert account_id is None

    def test_load_token_refreshes_when_expired(self):
        """_load_token() calls refresh() when token is expired."""
        expired_oauth = CodexOAuth(
            access_token=SecretStr("old_access"),
            refresh_token=SecretStr("refresh_456"),
            expires_at=time.time() - 100,
            account_id="account_789",
        )
        refreshed_oauth = CodexOAuth(
            access_token=SecretStr("new_access"),
            refresh_token=SecretStr("refresh_456"),
            expires_at=time.time() + 3600,
            account_id="account_789",
        )

        with patch("app.agent.providers.codex.codex.CodexOAuth.load") as mock_load:
            mock_load.return_value = expired_oauth
            with patch(
                "app.agent.providers.codex.codex.CodexOAuth.refresh"
            ) as mock_refresh:
                mock_refresh.return_value = refreshed_oauth
                token, account_id = _load_token()

                mock_refresh.assert_called_once()
                assert token == "new_access"
                assert account_id == "account_789"

    def test_load_token_raises_when_refresh_fails(self):
        """_load_token() raises ValueError when refresh fails."""
        expired_oauth = CodexOAuth(
            access_token=SecretStr("old_access"),
            refresh_token=SecretStr("refresh_456"),
            expires_at=time.time() - 100,
        )

        with patch("app.agent.providers.codex.codex.CodexOAuth.load") as mock_load:
            mock_load.return_value = expired_oauth
            with patch(
                "app.agent.providers.codex.codex.CodexOAuth.refresh"
            ) as mock_refresh:
                mock_refresh.side_effect = Exception("Network error")
                with pytest.raises(ValueError, match="Codex token refresh failed"):
                    _load_token()


# ============================================================================
# _CodexResponsesHandler.build_request Tests
# ============================================================================


class TestCodexResponsesHandlerBuildRequest:
    """Test _CodexResponsesHandler.build_request() — request building."""

    def test_build_request_sets_store_false(self):
        """build_request() always sets store=False."""
        handler = _CodexResponsesHandler("gpt-5.4", "https://api.example.com", {})
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(messages, None, False, {})
        assert body["store"] is False

    def test_build_request_includes_reasoning_encrypted_content(self):
        """Codex always requests `reasoning.encrypted_content`, unconditionally,
        matching upstream Codex CLI (codex-rs/core/src/client.rs `build_responses_request`)
        so stateless (store=false) tool-calling turns keep reasoning continuity."""
        handler = _CodexResponsesHandler("gpt-5.4", "https://api.example.com", {})
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(messages, None, False, {})
        assert body["include"] == ["reasoning.encrypted_content"]

    def test_build_request_extracts_system_message_to_instructions(self):
        """build_request() extracts SystemMessage content to instructions."""
        handler = _CodexResponsesHandler("gpt-5.4", "https://api.example.com", {})
        messages = [
            SystemMessage(content="You are helpful"),
            HumanMessage(content="Hello"),
        ]
        body = handler.build_request(messages, None, False, {})
        assert body["instructions"] == "You are helpful"

    def test_build_request_sets_instructions_to_space_when_no_system_message(self):
        """build_request() omits instructions when no SystemMessage is present."""
        handler = _CodexResponsesHandler("gpt-5.4", "https://api.example.com", {})
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(messages, None, False, {})
        assert "instructions" not in body

    def test_build_request_joins_multiple_system_messages(self):
        """build_request() joins multiple SystemMessages with newlines."""
        handler = _CodexResponsesHandler("gpt-5.4", "https://api.example.com", {})
        messages = [
            SystemMessage(content="You are helpful"),
            SystemMessage(content="Be concise"),
            HumanMessage(content="Hello"),
        ]
        body = handler.build_request(messages, None, False, {})
        assert body["instructions"] == "You are helpful\n\nBe concise"

    def test_build_request_skips_system_message_with_none_content(self):
        """build_request() skips SystemMessage with content=None."""
        handler = _CodexResponsesHandler("gpt-5.4", "https://api.example.com", {})
        messages = [
            SystemMessage(content=None),
            SystemMessage(content="You are helpful"),
            HumanMessage(content="Hello"),
        ]
        body = handler.build_request(messages, None, False, {})
        assert body["instructions"] == "You are helpful"

    def test_build_request_human_message_with_none_content_uses_input_text_item(self):
        """Codex request input text content must use explicit content items."""
        handler = _CodexResponsesHandler("gpt-5.4", "https://api.example.com", {})
        messages = [HumanMessage(content=None)]
        body = handler.build_request(messages, None, False, {})
        assert body["input"] == [
            {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": ""}],
            }
        ]

    def test_build_request_human_message_with_text_uses_input_text_item(self):
        """Codex text-only user turns match upstream ContentItem shape."""
        handler = _CodexResponsesHandler("gpt-5.4", "https://api.example.com", {})
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(messages, None, False, {})
        assert body["input"] == [
            {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "Hello"}],
            }
        ]

    def test_build_request_assistant_text_uses_output_text_content_item(self):
        """Codex rejects raw assistant strings as an unsupported content type."""
        handler = _CodexResponsesHandler("gpt-5.4", "https://api.example.com", {})
        messages = [AssistantMessage(content="Prior answer")]
        body = handler.build_request(messages, None, False, {})
        assert body["input"] == [
            {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "Prior answer"}],
            }
        ]

    def test_build_request_removes_system_messages_from_input(self):
        """build_request() removes SystemMessages from input array."""
        handler = _CodexResponsesHandler("gpt-5.4", "https://api.example.com", {})
        messages = [
            SystemMessage(content="You are helpful"),
            HumanMessage(content="Hello"),
            AssistantMessage(content="Hi there"),
        ]
        body = handler.build_request(messages, None, False, {})
        # input should only have HumanMessage and AssistantMessage
        input_items = body["input"]
        assert len(input_items) == 2
        assert input_items[0]["role"] == "user"
        assert input_items[1]["role"] == "assistant"

    def test_build_request_drops_orphan_tool_messages(self):
        """build_request() drops tool outputs without assistant tool calls."""
        handler = _CodexResponsesHandler("gpt-5.4", "https://api.example.com", {})
        messages = [
            SystemMessage(content="System"),
            HumanMessage(content="User message"),
            AssistantMessage(content="Assistant message"),
            ToolMessage(content="Tool output", tool_call_id="call_123"),
        ]
        body = handler.build_request(messages, None, False, {})
        input_items = body["input"]
        assert len(input_items) == 2
        assert input_items[0]["role"] == "user"
        assert input_items[1]["role"] == "assistant"

    def test_build_request_inherits_model_from_parent(self):
        """build_request() includes model from parent class."""
        handler = _CodexResponsesHandler("gpt-5.4", "https://api.example.com", {})
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(messages, None, False, {})
        assert body["model"] == "gpt-5.4"

    def test_build_request_inherits_stream_from_parent(self):
        """build_request() includes stream parameter from parent class."""
        handler = _CodexResponsesHandler("gpt-5.4", "https://api.example.com", {})
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(messages, None, True, {})
        assert body["stream"] is True

    def test_build_request_inherits_tools_from_parent(self):
        """build_request() includes tools from parent class."""
        handler = _CodexResponsesHandler("gpt-5.4", "https://api.example.com", {})
        messages = [HumanMessage(content="Hello")]
        tools = [{"type": "function", "function": {"name": "test"}}]
        body = handler.build_request(messages, tools, False, {})
        assert "tools" in body

    def test_build_request_enables_automatic_parallel_tool_calls(self):
        """Codex explicitly requests upstream's automatic parallel tool mode."""
        handler = _CodexResponsesHandler("gpt-5.4", "https://api.example.com", {})
        messages = [HumanMessage(content="Hello")]
        tools = [{"type": "function", "function": {"name": "test"}}]

        body = handler.build_request(messages, tools, False, {})

        assert body["tool_choice"] == "auto"
        assert body["parallel_tool_calls"] is True

    def test_build_request_sends_none_as_explicit_reasoning_effort(self):
        handler = _CodexResponsesHandler("gpt-5.4", "https://api.example.com", {})
        messages = [HumanMessage(content="Hello")]

        body = handler.build_request(messages, None, False, {"thinking_level": "none"})

        assert body["reasoning"] == {"effort": "none"}

    def test_build_request_sends_none_as_explicit_reasoning_effort_for_off(self):
        handler = _CodexResponsesHandler("gpt-5.4", "https://api.example.com", {})
        messages = [HumanMessage(content="Hello")]

        body = handler.build_request(messages, None, False, {"thinking_level": "off"})

        assert body["reasoning"] == {"effort": "none"}

    def test_build_request_requests_reasoning_summary_for_supported_model(self):
        handler = _CodexResponsesHandler("gpt-5.6-terra", "https://api.example.com", {})
        messages = [HumanMessage(content="Hello")]

        body = handler.build_request(messages, None, False, {"thinking_level": "xhigh"})

        assert body["reasoning"] == {"effort": "xhigh", "summary": "auto"}

    def test_build_request_omits_reasoning_summary_for_spark(self):
        handler = _CodexResponsesHandler(
            "gpt-5.3-codex-spark", "https://api.example.com", {}
        )
        messages = [HumanMessage(content="Hello")]

        body = handler.build_request(messages, None, False, {"thinking_level": "high"})

        assert body["reasoning"] == {"effort": "high"}

    def test_build_request_drops_max_tokens(self):
        """Match upstream: ``ResponsesApiRequest`` has no token-cap field.

        See openai/codex ``codex-rs/codex-api/src/common.rs::ResponsesApiRequest``
        — the official Codex CLI never sends ``max_output_tokens`` to the
        Responses endpoint. Empirically the endpoint stalls when given one
        (verified 2026-05-25), so we strip what the parent ResponsesHandler adds.
        """
        handler = _CodexResponsesHandler("gpt-5.4", "https://api.example.com", {})
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(messages, None, False, {"max_tokens": 1000})
        assert "max_output_tokens" not in body

    def test_build_request_maps_fast_service_tier_to_priority(self):
        """Codex Fast mode is sent as priority service tier upstream."""
        handler = _CodexResponsesHandler("gpt-5.4", "https://api.example.com", {})
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(messages, None, False, {"service_tier": "fast"})
        assert body["service_tier"] == "priority"

    def test_build_request_forwards_prompt_cache_key(self):
        """Codex requests retain the stable cache-routing key from the caller."""
        handler = _CodexResponsesHandler(
            "gpt-5.6-luna",
            "https://chatgpt.com/backend-api/codex",
            {},
        )
        body = handler.build_request(
            [HumanMessage(content="Hi")],
            None,
            False,
            {"prompt_cache_key": "openagentd:session-123"},
        )
        assert body["prompt_cache_key"] == "openagentd:session-123"

    def test_build_request_uses_session_id_for_cache_routing_header(self):
        """Normal Codex turns route a session to one cache partition."""
        handler = _CodexResponsesHandler("gpt-5.6-luna", "https://api.example.com", {})

        body = handler.build_request(
            [HumanMessage(content="Hi")],
            None,
            True,
            {"session_id": "session-123"},
        )

        assert body["prompt_cache_key"] == "session-123"
        assert handler._prepare_request_headers(body)["session-id"] == "session-123"

    def test_build_request_omits_standard_service_tier(self):
        """Standard/default tiers should not add a private endpoint field."""
        handler = _CodexResponsesHandler("gpt-5.4", "https://api.example.com", {})
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(
            messages, None, False, {"service_tier": "standard"}
        )
        assert "service_tier" not in body

    def test_build_request_forwards_non_fast_service_tier(self):
        """Allow other Codex service-tier IDs such as flex to pass through."""
        handler = _CodexResponsesHandler("gpt-5.4", "https://api.example.com", {})
        messages = [HumanMessage(content="Hello")]
        body = handler.build_request(messages, None, False, {"service_tier": "flex"})
        assert body["service_tier"] == "flex"

    def test_build_request_with_empty_system_message_content(self):
        """build_request() handles empty string SystemMessage content."""
        handler = _CodexResponsesHandler("gpt-5.4", "https://api.example.com", {})
        messages = [
            SystemMessage(content=""),
            HumanMessage(content="Hello"),
        ]
        body = handler.build_request(messages, None, False, {})
        # Empty string is falsy, so it should not be included
        assert "instructions" not in body

    @pytest.mark.asyncio
    async def test_chat_uses_streaming_endpoint(self):
        """chat() assembles chunks via stream because Codex requires stream=true."""
        handler = _CodexResponsesHandler("gpt-5.4", "https://api.example.com", {})
        seen: dict[str, Any] = {}

        async def fake_stream(messages, tools, merged):
            seen["messages"] = messages
            seen["tools"] = tools
            seen["merged"] = merged
            for text in ("Short", " title"):
                yield ChatCompletionChunk(
                    id="resp_1",
                    created=1,
                    model="gpt-5.4",
                    choices=[
                        ChatCompletionChunkChoice(
                            index=0,
                            delta=ChatCompletionDelta(content=text),
                        )
                    ],
                )

        handler.stream = fake_stream  # type: ignore[method-assign]

        messages = [HumanMessage(content="Hello")]
        result = await handler.chat(messages, None, {"max_tokens": 20})

        assert result.content == "Short title"
        assert seen == {
            "messages": messages,
            "tools": None,
            "merged": {"max_tokens": 20},
        }

    @pytest.mark.asyncio
    async def test_chat_carries_reasoning_items_through(self):
        """chat() must surface the reasoning item emitted mid-stream onto the returned AssistantMessage so it can be persisted
        and replayed on the next turn."""
        handler = _CodexResponsesHandler("gpt-5.4", "https://api.example.com", {})

        async def fake_stream(messages, tools, merged):
            yield ChatCompletionChunk(
                id="resp_1",
                created=1,
                model="gpt-5.4",
                choices=[
                    ChatCompletionChunkChoice(
                        index=0,
                        delta=ChatCompletionDelta(
                            reasoning_item=EncryptedReasoningItem(
                                id="rs_1",
                                encrypted_content="cipher123",
                            ),
                        ),
                    )
                ],
            )
            yield ChatCompletionChunk(
                id="resp_1",
                created=1,
                model="gpt-5.4",
                choices=[
                    ChatCompletionChunkChoice(
                        index=0, delta=ChatCompletionDelta(content="Done")
                    )
                ],
            )

        handler.stream = fake_stream  # type: ignore[method-assign]

        result = await handler.chat([HumanMessage(content="Hello")], None, {})

        assert result.content == "Done"
        assert result.reasoning_items is not None
        assert len(result.reasoning_items) == 1
        assert result.reasoning_items[0].id == "rs_1"
        assert result.reasoning_items[0].encrypted_content == "cipher123"

    @pytest.mark.asyncio
    async def test_chat_carries_multiple_reasoning_items_through(self):
        """chat() captures all mid-stream reasoning items in order."""
        handler = _CodexResponsesHandler("gpt-5.4", "https://api.example.com", {})

        async def fake_stream(messages, tools, merged):
            yield ChatCompletionChunk(
                id="resp_1",
                created=1,
                model="gpt-5.4",
                choices=[
                    ChatCompletionChunkChoice(
                        index=0,
                        delta=ChatCompletionDelta(
                            reasoning_item=EncryptedReasoningItem(
                                id="rs_1",
                                summary=[{"type": "summary_text", "text": "Thought 1"}],
                                encrypted_content="cipher1",
                            ),
                        ),
                    )
                ],
            )
            yield ChatCompletionChunk(
                id="resp_1",
                created=1,
                model="gpt-5.4",
                choices=[
                    ChatCompletionChunkChoice(
                        index=0,
                        delta=ChatCompletionDelta(
                            reasoning_item=EncryptedReasoningItem(
                                id="rs_2",
                                summary=[{"type": "summary_text", "text": "Thought 2"}],
                                encrypted_content="cipher2",
                            ),
                        ),
                    )
                ],
            )
            yield ChatCompletionChunk(
                id="resp_1",
                created=1,
                model="gpt-5.4",
                choices=[
                    ChatCompletionChunkChoice(
                        index=0, delta=ChatCompletionDelta(content="Done")
                    )
                ],
            )

        handler.stream = fake_stream  # type: ignore[method-assign]

        result = await handler.chat([HumanMessage(content="Hello")], None, {})

        assert result.content == "Done"
        assert result.reasoning_items is not None
        assert len(result.reasoning_items) == 2
        assert result.reasoning_items[0].id == "rs_1"
        assert result.reasoning_items[0].encrypted_content == "cipher1"
        assert result.reasoning_items[1].id == "rs_2"
        assert result.reasoning_items[1].encrypted_content == "cipher2"
        assert result.extra is not None
        assert len(result.extra["reasoning_items"]) == 2

    @pytest.mark.asyncio
    async def test_chat_leaves_reasoning_items_none_when_absent(self):
        """No mid-stream reasoning item -> fields stay None (no regression for
        models/turns that don't return one)."""
        handler = _CodexResponsesHandler("gpt-5.4", "https://api.example.com", {})

        async def fake_stream(messages, tools, merged):
            yield ChatCompletionChunk(
                id="resp_1",
                created=1,
                model="gpt-5.4",
                choices=[
                    ChatCompletionChunkChoice(
                        index=0, delta=ChatCompletionDelta(content="Done")
                    )
                ],
            )

        handler.stream = fake_stream  # type: ignore[method-assign]

        result = await handler.chat([HumanMessage(content="Hello")], None, {})

        assert result.reasoning_items is None


# ============================================================================
# CodexProvider.__init__ Tests
# ============================================================================


class TestCodexProviderInit:
    """Test CodexProvider.__init__() — initialization and header setup."""

    def test_init_raises_when_no_oauth_credentials(self):
        """__init__() raises ValueError when no oauth credentials exist."""
        with patch("app.agent.providers.codex.codex._load_token") as mock_load:
            mock_load.side_effect = ValueError("Codex OAuth credentials not found")
            with pytest.raises(ValueError, match="Codex OAuth credentials not found"):
                CodexProvider(model="gpt-5.4")

    def test_init_sets_authorization_header(self):
        """__init__() sets Authorization header with Bearer token."""
        with patch("app.agent.providers.codex.codex._load_token") as mock_load:
            mock_load.return_value = ("access_token_123", "account_789")
            provider = CodexProvider(model="gpt-5.4")

            assert (
                provider._responses.headers["Authorization"]
                == "Bearer access_token_123"
            )

    def test_init_sets_chatgpt_account_id_header_when_present(self):
        """__init__() sets ChatGPT-Account-ID header when account_id is present."""
        with patch("app.agent.providers.codex.codex._load_token") as mock_load:
            mock_load.return_value = ("access_token_123", "account_789")
            provider = CodexProvider(model="gpt-5.4")

            # Upstream codex-rs/model-provider/src/bearer_auth_provider.rs uses
            # the all-caps ``ID`` form.
            assert provider._responses.headers["ChatGPT-Account-ID"] == "account_789"

    def test_init_does_not_set_chatgpt_account_id_header_when_none(self):
        """__init__() does NOT set ChatGPT-Account-ID header when account_id is None."""
        with patch("app.agent.providers.codex.codex._load_token") as mock_load:
            mock_load.return_value = ("access_token_123", None)
            provider = CodexProvider(model="gpt-5.4")

            assert "ChatGPT-Account-ID" not in provider._responses.headers

    def test_init_sets_model(self):
        """__init__() sets the model attribute."""
        with patch("app.agent.providers.codex.codex._load_token") as mock_load:
            mock_load.return_value = ("access_token_123", "account_789")
            provider = CodexProvider(model="gpt-5.4")

            assert provider.model == "gpt-5.4"

    def test_init_includes_default_headers(self):
        """__init__() includes default HTTP and SSE headers."""
        with patch("app.agent.providers.codex.codex._load_token") as mock_load:
            mock_load.return_value = ("access_token_123", "account_789")
            provider = CodexProvider(model="gpt-5.4")

            assert provider._responses.headers["Content-Type"] == "application/json"
            assert provider._responses.headers["Accept"] == "text/event-stream"
            assert provider._responses.headers["User-Agent"] == f"openagentd/{VERSION}"
            assert provider._responses.headers["originator"] == CODEX_ORIGINATOR

    def test_init_creates_responses_handler(self):
        """__init__() creates _CodexResponsesHandler instance."""
        with patch("app.agent.providers.codex.codex._load_token") as mock_load:
            mock_load.return_value = ("access_token_123", "account_789")
            provider = CodexProvider(model="gpt-5.4")

            assert isinstance(provider._responses, _CodexResponsesHandler)
            assert provider._responses.model == "gpt-5.4"

    @respx.mock
    async def test_request_uses_provider_http_client_and_closes_it(self):
        with patch(
            "app.agent.providers.codex.codex._load_token", return_value=("key", None)
        ):
            provider = CodexProvider(model="gpt-5.4")
        route = respx.post("https://chatgpt.com/backend-api/codex/responses").mock(
            return_value=httpx.Response(
                200,
                text=(
                    'data: {"type":"response.created","response":{"id":"r1"}}\n\n'
                    'data: {"type":"response.output_text.delta","delta":"Hi"}\n\n'
                    "data: [DONE]\n\n"
                ),
            )
        )

        response = await provider.chat([HumanMessage(content="Hello")])

        assert response.content == "Hi"
        assert route.called
        request_headers = route.calls[0].request.headers
        assert request_headers["Accept"] == "text/event-stream"
        assert request_headers["x-codex-routing-hint"] == "model=gpt-5.4"
        assert provider._responses.client is provider.http_client
        client = provider.http_client
        await provider.aclose()
        assert client.is_closed

    def test_init_uses_codex_stream_idle_timeout(self):
        """Codex mirrors upstream's 300s stream idle timeout."""
        with patch("app.agent.providers.codex.codex._load_token") as mock_load:
            mock_load.return_value = ("access_token_123", "account_789")
            provider = CodexProvider(model="gpt-5.4")

            assert CODEX_STREAM_IDLE_TIMEOUT_SECONDS == 300.0
            assert provider._responses.request_timeout == 300.0

    def test_init_accepts_max_tokens_parameter(self):
        """__init__() accepts max_tokens parameter."""
        with patch("app.agent.providers.codex.codex._load_token") as mock_load:
            mock_load.return_value = ("access_token_123", "account_789")
            provider = CodexProvider(model="gpt-5.4", max_tokens=2000)

            assert provider.max_tokens == 2000

    def test_init_accepts_model_kwargs(self):
        """__init__() accepts model_kwargs parameter."""
        with patch("app.agent.providers.codex.codex._load_token") as mock_load:
            mock_load.return_value = ("access_token_123", "account_789")
            provider = CodexProvider(
                model="gpt-5.4", model_kwargs={"thinking_level": "high"}
            )

            assert provider.model_kwargs == {"thinking_level": "high"}


# ============================================================================
# app.cli.commands.auth._run_login Tests
# ============================================================================


class TestRunLogin:
    """Test app.cli.commands.auth._run_login() — provider dispatch with device flag."""

    def test_run_login_calls_codex_login_with_device_true(self):
        """_run_login() calls codex.login(device=True) when device=True."""
        call_tracker = {"called": False, "kwargs": {}}

        def codex_login(oauth_path=None, *, device=False):
            call_tracker["called"] = True
            call_tracker["kwargs"] = {"device": device}

        with patch("importlib.import_module") as mock_import:
            mock_module = MagicMock()
            mock_module.login = codex_login
            mock_import.return_value = mock_module

            _run_login("codex", device=True)
            assert call_tracker["called"] is True
            assert call_tracker["kwargs"]["device"] is True

    def test_run_login_calls_codex_login_with_device_false(self):
        """_run_login() calls codex.login(device=False) when device=False."""
        call_tracker = {"called": False, "kwargs": {}}

        def codex_login(oauth_path=None, *, device=False):
            call_tracker["called"] = True
            call_tracker["kwargs"] = {"device": device}

        with patch("importlib.import_module") as mock_import:
            mock_module = MagicMock()
            mock_module.login = codex_login
            mock_import.return_value = mock_module

            _run_login("codex", device=False)
            assert call_tracker["called"] is True
            assert call_tracker["kwargs"]["device"] is False

    def test_run_login_calls_copilot_login_without_device(self):
        """_run_login() calls copilot.login() without device kwarg."""
        call_tracker = {"called": False, "kwargs": {}}

        def copilot_login(oauth_path=None):
            call_tracker["called"] = True
            call_tracker["kwargs"] = {}

        with patch("importlib.import_module") as mock_import:
            mock_module = MagicMock()
            mock_module.login = copilot_login
            mock_import.return_value = mock_module

            # device=True is passed but should be filtered out
            _run_login("copilot", device=True)
            assert call_tracker["called"] is True
            assert "device" not in call_tracker["kwargs"]

    def test_run_login_filters_kwargs_based_on_signature(self):
        """_run_login() only passes kwargs that the login() function accepts."""
        call_tracker = {"called": False, "kwargs": {}}

        def selective_login(*, device=False):
            call_tracker["called"] = True
            call_tracker["kwargs"] = {"device": device}

        with patch("importlib.import_module") as mock_import:
            mock_module = MagicMock()
            mock_module.login = selective_login
            mock_import.return_value = mock_module

            # Pass both device and unknown_param, only device should be passed
            _run_login("codex", device=True, unknown_param=False)
            assert call_tracker["called"] is True
            assert call_tracker["kwargs"]["device"] is True

    def test_run_login_raises_on_unknown_provider(self):
        """_run_login() raises SystemExit on unknown provider."""
        with pytest.raises(SystemExit):
            _run_login("unknown_provider", device=False)


# ============================================================================
# Integration Tests
# ============================================================================


class TestCodexProviderIntegration:
    """Integration tests for CodexProvider with mocked HTTP."""

    def test_provider_initialization_flow(self, tmp_path):
        """Full provider initialization with mocked token loading."""
        oauth_file = tmp_path / "codex_oauth.json"
        oauth = CodexOAuth(
            access_token=SecretStr("access_123"),
            refresh_token=SecretStr("refresh_456"),
            expires_at=time.time() + 3600,
            account_id="account_789",
        )
        oauth.save(oauth_file)

        with patch("app.agent.providers.codex.codex.CodexOAuth.load") as mock_load:
            mock_load.return_value = oauth
            provider = CodexProvider(model="gpt-5.4")

            assert provider.model == "gpt-5.4"
            assert provider._responses.headers["Authorization"] == "Bearer access_123"
            assert provider._responses.headers["ChatGPT-Account-ID"] == "account_789"

    def test_build_request_with_complex_message_flow(self):
        """Test build_request with realistic message flow."""
        handler = _CodexResponsesHandler("gpt-5.4", "https://api.example.com", {})
        messages = [
            SystemMessage(content="You are a helpful assistant"),
            HumanMessage(content="What is 2+2?"),
            AssistantMessage(content="2+2 equals 4"),
            HumanMessage(content="And 3+3?"),
        ]
        body = handler.build_request(messages, None, False, {})

        assert body["instructions"] == "You are a helpful assistant"
        assert body["store"] is False
        assert body["model"] == "gpt-5.4"
        # Should have 3 non-system messages
        assert len(body["input"]) == 3


class TestCodexPromptCachingAndReasoning:
    """Tests verifying prompt caching prefix matching and reasoning continuity."""

    def test_assistant_message_reasoning_extra_sync_and_roundtrip(self):
        """AssistantMessage syncs reasoning_items to extra and roundtrips via model_dump_full."""
        msg = AssistantMessage(
            content="Answer",
            reasoning_content="Thinking",
            reasoning_items=[
                EncryptedReasoningItem(
                    id="rs_123",
                    encrypted_content="enc_cipher",
                )
            ],
        )
        assert msg.extra["reasoning_items"] == [
            {"id": "rs_123", "summary": [], "encrypted_content": "enc_cipher"}
        ]

        dumped_full = msg.model_dump_full()
        assert dumped_full["extra"]["reasoning_items"] == [
            {"id": "rs_123", "summary": [], "encrypted_content": "enc_cipher"}
        ]

        # Restoring from dump populates instance fields back from extra.
        restored = AssistantMessage.model_validate(dumped_full)
        assert restored.reasoning_items is not None
        assert restored.reasoning_items[0].id == "rs_123"
        assert restored.reasoning_items[0].encrypted_content == "enc_cipher"

    def test_convert_messages_omits_id_when_reasoning_item_id_none(self):
        """Reasoning items without a reasoning_item_id omit the 'id' key entirely."""
        handler = _CodexResponsesHandler("gpt-5.4", "https://api.example.com", {})
        msg = AssistantMessage(
            content="Done",
            reasoning_content="Reasoning text",
            reasoning_items=[
                EncryptedReasoningItem(
                    id=None,
                    encrypted_content="encrypted_blob",
                )
            ],
        )
        items = handler.convert_messages([msg])
        reasoning_item = items[0]
        assert reasoning_item["type"] == "reasoning"
        assert "id" not in reasoning_item
        assert reasoning_item["encrypted_content"] == "encrypted_blob"

    def test_build_request_adds_type_message_to_user_and_assistant_items(self):
        """User and assistant message items are tagged with type: 'message' for Codex."""
        handler = _CodexResponsesHandler("gpt-5.4", "https://api.example.com", {})
        messages = [
            HumanMessage(content="Question"),
            AssistantMessage(content="Answer"),
        ]
        body = handler.build_request(messages, None, False, {})
        assert body["input"][0]["type"] == "message"
        assert body["input"][1]["type"] == "message"

    def test_build_request_defaults_reasoning_effort_to_medium(self):
        """When thinking_level is omitted, reasoning effort defaults to 'medium'."""
        handler = _CodexResponsesHandler("gpt-5.4", "https://api.example.com", {})
        messages = [HumanMessage(content="Hi")]
        body = handler.build_request(messages, None, False, {})
        assert body["reasoning"] == {"effort": "medium", "summary": "auto"}

    def test_multiturn_prompt_cache_prefix_and_reasoning_continuity(self):
        """Turn 2 preserves Turn 1 prefix in input and replays reasoning item correctly."""
        handler = _CodexResponsesHandler("gpt-5.4", "https://api.example.com", {})

        # Turn 1
        turn1_messages = [
            SystemMessage(content="Instructions"),
            HumanMessage(content="Turn 1 user"),
        ]
        body1 = handler.build_request(turn1_messages, None, False, {})

        # Model responds with AssistantMessage carrying reasoning_encrypted_content
        turn1_assistant = AssistantMessage(
            content="Turn 1 response",
            reasoning_content="Turn 1 thinking",
            reasoning_items=[
                EncryptedReasoningItem(
                    id="rs_1",
                    summary=[{"type": "summary_text", "text": "Turn 1 thinking"}],
                    encrypted_content="enc_turn_1",
                )
            ],
        )

        # Turn 2
        turn2_messages = [
            SystemMessage(content="Instructions"),
            HumanMessage(content="Turn 1 user"),
            turn1_assistant,
            HumanMessage(content="Turn 2 user"),
        ]
        body2 = handler.build_request(turn2_messages, None, False, {})

        # Instructions match across turns
        assert body1["instructions"] == body2["instructions"] == "Instructions"

        # Reasoning config matches across turns
        assert (
            body1["reasoning"]
            == body2["reasoning"]
            == {"effort": "medium", "summary": "auto"}
        )

        # Input item 0 in turn 2 matches turn 1 input item 0 exactly
        assert body2["input"][0] == body1["input"][0]

        # Input item 1 in turn 2 is the replayed reasoning item
        assert body2["input"][1] == {
            "type": "reasoning",
            "id": "rs_1",
            "summary": [{"type": "summary_text", "text": "Turn 1 thinking"}],
            "encrypted_content": "enc_turn_1",
        }

        # Input item 2 is the assistant message
        assert body2["input"][2] == {
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": "Turn 1 response"}],
        }

    def test_multiturn_replays_all_encrypted_reasoning_items_in_order(self):
        """Every completed Responses reasoning item must survive tool continuation."""
        handler = _CodexResponsesHandler("gpt-5.4", "https://api.example.com", {})
        assistant = AssistantMessage(
            content="Calling a tool.",
            reasoning_items=[
                {
                    "id": "rs_1",
                    "summary": [{"type": "summary_text", "text": "First thought"}],
                    "encrypted_content": "cipher-1",
                },
                {
                    "id": "rs_2",
                    "summary": [{"type": "summary_text", "text": "Second thought"}],
                    "encrypted_content": "cipher-2",
                },
            ],
            tool_calls=[
                ToolCall(
                    id="call_1",
                    function=FunctionCall(name="read_file", arguments="{}"),
                )
            ],
        )

        body = handler.build_request(
            [
                HumanMessage(content="Read the file"),
                assistant,
                ToolMessage(content="file contents", tool_call_id="call_1"),
            ],
            None,
            True,
            {},
        )

        assert body["input"][1:3] == [
            {
                "type": "reasoning",
                "id": "rs_1",
                "summary": [{"type": "summary_text", "text": "First thought"}],
                "encrypted_content": "cipher-1",
            },
            {
                "type": "reasoning",
                "id": "rs_2",
                "summary": [{"type": "summary_text", "text": "Second thought"}],
                "encrypted_content": "cipher-2",
            },
        ]

    def test_consecutive_turns_cache_key_routing_header_and_shared_prefix(self):
        """Consecutive turns keep stable cache key, session-id header, and prefix."""
        handler = _CodexResponsesHandler("gpt-5.4", "https://api.example.com", {})
        session_id = "session-test-456"

        # Turn 1
        t1_messages = [
            SystemMessage(content="You are a coder."),
            HumanMessage(content="Write a hello function"),
        ]
        body1 = handler.build_request(
            t1_messages, None, True, {"session_id": session_id}
        )
        headers1 = handler._prepare_request_headers(body1)

        assert body1["prompt_cache_key"] == session_id
        assert headers1["session-id"] == session_id
        assert body1["instructions"] == "You are a coder."
        assert body1["input"] == [
            {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "Write a hello function"}],
            }
        ]

        # Model outputs response with multiple reasoning items
        assistant_t1 = AssistantMessage(
            content="def hello(): return 'hello'",
            reasoning_items=[
                {
                    "id": "rs_1",
                    "summary": [{"type": "summary_text", "text": "Planning hello"}],
                    "encrypted_content": "enc_plan",
                },
                {
                    "id": "rs_2",
                    "summary": [{"type": "summary_text", "text": "Implementing hello"}],
                    "encrypted_content": "enc_impl",
                },
            ],
        )

        # Turn 2
        t2_messages = [
            SystemMessage(content="You are a coder."),
            HumanMessage(content="Write a hello function"),
            assistant_t1,
            HumanMessage(content="Add docstring"),
        ]
        body2 = handler.build_request(
            t2_messages, None, True, {"session_id": session_id}
        )
        headers2 = handler._prepare_request_headers(body2)

        assert body2["prompt_cache_key"] == session_id
        assert headers2["session-id"] == session_id
        assert body2["instructions"] == "You are a coder."

        # Turn 1's input item 0 is byte/dict-identical in Turn 2
        assert body2["input"][0] == body1["input"][0]

        # Turn 2 input items 1 & 2 are the replayed reasoning items in order
        assert body2["input"][1] == {
            "type": "reasoning",
            "id": "rs_1",
            "summary": [{"type": "summary_text", "text": "Planning hello"}],
            "encrypted_content": "enc_plan",
        }
        assert body2["input"][2] == {
            "type": "reasoning",
            "id": "rs_2",
            "summary": [{"type": "summary_text", "text": "Implementing hello"}],
            "encrypted_content": "enc_impl",
        }

        # Turn 2 input item 3 is the assistant message
        assert body2["input"][3] == {
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": "def hello(): return 'hello'"}],
        }

        # Turn 2 input item 4 is the new user prompt
        assert body2["input"][4] == {
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "Add docstring"}],
        }


# ============================================================================
# Codex chat() tool-call assembly
# ============================================================================


class TestCodexChatToolCalls:
    """``chat()`` reads the required stream, so it must assemble tool calls too.

    Verified against the live endpoint: a Codex turn that answers with a
    ``function_call`` item streams tool-call deltas and no content, so a
    handler that only accumulates content returns an empty message and the
    caller sees the turn as "the model did nothing".
    """

    @pytest.mark.asyncio
    async def test_chat_assembles_tool_calls_from_stream(self):
        handler = _CodexResponsesHandler("gpt-5.4", "https://api.example.com", {})

        async def fake_stream(messages, tools, merged):
            for delta in (
                ToolCallDelta(
                    index=0,
                    id="call_1",
                    function=FunctionCallDelta(name="get_weather", arguments=""),
                ),
                ToolCallDelta(
                    index=0, function=FunctionCallDelta(arguments='{"city":')
                ),
                ToolCallDelta(
                    index=0, function=FunctionCallDelta(arguments='"Hanoi"}')
                ),
            ):
                yield ChatCompletionChunk(
                    id="resp_1",
                    created=1,
                    model="gpt-5.4",
                    choices=[
                        ChatCompletionChunkChoice(
                            index=0,
                            delta=ChatCompletionDelta(tool_calls=[delta]),
                        )
                    ],
                )

        handler.stream = fake_stream  # type: ignore[method-assign]

        result = await handler.chat([HumanMessage(content="weather?")], None, {})

        assert result.tool_calls is not None
        assert len(result.tool_calls) == 1
        assert result.tool_calls[0].id == "call_1"
        assert result.tool_calls[0].function.name == "get_weather"
        assert result.tool_calls[0].function.arguments == '{"city":"Hanoi"}'

    @pytest.mark.asyncio
    async def test_chat_assembles_parallel_tool_calls_in_index_order(self):
        handler = _CodexResponsesHandler("gpt-5.4", "https://api.example.com", {})

        async def fake_stream(messages, tools, merged):
            for delta in (
                ToolCallDelta(
                    index=0,
                    id="call_a",
                    function=FunctionCallDelta(name="read", arguments='{"p":1}'),
                ),
                ToolCallDelta(
                    index=1,
                    id="call_b",
                    function=FunctionCallDelta(name="grep", arguments='{"q":"x"}'),
                ),
            ):
                yield ChatCompletionChunk(
                    id="resp_1",
                    created=1,
                    model="gpt-5.4",
                    choices=[
                        ChatCompletionChunkChoice(
                            index=0,
                            delta=ChatCompletionDelta(tool_calls=[delta]),
                        )
                    ],
                )

        handler.stream = fake_stream  # type: ignore[method-assign]

        result = await handler.chat([HumanMessage(content="go")], None, {})

        assert [tc.id for tc in result.tool_calls or []] == ["call_a", "call_b"]
        assert [tc.function.name for tc in result.tool_calls or []] == ["read", "grep"]

    @pytest.mark.asyncio
    async def test_chat_without_tool_calls_leaves_field_none(self):
        handler = _CodexResponsesHandler("gpt-5.4", "https://api.example.com", {})

        async def fake_stream(messages, tools, merged):
            yield ChatCompletionChunk(
                id="resp_1",
                created=1,
                model="gpt-5.4",
                choices=[
                    ChatCompletionChunkChoice(
                        index=0, delta=ChatCompletionDelta(content="hi")
                    )
                ],
            )

        handler.stream = fake_stream  # type: ignore[method-assign]

        result = await handler.chat([HumanMessage(content="hi")], None, {})

        assert result.tool_calls is None


# ============================================================================
# x-codex-turn-state sticky routing
# ============================================================================


class TestCodexTurnStateStickyRouting:
    """Upstream captures ``x-codex-turn-state`` from the first response of a
    turn and replays it on every later request *within that same turn*, and
    never across turns (codex-rs/core/src/client.rs: ``ModelClientSession``).
    """

    def test_turn_state_is_not_sent_before_the_server_issues_one(self):
        handler = _CodexResponsesHandler(
            "gpt-5.4", "https://api.example.com", {"Authorization": "Bearer t"}
        )
        handler.build_request([HumanMessage(content="Hi")], None, True, {})

        headers = handler._prepare_request_headers({})

        assert "x-codex-turn-state" not in headers
        assert headers["x-codex-routing-hint"] == "model=gpt-5.4"
        assert headers["Authorization"] == "Bearer t"

    def test_routing_hint_includes_the_resolved_service_tier(self):
        handler = _CodexResponsesHandler(
            "gpt-5.4", "https://api.example.com", {"Authorization": "Bearer t"}
        )
        body = handler.build_request(
            [HumanMessage(content="Hi")], None, True, {"service_tier": "fast"}
        )

        assert body["service_tier"] == "priority"
        assert handler._prepare_request_headers(body)["x-codex-routing-hint"] == (
            "model=gpt-5.4;tier=priority"
        )

    def test_reasoning_summary_uses_cached_model_capability(self):
        with patch(
            "app.agent.providers.codex.codex.cached_codex_catalog",
            return_value={
                "models": [
                    {
                        "slug": "gpt-no-summary",
                        "supports_reasoning_summary_parameter": False,
                    }
                ]
            },
        ):
            handler = _CodexResponsesHandler(
                "gpt-no-summary", "https://api.example.com", {}
            )

        body = handler.build_request(
            [HumanMessage(content="Hi")], None, True, {"thinking_level": "high"}
        )

        assert body["reasoning"] == {"effort": "high"}

    def test_turn_state_replays_on_continuation_requests_of_the_same_turn(self):
        handler = _CodexResponsesHandler(
            "gpt-5.4", "https://api.example.com", {"Authorization": "Bearer t"}
        )
        handler.build_request([HumanMessage(content="Hi")], None, True, {})
        handler.on_response_headers({"x-codex-turn-state": "state-token-1"})

        # Continuation request: the turn resumes after a tool result.
        handler.build_request(
            [
                HumanMessage(content="Hi"),
                AssistantMessage(content=None),
                ToolMessage(content="ok", tool_call_id="call_1"),
            ],
            None,
            True,
            {},
        )
        headers = handler._prepare_request_headers({})

        assert headers["x-codex-turn-state"] == "state-token-1"

    def test_turn_state_is_dropped_when_a_new_user_turn_starts(self):
        handler = _CodexResponsesHandler(
            "gpt-5.4", "https://api.example.com", {"Authorization": "Bearer t"}
        )
        handler.build_request([HumanMessage(content="Hi")], None, True, {})
        handler.on_response_headers({"x-codex-turn-state": "state-token-1"})

        # New user turn — upstream must not leak the previous turn's token.
        handler.build_request(
            [
                HumanMessage(content="Hi"),
                AssistantMessage(content="Done"),
                HumanMessage(content="Next question"),
            ],
            None,
            True,
            {},
        )
        headers = handler._prepare_request_headers({})

        assert "x-codex-turn-state" not in headers

    def test_first_token_of_a_turn_wins(self):
        """Within one turn the token is fixed at turn start; later responses
        must not overwrite it."""
        handler = _CodexResponsesHandler(
            "gpt-5.4", "https://api.example.com", {"Authorization": "Bearer t"}
        )
        handler.build_request([HumanMessage(content="Hi")], None, True, {})
        handler.on_response_headers({"x-codex-turn-state": "state-token-1"})
        handler.build_request(
            [
                HumanMessage(content="Hi"),
                AssistantMessage(content=None),
                ToolMessage(content="ok", tool_call_id="call_1"),
            ],
            None,
            True,
            {},
        )
        handler.on_response_headers({"x-codex-turn-state": "state-token-2"})

        assert handler._prepare_request_headers({})["x-codex-turn-state"] == (
            "state-token-1"
        )

    def test_base_handler_ignores_response_headers(self):
        """The hook is a no-op for non-Codex Responses endpoints."""
        from app.agent.providers.openai.responses import ResponsesHandler

        handler = ResponsesHandler("gpt-5.4", "https://api.openai.com/v1", {})
        handler.on_response_headers({"x-codex-turn-state": "state-token-1"})

        assert not hasattr(handler, "_turn_state")

    @respx.mock
    async def test_turn_state_round_trips_through_a_real_stream_request(self):
        """End-to-end wiring: header captured off response 1, sent on the tool
        continuation, and dropped again when the next user turn starts."""
        with patch(
            "app.agent.providers.codex.codex._load_token", return_value=("key", None)
        ):
            provider = CodexProvider(model="gpt-5.4")
        body = (
            'data: {"type":"response.created","response":{"id":"r1"}}\n\n'
            'data: {"type":"response.output_text.delta","delta":"Hi"}\n\n'
            "data: [DONE]\n\n"
        )
        route = respx.post("https://chatgpt.com/backend-api/codex/responses").mock(
            return_value=httpx.Response(
                200, text=body, headers={"x-codex-turn-state": "state-1"}
            )
        )

        assistant = AssistantMessage(
            content=None,
            tool_calls=[
                ToolCall(id="call_1", function=FunctionCall(name="ls", arguments="{}"))
            ],
        )
        await provider.chat([HumanMessage(content="Hello")])
        await provider.chat(
            [
                HumanMessage(content="Hello"),
                assistant,
                ToolMessage(content="ok", tool_call_id="call_1"),
            ]
        )
        await provider.chat([HumanMessage(content="Next turn")])

        sent = [call.request.headers.get("x-codex-turn-state") for call in route.calls]
        assert sent == [None, "state-1", None]
        await provider.aclose()
