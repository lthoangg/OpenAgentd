"""Google GenAI (Gemini) image backend — ``models/<name>:generateContent``.

Auth: reads ``settings.GOOGLE_API_KEY`` (loaded from ``.env``) and falls back to
``os.getenv("GOOGLE_API_KEY")`` for runtime overrides. Intentionally not
configurable via YAML — the multimodal config only names a provider and model;
each backend owns its credential lookup.

Endpoint: both generate and edit hit the same ``:generateContent`` URL — they
differ only in the ``parts`` payload (text-only vs. text + ``inline_data``).

Response: Gemini returns the image as base64 in ``candidates[0].content.parts[*]
.inline_data.data``; we pick the first part whose ``mime_type`` starts with
``image/``. Text parts emitted alongside the image are logged and discarded.

Per-call overrides accepted: ``aspect_ratio`` → ``generationConfig.imageConfig.
aspectRatio``, ``image_size`` → ``imageConfig.imageSize``. YAML extras under
the same snake_case keys act as defaults; overrides win. OpenAI-only extras
(``size``, ``output_format``, ``quality``) are silently ignored.
"""

from __future__ import annotations

import base64
import mimetypes
import os
from typing import Any

import httpx2
from loguru import logger

from app.agent.tools.multimodalities._config import MediaSectionConfig
from app.core.config import settings

_GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models"
_REQUEST_TIMEOUT_SECONDS = 120.0

# Per Gemini 3.1 Flash Image Preview docs — surfacing a clear error before the
# round-trip avoids a slow failure.
_MAX_EDIT_IMAGES = 14

# YAML extras + per-call overrides the backend passes through to
# ``generationConfig.imageConfig``. Snake-case inbound; camelCase on the wire.
_IMAGE_CONFIG_KEYS: dict[str, str] = {
    "aspect_ratio": "aspectRatio",
    "image_size": "imageSize",
}


def _resolve_api_key() -> str:
    """Return the Google API key, preferring settings then env; empty if unset."""
    if settings.GOOGLE_API_KEY:
        return settings.GOOGLE_API_KEY.get_secret_value()
    return os.getenv("GOOGLE_API_KEY", "")


def _missing_key_error() -> str:
    return (
        "Error: GOOGLE_API_KEY is unset — cannot call Gemini Images API. "
        "Set it in .env or the environment."
    )


def _build_url(model: str) -> str:
    return f"{_GEMINI_BASE}/{model}:generateContent"


def _image_config(
    cfg: MediaSectionConfig, overrides: dict[str, str] | None
) -> dict[str, str]:
    """Merge YAML + overrides into the camelCase ``imageConfig`` payload."""
    out: dict[str, str] = {}
    for snake, camel in _IMAGE_CONFIG_KEYS.items():
        val = cfg.extras.get(snake)
        if isinstance(val, str) and val:
            out[camel] = val
    if overrides:
        for key, val in overrides.items():
            if key in _IMAGE_CONFIG_KEYS and val:
                out[_IMAGE_CONFIG_KEYS[key]] = val
    return out


def _build_generation_config(
    cfg: MediaSectionConfig, overrides: dict[str, str] | None
) -> dict[str, Any]:
    """Build the ``generationConfig`` object including imageConfig when relevant."""
    gen_cfg: dict[str, Any] = {"responseModalities": ["TEXT", "IMAGE"]}
    img_cfg = _image_config(cfg, overrides)
    if img_cfg:
        gen_cfg["imageConfig"] = img_cfg
    return gen_cfg


def _decode_image_response(resp: httpx2.Response) -> bytes | str:
    """Shared response handler — scans parts for the first image ``inline_data``."""
    if resp.status_code != 200:
        body = resp.text[:400]
        logger.warning(
            "gemini_image_api_error status={} body={}", resp.status_code, body
        )
        return f"Error: Gemini Images API returned {resp.status_code}: {body}"

    try:
        data = resp.json()
        candidates = data.get("candidates") or []
        if not candidates:
            return "Error: Gemini response had no candidates."
        parts = candidates[0].get("content", {}).get("parts") or []
    except (KeyError, ValueError) as exc:
        logger.warning("gemini_image_bad_response err={}", exc)
        return f"Error: unexpected Gemini response shape: {exc}"

    # Collect any text parts for the log; grab the first image part.
    text_fragments: list[str] = []
    image_b64: str | None = None
    for part in parts:
        if "text" in part and isinstance(part["text"], str):
            text_fragments.append(part["text"])
        # Gemini has used both ``inline_data`` and ``inlineData`` keys; accept both.
        inline = part.get("inline_data") or part.get("inlineData")
        if not inline:
            continue
        mime = inline.get("mime_type") or inline.get("mimeType") or ""
        if not mime.startswith("image/"):
            continue
        b64 = inline.get("data")
        if isinstance(b64, str) and b64:
            image_b64 = b64
            break

    if image_b64 is None:
        if text_fragments:
            logger.info("gemini_image_text_only text={}", "".join(text_fragments)[:200])
        return "Error: Gemini response had no image part."

    if text_fragments:
        logger.debug("gemini_image_accompanying_text={}", "".join(text_fragments)[:200])

    try:
        return base64.b64decode(image_b64)
    except (ValueError, TypeError) as exc:
        return f"Error: could not decode base64 image payload: {exc}"


async def generate(
    cfg: MediaSectionConfig,
    prompt: str,
    overrides: dict[str, str] | None = None,
) -> bytes | str:
    """Text-to-image via ``POST /v1beta/models/<model>:generateContent``."""
    api_key = _resolve_api_key()
    if not api_key:
        return _missing_key_error()

    payload: dict[str, Any] = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": _build_generation_config(cfg, overrides),
    }
    headers = {
        "x-goog-api-key": api_key,
        "Content-Type": "application/json",
    }

    try:
        async with httpx2.AsyncClient(timeout=_REQUEST_TIMEOUT_SECONDS) as client:
            resp = await client.post(
                _build_url(cfg.model), headers=headers, json=payload
            )
    except httpx2.HTTPError as exc:
        logger.warning("gemini_generate_http_error err={}", exc)
        return f"Error: network failure calling Gemini Images: {exc}"

    return _decode_image_response(resp)


async def edit(
    cfg: MediaSectionConfig,
    prompt: str,
    images: list[tuple[str, bytes]],
    overrides: dict[str, str] | None = None,
) -> bytes | str:
    """Image-to-image via text + ``inline_data`` parts on the same endpoint.

    ``images`` is a list of ``(filename, raw_bytes)`` — the dispatcher in
    ``image.py`` handles sandbox resolution and reads; the backend stays pure
    HTTP.
    """
    if not images:
        return "Error: edit requires at least one input image."
    if len(images) > _MAX_EDIT_IMAGES:
        return (
            f"Error: Gemini edit supports up to {_MAX_EDIT_IMAGES} input images "
            f"({len(images)} provided)."
        )

    api_key = _resolve_api_key()
    if not api_key:
        return _missing_key_error()

    parts: list[dict[str, Any]] = [{"text": prompt}]
    for name, blob in images:
        mime, _ = mimetypes.guess_type(name)
        parts.append(
            {
                "inline_data": {
                    "mime_type": mime or "application/octet-stream",
                    "data": base64.b64encode(blob).decode("ascii"),
                }
            }
        )

    payload: dict[str, Any] = {
        "contents": [{"parts": parts}],
        "generationConfig": _build_generation_config(cfg, overrides),
    }
    headers = {
        "x-goog-api-key": api_key,
        "Content-Type": "application/json",
    }

    try:
        async with httpx2.AsyncClient(timeout=_REQUEST_TIMEOUT_SECONDS) as client:
            resp = await client.post(
                _build_url(cfg.model), headers=headers, json=payload
            )
    except httpx2.HTTPError as exc:
        logger.warning("gemini_edit_http_error err={}", exc)
        return f"Error: network failure calling Gemini Images edit: {exc}"

    return _decode_image_response(resp)
