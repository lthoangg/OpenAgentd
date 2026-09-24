"""End-of-life notice for the v2 (Python) CLI.

v2 is replaced by the native v3 binary, which is not published to PyPI. The
last 2.x release prints this notice so uv/pipx/pip installs learn how to move
over; they would otherwise stay on the final 2.x forever. Homebrew users are
moved to v3 by ``brew upgrade`` because the formula switches to v3 binaries.
"""

from __future__ import annotations

import os
import sys
from typing import TextIO

REPO_RAW = "https://raw.githubusercontent.com/lthoangg/openagentd/main"
INSTALL_UNIX = f"curl -LsSf {REPO_RAW}/install.sh | sh -s -- --cli"
INSTALL_WINDOWS = f"& ([scriptblock]::Create((irm {REPO_RAW}/install.ps1))) -Cli"
HIDE_ENV = "OPENAGENTD_HIDE_V2_NOTICE"


def notice_lines(manager: str | None = None) -> list[str]:
    """The notice text. ``manager`` is the detected installer, if known."""
    install = INSTALL_WINDOWS if os.name == "nt" else INSTALL_UNIX
    lines = [
        "OpenAgentd v2 (Python) is no longer supported and will receive no further updates.",
        "OpenAgentd v3 is a single native binary that uses the same data, config and plugins",
        "(v2 .py plugins need a .ts/.js port).",
        "Switch with: openagentd upgrade",
        f"or install v3 directly (removes a uv/pipx v2 install): {install}",
    ]
    if manager == "brew":
        lines.append(
            "Homebrew installs move to v3 with `brew upgrade openagentd` as well."
        )
    elif manager == "pip":
        lines.append(
            f"Then remove the pip copy: {sys.executable} -m pip uninstall -y openagentd"
        )
    lines.append(f"Set {HIDE_ENV}=1 to hide this notice.")
    return lines


def print_notice(
    stream: TextIO | None = None, *, manager: str | None = None, force: bool = False
) -> bool:
    """Print the notice to stderr for interactive use; returns whether it printed.

    Non-TTY stderr (the desktop sidecar, daemons, pipes) is skipped unless
    ``force`` so logs and machine-read output stay unchanged.
    """
    out = stream if stream is not None else sys.stderr
    if os.environ.get(HIDE_ENV):
        return False
    if not force and not (hasattr(out, "isatty") and out.isatty()):
        return False
    body = "\n".join(f"  {line}" for line in notice_lines(manager))
    print(f"\n{body}\n", file=out)
    return True
