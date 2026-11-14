"""The one-command installer (root ``install.sh``) names what it installs.

Each case runs the real script with fake ``uname`` (and friends) first on
PATH and a ``curl`` that always fails, so nothing is downloaded or
installed: a machine the script accepts stops at "failed to download", one
it refuses stops earlier with its own message.
"""

from __future__ import annotations

import os
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "install.sh"


def _fake(bin_dir: Path, name: str, body: str) -> None:
    path = bin_dir / name
    path.write_text(f"#!/bin/sh\n{body}\n")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


def _run(
    tmp_path: Path,
    system: str,
    machine: str,
    *args: str,
    apt: bool = True,
    shell: str = "/bin/zsh",
    path_has_install_dir: bool = False,
) -> subprocess.CompletedProcess[str]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    _fake(bin_dir, "uname", f'case "$1" in -m) echo {machine} ;; *) echo {system} ;; esac')
    # Not an Apple Silicon Mac running the shell under Rosetta.
    _fake(bin_dir, "sysctl", "echo 0")
    _fake(bin_dir, "ldd", "echo 'ldd (GNU libc) 2.39'")
    _fake(bin_dir, "brew", "exit 1")
    _fake(bin_dir, "curl", "exit 22")
    path = f"{bin_dir}:/usr/bin:/bin"
    if apt:
        _fake(bin_dir, "apt-get", "exit 0")
    else:
        # A host with apt-get (CI's Ubuntu) must not lend its own: only the
        # few tools the script needs before that check are on PATH.
        for tool in ("mktemp", "rm", "tar"):
            real = shutil.which(tool)
            assert real, tool
            (bin_dir / tool).symlink_to(real)
        path = str(bin_dir)
    install_dir = tmp_path / "install"
    if path_has_install_dir:
        path = f"{install_dir}:{path}"
    env = {
        "PATH": path,
        "HOME": str(tmp_path),
        "SHELL": shell,
        "OPENAGENTD_INSTALL_DIR": str(install_dir),
        "OPENAGENTD_RELEASES_URL": "http://127.0.0.1:9/releases",
    }
    return subprocess.run(
        ["/bin/sh", str(SCRIPT), "--version", "9.9.9", *args],
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
    )


def _accepted(proc: subprocess.CompletedProcess[str]) -> bool:
    assert proc.returncode != 0, proc.stdout
    return "failed to download" in proc.stderr


def _usage() -> dict[str, str]:
    out = subprocess.run(
        ["sh", str(SCRIPT), "--help"], capture_output=True, text=True, timeout=30
    ).stdout
    lines = {}
    for line in out.splitlines():
        for label in ("Desktop app:", "CLI:"):
            if line.strip().startswith(label):
                lines[label] = line.split(label, 1)[1].lower()
    assert set(lines) == {"Desktop app:", "CLI:"}, out
    return lines


# (uname -s, uname -m) and the words the usage text uses for that machine.
MACHINES = [
    ("Darwin", "arm64", "apple silicon"),
    ("Darwin", "x86_64", "intel"),
    ("Linux", "x86_64", "x86_64"),
    ("Linux", "aarch64", "arm64"),
]


@pytest.mark.parametrize("system, machine, words", MACHINES)
def test_the_usage_text_lists_a_machine_only_when_the_cli_installs_on_it(
    tmp_path: Path, system: str, machine: str, words: str
):
    accepted = _accepted(_run(tmp_path, system, machine, "--cli"))
    assert (words in _usage()["CLI:"]) == accepted


@pytest.mark.parametrize("system, machine, words", MACHINES)
def test_the_usage_text_lists_a_machine_only_when_the_desktop_app_installs_on_it(
    tmp_path: Path, system: str, machine: str, words: str
):
    accepted = _accepted(_run(tmp_path, system, machine))
    assert (words in _usage()["Desktop app:"]) == accepted


@pytest.mark.parametrize(
    "system, machine, args",
    [
        ("Darwin", "x86_64", ["--cli"]),
        ("Darwin", "x86_64", []),
        ("Linux", "aarch64", ["--cli"]),
        ("Linux", "aarch64", []),
    ],
)
def test_a_machine_with_no_release_is_told_how_to_build_one(
    tmp_path: Path, system: str, machine: str, args: list[str]
):
    proc = _run(tmp_path, system, machine, *args)
    assert not _accepted(proc)
    assert "CONTRIBUTING.md" in proc.stderr


def test_linux_without_apt_is_pointed_to_the_cli(tmp_path: Path):
    proc = _run(tmp_path, "Linux", "x86_64", apt=False)
    assert not _accepted(proc)
    assert "--cli" in proc.stderr


def test_the_header_comment_agrees_with_the_usage_text():
    header = SCRIPT.read_text().split("set -eu", 1)[0].lower()
    assert "x86_64/arm64" not in header
    assert "arm64/x86_64" not in header


@pytest.mark.parametrize(
    "shell, system, rc",
    [
        ("/bin/zsh", "Darwin", "~/.zshrc"),
        ("/bin/bash", "Darwin", "~/.bash_profile"),
        ("/usr/bin/bash", "Linux", "~/.bashrc"),
        ("/usr/bin/fish", "Linux", "~/.profile"),
    ],
)
def test_the_path_hint_names_the_file_the_shell_reads(shell: str, system: str, rc: str):
    """``shell_rc`` alone: the hint prints only after a real install."""
    text = SCRIPT.read_text()
    start = text.index("shell_rc() {")
    function = text[start : text.index("\n}\n", start) + 3]
    proc = subprocess.run(
        ["sh", "-c", f'uname() {{ echo {system}; }}\n{function}\nshell_rc'],
        capture_output=True,
        text=True,
        env={"SHELL": shell, "PATH": os.environ["PATH"]},
        timeout=30,
    )
    assert proc.stdout == rc, proc.stderr


def test_the_next_step_does_not_pass_a_flag_start_no_longer_needs():
    assert "server start --wait" not in SCRIPT.read_text()
