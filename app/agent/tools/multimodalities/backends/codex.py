"""OpenAI Codex Images backend — ChatGPT-subscription via OAuth.

Codex does **not** expose a dedicated ``/images/generations`` endpoint. Image
generation rides on the same Responses API used for chat, with an
``image_generation`` tool entry; the streamed response carries the final
base64 image inside an ``image_generation_call`` output item.

This module mirrors how the codex CLI / 9router invoke the endpoint:

- POST ``https://chatgpt.com/backend-api/codex/responses`` with
  ``stream: true`` and an ``image_generation`` tool.
- Reference images are inlined into the ``input`` array as ``input_image``
  parts wrapped in ``<image name=imageN>`` tags, mirroring codex-imagen.
- Parse the SSE stream and return the base64 from
  ``response.output_item.done`` where ``item.type == "image_generation_call"``.

Auth comes from ``{CACHE_DIR}/codex_oauth.json`` (same token store the chat
provider uses); ``OPENAI_API_KEY`` is intentionally ignored.

Returns image ``bytes`` on success or an ``Error: ...`` string the agent
can react to.
"""

from __future__ import annotations

import base64
import json
import mimetypes
import uuid
from typing import Any

import httpx2
from loguru import logger

from app.agent.providers.codex.oauth import CodexOAuth
from app.agent.tools.multimodalities._config import MediaSectionConfig

_CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses"
_REQUEST_TIMEOUT_SECONDS = 180.0  # image gen takes longer than chat

# Match the codex CLI / 9router spoof identity. The upstream rejects unknown
# originators on the image path even when the OAuth token is valid, so we
# mirror codex-imagen's headers verbatim.
_CODEX_USER_AGENT = "codex-imagen/0.2.6"
_CODEX_VERSION = "0.122.0"
_CODEX_ORIGINATOR = "codex_cli_rs"

# Detail hint for reference images. ``high`` matches codex-imagen's default
# and gives the best edit fidelity.
_REF_IMAGE_DETAIL = "high"

# Keys we pass through from YAML / per-call overrides into the
# ``image_generation`` tool spec. Other extras are silently ignored.
_TOOL_PASSTHROUGH_KEYS = ("size", "quality", "background", "output_format")


def _missing_credentials_error() -> str:
    return (
        "Error: Codex OAuth credentials not found. "
        "Run `openagentd auth codex` to authenticate with your ChatGPT account."
    )


def _resolve_auth() -> tuple[str, str | None] | str:
    """Return ``(access_token, account_id)`` or an ``Error: ...`` string.

    Loads the cached OAuth token, refreshes it if expired, and surfaces a
    framed error if the cache is missing or refresh fails. Mirrors
    ``app.agent.providers.codex.codex._load_token``.
    """
    oauth = CodexOAuth.load()
    if not oauth:
        return _missing_credentials_error()
    if oauth.is_expired():
        logger.info("codex_image_token_expired refreshing")
        try:
            oauth = oauth.refresh()
        except Exception as exc:  # noqa: BLE001 — surface upstream failure verbatim
            logger.warning("codex_image_token_refresh_failed err={}", exc)
            return (
                f"Error: Codex token refresh failed: {exc}. "
                "Run `openagentd auth codex` to re-authenticate."
            )
    return oauth.access_token.get_secret_value(), oauth.account_id


def _build_headers(access_token: str, account_id: str | None) -> dict[str, str]:
    """Headers that match the codex CLI's image-gen requests exactly."""
    return {
        "accept": "text/event-stream, application/json",
        "authorization": f"Bearer {access_token}",
        "chatgpt-account-id": account_id or "",
        "content-type": "application/json",
        "originator": _CODEX_ORIGINATOR,
        "session_id": str(uuid.uuid4()),
        "user-agent": _CODEX_USER_AGENT,
        "version": _CODEX_VERSION,
        "x-client-request-id": str(uuid.uuid4()),
    }


def _to_data_url(name: str, blob: bytes) -> str:
    """Encode workspace bytes as a ``data:image/<type>;base64,...`` URL."""
    mime, _ = mimetypes.guess_type(name)
    if not mime or not mime.startswith("image/"):
        # Default to PNG; the API will still validate magic bytes.
        mime = "image/png"
    return f"data:{mime};base64,{base64.b64encode(blob).decode('ascii')}"


def _build_input_content(prompt: str, ref_data_urls: list[str]) -> list[dict[str, Any]]:
    """Build the ``input[0].content`` array.

    Mirrors codex-imagen's tagging scheme — each reference is bracketed by
    ``<image name=imageN>`` text so the model can address them by index, then
    the user prompt is appended last.
    """
    content: list[dict[str, Any]] = []
    for index, url in enumerate(ref_data_urls, start=1):
        content.append({"type": "input_text", "text": f"<image name=image{index}>"})
        content.append(
            {"type": "input_image", "image_url": url, "detail": _REF_IMAGE_DETAIL}
        )
        content.append({"type": "input_text", "text": "</image>"})
    content.append({"type": "input_text", "text": prompt})
    return content


def _build_tool_spec(
    cfg: MediaSectionConfig, overrides: dict[str, str] | None
) -> dict[str, Any]:
    """Build the ``image_generation`` tool entry from YAML + per-call overrides."""
    tool: dict[str, Any] = {"type": "image_generation"}

    # Defaults from YAML, overlaid with per-call overrides.
    merged: dict[str, str] = {}
    for key in _TOOL_PASSTHROUGH_KEYS:
        val = cfg.extras.get(key)
        if isinstance(val, str) and val:
            merged[key] = val
    if overrides:
        for key, val in overrides.items():
            if key in _TOOL_PASSTHROUGH_KEYS and val:
                merged[key] = val

    # ``output_format`` is required for the SSE result to come back with a
    # consistent encoding; default to png if neither YAML nor caller set it.
    tool["output_format"] = merged.get("output_format", "png").lower()
    for key in ("size", "quality", "background"):
        if key in merged:
            tool[key] = merged[key]

    return tool


def _build_request_body(
    cfg: MediaSectionConfig,
    prompt: str,
    ref_data_urls: list[str],
    overrides: dict[str, str] | None,
) -> dict[str, Any]:
    """Build the full Responses API request body for image generation."""
    return {
        "model": cfg.model,
        "instructions": "",
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": _build_input_content(prompt, ref_data_urls),
            }
        ],
        "tools": [_build_tool_spec(cfg, overrides)],
        "tool_choice": "auto",
        "parallel_tool_calls": False,
        "prompt_cache_key": str(uuid.uuid4()),
        "stream": True,
        "store": False,
        "reasoning": None,
    }


async def _read_error_body(resp: httpx2.Response) -> str:
    """Best-effort body read for error reporting; tolerates streaming responses."""
    try:
        body = await resp.aread()
        return body.decode("utf-8", errors="replace")[:400]
    except Exception:  # noqa: BLE001 — error path; never fail the failure
        return ""


async def _parse_sse_image(resp: httpx2.Response) -> bytes | str:
    """Parse the Codex SSE stream and return decoded image bytes.

    Looks for ``response.output_item.done`` events where the carried item is
    an ``image_generation_call`` with a ``result`` field (base64). Anything
    else is informational and ignored.
    """
    buffer = ""
    image_b64: str | None = None
    last_event: str | None = None

    try:
        async for chunk in resp.aiter_text():
            buffer += chunk
            # SSE frames are separated by blank lines.
            while "\n\n" in buffer:
                block, buffer = buffer.split("\n\n", 1)
                event_name: str | None = None
                data_str = ""
                for line in block.split("\n"):
                    if line.startswith("event:"):
                        event_name = line[len("event:") :].strip()
                    elif line.startswith("data:"):
                        # Multiple data: lines concatenate with no newline,
                        # mirroring 9router's parser. SSE technically joins
                        # with \n; the codex stream ships single-line frames
                        # so this is fine in practice.
                        data_str += line[len("data:") :].strip()

                if not event_name:
                    continue
                if event_name != last_event:
                    logger.debug("codex_image_progress event={}", event_name)
                    last_event = event_name

                if event_name == "response.output_item.done" and data_str:
                    try:
                        data = json.loads(data_str)
                    except json.JSONDecodeError:
                        continue
                    item = (data or {}).get("item") or {}
                    if item.get("type") == "image_generation_call" and item.get(
                        "result"
                    ):
                        image_b64 = item["result"]
    except httpx2.HTTPError as exc:
        logger.warning("codex_image_stream_error err={}", exc)
        return f"Error: Codex stream interrupted: {exc}"

    if not image_b64:
        return (
            "Error: Codex did not return an image. Account may not be entitled "
            "(Plus/Pro required for image generation)."
        )

    try:
        return base64.b64decode(image_b64)
    except (ValueError, TypeError) as exc:
        return f"Error: could not decode base64 image payload: {exc}"


async def _post_and_parse(
    request_body: dict[str, Any],
    headers: dict[str, str],
) -> bytes | str:
    """POST + SSE parse, with shared error handling for both entry points."""
    try:
        async with httpx2.AsyncClient(timeout=_REQUEST_TIMEOUT_SECONDS) as client:
            async with client.stream(
                "POST", _CODEX_RESPONSES_URL, headers=headers, json=request_body
            ) as resp:
                if resp.status_code != 200:
                    body = await _read_error_body(resp)
                    logger.warning(
                        "codex_image_api_error status={} body={}",
                        resp.status_code,
                        body,
                    )
                    return (
                        f"Error: Codex Images API returned {resp.status_code}: {body}"
                    )
                return await _parse_sse_image(resp)
    except httpx2.HTTPError as exc:
        logger.warning("codex_image_http_error err={}", exc)
        return f"Error: network failure calling Codex Images: {exc}"


async def generate(
    cfg: MediaSectionConfig,
    prompt: str,
    overrides: dict[str, str] | None = None,
) -> bytes | str:
    """Text-to-image via the Codex Responses API."""
    auth = _resolve_auth()
    if isinstance(auth, str):
        return auth
    access_token, account_id = auth

    body = _build_request_body(cfg, prompt, [], overrides)
    headers = _build_headers(access_token, account_id)
    return await _post_and_parse(body, headers)


async def edit(
    cfg: MediaSectionConfig,
    prompt: str,
    images: list[tuple[str, bytes]],
    overrides: dict[str, str] | None = None,
) -> bytes | str:
    """Image-to-image via the Codex Responses API.

    Codex has no separate ``/edits`` endpoint — references are passed as
    ``input_image`` parts on the same Responses request. ``images`` is a
    list of ``(filename, raw_bytes)`` already resolved by the dispatcher.
    """
    if not images:
        return "Error: edit requires at least one input image."

    auth = _resolve_auth()
    if isinstance(auth, str):
        return auth
    access_token, account_id = auth

    ref_urls = [_to_data_url(name, blob) for name, blob in images]
    body = _build_request_body(cfg, prompt, ref_urls, overrides)
    headers = _build_headers(access_token, account_id)
    return await _post_and_parse(body, headers)
