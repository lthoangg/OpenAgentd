---
title: User Plugins
description: User-authored Python plugins that hook into the agent loop without modifying the codebase.
status: stable
updated: 2026-07-02
---

# User Plugins

**Source:** `app/agent/plugins/`

Drop a `.py` file into `{OPENAGENTD_CONFIG_DIR}/plugins/` (default `.openagentd/config/plugins/`) to hook into the agent loop without touching the codebase. The hook loader discovers hook plugins at agent-build time and adapts them into [`BaseAgentHook`](hooks.md) instances. Provider plugins in the same directory expose `provider = ProviderPlugin(...)` and are ignored by the hook loader because they are loaded by the provider registry instead.

Provider plugin credential, discovery, usage, and model-metadata alias fields are documented in [`configuration/providers.md`](../configuration/providers.md#provider-plugins).

Set `OPENAGENTD_PLUGINS_DIRS` to point elsewhere; separate multiple directories with the OS path separator (`:` on macOS/Linux, `;` on Windows — same convention as `PATH`/`PYTHONPATH`). Files prefixed with `_` are skipped — useful for helper modules.

---

## Two contracts

### Functional — `async def plugin()` returning an event dict

Best for tool-arg/result rewrites.

```python
async def plugin():
    async def before(input, output):
        # mutate output["args"] in place; raise to abort with the message as result
        ...

    async def after(input, output):
        # mutate output["output"] to rewrite the result the LLM sees
        ...

    return {
        "tool.before": before,
        "tool.after": after,
        "applies_to": lambda agent_name, role: True,  # optional
    }
```

Minimal complete example — prefix every `shell` command with `set -e`:

```python
"""Fail-fast shell: abort multi-statement commands on the first error."""


async def plugin():
    async def before(input, output):
        if input["tool"] != "shell":
            return
        command = output["args"].get("command") or ""
        if command and not command.startswith("set -e"):
            output["args"]["command"] = "set -e\n" + command

    return {"tool.before": before}
```

**Events** (TypedDict shapes live in [`app/agent/plugins/events.py`](../../../app/agent/plugins/events.py)):

| Event         | Mutable output | Failure mode                                                |
| ------------- | -------------- | ----------------------------------------------------------- |
| `tool.before` | `args`         | Raise → `"Error: <message>"` returned, executor not called. |
| `tool.after`  | `output`       | Logged; original tool result preserved.                     |

#### Real-world example: rtk command rewriting

[rtk](https://github.com/rtk-ai/rtk) is a CLI proxy that compresses command output for 60-90 % token savings on `git` / `cargo` / `pytest` / `ls` output. This plugin pipes every `shell` tool command through `rtk rewrite "<command>"` and substitutes the rewritten command when rtk knows an equivalent. Commands rtk does not recognise — and background processes, empty commands, or already-wrapped `rtk …` commands — run unchanged; every failure path (rtk missing, timeout, crash) degrades to pass-through, so the plugin can only ever make things cheaper, never break them.

One caveat: rtk's `curl`/`wget` filters summarize the response *structure* (`{fact: string[120], length: int}`) instead of returning the body — useless when the agent needs the actual data. rtk's own README ships `exclude_commands = ["curl", ...]` in `~/.config/rtk/config.toml` (macOS: `~/Library/Application Support/rtk/config.toml`) for exactly this, and `rtk rewrite` honors it (verified: excluded commands return no rewrite). The plugin below also skips data-fetching commands itself, so it is safe even without that config file.

Install rtk (`brew install rtk`), save this as `{OPENAGENTD_CONFIG_DIR}/plugins/rtk_rewrite.py`, restart openagentd:

```python
"""Rewrite ``shell`` tool commands through rtk before execution."""

from __future__ import annotations

import asyncio
import shutil
from typing import Any

from loguru import logger

#: Absolute path to the rtk binary, resolved once at import time.
#: ``None`` disables the plugin (pure pass-through).
_RTK: str | None = shutil.which("rtk")

#: Hard cap on a single ``rtk rewrite`` call. rtk is <10 ms in practice;
#: this only guards against a wedged binary.
_REWRITE_TIMEOUT: float = 5.0

#: Commands whose *response body* is the point — rtk's filters summarize
#: structure ("fact: string[120]") instead of returning the data, which
#: breaks agents that need the actual payload. rtk's own README ships
#: ``exclude_commands = ["curl", ...]`` in config.toml for the same
#: reason; this is the in-plugin fallback for users without that config.
_EXCLUDED_PREFIXES: tuple[str, ...] = ("curl", "wget", "http ", "https ")


def _is_excluded(command: str) -> bool:
    """True when any statement in *command* starts with an excluded tool.

    Checks each ``&&`` / ``||`` / ``;`` / ``|`` segment so pipelines like
    ``curl … | cat`` and chains like ``cd x && curl …`` are caught.
    """
    import re

    for segment in re.split(r"&&|\|\||;|\|", command):
        stripped = segment.strip()
        if stripped.startswith(_EXCLUDED_PREFIXES):
            return True
    return False


async def _rtk_rewrite(command: str) -> str | None:
    """Return the rtk-rewritten command, or ``None`` when no rewrite applies.

    ``rtk rewrite`` prints the rewritten command to stdout when a rewrite
    exists and prints nothing otherwise. Exit codes vary across rtk
    versions, so we key off non-empty stdout only. Never raises — any
    subprocess failure is treated as "no rewrite".
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
        # Already wrapped (by the LLM or a previous hook).
        if command.startswith("rtk "):
            return
        # Data-fetching commands where the body is the answer.
        if _is_excluded(command):
            return

        rewritten = await _rtk_rewrite(command)
        if rewritten and rewritten != command:
            args["command"] = rewritten

    return {"tool.before": before}
```

### Class-based — `class Plugin(BaseAgentHook)`

Use when you need the full hook surface (`wrap_model_call`, `before_agent`, `on_rate_limit`, …). Subclass [`BaseAgentHook`](hooks.md) and expose it as `Plugin`. Configuration: import `app.core.config.settings` directly.

---

## `applies_to(agent_name, role)`

Optional filter run once per agent at load time. Roles: `lead` (team orchestrator), `member` (team worker), `agent` (direct `Agent.run()` callers). Propagated via `app.agent.plugins.role` contextvar — set by the team runner, so `Agent.run()` takes no role parameter.

---

## Loading & isolation

- **Lazy & cached** per `(Agent, role)`. Restart the process to pick up edits — no hot reload.
- **Isolated failures:** import error → `plugin_load_failed` log, file skipped, others continue. `applies_to` raise → treated as not applicable. Class-hook errors → caught by `_safe_invoke_hooks()` (see [`hooks.md`](hooks.md)).
- **Order:** user plugins run after `Agent.hooks` and per-call `hooks=` — built-ins win.

---

## See also

- [`hooks.md`](hooks.md) — full hook protocol and lifecycle.
- [`loop.md`](loop.md) — where each event fires in the agent loop.
