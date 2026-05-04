"""remove_path tool — delete a file or directory."""

from __future__ import annotations

import asyncio
import shutil
from typing import Annotated

from loguru import logger
from pydantic import Field

from app.agent.sandbox import get_sandbox
from app.agent.tools.registry import Tool


async def _remove_path(
    path: Annotated[
        str,
        Field(description="Relative path to the file or directory to remove."),
    ],
    recursive: Annotated[
        bool,
        Field(
            description="Remove directories recursively. Required when path is a non-empty directory (default false)."
        ),
    ] = False,
) -> str:
    """Delete a file or directory from the workspace. Use recursive=true to remove a directory tree."""
    sandbox = get_sandbox()
    resolved = sandbox.validate_path(path)
    rel = sandbox.display_path(resolved)

    if not resolved.exists():
        raise FileNotFoundError(f"Path not found: {rel}")

    if resolved.is_file() or resolved.is_symlink():
        resolved.unlink()
        logger.info("file_removed path={}", resolved)
        return f"Removed file: {rel}"

    # Me path is directory
    if recursive:
        await asyncio.to_thread(shutil.rmtree, resolved)
        logger.info("dir_removed path={} recursive=true", resolved)
        return f"Removed directory: {rel}"

    # Me try remove empty dir
    try:
        resolved.rmdir()
        logger.info("dir_removed path={} recursive=false", resolved)
        return f"Removed directory: {rel}"
    except OSError as exc:
        raise OSError(
            f"Directory not empty: {rel}. Use recursive=true to remove it."
        ) from exc


remove_path = Tool(
    _remove_path,
    name="rm",
    description=(
        "Permanently delete a file or directory from the workspace. "
        "Use only when the user asked for removal or deletion is necessary. "
        "Set recursive=true to remove a non-empty directory tree."
    ),
)
