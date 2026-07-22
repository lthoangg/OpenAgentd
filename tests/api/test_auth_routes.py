"""Tests for app/api/routes/auth.py — UI-driven OAuth SSE endpoint."""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes.auth import router
from app.agent.providers.plugin_api import ProviderPlugin


def _make_app() -> FastAPI:
    app = FastAPI()
    app.include_router(router, prefix="/api/auth")
    return app


def test_unknown_provider_returns_404() -> None:
    app = _make_app()
    client = TestClient(app)
    response = client.get("/api/auth/notreal/login")
    assert response.status_code == 404
    assert "notreal" in response.json()["detail"]


def test_sse_stream_emits_events_from_stubbed_login(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Stubbed login() pushes events; the SSE response surfaces them in order.

    Verifies the contract: events arrive with the right ``event`` field
    and JSON-encoded ``data``, terminating after the final ``success``.
    """
    fake_module = type("M", (), {})()

    def fake_login(event_sink: Any = None, **_kwargs: Any) -> None:
        # Simulate the real login flow without hitting GitHub.
        assert event_sink is not None
        event_sink("started", {"message": "starting"})
        event_sink(
            "device_code",
            {
                "message": "Open https://x/device",
                "verification_uri": "https://x/device",
                "user_code": "ABCD-1234",
            },
        )
        event_sink("polling", {"message": "waiting", "elapsed_s": 1})
        # Tiny sleep so the queue drains in order through the loop.
        time.sleep(0.01)
        event_sink(
            "success",
            {"message": "done", "oauth_path": "/tmp/x.json"},
        )

    fake_module.login = fake_login

    # Replace the provider's login module with our fake. The route looks
    # up the module via importlib using the path stored in _PROVIDERS.
    import app.api.routes.auth as auth_route

    monkeypatch.setattr(
        auth_route,
        "_PROVIDERS",
        {"copilot": ("test_auth_routes_fake_module", "fake")},
    )

    def fake_import(_name: str) -> Any:
        return fake_module

    monkeypatch.setattr(auth_route.importlib, "import_module", fake_import)

    app = _make_app()
    client = TestClient(app)
    with client.stream("GET", "/api/auth/copilot/login") as response:
        assert response.status_code == 200
        # Collect all SSE messages from the stream. Each message is one
        # or more lines like ``event: foo\ndata: {...}\n\n``.
        raw = b""
        for chunk in response.iter_bytes():
            raw += chunk
        text = raw.decode("utf-8")

    # Parse the event/data pairs out of the raw SSE text.
    events: list[tuple[str, dict[str, Any]]] = []
    cur_event: str | None = None
    for line in text.splitlines():
        if line.startswith("event:"):
            cur_event = line.removeprefix("event:").strip()
        elif line.startswith("data:") and cur_event is not None:
            payload = json.loads(line.removeprefix("data:").strip())
            events.append((cur_event, payload))
            cur_event = None

    event_names = [e[0] for e in events]
    assert event_names == ["started", "device_code", "polling", "success"]

    # The device_code event carries enough for the client to render the
    # modal — verification URL + user code.
    device_payload = next(p for n, p in events if n == "device_code")
    assert device_payload["verification_uri"] == "https://x/device"
    assert device_payload["user_code"] == "ABCD-1234"


def test_sse_stream_surfaces_exception_from_login(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If login() raises, the stream emits a ``failed`` event and closes."""
    fake_module = type("M", (), {})()

    def fake_login(event_sink: Any = None, **_kwargs: Any) -> None:
        event_sink("started", {"message": "starting"})
        raise RuntimeError("synthetic failure")

    fake_module.login = fake_login

    import app.api.routes.auth as auth_route

    monkeypatch.setattr(
        auth_route,
        "_PROVIDERS",
        {"copilot": ("fake", "fake")},
    )
    monkeypatch.setattr(
        auth_route.importlib, "import_module", lambda _name: fake_module
    )

    app = _make_app()
    client = TestClient(app)
    with client.stream("GET", "/api/auth/copilot/login") as response:
        text = b"".join(response.iter_bytes()).decode("utf-8")

    # Should contain both ``started`` and a ``failed`` terminating event.
    assert "event: started" in text
    assert "event: failed" in text
    assert "synthetic failure" in text


def test_sse_stream_does_not_duplicate_provider_failed_event(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Providers may emit ``failed`` before raising to stop their flow."""
    fake_module = type("M", (), {})()

    def fake_login(event_sink: Any = None, **_kwargs: Any) -> None:
        event_sink("failed", {"message": "device expired", "reason": "expired"})
        raise RuntimeError("device_code_expired")

    fake_module.login = fake_login

    import app.api.routes.auth as auth_route

    monkeypatch.setattr(auth_route, "_PROVIDERS", {"codex": ("fake", "fake")})
    monkeypatch.setattr(
        auth_route.importlib, "import_module", lambda _name: fake_module
    )

    app = _make_app()
    client = TestClient(app)
    with client.stream("GET", "/api/auth/codex/login") as response:
        text = b"".join(response.iter_bytes()).decode("utf-8")

    assert text.count("event: failed") == 1
    assert "device expired" in text
    assert "device_code_expired" not in text


def test_codex_login_browser_mode_passes_browser_flag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_module = type("M", (), {})()
    seen: list[dict[str, Any]] = []

    def fake_login(event_sink: Any = None, **kwargs: Any) -> None:
        seen.append(kwargs)
        assert event_sink is not None
        event_sink("browser_auth", {"message": "open browser"})

    fake_module.login = fake_login

    import app.api.routes.auth as auth_route

    monkeypatch.setattr(auth_route, "_PROVIDERS", {"codex": ("fake", "fake")})
    monkeypatch.setattr(
        auth_route.importlib, "import_module", lambda _name: fake_module
    )

    client = TestClient(_make_app())
    with client.stream("GET", "/api/auth/codex/login?mode=browser") as response:
        text = b"".join(response.iter_bytes()).decode("utf-8")

    assert response.status_code == 200
    assert seen == [{"browser": True}]
    assert "event: browser_auth" in text


def test_plugin_oauth_login_streams_plugin_events(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """OAuth provider plugins use the same SSE login endpoint as built-ins."""
    import app.agent.providers.plugin_registry as registry

    def login(event_sink: Any = None) -> None:
        assert event_sink is not None
        event_sink("started", {"message": "plugin started"})
        event_sink("code_required", {"message": "paste code"})

    plugin = ProviderPlugin(
        id="plugin-oauth",
        label="Plugin OAuth",
        description="Synthetic OAuth provider.",
        kind="oauth",
        factory=lambda ctx: (_ for _ in ()).throw(AssertionError("not used")),
        login=login,
    )
    monkeypatch.setattr(registry, "find_provider_plugin", lambda _id: plugin)

    client = TestClient(_make_app())
    with client.stream("GET", "/api/auth/plugin-oauth/login") as response:
        text = b"".join(response.iter_bytes()).decode("utf-8")

    assert response.status_code == 200
    assert "event: started" in text
    assert "plugin started" in text
    assert "event: code_required" in text


def test_plugin_oauth_callback_returns_success_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Callback route delegates code exchange to the owning provider plugin."""
    import app.agent.providers.plugin_registry as registry

    seen_codes: list[str] = []

    def callback(code: str, event_sink: Any = None) -> None:
        seen_codes.append(code)
        assert event_sink is not None
        event_sink("token_acquired", {"message": "saved"})
        event_sink("success", {"suggested_model": "plugin-oauth:model-a"})

    plugin = ProviderPlugin(
        id="plugin-oauth",
        label="Plugin OAuth",
        description="Synthetic OAuth provider.",
        kind="oauth",
        factory=lambda ctx: (_ for _ in ()).throw(AssertionError("not used")),
        oauth_callback=callback,
    )
    monkeypatch.setattr(registry, "find_provider_plugin", lambda _id: plugin)

    response = TestClient(_make_app()).post(
        "/api/auth/plugin-oauth/callback",
        json={"code": "code#state"},
    )

    assert response.status_code == 200
    assert seen_codes == ["code#state"]
    assert response.json() == {"ok": True, "suggested_model": "plugin-oauth:model-a"}


@pytest.mark.parametrize("code", ["", "   ", "x" * 8193])
def test_oauth_callback_rejects_invalid_code(code: str) -> None:
    response = TestClient(_make_app()).post(
        "/api/auth/plugin-oauth/callback",
        json={"code": code},
    )

    assert response.status_code == 422


def test_builtin_oauth_callback_returns_success_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Callback route delegates code exchange to built-in provider module if callback() exists."""
    fake_module = type("M", (), {})()
    seen_codes: list[str] = []

    def callback(code: str, event_sink: Any = None) -> None:
        seen_codes.append(code)
        assert event_sink is not None
        event_sink("success", {"message": "builtin logged in"})

    fake_module.callback = callback

    import app.api.routes.auth as auth_route

    monkeypatch.setattr(auth_route, "_PROVIDERS", {"codex": ("fake_codex", "fake")})
    monkeypatch.setattr(
        auth_route.importlib, "import_module", lambda _name: fake_module
    )

    response = TestClient(_make_app()).post(
        "/api/auth/codex/callback",
        json={"code": "valid_code_123"},
    )

    assert response.status_code == 200
    assert seen_codes == ["valid_code_123"]
    assert response.json() == {"ok": True, "message": "builtin logged in"}


def test_plugin_oauth_callback_failure_returns_400(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Provider-owned callback failures are surfaced as client errors."""
    import app.agent.providers.plugin_registry as registry

    def callback(_code: str, event_sink: Any = None) -> None:
        assert event_sink is not None
        event_sink("failed", {"message": "bad verifier", "reason": "state_mismatch"})

    plugin = ProviderPlugin(
        id="plugin-oauth",
        label="Plugin OAuth",
        description="Synthetic OAuth provider.",
        kind="oauth",
        factory=lambda ctx: (_ for _ in ()).throw(AssertionError("not used")),
        oauth_callback=callback,
    )
    monkeypatch.setattr(registry, "find_provider_plugin", lambda _id: plugin)

    response = TestClient(_make_app()).post(
        "/api/auth/plugin-oauth/callback",
        json={"code": "wrong"},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "bad verifier"


async def test_event_sink_pushes_via_loop(monkeypatch: pytest.MonkeyPatch) -> None:
    """Smoke test: the _sink closure puts items on the queue via the loop.

    Mirrors the contract used by the SSE route. Built standalone so the
    test doesn't have to bring up a full FastAPI server.
    """
    queue: asyncio.Queue[tuple[str, dict[str, Any]] | object] = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def sink(event: str, data: dict[str, Any]) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, (event, data))

    # Drive it from a thread the way the real route does.
    await asyncio.to_thread(sink, "hello", {"k": "v"})

    item = await asyncio.wait_for(queue.get(), timeout=1.0)
    assert isinstance(item, tuple)
    assert item == ("hello", {"k": "v"})
