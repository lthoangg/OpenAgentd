"""Innermost tool executor — the final link in the tool-call chain.

The ``Agent`` builds a ``ToolCallHandler`` chain out of every hook's
``wrap_tool_call`` and lays this executor at the bottom.  When the
chain is invoked it eventually calls ``execute(ctx, state, tc)``,
which:

1. Parses ``tc.function.arguments`` JSON.
2. Looks up the tool in the run-local lookup.
3. Runs it with ``_injected={"_state": state}`` plus the parsed args.
4. Coerces the return into a string (special-casing :class:`ToolResult`
   for multimodal parts, ``dict``/``list`` via ``json.dumps``).
5. On error, normalises the message with :func:`sanitize_error`.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import TYPE_CHECKING, Any

from loguru import logger

from app.agent.errors import (
    QuestionSuspended,
    ToolArgumentError,
    ToolNotFoundError,
)
from app.agent.schemas.chat import ContentBlock, TextBlock, ToolResult

TOOL_TIMEOUT_SECONDS = 300.0

# Characters of tool output kept in the DEBUG preview line.  The authoritative
# copy lives in the DB and the per-session log; this is only a breadcrumb for
# scanning app.log.
_RESULT_PREVIEW_CHARS = 200


if TYPE_CHECKING:
    from app.agent.schemas.chat import ToolCall
    from app.agent.state import AgentState, RunContext, ToolCallHandler
    from app.agent.tools.registry import Tool


def sanitize_error(message: str) -> str:
    """Normalise sandbox paths in tool error messages."""
    return message


def make_tool_executor(
    run_tools: dict[str, Tool],
    agent_name: str,
) -> ToolCallHandler:
    """Return the innermost tool executor coroutine for one ``Agent.run``.

    Closed over ``run_tools`` (constructor + injected tools) and the
    agent's ``name`` (logging only).  The executor itself depends on
    no instance state, so it can live outside the class.
    """

    async def execute(ctx: RunContext, s: AgentState, tc: ToolCall) -> str:
        tool_start = time.monotonic()
        logger.info(
            "tool_start agent={} tool={} id={} args={}",
            agent_name,
            tc.function.name,
            tc.id,
            tc.function.arguments[:500] if tc.function.arguments else "{}",
        )

        try:
            args: dict = {}
            if tc.function.arguments:
                try:
                    args = json.loads(tc.function.arguments)
                except (json.JSONDecodeError, ValueError) as parse_exc:
                    logger.warning(
                        "tool_args_parse_failed tool={} raw_args={} error={}",
                        tc.function.name,
                        tc.function.arguments,
                        parse_exc,
                    )
                    raise ToolArgumentError(
                        f"Could not parse arguments for tool '{tc.function.name}': "
                        f"{parse_exc}. Raw: {tc.function.arguments!r}"
                    ) from parse_exc

            if tc.function.name not in run_tools:
                raise ToolNotFoundError(f"Tool '{tc.function.name}' not found.")

            # Empty ``arguments`` is a valid no-arg call, but
            # for a tool with required parameters it means the model's output was
            # cut off before it emitted any argument text — usually a large
            # ``write``/``patch``.  Pydantic would report "Field required", which
            # misleads the model into re-sending the same oversized call.  Name
            # the real cause so it splits the work instead.
            if not tc.function.arguments:
                required = (
                    run_tools[tc.function.name]
                    .definition["function"]["parameters"]
                    .get("required")
                    or []
                )
                if required:
                    raise ToolArgumentError(
                        f"No arguments received for '{tc.function.name}' (requires "
                        f"{', '.join(sorted(required))}). Retry with a smaller payload."
                    )

            workspace_raw = s.metadata.get("workspace")
            injected_workspace = (
                str(workspace_raw)
                if isinstance(workspace_raw, str) and workspace_raw
                else None
            )

            arun_coro = run_tools[tc.function.name].arun(
                _injected={
                    "_state": s,
                    "_tool_call_id": tc.id,
                    "_workspace": injected_workspace,
                    "_tool_output": s.metadata.get("_tool_output_callbacks", {}).get(
                        tc.id
                    ),
                },
                **args,
            )

            if tc.function.name == "shell":
                result_raw = await arun_coro
            else:
                async with asyncio.timeout(TOOL_TIMEOUT_SECONDS):
                    result_raw = await arun_coro

            if isinstance(result_raw, ToolResult):
                # Multimodal tool result — stash parts in state metadata
                # for retrieval when constructing the ToolMessage.
                # Derive content from TextBlock items for DB persistence.
                result = " ".join(
                    p.text for p in result_raw.parts if isinstance(p, TextBlock)
                )
                pending: dict[str, list[ContentBlock]] = s.metadata.setdefault(
                    "_multimodal_tool_parts", {}
                )
                pending[tc.id] = result_raw.parts

                if result_raw.mcp_app:
                    mcp_apps: dict[str, dict[str, Any]] = s.metadata.setdefault(
                        "_mcp_apps", {}
                    )
                    mcp_apps[tc.id] = result_raw.mcp_app
            elif isinstance(result_raw, (dict, list)):
                result = json.dumps(result_raw)
            else:
                result = str(result_raw)

            tool_elapsed = time.monotonic() - tool_start
            logger.info(
                "tool_done agent={} tool={} elapsed={:.2f}s result_len={}",
                agent_name,
                tc.function.name,
                tool_elapsed,
                len(result),
            )
            # Short preview only.  The full result is already persisted as a
            # ToolMessage in the DB and mirrored into the per-session log, so a
            # 1 KB copy per call bought nothing but disk (6.4 MB / 2 days).
            logger.debug(
                "tool_result_preview agent={} tool={} result={}",
                agent_name,
                tc.function.name,
                result[:_RESULT_PREVIEW_CHARS],
            )

        except QuestionSuspended:
            # Control flow, not a failure: the turn is being handed to the user.
            # Swallowing it into an "Error: ..." result would strand the
            # already-persisted question with nothing waiting on the answer.
            raise
        except TimeoutError as e:
            msg = str(e)
            if not msg:
                msg = f"Tool '{tc.function.name}' timed out after {TOOL_TIMEOUT_SECONDS}s."
            result = f"Error: {msg}"
            tool_elapsed = time.monotonic() - tool_start
            logger.warning(
                "tool_timeout agent={} tool={} elapsed={:.2f}s error={}",
                agent_name,
                tc.function.name,
                tool_elapsed,
                e,
            )
        except Exception as e:
            result = f"Error: {sanitize_error(str(e))}"
            tool_elapsed = time.monotonic() - tool_start
            logger.warning(
                "tool_error agent={} tool={} elapsed={:.2f}s error={}",
                agent_name,
                tc.function.name,
                tool_elapsed,
                e,
            )

        return result

    return execute
