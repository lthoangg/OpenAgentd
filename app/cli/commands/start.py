"""``openagentd`` (default) — launch the API server in the background."""

from __future__ import annotations

import argparse
import getpass
import os
import subprocess

from app.cli.net import require_loopback_or_auth, server_addresses
from app.cli.paths import _ROOT, _server_log
from app.cli.pids import _find_pids, _write_pids
from app.cli.server import _server_cmd
from app.cli.ui import _bold, _dim, _print_banner, _yellow
from app.core.runtime_settings import ServerSettings
from app.core.server_settings import load_server_settings, save_server_settings


_API_PORT = 4082


def _resolve_port(port: int | None) -> int:
    """Pick the API port when the user didn't pass ``--port`` explicitly."""
    if port is not None:
        return port
    return load_server_settings().port or _API_PORT


def _resolve_host(args: argparse.Namespace) -> str:
    if getattr(args, "lan", False):
        return "0.0.0.0"
    if getattr(args, "host", None):
        return args.host
    return load_server_settings().host


def _prompt_access_key() -> str:
    key = getpass.getpass("OpenAgentd LAN access key: ").strip()
    if not key:
        raise SystemExit("LAN access key cannot be empty.")
    return key


def _apply_server_overrides(args: argparse.Namespace, cfg: ServerSettings) -> None:
    """Apply explicit CLI overrides in memory so they can be validated first."""
    if getattr(args, "lan", False):
        cfg.host = "0.0.0.0"
    elif args.host:
        cfg.host = args.host
    if args.port:
        cfg.port = args.port
    if getattr(args, "key", False):
        cfg.access_key = _prompt_access_key()


def _save_server_overrides(args: argparse.Namespace, cfg: ServerSettings) -> None:
    if not (
        getattr(args, "lan", False)
        or args.host
        or args.port
        or getattr(args, "key", False)
    ):
        return
    save_server_settings(cfg)


def cmd_start(args: argparse.Namespace) -> None:
    # Bail early if a server is already running — no point prompting the
    # user for init questions only to refuse to start. ``_find_pids`` only
    # returns when at least one PID is still alive.
    if _find_pids():
        print(f"  {_yellow('already running')}  (run {_bold('openagentd stop')} first)")
        return

    server_settings = load_server_settings()
    _apply_server_overrides(args, server_settings)
    port = _resolve_port(args.port)
    host = _resolve_host(args)
    require_loopback_or_auth(
        host=host,
        has_auth=bool(
            os.environ.get("OPENAGENTD_DESKTOP_TOKEN")
            or os.environ.get("OPENAGENTD_ACCESS_KEY")
            or server_settings.access_key
        ),
    )
    _save_server_overrides(args, server_settings)
    args.port = port
    args.host = host

    srv_log = _server_log()

    _print_banner(host=args.host, port=args.port)

    srv_log.parent.mkdir(parents=True, exist_ok=True)

    env = {**os.environ, "APP_ENV": "production"}
    if server_settings.access_key and not env.get("OPENAGENTD_ACCESS_KEY"):
        env["OPENAGENTD_ACCESS_KEY"] = server_settings.access_key

    with open(srv_log, "a") as srv_f:
        server = subprocess.Popen(
            _server_cmd(host=args.host, port=args.port),
            cwd=_ROOT,
            env=env,
            stdout=srv_f,
            stderr=srv_f,
            start_new_session=True,
        )

    _write_pids([server.pid])
    print(f"  {_dim('Logs:')}  {srv_log}")
    addresses = server_addresses(host=args.host, port=args.port)
    if addresses.lan:
        print(f"  {_dim('LAN:')}   {_bold(addresses.lan[0])}")
        print(f"  {_dim('Mobile:')} use the LAN address in the mobile app")
    print(f"  {_dim('Stop:')}  {_bold('openagentd stop')}")
    print()

    if getattr(args, "wait", False) or getattr(args, "watch", False):
        import urllib.request
        import urllib.error
        import time
        from app.cli.ui import _green, _red

        poll_host = "127.0.0.1" if args.host in {"0.0.0.0", "::"} else args.host
        ready_url = f"http://{poll_host}:{args.port}/api/health/ready"

        print(f"  {_dim('Status:')} waiting for server to become ready...")
        start_time = time.monotonic()
        max_wait = 30.0
        started = False

        while time.monotonic() - start_time < max_wait:
            if server.poll() is not None:
                print(f"  {_bold(_red('error'))}: server process died unexpectedly")
                break

            try:
                with urllib.request.urlopen(ready_url, timeout=1.0) as resp:
                    if resp.status == 200:
                        started = True
                        break
            except OSError:
                pass  # server not up yet — poll again
            time.sleep(0.5)

        if started:
            elapsed = time.monotonic() - start_time
            print(
                f"  {_dim('Status:')} {_green('started and ready')} (took {elapsed:.2f}s)"
            )
            print()
        else:
            print(
                f"  {_bold(_yellow('warning'))}: server did not become ready within {max_wait}s (check logs)"
            )
            print()
