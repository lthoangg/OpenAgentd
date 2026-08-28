"""``openagentd server health`` — server-focused diagnostics."""

from __future__ import annotations

import argparse
import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

from app.cli.net import (
    display_host,
    is_port_reachable,
    resolve_host,
    resolve_port,
    server_addresses,
)
from app.cli.paths import _server_log
from app.cli.pids import _find_pids
from app.cli.ui import _bold, _cyan, _dim, _green, _red, _yellow


@dataclass(frozen=True)
class Check:
    name: str
    status: str
    detail: str


def _fetch_json(url: str, *, timeout: float = 2.0) -> tuple[int, dict[str, Any] | None]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            body = response.read().decode("utf-8")
            return response.status, json.loads(body) if body else None
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8")
        try:
            payload = json.loads(body) if body else None
        except json.JSONDecodeError:
            payload = None
        return exc.code, payload
    except (OSError, json.JSONDecodeError):
        return 0, None


def _check_line(check: Check) -> str:
    marker = {
        "ok": _green("✓"),
        "warn": _yellow("⚠"),
        "fail": _red("✗"),
    }[check.status]
    return f"  {marker}  {_bold(check.name)}  {_dim(check.detail)}"


def cmd_health(args: argparse.Namespace) -> None:
    """Run server diagnostics for desktop/mobile clients."""
    port = resolve_port(getattr(args, "port", None))
    bind_host = resolve_host(args)
    host = display_host(bind_host)
    addresses = server_addresses(host=bind_host, port=port)
    alive = _find_pids()
    base_url = f"http://{host}:{port}"

    checks: list[Check] = []
    if alive:
        checks.append(
            Check("Process", "ok", f"running; pid {', '.join(map(str, alive))}")
        )
    else:
        checks.append(Check("Process", "fail", "not running"))

    if is_port_reachable(host=host, port=port):
        checks.append(Check("Port", "ok", f"{host}:{port} accepts connections"))
    else:
        checks.append(Check("Port", "fail", f"{host}:{port} is not reachable"))

    live_status, live_payload = _fetch_json(f"{base_url}/api/health/live")
    if live_status == 200:
        version = live_payload.get("version") if live_payload else None
        detail = f"live endpoint ok{f' · v{version}' if version else ''}"
        checks.append(Check("API live", "ok", detail))
    else:
        checks.append(Check("API live", "fail", "no healthy /api/health/live response"))

    ready_status, ready_payload = _fetch_json(f"{base_url}/api/health/ready")
    if ready_status == 200:
        checks.append(Check("API ready", "ok", "database and runtime checks passed"))
    elif ready_status:
        detail = "readiness degraded"
        if ready_payload:
            detail = json.dumps(ready_payload, sort_keys=True)
        checks.append(Check("API ready", "warn", detail))
    else:
        checks.append(Check("API ready", "fail", "no /api/health/ready response"))

    if bind_host == "0.0.0.0":
        if addresses.lan:
            checks.append(Check("LAN binding", "ok", ", ".join(addresses.lan)))
        else:
            checks.append(
                Check(
                    "LAN binding",
                    "warn",
                    "bound to all interfaces, but no LAN IP was detected",
                )
            )
    else:
        checks.append(
            Check(
                "LAN binding",
                "warn",
                "local-only; use openagentd server start --host 0.0.0.0 for mobile",
            )
        )

    print()
    print(f"  {_bold(_cyan('OpenAgentd server health'))}")
    print()
    print(f"  {_dim('Local:')}  {_bold(addresses.local)}")
    if addresses.lan:
        print(f"  {_dim('LAN:')}    {_green(addresses.lan[0])}")
    print(f"  {_dim('Logs:')}   {_server_log()}")
    print()
    for check in checks:
        print(_check_line(check))
    print()

    failures = sum(1 for check in checks if check.status == "fail")
    warnings = sum(1 for check in checks if check.status == "warn")
    if failures:
        print(
            f"  {_red(f'{failures} failed')}, {_yellow(f'{warnings} warning(s)')}"
            if warnings
            else f"  {_red(f'{failures} failed')}"
        )
        raise SystemExit(1)
    if warnings:
        print(f"  {_green('healthy')}, {_yellow(f'{warnings} warning(s)')}")
    else:
        print(f"  {_green('healthy')}")
    print()
