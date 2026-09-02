"""Plugin discovery and adapter.

The loader scans a list of directories for ``*.py`` files, imports each
in isolation, and returns a list of :class:`BaseAgentHook` instances
filtered by ``(agent_name, role)``.

Two authoring contracts are recognised, in priority order:

1. **Functional** — module exports ``async def plugin() -> dict``.  The
   returned dict maps event names (``"tool.before"``, ``"tool.after"``)
   to coroutines.  We wrap it in :class:`_FunctionalPluginAdapter`.

2. **Class-based** — module exports a class ``Plugin`` that subclasses
   :class:`BaseAgentHook`.  The class is instantiated with no arguments;
   plugin authors that need configuration read it from
   :data:`app.core.config.settings` or environment variables in
   ``__init__``.

Errors during discovery, import, or instantiation are logged and
swallowed so a single broken plugin never takes down the agent.
"""

from __future__ import annotations

import importlib.util
import inspect
import json
import sys
from collections.abc import Awaitable, Callable, Sequence
from pathlib import Path
from typing import Any

from loguru import logger

from app.agent.hooks.base import BaseAgentHook
from app.agent.plugins.events import (
    ToolAfterInput,
    ToolAfterOutput,
    ToolBeforeInput,
    ToolBeforeOutput,
)
from app.agent.providers.plugin_api import ProviderPlugin
from app.agent.schemas.chat import FunctionCall, ToolCall
from app.agent.state import AgentState, RunContext, ToolCallHandler

# Event-name → handler signature.  Kept as plain strings (no enum) so
# adding new event names is a one-line change in this module and a
# matching dispatch line in the adapter.
EVENT_TOOL_BEFORE = "tool.before"
EVENT_TOOL_AFTER = "tool.after"

KNOWN_EVENTS = frozenset({EVENT_TOOL_BEFORE, EVENT_TOOL_AFTER})


class PluginLoadError(RuntimeError):
    """Raised internally when a plugin file fails to load.  Caught by
    :func:`load_plugin_hooks` so one bad file doesn't block the rest."""


# ---------------------------------------------------------------------------
# Functional adapter
# ---------------------------------------------------------------------------


class _FunctionalPluginAdapter(BaseAgentHook):
    """Wrap a functional plugin's event dict in the BaseAgentHook surface.

    Only the events present in ``handlers`` are dispatched; absent events
    fall through to the no-op base methods.  ``applies_to`` is supplied
    via the ``applies_to_fn`` constructor arg (None = global).
    """

    def __init__(
        self,
        *,
        plugin_id: str,
        handlers: dict[str, Callable[..., Awaitable[None]]],
        applies_to_fn: Callable[[str, str], bool] | None = None,
    ) -> None:
        self._plugin_id = plugin_id
        self._handlers = handlers
        self._applies_to_fn = applies_to_fn

    def applies_to(self, agent_name: str, role: str) -> bool:
        if self._applies_to_fn is None:
            return True
        try:
            return bool(self._applies_to_fn(agent_name, role))
        except Exception as exc:  # noqa: BLE001 — never crash the agent
            logger.warning(
                "plugin_applies_to_failed plugin={} error={}",
                self._plugin_id,
                exc,
            )
            return False

    async def wrap_tool_call(
        self,
        ctx: RunContext,
        state: AgentState,
        tool_call: ToolCall,
        handler: ToolCallHandler,
    ) -> str:
        before = self._handlers.get(EVENT_TOOL_BEFORE)
        after = self._handlers.get(EVENT_TOOL_AFTER)

        # Fast-path: no event subscribed → pure pass-through.
        if before is None and after is None:
            return await handler(ctx, state, tool_call)

        # ── tool.before ────────────────────────────────────────────────
        # Mutation contract: plugins mutate `output["args"]`; we
        # re-serialize back into a fresh ToolCall before dispatching.
        # An exception in the before-hook aborts execution and surfaces
        # as the tool result.
        try:
            args: dict[str, Any] = (
                json.loads(tool_call.function.arguments)
                if tool_call.function.arguments
                else {}
            )
        except (json.JSONDecodeError, ValueError):
            # Args aren't valid JSON — let the executor surface the
            # canonical ToolArgumentError.  Skip the before-hook.
            args = {}
            before = None

        if before is not None:
            input_payload: ToolBeforeInput = {
                "tool": tool_call.function.name,
                "session_id": ctx.session_id,
                "run_id": ctx.run_id,
                "agent_name": ctx.agent_name,
                "call_id": tool_call.id,
            }
            output_payload: ToolBeforeOutput = {"args": args}
            try:
                await before(input_payload, output_payload)
            except Exception as exc:  # noqa: BLE001 — abort signal
                logger.info(
                    "plugin_tool_before_aborted plugin={} tool={} reason={}",
                    self._plugin_id,
                    tool_call.function.name,
                    exc,
                )
                return f"Error: {exc}"

            # Rebuild ToolCall with possibly-mutated args.  We never
            # mutate the inbound object — concurrent runs share state.
            tool_call = ToolCall(
                id=tool_call.id,
                type=tool_call.type,
                function=FunctionCall(
                    name=tool_call.function.name,
                    arguments=json.dumps(output_payload["args"]),
                    thought=tool_call.function.thought,
                    thought_signature=tool_call.function.thought_signature,
                ),
            )

        result = await handler(ctx, state, tool_call)

        # ── tool.after ─────────────────────────────────────────────────
        if after is not None:
            after_input: ToolAfterInput = {
                "tool": tool_call.function.name,
                "session_id": ctx.session_id,
                "run_id": ctx.run_id,
                "agent_name": ctx.agent_name,
                "call_id": tool_call.id,
                "args": args,
            }
            after_output: ToolAfterOutput = {"output": result}
            try:
                await after(after_input, after_output)
                result = after_output["output"]
            except Exception as exc:  # noqa: BLE001 — never crash agent
                logger.warning(
                    "plugin_tool_after_failed plugin={} tool={} error={}",
                    self._plugin_id,
                    tool_call.function.name,
                    exc,
                )

        return result


# ---------------------------------------------------------------------------
# Discovery + import
# ---------------------------------------------------------------------------


def _import_plugin_file(path: Path) -> Any:
    """Import ``path`` as an anonymous module and return the module object.

    Each plugin gets a unique synthetic module name keyed by its
    absolute path so two plugins with the same filename in different
    dirs don't clobber each other in ``sys.modules``.
    """
    mod_name = f"_openagentd_plugin_{abs(hash(str(path.resolve())))}"
    spec = importlib.util.spec_from_file_location(mod_name, path)
    if spec is None or spec.loader is None:
        raise PluginLoadError(f"Could not create import spec for {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = module
    try:
        spec.loader.exec_module(module)
    except Exception as exc:
        # Drop the half-initialised module so re-imports start clean.
        sys.modules.pop(mod_name, None)
        raise PluginLoadError(f"Import failed for {path}: {exc}") from exc
    return module


async def _adapt_module(module: Any) -> BaseAgentHook | None:
    """Convert one imported module into a single BaseAgentHook instance.

    Functional contract wins if both ``plugin`` and ``Plugin`` are
    defined — that's almost certainly an authoring mistake but we pick
    the explicit factory over the class.
    """
    plugin_id = getattr(module, "__name__", "<unknown>")

    # Provider plugins share this directory but are loaded by the provider
    # registry, not by the agent hook loader.
    provider = getattr(module, "provider", None)
    if isinstance(provider, ProviderPlugin):
        return None

    # ── Functional contract ────────────────────────────────────────────
    factory = getattr(module, "plugin", None)
    if factory is not None and inspect.iscoroutinefunction(factory):
        result = await factory()
        if not isinstance(result, dict):
            raise PluginLoadError(
                f"plugin() in {plugin_id} must return a dict, got {type(result).__name__}"
            )
        unknown = set(result) - KNOWN_EVENTS - {"applies_to"}
        if unknown:
            logger.warning(
                "plugin_unknown_events plugin={} events={}",
                plugin_id,
                sorted(unknown, key=str),
            )
        handlers: dict[str, Callable[..., Awaitable[None]]] = {
            name: fn for name, fn in result.items() if name in KNOWN_EVENTS
        }
        applies_to_raw = result.get("applies_to")
        applies_to_fn: Callable[[str, str], bool] | None
        if applies_to_raw is None:
            applies_to_fn = None
        elif callable(applies_to_raw):
            # Trust the caller — _FunctionalPluginAdapter coerces the
            # return value with bool() and traps exceptions, so a wrong
            # signature surfaces as "plugin_applies_to_failed" not a crash.
            applies_to_fn = applies_to_raw  # type: ignore[assignment]
        else:
            raise PluginLoadError(
                f"applies_to in {plugin_id} must be callable, got {type(applies_to_raw).__name__}"
            )
        return _FunctionalPluginAdapter(
            plugin_id=plugin_id,
            handlers=handlers,
            applies_to_fn=applies_to_fn,
        )

    # ── Class-based contract ───────────────────────────────────────────
    cls = getattr(module, "Plugin", None)
    if cls is not None and inspect.isclass(cls) and issubclass(cls, BaseAgentHook):
        return cls()

    raise PluginLoadError(
        f"{plugin_id} exposes no recognised plugin contract "
        "(expected `async def plugin()` or `class Plugin(BaseAgentHook)`)"
    )


def _discover_plugin_files(dirs: Sequence[Path]) -> list[Path]:
    """Return ``.py`` files across ``dirs`` (sorted, deduped, skipping
    ``_*.py`` so authors can stash helper modules)."""
    seen: set[Path] = set()
    out: list[Path] = []
    for d in dirs:
        if not d.exists() or not d.is_dir():
            continue
        for path in sorted(d.glob("*.py")):
            if path.name.startswith("_"):
                continue
            resolved = path.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            out.append(path)
    return out


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


async def load_plugin_hooks(
    dirs: Sequence[str | Path],
    *,
    agent_name: str,
    role: str,
) -> list[BaseAgentHook]:
    """Discover and instantiate plugin hooks for one agent.

    Errors in any single plugin are logged and isolated — the rest of
    the discovery continues so one typo doesn't disable every plugin.

    ``role`` is the persisted agent role string (``"lead"`` / ``"member"``)
    used by ``applies_to`` filters.
    """
    paths = [Path(d) for d in dirs]
    files = _discover_plugin_files(paths)
    if not files:
        return []

    hooks: list[BaseAgentHook] = []

    for f in files:
        try:
            module = _import_plugin_file(f)
            hook = await _adapt_module(module)
        except PluginLoadError as exc:
            logger.warning("plugin_load_failed file={} error={}", f, exc)
            continue
        except Exception as exc:  # noqa: BLE001 — defensive: never bubble
            logger.warning("plugin_load_unexpected file={} error={}", f, exc)
            continue
        if hook is None:
            continue

        applies = getattr(hook, "applies_to", None)
        if callable(applies):
            try:
                if not applies(agent_name, role):
                    continue
            except Exception as exc:  # noqa: BLE001
                logger.warning("plugin_applies_to_errored file={} error={}", f, exc)
                continue
        logger.info(
            "plugin_loaded file={} agent={} role={}",
            f.name,
            agent_name,
            role,
        )
        hooks.append(hook)

    return hooks
