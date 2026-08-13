"""generate_video tool — create a video in the session workspace.

One tool, five input modes routed by which optional args are set:

- **text-to-video** (default): pure ``prompt`` → mp4.
- **image-to-video**: ``first_frame=<path>`` → animated starting from that
  frame.
- **first+last interpolation**: ``first_frame=<path>`` + ``last_frame=<path>``
  → smooth transition between the two frames.
- **reference images**: ``reference_images=[...]`` (up to 3) → subject /
  style preservation. Mutually exclusive with ``last_frame`` per Veo.
- **video extension**: ``extend_video=<uri>`` → extend a previously-generated
  Veo mp4 (pass the Files API URI returned by a prior generation) by 8 s.
  Mutually exclusive with all other input modes. Forced to 16:9 / 720p / 8 s.

Per-call ``aspect_ratio``, ``resolution``, and ``duration_seconds`` override
the YAML defaults. Other extras (``person_generation``, ``negative_prompt``,
``seed``) are YAML-only for now.

Workflow:

1. Read config from ``{CONFIG_DIR}/multimodal.yaml`` (``video`` section).
2. Pick the backend for ``cfg.provider`` from ``_VIDEO_BACKENDS``.
3. Validate per-call enum overrides and input-mode invariants; build overrides.
4. Resolve + read each workspace input image via the sandbox.
5. Call ``backend.generate(cfg, prompt, image=..., last_frame=...,
   reference_images=..., overrides=...)``.
6. On success, write the mp4 bytes into the sandbox workspace with an ``.mp4``
   extension and return markdown ``![alt](filename.mp4)``. The frontend's
   ``MarkdownMedia`` renderer recognises ``.mp4`` / ``.webm`` / ``.mov`` and
   renders a ``<video controls>`` element instead of an ``<img>``.

Misconfiguration, sandbox errors, backend auth failures, polling timeouts, and
download errors all return a short ``Error: ...`` string — the agent sees it
as a regular tool result and can react.

Provider registry lives in ``_VIDEO_BACKENDS`` — add new providers there and
in ``backends/``.
"""

from __future__ import annotations

import re
import time
import uuid
from collections.abc import Awaitable, Callable
from typing import Any, Literal, get_args

from loguru import logger
from opentelemetry.trace import Status, StatusCode
from pydantic import BaseModel, Field

from app.agent.sandbox import get_sandbox

# Import the backends subpackage directly — routing through the parent
# package __init__ creates a module-level import cycle (the parent
# imports this module back).
import app.agent.tools.multimodalities.backends as _backends
from app.agent.tools.multimodalities._config import get_section
from app.agent.tools.multimodalities._metrics import (
    video_duration_histogram,
    video_output_bytes_histogram,
)
from app.agent.tools.registry import Tool
from app.core.otel import get_tracer

# Me: match image.py — safe filenames for the ``/media/`` proxy (no separators).
_SAFE_NAME_RE = re.compile(r"[^a-zA-Z0-9_-]+")

# Input-image cap: 5 MB for first/last frame + reference images. Matches image.py.
_MAX_INPUT_BYTES = 5 * 1024 * 1024

# Files API base — video extension URIs must start with this prefix.
_FILES_API_BASE = "https://generativelanguage.googleapis.com/"

# Veo cap: 3 reference images max. Enforced here so bad values don't reach the HTTP call.
_MAX_REFERENCE_IMAGES = 3

# Enums exposed to the LLM via the tool schema. Keep these aligned with the
# Veo 3.1 docs — foreign values are rejected at the dispatcher before HTTP.
VideoAspectRatio = Literal["16:9", "9:16"]
VideoResolution = Literal["720p", "1080p", "4k"]
VideoDuration = Literal["4", "6", "8"]

_DESCRIPTION = (
    "Generate a video clip in the session workspace using Veo. "
    "Use first_frame for image-to-video, last_frame for interpolation, "
    "reference_images for subject consistency, or extend_video to extend a clip. "
    "Returns ``![alt](file.mp4)`` markdown; include it verbatim so it renders "
    "inline. On failure returns ``Error: ...``."
)


class VideoArgs(BaseModel):
    """Arguments for the generate_video tool."""

    prompt: str = Field(
        description=(
            "Text description of the video, including camera direction, action, "
            "style, ambiance, and dialogue."
        )
    )
    filename: str | None = Field(
        default=None, description="Optional slug for the saved file (no extension)."
    )
    first_frame: str | None = Field(
        default=None,
        description=(
            "Workspace-relative starting frame. Combine with `last_frame` for "
            "first-to-last-frame interpolation."
        ),
    )
    last_frame: str | None = Field(
        default=None,
        description=(
            "Workspace-relative ending frame; requires `first_frame` and is "
            "mutually exclusive with `reference_images`."
        ),
    )
    reference_images: list[str] | None = Field(
        default=None,
        description=(
            "Workspace-relative reference images (up to 3) whose subject or "
            "appearance is preserved. Mutually exclusive with `last_frame`."
        ),
    )
    aspect_ratio: VideoAspectRatio | None = Field(
        default=None,
        description=("Output aspect ratio; must be '16:9' with `extend_video`."),
    )
    resolution: VideoResolution | None = Field(
        default=None,
        description=("Output resolution; 1080p and 4k require 8 s duration."),
    )
    duration_seconds: VideoDuration | None = Field(
        default=None,
        description=("Clip duration; must be '8' with 1080p, 4k, or reference_images."),
    )
    extend_video: str | None = Field(
        default=None,
        description=(
            "Files API URI of a previously Veo-generated video. Mutually exclusive "
            "with input images; output is always 16:9 / 720p / 8 s."
        ),
    )


_GenerateFn = Callable[
    ...,
    Awaitable[tuple[bytes, str] | str],
]


# Me: a single ``_VideoBackend`` wraps just ``generate`` — unlike image, there
# is no ``edit`` counterpart. Multiple input modes (first frame, interpolation,
# references) all route through the same call with different kwargs set.
_VIDEO_BACKENDS: dict[str, _GenerateFn] = {
    "googlegenai": _backends.generate_video_googlegenai,
}


def _sanitise_filename(raw: str | None, ext: str = "mp4") -> str:
    """Return a workspace-safe filename ending in ``.<ext>``."""
    if not raw:
        return f"video-{uuid.uuid4().hex[:8]}.{ext}"
    stem = raw.rsplit(".", 1)[0]
    stem = _SAFE_NAME_RE.sub("-", stem).strip("-")
    if not stem:
        stem = f"video-{uuid.uuid4().hex[:8]}"
    return f"{stem}.{ext}"


def _load_input_image(raw: str) -> tuple[str, bytes] | str:
    """Resolve + read a single workspace-path image via the sandbox.

    Returns ``(filename, bytes)`` on success or ``Error: ...`` string on
    failure. Mirrors the per-path logic in image.py._load_input_images so a
    missing file, symlink escape, or oversized blob is surfaced before any
    HTTP call.
    """
    if not isinstance(raw, str) or not raw.strip():
        return "Error: image path must be a non-empty workspace string."
    sandbox = get_sandbox()
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
            f"Error: input image '{raw}' is {size:,} bytes (max {_MAX_INPUT_BYTES:,})."
        )
    return (resolved.name, resolved.read_bytes())


def _load_input_images(paths: list[str]) -> list[tuple[str, bytes]] | str:
    """Resolve + read each workspace path. Return loaded tuples, or ``Error: ...``."""
    loaded: list[tuple[str, bytes]] = []
    for raw in paths:
        one = _load_input_image(raw)
        if isinstance(one, str):
            return one
        loaded.append(one)
    return loaded


async def _generate_video(
    prompt: str,
    filename: str | None = None,
    first_frame: str | None = None,
    last_frame: str | None = None,
    reference_images: list[str] | None = None,
    aspect_ratio: VideoAspectRatio | None = None,
    resolution: VideoResolution | None = None,
    duration_seconds: VideoDuration | None = None,
    extend_video: str | None = None,
) -> str:
    """Generate a video clip, saving it to the workspace and returning markdown."""
    tracer = get_tracer()
    t0 = time.monotonic()
    with tracer.start_as_current_span("generate_video") as span:
        span.set_attribute("gen_ai.operation.name", "generate_video")
        span.set_attribute("video.prompt_length", len(prompt))
        span.set_attribute("video.has_first_frame", first_frame is not None)
        span.set_attribute(
            "video.reference_image_count",
            len(reference_images) if reference_images else 0,
        )
        span.set_attribute("video.has_last_frame", last_frame is not None)
        span.set_attribute("video.has_extend_video", extend_video is not None)

        def _fail(
            error_type: str,
            message: str,
            *,
            provider: str | None = None,
            model: str | None = None,
            mode: str | None = None,
        ) -> str:
            span.set_attribute("error.type", error_type)
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

        cfg = get_section("video")
        if cfg is None:
            from app.agent.tools.multimodalities._config import _config_path

            return _fail(
                "configuration",
                f"video generation is not configured. "
                f"Add a `video` section to {_config_path()}.",
            )

        span.set_attribute("gen_ai.provider.name", cfg.provider)
        span.set_attribute("gen_ai.request.model", cfg.model)
        span.update_name(f"generate_video {cfg.provider}:{cfg.model}")

        backend = _VIDEO_BACKENDS.get(cfg.provider)
        if backend is None:
            supported = ", ".join(sorted(_VIDEO_BACKENDS))
            return _fail(
                "unknown_provider",
                (
                    f"provider '{cfg.provider}' is not supported for video "
                    f"generation. Supported providers: {supported}."
                ),
                provider=cfg.provider,
            )

        # Me: Literal types constrain the JSON schema the LLM sees, but a
        # non-conforming model could still pass garbage; fail fast with a
        # framed message instead of reaching the HTTP call.
        if aspect_ratio is not None and aspect_ratio not in get_args(VideoAspectRatio):
            return _fail(
                "validation",
                (
                    f"aspect_ratio '{aspect_ratio}' not in "
                    f"{list(get_args(VideoAspectRatio))}."
                ),
                provider=cfg.provider,
                model=cfg.model,
            )
        if resolution is not None and resolution not in get_args(VideoResolution):
            return _fail(
                "validation",
                (
                    f"resolution '{resolution}' not in "
                    f"{list(get_args(VideoResolution))}."
                ),
                provider=cfg.provider,
                model=cfg.model,
            )
        if duration_seconds is not None and duration_seconds not in get_args(
            VideoDuration
        ):
            return _fail(
                "validation",
                (
                    f"duration_seconds '{duration_seconds}' not in "
                    f"{list(get_args(VideoDuration))}."
                ),
                provider=cfg.provider,
                model=cfg.model,
            )

        # Input-mode validation. Enforce the same invariants the backend
        # restates as a safety net, but surface cleaner error messages here.
        if last_frame is not None and first_frame is None:
            return _fail(
                "validation",
                "`last_frame` requires `first_frame` to also be set.",
                provider=cfg.provider,
                model=cfg.model,
            )
        if reference_images is not None:
            if not isinstance(reference_images, list) or not reference_images:
                return _fail(
                    "validation",
                    "`reference_images` must be a non-empty list (or omitted).",
                    provider=cfg.provider,
                    model=cfg.model,
                )
            if len(reference_images) > _MAX_REFERENCE_IMAGES:
                return _fail(
                    "validation",
                    (
                        f"`reference_images` supports up to "
                        f"{_MAX_REFERENCE_IMAGES} entries "
                        f"({len(reference_images)} provided)."
                    ),
                    provider=cfg.provider,
                    model=cfg.model,
                )
        if reference_images is not None and last_frame is not None:
            return _fail(
                "validation",
                "`reference_images` and `last_frame` are mutually exclusive on Veo.",
                provider=cfg.provider,
                model=cfg.model,
            )
        if extend_video is not None:
            if any((first_frame, last_frame, reference_images)):
                return _fail(
                    "validation",
                    "`extend_video` is mutually exclusive with `first_frame`, "
                    "`last_frame`, and `reference_images`.",
                    provider=cfg.provider,
                    model=cfg.model,
                )
            if not extend_video.startswith(_FILES_API_BASE):
                return _fail(
                    "validation",
                    "`extend_video` must be a Files API URI starting with "
                    f"'{_FILES_API_BASE}' (got '{extend_video[:80]}').",
                    provider=cfg.provider,
                    model=cfg.model,
                )
            # Veo only supports 16:9 / 720p for extension; reject conflicting values.
            if aspect_ratio and aspect_ratio != "16:9":
                return _fail(
                    "validation",
                    f"video extension only supports 16:9 aspect ratio (got '{aspect_ratio}').",
                    provider=cfg.provider,
                    model=cfg.model,
                )
            if resolution and resolution != "720p":
                return _fail(
                    "validation",
                    f"video extension only supports 720p resolution (got '{resolution}').",
                    provider=cfg.provider,
                    model=cfg.model,
                )
            # durationSeconds must be "8" for extension.
            if duration_seconds and duration_seconds != "8":
                return _fail(
                    "validation",
                    f"video extension requires duration_seconds='8' (got '{duration_seconds}').",
                    provider=cfg.provider,
                    model=cfg.model,
                )

        # Resolve mode label for span / metrics. "text" / "image" /
        # "interpolation" / "reference" / "extension" are short, stable strings
        # dashboards can group by.
        if extend_video is not None:
            mode = "extension"
        elif reference_images:
            mode = "reference"
        elif last_frame is not None:
            mode = "interpolation"
        elif first_frame is not None:
            mode = "image"
        else:
            mode = "text"
        span.set_attribute("video.mode", mode)

        overrides: dict[str, str] = {}
        if aspect_ratio:
            overrides["aspect_ratio"] = aspect_ratio
            span.set_attribute("video.aspect_ratio", aspect_ratio)
        if resolution:
            overrides["resolution"] = resolution
            span.set_attribute("video.resolution", resolution)
        if duration_seconds:
            overrides["duration_seconds"] = duration_seconds
            span.set_attribute("video.duration_seconds", duration_seconds)

        # Load inputs from the sandbox.
        first_frame_loaded: tuple[str, bytes] | None = None
        last_frame_loaded: tuple[str, bytes] | None = None
        reference_loaded: list[tuple[str, bytes]] | None = None
        # extend_video is a Files API URI — no sandbox loading needed.

        if first_frame is not None:
            loaded = _load_input_image(first_frame)
            if isinstance(loaded, str):
                msg = loaded.removeprefix("Error: ")
                return _fail(
                    "sandbox", msg, provider=cfg.provider, model=cfg.model, mode=mode
                )
            first_frame_loaded = loaded

        if last_frame is not None:
            loaded = _load_input_image(last_frame)
            if isinstance(loaded, str):
                msg = loaded.removeprefix("Error: ")
                return _fail(
                    "sandbox", msg, provider=cfg.provider, model=cfg.model, mode=mode
                )
            last_frame_loaded = loaded

        if reference_images:
            refs = _load_input_images(reference_images)
            if isinstance(refs, str):
                msg = refs.removeprefix("Error: ")
                return _fail(
                    "sandbox", msg, provider=cfg.provider, model=cfg.model, mode=mode
                )
            reference_loaded = refs

        result = await backend(
            cfg,
            prompt,
            image=first_frame_loaded,
            last_frame=last_frame_loaded,
            reference_images=reference_loaded,
            extend_video=extend_video,
            overrides=overrides or None,
        )

        if isinstance(result, str):
            msg = result.removeprefix("Error: ")
            return _fail(
                "backend", msg, provider=cfg.provider, model=cfg.model, mode=mode
            )

        mp4_bytes, video_uri = result

        # Me: Veo always emits mp4; no per-call format override exists today.
        name = _sanitise_filename(filename, ext="mp4")
        sandbox = get_sandbox()
        resolved = sandbox.validate_path(name)
        resolved.parent.mkdir(parents=True, exist_ok=True)
        resolved.write_bytes(mp4_bytes)
        rel = sandbox.display_path(resolved)
        logger.info(
            "generate_video_saved path={} bytes={} provider={} model={} mode={} "
            "refs={} has_last_frame={} extend_uri={}",
            resolved,
            len(mp4_bytes),
            cfg.provider,
            cfg.model,
            mode,
            len(reference_loaded) if reference_loaded else 0,
            last_frame is not None,
            extend_video is not None,
        )

        output_bytes = len(mp4_bytes)
        span.set_attribute("video.output_bytes", output_bytes)
        span.set_status(Status(StatusCode.OK))
        elapsed = time.monotonic() - t0
        _record_duration(
            elapsed,
            provider=cfg.provider,
            model=cfg.model,
            mode=mode,
            status="ok",
        )
        video_output_bytes_histogram().record(
            output_bytes,
            {
                "gen_ai.provider.name": cfg.provider,
                "gen_ai.request.model": cfg.model,
                "video.mode": mode,
            },
        )

        # Always append the Files API URI so the LLM can pass it back as
        # ``extend_video`` on a future call. URIs expire after 2 days.
        return (
            f"![{prompt}]({rel})\n\n"
            f'To extend this video, pass `extend_video="{video_uri}"`.'
        )


def _record_duration(
    elapsed: float,
    *,
    provider: str | None,
    model: str | None,
    mode: str | None,
    status: str,
) -> None:
    """Record a point on the ``openagentd.video.generation.duration`` histogram.

    Dimensions default to ``"unknown"`` when we failed before resolving them
    (e.g. missing config).
    """
    video_duration_histogram().record(
        elapsed,
        {
            "gen_ai.provider.name": provider or "unknown",
            "gen_ai.request.model": model or "unknown",
            "video.mode": mode or "unknown",
            "status": status,
        },
    )


# Silence the unused ``Any`` import when the module is just imported for the
# ``Tool`` wrapper — the annotations above rely on it via ``Callable[..., ...]``.
_ = Any

generate_video = Tool(
    _generate_video,
    name="generate_video",
    description=_DESCRIPTION,
    args_schema=VideoArgs,
)
