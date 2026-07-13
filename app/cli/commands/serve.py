"""``openagentd serve`` — foreground server for desktop / embedded use.

Unlike :mod:`app.cli.commands.start`, which double-forks and writes a PID
file so the user gets their shell back, ``serve`` runs uvicorn in the
**foreground** with no PID file and no log redirection. Stdout/stderr go
to the parent process — which in the desktop case is the Tauri shell.

Why a separate command?

- ``start`` is for terminal users: backgrounded daemon, fixed port, PID
  file, banner, logs to disk.
- ``serve`` is for embedding (Tauri, CI smoke tests, any
  foreground-supervised host): foreground, dynamic port, JSON handshake,
  parent-death watch.

The two never compete: a Tauri sidecar will never need PID-file
arbitration, and a terminal user will never want the backend's lifecycle
tied to ``$$``.

JSON handshake
==============

When ``--handshake`` is passed, the first line printed to stdout is a
single JSON object describing the bound port and (if applicable) the
desktop token::

    {"port": 53421, "token": "...", "pid": 12345, "version": "0.6.0"}

The shell parses that and uses it to point its webview at the right
URL and to inject the token into the page.

Port selection
==============

``--port 0`` (default for ``serve``) tells uvicorn to bind to an
OS-assigned ephemeral port. We do **not** ask the kernel for a port
ourselves and then hand it to uvicorn — that races with anything else
on the host. Instead we let uvicorn's own socket do the bind, then
read the bound port from the socket and emit it on the handshake line
once the server is ready.

Parent-death watch
==================

When ``--parent-pid <pid>`` is passed, a background task polls every
500 ms and exits the process if that PID is no longer alive. This is
the cross-platform backstop the desktop sidecar relies on.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import secrets
import signal
import sys
import threading
from typing import Any

from app.cli.net import require_loopback_or_auth
from app.core.server_settings import load_server_settings


def _add_serve_subparser(sub: argparse._SubParsersAction) -> None:
    """Register the ``serve`` subcommand on the given subparsers action."""
    p = sub.add_parser(
        "serve",
        help="Foreground server for desktop shells / embedding",
        description=(
            "Run the API server in the foreground. Intended for embedding "
            "(Tauri desktop shell, CI smoke tests). For a backgrounded "
            "daemon use 'openagentd start' instead."
        ),
    )
    p.add_argument(
        "--host",
        default="127.0.0.1",
        help="Bind host (default: 127.0.0.1 — desktop must stay local).",
    )
    p.add_argument(
        "--port",
        type=int,
        default=0,
        help="Bind port. 0 (default) picks an OS-assigned ephemeral port.",
    )
    p.add_argument(
        "--handshake",
        action="store_true",
        help="Emit a single JSON line on stdout once bound (for Tauri/IPC).",
    )
    p.add_argument(
        "--generate-token",
        action="store_true",
        help=(
            "Generate a random desktop session token and require it for API "
            "access. The token is included in the handshake line."
        ),
    )
    p.add_argument(
        "--parent-pid",
        type=int,
        default=None,
        help=(
            "Exit if the given PID is no longer alive. Used by the desktop "
            "shell to clean up the backend when it crashes."
        ),
    )
    p.set_defaults(func=cmd_serve)


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # PID exists but we can't signal it — still alive enough for our purposes.
        return True
    except OSError:
        return False
    return True


def _start_parent_watch(
    parent_pid: int,
    interval: float = 0.5,
    shutdown_grace: float = 15.0,
) -> None:
    """Spawn a daemon thread that exits the process if parent_pid dies.

    Runs in a thread (not asyncio task) so it survives even if the event
    loop is wedged. SIGTERM goes out first so uvicorn can drain in-flight
    requests + run shutdown hooks (MCP, scheduler, OTel, DB) — those can
    take several seconds in practice. We only ``os._exit`` if SIGTERM
    didn't take effect within ``shutdown_grace``.
    """
    import time as _time

    def _watch() -> None:
        while True:
            if not _pid_alive(parent_pid):
                # Parent died — don't leak the backend.  Log first so that
                # ``backend.log`` retains *something* if the watch ever
                # fires by mistake (e.g. a future bug in ``_pid_alive``);
                # a silent self-kill is hard to diagnose.
                print(
                    f"parent-watch: parent pid {parent_pid} no longer alive; "
                    "sending SIGTERM to self",
                    file=sys.stderr,
                    flush=True,
                )
                try:
                    os.kill(os.getpid(), signal.SIGTERM)
                except OSError:
                    pass
                # Poll for our own pending shutdown; daemon threads die
                # automatically once the main thread exits, so a clean
                # uvicorn shutdown means we never reach the hard exit.
                deadline = _time.monotonic() + shutdown_grace
                while _time.monotonic() < deadline:
                    _time.sleep(0.25)
                os._exit(1)
            _time.sleep(interval)

    t = threading.Thread(target=_watch, name="parent-watch", daemon=True)
    t.start()


def _server_port(server: Any, fallback: int) -> int:
    """Return the actual TCP port bound by uvicorn after startup."""
    for srv in getattr(server, "servers", []) or []:
        for sock in getattr(srv, "sockets", []) or []:
            addr = sock.getsockname()
            if isinstance(addr, tuple) and len(addr) >= 2:
                return int(addr[1])
    return fallback


def _emit_handshake(*, port: int, token: str | None, version: str) -> None:
    payload: dict[str, Any] = {
        "port": port,
        "pid": os.getpid(),
        "version": version,
    }
    if token:
        payload["token"] = token
    # Single channel: stdout with an explicit marker so the parent can
    # ignore any incidental log lines that arrive first.
    sys.stdout.write("OPENAGENTD_HANDSHAKE " + json.dumps(payload) + "\n")
    sys.stdout.flush()


def _configure_desktop_token(generate_token: bool) -> str | None:
    if generate_token:
        token = secrets.token_urlsafe(32)
        os.environ["OPENAGENTD_DESKTOP_TOKEN"] = token
        return token
    return os.environ.get("OPENAGENTD_DESKTOP_TOKEN") or None


def cmd_serve(args: argparse.Namespace) -> None:
    # Lazy imports so ``openagentd --help`` stays fast.
    import uvicorn

    from app.core.version import VERSION

    # Token must be in env *before* the app is imported so the middleware
    # picks it up at construction time.
    token = _configure_desktop_token(args.generate_token)
    require_loopback_or_auth(
        host=args.host,
        has_auth=bool(
            token
            or os.environ.get("OPENAGENTD_ACCESS_KEY")
            or load_server_settings().access_key
        ),
    )

    # Hard-enforce production mode in this entry point — the desktop
    # sidecar must never run with dev hot-reload, dev XDG roots, etc.
    os.environ.setdefault("APP_ENV", "production")

    if args.parent_pid is not None:
        _start_parent_watch(args.parent_pid)

    config = uvicorn.Config(
        "app.server:app",
        host=args.host,
        port=args.port,
        log_config=None,  # let loguru handle it
        access_log=False,
    )
    server = uvicorn.Server(config)

    async def _serve_and_handshake() -> None:
        """Run the server, emitting the handshake only once it's listening.

        The order matters: if we emit before the server is up the parent
        will race ahead and start hitting ``/api/health/live`` against a
        port that nothing's accepting on yet. Uvicorn exposes a
        ``started`` flag we can poll, plus there's a ``startup_complete``
        on the lifespan we could hook — polling ``server.started`` is
        the simplest pattern that works on every uvicorn version.
        """
        serve_task = asyncio.create_task(server.serve())
        if args.handshake:
            # Poll until uvicorn is actually accepting, or the serve
            # task crashes — whichever comes first.
            while not server.started:
                if serve_task.done():
                    # serve() returned without ``started`` flipping —
                    # something failed during startup. Surface the
                    # exception by awaiting the task.
                    await serve_task
                    return
                await asyncio.sleep(0.05)
            _emit_handshake(
                port=_server_port(server, args.port), token=token, version=VERSION
            )
        await serve_task

    # Run in this thread; KeyboardInterrupt / SIGTERM propagate naturally.
    asyncio.run(_serve_and_handshake())
