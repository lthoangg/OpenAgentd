"""Long-lived MCP client manager.

Owns one :class:`mcp.ClientSession` per configured server. Sessions are spawned
best-effort during application startup and kept alive for the server's lifetime,
matching the lifecycle of ``agent_manager`` and ``task_scheduler``.

A failed server does NOT block startup: the error is logged, status is set
to ``error``, and the process continues. Healthy servers' tools are merged
into the agent loader's tool registry on next call to
:meth:`MCPManager.get_tools_dict`.

Threading model
---------------

The MCP SDK uses ``anyio`` task groups internally and requires that a
``ClientSession`` is entered and exited from the **same task**. We therefore
spawn one long-running ``asyncio.Task`` per server that:

1. Enters the transport context (``stdio_client`` or ``streamable_http_client``).
2. Enters the ``ClientSession`` context.
3. Calls ``session.initialize()`` and ``session.list_tools()``.
4. Awaits a shutdown ``Event``.
5. Exits both contexts on the way out.

Tool calls happen in arbitrary other tasks but only ever **read** the live
``ClientSession`` reference; they never enter or exit its context.
"""

from __future__ import annotations

import asyncio
import os
import urllib.parse
from contextlib import AsyncExitStack, suppress
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING

import httpx2
from loguru import logger
from mcp import ClientSession, StdioServerParameters
from mcp.client.auth import OAuthRegistrationError
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamable_http_client
from mcp.types import CallToolResult

from app.agent.mcp.config import (
    HttpServerConfig,
    StdioServerConfig,
    load_config,
    resolve_env_dict,
    resolve_headers,
)
from app.agent.mcp.oauth import (
    OAuthRequiredError,
    build_oauth_provider,
    has_cached_oauth_tokens,
    has_resolved_client_id,
    interactive_oauth_allowed,
)
from app.agent.mcp.tools import MCPTool
from app.agent.tools.registry import Tool

if TYPE_CHECKING:
    from mcp import ClientSession


def _find_exception(
    exc: BaseException, kind: type[BaseException]
) -> BaseException | None:
    if isinstance(exc, kind):
        return exc
    if isinstance(exc, BaseExceptionGroup):
        for child in exc.exceptions:
            found = _find_exception(child, kind)
            if found is not None:
                return found
    return None


def _format_exception(exc: BaseException) -> str:
    if isinstance(exc, BaseExceptionGroup):
        # anyio wraps every transport failure in a task group. A lone child
        # carries the whole story, so surfacing the wrapper only shows the
        # reader "ExceptionGroup (...)" noise around the real message.
        if len(exc.exceptions) == 1:
            return _format_exception(exc.exceptions[0])
        child_msgs = [_format_exception(child) for child in exc.exceptions]
        return f"{type(exc).__name__} ({'; '.join(child_msgs)})"
    return f"{type(exc).__name__}: {exc}"


_CACHED_USER_PATH: str | None = None
_USER_PATH_LOCK = asyncio.Lock()
_USER_PATH_TIMEOUT_SECONDS = 3.0
_PATH_OUTPUT_PREFIX = "__OPENAGENTD_PATH__"


async def _get_user_path(*, force_refresh: bool = False) -> str:
    global _CACHED_USER_PATH
    if _CACHED_USER_PATH is not None and not force_refresh:
        return _CACHED_USER_PATH

    async with _USER_PATH_LOCK:
        if _CACHED_USER_PATH is not None and not force_refresh:
            return _CACHED_USER_PATH

        try:
            from app.agent.tools.builtin import shell_runtime

            shell_bin = shell_runtime.acceptable()
            argv = shell_runtime.build_argv(
                shell_bin, f'printf "{_PATH_OUTPUT_PREFIX}%s\\n" "$PATH"'
            )
            proc = await asyncio.create_subprocess_exec(
                shell_bin,
                *argv,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                stdin=asyncio.subprocess.DEVNULL,
            )
            try:
                stdout, _ = await asyncio.wait_for(
                    proc.communicate(), timeout=_USER_PATH_TIMEOUT_SECONDS
                )
            except TimeoutError:
                with suppress(ProcessLookupError):
                    proc.kill()
                with suppress(ProcessLookupError):
                    await proc.wait()
                raise
            if proc.returncode == 0:
                for line in reversed(stdout.decode().splitlines()):
                    if line.startswith(_PATH_OUTPUT_PREFIX):
                        path_str = line.removeprefix(_PATH_OUTPUT_PREFIX).strip()
                        if path_str:
                            _CACHED_USER_PATH = path_str
                            return _CACHED_USER_PATH
        except Exception as exc:
            # Boundary catch-all: any probe failure must fall back to
            # os.environ["PATH"] — never block MCP startup.
            logger.debug("login_shell_path_probe_failed error={!r}", exc)

        _CACHED_USER_PATH = os.environ.get("PATH", "")
        return _CACHED_USER_PATH


@dataclass(frozen=True)
class _StdioLaunch:
    command: str
    env: dict[str, str]


async def _resolve_stdio_launch(server_cfg: StdioServerConfig) -> _StdioLaunch:
    import shutil

    configured_path = server_cfg.env.get("PATH")
    if configured_path is not None:
        effective_path = configured_path
    else:
        user_path = await _get_user_path()
        effective_path = user_path or os.environ.get("PATH", "")
    resolved_command = shutil.which(server_cfg.command, path=effective_path)

    if not resolved_command and configured_path is None:
        user_path = await _get_user_path(force_refresh=True)
        effective_path = user_path or os.environ.get("PATH", "")
        resolved_command = shutil.which(server_cfg.command, path=effective_path)

    env: dict[str, str] = {}
    if effective_path:
        env["PATH"] = effective_path
    env.update(resolve_env_dict(server_cfg.env))

    return _StdioLaunch(
        command=resolved_command or server_cfg.command,
        env=env,
    )


def _is_oauth_registration_failure(exc: BaseException) -> bool:
    if _find_exception(exc, OAuthRegistrationError) is not None:
        return True
    if exc.__class__.__name__ == "OAuthRegistrationError":
        return True
    if isinstance(exc, BaseExceptionGroup):
        return any(_is_oauth_registration_failure(child) for child in exc.exceptions)
    message = str(exc)
    return "Registration failed" in message or "OAuthRegistrationError" in message


def _is_http_auth_failure(exc: BaseException) -> bool:
    if isinstance(exc, BaseExceptionGroup):
        return any(_is_http_auth_failure(child) for child in exc.exceptions)
    message = str(exc).lower()
    return (
        "missing_token" in message
        or "unauthorized" in message
        or "401" in message
        or "authentication" in message
    )


def _requires_oauth_config(cfg: HttpServerConfig) -> bool:
    host = urllib.parse.urlparse(cfg.url).hostname or ""
    return host == "mcp.slack.com"


def _oauth_credentials_required_message(name: str) -> str:
    return (
        f"MCP server '{name}' requires OAuth app credentials. "
        "Add the OAuth app client ID/secret in Settings, then Connect OAuth."
    )


def _oauth_config_required_message(name: str) -> str:
    return (
        f"MCP server '{name}' requires OAuth. "
        "Enable OAuth, add the OAuth app client ID and secret in Settings, "
        "then Connect OAuth."
    )


@dataclass
class MCPServerStatus:
    """Live state for one MCP server. Returned by ``GET /api/mcp/servers``."""

    name: str
    transport: str
    enabled: bool
    state: str  # "stopped" | "starting" | "ready" | "error"
    error: str | None = None
    tool_names: list[str] = field(default_factory=list)
    started_at: str | None = None


@dataclass
class _ServerRunner:
    """Holds the asyncio.Task and live session for one MCP server.

    ``task`` is ``None`` for disabled servers (which have nothing to run);
    callers must check before awaiting. The ``ready`` and ``shutdown``
    events stay populated so polling code can treat all runners uniformly.
    """

    shutdown: asyncio.Event
    ready: asyncio.Event
    task: asyncio.Task[None] | None = None
    session: "ClientSession | None" = None
    status: MCPServerStatus = field(
        default_factory=lambda: MCPServerStatus(
            name="", transport="", enabled=False, state="stopped"
        )
    )
    tools: list[MCPTool] = field(default_factory=list)


def _mark_auth_required(
    runner: _ServerRunner, name: str, transport: str, message: str
) -> None:
    """Park a runner in ``auth_required`` — the one state the UI offers a
    Connect button for, and the one it deliberately hides the error text of."""
    logger.warning(
        "mcp_server_auth_required name={} transport={} err={}",
        name,
        transport,
        message,
    )
    runner.session = None
    runner.tools = []
    runner.status.state = "auth_required"
    runner.status.error = message
    runner.status.tool_names = []
    runner.ready.set()


class MCPManager:
    """Lifecycle owner for all configured MCP server connections.

    Singleton: import :data:`mcp_manager` rather than instantiating directly.
    """

    def __init__(self) -> None:
        self._runners: dict[str, _ServerRunner] = {}
        self._lock = asyncio.Lock()
        self._started = False

    # ── Public lifecycle ──────────────────────────────────────────────────

    async def start(self) -> None:
        """Load ``mcp.json`` and start a connection task per enabled server.

        Safe to call when the file is missing — it just logs and returns.
        Failures on individual servers are logged and do not raise.
        """
        async with self._lock:
            if self._started:
                return
            await self._start_locked()

    async def _start_locked(self) -> None:
        """Body of :meth:`start` — caller must already hold ``self._lock``.

        Factored out so :meth:`reload_from_config` can stop-and-restart in
        a single critical section, closing the window where another caller
        could observe an empty ``_runners`` dict between phases.
        """
        self._started = True

        try:
            cfg = load_config()
        except ValueError as exc:
            logger.error("mcp_config_invalid err={}", exc)
            return

        if not cfg.servers:
            logger.info("mcp_no_servers_configured")
            return

        for name, server_cfg in cfg.servers.items():
            if not server_cfg.enabled:
                self._runners[name] = self._make_disabled_runner(name, server_cfg)
                continue
            await self._spawn_runner(name, server_cfg)

        logger.info(
            "mcp_manager_started servers={}",
            {n: r.status.state for n, r in self._runners.items()},
        )

    async def wait_until_ready(self, *, timeout: float = 10.0) -> None:
        """Block until every spawned runner has reached a terminal state.

        Each runner's ``ready`` event fires when it transitions to ``ready``,
        ``error``, or ``stopped`` — so this returns as soon as every server
        either finished initializing or failed. Servers still pending after
        ``timeout`` are left as-is; the agent loader will see them with zero
        tools and load gracefully (matching :meth:`get_tools_for_server`'s
        existing not-ready contract).

        Kept for explicit callers that need to wait after a restart or config
        apply. Normal API startup intentionally does not call this; MCP runners
        initialize in the background and agents tolerate not-yet-ready servers.
        """
        events = [r.ready for r in self._runners.values()]
        if not events:
            return
        try:
            await asyncio.wait_for(
                asyncio.gather(*(e.wait() for e in events)),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            pending = [
                n for n, r in self._runners.items() if r.status.state == "starting"
            ]
            logger.warning(
                "mcp_wait_until_ready_timeout pending={} timeout_s={}",
                pending,
                timeout,
            )

    async def stop(self) -> None:
        """Signal all runners to shut down and await their exit."""
        async with self._lock:
            if not self._started:
                return
            for runner in self._runners.values():
                runner.shutdown.set()
            tasks = [
                r.task
                for r in self._runners.values()
                if r.task is not None and not r.task.done()
            ]
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            self._runners.clear()
            self._started = False
            logger.info("mcp_manager_stopped")

    # ── Public read API ───────────────────────────────────────────────────

    def get_tools_dict(self) -> dict[str, Tool]:
        """Return ``{tool_name: Tool}`` for every healthy server's tools."""
        result: dict[str, Tool] = {}
        for runner in self._runners.values():
            if runner.status.state != "ready":
                continue
            for t in runner.tools:
                result[t.name] = t
        return result

    def server_names(self) -> list[str]:
        """Return all configured server names (any state, enabled or not)."""
        return list(self._runners.keys())

    def get_tools_for_server(self, name: str) -> list[Tool] | None:
        """Return the tool list for a single server.

        - ``None`` if the server is not configured (caller treats as error).
        - ``[]`` if the server is configured but not ready (disabled, starting,
          errored). The agent loads, just without these tools — matches the
          existing "graceful degradation" model in :meth:`get_tools_dict`.
        """
        runner = self._runners.get(name)
        if runner is None:
            return None
        if runner.status.state != "ready":
            return []
        return list(runner.tools)

    def list_status(self) -> list[MCPServerStatus]:
        """Return a snapshot of every configured server's status."""
        return [r.status for r in self._runners.values()]

    def get_status(self, name: str) -> MCPServerStatus | None:
        runner = self._runners.get(name)
        return runner.status if runner else None

    async def call_app_tool(
        self, server_name: str, tool_name: str, arguments: dict
    ) -> CallToolResult:
        """Call an MCP server tool for an already-approved app bridge request."""
        runner = self._runners.get(server_name)
        if runner is None:
            raise KeyError(server_name)
        if runner.status.state != "ready" or runner.session is None:
            raise RuntimeError(f"MCP server '{server_name}' is not connected.")
        advertised_tool_names = {
            tool.name.removeprefix(f"{server_name}_") for tool in runner.tools
        }
        if tool_name not in advertised_tool_names:
            raise ValueError(f"MCP tool '{tool_name}' is not available.")

        logger.debug(
            "mcp_app_tool_call server={} tool={} args={}",
            server_name,
            tool_name,
            list(arguments.keys()),
        )
        # ``arguments`` are passed through to the MCP server which validates
        # them against the tool's declared JSON Schema before execution.
        # Client-side re-validation is intentionally omitted — the schema is
        # authoritative on the server side and duplicating it here would
        # diverge over time.
        return await runner.session.call_tool(tool_name, arguments)

    # ── Public mutation API (used by /api/mcp routes) ────────────────────

    async def restart_server(
        self, name: str, *, ready_timeout: float = 15.0
    ) -> MCPServerStatus:
        """Restart a single server. The new config is read from disk.

        Raises ``KeyError`` if ``name`` is not in the current config file.
        """
        cfg = load_config()
        if name not in cfg.servers:
            raise KeyError(name)

        async with self._lock:
            await self._stop_runner(name)
            server_cfg = cfg.servers[name]
            if not server_cfg.enabled:
                self._runners[name] = self._make_disabled_runner(name, server_cfg)
            else:
                await self._spawn_runner(name, server_cfg)

        runner = self._runners[name]
        if runner.status.state != "stopped":
            try:
                await asyncio.wait_for(runner.ready.wait(), timeout=ready_timeout)
            except asyncio.TimeoutError:
                logger.warning(
                    "mcp_restart_timeout server={} timeout_s={}", name, ready_timeout
                )
        return runner.status

    async def reload_from_config(self) -> None:
        """Stop all runners and restart from the current config file.

        Done under a single lock so other callers cannot observe an empty
        ``_runners`` dict between the teardown and the respawn.
        """
        async with self._lock:
            for runner in self._runners.values():
                runner.shutdown.set()
            tasks = [
                r.task
                for r in self._runners.values()
                if r.task is not None and not r.task.done()
            ]
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            self._runners.clear()
            self._started = False
            await self._start_locked()

    async def remove_runner(self, name: str) -> None:
        """Tear down ``name``'s runner if present (no-op if absent)."""
        async with self._lock:
            await self._stop_runner(name)
            self._runners.pop(name, None)

    # ── Internals ─────────────────────────────────────────────────────────

    def _make_disabled_runner(
        self, name: str, server_cfg: StdioServerConfig | HttpServerConfig
    ) -> _ServerRunner:
        # Disabled servers carry no task — both events start "set" so any
        # ``ready.wait()`` / ``shutdown.wait()`` returns immediately.
        ready = asyncio.Event()
        ready.set()
        shutdown = asyncio.Event()
        shutdown.set()
        return _ServerRunner(
            shutdown=shutdown,
            ready=ready,
            status=MCPServerStatus(
                name=name,
                transport=server_cfg.transport,
                enabled=False,
                state="stopped",
            ),
        )

    async def _spawn_runner(
        self, name: str, server_cfg: StdioServerConfig | HttpServerConfig
    ) -> None:
        # Two-step construction: register the runner first so ``_run_server``
        # can mutate ``runner.session`` / ``runner.status`` while it executes,
        # then attach the task. ``task`` stays ``Optional`` in the dataclass
        # so this gap is type-safe instead of papered over with type-ignore comments.
        runner = _ServerRunner(
            shutdown=asyncio.Event(),
            ready=asyncio.Event(),
            status=MCPServerStatus(
                name=name,
                transport=server_cfg.transport,
                enabled=True,
                state="starting",
            ),
        )
        self._runners[name] = runner
        runner.task = asyncio.create_task(
            self._run_server(name, server_cfg, runner),
            name=f"mcp-{name}",
        )

    async def _stop_runner(self, name: str) -> None:
        runner = self._runners.get(name)
        if runner is None or runner.task is None:
            # No task means the runner was disabled — nothing to await.
            return
        runner.shutdown.set()
        if not runner.task.done():
            try:
                await asyncio.wait_for(runner.task, timeout=10.0)
            except asyncio.TimeoutError:
                runner.task.cancel()
                try:
                    await runner.task
                except (asyncio.CancelledError, Exception):
                    pass

    async def _run_server(
        self,
        name: str,
        server_cfg: StdioServerConfig | HttpServerConfig,
        runner: _ServerRunner,
    ) -> None:
        """Long-lived task: open the session, list tools, await shutdown."""
        try:
            async with AsyncExitStack() as stack:
                if isinstance(server_cfg, StdioServerConfig):
                    launch = await _resolve_stdio_launch(server_cfg)
                    params = StdioServerParameters(
                        command=launch.command,
                        args=list(server_cfg.args),
                        env=launch.env,
                    )
                    read, write = await stack.enter_async_context(stdio_client(params))
                    session = await stack.enter_async_context(
                        ClientSession(read, write)
                    )
                else:
                    if server_cfg.oauth is None and _requires_oauth_config(server_cfg):
                        raise OAuthRequiredError(_oauth_config_required_message(name))
                    if (
                        server_cfg.oauth is not None
                        and not has_cached_oauth_tokens(name)
                        and not interactive_oauth_allowed(name)
                    ):
                        raise OAuthRequiredError(
                            f"MCP server '{name}' needs OAuth. Use Settings -> MCP -> Connect OAuth."
                        )
                    if (
                        server_cfg.oauth is not None
                        and interactive_oauth_allowed(name)
                        and server_cfg.oauth.client_id
                        and not has_resolved_client_id(server_cfg)
                    ):
                        raise OAuthRequiredError(
                            _oauth_credentials_required_message(name)
                        )
                    # v2 moved headers/auth/timeout off the transport and onto a
                    # caller-supplied client. Both defaults v1 applied internally
                    # must be restated here:
                    #   - follow_redirects: some servers 308 from / to /mcp
                    #     (mcp.excalidraw.com does), which fails without it.
                    #   - Timeout(30, read=300): a bare client would use httpx2's
                    #     flat 5s, far too short for the long-lived GET stream.
                    http_client = await stack.enter_async_context(
                        httpx2.AsyncClient(
                            headers=resolve_headers(server_cfg.headers) or None,
                            auth=build_oauth_provider(name, server_cfg),
                            timeout=httpx2.Timeout(30, read=300),
                            follow_redirects=True,
                        )
                    )
                    # streamable_http_client yields (read, write) in v2 — the
                    # get_session_id callback was dropped.
                    read, write = await stack.enter_async_context(
                        streamable_http_client(server_cfg.url, http_client=http_client)
                    )
                    session = await stack.enter_async_context(
                        ClientSession(read, write)
                    )

                await session.initialize()
                tools_resp = await session.list_tools()

                runner.session = session
                runner.tools = [
                    MCPTool(
                        server_name=name,
                        mcp_tool=t,
                        session_provider=lambda r=runner: r.session,
                    )
                    for t in tools_resp.tools
                ]
                # Mutate the existing status in place rather than rebuilding —
                # ``name``, ``transport``, ``enabled`` are already set correctly
                # by ``_spawn_runner``; only the lifecycle fields move.
                runner.status.state = "ready"
                runner.status.tool_names = [t.name for t in runner.tools]
                runner.status.started_at = datetime.now(UTC).isoformat()
                runner.status.error = None
                runner.ready.set()
                logger.info(
                    "mcp_server_ready name={} transport={} tools={}",
                    name,
                    server_cfg.transport,
                    len(runner.tools),
                )

                # Hold the contexts open until shutdown is requested.
                await runner.shutdown.wait()

                runner.session = None
                logger.info("mcp_server_stopping name={}", name)
        except asyncio.CancelledError:
            runner.status.state = "stopped"
            runner.status.error = None
            runner.ready.set()
            raise
        except OAuthRequiredError as exc:
            _mark_auth_required(runner, name, server_cfg.transport, str(exc))
        except Exception as exc:
            # The SDK calls the OAuth redirect handler from inside its anyio
            # task group, so a cached-but-stale grant raises OAuthRequiredError
            # wrapped in an ExceptionGroup — which `except OAuthRequiredError`
            # above cannot match.
            if (oauth_exc := _find_exception(exc, OAuthRequiredError)) is not None:
                _mark_auth_required(runner, name, server_cfg.transport, str(oauth_exc))
                return
            if (
                isinstance(server_cfg, HttpServerConfig)
                and server_cfg.oauth is None
                and _is_http_auth_failure(exc)
            ):
                _mark_auth_required(
                    runner,
                    name,
                    server_cfg.transport,
                    _oauth_config_required_message(name),
                )
                return
            if _is_oauth_registration_failure(exc) or (
                isinstance(server_cfg, HttpServerConfig)
                and server_cfg.oauth is not None
                and server_cfg.oauth.client_id
                and not has_resolved_client_id(server_cfg)
            ):
                _mark_auth_required(
                    runner,
                    name,
                    server_cfg.transport,
                    _oauth_credentials_required_message(name),
                )
                return
            logger.error(
                "mcp_server_failed name={} transport={} err={}",
                name,
                server_cfg.transport,
                exc,
            )
            runner.session = None
            runner.tools = []
            runner.status.state = "error"
            runner.status.error = _format_exception(exc)
            runner.status.tool_names = []
            runner.ready.set()


# ── Module-level singleton ─────────────────────────────────────────────────

mcp_manager = MCPManager()
