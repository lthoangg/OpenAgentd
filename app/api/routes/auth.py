"""``/api/auth`` — UI-driven OAuth login for LLM providers.

The CLI exposes ``openagentd auth <provider>`` for terminal users. This
module wraps the same per-provider ``login()`` functions in an SSE-based
HTTP endpoint so the desktop/web UI can drive the same flow from a
"Connect with GitHub Copilot" button.

Flow
----

1. Client opens ``GET /api/auth/{provider}/login`` as an EventSource.
2. Server invokes ``app.cli.commands.auth._PROVIDERS[provider]`` in a
   worker thread with an ``event_sink`` that pushes JSON-serialisable
   events onto an ``asyncio.Queue``.
3. The async endpoint generator drains the queue and yields SSE
   messages to the client.
4. The thread's ``login()`` writes the OAuth token file under
   ``OPENAGENTD_CACHE_DIR``; the ``success`` event tells the client the
   credentials are persisted and the provider is now usable.

Why a thread + queue
--------------------

``login()`` is synchronous (``time.sleep``, sync ``httpx``) and we
don't want to refactor every provider's flow to be async. Running it
in ``asyncio.to_thread`` and bridging via a queue keeps the producer
side unchanged while letting FastAPI stream events to the client.
"""

from __future__ import annotations

import asyncio
import importlib
import json
from collections.abc import AsyncGenerator
from typing import Any

from pydantic import BaseModel, ConfigDict
from fastapi import APIRouter, HTTPException, Request
from loguru import logger
from sse_starlette.sse import EventSourceResponse

from app.cli.commands.auth import _PROVIDERS

router = APIRouter()


class OAuthCallbackBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str


class AuthCheckResponse(BaseModel):
    ok: bool


class OAuthCallbackResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    ok: bool


@router.get("/check")
async def auth_check() -> AuthCheckResponse:
    """Protected no-op endpoint for clients to verify access credentials."""
    return AuthCheckResponse(ok=True)


# Sentinel queued by the worker thread once login() returns or raises.
# The async generator uses it to terminate the SSE stream cleanly.
_DONE = object()


@router.get("/{provider_id}/login")
async def oauth_login(provider_id: str, request: Request):
    """Start an OAuth login flow and stream progress as SSE events.

    Events emitted (``event`` field of each SSE message):

    - ``started`` — flow initialised.
    - ``device_code`` — payload ``{verification_uri, user_code}``;
      client should open the URI and display the code.
    - ``polling`` — periodic heartbeat with ``elapsed_s``.
    - ``token_acquired`` — server-side milestone; no client action.
    - ``verifying`` — checking the provider's API with the token.
    - ``success`` — credentials saved; client can close the stream.
    - ``failed`` — terminal failure; payload includes ``reason``.

    The stream auto-closes after ``success`` or ``failed``.
    """
    entry = _PROVIDERS.get(provider_id)
    plugin_login = None
    if entry is None:
        from app.agent.providers.plugin_registry import find_provider_plugin

        plugin = find_provider_plugin(provider_id)
        if plugin is not None and plugin.kind == "oauth" and plugin.login is not None:
            plugin_login = plugin.login
    if entry is None and plugin_login is None:
        raise HTTPException(
            status_code=404,
            detail=(
                f"Unknown OAuth provider '{provider_id}'. Known: {sorted(_PROVIDERS)}."
            ),
        )
    module_path = entry[0] if entry is not None else ""
    use_browser = (
        provider_id == "codex" and request.query_params.get("mode") == "browser"
    )

    queue: asyncio.Queue[tuple[str, dict[str, Any]] | object] = asyncio.Queue()
    loop = asyncio.get_running_loop()
    failed_emitted = False

    def _sink(event: str, data: dict[str, Any]) -> None:
        nonlocal failed_emitted
        if event == "failed":
            failed_emitted = True
        # Called from the worker thread — bounce through the loop so
        # asyncio.Queue.put_nowait isn't called cross-thread.
        loop.call_soon_threadsafe(queue.put_nowait, (event, data))

    def _run_login() -> None:
        try:
            # All registered ``login`` functions accept ``event_sink`` as
            # a kwarg per the refactor in this PR; ``inspect`` is no
            # longer needed.
            if plugin_login is not None:
                plugin_login(_sink)
            else:
                mod = importlib.import_module(module_path)
                if use_browser:
                    mod.login(event_sink=_sink, browser=True)
                else:
                    mod.login(event_sink=_sink)
        except Exception as exc:  # noqa: BLE001 — surface everything to UI
            logger.warning("oauth_login_failed provider={} error={}", provider_id, exc)
            if not failed_emitted:
                loop.call_soon_threadsafe(
                    queue.put_nowait,
                    ("failed", {"message": str(exc), "reason": "exception"}),
                )
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, _DONE)

    async def _gen() -> AsyncGenerator[dict, None]:
        task = asyncio.create_task(asyncio.to_thread(_run_login))
        try:
            while True:
                # Cancel the worker if the client disconnects mid-flow.
                if await request.is_disconnected():
                    task.cancel()
                    break
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue
                if item is _DONE:
                    break
                # ty can't narrow ``tuple | object`` after the ``is _DONE``
                # check; assert so the static type matches the runtime
                # invariant (sentinel is the only ``object`` we put in).
                assert isinstance(item, tuple)
                event, data = item
                yield {"event": event, "data": json.dumps(data)}
        finally:
            if not task.done():
                task.cancel()

    return EventSourceResponse(_gen())


@router.post("/{provider_id}/callback")
async def oauth_callback(
    provider_id: str, body: OAuthCallbackBody
) -> OAuthCallbackResponse:
    from app.agent.providers.plugin_registry import find_provider_plugin

    callback_fn = None
    plugin = find_provider_plugin(provider_id)
    if plugin is not None and plugin.oauth_callback is not None:
        callback_fn = plugin.oauth_callback
    else:
        entry = _PROVIDERS.get(provider_id)
        if entry is not None:
            mod = importlib.import_module(entry[0])
            fn = getattr(mod, "callback", None) or getattr(mod, "oauth_callback", None)
            if callable(fn):
                callback_fn = fn

    if callback_fn is None:
        raise HTTPException(
            status_code=404, detail=f"OAuth callback unsupported for '{provider_id}'"
        )

    events: list[tuple[str, dict[str, Any]]] = []

    def _sink(event: str, data: dict[str, Any]) -> None:
        events.append((event, data))

    try:
        callback_fn(body.code, _sink)
    except Exception as exc:  # noqa: BLE001 - return plugin auth failures to UI
        logger.warning("oauth_callback_failed provider={} error={}", provider_id, exc)
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    failed = next((data for event, data in events if event == "failed"), None)
    if failed is not None:
        raise HTTPException(
            status_code=400, detail=failed.get("message", "OAuth callback failed")
        )
    success = next((data for event, data in events if event == "success"), {})
    return OAuthCallbackResponse(ok=True, **success)
