"""Tests for app/api/routes/speech.py — voice config and transcription endpoints."""

from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes.speech import router


def _make_app() -> FastAPI:
    app = FastAPI()
    app.include_router(router, prefix="/api/speech")
    return app


# ── GET /api/speech/config ────────────────────────────────────────────────────


def test_config_voice_disabled_when_no_section() -> None:
    """Missing voice section returns enabled=False with safe defaults."""
    with patch("app.api.routes.speech.get_voice_config", return_value=None):
        client = TestClient(_make_app())
        resp = client.get("/api/speech/config")

    assert resp.status_code == 200
    body = resp.json()
    assert body["enabled"] is False
    assert body["model"] == "local:base"
    assert body["language"] == "auto"
    assert body["max_file_mb"] == 25


def test_config_returns_voice_settings_when_enabled() -> None:
    """Enabled voice config is reflected in the response."""
    from app.agent.speech._config import VoiceConfig

    cfg = VoiceConfig(
        provider="local",
        model="base",
        language="en",
        max_file_mb=10,
    )
    with patch("app.api.routes.speech.get_voice_config", return_value=cfg):
        client = TestClient(_make_app())
        resp = client.get("/api/speech/config")

    assert resp.status_code == 200
    body = resp.json()
    assert body["enabled"] is True
    assert body["model"] == "local:base"
    assert body["language"] == "en"
    assert body["max_file_mb"] == 10


# ── POST /api/speech/transcribe ───────────────────────────────────────────────


def test_transcribe_returns_503_when_voice_disabled() -> None:
    """POST /transcribe rejects when voice is disabled."""
    with patch("app.api.routes.speech.get_voice_config", return_value=None):
        client = TestClient(_make_app())
        resp = client.post(
            "/api/speech/transcribe",
            files={"file": ("rec.webm", b"fake", "audio/webm")},
        )

    assert resp.status_code == 503
    assert "disabled" in resp.json()["detail"].lower()


def test_transcribe_rejects_non_audio_mime() -> None:
    """POST /transcribe returns 415 for non-audio MIME types."""
    from app.agent.speech._config import VoiceConfig

    cfg = VoiceConfig(provider="local", model="base", language="auto", max_file_mb=25)
    with patch("app.api.routes.speech.get_voice_config", return_value=cfg):
        client = TestClient(_make_app())
        resp = client.post(
            "/api/speech/transcribe",
            files={"file": ("img.png", b"fake", "image/png")},
        )

    assert resp.status_code == 415
    assert "Unsupported" in resp.json()["detail"]


def test_transcribe_rejects_oversized_file() -> None:
    """POST /transcribe returns 413 when the file exceeds max_file_mb."""
    from app.agent.speech._config import VoiceConfig

    cfg = VoiceConfig(provider="local", model="base", language="auto", max_file_mb=1)
    big_audio = b"x" * (1 * 1024 * 1024 + 1)  # 1 MB + 1 byte
    with patch("app.api.routes.speech.get_voice_config", return_value=cfg):
        client = TestClient(_make_app())
        resp = client.post(
            "/api/speech/transcribe",
            files={"file": ("rec.webm", big_audio, "audio/webm")},
        )

    assert resp.status_code == 413
    assert "limit" in resp.json()["detail"].lower()


def test_transcribe_rejects_empty_file() -> None:
    """POST /transcribe returns 422 for a zero-byte upload."""
    from app.agent.speech._config import VoiceConfig

    cfg = VoiceConfig(provider="local", model="base", language="auto", max_file_mb=25)
    with patch("app.api.routes.speech.get_voice_config", return_value=cfg):
        client = TestClient(_make_app())
        resp = client.post(
            "/api/speech/transcribe",
            files={"file": ("rec.webm", b"", "audio/webm")},
        )

    assert resp.status_code == 422
    assert "empty" in resp.json()["detail"].lower()


def test_transcribe_returns_503_when_faster_whisper_missing() -> None:
    """When faster-whisper is not installed a clear setup error is returned."""
    from app.agent.speech._config import VoiceConfig

    cfg = VoiceConfig(provider="local", model="base", language="auto", max_file_mb=25)

    with patch("app.api.routes.speech.get_voice_config", return_value=cfg):
        with patch.dict("sys.modules", {"faster_whisper": None}):
            client = TestClient(_make_app())
            resp = client.post(
                "/api/speech/transcribe",
                files={"file": ("rec.webm", b"fake audio bytes", "audio/webm")},
            )

    assert resp.status_code == 503
    detail = resp.json()["detail"]
    assert "voice-local" in detail
    assert "openagentd[voice-local]" in detail


@pytest.mark.asyncio
async def test_transcribe_returns_text_on_success() -> None:
    """Successful local transcription returns {text: '...'}."""
    from app.agent.speech._config import VoiceConfig
    from httpx import ASGITransport, AsyncClient

    cfg = VoiceConfig(provider="local", model="base", language="auto", max_file_mb=25)

    async def _fake_transcribe(audio_bytes: bytes, model: str, language: str) -> str:
        return "hello world"

    app = _make_app()
    with patch("app.api.routes.speech.get_voice_config", return_value=cfg):
        with patch("app.api.routes.speech._transcribe_local", side_effect=_fake_transcribe):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post(
                    "/api/speech/transcribe",
                    files={"file": ("rec.webm", b"fake audio bytes", "audio/webm")},
                )

    assert resp.status_code == 200
    assert resp.json() == {"text": "hello world"}


@pytest.mark.asyncio
async def test_transcribe_returns_empty_text_for_silence() -> None:
    """Transcriptions that produce empty text still return {text: ''} (no error)."""
    from app.agent.speech._config import VoiceConfig
    from httpx import ASGITransport, AsyncClient

    cfg = VoiceConfig(provider="local", model="base", language="auto", max_file_mb=25)

    async def _fake_silent(_bytes: bytes, _model: str, _lang: str) -> str:
        return ""

    app = _make_app()
    with patch("app.api.routes.speech.get_voice_config", return_value=cfg):
        with patch("app.api.routes.speech._transcribe_local", side_effect=_fake_silent):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post(
                    "/api/speech/transcribe",
                    files={"file": ("rec.webm", b"silence bytes", "audio/webm")},
                )

    assert resp.status_code == 200
    assert resp.json() == {"text": ""}


def test_transcribe_returns_501_for_unknown_provider() -> None:
    """Unsupported provider returns 501 with a helpful message."""
    from app.agent.speech._config import VoiceConfig

    cfg = VoiceConfig(provider="openai", model="whisper-1", language="auto", max_file_mb=25)
    with patch("app.api.routes.speech.get_voice_config", return_value=cfg):
        client = TestClient(_make_app())
        resp = client.post(
            "/api/speech/transcribe",
            files={"file": ("rec.webm", b"fake audio bytes", "audio/webm")},
        )

    assert resp.status_code == 501
    assert "local:base" in resp.json()["detail"]


# ── PUT /api/speech/config ────────────────────────────────────────────────────


def test_update_config_returns_echoed_body() -> None:
    """PUT /config persists the body and returns the same values."""
    with patch("app.api.routes.speech.save_speech_config") as save_mock:
        client = TestClient(_make_app())
        resp = client.put(
            "/api/speech/config",
            json={
                "enabled": True,
                "model": "local:base",
                "language": "en",
                "max_file_mb": 12,
            },
        )

    assert resp.status_code == 200
    assert resp.json() == {
        "enabled": True,
        "model": "local:base",
        "language": "en",
        "max_file_mb": 12,
    }
    save_mock.assert_called_once_with(
        enabled=True,
        model="local:base",
        language="en",
        max_file_mb=12,
    )


def test_update_config_rejects_model_without_colon() -> None:
    """PUT /config returns 422 when save_speech_config rejects the model."""
    with patch(
        "app.api.routes.speech.save_speech_config",
        side_effect=ValueError("Invalid model 'localbase': expected 'provider:name'"),
    ):
        client = TestClient(_make_app())
        resp = client.put(
            "/api/speech/config",
            json={
                "enabled": True,
                "model": "localbase",
                "language": "en",
                "max_file_mb": 12,
            },
        )

    assert resp.status_code == 422
    assert "provider:name" in resp.json()["detail"]


def test_update_config_rejects_empty_language() -> None:
    """PUT /config is blocked by Pydantic when language is empty."""
    with patch("app.api.routes.speech.save_speech_config") as save_mock:
        client = TestClient(_make_app())
        resp = client.put(
            "/api/speech/config",
            json={
                "enabled": True,
                "model": "local:base",
                "language": "",
                "max_file_mb": 12,
            },
        )

    assert resp.status_code == 422
    save_mock.assert_not_called()


def test_update_config_rejects_zero_max_file_mb() -> None:
    """PUT /config is blocked by Pydantic when max_file_mb is not positive."""
    with patch("app.api.routes.speech.save_speech_config") as save_mock:
        client = TestClient(_make_app())
        resp = client.put(
            "/api/speech/config",
            json={
                "enabled": True,
                "model": "local:base",
                "language": "en",
                "max_file_mb": 0,
            },
        )

    assert resp.status_code == 422
    save_mock.assert_not_called()
