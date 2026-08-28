"""``openagentd server stop`` — terminate the background server."""

from __future__ import annotations

import argparse
import os
import signal
import time

from app.cli.pids import _clear_pids, _find_pids, _pid_alive
from app.cli.ui import _green, _yellow


def _kill_pid(pid: int, sig: signal.Signals) -> None:
    if hasattr(os, "killpg") and hasattr(os, "getpgid"):
        try:
            pgid = os.getpgid(pid)
            if pgid == pid:
                os.killpg(pgid, sig)
                return
        except OSError:
            pass
    try:
        os.kill(pid, sig)
    except OSError:
        pass


def cmd_stop(_args: argparse.Namespace) -> None:
    alive = _find_pids()
    if not alive:
        print(f"  {_yellow('not running')}")
        return
    for pid in alive:
        _kill_pid(pid, signal.SIGTERM)
    deadline = time.monotonic() + 5.0
    while any(_pid_alive(p) for p in alive):
        if time.monotonic() > deadline:
            for pid in alive:
                if _pid_alive(pid):
                    _kill_pid(pid, signal.SIGKILL)
            break
        time.sleep(0.1)
    _clear_pids()
    print(f"  {_green('stopped')}")
