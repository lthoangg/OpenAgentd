from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING
from loguru import logger

from app.agent.hooks.base import BaseAgentHook

if TYPE_CHECKING:
    from app.agent.state import RunContext, AgentState, ToolCallHandler
    from app.agent.schemas.chat import ToolCall


class LspHook(BaseAgentHook):
    """Agent hook that intercepts write, edit, and patch tool calls and injects LSP diagnostics.

    Only active in coding mode. The mode is decided once by the caller and
    passed in at construction — the hook does no DB lookups or test sniffing
    on the hot path.
    """

    def __init__(self, *, enabled: bool = True) -> None:
        # ``enabled`` is set by the team builder based on the team mode
        # ("coding"). When False the hook is a transparent pass-through.
        self._enabled = enabled

    async def wrap_tool_call(
        self,
        ctx: RunContext,
        state: AgentState,
        tool_call: ToolCall,
        handler: ToolCallHandler,
    ) -> str:
        # Execute the tool first
        result = await handler(ctx, state, tool_call)

        if not self._enabled:
            return result

        tool_name = tool_call.function.name
        if tool_name not in ("write", "edit", "patch"):
            return result

        # A tool call truncated by the model's output-token cap can arrive with
        # empty or half-written JSON arguments.  There is no file to diagnose in
        # that case, and the tool itself already reported the failure — so pass
        # the result through instead of raising into the handler below (which
        # would log a misleading "Error in LspHook: Expecting value ...").
        raw_args = tool_call.function.arguments
        if not raw_args:
            return result
        try:
            args = json.loads(raw_args)
        except (json.JSONDecodeError, ValueError):
            logger.debug(
                "lsp_hook_skipped_unparseable_args tool={} chars={}",
                tool_name,
                len(raw_args),
            )
            return result
        if not isinstance(args, dict):
            return result

        try:
            from app.agent.sandbox import get_sandbox
            from app.services.lsp.manager import check_lsp_diagnostics

            sandbox = get_sandbox()

            # Identify which files were modified/added
            files_to_check = []
            if tool_name in ("write", "edit"):
                path = args.get("path")
                if path:
                    files_to_check.append(sandbox.validate_path(path))
            elif tool_name == "patch":
                patch_text = args.get("patch_text")
                if patch_text:
                    from app.agent.tools.builtin.filesystem.patch import _parse_patch

                    patches = _parse_patch(patch_text)
                    for p in patches:
                        if p.kind in ("add", "update"):
                            files_to_check.append(
                                sandbox.validate_path(p.move_to or p.path)
                            )

            # Dedupe so the same file is never checked twice concurrently (the
            # per-URI diagnostics state assumes a single in-flight check).
            unique_files = list(dict.fromkeys(files_to_check))

            # Run diagnostics for all touched files concurrently — a patch can
            # modify several files and each check has its own server round-trip,
            # so serial awaits would stack their latencies.
            reports = await asyncio.gather(
                *(
                    check_lsp_diagnostics(file_path, sandbox.workspace_root)
                    for file_path in unique_files
                ),
                return_exceptions=True,
            )
            lsp_reports = []
            for r in reports:
                if isinstance(r, BaseException):
                    logger.warning("LSP diagnostics check failed: {}", r)
                    continue
                if r:
                    lsp_reports.append(r)

            if lsp_reports:
                all_lines = []
                for r in lsp_reports:
                    lines = r.split("\n")
                    if lines and lines[0] == "[LSP Diagnostics]":
                        lines = lines[1:]
                    all_lines.extend(lines)
                if all_lines:
                    lsp_report = "[LSP Diagnostics]\n" + "\n".join(all_lines)
                    result += f"\n\n{lsp_report}"

        except Exception as e:
            # Never let LSP hook errors crash the tool execution
            logger.warning("Error in LspHook: {}", e)

        return result
