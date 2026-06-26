"""generate_image tool — create (or edit) an image in the session workspace.

Two modes, one tool:

- **generate** (no ``images``): text → image via the provider's text-to-image API.
- **edit** (``images`` non-empty): 1–16 workspace images + prompt → image via the
  provider's image-edit API.

Per-call ``size`` and ``output_format`` overrides YAML defaults; YAML is the
baseline, the tool params are overrides. Other extras (``quality`` etc.) are
YAML-only for now.

Workflow:

1. Read config from ``{CONFIG_DIR}/multimodal.yaml`` (``image`` section).
2. Pick the backend for ``cfg.provider`` from ``_IMAGE_BACKENDS``.
3. Validate per-call enum overrides; build an overrides dict.
4. If ``images`` is given, resolve each path via the sandbox and read bytes;
   then call ``backend.edit(cfg, prompt, loaded, overrides)``. Otherwise call
   ``backend.generate(cfg, prompt, overrides)``.
5. On success, write the returned bytes into the sandbox workspace with an
   extension that matches the resolved output format and return markdown
   ``![alt](filename.ext)`` so the frontend renders inline.

Misconfiguration (missing section, unknown provider, unreadable input,
backend-level auth failures) → a short ``Error: ...`` string; the agent
sees it as a regular tool result and can react.

Provider registry lives in ``_IMAGE_BACKENDS`` — add new providers there
and in ``backends/``.
"""

from __future__ import annotations

import re
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal, get_args

from loguru import logger
from opentelemetry.trace import Status, StatusCode
from pydantic import BaseModel, Field

from app.agent.sandbox import get_sandbox
from app.agent.tools.multimodalities import backends as _backends
from app.agent.tools.multimodalities._config import MediaSectionConfig, get_section
from app.agent.tools.multimodalities._metrics import (
    image_duration_histogram,
    image_output_bytes_histogram,
)
from app.agent.tools.registry import Tool
from app.core.otel import get_tracer

# Me keep filenames safe for the ``/media/`` proxy (no separators, no dots beyond ext)
_SAFE_NAME_RE = re.compile(r"[^a-zA-Z0-9_-]+")

# Me cap input bytes at 5 MB per image so a runaway workspace read can't OOM us.
_MAX_INPUT_BYTES = 5 * 1024 * 1024

# Enums exposed to the LLM via the tool schema.
#
# OpenAI-shaped params — intersection of ``/generations`` and ``/edits`` for the
# GPT image family, so a value accepted here is valid in both modes. Keep
# ``auto`` as the sentinel meaning "use whatever is in multimodal.yaml".
ImageSize = Literal["auto", "1024x1024", "1536x1024", "1024x1536"]
ImageOutputFormat = Literal["png", "jpeg", "webp"]

# Google GenAI (Gemini) params. Each backend filters params it understands;
# foreign values are silently ignored so one tool schema works across providers.
ImageAspectRatio = Literal["1:1", "3:4", "4:3", "9:16", "16:9"]
ImageResolution = Literal["0.5K", "1K", "2K", "4K"]

_DESCRIPTION = (
    "Create or edit an image in the session workspace. "
    "Returns markdown ``![alt](file.ext)`` to include verbatim so it "
    "renders inline. On failure returns ``Error: ...``."
)


class ImageArgs(BaseModel):
    """Arguments for the generate_image tool."""

    prompt: str = Field(
        description=(
            "Visual description for text-to-image, or the transformation "
            "to apply when `images` is provided."
        )
    )
    filename: str | None = Field(
        default=None, description="Optional slug for the saved file (no extension)."
    )
    images: list[str] | None = Field(
        default=None,
        description=(
            "Optional workspace-relative paths of input images to edit "
            "(1–16). When provided, the tool calls the provider's image "
            "edit API instead of text-to-image; the `prompt` then "
            "describes the transformation."
        ),
    )
    size: ImageSize | None = Field(
        default=None,
        description=(
            "Output size. 'auto', '1024x1024' (square), "
            "'1536x1024' (landscape), or '1024x1536' (portrait)."
        ),
    )
    output_format: ImageOutputFormat | None = Field(
        default=None, description="Output file format: 'png', 'jpeg', or 'webp'."
    )
    aspect_ratio: ImageAspectRatio | None = Field(
        default=None,
        description="Aspect ratio: '1:1', '3:4', '4:3', '9:16', or '16:9'.",
    )
    image_size: ImageResolution | None = Field(
        default=None, description="Output resolution: '0.5K', '1K', '2K', or '4K'."
    )


_GenerateFn = Callable[
    [MediaSectionConfig, str, dict[str, str] | None], Awaitable[bytes | str]
]
_EditFn = Callable[
    [MediaSectionConfig, str, list[tuple[str, bytes]], dict[str, str] | None],
    Awaitable[bytes | str],
]


@dataclass(frozen=True, slots=True)
class _ImageBackend:
    generate: _GenerateFn
    edit: _EditFn


# Me provider registry — add a new provider by writing backends/<name>.py and
# registering both coroutines here.
_IMAGE_BACKENDS: dict[str, _ImageBackend] = {
    "openai": _ImageBackend(
        generate=_backends.generate_openai,
        edit=_backends.edit_openai,
    ),
    "codex": _ImageBackend(
        generate=_backends.generate_codex,
        edit=_backends.edit_codex,
    ),
    "googlegenai": _ImageBackend(
        generate=_backends.generate_googlegenai,
        edit=_backends.edit_googlegenai,
    ),
}


def _sanitise_filename(raw: str | None, ext: str = "png") -> str:
    """Return a workspace-safe filename ending in ``.<ext>``."""
    if not raw:
        return f"image-{uuid.uuid4().hex[:8]}.{ext}"
    stem = raw.rsplit(".", 1)[0]
    stem = _SAFE_NAME_RE.sub("-", stem).strip("-")
    if not stem:
        stem = f"image-{uuid.uuid4().hex[:8]}"
    return f"{stem}.{ext}"


def _load_input_images(paths: list[str]) -> list[tuple[str, bytes]] | str:
    """Resolve + read each workspace path. Return loaded tuples, or ``Error: ...``."""
    sandbox = get_sandbox()
    loaded: list[tuple[str, bytes]] = []
    for raw in paths:
        if not isinstance(raw, str) or not raw.strip():
            return "Error: each entry in `images` must be a non-empty workspace path."
        try:
            resolved = sandbox.validate_path(raw)
        except (ValueError, PermissionError) as exc:
            return f"Error: input image '{raw}' rejected by sandbox: {exc}"
        if not resolved.exists():
            return f"Error: input image '{raw}' does not exist in the workspace."
        if not resolved.is_file():
            return f"Error: input image '{raw}' is not a regular file."
        size = resolved.stat().st_size
        if size > _MAX_INPUT_BYTES:
            return (
                f"Error: input image '{raw}' is {size:,} bytes "
                f"(max {_MAX_INPUT_BYTES:,})."
            )
        loaded.append((resolved.name, resolved.read_bytes()))
    return loaded


async def _generate_image(
    prompt: str,
    filename: str | None = None,
    images: list[str] | None = None,
    size: ImageSize | None = None,
    output_format: ImageOutputFormat | None = None,
    aspect_ratio: ImageAspectRatio | None = None,
    image_size: ImageResolution | None = None,
) -> str:
    """Create or edit an image, saving it to the workspace and returning markdown."""
    # Span covers the whole call. Name is finalised once we know provider/model;
    # until then we use a generic name so configuration-level errors still have
    # something to attach to.
    tracer = get_tracer()
    t0 = time.monotonic()
    with tracer.start_as_current_span("generate_image") as span:
        span.set_attribute("gen_ai.operation.name", "generate_image")
        span.set_attribute("image.prompt_length", len(prompt))
        span.set_attribute("image.input_count", len(images) if images else 0)

        def _fail(
            error_type: str,
            message: str,
            *,
            provider: str | None = None,
            model: str | None = None,
            mode: str | None = None,
        ) -> str:
            """Mark span ERROR, record metric, return framed error string.

            ``provider`` / ``model`` / ``mode`` are passed through to the
            duration histogram so dashboards can slice errors by the same
            dimensions as successes. Any unresolved dimension becomes
            ``"unknown"`` in the label set.
            """
            span.set_attribute("error.type", error_type)
            # Me cap error messages to avoid pulling arbitrary backend bodies
            # (e.g. model-emitted refusal text) into the span attribute.
            span.set_attribute("error.message", message[:200])
            span.set_status(Status(StatusCode.ERROR, error_type))
            _record_duration(
                time.monotonic() - t0,
                provider=provider,
                model=model,
                mode=mode,
                status="error",
            )
            return f"Error: {message}"

        cfg = get_section("image")
        if cfg is None:
            from app.agent.tools.multimodalities._config import _config_path

            return _fail(
                "configuration",
                f"image generation is not configured. "
                f"Add an `image` section to {_config_path()}.",
            )

        span.set_attribute("gen_ai.provider.name", cfg.provider)
        span.set_attribute("gen_ai.request.model", cfg.model)
        span.update_name(f"generate_image {cfg.provider}:{cfg.model}")

        backend = _IMAGE_BACKENDS.get(cfg.provider)
        if backend is None:
            supported = ", ".join(sorted(_IMAGE_BACKENDS))
            return _fail(
                "unknown_provider",
                (
                    f"provider '{cfg.provider}' is not supported for image "
                    f"generation. Supported providers: {supported}."
                ),
                provider=cfg.provider,
            )

        # Me defensive enum validation — Literal types already constrain the
        # JSON schema, but a non-conforming model could still pass garbage;
        # fail fast with a framed message instead of reaching the HTTP call.
        if size is not None and size not in get_args(ImageSize):
            return _fail(
                "validation",
                f"size '{size}' not in {list(get_args(ImageSize))}.",
                provider=cfg.provider,
                model=cfg.model,
            )
        if output_format is not None and output_format not in get_args(
            ImageOutputFormat
        ):
            return _fail(
                "validation",
                (
                    f"output_format '{output_format}' not in "
                    f"{list(get_args(ImageOutputFormat))}."
                ),
                provider=cfg.provider,
                model=cfg.model,
            )
        if aspect_ratio is not None and aspect_ratio not in get_args(ImageAspectRatio):
            return _fail(
                "validation",
                (
                    f"aspect_ratio '{aspect_ratio}' not in "
                    f"{list(get_args(ImageAspectRatio))}."
                ),
                provider=cfg.provider,
                model=cfg.model,
            )
        if image_size is not None and image_size not in get_args(ImageResolution):
            return _fail(
                "validation",
                (
                    f"image_size '{image_size}' not in "
                    f"{list(get_args(ImageResolution))}."
                ),
                provider=cfg.provider,
                model=cfg.model,
            )

        # All four keys go into ``overrides`` unconditionally; each backend
        # filters the ones it understands and drops the rest.
        overrides: dict[str, str] = {}
        if size:
            overrides["size"] = size
            span.set_attribute("image.size", size)
        if output_format:
            overrides["output_format"] = output_format
            span.set_attribute("image.output_format", output_format)
        if aspect_ratio:
            overrides["aspect_ratio"] = aspect_ratio
            span.set_attribute("image.aspect_ratio", aspect_ratio)
        if image_size:
            overrides["image_size"] = image_size
            span.set_attribute("image.image_size", image_size)

        mode = "edit" if images else "generate"
        span.set_attribute("image.mode", mode)

        if images:
            loaded = _load_input_images(images)
            if isinstance(loaded, str):
                # Me sandbox/IO error already framed as ``Error: ...``; strip
                # the "Error: " prefix so we don't double-frame it.
                msg = loaded.removeprefix("Error: ")
                return _fail(
                    "sandbox",
                    msg,
                    provider=cfg.provider,
                    model=cfg.model,
                    mode=mode,
                )
            result = await backend.edit(cfg, prompt, loaded, overrides or None)
        else:
            result = await backend.generate(cfg, prompt, overrides or None)

        if isinstance(result, str):
            # Me backend returned a user-facing ``Error: ...`` string.
            msg = result.removeprefix("Error: ")
            return _fail(
                "backend",
                msg,
                provider=cfg.provider,
                model=cfg.model,
                mode=mode,
            )

        # Pick the extension that matches the resolved output_format: caller
        # override first, then YAML default, else PNG. Keeps the saved filename
        # honest so the /media/ proxy serves the right Content-Type.
        yaml_format = cfg.extras.get("output_format")
        chosen_format: str | None = output_format or (
            yaml_format if isinstance(yaml_format, str) else None
        )
        ext = (
            chosen_format
            if chosen_format and chosen_format in get_args(ImageOutputFormat)
            else "png"
        )
        name = _sanitise_filename(filename, ext=ext)
        sandbox = get_sandbox()
        resolved = sandbox.validate_path(name)
        resolved.parent.mkdir(parents=True, exist_ok=True)
        resolved.write_bytes(result)
        rel = sandbox.display_path(resolved)
        logger.info(
            "generate_image_saved path={} bytes={} provider={} model={} mode={} inputs={}",
            resolved,
            len(result),
            cfg.provider,
            cfg.model,
            mode,
            len(images) if images else 0,
        )

        output_bytes = len(result)
        span.set_attribute("image.output_bytes", output_bytes)
        span.set_status(Status(StatusCode.OK))
        elapsed = time.monotonic() - t0
        _record_duration(
            elapsed,
            provider=cfg.provider,
            model=cfg.model,
            mode=mode,
            status="ok",
        )
        image_output_bytes_histogram().record(
            output_bytes,
            {
                "gen_ai.provider.name": cfg.provider,
                "gen_ai.request.model": cfg.model,
                "image.mode": mode,
            },
        )

        # Me bare relative markdown — frontend rewrites to /api/team/{sid}/media/{rel}.
        return f"![{prompt}]({rel})"


def _record_duration(
    elapsed: float,
    *,
    provider: str | None,
    model: str | None,
    mode: str | None,
    status: str,
) -> None:
    """Record a point on the ``openagentd.image.generation.duration`` histogram.

    Dimensions default to ``"unknown"`` when we failed before resolving them
    (e.g. missing config). Histograms are lazily constructed so the OTel SDK
    doesn't need to be ready at import time.
    """
    image_duration_histogram().record(
        elapsed,
        {
            "gen_ai.provider.name": provider or "unknown",
            "gen_ai.request.model": model or "unknown",
            "image.mode": mode or "unknown",
            "status": status,
        },
    )


generate_image = Tool(
    _generate_image,
    name="generate_image",
    description=_DESCRIPTION,
    args_schema=ImageArgs,
)
