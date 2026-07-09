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
import sys
from pathlib import Path
from unittest.mock import Mock, patch

import pytest
from sqlalchemy.exc import OperationalError

import app.cli as cli
from app.cli.net import ServerAddresses
from app.cli.net import _lan_ips
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
    cmd_address,
    cmd_health,
    cmd_logs,
    cmd_cleanup,
    cmd_restart,
    cmd_status,
    cmd_stop,
    cmd_version,
)


# ---------------------------------------------------------------------------
# XDG dir resolvers
# ---------------------------------------------------------------------------


class TestXdgDirs:
    def test_state_env_var_overrides(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OPENAGENTD_STATE_DIR", str(tmp_path))
        assert _state_dir() == tmp_path

    def test_data_env_var_overrides(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OPENAGENTD_DATA_DIR", str(tmp_path))
        assert _data_dir() == tmp_path

    def test_config_env_var_overrides(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OPENAGENTD_CONFIG_DIR", str(tmp_path))
        assert _config_dir() == tmp_path

    def test_state_default_is_xdg_state(self, monkeypatch):
        monkeypatch.delenv("OPENAGENTD_STATE_DIR", raising=False)
        assert _state_dir() == Path.home() / ".local" / "state" / "openagentd"

    def test_data_default_is_xdg_data(self, monkeypatch):
        monkeypatch.delenv("OPENAGENTD_DATA_DIR", raising=False)
        assert _data_dir() == Path.home() / ".local" / "share" / "openagentd"

    def test_config_default_is_xdg_config(self, monkeypatch):
        monkeypatch.delenv("OPENAGENTD_CONFIG_DIR", raising=False)
        assert _config_dir() == Path.home() / ".config" / "openagentd"


# ---------------------------------------------------------------------------
# _write_pids / _read_pids
# ---------------------------------------------------------------------------


class TestPidFileIO:
    def test_write_and_read_pids(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OPENAGENTD_STATE_DIR", str(tmp_path))
        _write_pids([1234, 5678])
        assert _read_pids() == [1234, 5678]

    def test_read_pids_missing_file_returns_empty(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OPENAGENTD_STATE_DIR", str(tmp_path))
        assert _read_pids() == []

    def test_read_pids_corrupt_file_returns_empty(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OPENAGENTD_STATE_DIR", str(tmp_path))
        _write_pids([999])
        # Corrupt the file with non-integer content
        _pid_file().write_text("not-a-pid\n")
        assert _read_pids() == []

    def test_read_pids_ignores_blank_lines(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OPENAGENTD_STATE_DIR", str(tmp_path))
        _pid_file().parent.mkdir(parents=True, exist_ok=True)
        _pid_file().write_text("111\n\n222\n")
        assert _read_pids() == [111, 222]

    def test_write_pids_creates_parent_dirs(self, tmp_path, monkeypatch):
        target = tmp_path / "deep" / "nested"
        monkeypatch.setenv("OPENAGENTD_STATE_DIR", str(target))
        _write_pids([42])
        assert _pid_file().exists()


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
# Network helpers
# ---------------------------------------------------------------------------


class TestLanIps:
    def test_udp_route_ip_is_listed_first(self, monkeypatch):
        class FakeSocket:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

            def connect(self, _addr):
                return None

            def getsockname(self):
                return ("10.4.28.34", 12345)

        monkeypatch.setattr("socket.socket", lambda *_args, **_kwargs: FakeSocket())
        monkeypatch.setattr("socket.gethostname", lambda: "host.local")
        monkeypatch.setattr(
            "socket.getaddrinfo",
            lambda *_args, **_kwargs: [
                (None, None, None, None, ("10.4.28.145", 0)),
                (None, None, None, None, ("10.4.28.34", 0)),
            ],
        )

        assert _lan_ips() == ["10.4.28.34", "10.4.28.145"]


# ---------------------------------------------------------------------------
# _find_pids
# ---------------------------------------------------------------------------


class TestFindPids:
    def test_find_pids_returns_empty_when_no_file(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OPENAGENTD_STATE_DIR", str(tmp_path))
        assert _find_pids() == []

    def test_find_pids_returns_alive_pids(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OPENAGENTD_STATE_DIR", str(tmp_path))
        own = os.getpid()
        _write_pids([own])
        assert own in _find_pids()

    def test_find_pids_skips_dead_pids(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OPENAGENTD_STATE_DIR", str(tmp_path))
        _write_pids([9_999_999])
        assert _find_pids() == []


# ---------------------------------------------------------------------------
# build_parser
# ---------------------------------------------------------------------------


class TestBuildParser:
    def test_default_command_is_start(self):
        parser = build_parser()
        args = parser.parse_args([])
        assert args.func is cli.cmd_start

    def test_start_subcommand_is_start(self):
        parser = build_parser()
        args = parser.parse_args(["start"])
        assert args.func is cli.cmd_start

    def test_host_default(self):
        args = build_parser().parse_args([])
        assert args.host is None

    def test_port_default(self):
        # ``--port`` parses as ``None`` (sentinel) so cmd_start applies the
        # 4082 default. See app/cli/commands/start.py.
        args = build_parser().parse_args([])
        assert args.port is None

    def test_custom_host_and_port(self):
        args = build_parser().parse_args(["--host", "0.0.0.0", "--port", "9000"])
        assert args.host == "0.0.0.0"
        assert args.port == 9000

    def test_lan_flag(self):
        args = build_parser().parse_args(["--lan", "start"])
        assert args.lan is True

    def test_wait_and_watch_flags(self):
        args = build_parser().parse_args(["start", "--wait"])
        assert args.wait is True

        args = build_parser().parse_args(["start", "--watch"])
        assert args.watch is True

        args = build_parser().parse_args(["restart", "--wait"])
        assert args.wait is True

    def test_stop_subcommand(self):
        args = build_parser().parse_args(["stop"])
        assert args.func is cli.cmd_stop

    def test_restart_subcommand(self):
        args = build_parser().parse_args(["restart"])
        assert args.func is cli.cmd_restart

    def test_status_subcommand(self):
        args = build_parser().parse_args(["status"])
        assert args.func is cli.cmd_status

    def test_address_subcommand(self):
        args = build_parser().parse_args(["address"])
        assert args.func is cli.cmd_address

    def test_health_subcommand(self):
        args = build_parser().parse_args(["health"])
        assert args.func is cli.cmd_health

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

    def test_cleanup_subcommand_defaults(self):
        args = build_parser().parse_args(["cleanup"])
        assert args.func is cli.cmd_cleanup
        assert args.older_than_days == 14
        assert args.dry_run is True
        assert args.limit == 50

    def test_cleanup_subcommand_apply(self):
        args = build_parser().parse_args(["cleanup", "--apply"])
        assert args.dry_run is False

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

    def test_upgrade_subcommand(self):
        args = build_parser().parse_args(["upgrade"])
        assert args.func is cli.cmd_upgrade

    def test_update_subcommand_removed(self):
        with pytest.raises(SystemExit):
            build_parser().parse_args(["update"])


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
        _write_pids([own])
        monkeypatch.setattr(
            "app.cli.commands.status.server_addresses",
            lambda **_kwargs: ServerAddresses(
                local="http://127.0.0.1:4082", lan=["http://192.168.1.2:4082"]
            ),
        )

        args = build_parser().parse_args(["status"])
        cmd_status(args)
        out = capsys.readouterr().out
        assert str(own) in out
        assert "OpenAgentd server" in out
        assert "Version:" in out
        assert "http://127.0.0.1:4082" in out
        assert "http://192.168.1.2:4082" in out

    def test_not_running_shows_stopped(self, capsys, tmp_path, monkeypatch):
        monkeypatch.setenv("OPENAGENTD_STATE_DIR", str(tmp_path))
        # No PID file → nothing running
        args = build_parser().parse_args(["status"])
        cmd_status(args)
        out = capsys.readouterr().out
        assert "stopped" in out
        assert "openagentd start --lan" in out


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
        _write_pids([own])

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
        _write_pids([own])

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
# cmd_restart
# ---------------------------------------------------------------------------


class TestCmdRestart:
    def test_restart_stops_when_running_then_starts(self, monkeypatch):
        import app.cli.commands.restart as restart_mod

        args = build_parser().parse_args(["restart"])
        calls: list[str] = []

        monkeypatch.setattr(restart_mod, "_find_pids", lambda: [1234])
        monkeypatch.setattr(restart_mod, "cmd_stop", lambda _args: calls.append("stop"))
        monkeypatch.setattr(
            restart_mod, "cmd_start", lambda _args: calls.append("start")
        )

        cmd_restart(args)

        assert calls == ["stop", "start"]

    def test_restart_starts_when_not_running(self, monkeypatch, capsys):
        import app.cli.commands.restart as restart_mod

        args = build_parser().parse_args(["restart"])
        calls: list[str] = []

        monkeypatch.setattr(restart_mod, "_find_pids", lambda: [])
        monkeypatch.setattr(restart_mod, "cmd_stop", lambda _args: calls.append("stop"))
        monkeypatch.setattr(
            restart_mod, "cmd_start", lambda _args: calls.append("start")
        )

        cmd_restart(args)

        assert calls == ["start"]
        assert "starting fresh" in capsys.readouterr().out


# ---------------------------------------------------------------------------
# cmd_upgrade
# ---------------------------------------------------------------------------


class TestCmdCleanup:
    def test_cleanup_handles_missing_chat_sessions_table(self, monkeypatch, capsys):
        from app.cli.commands import cleanup as cleanup_mod

        args = build_parser().parse_args(["cleanup"])

        class _OrigExc(Exception):
            pass

        error = OperationalError(
            "SELECT chat_sessions.id FROM chat_sessions",
            {},
            _OrigExc("no such table: chat_sessions"),
        )

        async def raise_missing_table(*_args, **_kwargs):
            raise error

        monkeypatch.setattr(
            cleanup_mod, "cleanup_generated_artifacts", raise_missing_table
        )

        cmd_cleanup(args)

        out = capsys.readouterr().out
        assert "Generated artifact cleanup" in out
        assert "Database not initialized yet" in out
        assert "No files deleted" in out


class TestMainEntrypoint:
    def test_main_forces_production_when_invoked_via_console_script(self, monkeypatch):
        import importlib

        main_mod = importlib.import_module("app.cli.main")

        parser = build_parser()
        seen: list[str | None] = []

        def fake_cmd(_args):
            seen.append(os.environ.get("APP_ENV"))

        args = parser.parse_args(["cleanup"])
        args.func = fake_cmd
        monkeypatch.setattr(parser, "parse_args", lambda: args)
        monkeypatch.setattr(main_mod, "build_parser", lambda: parser)
        monkeypatch.setattr(sys, "argv", ["openagentd", "cleanup"])

        monkeypatch.delenv("APP_ENV", raising=False)
        main_mod.main()

        assert seen == ["production"]


class TestCmdCleanupReporting:
    def test_cleanup_prints_expired_db_counts_when_no_path_candidates(
        self, monkeypatch, capsys
    ):
        from app.cli.commands import cleanup as cleanup_mod
        from app.services.artifact_cleanup import CleanupResult

        args = build_parser().parse_args(["cleanup", "--older-than-days", "10"])

        async def fake_cleanup_result(_args):
            return (
                CleanupResult(
                    dry_run=True,
                    candidates=[],
                    deleted=[],
                    expired_sessions=3,
                    expired_messages=12,
                ),
                None,
            )

        monkeypatch.setattr(cleanup_mod, "_cleanup_result", fake_cleanup_result)

        cmd_cleanup(args)

        out = capsys.readouterr().out
        assert "Expired sessions:" in out
        assert "3" in out
        assert "Expired messages:" in out
        assert "12" in out
        assert "Candidates:" in out
        assert "0" in out


class TestCmdUpgrade:
    def test_upgrade_runs_package_manager_without_restart(self, monkeypatch):
        from app.cli.commands import upgrade as upgrade_mod

        args = build_parser().parse_args(["upgrade"])
        run_calls: list[list[str]] = []

        monkeypatch.setattr(upgrade_mod, "_find_pids", lambda: [])
        monkeypatch.setattr(
            upgrade_mod,
            "_upgrade_command",
            lambda: ("uv tool", ["uv", "tool", "upgrade", "openagentd"]),
        )
        monkeypatch.setattr(
            upgrade_mod, "_run", lambda command: run_calls.append(command) or 0
        )

        upgrade_mod.cmd_upgrade(args)

        assert run_calls == [["uv", "tool", "upgrade", "openagentd"]]

    def test_brew_upgrade_does_not_relink_formula_without_restart(self, monkeypatch):
        from app.cli.commands import upgrade as upgrade_mod

        args = build_parser().parse_args(["upgrade"])
        run_calls: list[list[str]] = []

        monkeypatch.setattr(upgrade_mod, "_find_pids", lambda: [])
        monkeypatch.setattr(
            upgrade_mod,
            "_upgrade_command",
            lambda: (
                "brew",
                ["brew", "upgrade", "--formula", "lthoangg/tap/openagentd"],
            ),
        )
        monkeypatch.setattr(
            upgrade_mod, "_run", lambda command: run_calls.append(command) or 0
        )

        upgrade_mod.cmd_upgrade(args)

        assert run_calls == [
            ["brew", "update"],
            ["brew", "upgrade", "--formula", "lthoangg/tap/openagentd"],
        ]

    def test_upgrade_stops_and_restarts_when_running(self, monkeypatch):
        from app.cli.commands import upgrade as upgrade_mod

        args = build_parser().parse_args(
            ["--host", "0.0.0.0", "--port", "9000", "upgrade"]
        )
        stop = Mock()
        run_calls: list[list[str]] = []

        monkeypatch.setattr(upgrade_mod, "_find_pids", lambda: [1234])
        monkeypatch.setattr(upgrade_mod, "cmd_stop", stop)
        monkeypatch.setattr(
            upgrade_mod,
            "_upgrade_command",
            lambda: ("pipx", ["pipx", "upgrade", "openagentd"]),
        )
        monkeypatch.setattr(
            upgrade_mod.shutil, "which", lambda _name: "/usr/local/bin/openagentd"
        )
        monkeypatch.setattr(
            upgrade_mod, "_run", lambda command: run_calls.append(command) or 0
        )

        upgrade_mod.cmd_upgrade(args)

        stop.assert_called_once_with(args)
        assert run_calls == [
            ["pipx", "upgrade", "openagentd"],
            [
                "/usr/local/bin/openagentd",
                "--host",
                "0.0.0.0",
                "--port",
                "9000",
                "start",
            ],
        ]

    def test_upgrade_restart_preserves_lan_flag(self, monkeypatch):
        from app.cli.commands import upgrade as upgrade_mod

        args = build_parser().parse_args(["--lan", "upgrade"])
        run_calls: list[list[str]] = []

        monkeypatch.setattr(upgrade_mod, "_find_pids", lambda: [1234])
        monkeypatch.setattr(upgrade_mod, "cmd_stop", Mock())
        monkeypatch.setattr(
            upgrade_mod,
            "_upgrade_command",
            lambda: ("pipx", ["pipx", "upgrade", "openagentd"]),
        )
        monkeypatch.setattr(upgrade_mod.shutil, "which", lambda _name: "openagentd")
        monkeypatch.setattr(
            upgrade_mod, "_run", lambda command: run_calls.append(command) or 0
        )

        upgrade_mod.cmd_upgrade(args)

        assert run_calls[-1] == ["openagentd", "--lan", "start"]

    def test_upgrade_restart_falls_back_to_original_script_path(self, monkeypatch):
        from app.cli.commands import upgrade as upgrade_mod

        args = build_parser().parse_args(["upgrade"])
        run_calls: list[list[str]] = []

        monkeypatch.setattr(upgrade_mod, "_find_pids", lambda: [1234])
        monkeypatch.setattr(upgrade_mod, "cmd_stop", Mock())
        monkeypatch.setattr(
            upgrade_mod,
            "_upgrade_command",
            lambda: (
                "brew",
                ["brew", "upgrade", "--formula", "lthoangg/tap/openagentd"],
            ),
        )
        monkeypatch.setattr(upgrade_mod.shutil, "which", lambda _name: None)
        monkeypatch.setattr(upgrade_mod.sys, "argv", [__file__])
        monkeypatch.setattr(
            upgrade_mod, "_run", lambda command: run_calls.append(command) or 0
        )

        upgrade_mod.cmd_upgrade(args)

        assert run_calls == [
            ["brew", "update"],
            ["brew", "upgrade", "--formula", "lthoangg/tap/openagentd"],
            [__file__, "start"],
        ]

    def test_upgrade_exits_with_upgrade_failure_after_restart(self, monkeypatch):
        from app.cli.commands import upgrade as upgrade_mod

        args = build_parser().parse_args(["upgrade"])
        run_results = iter([7, 0])

        monkeypatch.setattr(upgrade_mod, "_find_pids", lambda: [1234])
        monkeypatch.setattr(upgrade_mod, "cmd_stop", Mock())
        monkeypatch.setattr(
            upgrade_mod,
            "_upgrade_command",
            lambda: ("pipx", ["pipx", "upgrade", "openagentd"]),
        )
        monkeypatch.setattr(upgrade_mod, "_run", lambda _command: next(run_results))

        with pytest.raises(SystemExit) as exc:
            upgrade_mod.cmd_upgrade(args)

        assert exc.value.code == 7


# ---------------------------------------------------------------------------
# cmd_address
# ---------------------------------------------------------------------------


class TestCmdAddress:
    def test_address_prints_local_and_lan_urls(self, monkeypatch, capsys):
        monkeypatch.setattr("app.cli.commands.address._find_pids", lambda: [1234])
        monkeypatch.setattr(
            "app.cli.commands.address.server_addresses",
            lambda **_kwargs: ServerAddresses(
                local="http://127.0.0.1:4082", lan=["http://192.168.1.2:4082"]
            ),
        )

        args = build_parser().parse_args(["address"])
        cmd_address(args)

        out = capsys.readouterr().out
        assert "OpenAgentd addresses" in out
        assert "running" in out
        assert "http://127.0.0.1:4082" in out
        assert "http://192.168.1.2:4082" in out


# ---------------------------------------------------------------------------
# cmd_health
# ---------------------------------------------------------------------------


class TestCmdHealth:
    def test_health_passes_for_reachable_ready_server(self, monkeypatch, capsys):
        monkeypatch.setattr("app.cli.commands.health._find_pids", lambda: [1234])
        monkeypatch.setattr("app.cli.commands.health._pid_alive", lambda _pid: True)
        monkeypatch.setattr(
            "app.cli.commands.health.is_port_reachable", lambda **_kwargs: True
        )
        monkeypatch.setattr(
            "app.cli.commands.health.server_addresses",
            lambda **_kwargs: ServerAddresses(
                local="http://127.0.0.1:4082", lan=["http://192.168.1.2:4082"]
            ),
        )

        def fake_fetch(url: str, *, timeout: float = 2.0):
            assert timeout == 2.0
            if url.endswith("/live"):
                return 200, {"version": "1.2.3"}
            return 200, {"status": "ok"}

        monkeypatch.setattr("app.cli.commands.health._fetch_json", fake_fetch)

        args = build_parser().parse_args(["--lan", "health"])
        cmd_health(args)

        out = capsys.readouterr().out
        assert "OpenAgentd server health" in out
        assert "Process" in out
        assert "API ready" in out
        assert "healthy" in out

    def test_health_exits_when_server_down(self, monkeypatch):
        monkeypatch.setattr("app.cli.commands.health._find_pids", lambda: [])
        monkeypatch.setattr(
            "app.cli.commands.health.is_port_reachable", lambda **_kwargs: False
        )
        monkeypatch.setattr(
            "app.cli.commands.health.server_addresses",
            lambda **_kwargs: ServerAddresses(local="http://127.0.0.1:4082", lan=[]),
        )
        monkeypatch.setattr(
            "app.cli.commands.health._fetch_json", lambda *_args: (0, None)
        )

        args = build_parser().parse_args(["health"])
        with pytest.raises(SystemExit) as exc:
            cmd_health(args)

        assert exc.value.code == 1


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
            patch("app.cli.commands.logs._server_log", return_value=log),
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
    from the 4082 default. An explicit port always wins.
    """

    def test_default_is_4082(self):
        from app.cli.commands.start import _resolve_port

        assert _resolve_port(None) == 4082

    def test_explicit_port_wins(self):
        from app.cli.commands.start import _resolve_port

        assert _resolve_port(9000) == 9000


# ---------------------------------------------------------------------------
# _server_cmd — uvicorn argv builder
# ---------------------------------------------------------------------------


class TestServerCmd:
    """``_server_cmd`` builds a plain uvicorn argv — no reload flags,
    since hot-reload now lives in ``make dev`` (not the CLI).
    """

    def test_argv_has_no_reload_flags(self):
        from app.cli.server import _server_cmd

        cmd = _server_cmd(host="127.0.0.1", port=4082)
        assert "--reload" not in cmd
        assert "--reload-dir" not in cmd
        assert "--reload-include" not in cmd

    def test_argv_includes_host_and_port(self):
        from app.cli.server import _server_cmd

        cmd = _server_cmd(host="0.0.0.0", port=9000)
        assert "--host" in cmd
        assert "0.0.0.0" in cmd
        assert "--port" in cmd
        assert "9000" in cmd
