"""Inject instruction files into the system prompt for coding mode.

Two sources, rendered broad → scoped like pi/opencode/codex:

1. Global ``{CONFIG_DIR}/AGENTS.md`` (``~/.config/openagentd/AGENTS.md`` in
   production) — the developer's cross-project preferences.
2. Workspace ``AGENTS.md`` (falling back to ``CLAUDE.md``) at the root.
"""

from __future__ import annotations

from pathlib import Path
from stat import S_ISREG
from typing import TYPE_CHECKING

from loguru import logger

from app.agent.hooks.base import BaseAgentHook

if TYPE_CHECKING:
    from app.agent.schemas.chat import AssistantMessage
    from app.agent.state import AgentState, ModelCallHandler, ModelRequest, RunContext


MAX_AGENTS_MD_BYTES = 128 * 1024
_GLOBAL_INSTRUCTIONS_FILENAME = "AGENTS.md"


def global_instructions_path() -> Path:
    """Return the global instructions file: ``{OPENAGENTD_CONFIG_DIR}/AGENTS.md``."""
    from app.core.config import settings

    return Path(settings.OPENAGENTD_CONFIG_DIR) / _GLOBAL_INSTRUCTIONS_FILENAME


class WorkspaceInstructionsHook(BaseAgentHook):
    def __init__(
        self,
        workspace: str | None,
        *,
        global_instructions: Path | None = None,
    ) -> None:
        self._workspace = Path(workspace).resolve() if workspace else None
        self._global_instructions = (
            global_instructions
            if global_instructions is not None
            else global_instructions_path()
        )
        self._instruction_cache: dict[Path, tuple[tuple[int, int, int, int], str]] = {}

    async def wrap_model_call(
        self,
        ctx: "RunContext",
        state: "AgentState",
        request: "ModelRequest",
        handler: "ModelCallHandler",
    ) -> "AssistantMessage":
        blocks: list[str] = []
        if self._workspace is not None:
            blocks.append(f"## Workspace\nRoot: `{self._workspace}`")
        global_instructions = self._read_instruction_file(self._global_instructions)
        if global_instructions:
            blocks.append(
                f"## Global Instructions\n\nSource: `{self._global_instructions}`\n\n"
                f"{global_instructions}"
            )
        instructions = self._read_workspace_instructions()
        if instructions:
            blocks.append(f"## Workspace Instructions\n\n{instructions}")
        if not blocks:
            return await handler(request)
        block = "\n\n".join(blocks)
        prompt = (
            f"{request.system_prompt}\n\n{block}" if request.system_prompt else block
        )
        return await handler(request.override(system_prompt=prompt))

    def _read_workspace_instructions(self) -> str:
        if self._workspace is None:
            return ""
        for filename in ("AGENTS.md", "CLAUDE.md"):
            instructions = self._read_instruction_file(self._workspace / filename)
            if instructions:
                return instructions
        return ""

    def _read_instruction_file(self, path: Path) -> str:
        try:
            file_stat = path.stat()
        except OSError:
            self._instruction_cache.pop(path, None)
            return ""
        if not S_ISREG(file_stat.st_mode):
            self._instruction_cache.pop(path, None)
            return ""

        signature = (
            file_stat.st_mtime_ns,
            file_stat.st_ctime_ns,
            file_stat.st_size,
            file_stat.st_ino,
        )
        cached = self._instruction_cache.get(path)
        if cached is not None and cached[0] == signature:
            return cached[1]

        try:
            if file_stat.st_size > MAX_AGENTS_MD_BYTES:
                logger.warning(
                    "workspace_instructions_file_too_large path={} bytes={} limit={}",
                    path,
                    file_stat.st_size,
                    MAX_AGENTS_MD_BYTES,
                )
                instructions = ""
            else:
                instructions = path.read_text(encoding="utf-8").strip()
        except (OSError, UnicodeDecodeError) as exc:
            logger.warning(
                "workspace_instructions_file_read_failed path={} error={}", path, exc
            )
            return ""

        self._instruction_cache[path] = (signature, instructions)
        return instructions
