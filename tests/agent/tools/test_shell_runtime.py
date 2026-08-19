"""Tests for app/agent/tools/builtin/shell_runtime.py."""

from __future__ import annotations

import pytest

from app.agent.tools.builtin import shell_runtime


@pytest.fixture(autouse=True)
def _reset_cache():
    shell_runtime.reset_cache()
    yield
    shell_runtime.reset_cache()


def test_build_argv_zsh_uses_login_and_sources_rc_files():
    """zsh argv passes -l, sources ~/.zshenv and ~/.zshrc, and evals the command."""
    argv = shell_runtime.build_argv("/bin/zsh", "echo hi")

    assert argv[0] == "-l"
    assert argv[1] == "-c"
    wrapper = argv[2]
    assert "~/.zshenv" in wrapper
    assert ".zshrc" in wrapper
    assert 'eval "$1"' in wrapper
    # argv[3] is $0, argv[4] is $1 — the user's command
    assert argv[3] == "openagentd"
    assert argv[4] == "echo hi"


def test_build_argv_zsh_disables_history_after_sourcing_rc():
    """zsh wrapper neutralizes HISTFILE after rc sourcing so agent commands
    never leak into the user's real shell history, regardless of what the
    user's ~/.zshrc configures (e.g. history plugins/hooks)."""
    argv = shell_runtime.build_argv("/bin/zsh", "echo hi")
    wrapper = argv[2]

    # Must come after rc sourcing (so PATH/aliases still load) but before eval.
    rc_index = wrapper.index(".zshrc")
    hist_index = wrapper.index("unset HISTFILE")
    eval_index = wrapper.index('eval "$1"')
    assert rc_index < hist_index < eval_index
    assert "HISTSIZE=0" in wrapper
    assert "SAVEHIST=0" in wrapper


def test_build_argv_bash_uses_login_and_sources_bashrc():
    """bash argv passes -l, enables alias expansion, sources ~/.bashrc."""
    argv = shell_runtime.build_argv("/bin/bash", "ls -la")

    assert argv[0] == "-l"
    assert argv[1] == "-c"
    wrapper = argv[2]
    assert "shopt -s expand_aliases" in wrapper
    assert "~/.bashrc" in wrapper
    assert 'eval "$1"' in wrapper
    assert argv[3] == "openagentd"
    assert argv[4] == "ls -la"


def test_build_argv_bash_disables_history_after_sourcing_rc():
    """bash wrapper neutralizes HISTFILE after rc sourcing for the same
    isolation guarantee as zsh."""
    argv = shell_runtime.build_argv("/bin/bash", "ls -la")
    wrapper = argv[2]

    rc_index = wrapper.index(".bashrc")
    hist_index = wrapper.index("unset HISTFILE")
    eval_index = wrapper.index('eval "$1"')
    assert rc_index < hist_index < eval_index
    assert "HISTSIZE=0" in wrapper
    assert "set +o history" in wrapper


def test_build_argv_sh_uses_bare_c():
    """Plain POSIX sh has no rc file convention — bare -c is correct."""
    argv = shell_runtime.build_argv("/bin/sh", "echo hi")
    assert argv == ["-c", "echo hi"]


def test_build_argv_dash_uses_bare_c():
    argv = shell_runtime.build_argv("/usr/bin/dash", "echo hi")
    assert argv == ["-c", "echo hi"]


def test_build_argv_powershell_uses_noninteractive_command():
    argv = shell_runtime.build_argv(
        r"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        "Get-ChildItem",
    )
    assert argv == [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-ChildItem",
    ]


def test_build_argv_cmd_uses_safe_command_flags():
    assert shell_runtime.build_argv("cmd.exe", "dir") == ["/d", "/s", "/c", "dir"]


@pytest.mark.parametrize("shell", ["pwsh", "powershell.exe", "cmd.exe"])
def test_windows_build_argv_preserves_complex_command_as_one_argument(shell):
    command = 'echo "hello world" | findstr "world"'

    assert shell_runtime.build_argv(shell, command)[-1] == command


def test_windows_fallback_prefers_powershell(monkeypatch):
    monkeypatch.setattr(shell_runtime.sys, "platform", "win32")
    monkeypatch.setattr(
        shell_runtime,
        "_which",
        lambda name: rf"C:\\Tools\\{name}.exe" if name == "pwsh" else None,
    )

    assert shell_runtime._fallback() == r"C:\\Tools\\pwsh.exe"


def test_windows_fallback_prefers_windows_powershell_over_cmd(monkeypatch):
    monkeypatch.setattr(shell_runtime.sys, "platform", "win32")
    available = {
        "powershell": r"C:\\Windows\\System32\\WindowsPowerShell\\powershell.exe",
        "cmd": r"C:\\Windows\\System32\\cmd.exe",
    }
    monkeypatch.setattr(shell_runtime, "_which", available.get)

    assert shell_runtime._fallback() == available["powershell"]


def test_windows_fallback_uses_cmd_executable_when_path_lookup_fails(monkeypatch):
    monkeypatch.setattr(shell_runtime.sys, "platform", "win32")
    monkeypatch.setattr(shell_runtime, "_which", lambda _name: None)

    assert shell_runtime._fallback() == "cmd.exe"


def test_windows_shell_name_handles_backslash_paths():
    assert (
        shell_runtime.name(
            r"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
        )
        == "powershell"
    )


def test_windows_detection_ignores_posix_shell_environment(monkeypatch):
    monkeypatch.setattr(shell_runtime.sys, "platform", "win32")
    monkeypatch.setenv("SHELL", "/bin/bash")
    monkeypatch.setattr(
        shell_runtime,
        "_which",
        lambda name: r"C:\\Windows\\System32\\cmd.exe" if name == "cmd" else None,
    )

    assert shell_runtime.acceptable() == r"C:\\Windows\\System32\\cmd.exe"


def test_build_argv_preserves_command_quoting_unchanged():
    """The command is passed as a single argv element — quoting is the shell's job via eval."""
    cmd = """echo 'hello world' && echo "$HOME" """
    argv = shell_runtime.build_argv("/bin/zsh", cmd)
    assert argv[-1] == cmd
