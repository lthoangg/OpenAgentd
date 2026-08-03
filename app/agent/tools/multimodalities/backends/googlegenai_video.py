"""Google GenAI (Veo) video backend — ``models/<name>:predictLongRunning``.

Veo is a long-running operation: the ``predictLongRunning`` endpoint returns
an operation name (``operations/...``) that must be polled until ``done=true``
before the generated video is available for download.

Flow:

1. POST ``{BASE}/models/<model>:predictLongRunning`` with the instance +
   parameters payload → ``{"name": "operations/..."}``.
2. Poll ``GET {BASE}/<operation_name>`` every ``_POLL_INTERVAL_SECONDS``
   until ``done=true`` or ``_MAX_WAIT_SECONDS`` elapses.
3. Extract ``response.generateVideoResponse.generatedSamples[0].video.uri``
   and download the mp4 bytes (with ``x-goog-api-key`` header; ``-L`` to
   follow redirects — ``httpx2`` does this via ``follow_redirects=True``).

Auth: reads ``settings.GOOGLE_API_KEY`` (loaded from ``.env``) and falls back
to ``os.getenv("GOOGLE_API_KEY")`` for runtime overrides. Mirrors the image
backend — multimodal config only names a provider and model; credentials
live in the backend.

Supported input modes (all routed here, distinguished by which args are set):

- **text-to-video**: ``image`` / ``last_frame`` / ``reference_images`` all
  unset → pure ``prompt``.
- **image-to-video**: ``image`` set → ``image`` on the instance.
- **first+last interpolation**: ``image`` + ``last_frame`` →
  ``image`` + ``lastFrame``.
- **reference images**: up to 3 ``reference_images`` → ``referenceImages``
  array with ``referenceType: "asset"``. Mutually exclusive with
  ``last_frame`` (Veo won't accept both). The dispatcher enforces this.
- **video extension**: ``extend_video`` → ``video`` on the instance. Extends
  a previously generated mp4 by up to 8 s. Mutually exclusive with all other
  image inputs. Veo only supports 720p for extension; ``resolution`` overrides
  are silently clamped to ``"720p"`` in ``_build_parameters``.

Per-call overrides the backend understands, mapped to Veo parameters:

- ``aspect_ratio`` → ``parameters.aspectRatio``
- ``resolution`` → ``parameters.resolution``
- ``duration_seconds`` → ``parameters.durationSeconds``
- ``person_generation`` → ``parameters.personGeneration`` (YAML-only for now)

Image-shaped overrides (``size``, ``output_format``, ``image_size``) are
silently ignored — one tool schema serves both media kinds.
"""

from __future__ import annotations

import asyncio
import base64
import mimetypes
import os
from typing import Any

import httpx2
from loguru import logger

from app.agent.tools.multimodalities._config import MediaSectionConfig
from app.core.config import settings

_GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta"
# Me: request timeout for the initial predictLongRunning POST and each poll.
# The actual long wait is absorbed by our polling loop, not a single HTTP call.
_REQUEST_TIMEOUT_SECONDS = 60.0
# Download timeout is larger — a 4k 8s mp4 can be several hundred MB.
_DOWNLOAD_TIMEOUT_SECONDS = 300.0
_POLL_INTERVAL_SECONDS = 10.0
# Per Veo docs: peak-hour latency can reach 6 minutes; give headroom.
_MAX_WAIT_SECONDS = 10 * 60.0

# Veo 3.1 caps reference_images at 3 (see API parameters table).
_MAX_REFERENCE_IMAGES = 3

# Snake-case inbound → camelCase on the wire.
_PARAMETER_KEYS: dict[str, str] = {
    "aspect_ratio": "aspectRatio",
    "resolution": "resolution",
    "duration_seconds": "durationSeconds",
    "person_generation": "personGeneration",
    "negative_prompt": "negativePrompt",
    "seed": "seed",
}

# Veo's REST API is fussy about JSON types: ``durationSeconds`` and ``seed``
# must be numbers, not numeric strings. We keep the tool-schema side as a
# ``Literal["4","6","8"]`` string enum for LLM stability, then coerce here.
# Any coercion failure falls back to the original value so the caller gets
# the real API error instead of a silent drop.
_NUMERIC_PARAMETER_KEYS: frozenset[str] = frozenset({"durationSeconds", "seed"})


def _resolve_api_key() -> str:
    """Return the Google API key, preferring settings then env; empty if unset."""
    if settings.GOOGLE_API_KEY:
        return settings.GOOGLE_API_KEY.get_secret_value()
    return os.getenv("GOOGLE_API_KEY", "")


def _missing_key_error() -> str:
    return (
        "Error: GOOGLE_API_KEY is unset — cannot call Gemini Veo API. "
        "Set it in .env or the environment."
    )


def _predict_url(model: str) -> str:
    return f"{_GEMINI_BASE}/models/{model}:predictLongRunning"


def _operation_url(operation_name: str) -> str:
    # Me: ``operation_name`` from the API comes as e.g. ``models/<m>/operations/...``
    # or ``operations/...`` depending on the endpoint; always safe to join against
    # the v1beta base with a leading slash stripped.
    return f"{_GEMINI_BASE}/{operation_name.lstrip('/')}"


def _inline_image(name: str, blob: bytes) -> dict[str, Any]:
    """Build the image shape Veo's ``predictLongRunning`` REST endpoint accepts.

    Despite the official REST docs showing ``{"inlineData": {"mimeType": ...,
    "data": ...}}``, the live API rejects that shape with::

        "`inlineData` isn't supported by this model."

    The correct wire format — confirmed by reading the Google GenAI Python SDK
    source (``_Image_to_mldev`` in ``models.py``) and verified empirically — is
    flat fields at the image object level::

        {"bytesBase64Encoded": "<base64>", "mimeType": "image/png"}

    This matches what the SDK sends internally for all image-bearing Veo calls
    (image-to-video, first+last interpolation, reference images).
    """
    mime, _ = mimetypes.guess_type(name)
    return {
        "bytesBase64Encoded": base64.b64encode(blob).decode("ascii"),
        "mimeType": mime or "application/octet-stream",
    }


def _coerce_parameter_value(camel_key: str, value: Any) -> Any:
    """Coerce string values to numbers for keys the Veo API requires as numbers.

    The tool schema exposes ``duration_seconds`` / ``seed`` as string
    ``Literal`` enums so the LLM emits stable values, and YAML routinely
    carries them as strings too. Veo itself rejects numeric strings with a
    400 ``INVALID_ARGUMENT``. Parse here; if parsing fails, leave the
    original value so the caller sees the real API error rather than us
    silently dropping a typo.
    """
    if camel_key not in _NUMERIC_PARAMETER_KEYS:
        return value
    if isinstance(value, bool):
        # bool is a subclass of int — never what Veo expects for these keys.
        return value
    if isinstance(value, int | float):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            try:
                return float(value)
            except ValueError:
                return value
    return value


def _build_parameters(
    cfg: MediaSectionConfig, overrides: dict[str, str] | None
) -> dict[str, Any]:
    """Merge YAML extras + per-call overrides into the ``parameters`` payload.

    Per-key type coercion (see ``_coerce_parameter_value``) handles the
    string↔number mismatch between our tool schema and Veo's JSON shape.
    """
    out: dict[str, Any] = {}
    for snake, camel in _PARAMETER_KEYS.items():
        val = cfg.extras.get(snake)
        if val is None:
            continue
        if isinstance(val, str) and not val:
            continue
        out[camel] = _coerce_parameter_value(camel, val)
    if overrides:
        for key, val in overrides.items():
            if key in _PARAMETER_KEYS and val:
                camel = _PARAMETER_KEYS[key]
                out[camel] = _coerce_parameter_value(camel, val)
    return out


def _build_instance(
    prompt: str,
    image: tuple[str, bytes] | None,
    last_frame: tuple[str, bytes] | None,
    reference_images: list[tuple[str, bytes]] | None,
    extend_video: str | None,
) -> dict[str, Any]:
    """Assemble the single ``instances[0]`` object for Veo.

    Input invariants — the dispatcher should enforce these, but we restate
    them here so a direct caller can't slip through:

    - ``last_frame`` requires ``image`` (first frame); solo ``last_frame``
      would be meaningless.
    - ``reference_images`` and ``last_frame`` are mutually exclusive on Veo.
    - ``extend_video`` is a Files API URI (str) and is mutually exclusive
      with all image inputs.

    Wire format for ``extend_video``: ``{"uri": "<Files API URI>"}`` — Veo
    only accepts URIs for video extension; raw bytes (inlineData / encodedVideo)
    are rejected. Confirmed empirically: the live API requires a URI in the
    form ``https://generativelanguage.googleapis.com/{version}/files/{id}``.
    """
    instance: dict[str, Any] = {"prompt": prompt}
    if image is not None:
        instance["image"] = _inline_image(*image)
    if last_frame is not None:
        instance["lastFrame"] = _inline_image(*last_frame)
    if reference_images:
        instance["referenceImages"] = [
            {"image": _inline_image(name, blob), "referenceType": "asset"}
            for name, blob in reference_images
        ]
    if extend_video is not None:
        instance["video"] = {"uri": extend_video}
    return instance


def _extract_video_uri(status_response: dict[str, Any]) -> str | None:
    """Pluck the first generated-sample URI from a done operation response.

    Shape per Veo docs::

        {
          "done": true,
          "response": {
            "generateVideoResponse": {
              "generatedSamples": [
                {"video": {"uri": "https://..."}}
              ]
            }
          }
        }
    """
    resp = status_response.get("response")
    if not isinstance(resp, dict):
        return None
    gvr = resp.get("generateVideoResponse")
    if not isinstance(gvr, dict):
        return None
    samples = gvr.get("generatedSamples")
    if not isinstance(samples, list) or not samples:
        return None
    first = samples[0]
    if not isinstance(first, dict):
        return None
    video = first.get("video")
    if not isinstance(video, dict):
        return None
    uri = video.get("uri")
    return uri if isinstance(uri, str) and uri else None


async def _poll_until_done(
    client: httpx2.AsyncClient,
    operation_name: str,
    api_key: str,
) -> dict[str, Any] | str:
    """Poll ``operation_name`` until ``done=true``. Return the final JSON.

    Returns a framed ``Error: ...`` string on API failure, timeout, or when
    the response carries ``error`` instead of ``response``.
    """
    headers = {"x-goog-api-key": api_key}
    deadline = asyncio.get_event_loop().time() + _MAX_WAIT_SECONDS
    attempt = 0
    while True:
        attempt += 1
        try:
            resp = await client.get(_operation_url(operation_name), headers=headers)
        except httpx2.HTTPError as exc:
            logger.warning("veo_poll_http_error attempt={} err={}", attempt, exc)
            return f"Error: network failure polling Veo operation: {exc}"

        if resp.status_code != 200:
            body = resp.text[:400]
            logger.warning(
                "veo_poll_api_error status={} body={}", resp.status_code, body
            )
            return f"Error: Veo operation poll returned {resp.status_code}: {body}"

        try:
            data = resp.json()
        except ValueError as exc:
            return f"Error: unexpected Veo operation response: {exc}"

        if data.get("done") is True:
            err = data.get("error")
            if isinstance(err, dict):
                # {"code": int, "message": str, ...}
                msg = err.get("message") or str(err)
                return f"Error: Veo operation failed: {msg}"
            return data

        if asyncio.get_event_loop().time() >= deadline:
            return (
                f"Error: Veo operation '{operation_name}' did not complete within "
                f"{int(_MAX_WAIT_SECONDS)}s."
            )

        logger.debug(
            "veo_polling operation={} attempt={} interval={}s",
            operation_name,
            attempt,
            _POLL_INTERVAL_SECONDS,
        )
        await asyncio.sleep(_POLL_INTERVAL_SECONDS)


async def _download_video(
    client: httpx2.AsyncClient,
    uri: str,
    api_key: str,
) -> bytes | str:
    """Fetch the final mp4 bytes. Veo URIs redirect via 302 to the CDN."""
    headers = {"x-goog-api-key": api_key}
    try:
        resp = await client.get(uri, headers=headers, follow_redirects=True)
    except httpx2.HTTPError as exc:
        logger.warning("veo_download_http_error err={}", exc)
        return f"Error: network failure downloading Veo video: {exc}"

    if resp.status_code != 200:
        body = resp.text[:200]
        logger.warning(
            "veo_download_api_error status={} body={}", resp.status_code, body
        )
        return f"Error: Veo video download returned {resp.status_code}: {body}"

    return resp.content


async def generate(
    cfg: MediaSectionConfig,
    prompt: str,
    *,
    image: tuple[str, bytes] | None = None,
    last_frame: tuple[str, bytes] | None = None,
    reference_images: list[tuple[str, bytes]] | None = None,
    extend_video: str | None = None,
    overrides: dict[str, str] | None = None,
) -> tuple[bytes, str] | str:
    """Generate a video via ``predictLongRunning`` + polling + download.

    All input images are ``(filename, raw_bytes)`` — the dispatcher is
    responsible for sandbox resolution; the backend stays pure HTTP.

    Returns ``(mp4_bytes, files_api_uri)`` on success, or an ``Error: ...``
    string the agent can react to. The URI is the Files API download link
    (``https://generativelanguage.googleapis.com/…``) which callers can
    surface to the LLM for future video extension calls.
    """
    api_key = _resolve_api_key()
    if not api_key:
        return _missing_key_error()

    # Defensive caps — dispatcher should have guarded already.
    if reference_images and len(reference_images) > _MAX_REFERENCE_IMAGES:
        return (
            f"Error: Veo supports up to {_MAX_REFERENCE_IMAGES} reference images "
            f"({len(reference_images)} provided)."
        )
    if last_frame is not None and image is None:
        return "Error: last_frame requires a first-frame image (pass it as images[0])."
    if reference_images and last_frame is not None:
        return "Error: reference_images and last_frame are mutually exclusive on Veo."
    if extend_video is not None and any((image, last_frame, reference_images)):
        return "Error: extend_video is mutually exclusive with image, last_frame, and reference_images."

    instance = _build_instance(
        prompt, image, last_frame, reference_images, extend_video
    )
    parameters = _build_parameters(cfg, overrides)

    payload: dict[str, Any] = {"instances": [instance]}
    if parameters:
        payload["parameters"] = parameters

    headers = {
        "x-goog-api-key": api_key,
        "Content-Type": "application/json",
    }

    try:
        async with httpx2.AsyncClient(timeout=_REQUEST_TIMEOUT_SECONDS) as client:
            # 1. Kick off the operation.
            try:
                resp = await client.post(
                    _predict_url(cfg.model), headers=headers, json=payload
                )
            except httpx2.HTTPError as exc:
                logger.warning("veo_start_http_error err={}", exc)
                return f"Error: network failure calling Veo: {exc}"

            if resp.status_code != 200:
                body = resp.text[:400]
                logger.warning(
                    "veo_start_api_error status={} body={}", resp.status_code, body
                )
                return f"Error: Veo API returned {resp.status_code}: {body}"

            try:
                operation_name = resp.json().get("name")
            except ValueError as exc:
                return f"Error: unexpected Veo start response: {exc}"

            if not isinstance(operation_name, str) or not operation_name:
                return "Error: Veo start response had no operation name."

            logger.info(
                "veo_operation_started operation={} model={} params={}",
                operation_name,
                cfg.model,
                parameters,
            )

            # 2. Poll until done.
            final = await _poll_until_done(client, operation_name, api_key)
            if isinstance(final, str):
                return final

            uri = _extract_video_uri(final)
            if uri is None:
                logger.warning("veo_no_video_uri final_keys={}", list(final.keys()))
                return "Error: Veo operation completed but no video URI was returned."

            logger.info("veo_operation_complete operation={}", operation_name)

        # 3. Download — fresh client with a longer timeout for the mp4 payload.
        async with httpx2.AsyncClient(timeout=_DOWNLOAD_TIMEOUT_SECONDS) as dl_client:
            mp4 = await _download_video(dl_client, uri, api_key)
            if isinstance(mp4, str):
                return mp4  # Error string
            return mp4, uri
    except httpx2.HTTPError as exc:
        # Belt-and-braces for client creation / context failures.
        logger.warning("veo_unexpected_http_error err={}", exc)
        return f"Error: unexpected network failure during Veo call: {exc}"
