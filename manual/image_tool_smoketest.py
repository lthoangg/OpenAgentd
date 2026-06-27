"""Manual E2E smoketest for the ``generate_image`` tool itself.

Usage:
    uv run python -m manual.image_tool_smoketest
    uv run python -m manual.image_tool_smoketest --model gpt-image-2-mini

Exercises the full tool code path:

  _generate_image(prompt, images=[...]) →
    _load_input_images (sandbox.validate_path, read_bytes, size cap) →
      backend.edit → /v1/images/edits →
        sandbox write → markdown return value

No LLM, no HTTP server — just the tool as the agent loop would call it.

Requires ``OPENAI_API_KEY`` in the environment (or ``.env``).
Writes outputs to ``/tmp/image_tool_smoke/workspace/``.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from app.agent.sandbox import SandboxConfig, set_sandbox
from app.agent.tools.multimodalities._config import MediaSectionConfig
from app.agent.tools.multimodalities.backends.openai import generate
from app.agent.tools.multimodalities.image import _generate_image

ROOT = Path("/tmp/image_tool_smoke")
WORKSPACE = ROOT / "workspace"
CONFIG_DIR = ROOT / "config"
DEFAULT_MODEL = "gpt-image-2"


async def _seed_sources(model: str) -> None:
    """Pre-create two source PNGs in the workspace via the generate backend."""
    cfg = MediaSectionConfig(
        provider="openai",
        model=model,
        extras={"size": "1024x1024", "quality": "low"},
    )
    for name, prompt in [
        ("red-cube.png", "a solid red cube on a white background"),
        ("blue-sphere.png", "a solid blue sphere on a white background"),
    ]:
        target = WORKSPACE / name
        if target.exists():
            print(f"  {name} already present, skipping generate")
            continue
        print(f"  seeding {name}...")
        result = await generate(cfg, prompt)
        if isinstance(result, str):
            sys.exit(f"seed generate failed: {result}")
        target.write_bytes(result)


async def main(model: str) -> None:
    print(f"model: {model}")
    ROOT.mkdir(parents=True, exist_ok=True)
    WORKSPACE.mkdir(parents=True, exist_ok=True)
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)

    # Point the multimodal loader at our tmp config.
    (CONFIG_DIR / "multimodal.yaml").write_text(
        f"image:\n  model: openai:{model}\n  size: 1024x1024\n  quality: low\n",
        encoding="utf-8",
    )

    # Install a real sandbox rooted in our tmp workspace. The loader reads
    # ``settings.OPENAGENTD_CONFIG_DIR`` for multimodal.yaml, so override that too.
    from app.core.config import settings
    from app.agent.tools.multimodalities import _config as mm_config

    settings.OPENAGENTD_CONFIG_DIR = str(CONFIG_DIR)
    mm_config._cache = None

    sandbox = SandboxConfig(workspace=str(WORKSPACE))
    set_sandbox(sandbox)

    print("Seeding source images...")
    await _seed_sources(model)

    print("\n→ Mode 1: generate (no images)")
    out = await _generate_image(prompt="a green pyramid", filename="green-pyramid")
    print(f"  returned: {out}")

    print("\n→ Mode 2: edit (two images)")
    out = await _generate_image(
        prompt="compose the red cube and blue sphere side-by-side on a wooden desk",
        filename="composed",
        images=["red-cube.png", "blue-sphere.png"],
    )
    print(f"  returned: {out}")

    print("\n→ Mode 3: edit with bad path (should return Error)")
    out = await _generate_image(
        prompt="whatever",
        images=["nope.png"],
    )
    print(f"  returned: {out}")
    assert out.startswith("Error:"), "expected error string for missing input"

    print(f"\nDone. Outputs in {WORKSPACE}")
    for p in sorted(WORKSPACE.iterdir()):
        print(f"  {p.name}  ({p.stat().st_size:,} bytes)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="generate_image tool smoke-test")
    ap.add_argument(
        "--model", default=DEFAULT_MODEL, help=f"Image model (default: {DEFAULT_MODEL})"
    )
    args = ap.parse_args()
    asyncio.run(main(args.model))
