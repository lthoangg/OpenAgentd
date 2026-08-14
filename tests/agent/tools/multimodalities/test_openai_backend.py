"""Tests for generate_image with the ``openai`` backend.

Covers:
- Missing config file → "not configured" error string.
- Unknown provider → clear error listing supported providers.
- Config present but ``OPENAI_API_KEY`` unset → clear error.
- Generate path: JSON POST to /v1/images/generations, PNG written, markdown
  returned; non-200 response bubbles up.
- Edit path: multipart POST to /v1/images/edits with repeated ``image[]``
  parts; workspace-path resolution, missing-file rejection, empty-list
  falls through to generate.
- Filename sanitisation (pure function).
"""

from __future__ import annotations

import base64
from collections.abc import Callable, Iterator
from pathlib import Path

import httpx2
import pytest

from app.agent.denied_paths import (
    DeniedPathsConfig as SandboxConfig,
    set_denied_paths as set_sandbox,
)
from app.agent.tools.multimodalities import _config as mm_config
from app.agent.tools.multimodalities.image import _generate_image, _sanitise_filename


@pytest.fixture
def tmp_sandbox(tmp_path: Path) -> Iterator[SandboxConfig]:
    sandbox = SandboxConfig(workspace=str(tmp_path / "workspace"))
    token = set_sandbox(sandbox)
    try:
        yield sandbox
    finally:
        import contextvars

        # Best-effort reset; SandboxConfig has no tearDown requirement beyond this.
        contextvars.copy_context()  # no-op, keeps linter happy
        del token


@pytest.fixture
def config_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point settings.OPENAGENTD_CONFIG_DIR at a tmp dir and clear the loader cache."""
    cfg = tmp_path / "config"
    cfg.mkdir()
    monkeypatch.setattr("app.core.config.settings.OPENAGENTD_CONFIG_DIR", str(cfg))
    # Me drop the mtime-based cache so each test starts clean.
    monkeypatch.setattr(mm_config, "_cache", None)
    return cfg


@pytest.fixture(autouse=True)
def _clear_settings_openai_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """Neutralise ``settings.OPENAI_API_KEY`` so tests drive auth via env only.

    Dev machines may have the key loaded from ``.env`` at import time; without
    this the "missing key" branch can't be exercised and success tests couldn't
    rely on a deterministic ``sk-test`` value.
    """
    monkeypatch.setattr("app.core.config.settings.OPENAI_API_KEY", None)


def _write_config(config_dir: Path, body: str) -> None:
    (config_dir / "multimodal.yaml").write_text(body, encoding="utf-8")


def _install_mock_transport(
    monkeypatch: pytest.MonkeyPatch,
    handler: "Callable[[httpx2.Request], httpx2.Response]",
) -> None:
    """Route all ``httpx2.AsyncClient`` traffic in the openai backend to ``handler``."""
    transport = httpx2.MockTransport(handler)
    real_async_client = httpx2.AsyncClient

    def _mock_async_client(*args: object, **kwargs: object) -> httpx2.AsyncClient:
        kwargs["transport"] = transport
        return real_async_client(*args, **kwargs)

    monkeypatch.setattr(
        "app.agent.tools.multimodalities.backends.openai.httpx2.AsyncClient",
        _mock_async_client,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Config gate
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_missing_config_returns_error(
    tmp_sandbox: SandboxConfig, config_dir: Path
) -> None:
    result = await _generate_image(prompt="a cat")
    assert result.startswith("Error:")
    assert "not configured" in result


@pytest.mark.asyncio
async def test_unknown_provider_returns_error(
    tmp_sandbox: SandboxConfig, config_dir: Path
) -> None:
    _write_config(
        config_dir,
        "image:\n  model: stability:sdxl\n",
    )
    result = await _generate_image(prompt="a cat")
    assert result.startswith("Error:")
    assert "stability" in result
    # Supported providers are enumerated in the error.
    assert "openai" in result


@pytest.mark.asyncio
async def test_missing_api_key_env_returns_error(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(
        config_dir,
        "image:\n  model: openai:gpt-image-2\n",
    )
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    result = await _generate_image(prompt="a cat")
    assert result.startswith("Error:")
    assert "OPENAI_API_KEY" in result


# ─────────────────────────────────────────────────────────────────────────────
# Success path
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_success_writes_png_and_returns_markdown(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(
        config_dir,
        "image:\n  model: openai:gpt-image-2\n  size: 1024x1024\n",
    )
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

    fake_png = b"\x89PNG\r\n\x1a\nFAKEDATA"
    b64 = base64.b64encode(fake_png).decode("ascii")

    def _handler(request: httpx2.Request) -> httpx2.Response:
        assert request.url.path == "/v1/images/generations"
        assert request.headers["Authorization"] == "Bearer sk-test"
        import json as _json

        body = _json.loads(request.content)
        assert body["model"] == "gpt-image-2"
        assert body["prompt"] == "a red cube"
        assert body["size"] == "1024x1024"
        return httpx2.Response(200, json={"data": [{"b64_json": b64}]})

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_image(prompt="a red cube", filename="red-cube")

    assert result == "![a red cube](red-cube.png)"
    written = tmp_sandbox.workspace_root / "red-cube.png"
    assert written.exists()
    assert written.read_bytes() == fake_png


@pytest.mark.asyncio
async def test_api_error_bubbled_to_agent(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(
        config_dir,
        "image:\n  model: openai:gpt-image-2\n",
    )
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

    def _handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(401, text='{"error":"bad key"}')

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_image(prompt="anything")
    assert result.startswith("Error: OpenAI Images API returned 401")


# ─────────────────────────────────────────────────────────────────────────────
# Edit path (images → /v1/images/edits)
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_edit_posts_multipart_with_image_parts(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two workspace images + prompt → multipart POST with repeated ``image[]`` parts."""
    _write_config(
        config_dir,
        "image:\n  model: openai:gpt-image-2\n  size: 1024x1024\n",
    )
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

    # Seed two input PNGs in the workspace.
    ws = tmp_sandbox.workspace_root
    ws.mkdir(parents=True, exist_ok=True)
    (ws / "first.png").write_bytes(b"\x89PNG\r\n\x1a\nFIRST")
    (ws / "second.png").write_bytes(b"\x89PNG\r\n\x1a\nSECOND")

    fake_png = b"\x89PNG\r\n\x1a\nEDITED"
    b64 = base64.b64encode(fake_png).decode("ascii")

    captured: dict[str, object] = {}

    def _handler(request: httpx2.Request) -> httpx2.Response:
        assert request.url.path == "/v1/images/edits"
        assert request.headers["Authorization"] == "Bearer sk-test"
        ctype = request.headers.get("content-type", "")
        assert ctype.startswith("multipart/form-data")
        body = request.content
        captured["body"] = body
        captured["content_type"] = ctype
        return httpx2.Response(200, json={"data": [{"b64_json": b64}]})

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_image(
        prompt="combine them",
        filename="combined",
        images=["first.png", "second.png"],
    )

    assert result == "![combine them](combined.png)"
    written = ws / "combined.png"
    assert written.exists()
    assert written.read_bytes() == fake_png

    # Body contains both image parts + form fields.
    body_bytes = captured["body"]
    assert isinstance(body_bytes, bytes)
    # Multipart field name is literally ``image[]`` (square brackets).
    assert body_bytes.count(b'name="image[]"') == 2
    assert b'name="model"' in body_bytes
    assert b"gpt-image-2" in body_bytes
    assert b'name="prompt"' in body_bytes
    assert b"combine them" in body_bytes
    assert b'name="size"' in body_bytes
    assert b"1024x1024" in body_bytes
    # Raw image bytes flow through.
    assert b"FIRST" in body_bytes
    assert b"SECOND" in body_bytes


@pytest.mark.asyncio
async def test_edit_rejects_missing_input_file(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Unknown workspace path → sandbox error, no HTTP call made."""
    _write_config(config_dir, "image:\n  model: openai:gpt-image-2\n")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

    called = False

    def _handler(request: httpx2.Request) -> httpx2.Response:  # pragma: no cover
        nonlocal called
        called = True
        return httpx2.Response(200, json={"data": [{"b64_json": ""}]})

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_image(prompt="edit me", images=["does-not-exist.png"])
    assert result.startswith("Error:")
    assert "does not exist" in result
    assert called is False


@pytest.mark.asyncio
async def test_edit_rejects_empty_string_path(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Empty/whitespace entry → rejected before any HTTP call."""
    _write_config(config_dir, "image:\n  model: openai:gpt-image-2\n")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

    result = await _generate_image(prompt="x", images=["   "])
    assert result.startswith("Error:")
    assert "non-empty workspace path" in result


@pytest.mark.asyncio
async def test_empty_images_list_falls_through_to_generate(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``images=[]`` is treated as "no inputs" and hits /generations, not /edits."""
    _write_config(config_dir, "image:\n  model: openai:gpt-image-2\n")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

    fake_png = b"\x89PNGGEN"
    b64 = base64.b64encode(fake_png).decode("ascii")

    paths_seen: list[str] = []

    def _handler(request: httpx2.Request) -> httpx2.Response:
        paths_seen.append(request.url.path)
        return httpx2.Response(200, json={"data": [{"b64_json": b64}]})

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_image(prompt="plain", filename="plain", images=[])
    assert result == "![plain](plain.png)"
    assert paths_seen == ["/v1/images/generations"]


@pytest.mark.asyncio
async def test_edit_api_error_bubbled_to_agent(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Non-200 from /edits surfaces as ``Error: OpenAI Images API returned ...``."""
    _write_config(config_dir, "image:\n  model: openai:gpt-image-2\n")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

    ws = tmp_sandbox.workspace_root
    ws.mkdir(parents=True, exist_ok=True)
    (ws / "in.png").write_bytes(b"\x89PNG\r\n\x1a\nIN")

    def _handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(400, text='{"error":"bad image"}')

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_image(prompt="anything", images=["in.png"])
    assert result.startswith("Error: OpenAI Images API returned 400")


# ─────────────────────────────────────────────────────────────────────────────
# Filename sanitisation (pure function)
# ─────────────────────────────────────────────────────────────────────────────


def test_sanitise_filename_none_yields_random_png() -> None:
    name = _sanitise_filename(None)
    assert name.endswith(".png")
    assert name.startswith("image-")


def test_sanitise_filename_strips_separators_and_appends_png() -> None:
    assert _sanitise_filename("evil/path") == "evil-path.png"


def test_sanitise_filename_preserves_alphanumerics_and_dashes() -> None:
    assert _sanitise_filename("my-chart_v2") == "my-chart_v2.png"


def test_sanitise_filename_replaces_existing_extension() -> None:
    assert _sanitise_filename("foo.jpg") == "foo.png"


def test_sanitise_filename_honours_ext_arg() -> None:
    assert _sanitise_filename("chart", ext="jpeg") == "chart.jpeg"
    assert _sanitise_filename(None, ext="webp").endswith(".webp")


# ─────────────────────────────────────────────────────────────────────────────
# Per-call size / output_format overrides
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_overrides_win_over_yaml_on_generate(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Tool params for size/output_format beat YAML defaults on /generations."""
    _write_config(
        config_dir,
        "image:\n  model: openai:gpt-image-2\n  size: 1024x1024\n  output_format: png\n",
    )
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

    captured: dict[str, object] = {}
    fake_png = b"\x89PNG\r\n\x1a\nOVR"
    b64 = base64.b64encode(fake_png).decode("ascii")

    def _handler(request: httpx2.Request) -> httpx2.Response:
        import json as _json

        captured["body"] = _json.loads(request.content)
        return httpx2.Response(200, json={"data": [{"b64_json": b64}]})

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_image(
        prompt="a blue cube",
        filename="blue",
        size="1536x1024",
        output_format="webp",
    )

    body = captured["body"]
    assert isinstance(body, dict)
    # Overrides reached the wire, YAML defaults are gone.
    assert body["size"] == "1536x1024"
    assert body["output_format"] == "webp"
    # Saved filename reflects the resolved format.
    assert result == "![a blue cube](blue.webp)"
    assert (tmp_sandbox.workspace_root / "blue.webp").exists()


@pytest.mark.asyncio
async def test_yaml_defaults_used_when_tool_params_omitted(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """YAML ``size`` / ``output_format`` flow through when the tool omits them."""
    _write_config(
        config_dir,
        "image:\n  model: openai:gpt-image-2\n  size: 1024x1536\n  output_format: jpeg\n",
    )
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

    captured: dict[str, object] = {}
    fake = b"FAKE-JPEG"
    b64 = base64.b64encode(fake).decode("ascii")

    def _handler(request: httpx2.Request) -> httpx2.Response:
        import json as _json

        captured["body"] = _json.loads(request.content)
        return httpx2.Response(200, json={"data": [{"b64_json": b64}]})

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_image(prompt="a frog", filename="frog")
    body = captured["body"]
    assert isinstance(body, dict)
    assert body["size"] == "1024x1536"
    assert body["output_format"] == "jpeg"
    assert result == "![a frog](frog.jpeg)"


@pytest.mark.asyncio
async def test_overrides_win_over_yaml_on_edit(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Overrides also land in multipart form data on /edits."""
    _write_config(
        config_dir,
        "image:\n  model: openai:gpt-image-2\n  size: 1024x1024\n",
    )
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

    ws = tmp_sandbox.workspace_root
    ws.mkdir(parents=True, exist_ok=True)
    (ws / "src.png").write_bytes(b"\x89PNG\r\n\x1a\nSRC")

    captured: dict[str, bytes] = {}
    fake = b"EDITED"
    b64 = base64.b64encode(fake).decode("ascii")

    def _handler(request: httpx2.Request) -> httpx2.Response:
        captured["body"] = request.content
        return httpx2.Response(200, json={"data": [{"b64_json": b64}]})

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_image(
        prompt="to jpeg",
        filename="out",
        images=["src.png"],
        size="1024x1536",
        output_format="jpeg",
    )

    body_text = captured["body"].decode("latin-1")
    # Multipart parts are inspectable as raw text.
    assert 'name="size"' in body_text and "1024x1536" in body_text
    assert 'name="output_format"' in body_text and "jpeg" in body_text
    assert result == "![to jpeg](out.jpeg)"


@pytest.mark.asyncio
async def test_invalid_size_rejected_before_http(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A garbage size value never reaches the backend — fail fast with a framed error."""
    _write_config(config_dir, "image:\n  model: openai:gpt-image-2\n")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

    called = False

    def _handler(request: httpx2.Request) -> httpx2.Response:
        nonlocal called
        called = True
        return httpx2.Response(200, json={"data": [{"b64_json": ""}]})

    _install_mock_transport(monkeypatch, _handler)

    # Me bypass the Literal by casting — what the model might send if it ignores the schema.
    result = await _generate_image(prompt="x", size="9999x9999")  # type: ignore[arg-type]
    assert result.startswith("Error: size '9999x9999'")
    assert called is False


@pytest.mark.asyncio
async def test_invalid_output_format_rejected_before_http(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(config_dir, "image:\n  model: openai:gpt-image-2\n")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

    called = False

    def _handler(request: httpx2.Request) -> httpx2.Response:
        nonlocal called
        called = True
        return httpx2.Response(200, json={"data": [{"b64_json": ""}]})

    _install_mock_transport(monkeypatch, _handler)

    result = await _generate_image(prompt="x", output_format="tiff")  # type: ignore[arg-type]
    assert result.startswith("Error: output_format 'tiff'")
    assert called is False
