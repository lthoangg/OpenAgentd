"""Tests for generate_video with the ``googlegenai`` (Veo) backend.

Covers:

- Missing ``GOOGLE_API_KEY`` → framed error, transport uncalled.
- Text-to-video happy path: POST to ``:predictLongRunning``, poll until
  ``done=true``, download mp4, write to workspace, return markdown.
- Polling survives a pending response before the done one.
- Aspect ratio / resolution / duration overrides forwarded as camelCase
  ``parameters``.
- Image-to-video: ``image`` inlineData on the instance.
- First+last interpolation: ``image`` + ``lastFrame`` both inlined.
- Reference images: ``referenceImages`` array with ``referenceType: asset``.
- Start-time API error bubbles up.
- Poll-time API error bubbles up.
- Operation failure (``error`` object on done response) bubbles up.
- Operation missing video URI returns framed error.
- Dispatcher-level guards: invalid aspect_ratio / resolution / duration
  rejected before HTTP; reference_images > 3 rejected; last_frame without
  images rejected; reference_images + last_frame rejected.
- Video extension enum silently ignores image-shaped params.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Iterator
from pathlib import Path

import httpx2
import pytest

from app.agent.denied_paths import (
    DeniedPathsConfig as SandboxConfig,
    set_denied_paths as set_sandbox,
)
from app.agent.tools.multimodalities import _config as mm_config
from app.agent.tools.multimodalities.backends import googlegenai_video as ggv
from app.agent.tools.multimodalities.video import _generate_video


@pytest.fixture
def tmp_sandbox(tmp_path: Path) -> Iterator[SandboxConfig]:
    sandbox = SandboxConfig(workspace=str(tmp_path / "workspace"))
    token = set_sandbox(sandbox)
    try:
        yield sandbox
    finally:
        import contextvars

        contextvars.copy_context()  # no-op, keeps linter happy
        del token


@pytest.fixture
def config_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    cfg = tmp_path / "config"
    cfg.mkdir()
    monkeypatch.setattr("app.core.config.settings.OPENAGENTD_CONFIG_DIR", str(cfg))
    monkeypatch.setattr(mm_config, "_cache", None)
    return cfg


@pytest.fixture(autouse=True)
def _clear_settings_google_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """Neutralise ``settings.GOOGLE_API_KEY`` so tests drive auth via env only."""
    monkeypatch.setattr("app.core.config.settings.GOOGLE_API_KEY", None)


@pytest.fixture(autouse=True)
def _zero_poll_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    """Neutralise the poll-loop sleep so tests finish in ms, not seconds.

    The backend uses ``asyncio.sleep`` between polls to the ``operations/...``
    endpoint. Tests override this with a no-op coroutine.
    """

    async def _fast_sleep(_: float) -> None:
        return None

    monkeypatch.setattr(ggv.asyncio, "sleep", _fast_sleep)


def _write_config(config_dir: Path, body: str) -> None:
    (config_dir / "multimodal.yaml").write_text(body, encoding="utf-8")


def _install_mock_transport(
    monkeypatch: pytest.MonkeyPatch,
    handler: "Callable[[httpx2.Request], httpx2.Response]",
) -> None:
    """Route all Veo backend httpx2 traffic to ``handler``."""
    transport = httpx2.MockTransport(handler)
    real_async_client = httpx2.AsyncClient

    def _mock_async_client(*args: object, **kwargs: object) -> httpx2.AsyncClient:
        kwargs["transport"] = transport
        return real_async_client(*args, **kwargs)

    monkeypatch.setattr(
        "app.agent.tools.multimodalities.backends.googlegenai_video.httpx2.AsyncClient",
        _mock_async_client,
    )


def _done_response(uri: str) -> dict:
    """Canonical Veo ``done=true`` operation body."""
    return {
        "done": True,
        "response": {
            "generateVideoResponse": {"generatedSamples": [{"video": {"uri": uri}}]}
        },
    }


# ─────────────────────────────────────────────────────────────────────────────
# Auth gate
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_missing_api_key_env_returns_error(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(
        config_dir,
        "video:\n  model: googlegenai:veo-3.1-generate-preview\n",
    )
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)

    called = False

    def _handler(_: httpx2.Request) -> httpx2.Response:
        nonlocal called
        called = True
        return httpx2.Response(200)

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_video(prompt="a lion")
    assert result.startswith("Error:")
    assert "GOOGLE_API_KEY" in result
    assert called is False


# ─────────────────────────────────────────────────────────────────────────────
# Text-to-video happy path + polling
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_text_to_video_success_writes_mp4_and_returns_markdown(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(
        config_dir,
        "video:\n  model: veo-3.1-generate-preview\n".replace(
            "model: veo-3.1", "model: googlegenai:veo-3.1"
        ),
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    fake_mp4 = b"\x00\x00\x00\x18ftypisomFAKEMP4"
    # Sequence: 1) start → operation name; 2) poll pending; 3) poll done;
    # 4) download mp4.
    calls: list[str] = []

    def _handler(request: httpx2.Request) -> httpx2.Response:
        url = str(request.url)
        calls.append(f"{request.method} {url}")
        assert request.headers["x-goog-api-key"] == "k-test"

        if request.method == "POST" and url.endswith(
            "/models/veo-3.1-generate-preview:predictLongRunning"
        ):
            import json as _json

            body = _json.loads(request.content)
            # One instance with just the prompt.
            assert body["instances"] == [{"prompt": "a lion"}]
            # No parameters block when nothing was overridden.
            assert "parameters" not in body
            return httpx2.Response(200, json={"name": "operations/abc123"})

        if request.method == "GET" and url.endswith("/operations/abc123"):
            # First poll returns pending, second returns done.
            poll_count = sum(1 for c in calls if "GET" in c)
            if poll_count == 1:
                return httpx2.Response(200, json={"done": False})
            return httpx2.Response(
                200,
                json=_done_response("https://cdn.google.test/videos/abc123.mp4"),
            )

        if request.method == "GET" and "cdn.google.test" in url:
            return httpx2.Response(200, content=fake_mp4)

        raise AssertionError(f"unexpected request {request.method} {url}")

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_video(prompt="a lion", filename="lion")
    assert result.startswith("![a lion](lion.mp4)")
    # URI note must be present so the LLM can use it for extension.
    assert "extend_video=" in result
    assert "https://cdn.google.test/videos/abc123.mp4" in result
    written = tmp_sandbox.workspace_root / "lion.mp4"
    assert written.exists()
    assert written.read_bytes() == fake_mp4
    # Exactly: start + 2 polls + 1 download = 4 calls.
    assert len(calls) == 4


# ─────────────────────────────────────────────────────────────────────────────
# Parameter overrides
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_overrides_forwarded_as_parameters(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(
        config_dir,
        "video:\n"
        "  model: googlegenai:veo-3.1-generate-preview\n"
        "  aspect_ratio: '16:9'\n"
        "  resolution: '720p'\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    fake_mp4 = b"MP4"

    def _handler(request: httpx2.Request) -> httpx2.Response:
        url = str(request.url)
        if request.method == "POST":
            import json as _json

            body = _json.loads(request.content)
            # Per-call overrides win over YAML, YAML values still present for
            # keys not overridden. durationSeconds is coerced from the tool's
            # string enum to an int because Veo rejects numeric strings.
            assert body["parameters"] == {
                "aspectRatio": "9:16",
                "resolution": "1080p",
                "durationSeconds": 8,
            }
            return httpx2.Response(200, json={"name": "operations/x"})
        if "operations/x" in url:
            return httpx2.Response(
                200, json=_done_response("https://cdn.google.test/x.mp4")
            )
        return httpx2.Response(200, content=fake_mp4)

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_video(
        prompt="pizza",
        aspect_ratio="9:16",
        resolution="1080p",
        duration_seconds="8",
    )
    assert result.startswith("![pizza](")


@pytest.mark.asyncio
async def test_yaml_duration_as_int_forwarded_as_int(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Veo rejects numeric strings for durationSeconds/seed.

    Guard: YAML-provided ints pass through unchanged; string YAML values get
    coerced to int; the wire payload never carries a numeric string.
    """
    _write_config(
        config_dir,
        "video:\n"
        "  model: googlegenai:veo-3.1-generate-preview\n"
        "  duration_seconds: 6\n"  # YAML int
        "  seed: '42'\n",  # YAML string
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    def _handler(request: httpx2.Request) -> httpx2.Response:
        url = str(request.url)
        if request.method == "POST":
            import json as _json

            body = _json.loads(request.content)
            assert body["parameters"]["durationSeconds"] == 6
            assert body["parameters"]["seed"] == 42
            # And they are not strings on the wire.
            assert not isinstance(body["parameters"]["durationSeconds"], str)
            assert not isinstance(body["parameters"]["seed"], str)
            return httpx2.Response(200, json={"name": "operations/x"})
        if "operations/x" in url:
            return httpx2.Response(
                200, json=_done_response("https://cdn.google.test/x.mp4")
            )
        return httpx2.Response(200, content=b"MP4")

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_video(prompt="coerce")
    assert result.startswith("![coerce](")


# ─────────────────────────────────────────────────────────────────────────────
# Image-to-video, interpolation, reference images
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_image_to_video_inlines_first_frame(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(
        config_dir,
        "video:\n  model: googlegenai:veo-3.1-generate-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    workspace = tmp_sandbox.workspace_root
    workspace.mkdir(parents=True, exist_ok=True)
    first_png = b"\x89PNG\r\n\x1a\nFIRST"
    (workspace / "first.png").write_bytes(first_png)

    def _handler(request: httpx2.Request) -> httpx2.Response:
        url = str(request.url)
        if request.method == "POST":
            import base64 as _b64
            import json as _json

            body = _json.loads(request.content)
            instance = body["instances"][0]
            assert instance["prompt"] == "animate"
            assert "lastFrame" not in instance
            assert "referenceImages" not in instance
            # Veo's wire format: flat bytesBase64Encoded + mimeType (not inlineData).
            img = instance["image"]
            assert img["mimeType"] == "image/png"
            assert _b64.b64decode(img["bytesBase64Encoded"]) == first_png
            return httpx2.Response(200, json={"name": "operations/x"})
        if "operations/x" in url:
            return httpx2.Response(
                200, json=_done_response("https://cdn.google.test/x.mp4")
            )
        return httpx2.Response(200, content=b"MP4")

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_video(
        prompt="animate", first_frame="first.png", filename="out"
    )
    assert result.startswith("![animate](out.mp4)")


@pytest.mark.asyncio
async def test_first_and_last_frame_interpolation(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(
        config_dir,
        "video:\n  model: googlegenai:veo-3.1-generate-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    workspace = tmp_sandbox.workspace_root
    workspace.mkdir(parents=True, exist_ok=True)
    first_png = b"\x89PNG\r\n\x1a\nONE"
    last_jpg = b"\xff\xd8\xff\xe0TWO"
    (workspace / "a.png").write_bytes(first_png)
    (workspace / "b.jpg").write_bytes(last_jpg)

    def _handler(request: httpx2.Request) -> httpx2.Response:
        url = str(request.url)
        if request.method == "POST":
            import base64 as _b64
            import json as _json

            body = _json.loads(request.content)
            instance = body["instances"][0]
            # Veo's wire format: flat bytesBase64Encoded + mimeType (not inlineData).
            assert instance["image"]["mimeType"] == "image/png"
            assert _b64.b64decode(instance["image"]["bytesBase64Encoded"]) == first_png
            assert instance["lastFrame"]["mimeType"] == "image/jpeg"
            assert (
                _b64.b64decode(instance["lastFrame"]["bytesBase64Encoded"]) == last_jpg
            )
            return httpx2.Response(200, json={"name": "operations/x"})
        if "operations/x" in url:
            return httpx2.Response(
                200, json=_done_response("https://cdn.google.test/x.mp4")
            )
        return httpx2.Response(200, content=b"MP4")

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_video(
        prompt="morph",
        first_frame="a.png",
        last_frame="b.jpg",
    )
    assert result.startswith("![morph](")


@pytest.mark.asyncio
async def test_reference_images_forwarded_with_asset_type(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(
        config_dir,
        "video:\n  model: googlegenai:veo-3.1-generate-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    workspace = tmp_sandbox.workspace_root
    workspace.mkdir(parents=True, exist_ok=True)
    r1 = b"REF1"
    r2 = b"REF2"
    (workspace / "r1.png").write_bytes(r1)
    (workspace / "r2.png").write_bytes(r2)

    def _handler(request: httpx2.Request) -> httpx2.Response:
        url = str(request.url)
        if request.method == "POST":
            import base64 as _b64
            import json as _json

            body = _json.loads(request.content)
            instance = body["instances"][0]
            refs = instance["referenceImages"]
            assert len(refs) == 2
            for ref, expected in zip(refs, [r1, r2], strict=False):
                assert ref["referenceType"] == "asset"
                # Veo's wire format: flat bytesBase64Encoded + mimeType (not inlineData).
                assert _b64.b64decode(ref["image"]["bytesBase64Encoded"]) == expected
            return httpx2.Response(200, json={"name": "operations/x"})
        if "operations/x" in url:
            return httpx2.Response(
                200, json=_done_response("https://cdn.google.test/x.mp4")
            )
        return httpx2.Response(200, content=b"MP4")

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_video(
        prompt="style",
        reference_images=["r1.png", "r2.png"],
    )
    assert result.startswith("![style](")


# ─────────────────────────────────────────────────────────────────────────────
# Error propagation
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_start_api_error_bubbled(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(
        config_dir,
        "video:\n  model: googlegenai:veo-3.1-generate-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    def _handler(_: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(429, text='{"error":"rate limited"}')

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_video(prompt="x")
    assert result.startswith("Error: Veo API returned 429")


@pytest.mark.asyncio
async def test_poll_api_error_bubbled(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(
        config_dir,
        "video:\n  model: googlegenai:veo-3.1-generate-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    def _handler(request: httpx2.Request) -> httpx2.Response:
        if request.method == "POST":
            return httpx2.Response(200, json={"name": "operations/x"})
        return httpx2.Response(500, text="boom")

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_video(prompt="x")
    assert result.startswith("Error: Veo operation poll returned 500")


@pytest.mark.asyncio
async def test_operation_error_on_done_bubbled(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(
        config_dir,
        "video:\n  model: googlegenai:veo-3.1-generate-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    def _handler(request: httpx2.Request) -> httpx2.Response:
        if request.method == "POST":
            return httpx2.Response(200, json={"name": "operations/x"})
        return httpx2.Response(
            200,
            json={
                "done": True,
                "error": {"code": 3, "message": "safety filter blocked output"},
            },
        )

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_video(prompt="x")
    assert result.startswith("Error: Veo operation failed")
    assert "safety filter" in result


@pytest.mark.asyncio
async def test_done_without_video_uri_returns_framed_error(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(
        config_dir,
        "video:\n  model: googlegenai:veo-3.1-generate-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    def _handler(request: httpx2.Request) -> httpx2.Response:
        if request.method == "POST":
            return httpx2.Response(200, json={"name": "operations/x"})
        # done but missing generatedSamples
        return httpx2.Response(
            200, json={"done": True, "response": {"generateVideoResponse": {}}}
        )

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_video(prompt="x")
    assert result.startswith("Error:")
    assert "no video URI" in result


@pytest.mark.asyncio
async def test_polling_times_out(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(
        config_dir,
        "video:\n  model: googlegenai:veo-3.1-generate-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    # Collapse the deadline so the second poll tips over it.
    monkeypatch.setattr(ggv, "_MAX_WAIT_SECONDS", 0.0)

    def _handler(request: httpx2.Request) -> httpx2.Response:
        if request.method == "POST":
            return httpx2.Response(200, json={"name": "operations/x"})
        # Perpetually pending.
        return httpx2.Response(200, json={"done": False})

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_video(prompt="x")
    assert result.startswith("Error:")
    assert "did not complete" in result


# ─────────────────────────────────────────────────────────────────────────────
# Dispatcher-level enum / mode guards — rejected before HTTP
# ─────────────────────────────────────────────────────────────────────────────


def _trap_handler() -> tuple[Callable[[httpx2.Request], httpx2.Response], list[bool]]:
    """Return a handler that flags any call and the flag list to inspect."""
    flagged: list[bool] = []

    def _handler(_: httpx2.Request) -> httpx2.Response:
        flagged.append(True)
        return httpx2.Response(200)

    return _handler, flagged


@pytest.mark.asyncio
async def test_invalid_aspect_ratio_rejected_before_http(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(
        config_dir,
        "video:\n  model: googlegenai:veo-3.1-generate-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")
    handler, flagged = _trap_handler()
    _install_mock_transport(monkeypatch, handler)

    bad: str = "1:1"
    result = await _generate_video(prompt="x", aspect_ratio=bad)  # type: ignore[arg-type]
    assert result.startswith("Error:")
    assert "aspect_ratio" in result
    assert flagged == []


@pytest.mark.asyncio
async def test_invalid_resolution_rejected_before_http(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(
        config_dir,
        "video:\n  model: googlegenai:veo-3.1-generate-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")
    handler, flagged = _trap_handler()
    _install_mock_transport(monkeypatch, handler)

    bad: str = "8k"
    result = await _generate_video(prompt="x", resolution=bad)  # type: ignore[arg-type]
    assert result.startswith("Error:")
    assert "resolution" in result
    assert flagged == []


@pytest.mark.asyncio
async def test_invalid_duration_rejected_before_http(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(
        config_dir,
        "video:\n  model: googlegenai:veo-3.1-generate-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")
    handler, flagged = _trap_handler()
    _install_mock_transport(monkeypatch, handler)

    bad: str = "10"
    result = await _generate_video(prompt="x", duration_seconds=bad)  # type: ignore[arg-type]
    assert result.startswith("Error:")
    assert "duration_seconds" in result
    assert flagged == []


@pytest.mark.asyncio
async def test_empty_first_frame_rejected_before_http(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(
        config_dir,
        "video:\n  model: googlegenai:veo-3.1-generate-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")
    handler, flagged = _trap_handler()
    _install_mock_transport(monkeypatch, handler)

    result = await _generate_video(prompt="x", first_frame="")
    assert result.startswith("Error:")
    assert "image path must be a non-empty workspace string" in result
    assert flagged == []


@pytest.mark.asyncio
async def test_too_many_reference_images_rejected_before_http(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(
        config_dir,
        "video:\n  model: googlegenai:veo-3.1-generate-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")
    workspace = tmp_sandbox.workspace_root
    workspace.mkdir(parents=True, exist_ok=True)
    names: list[str] = []
    for i in range(4):
        n = f"r{i}.png"
        (workspace / n).write_bytes(b"x")
        names.append(n)
    handler, flagged = _trap_handler()
    _install_mock_transport(monkeypatch, handler)

    result = await _generate_video(prompt="x", reference_images=names)
    assert result.startswith("Error:")
    assert "up to 3" in result
    assert flagged == []


@pytest.mark.asyncio
async def test_last_frame_without_first_rejected_before_http(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(
        config_dir,
        "video:\n  model: googlegenai:veo-3.1-generate-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")
    workspace = tmp_sandbox.workspace_root
    workspace.mkdir(parents=True, exist_ok=True)
    (workspace / "b.png").write_bytes(b"B")
    handler, flagged = _trap_handler()
    _install_mock_transport(monkeypatch, handler)

    result = await _generate_video(prompt="x", last_frame="b.png")
    assert result.startswith("Error:")
    assert "last_frame" in result
    assert flagged == []


@pytest.mark.asyncio
async def test_reference_and_last_frame_mutually_exclusive(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(
        config_dir,
        "video:\n  model: googlegenai:veo-3.1-generate-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")
    workspace = tmp_sandbox.workspace_root
    workspace.mkdir(parents=True, exist_ok=True)
    (workspace / "a.png").write_bytes(b"A")
    (workspace / "b.png").write_bytes(b"B")
    (workspace / "r.png").write_bytes(b"R")
    handler, flagged = _trap_handler()
    _install_mock_transport(monkeypatch, handler)

    result = await _generate_video(
        prompt="x",
        first_frame="a.png",
        last_frame="b.png",
        reference_images=["r.png"],
    )
    assert result.startswith("Error:")
    assert "mutually exclusive" in result
    assert flagged == []


@pytest.mark.asyncio
async def test_missing_sandbox_input_rejected_before_http(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(
        config_dir,
        "video:\n  model: googlegenai:veo-3.1-generate-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")
    handler, flagged = _trap_handler()
    _install_mock_transport(monkeypatch, handler)

    # File not created → sandbox load returns "does not exist".
    result = await _generate_video(prompt="x", first_frame="ghost.png")
    assert result.startswith("Error:")
    assert "does not exist" in result
    assert flagged == []


@pytest.mark.asyncio
async def test_misconfigured_provider_rejected_before_http(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(
        config_dir,
        "video:\n  model: unknownprovider:someversion\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")
    handler, flagged = _trap_handler()
    _install_mock_transport(monkeypatch, handler)

    result = await _generate_video(prompt="x")
    assert result.startswith("Error:")
    assert "unknownprovider" in result
    assert flagged == []


@pytest.mark.asyncio
async def test_missing_video_section_returns_configuration_error(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Only image section written — video section missing.
    _write_config(
        config_dir,
        "image:\n  model: googlegenai:gemini-3.1-flash-image-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")
    handler, flagged = _trap_handler()
    _install_mock_transport(monkeypatch, handler)

    result = await _generate_video(prompt="x")
    assert result.startswith("Error:")
    assert "not configured" in result
    assert flagged == []


# ─────────────────────────────────────────────────────────────────────────────
# Paranoia: the background fast-sleep fixture really replaces the poll sleep.
# If a test regresses and uses real sleep, the ``test_text_to_video_success``
# test above already asserts the call count matches — two real 10s sleeps
# would blow past pytest's default timeout long before that.
# ─────────────────────────────────────────────────────────────────────────────


def test_fast_sleep_fixture_is_noop(monkeypatch: pytest.MonkeyPatch) -> None:
    """Smoke-check: the patched sleep resolves immediately."""

    async def _run() -> None:
        await ggv.asyncio.sleep(100.0)

    asyncio.get_event_loop().run_until_complete(_run())


# ─────────────────────────────────────────────────────────────────────────────
# Dispatcher-level isolation: mock backend, assert output format + workspace
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_dispatcher_mocks_backend_and_validates_markdown_output(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Dispatcher layer: mock backend, assert markdown format and workspace write.

    This test isolates the dispatcher from the backend by mocking
    ``_call_video_backend`` (the internal backend call). It verifies:
    - Markdown format: ``![prompt](filename.mp4)``
    - File written to workspace
    - Filename matches the requested slug
    """
    _write_config(
        config_dir,
        "video:\n  model: googlegenai:veo-3.1-generate-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    fake_mp4 = b"\x00\x00\x00\x18ftypisomFAKEMP4"

    # Mock the backend to return bytes directly.
    async def _mock_backend(*args: object, **kwargs: object) -> tuple[bytes, str] | str:
        return (
            fake_mp4,
            "https://generativelanguage.googleapis.com/v1beta/files/test123",
        )

    monkeypatch.setattr(
        "app.agent.tools.multimodalities.video._VIDEO_BACKENDS",
        {"googlegenai": _mock_backend},
    )

    result = await _generate_video(prompt="test prompt", filename="my-video")

    # Assert markdown format.
    assert result.startswith("![test prompt](my-video.mp4)")

    # Assert file written to workspace.
    written = tmp_sandbox.workspace_root / "my-video.mp4"
    assert written.exists()
    assert written.read_bytes() == fake_mp4


@pytest.mark.asyncio
async def test_dispatcher_generates_unique_filename_when_slug_empty(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Dispatcher: UUID fallback when filename slug is None or empty."""
    _write_config(
        config_dir,
        "video:\n  model: googlegenai:veo-3.1-generate-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    fake_mp4 = b"MP4"

    async def _mock_backend(*args: object, **kwargs: object) -> tuple[bytes, str] | str:
        return (
            fake_mp4,
            "https://generativelanguage.googleapis.com/v1beta/files/test123",
        )

    monkeypatch.setattr(
        "app.agent.tools.multimodalities.video._VIDEO_BACKENDS",
        {"googlegenai": _mock_backend},
    )

    # Call with no filename → should generate UUID-based name.
    result = await _generate_video(prompt="test")

    # Result should be markdown with a UUID-based filename.
    assert result.startswith("![test](video-")
    assert ".mp4)" in result

    # Extract filename and verify it exists.
    filename = result.split("(")[1].split(")")[0]
    written = tmp_sandbox.workspace_root / filename
    assert written.exists()


@pytest.mark.asyncio
async def test_dispatcher_sanitises_filename_special_chars(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Dispatcher: special characters in filename replaced with dashes."""
    _write_config(
        config_dir,
        "video:\n  model: googlegenai:veo-3.1-generate-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    fake_mp4 = b"MP4"

    async def _mock_backend(*args: object, **kwargs: object) -> tuple[bytes, str] | str:
        return (
            fake_mp4,
            "https://generativelanguage.googleapis.com/v1beta/files/test123",
        )

    monkeypatch.setattr(
        "app.agent.tools.multimodalities.video._VIDEO_BACKENDS",
        {"googlegenai": _mock_backend},
    )

    # Filename with special chars (note: extension is stripped, so .test becomes part of stem).
    result = await _generate_video(prompt="test", filename="my/video:name@2024")

    # Special chars should be replaced with dashes.
    assert "my-video-name-2024.mp4" in result
    written = tmp_sandbox.workspace_root / "my-video-name-2024.mp4"
    assert written.exists()


@pytest.mark.asyncio
async def test_dispatcher_uses_sandbox_display_path_in_markdown(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Dispatcher: markdown uses sandbox.display_path() for the file reference.

    The markdown should contain a path suitable for the /media/ proxy,
    not an absolute filesystem path.
    """
    _write_config(
        config_dir,
        "video:\n  model: googlegenai:veo-3.1-generate-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    fake_mp4 = b"MP4"

    async def _mock_backend(*args: object, **kwargs: object) -> tuple[bytes, str] | str:
        return (
            fake_mp4,
            "https://generativelanguage.googleapis.com/v1beta/files/test123",
        )

    monkeypatch.setattr(
        "app.agent.tools.multimodalities.video._VIDEO_BACKENDS",
        {"googlegenai": _mock_backend},
    )

    result = await _generate_video(prompt="test", filename="video")

    # Markdown should contain just the filename, not an absolute path.
    assert result.startswith("![test](video.mp4)")
    # Should not contain workspace root path.
    assert str(tmp_sandbox.workspace_root) not in result


# ─────────────────────────────────────────────────────────────────────────────
# Sandbox edge cases: symlinks, directories, oversized files
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_symlink_to_denied_root_rejected_by_sandbox(
    tmp_path: Path,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Sandbox: symlinks pointing into a denied root are rejected.

    Generic symlinks within the workspace are allowed under the denylist
    model; only symlinks whose target lands inside a denied root must be
    refused.
    """
    _write_config(
        config_dir,
        "video:\n  model: googlegenai:veo-3.1-generate-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    # Build a sandbox with an explicit denied root.
    workspace = tmp_path / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    denied = tmp_path / "denied"
    denied.mkdir(parents=True, exist_ok=True)
    secret = denied / "secret.png"
    secret.write_bytes(b"PNG-SECRET")

    sandbox = SandboxConfig(
        workspace=str(workspace),
        memory=str(tmp_path / "memory"),
        denied_roots=[denied],
    )
    set_sandbox(sandbox)

    # Plant a symlink inside the workspace that escapes into the denied root.
    symlink = workspace / "link.png"
    symlink.symlink_to(secret)

    handler, flagged = _trap_handler()
    _install_mock_transport(monkeypatch, handler)

    result = await _generate_video(prompt="x", first_frame="link.png")

    # Should be rejected before HTTP.
    assert result.startswith("Error:")
    assert (
        "rejected by sandbox" in result
        or "symlink" in result.lower()
        or "denied" in result.lower()
    )
    assert flagged == []


@pytest.mark.asyncio
async def test_directory_input_rejected_as_not_file(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Sandbox: directory paths are rejected (not a regular file)."""
    _write_config(
        config_dir,
        "video:\n  model: googlegenai:veo-3.1-generate-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    workspace = tmp_sandbox.workspace_root
    workspace.mkdir(parents=True, exist_ok=True)
    (workspace / "subdir").mkdir()

    handler, flagged = _trap_handler()
    _install_mock_transport(monkeypatch, handler)

    result = await _generate_video(prompt="x", first_frame="subdir")

    assert result.startswith("Error:")
    assert "not a regular file" in result
    assert flagged == []


@pytest.mark.asyncio
async def test_oversized_input_image_rejected(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Sandbox: input images > 5 MB are rejected."""
    _write_config(
        config_dir,
        "video:\n  model: googlegenai:veo-3.1-generate-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    workspace = tmp_sandbox.workspace_root
    workspace.mkdir(parents=True, exist_ok=True)

    # Create a file just over 5 MB.
    oversized = workspace / "huge.png"
    oversized.write_bytes(b"x" * (5 * 1024 * 1024 + 1))

    handler, flagged = _trap_handler()
    _install_mock_transport(monkeypatch, handler)

    result = await _generate_video(prompt="x", first_frame="huge.png")

    assert result.startswith("Error:")
    assert "bytes" in result and "max" in result
    assert flagged == []


@pytest.mark.asyncio
async def test_empty_first_frame_string_rejected(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Mode invariant: empty first_frame string is rejected."""
    _write_config(
        config_dir,
        "video:\n  model: googlegenai:veo-3.1-generate-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    handler, flagged = _trap_handler()
    _install_mock_transport(monkeypatch, handler)

    result = await _generate_video(prompt="x", first_frame="")

    assert result.startswith("Error:")
    assert "image path must be a non-empty workspace string" in result
    assert flagged == []


@pytest.mark.asyncio
async def test_empty_reference_images_list_rejected(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Mode invariant: empty reference_images list is rejected."""
    _write_config(
        config_dir,
        "video:\n  model: googlegenai:veo-3.1-generate-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    handler, flagged = _trap_handler()
    _install_mock_transport(monkeypatch, handler)

    result = await _generate_video(prompt="x", reference_images=[])

    assert result.startswith("Error:")
    assert "non-empty list" in result
    assert flagged == []


# ─────────────────────────────────────────────────────────────────────────────
# Backend edge cases: malformed responses, empty samples, download errors
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_operation_response_missing_done_field(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Backend: operation response missing 'done' field treated as pending."""
    _write_config(
        config_dir,
        "video:\n  model: googlegenai:veo-3.1-generate-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    def _handler(request: httpx2.Request) -> httpx2.Response:
        if request.method == "POST":
            return httpx2.Response(200, json={"name": "operations/x"})
        # Missing 'done' field — should be treated as pending.
        return httpx2.Response(200, json={"response": {}})

    _install_mock_transport(monkeypatch, _handler)

    # With _MAX_WAIT_SECONDS=0, should timeout immediately.
    monkeypatch.setattr(ggv, "_MAX_WAIT_SECONDS", 0.0)

    result = await _generate_video(prompt="x")
    assert result.startswith("Error:")
    assert "did not complete" in result


@pytest.mark.asyncio
async def test_operation_response_missing_response_field(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Backend: done=true but missing 'response' field → no video URI."""
    _write_config(
        config_dir,
        "video:\n  model: googlegenai:veo-3.1-generate-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    def _handler(request: httpx2.Request) -> httpx2.Response:
        if request.method == "POST":
            return httpx2.Response(200, json={"name": "operations/x"})
        # done=true but no response field.
        return httpx2.Response(200, json={"done": True})

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_video(prompt="x")
    assert result.startswith("Error:")
    assert "no video URI" in result


@pytest.mark.asyncio
async def test_operation_response_empty_generated_samples(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Backend: generatedSamples array is empty → no video URI."""
    _write_config(
        config_dir,
        "video:\n  model: googlegenai:veo-3.1-generate-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    def _handler(request: httpx2.Request) -> httpx2.Response:
        if request.method == "POST":
            return httpx2.Response(200, json={"name": "operations/x"})
        # Empty generatedSamples.
        return httpx2.Response(
            200,
            json={
                "done": True,
                "response": {"generateVideoResponse": {"generatedSamples": []}},
            },
        )

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_video(prompt="x")
    assert result.startswith("Error:")
    assert "no video URI" in result


@pytest.mark.asyncio
async def test_download_returns_zero_bytes(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Backend: download returns 0 bytes (empty file)."""
    _write_config(
        config_dir,
        "video:\n  model: googlegenai:veo-3.1-generate-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    def _handler(request: httpx2.Request) -> httpx2.Response:
        url = str(request.url)
        if request.method == "POST":
            return httpx2.Response(200, json={"name": "operations/x"})
        if "operations/x" in url:
            return httpx2.Response(
                200, json=_done_response("https://cdn.google.test/x.mp4")
            )
        # Download returns empty content.
        return httpx2.Response(200, content=b"")

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_video(prompt="x")

    # Should succeed but write 0 bytes.
    assert result.startswith("![x](")
    # Find the actual file (UUID-based name).
    files = list(tmp_sandbox.workspace_root.glob("video-*.mp4"))
    assert len(files) == 1
    assert files[0].stat().st_size == 0


@pytest.mark.asyncio
async def test_download_returns_non_200_status(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Backend: download endpoint returns non-200 status."""
    _write_config(
        config_dir,
        "video:\n  model: googlegenai:veo-3.1-generate-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    def _handler(request: httpx2.Request) -> httpx2.Response:
        url = str(request.url)
        if request.method == "POST":
            return httpx2.Response(200, json={"name": "operations/x"})
        if "operations/x" in url:
            return httpx2.Response(
                200, json=_done_response("https://cdn.google.test/x.mp4")
            )
        # Download fails.
        return httpx2.Response(403, text="Forbidden")

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_video(prompt="x")
    assert result.startswith("Error:")
    assert "download returned 403" in result


@pytest.mark.asyncio
async def test_http_429_on_start_call(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Backend: HTTP 429 (rate limit) on the initial predictLongRunning call."""
    _write_config(
        config_dir,
        "video:\n  model: googlegenai:veo-3.1-generate-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    def _handler(_: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(429, text='{"error":"rate limited"}')

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_video(prompt="x")
    assert result.startswith("Error: Veo API returned 429")


@pytest.mark.asyncio
async def test_http_500_on_start_call(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Backend: HTTP 500 on the initial predictLongRunning call."""
    _write_config(
        config_dir,
        "video:\n  model: googlegenai:veo-3.1-generate-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    def _handler(_: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(500, text="Internal Server Error")

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_video(prompt="x")
    assert result.startswith("Error: Veo API returned 500")


@pytest.mark.asyncio
async def test_poll_returns_error_field_on_done(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Backend: operation completes with error field instead of response."""
    _write_config(
        config_dir,
        "video:\n  model: googlegenai:veo-3.1-generate-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    def _handler(request: httpx2.Request) -> httpx2.Response:
        if request.method == "POST":
            return httpx2.Response(200, json={"name": "operations/x"})
        # Operation fails with error field.
        return httpx2.Response(
            200,
            json={
                "done": True,
                "error": {"code": 7, "message": "permission denied"},
            },
        )

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_video(prompt="x")
    assert result.startswith("Error: Veo operation failed")
    assert "permission denied" in result


# ─────────────────────────────────────────────────────────────────────────────
# OTel span attributes and metrics emission
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_otel_span_attributes_set_on_success(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """OTel: span attributes are set for mode, output_bytes, provider, model."""
    _write_config(
        config_dir,
        "video:\n  model: googlegenai:veo-3.1-generate-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    fake_mp4 = b"MP4DATA"

    async def _mock_backend(*args: object, **kwargs: object) -> tuple[bytes, str] | str:
        return (
            fake_mp4,
            "https://generativelanguage.googleapis.com/v1beta/files/test123",
        )

    monkeypatch.setattr(
        "app.agent.tools.multimodalities.video._VIDEO_BACKENDS",
        {"googlegenai": _mock_backend},
    )

    # Capture span attributes via a mock tracer.
    captured_attrs: dict[str, object] = {}

    class _MockSpan:
        def set_attribute(self, key: str, value: object) -> None:
            captured_attrs[key] = value

        def set_status(self, status: object) -> None:
            pass

        def update_name(self, name: str) -> None:
            pass

        def __enter__(self) -> "_MockSpan":
            return self

        def __exit__(self, *args: object) -> None:
            pass

    class _MockTracer:
        def start_as_current_span(self, name: str) -> _MockSpan:
            return _MockSpan()

    monkeypatch.setattr(
        "app.agent.tools.multimodalities.video.get_tracer",
        lambda: _MockTracer(),
    )

    await _generate_video(prompt="test", filename="out")

    # Verify key attributes were set.
    assert captured_attrs.get("video.mode") == "text"
    assert captured_attrs.get("video.output_bytes") == len(fake_mp4)
    assert captured_attrs.get("gen_ai.provider.name") == "googlegenai"
    assert captured_attrs.get("gen_ai.request.model") == "veo-3.1-generate-preview"


@pytest.mark.asyncio
async def test_otel_span_mode_attribute_for_each_mode(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """OTel: span.video.mode is set correctly for text/image/interpolation/reference."""
    _write_config(
        config_dir,
        "video:\n  model: googlegenai:veo-3.1-generate-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    workspace = tmp_sandbox.workspace_root
    workspace.mkdir(parents=True, exist_ok=True)
    (workspace / "a.png").write_bytes(b"A")
    (workspace / "b.png").write_bytes(b"B")
    (workspace / "r.png").write_bytes(b"R")

    fake_mp4 = b"MP4"

    async def _mock_backend(*args: object, **kwargs: object) -> tuple[bytes, str] | str:
        return (
            fake_mp4,
            "https://generativelanguage.googleapis.com/v1beta/files/test123",
        )

    monkeypatch.setattr(
        "app.agent.tools.multimodalities.video._VIDEO_BACKENDS",
        {"googlegenai": _mock_backend},
    )

    captured_modes: list[str] = []

    class _MockSpan:
        def set_attribute(self, key: str, value: object) -> None:
            if key == "video.mode":
                captured_modes.append(str(value))

        def set_status(self, status: object) -> None:
            pass

        def update_name(self, name: str) -> None:
            pass

        def __enter__(self) -> "_MockSpan":
            return self

        def __exit__(self, *args: object) -> None:
            pass

    class _MockTracer:
        def start_as_current_span(self, name: str) -> _MockSpan:
            return _MockSpan()

    monkeypatch.setattr(
        "app.agent.tools.multimodalities.video.get_tracer",
        lambda: _MockTracer(),
    )

    # Test each mode.
    await _generate_video(prompt="text mode")
    assert "text" in captured_modes

    captured_modes.clear()
    await _generate_video(prompt="image mode", first_frame="a.png")
    assert "image" in captured_modes

    captured_modes.clear()
    await _generate_video(
        prompt="interpolation mode", first_frame="a.png", last_frame="b.png"
    )
    assert "interpolation" in captured_modes

    captured_modes.clear()
    await _generate_video(prompt="reference mode", reference_images=["r.png"])
    assert "reference" in captured_modes
