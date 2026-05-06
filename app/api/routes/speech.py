"""``/api/speech`` endpoints — voice input config and transcription."""

from __future__ import annotations

import asyncio
import io

from fastapi import APIRouter, HTTPException, UploadFile
from loguru import logger

from app.agent.speech._config import get_voice_config, save_speech_config
from app.api.schemas.speech import SpeechConfigBody, SpeechConfigResponse, TranscribeResponse

router = APIRouter()

# Accepted audio MIME type prefixes.
# Chromium MediaRecorder produces audio/webm; Firefox produces audio/ogg.
_ACCEPTED_AUDIO_PREFIXES = ("audio/",)

# Fallback public model name used in the disabled-voice response.
_DISABLED_MODEL = "local:base"

# ── WhisperModel cache ────────────────────────────────────────────────────────
# Loading model weights is expensive (~seconds). Cache the instance
# process-wide so repeated calls reuse the same loaded model.
# Key: (model_name, device, compute_type).
_whisper_cache: dict[tuple[str, str, str], object] = {}


@router.get("/config")
async def get_speech_config() -> SpeechConfigResponse:
    """Return safe UI config from ``speech.yaml`` — no secrets."""
    cfg = get_voice_config()
    if cfg is None:
        return SpeechConfigResponse(
            enabled=False,
            model=_DISABLED_MODEL,
            language="auto",
            max_file_mb=25,
        )
    return SpeechConfigResponse(
        enabled=True,
        model=f"{cfg.provider}:{cfg.model}",
        language=cfg.language,
        max_file_mb=cfg.max_file_mb,
    )


@router.put("/config")
async def update_speech_config(body: SpeechConfigBody) -> SpeechConfigResponse:
    """Persist the voice config to ``speech.yaml`` and return the saved state."""
    try:
        save_speech_config(
            enabled=body.enabled,
            model=body.model,
            language=body.language,
            max_file_mb=body.max_file_mb,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    logger.info(
        "speech_config_updated enabled={} model={} language={} max_file_mb={}",
        body.enabled, body.model, body.language, body.max_file_mb,
    )
    return SpeechConfigResponse(
        enabled=body.enabled,
        model=body.model,
        language=body.language,
        max_file_mb=body.max_file_mb,
    )


@router.post("/transcribe")
async def transcribe_audio(file: UploadFile) -> TranscribeResponse:
    """Transcribe one uploaded audio recording.

    Accepts ``multipart/form-data`` with a single ``file`` field containing
    browser ``MediaRecorder`` output (``audio/webm`` Opus in Chromium,
    ``audio/ogg`` in Firefox).

    Returns ``{text: ""}`` for silent recordings so the UI can avoid
    modifying the input.
    """
    cfg = get_voice_config()
    if cfg is None:
        raise HTTPException(
            status_code=503,
            detail=(
                "Voice input is disabled. "
                "Enable it in speech.yaml to use voice transcription."
            ),
        )

    # ── Validate MIME type ────────────────────────────────────────────────────
    content_type = (file.content_type or "").lower()
    if not any(content_type.startswith(p) for p in _ACCEPTED_AUDIO_PREFIXES):
        raise HTTPException(
            status_code=415,
            detail=(
                f"Unsupported audio type '{content_type}'. "
                "Upload an audio/webm or audio/ogg file."
            ),
        )

    # ── Read and size-check ───────────────────────────────────────────────────
    max_bytes = cfg.max_file_mb * 1024 * 1024
    audio_bytes = await file.read(max_bytes + 1)
    if len(audio_bytes) > max_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"Audio file exceeds the {cfg.max_file_mb} MB limit.",
        )

    if not audio_bytes:
        raise HTTPException(status_code=422, detail="Uploaded file is empty.")

    # ── Dispatch to provider ──────────────────────────────────────────────────
    if cfg.provider == "local":
        text = await _transcribe_local(audio_bytes, cfg.model, cfg.language)
    else:
        raise HTTPException(
            status_code=501,
            detail=(
                f"Voice provider '{cfg.provider}' is not supported in V1. "
                "Use 'local:base'."
            ),
        )

    logger.info(
        "speech_transcribed provider={} model={} bytes={} chars={}",
        cfg.provider, cfg.model, len(audio_bytes), len(text),
    )
    return TranscribeResponse(text=text)


async def _transcribe_local(audio_bytes: bytes, model: str, language: str) -> str:
    """Transcribe using faster-whisper (``voice-local`` optional extra).

    Lazy-imports ``faster_whisper`` so the base server starts without it.
    The ``WhisperModel`` instance is cached process-wide to avoid reloading
    weights on every request.
    """
    try:
        import faster_whisper  # noqa: F401 — availability probe
    except ImportError as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                "Local speech-to-text requires the 'voice-local' extra. "
                "Install it with: uv sync --extra voice-local  "
                "or: uv tool install 'openagentd[voice-local]'"
            ),
        ) from exc

    cache_key = (model, "cpu", "int8")

    def _run() -> str:
        from faster_whisper import WhisperModel

        wmodel = _whisper_cache.get(cache_key)
        if wmodel is None:
            wmodel = WhisperModel(model, device="cpu", compute_type="int8")
            _whisper_cache[cache_key] = wmodel

        whisper_language = None if language == "auto" else language
        segments, _ = wmodel.transcribe(  # ty: ignore[unresolved-attribute]
            io.BytesIO(audio_bytes),
            language=whisper_language,
            beam_size=5,
        )
        return "".join(seg.text for seg in segments).strip()

    return await asyncio.to_thread(_run)
