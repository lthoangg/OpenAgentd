"""Manual E2E smoketest for the OpenAI image edit backend.

Usage:
    uv run python -m manual.image_edit_smoketest
    uv run python -m manual.image_edit_smoketest --model gpt-image-2-mini

Requires ``OPENAI_API_KEY`` in the environment (or ``.env``).

Flow:
1. Call the ``generate`` backend to create two small source PNGs.
2. Call the ``edit`` backend with those PNGs + a compose prompt.
3. Write all outputs to ``/tmp/image_edit_smoke/`` for eyeballing.

No sandbox, no agent loop — directly exercises the backend HTTP path.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from app.agent.tools.multimodalities._config import MediaSectionConfig
from app.agent.tools.multimodalities.backends.openai import edit, generate

OUT = Path("/tmp/image_edit_smoke")
DEFAULT_MODEL = "gpt-image-2"


def _cfg(model: str) -> MediaSectionConfig:
    return MediaSectionConfig(
        provider="openai",
        model=model,
        extras={"size": "1024x1024", "quality": "low"},  # low = fastest/cheapest
    )


async def _make_source(cfg: MediaSectionConfig, prompt: str, name: str) -> Path:
    print(f"→ generating {name}: {prompt!r}")
    result = await generate(cfg, prompt)
    if isinstance(result, str):
        sys.exit(f"generate failed: {result}")
    path = OUT / name
    path.write_bytes(result)
    print(f"  wrote {path} ({len(result):,} bytes)")
    return path


async def _edit_sources(
    cfg: MediaSectionConfig, sources: list[Path], prompt: str, name: str
) -> Path:
    print(f"→ editing {[p.name for p in sources]} with prompt: {prompt!r}")
    blobs = [(p.name, p.read_bytes()) for p in sources]
    result = await edit(cfg, prompt, blobs)
    if isinstance(result, str):
        sys.exit(f"edit failed: {result}")
    path = OUT / name
    path.write_bytes(result)
    print(f"  wrote {path} ({len(result):,} bytes)")
    return path


async def main(model: str) -> None:
    cfg = _cfg(model)
    print(f"model: {model}")
    OUT.mkdir(parents=True, exist_ok=True)
    red = await _make_source(
        cfg, "a solid red cube on a white background", "red-cube.png"
    )
    blue = await _make_source(
        cfg, "a solid blue sphere on a white background", "blue-sphere.png"
    )
    await _edit_sources(
        cfg,
        [red, blue],
        "place the red cube and the blue sphere side by side on a wooden desk, "
        "photorealistic, soft studio lighting",
        "composed.png",
    )
    print(f"\nDone. Open {OUT} to inspect the PNGs.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="OpenAI image edit backend smoke-test")
    ap.add_argument(
        "--model", default=DEFAULT_MODEL, help=f"Image model (default: {DEFAULT_MODEL})"
    )
    args = ap.parse_args()
    asyncio.run(main(args.model))
