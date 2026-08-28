"""``openagentd server status`` — report whether the background server runs."""

from __future__ import annotations

import argparse

from app.cli.net import resolve_host, resolve_port, server_addresses
from app.cli.paths import _server_log
from app.cli.pids import _find_pids
from app.cli.ui import _bold, _cyan, _dim, _green, _yellow
from app.core.version import VERSION


def cmd_status(_args: argparse.Namespace) -> None:
    alive = _find_pids()
    port = resolve_port(getattr(_args, "port", None))
    bind_host = resolve_host(_args)
    addresses = server_addresses(host=bind_host, port=port)
    print()
    print(f"  {_bold(_cyan('OpenAgentd server'))}")
    print(f"  {_dim('Version:')} v{VERSION}")
    print()
    if alive:
        print(
            f"  {_dim('Status:')} {_green('running')}  pids: {', '.join(str(p) for p in alive)}"
        )
        print(f"  {_dim('Local:')}  {_bold(addresses.local)}")
        if addresses.lan:
            for index, url in enumerate(addresses.lan):
                label = "LAN:" if index == 0 else ""
                print(f"  {_dim(label):<6}  {_green(url)}")
            if bind_host in {"0.0.0.0", "::"}:
                print(f"  {_dim('Mobile:')} use the LAN address in the mobile app")
        print(f"  {_dim('Logs:')}   {_server_log()}")
    else:
        print(f"  {_dim('Status:')} {_yellow('stopped')}")
        print(
            f"  {_dim('Start:')}  {_bold('openagentd server start')}  or  "
            f"{_bold('openagentd server start --host 0.0.0.0')}"
        )
    print()
