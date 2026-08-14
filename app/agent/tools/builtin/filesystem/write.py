"""write_file tool — create or overwrite a file."""

from __future__ import annotations

from loguru import logger
from pydantic import BaseModel, Field

from app.agent.denied_paths import get_denied_paths
from app.agent.tools.builtin.filesystem._config_watch import notify_fs_change
from app.agent.tools.registry import Tool

_DESCRIPTION = (
    "Create or overwrite a file with text content. "
    "Parent directories are created automatically."
)


class WriteArgs(BaseModel):
    """Arguments for the write tool."""

    path: str = Field(
        description="File to create or overwrite; relative paths resolve from workspace."
    )
    content: str = Field(description="UTF-8 text content to write.")
    overwrite: bool = Field(
        default=True, description="Fail if the file exists when false."
    )


async def _write_file(path: str, content: str, overwrite: bool = True) -> str:
    """Write text to a file, creating parent directories as needed."""
    denied_paths = get_denied_paths()
    resolved = denied_paths.validate_path(path)
    rel = denied_paths.display_path(resolved)
    if not overwrite and resolved.exists():
        raise FileExistsError(f"File already exists: {rel}")

    resolved.parent.mkdir(parents=True, exist_ok=True)
    encoded = content.encode("utf-8")
    resolved.write_bytes(encoded)
    logger.info("file_written path={} bytes={}", resolved, len(encoded))
    notify_fs_change(resolved)
    return f"Written {len(encoded)} bytes to {rel}\nResolved path: {resolved}"


write_file = Tool(
    _write_file,
    name="write",
    description=_DESCRIPTION,
    args_schema=WriteArgs,
)
