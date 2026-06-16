"""``openagentd status`` — report whether a background openagentd is running."""

from __future__ import annotations

import argparse

from app.cli.commands.start import _resolve_host, _resolve_port
from app.cli.net import server_addresses
from app.cli.paths import _server_log
from app.cli.pids import _find_pids, _pid_alive
from app.cli.ui import _bold, _cyan, _dim, _green, _yellow
from app.core.version import VERSION


def cmd_status(_args: argparse.Namespace) -> None:
    pids = _find_pids()
    alive = [p for p in pids if _pid_alive(p)]
    port = _resolve_port(_args.port)
    addresses = server_addresses(host=_resolve_host(_args), port=port)
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
            print(f"  {_dim('LAN:')}    {_green(addresses.lan[0])}")
        print(f"  {_dim('Logs:')}   {_server_log()}")
    else:
        print(f"  {_dim('Status:')} {_yellow('stopped')}")
        print(
            f"  {_dim('Start:')}  {_bold('openagentd start')}  or  {_bold('openagentd start --lan')}"
        )
    print()
