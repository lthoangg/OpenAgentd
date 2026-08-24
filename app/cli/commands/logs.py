"""``openagentd server logs`` — tail the server log file."""

from __future__ import annotations

import argparse
import os
import sys

from app.cli.paths import _server_log
from app.cli.ui import _bold


def cmd_logs(args: argparse.Namespace) -> None:
    log = _server_log()
    if log.exists():
        os.execvp("tail", ["tail", f"-n{args.lines}", "-f", str(log)])
    print(
        f"  No log file found. Start the server with {_bold('openagentd')} first.",
        file=sys.stderr,
    )
    sys.exit(1)
