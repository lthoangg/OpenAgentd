"""Tests for generate_image with the ``googlegenai`` (Gemini) backend.

Covers:
- Missing ``GOOGLE_API_KEY`` → framed error, transport uncalled.
- Generate path: JSON POST to ``:generateContent``, PNG written, markdown
  returned; API 4xx bubbles up.
- Edit path: inline_data parts with per-file mime + base64 payload; empty
  list rejected before HTTP; >14 images rejected before HTTP.
- YAML ``aspect_ratio`` / ``image_size`` forwarded as
  ``generationConfig.imageConfig.{aspectRatio,imageSize}``.
- Per-call overrides (``aspect_ratio`` / ``image_size`` tool params) win
  over YAML defaults.
- OpenAI-only params (``size`` / ``output_format``) silently ignored.
- Response missing image part returns framed error.
"""

from __future__ import annotations

import base64
from collections.abc import Callable, Iterator
from pathlib import Path

import httpx2
import pytest

from app.agent.sandbox import SandboxConfig, set_sandbox
from app.agent.tools.multimodalities import _config as mm_config
from app.agent.tools.multimodalities.image import _generate_image


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


def _write_config(config_dir: Path, body: str) -> None:
    (config_dir / "multimodal.yaml").write_text(body, encoding="utf-8")


def _install_mock_transport(
    monkeypatch: pytest.MonkeyPatch,
    handler: "Callable[[httpx2.Request], httpx2.Response]",
) -> None:
    """Route all Gemini backend httpx2 traffic to ``handler``."""
    transport = httpx2.MockTransport(handler)
    real_async_client = httpx2.AsyncClient

    def _mock_async_client(*args: object, **kwargs: object) -> httpx2.AsyncClient:
        kwargs["transport"] = transport
        return real_async_client(*args, **kwargs)

    monkeypatch.setattr(
        "app.agent.tools.multimodalities.backends.googlegenai.httpx2.AsyncClient",
        _mock_async_client,
    )


def _gemini_response(png: bytes) -> dict:
    """Build a canonical Gemini successful response body."""
    return {
        "candidates": [
            {
                "content": {
                    "parts": [
                        {
                            "inline_data": {
                                "mime_type": "image/png",
                                "data": base64.b64encode(png).decode("ascii"),
                            }
                        }
                    ]
                }
            }
        ]
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
        "image:\n  model: googlegenai:gemini-3.1-flash-image-preview\n",
    )
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)

    called = False

    def _handler(_: httpx2.Request) -> httpx2.Response:
        nonlocal called
        called = True
        return httpx2.Response(200)

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_image(prompt="a cat")
    assert result.startswith("Error:")
    assert "GOOGLE_API_KEY" in result
    assert called is False


# ─────────────────────────────────────────────────────────────────────────────
# Generate path
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_generate_success_writes_png_and_returns_markdown(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(
        config_dir,
        "image:\n"
        "  model: googlegenai:gemini-3.1-flash-image-preview\n"
        "  aspect_ratio: '1:1'\n"
        "  image_size: 1K\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    fake_png = b"\x89PNG\r\n\x1a\nFAKEGEMINI"

    def _handler(request: httpx2.Request) -> httpx2.Response:
        assert request.url.path.endswith(
            "/models/gemini-3.1-flash-image-preview:generateContent"
        )
        assert request.headers["x-goog-api-key"] == "k-test"

        import json as _json

        body = _json.loads(request.content)
        # Single text part for generate mode.
        parts = body["contents"][0]["parts"]
        assert parts == [{"text": "a red cube"}]
        # YAML imageConfig is mapped to camelCase.
        gen_cfg = body["generationConfig"]
        assert gen_cfg["responseModalities"] == ["TEXT", "IMAGE"]
        assert gen_cfg["imageConfig"] == {"aspectRatio": "1:1", "imageSize": "1K"}
        return httpx2.Response(200, json=_gemini_response(fake_png))

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_image(prompt="a red cube", filename="red-cube")

    assert result == "![a red cube](red-cube.png)"
    written = tmp_sandbox.workspace_root / "red-cube.png"
    assert written.exists()
    assert written.read_bytes() == fake_png


@pytest.mark.asyncio
async def test_generate_api_error_bubbled_to_agent(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(
        config_dir,
        "image:\n  model: googlegenai:gemini-3.1-flash-image-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    def _handler(_: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(429, text='{"error":"rate limited"}')

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_image(prompt="anything")
    assert result.startswith("Error: Gemini Images API returned 429")


@pytest.mark.asyncio
async def test_generate_response_missing_image_part(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(
        config_dir,
        "image:\n  model: googlegenai:gemini-3.1-flash-image-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    def _handler(_: httpx2.Request) -> httpx2.Response:
        # Only a text part — no inline_data.
        return httpx2.Response(
            200,
            json={
                "candidates": [
                    {"content": {"parts": [{"text": "I refuse to draw that."}]}}
                ]
            },
        )

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_image(prompt="prompt")
    assert result.startswith("Error:")
    assert "no image part" in result


# ─────────────────────────────────────────────────────────────────────────────
# Edit path
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_edit_success_sends_inline_data_parts(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(
        config_dir,
        "image:\n  model: googlegenai:gemini-3.1-flash-image-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    # Seed two input images in the sandbox.
    workspace = tmp_sandbox.workspace_root
    workspace.mkdir(parents=True, exist_ok=True)
    img1 = b"\x89PNG\r\n\x1a\nONE"
    img2 = b"\xff\xd8\xff\xe0TWO"  # jpeg-ish
    (workspace / "a.png").write_bytes(img1)
    (workspace / "b.jpg").write_bytes(img2)

    fake_png = b"\x89PNG\r\n\x1a\nOUT"

    def _handler(request: httpx2.Request) -> httpx2.Response:
        import json as _json

        body = _json.loads(request.content)
        parts = body["contents"][0]["parts"]
        # Text first, then two inline_data entries.
        assert parts[0] == {"text": "combine"}
        assert parts[1]["inline_data"]["mime_type"] == "image/png"
        assert base64.b64decode(parts[1]["inline_data"]["data"]) == img1
        assert parts[2]["inline_data"]["mime_type"] == "image/jpeg"
        assert base64.b64decode(parts[2]["inline_data"]["data"]) == img2
        return httpx2.Response(200, json=_gemini_response(fake_png))

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_image(
        prompt="combine",
        filename="out",
        images=["a.png", "b.jpg"],
    )
    assert result == "![combine](out.png)"
    assert (workspace / "out.png").read_bytes() == fake_png


@pytest.mark.asyncio
async def test_edit_over_14_images_rejected_before_http(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(
        config_dir,
        "image:\n  model: googlegenai:gemini-3.1-flash-image-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    workspace = tmp_sandbox.workspace_root
    workspace.mkdir(parents=True, exist_ok=True)
    names: list[str] = []
    for i in range(15):
        name = f"x{i}.png"
        (workspace / name).write_bytes(b"\x89PNG\r\n\x1a\n")
        names.append(name)

    called = False

    def _handler(_: httpx2.Request) -> httpx2.Response:
        nonlocal called
        called = True
        return httpx2.Response(200)

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_image(prompt="x", images=names)
    assert result.startswith("Error:")
    assert "14" in result
    assert called is False


# ─────────────────────────────────────────────────────────────────────────────
# Overrides — caller wins over YAML; foreign params ignored
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_overrides_win_over_yaml(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(
        config_dir,
        "image:\n"
        "  model: googlegenai:gemini-3.1-flash-image-preview\n"
        "  aspect_ratio: '1:1'\n"
        "  image_size: 1K\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    fake_png = b"\x89PNG\r\n\x1a\nX"

    def _handler(request: httpx2.Request) -> httpx2.Response:
        import json as _json

        body = _json.loads(request.content)
        img_cfg = body["generationConfig"]["imageConfig"]
        # Caller-supplied values win.
        assert img_cfg == {"aspectRatio": "16:9", "imageSize": "2K"}
        return httpx2.Response(200, json=_gemini_response(fake_png))

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_image(
        prompt="override-test",
        aspect_ratio="16:9",
        image_size="2K",
    )
    assert result.startswith("![override-test](")


@pytest.mark.asyncio
async def test_openai_only_params_silently_ignored_by_gemini(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(
        config_dir,
        "image:\n  model: googlegenai:gemini-3.1-flash-image-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    fake_png = b"\x89PNG\r\n\x1a\nX"

    def _handler(request: httpx2.Request) -> httpx2.Response:
        import json as _json

        body = _json.loads(request.content)
        # OpenAI-shaped size/output_format must not leak into imageConfig.
        gen_cfg = body["generationConfig"]
        img_cfg = gen_cfg.get("imageConfig", {})
        assert "size" not in img_cfg
        assert "output_format" not in img_cfg
        # imageConfig should be empty since nothing Gemini-shaped was provided.
        assert img_cfg == {}
        return httpx2.Response(200, json=_gemini_response(fake_png))

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_image(
        prompt="cross-backend",
        size="1024x1024",
        output_format="jpeg",
    )
    assert result.startswith("![cross-backend](")


# ─────────────────────────────────────────────────────────────────────────────
# Dispatcher-level enum guards — bad values rejected before HTTP
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_invalid_aspect_ratio_rejected_before_http(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(
        config_dir,
        "image:\n  model: googlegenai:gemini-3.1-flash-image-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    called = False

    def _handler(_: httpx2.Request) -> httpx2.Response:
        nonlocal called
        called = True
        return httpx2.Response(200)

    _install_mock_transport(monkeypatch, _handler)

    # Bypass the Literal by casting through Any at the call-site.
    bad: str = "21:9"
    result = await _generate_image(prompt="x", aspect_ratio=bad)  # type: ignore[arg-type]
    assert result.startswith("Error:")
    assert "aspect_ratio" in result
    assert called is False


@pytest.mark.asyncio
async def test_invalid_image_size_rejected_before_http(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(
        config_dir,
        "image:\n  model: googlegenai:gemini-3.1-flash-image-preview\n",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "k-test")

    called = False

    def _handler(_: httpx2.Request) -> httpx2.Response:
        nonlocal called
        called = True
        return httpx2.Response(200)

    _install_mock_transport(monkeypatch, _handler)

    bad: str = "8K"
    result = await _generate_image(prompt="x", image_size=bad)  # type: ignore[arg-type]
    assert result.startswith("Error:")
    assert "image_size" in result
    assert called is False
