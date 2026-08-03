"""OpenAI Images API backend — ``/v1/images/generations`` and ``/v1/images/edits``.

Auth: reads ``settings.OPENAI_API_KEY`` (loaded from ``.env``) and falls back to
``os.getenv("OPENAI_API_KEY")`` for runtime overrides. Intentionally not
configurable via YAML — the multimodal config only names a provider and model;
each backend owns its credential lookup.

Entry points:

- ``generate(cfg, prompt)`` → POST JSON to ``/v1/images/generations``
- ``edit(cfg, prompt, images)`` → POST multipart to ``/v1/images/edits`` with
  repeated ``image[]`` file parts (1–16 images).

Both return PNG ``bytes`` on success or an ``Error: ...`` string the agent
can react to.
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

_OPENAI_GENERATE_URL = "https://api.openai.com/v1/images/generations"
_OPENAI_EDIT_URL = "https://api.openai.com/v1/images/edits"
_REQUEST_TIMEOUT_SECONDS = 120.0

# Max per OpenAI docs — the API itself will reject more, but surfacing a clear
# error before the round-trip saves a slow failure.
_MAX_EDIT_IMAGES = 16


def _resolve_api_key() -> str:
    """Return the OpenAI API key, preferring settings then env; empty if unset."""
    if settings.OPENAI_API_KEY:
        return settings.OPENAI_API_KEY.get_secret_value()
    return os.getenv("OPENAI_API_KEY", "")


def _missing_key_error() -> str:
    return (
        "Error: OPENAI_API_KEY is unset — cannot call OpenAI Images API. "
        "Set it in .env or the environment."
    )


def _decode_image_response(resp: httpx2.Response) -> bytes | str:
    """Shared response handler for both generate and edit endpoints."""
    if resp.status_code != 200:
        # Me surface API error text to the agent (truncated) so the model can adapt.
        body = resp.text[:400]
        logger.warning(
            "openai_image_api_error status={} body={}", resp.status_code, body
        )
        return f"Error: OpenAI Images API returned {resp.status_code}: {body}"

    try:
        data = resp.json()
        b64 = data["data"][0]["b64_json"]
    except (KeyError, IndexError, ValueError) as exc:
        logger.warning("openai_image_bad_response err={}", exc)
        return f"Error: unexpected OpenAI response shape: {exc}"

    try:
        return base64.b64decode(b64)
    except (ValueError, TypeError) as exc:
        return f"Error: could not decode base64 image payload: {exc}"


# Keys the backend is willing to pass through — extras_payload filters to these.
# size / output_format are also overridable per-call; quality is YAML-only for now.
_PASSTHROUGH_KEYS = ("size", "quality", "output_format")


def _extras_payload(
    cfg: MediaSectionConfig, overrides: dict[str, str] | None = None
) -> dict[str, str]:
    """Merge YAML defaults with per-call overrides; overrides win."""
    out: dict[str, str] = {}
    for key in _PASSTHROUGH_KEYS:
        val = cfg.extras.get(key)
        if isinstance(val, str):
            out[key] = val
    if overrides:
        for key, val in overrides.items():
            if key in _PASSTHROUGH_KEYS and val:
                out[key] = val
    return out


async def generate(
    cfg: MediaSectionConfig,
    prompt: str,
    overrides: dict[str, str] | None = None,
) -> bytes | str:
    """Text-to-image via ``POST /v1/images/generations``."""
    api_key = _resolve_api_key()
    if not api_key:
        return _missing_key_error()

    payload: dict[str, Any] = {"model": cfg.model, "prompt": prompt, "n": 1}
    payload.update(_extras_payload(cfg, overrides))
    headers = {"Authorization": f"Bearer {api_key}"}

    try:
        async with httpx2.AsyncClient(timeout=_REQUEST_TIMEOUT_SECONDS) as client:
            resp = await client.post(
                _OPENAI_GENERATE_URL, headers=headers, json=payload
            )
    except httpx2.HTTPError as exc:
        logger.warning("openai_generate_http_error err={}", exc)
        return f"Error: network failure calling OpenAI Images: {exc}"

    return _decode_image_response(resp)


async def edit(
    cfg: MediaSectionConfig,
    prompt: str,
    images: list[tuple[str, bytes]],
    overrides: dict[str, str] | None = None,
) -> bytes | str:
    """Image-to-image via ``POST /v1/images/edits`` (multipart).

    ``images`` is a list of ``(filename, raw_bytes)`` — the dispatcher in
    ``image.py`` is responsible for sandbox resolution and reads; the backend
    stays pure HTTP.
    """
    if not images:
        return "Error: edit requires at least one input image."
    if len(images) > _MAX_EDIT_IMAGES:
        return (
            f"Error: OpenAI edit supports up to {_MAX_EDIT_IMAGES} input images "
            f"({len(images)} provided)."
        )

    api_key = _resolve_api_key()
    if not api_key:
        return _missing_key_error()

    # Me build repeated ``image[]`` multipart parts with per-file mime type.
    files: list[tuple[str, tuple[str, bytes, str]]] = []
    for name, blob in images:
        mime, _ = mimetypes.guess_type(name)
        files.append(("image[]", (name, blob, mime or "application/octet-stream")))

    data: dict[str, str] = {"model": cfg.model, "prompt": prompt, "n": "1"}
    data.update(_extras_payload(cfg, overrides))
    headers = {"Authorization": f"Bearer {api_key}"}

    try:
        async with httpx2.AsyncClient(timeout=_REQUEST_TIMEOUT_SECONDS) as client:
            resp = await client.post(
                _OPENAI_EDIT_URL, headers=headers, data=data, files=files
            )
    except httpx2.HTTPError as exc:
        logger.warning("openai_edit_http_error err={}", exc)
        return f"Error: network failure calling OpenAI Images edit: {exc}"

    return _decode_image_response(resp)
