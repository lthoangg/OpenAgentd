"""Manual smoke-test for the Veo video generation backend.

Exercises the generate() function directly — no agent, no HTTP server.
Prints the exact JSON payload sent to the API before each call.

Usage:
    uv run python -m manual.video_smoketest --mode text
    uv run python -m manual.video_smoketest --mode image --img path/to/frame.png
    uv run python -m manual.video_smoketest --mode interp --img first.png --last last.png
    uv run python -m manual.video_smoketest --mode ref --img a.png --img b.png
    uv run python -m manual.video_smoketest --model veo-3.1-fast-generate-preview

Requires GOOGLE_API_KEY in .env or environment.
Writes output mp4 to /tmp/video_smoke/.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from unittest.mock import patch

from app.agent.tools.multimodalities._config import MediaSectionConfig
from app.agent.tools.multimodalities.backends import googlegenai_video as _backend

OUT_DIR = Path("/tmp/video_smoke")
DEFAULT_MODEL = "veo-3.1-generate-preview"


def _load(path: str) -> tuple[str, bytes]:
    p = Path(path)
    if not p.exists():
        sys.exit(f"file not found: {path}")
    return p.name, p.read_bytes()


def _redact_payload(payload: dict | None) -> dict:
    """Replace base64 data blobs with <N bytes> for readable output."""
    if payload is None:
        return {}
    import copy

    p = copy.deepcopy(payload)
    for inst in p.get("instances", []):
        _redact_inline(inst.get("image"))
        _redact_inline(inst.get("lastFrame"))
        for ri in inst.get("referenceImages", []):
            _redact_inline(ri.get("image"))
    return p


def _redact_inline(obj: dict | None) -> None:
    if not isinstance(obj, dict):
        return
    for key in ("inlineData", "inline_data"):
        if key in obj and isinstance(obj[key], dict) and "data" in obj[key]:
            raw = obj[key]["data"]
            import base64

            byte_len = len(base64.b64decode(raw)) if raw else 0
            obj[key]["data"] = f"<{byte_len:,} bytes>"


def pretty(d: dict) -> str:
    return json.dumps(d, indent=2)


async def run(mode: str, imgs: list[str], last: str | None, model: str) -> None:
    import httpx as _httpx

    cfg = MediaSectionConfig(provider="googlegenai", model=model, extras={})
    print(f"  model: {model}")
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    image: tuple[str, bytes] | None = None
    last_frame: tuple[str, bytes] | None = None
    reference_images: list[tuple[str, bytes]] | None = None

    if mode == "text":
        prompt = "A lone wolf running through a snowy forest at dusk, cinematic"
        out_name = "text_to_video.mp4"

    elif mode == "image":
        if not imgs:
            sys.exit("--img required for image mode")
        image = _load(imgs[0])
        prompt = "The subject begins moving forward, natural lighting, cinematic"
        out_name = "image_to_video.mp4"

    elif mode == "interp":
        if len(imgs) < 1 or last is None:
            sys.exit("--img and --last required for interp mode")
        image = _load(imgs[0])
        last_frame = _load(last)
        prompt = "Smooth cinematic transition between the two frames"
        out_name = "interpolation.mp4"

    elif mode == "ref":
        if not imgs:
            sys.exit("--img required for ref mode")
        reference_images = [_load(p) for p in imgs[:3]]
        prompt = "A cinematic scene featuring the reference subjects"
        out_name = "reference_images.mp4"

    else:
        sys.exit(f"unknown mode: {mode}")

    print(f"\n→ Mode: {mode}")
    print(f"  image     : {image[0] if image else None}")
    print(f"  last_frame: {last_frame[0] if last_frame else None}")
    print(
        f"  ref_images: {[r[0] for r in reference_images] if reference_images else None}"
    )

    # Build DebugClient here so it captures the real httpx.AsyncClient before patching.
    _RealClient = _httpx.AsyncClient

    class DebugClient:
        def __init__(self, *args, **kwargs):
            self._real = _RealClient(*args, **kwargs)

        async def __aenter__(self):
            await self._real.__aenter__()
            return self

        async def __aexit__(self, *a):
            return await self._real.__aexit__(*a)

        async def post(self, url, *, headers=None, json=None, **kw):
            display = _redact_payload(json)
            print("\n─── POST", url)
            print(pretty(display))
            return await self._real.post(url, headers=headers, json=json, **kw)

        async def get(self, url, *, headers=None, **kw):
            return await self._real.get(url, headers=headers, **kw)

    with patch(
        "app.agent.tools.multimodalities.backends.googlegenai_video.httpx.AsyncClient",
        new=DebugClient,
    ):
        result = await _backend.generate(
            cfg,
            prompt,
            image=image,
            last_frame=last_frame,
            reference_images=reference_images,
            overrides={"aspect_ratio": "16:9", "duration_seconds": "4"},
        )

    if isinstance(result, str):
        print(f"\n  ERROR: {result}")
        sys.exit(1)

    out = OUT_DIR / out_name
    out.write_bytes(result)
    print(f"\n  OK — {len(result):,} bytes → {out}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Veo backend smoke-test")
    ap.add_argument(
        "--mode",
        choices=["text", "image", "interp", "ref"],
        default="text",
        help="Generation mode (default: text)",
    )
    ap.add_argument(
        "--img",
        dest="imgs",
        action="append",
        default=[],
        metavar="PATH",
        help="Input image path(s); repeat for multiple",
    )
    ap.add_argument(
        "--last",
        metavar="PATH",
        help="Last-frame image path (interp mode)",
    )
    ap.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=f"Veo model id (default: {DEFAULT_MODEL})",
    )
    args = ap.parse_args()
    asyncio.run(run(args.mode, args.imgs, args.last, args.model))


if __name__ == "__main__":
    main()
