"""``openagentd upgrade`` — self-upgrade.

Detection order (first match wins):
1. Homebrew  — executable lives under a Cellar or opt path, or ``brew`` lists it.
2. uv tool   — ``uv`` is on PATH and the tool is in uv's tool environment.
3. pipx      — ``pipx`` is on PATH.
4. pip       — fallback through the current Python interpreter.

v2 is end-of-life: Homebrew moves to v3 through ``brew upgrade`` (the formula
ships the v3 binary), and uv/pipx/pip installs are migrated to v3 by running
the v3 installer (``install.sh --cli`` / ``install.ps1 -Cli``), which removes
the uv/pipx package itself. A pip install is removed here afterwards.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

from app.cli.commands.stop import cmd_stop
from app.cli.pids import _find_pids
from app.cli.sunset import REPO_RAW, print_notice
from app.cli.ui import _bold, _cyan, _dim

# Overrides the installer URL (tests point it at a local copy).
INSTALLER_URL_ENV = "OPENAGENTD_INSTALLER_URL"
_IS_WINDOWS = os.name == "nt"


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
    command = [executable, "server", "start"]
    if getattr(args, "host", None):
        command.extend(["--host", args.host])
    if getattr(args, "port", None) is not None:
        command.extend(["--port", str(args.port)])
    return command


def _run(command: list[str]) -> int:
    return subprocess.run(command).returncode


def _post_upgrade_command(manager: str) -> list[str] | None:
    return None


def _installer_url() -> str:
    name = "install.ps1" if _IS_WINDOWS else "install.sh"
    return os.environ.get(INSTALLER_URL_ENV) or f"{REPO_RAW}/{name}"


def _download_installer() -> Path:
    """Fetch the v3 installer to a temp file (``file://`` works for tests)."""
    suffix = ".ps1" if _IS_WINDOWS else ".sh"
    fd, name = tempfile.mkstemp(prefix="openagentd-install-", suffix=suffix)
    with (
        os.fdopen(fd, "wb") as out,
        urllib.request.urlopen(_installer_url(), timeout=60) as resp,
    ):
        out.write(resp.read())
    return Path(name)


def _migration_commands(manager: str, installer: Path) -> list[list[str]]:
    commands = [["sh", str(installer), "--cli"]]
    if manager == "pip":
        commands.append([sys.executable, "-m", "pip", "uninstall", "-y", "openagentd"])
    return commands


def _ps_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _spawn_windows_migration(manager: str, installer: Path) -> None:
    """Run the installer in a new console once this process has exited.

    Windows locks the running ``openagentd.exe`` shim, so uv/pipx/pip cannot
    remove v2 while this command is still alive.
    """
    script = f"Start-Sleep -Seconds 3; & {_ps_quote(str(installer))} -Cli"
    if manager == "pip":
        script += f"; if ($?) {{ & {_ps_quote(sys.executable)} -m pip uninstall -y openagentd }}"
    script += "; Read-Host 'Press Enter to close'"
    subprocess.Popen(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
        creationflags=getattr(subprocess, "CREATE_NEW_CONSOLE", 0),
    )


def _migrate_to_v3(manager: str) -> tuple[int, bool]:
    """Install v3 in place of this v2 install. Returns (exit code, restart ok).

    Everything this command still needs is imported at module load: the
    installer uninstalls the package this process runs from.
    """
    print(
        f"  {_bold('Switching to OpenAgentd v3')} (native binary; same data and config) ..."
    )
    try:
        installer = _download_installer()
    except Exception as exc:
        print(f"  Could not download the v3 installer: {exc}")
        return 1, True
    if _IS_WINDOWS:
        _spawn_windows_migration(manager, installer)
        print("  The v3 installer continues in a new window once this command exits.")
        print(
            f"  Afterwards, run {_cyan('openagentd server start')} if you use the background server."
        )
        return 0, False
    try:
        for command in _migration_commands(manager, installer):
            print(f"  {_dim(' '.join(command))}")
            code = _run(command)
            if code != 0:
                return code, True
        return 0, True
    finally:
        installer.unlink(missing_ok=True)


def cmd_upgrade(args: argparse.Namespace) -> None:
    """Upgrade openagentd to the latest version."""
    was_running = bool(_find_pids())
    if was_running:
        print(f"  {_bold('Stopping openagentd')} before upgrade ...")
        cmd_stop(args)

    manager, command = _upgrade_command()
    print(f"  {_bold('Upgrading openagentd')} via {_cyan(manager)} ...")
    upgrade_code = 0
    migrated = manager != "brew"
    can_restart = True
    if migrated:
        upgrade_code, can_restart = _migrate_to_v3(manager)
    else:
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
    if was_running and can_restart:
        restart = _restart_command(args)
        if upgrade_code == 0:
            print(f"  {_bold('Restarting openagentd')} ...")
        else:
            print(f"  {_bold('Restarting openagentd')} after failed upgrade ...")
        print(f"  {_dim(' '.join(restart))}")
        restart_code = _run(restart)

    if upgrade_code != 0:
        if migrated:
            print_notice(sys.stdout, manager=manager, force=True)
        raise SystemExit(upgrade_code)
    if restart_code != 0:
        raise SystemExit(restart_code)
