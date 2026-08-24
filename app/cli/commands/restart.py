"""``openagentd server restart`` — restart the background server."""

from __future__ import annotations

import argparse

from app.cli.commands.start import cmd_start
from app.cli.commands.stop import cmd_stop
from app.cli.pids import _find_pids
from app.cli.ui import _bold, _cyan, _green, _yellow


def cmd_restart(args: argparse.Namespace) -> None:
    """Restart the background server."""
    print()
    print(f"  {_bold(_cyan('Restarting OpenAgentd'))}")
    print()
    if _find_pids():
        cmd_stop(args)
    else:
        print(f"  {_yellow('not running')}  starting fresh")
    cmd_start(args)
    print(f"  {_green('restart complete')}")
