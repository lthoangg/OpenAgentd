"""Rewrite ``shell`` tool commands through rtk before execution.

`rtk <https://github.com/rtk-ai/rtk>`_ is a CLI proxy that filters and
compresses command output before it reaches the LLM context (60-90 %
token savings on ``git``, ``cargo``, ``pytest``, ``ls`` … output).

This plugin uses openagentd's functional plugin contract: every ``shell``
tool call is passed through ``rtk rewrite`` and, when rtk knows an equivalent,
the command is substituted before execution.  Commands rtk does not recognise
run unchanged.

Install
-------
1. ``brew install rtk`` (or see the rtk README).
2. Copy this file into ``{OPENAGENTD_CONFIG_DIR}/plugins/``.
3. Restart openagentd (plugins are loaded at agent-build time).

Contract with ``rtk rewrite``
-----------------------------
``rtk rewrite "<command>"`` prints the rewritten command to stdout when
a rewrite exists and prints nothing when it does not.  Exit codes vary
across rtk versions (0 documented, 3 observed on 0.36.x), so we key off
*non-empty stdout* only.

Failure policy
--------------
Raising inside ``tool.before`` aborts the tool call, so every failure
path here (rtk missing, timeout, crash) is swallowed and the original
command runs unmodified — the plugin can only ever make things cheaper,
never break them.
"""

from __future__ import annotations

import asyncio
import shutil
from typing import Any

from loguru import logger

#: Absolute path to the rtk binary, resolved once at import time.
#: ``None`` disables the plugin (pure pass-through).
_RTK: str | None = shutil.which("rtk")

#: Hard cap on how long a single ``rtk rewrite`` call may take.  rtk is
#: <10 ms in practice; this only guards against a wedged binary.
_REWRITE_TIMEOUT: float = 5.0


async def _rtk_rewrite(command: str) -> str | None:
    """Return the rtk-rewritten command, or ``None`` when no rewrite applies.

    Never raises — any subprocess failure is treated as "no rewrite".
    """
    if _RTK is None:
        return None
    try:
        proc = await asyncio.create_subprocess_exec(
            _RTK,
            "rewrite",
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            stdout, _ = await asyncio.wait_for(
                proc.communicate(), timeout=_REWRITE_TIMEOUT
            )
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            logger.warning("rtk_rewrite_timeout command={}", command[:120])
            return None
    except Exception as exc:  # noqa: BLE001 — never break the tool call
        logger.warning("rtk_rewrite_failed command={} error={}", command[:120], exc)
        return None

    rewritten = stdout.decode("utf-8", errors="replace").strip()
    return rewritten or None


async def plugin() -> dict[str, Any]:
    async def before(input: dict[str, Any], output: dict[str, Any]) -> None:
        if _RTK is None or input["tool"] != "shell":
            return
        args = output["args"]
        command = args.get("command") or ""
        if not command:
            return
        # Dev servers / watchers stream output — rtk's filters target
        # bounded output, so leave background processes alone.
        if args.get("background"):
            return
        # Already wrapped (by the LLM or a previous hook) — skip the
        # subprocess round-trip.
        if command.startswith("rtk "):
            return
        rewritten = await _rtk_rewrite(command)
        if rewritten and rewritten != command:
            logger.debug(
                "rtk_rewrite applied session={} before={} after={}",
                input["session_id"],
                command[:120],
                rewritten[:120],
            )
            args["command"] = rewritten

    return {"tool.before": before}
