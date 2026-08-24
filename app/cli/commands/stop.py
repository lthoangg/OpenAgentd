"""``openagentd server stop`` — terminate the background server."""

from __future__ import annotations

import argparse
import os
import signal
import time

from app.cli.pids import _clear_pids, _find_pids, _pid_alive
from app.cli.ui import _green, _yellow


def cmd_stop(_args: argparse.Namespace) -> None:
    pids = _find_pids()
    alive = [p for p in pids if _pid_alive(p)]
    if not alive:
        print(f"  {_yellow('not running')}")
        return
    for pid in alive:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    deadline = time.monotonic() + 5
    while any(_pid_alive(p) for p in alive):
        if time.monotonic() > deadline:
            for pid in alive:
                try:
                    os.kill(pid, signal.SIGKILL)
                except OSError:
                    pass
            break
        time.sleep(0.2)
    _clear_pids()
    print(f"  {_green('stopped')}")
