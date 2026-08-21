"""`read` must not stall the shared event loop.

One daemon serves every session and every desktop window on a single event
loop. Any synchronous work inside `_read_file` freezes all of them: a measured
`.docx` conversion blocked the loop for 4.6 s, during which no other session
could stream a token or run a tool.

These tests assert the loop keeps making progress while a read is in flight.
`grep`, `glob`, and `skill` already offload via `asyncio.to_thread`.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from app.agent.denied_paths import (
    DeniedPathsConfig as SandboxConfig,
    set_denied_paths as set_sandbox,
)
from app.agent.schemas.chat import TextBlock, ToolResult
from app.agent.tools.builtin.filesystem.read import _read_file

# A read long enough that a blocked loop is unambiguous, short enough to keep
# the suite fast. Ticks are 10x finer so a healthy loop records plenty.
_BLOCK_SECONDS = 0.3
_TICK_SECONDS = 0.01
# A non-blocking loop manages ~30 ticks; a blocked one manages 0-1. Anything
# above this margin proves the work left the event loop thread.
_MIN_TICKS = 5


@pytest.fixture
def workspace(tmp_path):
    set_sandbox(SandboxConfig(workspace=str(tmp_path)))
    return tmp_path


async def _ticks_during(coro) -> int:
    """Run *coro*, counting event-loop ticks that land while it executes."""
    ticks = 0

    async def ticker() -> None:
        nonlocal ticks
        while True:
            await asyncio.sleep(_TICK_SECONDS)
            ticks += 1

    task = asyncio.create_task(ticker())
    await asyncio.sleep(0)  # let the ticker reach its first await
    try:
        await coro
    finally:
        task.cancel()
    return ticks


async def test_document_read_does_not_block_the_event_loop(workspace: Path):
    doc = workspace / "report.docx"
    doc.write_bytes(b"PK\x03\x04 not really a docx")

    def _slow_convert(*_args, **_kwargs) -> ToolResult:
        time.sleep(_BLOCK_SECONDS)  # document conversion is CPU-bound and synchronous
        return ToolResult(parts=[TextBlock(text="[Document: report.docx]\nbody")])

    with patch(
        "app.agent.tools.builtin.filesystem.read.handle_document", _slow_convert
    ):
        ticks = await _ticks_during(_read_file(str(doc)))

    assert ticks >= _MIN_TICKS, (
        f"event loop stalled during document read: only {ticks} ticks in "
        f"{_BLOCK_SECONDS}s — other sessions were frozen"
    )


async def test_image_read_does_not_block_the_event_loop(workspace: Path):
    img = workspace / "shot.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 128)

    def _slow_encode(*_args, **_kwargs) -> ToolResult:
        time.sleep(_BLOCK_SECONDS)  # read_bytes + base64 of a large image
        return ToolResult(parts=[TextBlock(text="[Image: shot.png]")])

    with patch("app.agent.tools.builtin.filesystem.read.handle_image", _slow_encode):
        ticks = await _ticks_during(_read_file(str(img)))

    assert ticks >= _MIN_TICKS, (
        f"event loop stalled during image read: only {ticks} ticks in "
        f"{_BLOCK_SECONDS}s — other sessions were frozen"
    )
