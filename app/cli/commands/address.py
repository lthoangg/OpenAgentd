"""``openagentd server address`` — print local and LAN server URLs."""

from __future__ import annotations

import argparse

from app.cli.commands.start import _resolve_host, _resolve_port
from app.cli.net import server_addresses
from app.cli.pids import _find_pids
from app.cli.ui import _bold, _cyan, _dim, _green, _yellow


def cmd_address(args: argparse.Namespace) -> None:
    """Show addresses desktop and mobile clients can use."""
    port = _resolve_port(args.port)
    host = _resolve_host(args)
    addresses = server_addresses(host=host, port=port)
    running = bool(_find_pids())

    print()
    print(f"  {_bold(_cyan('OpenAgentd addresses'))}")
    print()
    print(f"  {_dim('Status:')} {'running' if running else _yellow('not running')}")
    print(f"  {_dim('Local:')}  {_bold(addresses.local)}")
    if addresses.lan:
        for index, url in enumerate(addresses.lan):
            label = "LAN:" if index == 0 else ""
            print(f"  {_dim(label):<6}  {_green(url)}")
    else:
        print(f"  {_dim('LAN:')}    {_yellow('no LAN address detected')}")
    print()
    print(
        f"  {_dim('Mobile:')} start with {_bold('openagentd server start --lan')} to bind on your network"
    )
    print()
