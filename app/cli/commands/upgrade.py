"""``openagentd upgrade`` — self-upgrade.

Detection order (first match wins):
1. Homebrew  — executable lives under a Cellar or opt path, or ``brew`` lists it.
2. uv tool   — ``uv`` is on PATH and the tool is in uv's tool environment.
3. pipx      — ``pipx`` is on PATH.
4. pip       — fallback through the current Python interpreter.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

from app.cli.commands.stop import cmd_stop
from app.cli.pids import _find_pids
from app.cli.ui import _bold, _cyan, _dim


def _is_brew_managed() -> bool:
    """Return True when the running executable is inside a Homebrew prefix."""
    try:
        exe = Path(sys.executable).resolve()
        brew = shutil.which("brew")
        if not brew:
            return False
        # Fast path: path contains Cellar or opt (works for both Intel and Apple Silicon).
        parts = exe.parts
        if "Cellar" in parts or ("Homebrew" in parts and "opt" in parts):
            return True
        # Slow path: ask brew directly (spawns a subprocess but only as a fallback).
        result = subprocess.run(
            [brew, "list", "--formula", "openagentd"],
            capture_output=True,
            timeout=5,
        )
        return result.returncode == 0
    except Exception:
        return False


def _is_uv_tool_managed() -> bool:
    """Return True when uv is available and openagentd is a uv tool."""
    uv = shutil.which("uv")
    if not uv:
        return False
    try:
        result = subprocess.run(
            [uv, "tool", "list"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        return "openagentd" in result.stdout
    except Exception:
        return False


def _is_pipx_managed() -> bool:
    """Return True when pipx is available and openagentd is a pipx package."""
    pipx = shutil.which("pipx")
    if not pipx:
        return False
    try:
        result = subprocess.run(
            [pipx, "list", "--short"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        return "openagentd" in result.stdout
    except Exception:
        return False


def _upgrade_command() -> tuple[str, list[str]]:
    if _is_brew_managed():
        return "brew", ["brew", "upgrade", "--formula", "lthoangg/tap/openagentd"]
    if _is_uv_tool_managed():
        return "uv tool", ["uv", "tool", "upgrade", "openagentd"]
    if _is_pipx_managed():
        return "pipx", ["pipx", "upgrade", "openagentd"]
    return "pip", [sys.executable, "-m", "pip", "install", "--upgrade", "openagentd"]


def _pre_upgrade_commands(manager: str) -> list[list[str]]:
    if manager == "brew":
        return [["brew", "update"]]
    return []


def _restart_command(args: argparse.Namespace) -> list[str]:
    executable = shutil.which("openagentd")
    if executable is None and sys.argv:
        candidate = Path(sys.argv[0])
        if candidate.is_file():
            executable = str(candidate)
    if executable is None:
        executable = "openagentd"
    command = [executable]
    if getattr(args, "lan", False):
        command.append("--lan")
    elif getattr(args, "host", None):
        command.extend(["--host", args.host])
    if getattr(args, "port", None) is not None:
        command.extend(["--port", str(args.port)])
    command.append("start")
    return command


def _run(command: list[str]) -> int:
    return subprocess.run(command).returncode


def _post_upgrade_command(manager: str) -> list[str] | None:
    if manager == "brew":
        return ["brew", "link", "lthoangg/tap/openagentd"]
    return None


def cmd_upgrade(args: argparse.Namespace) -> None:
    """Upgrade openagentd to the latest version."""
    was_running = bool(_find_pids())
    if was_running:
        print(f"  {_bold('Stopping openagentd')} before upgrade ...")
        cmd_stop(args)

    manager, command = _upgrade_command()
    print(f"  {_bold('Upgrading openagentd')} via {_cyan(manager)} ...")
    upgrade_code = 0
    for pre_upgrade in _pre_upgrade_commands(manager):
        print(f"  {_dim(' '.join(pre_upgrade))}")
        upgrade_code = _run(pre_upgrade)
        if upgrade_code != 0:
            break
    if upgrade_code == 0:
        print(f"  {_dim(' '.join(command))}")
        upgrade_code = _run(command)
    if upgrade_code == 0:
        post_upgrade = _post_upgrade_command(manager)
        if post_upgrade is not None:
            print(f"  {_dim(' '.join(post_upgrade))}")
            upgrade_code = _run(post_upgrade)

    restart_code = 0
    if was_running:
        restart = _restart_command(args)
        if upgrade_code == 0:
            print(f"  {_bold('Restarting openagentd')} ...")
        else:
            print(f"  {_bold('Restarting openagentd')} after failed upgrade ...")
        print(f"  {_dim(' '.join(restart))}")
        restart_code = _run(restart)

    if upgrade_code != 0:
        raise SystemExit(upgrade_code)
    if restart_code != 0:
        raise SystemExit(restart_code)
