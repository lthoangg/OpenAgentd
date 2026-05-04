"""Tests for app/cli/ package — CLI argument parsing and command handlers.

Covers: _state_dir/_data_dir/_config_dir, _read_pids/_write_pids,
_find_pids, _pid_alive, build_parser, cmd_version, cmd_status,
cmd_stop, cmd_logs.

Excluded intentionally:
- cmd_start: spawns real subprocesses and blocks — integration territory.
- _c / color helpers: pure formatting, zero logic.

Patch targets follow Python name-lookup semantics: each ``cmd_*`` function
imports its dependencies directly (``from app.cli.pids import _pid_alive``),
so tests must patch the submodule that owns the name, not the package.
"""

from __future__ import annotations

import os
import signal
from pathlib import Path
from unittest.mock import patch

import pytest

import app.cli as cli
from app.cli import (
    _config_dir,
    _data_dir,
    _find_pids,
    _pid_alive,
    _pid_file,
    _read_pids,
    _state_dir,
    _write_pids,
    build_parser,
    cmd_logs,
    cmd_status,
    cmd_stop,
    cmd_version,
)


# ---------------------------------------------------------------------------
# XDG dir resolvers
# ---------------------------------------------------------------------------


class TestXdgDirs:
    def test_state_env_var_overrides_all(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OPENAGENTD_STATE_DIR", str(tmp_path))
        assert _state_dir(dev=False) == tmp_path
        assert _state_dir(dev=True) == tmp_path

    def test_data_env_var_overrides_all(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OPENAGENTD_DATA_DIR", str(tmp_path))
        assert _data_dir(dev=False) == tmp_path
        assert _data_dir(dev=True) == tmp_path

    def test_config_env_var_overrides_all(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OPENAGENTD_CONFIG_DIR", str(tmp_path))
        assert _config_dir(dev=False) == tmp_path
        assert _config_dir(dev=True) == tmp_path

    def test_dev_mode_state_is_project_local(self, monkeypatch):
        monkeypatch.delenv("OPENAGENTD_STATE_DIR", raising=False)
        assert _state_dir(dev=True) == Path(".openagentd") / "state"

    def test_dev_mode_data_is_project_local(self, monkeypatch):
        monkeypatch.delenv("OPENAGENTD_DATA_DIR", raising=False)
        assert _data_dir(dev=True) == Path(".openagentd") / "data"

    def test_dev_mode_config_is_project_local(self, monkeypatch):
        monkeypatch.delenv("OPENAGENTD_CONFIG_DIR", raising=False)
        assert _config_dir(dev=True) == Path(".openagentd") / "config"

    def test_prod_mode_state_is_xdg_state(self, monkeypatch):
        monkeypatch.delenv("OPENAGENTD_STATE_DIR", raising=False)
        assert _state_dir(dev=False) == Path.home() / ".local" / "state" / "openagentd"

    def test_prod_mode_data_is_xdg_data(self, monkeypatch):
        monkeypatch.delenv("OPENAGENTD_DATA_DIR", raising=False)
        assert _data_dir(dev=False) == Path.home() / ".local" / "share" / "openagentd"

    def test_prod_mode_config_is_xdg_config(self, monkeypatch):
        monkeypatch.delenv("OPENAGENTD_CONFIG_DIR", raising=False)
        assert _config_dir(dev=False) == Path.home() / ".config" / "openagentd"


# ---------------------------------------------------------------------------
# _write_pids / _read_pids
# ---------------------------------------------------------------------------


class TestPidFileIO:
    def test_write_and_read_pids(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OPENAGENTD_STATE_DIR", str(tmp_path))
        _write_pids([1234, 5678], dev=False)
        assert _read_pids(dev=False) == [1234, 5678]

    def test_read_pids_missing_file_returns_empty(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OPENAGENTD_STATE_DIR", str(tmp_path))
        assert _read_pids(dev=False) == []

    def test_read_pids_corrupt_file_returns_empty(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OPENAGENTD_STATE_DIR", str(tmp_path))
        _write_pids([999], dev=False)
        # Corrupt the file with non-integer content
        _pid_file(dev=False).write_text("not-a-pid\n")
        assert _read_pids(dev=False) == []

    def test_read_pids_ignores_blank_lines(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OPENAGENTD_STATE_DIR", str(tmp_path))
        _pid_file(dev=False).parent.mkdir(parents=True, exist_ok=True)
        _pid_file(dev=False).write_text("111\n\n222\n")
        assert _read_pids(dev=False) == [111, 222]

    def test_write_pids_creates_parent_dirs(self, tmp_path, monkeypatch):
        target = tmp_path / "deep" / "nested"
        monkeypatch.setenv("OPENAGENTD_STATE_DIR", str(target))
        _write_pids([42], dev=False)
        assert _pid_file(dev=False).exists()


# ---------------------------------------------------------------------------
# _pid_alive
# ---------------------------------------------------------------------------


class TestPidAlive:
    def test_own_pid_is_alive(self):
        assert _pid_alive(os.getpid()) is True

    def test_nonexistent_pid_is_not_alive(self):
        # PID 0 always raises OSError on kill(0, 0) with EPERM/EINVAL
        # Use a very high PID that is almost certainly not running
        assert _pid_alive(9_999_999) is False


# ---------------------------------------------------------------------------
# _find_pids
# ---------------------------------------------------------------------------


class TestFindPids:
    def test_find_pids_returns_empty_when_no_file(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OPENAGENTD_STATE_DIR", str(tmp_path))
        pids, dev = _find_pids()
        assert pids == []

    def test_find_pids_returns_alive_pids(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OPENAGENTD_STATE_DIR", str(tmp_path))
        own = os.getpid()
        _write_pids([own], dev=False)
        pids, dev = _find_pids()
        assert own in pids

    def test_find_pids_skips_dead_pids(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OPENAGENTD_STATE_DIR", str(tmp_path))
        _write_pids([9_999_999], dev=False)
        pids, _ = _find_pids()
        assert pids == []


# ---------------------------------------------------------------------------
# build_parser
# ---------------------------------------------------------------------------


class TestBuildParser:
    def test_default_command_is_start(self):
        parser = build_parser()
        args = parser.parse_args([])
        assert args.func is cli.cmd_start

    def test_dev_flag(self):
        parser = build_parser()
        args = parser.parse_args(["--dev"])
        assert args.dev is True

    def test_host_default(self):
        args = build_parser().parse_args([])
        assert args.host == "127.0.0.1"

    def test_port_default(self):
        # ``--port`` parses as ``None`` (sentinel) so cmd_start can pick
        # 8000 in --dev or 4082 otherwise. See app/cli/commands/start.py.
        args = build_parser().parse_args([])
        assert args.port is None

    def test_web_port_default(self):
        args = build_parser().parse_args([])
        assert args.web_port == 5173

    def test_custom_host_and_port(self):
        args = build_parser().parse_args(["--host", "0.0.0.0", "--port", "9000"])
        assert args.host == "0.0.0.0"
        assert args.port == 9000

    def test_stop_subcommand(self):
        args = build_parser().parse_args(["stop"])
        assert args.func is cli.cmd_stop

    def test_status_subcommand(self):
        args = build_parser().parse_args(["status"])
        assert args.func is cli.cmd_status

    def test_logs_subcommand_defaults(self):
        args = build_parser().parse_args(["logs"])
        assert args.func is cli.cmd_logs
        assert args.lines == 50

    def test_logs_subcommand_custom_lines(self):
        args = build_parser().parse_args(["logs", "-n", "200"])
        assert args.lines == 200

    def test_version_subcommand(self):
        args = build_parser().parse_args(["version"])
        assert args.func is cli.cmd_version

    def test_doctor_subcommand(self):
        args = build_parser().parse_args(["doctor"])
        assert args.func is cli.cmd_doctor

    def test_migrate_openclaw_subcommand(self):
        args = build_parser().parse_args(
            ["migrate", "openclaw", "--model", "openai:gpt-5.5"]
        )
        assert args.func is cli.cmd_migrate
        assert args.source == "openclaw"
        assert args.from_dir is None
        assert args.model == "openai:gpt-5.5"

    def test_migrate_hermes_subcommand(self):
        args = build_parser().parse_args(
            ["migrate", "hermes", "--model", "openai:gpt-5.5"]
        )
        assert args.func is cli.cmd_migrate
        assert args.source == "hermes"
        assert args.from_dir is None
        assert args.model == "openai:gpt-5.5"

    def test_update_subcommand(self):
        args = build_parser().parse_args(["update"])
        assert args.func is cli.cmd_update


# ---------------------------------------------------------------------------
# cmd_version
# ---------------------------------------------------------------------------


class TestCmdVersion:
    def test_prints_version(self, capsys):
        args = build_parser().parse_args(["version"])
        cmd_version(args)
        out = capsys.readouterr().out
        assert "openagentd" in out
        assert "v" in out


# ---------------------------------------------------------------------------
# cmd_status
# ---------------------------------------------------------------------------


class TestCmdStatus:
    def test_running_shows_pids(self, capsys, tmp_path, monkeypatch):
        monkeypatch.setenv("OPENAGENTD_STATE_DIR", str(tmp_path))
        own = os.getpid()
        _write_pids([own], dev=False)

        args = build_parser().parse_args(["status"])
        cmd_status(args)
        out = capsys.readouterr().out
        assert str(own) in out

    def test_not_running_shows_stopped(self, capsys, tmp_path, monkeypatch):
        monkeypatch.setenv("OPENAGENTD_STATE_DIR", str(tmp_path))
        # No PID file → nothing running
        args = build_parser().parse_args(["status"])
        cmd_status(args)
        out = capsys.readouterr().out
        assert "stopped" in out


# ---------------------------------------------------------------------------
# cmd_stop
# ---------------------------------------------------------------------------


class TestCmdStop:
    def test_not_running_prints_message(self, capsys, tmp_path, monkeypatch):
        monkeypatch.setenv("OPENAGENTD_STATE_DIR", str(tmp_path))
        args = build_parser().parse_args(["stop"])
        cmd_stop(args)
        out = capsys.readouterr().out
        assert "not running" in out

    def test_stop_sends_sigterm(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OPENAGENTD_STATE_DIR", str(tmp_path))
        own = os.getpid()
        _write_pids([own], dev=False)

        killed: list[tuple[int, int]] = []

        def fake_kill(pid: int, sig: int) -> None:
            killed.append((pid, sig))

        # ``_pid_alive`` is referenced from two modules after the split:
        #   * ``app.cli.pids._find_pids`` (to discover running pids)
        #   * ``app.cli.commands.stop.cmd_stop`` (the SIGTERM loop)
        # Return True until a SIGTERM has been recorded, then False — so the
        # while-loop exits once the signal has been delivered.
        def alive_fn(_pid: int) -> bool:
            return not any(sig == signal.SIGTERM for _, sig in killed)

        with (
            patch("app.cli.commands.stop._pid_alive", side_effect=alive_fn),
            patch("app.cli.pids._pid_alive", side_effect=alive_fn),
        ):
            monkeypatch.setattr(os, "kill", fake_kill)
            args = build_parser().parse_args(["stop"])
            cmd_stop(args)

        assert (own, signal.SIGTERM) in killed

    def test_stop_sigkill_on_timeout(self, tmp_path, monkeypatch):
        """If process doesn't die within deadline, SIGKILL is sent."""
        monkeypatch.setenv("OPENAGENTD_STATE_DIR", str(tmp_path))
        own = os.getpid()
        _write_pids([own], dev=False)

        killed: list[tuple[int, int]] = []

        def fake_kill(pid: int, sig: int) -> None:
            killed.append((pid, sig))

        monkeypatch.setattr(os, "kill", fake_kill)

        # monotonic: first call sets deadline (returns 0), second call
        # is the loop check (returns 999) → 999 > 0+5 → deadline exceeded → SIGKILL
        monotonic_values = iter([0.0, 999.0])

        import app.cli.commands.stop as stop_mod

        with (
            # Both ``_find_pids`` (pids module) and the kill loop (stop module)
            # must see the process as alive.
            patch("app.cli.commands.stop._pid_alive", return_value=True),
            patch("app.cli.pids._pid_alive", return_value=True),
            patch.object(stop_mod.time, "monotonic", side_effect=monotonic_values),
            patch.object(stop_mod.time, "sleep"),
        ):
            args = build_parser().parse_args(["stop"])
            cmd_stop(args)

        assert (own, signal.SIGKILL) in killed


# ---------------------------------------------------------------------------
# cmd_logs
# ---------------------------------------------------------------------------


class TestCmdLogs:
    def test_logs_execs_tail_when_log_exists(self, tmp_path, monkeypatch):
        log = tmp_path / "app.log"
        log.write_text("some log content\n")

        execvp_calls: list[tuple[str, list[str]]] = []

        def fake_execvp(prog: str, argv: list[str]) -> None:
            # Real execvp replaces the process — raise SystemExit to stop execution
            execvp_calls.append((prog, argv))
            raise SystemExit(0)

        import app.cli.commands.logs as logs_mod

        with (
            patch.object(logs_mod.os, "execvp", fake_execvp),
            patch(
                "app.cli.commands.logs._server_log",
                side_effect=lambda dev: log if not dev else tmp_path / "no.log",
            ),
        ):
            args = build_parser().parse_args(["logs", "-n", "100"])
            with pytest.raises(SystemExit):
                cmd_logs(args)

        assert len(execvp_calls) == 1
        prog, argv = execvp_calls[0]
        assert prog == "tail"
        assert "-n100" in argv
        assert str(log) in argv

    def test_logs_exits_when_no_log_file(self, tmp_path, monkeypatch, capsys):
        with patch(
            "app.cli.commands.logs._server_log", return_value=tmp_path / "no.log"
        ):
            args = build_parser().parse_args(["logs"])
            with pytest.raises(SystemExit) as exc_info:
                cmd_logs(args)
        assert exc_info.value.code == 1
        assert "No log file" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# cmd_doctor
# ---------------------------------------------------------------------------


class TestCmdDoctor:
    """Doctor exits 0 on a healthy host and 1 when any check fails.

    The tests below set ``OPENAI_API_KEY`` so the API-key check passes;
    without it, doctor would correctly fail and the test would have to
    catch ``SystemExit``. Tests that *do* want to assert the error path
    explicitly drop the env var first.
    """

    @pytest.fixture
    def _healthy_env(self, monkeypatch, tmp_path):
        """Set up a host where every required check passes.

        Doctor reads from the configured ``OPENAGENTD_CONFIG_DIR`` (set to
        ``.tests/config`` by ``pytest.ini``); we redirect it to a tmp
        path here so we can drop a stub ``openagentd.md`` without polluting
        the shared test config dir.
        """
        from tests.conftest import set_openagentd_dirs

        set_openagentd_dirs(monkeypatch, tmp_path)
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

        agents = tmp_path / "config" / "agents"
        agents.mkdir(parents=True)
        (agents / "openagentd.md").write_text(
            "---\nname: openagentd\nmodel: openai:gpt-5\n---\n"
        )
        return tmp_path

    def test_doctor_runs_without_error(self, capsys, _healthy_env):
        """Doctor exits 0 and prints a summary on a healthy host."""
        args = build_parser().parse_args(["doctor"])
        # May still SystemExit(0) — doctor only exits on errors. Catch
        # SystemExit so a future "always exit" change wouldn't silently
        # break this test.
        try:
            cli.cmd_doctor(args)
        except SystemExit as exc:
            assert exc.code in (None, 0), f"doctor failed:\n{capsys.readouterr().out}"
        out = capsys.readouterr().out
        assert "passed" in out

    def test_doctor_detects_python_version(self, capsys, _healthy_env):
        args = build_parser().parse_args(["doctor"])
        try:
            cli.cmd_doctor(args)
        except SystemExit:
            pass
        out = capsys.readouterr().out
        assert "Python" in out

    def test_doctor_exits_nonzero_when_no_api_key(self, capsys, monkeypatch, tmp_path):
        """No provider key set → exit 1 so CI / install scripts fail loud."""
        from app.cli.commands.doctor import _LLM_API_KEY_VARS
        from tests.conftest import set_openagentd_dirs

        # Provide a real agent dir with a non-OAuth provider so doctor can
        # resolve the provider and then correctly fail on the missing key.
        set_openagentd_dirs(monkeypatch, tmp_path)
        agents = tmp_path / "config" / "agents"
        agents.mkdir(parents=True)
        (agents / "openagentd.md").write_text(
            "---\nname: openagentd\nmodel: openai:gpt-4o\n---\n"
        )

        for key in _LLM_API_KEY_VARS:
            monkeypatch.delenv(key, raising=False)

        args = build_parser().parse_args(["doctor"])
        with pytest.raises(SystemExit) as exc:
            cli.cmd_doctor(args)
        assert exc.value.code == 1
        out = capsys.readouterr().out
        assert "No LLM provider API key" in out

    def test_doctor_warns_when_provider_key_mismatches_lead_agent(
        self, capsys, monkeypatch, tmp_path
    ):
        """Lead uses ``openai:`` but only ``GOOGLE_API_KEY`` is set → fail."""
        from app.cli.commands.doctor import _LLM_API_KEY_VARS
        from tests.conftest import set_openagentd_dirs

        set_openagentd_dirs(monkeypatch, tmp_path)
        for key in _LLM_API_KEY_VARS:
            monkeypatch.delenv(key, raising=False)
        monkeypatch.setenv("GOOGLE_API_KEY", "abc")  # wrong provider for lead

        agents = tmp_path / "config" / "agents"
        agents.mkdir(parents=True)
        (agents / "openagentd.md").write_text(
            "---\nname: openagentd\nmodel: openai:gpt-5\n---\n"
        )

        args = build_parser().parse_args(["doctor"])
        with pytest.raises(SystemExit) as exc:
            cli.cmd_doctor(args)
        assert exc.value.code == 1
        out = capsys.readouterr().out
        assert "Lead agent uses 'openai'" in out


# ---------------------------------------------------------------------------
# _resolve_port — picks the API port default per mode
# ---------------------------------------------------------------------------


class TestResolvePort:
    """``--port`` parses as ``None`` so we can tell user-supplied apart
    from default. Resolution flips the default between dev (8000, to
    match Vite's ``/api → :8000`` proxy) and prod (4082, the bundled
    single-process default). An explicit port always wins.
    """

    def test_dev_default_is_8000(self):
        from app.cli.commands.start import _resolve_port

        assert _resolve_port(None, dev=True) == 8000

    def test_prod_default_is_4082(self):
        from app.cli.commands.start import _resolve_port

        assert _resolve_port(None, dev=False) == 4082

    def test_explicit_port_wins_in_dev(self):
        from app.cli.commands.start import _resolve_port

        assert _resolve_port(9000, dev=True) == 9000

    def test_explicit_port_wins_in_prod(self):
        from app.cli.commands.start import _resolve_port

        assert _resolve_port(9000, dev=False) == 9000


# ---------------------------------------------------------------------------
# _server_cmd — uvicorn argv builder
# ---------------------------------------------------------------------------


class TestServerCmd:
    """The ``--dev`` flag should reload only on edits under ``app/``.

    Earlier versions also watched the on-disk config tree so editing an
    agent ``.md`` file triggered a reload, but the agent itself writes
    there, which caused restart storms during normal use. Config edits
    in dev now require a manual restart — matching prod behaviour.
    """

    def test_prod_argv_has_no_reload_flags(self):
        from app.cli.server import _server_cmd

        cmd = _server_cmd(host="127.0.0.1", port=4082, dev=False)
        assert "--reload" not in cmd
        assert "--reload-dir" not in cmd
        assert "--reload-include" not in cmd

    def test_dev_argv_watches_app_source(self):
        from app.cli.server import _server_cmd

        cmd = _server_cmd(host="127.0.0.1", port=4082, dev=True)
        assert "--reload" in cmd
        # ``--reload-dir`` precedes ``app`` — pair them positionally.
        idx = cmd.index("--reload-dir")
        assert cmd[idx + 1] == "app"

    def test_dev_argv_does_not_watch_config_dir(self, tmp_path, monkeypatch):
        """Even when OPENAGENTD_CONFIG_DIR points at an existing directory,
        the dev argv must not add it as a second ``--reload-dir`` — that
        coupling caused reload storms when the agent wrote to its own
        config tree."""
        from app.cli.server import _server_cmd

        cfg = tmp_path / "cfg"
        cfg.mkdir()
        monkeypatch.setenv("OPENAGENTD_CONFIG_DIR", str(cfg))

        cmd = _server_cmd(host="127.0.0.1", port=4082, dev=True)
        reload_dirs = [cmd[i + 1] for i, x in enumerate(cmd) if x == "--reload-dir"]
        # ``app`` is the only watched directory.
        assert reload_dirs == ["app"]
        assert str(cfg) not in reload_dirs

    def test_dev_argv_emits_no_reload_include_filters(self):
        """With only ``app/`` watched, ``--reload-include`` filters are
        unnecessary — uvicorn's default ``*.py`` covers the source tree."""
        from app.cli.server import _server_cmd

        cmd = _server_cmd(host="127.0.0.1", port=4082, dev=True)
        assert "--reload-include" not in cmd
