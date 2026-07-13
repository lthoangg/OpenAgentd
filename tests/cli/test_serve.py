"""Tests for app/cli/commands/serve.py — desktop-shell entry point.

These tests cover the *non-blocking* surface area: argument parsing,
the handshake JSON format, and the parent-death helpers. Actually
spawning uvicorn is left to integration testing (scripts/build_sidecar.py
runs a real smoke test at bundle time).
"""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import time
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app.cli.commands.serve import (
    _configure_desktop_token,
    _emit_handshake,
    _pid_alive,
    _server_port,
    cmd_serve,
)
from app.cli.main import build_parser


class TestParserWiring:
    def test_serve_subcommand_exists(self):
        parser = build_parser()
        args = parser.parse_args(["serve"])
        assert args.command == "serve"
        # Defaults: dynamic port, no handshake unless asked.
        assert args.port == 0
        assert args.handshake is False
        assert args.generate_token is False
        assert args.parent_pid is None

    def test_serve_accepts_all_flags(self):
        parser = build_parser()
        args = parser.parse_args(
            [
                "serve",
                "--host",
                "127.0.0.1",
                "--port",
                "0",
                "--handshake",
                "--generate-token",
                "--parent-pid",
                "12345",
            ]
        )
        assert args.host == "127.0.0.1"
        assert args.handshake is True
        assert args.generate_token is True
        assert args.parent_pid == 12345


class TestServerPort:
    def test_reads_uvicorn_bound_port(self):
        sock = SimpleNamespace(getsockname=lambda: ("127.0.0.1", 54321))
        uvicorn_server = SimpleNamespace(servers=[SimpleNamespace(sockets=[sock])])

        assert _server_port(uvicorn_server, fallback=0) == 54321

    def test_falls_back_when_socket_unavailable(self):
        uvicorn_server = SimpleNamespace(servers=[])

        assert _server_port(uvicorn_server, fallback=8000) == 8000

    def test_ignores_non_tcp_socket_address(self):
        sock = SimpleNamespace(getsockname=lambda: "not-a-tcp-address")
        uvicorn_server = SimpleNamespace(servers=[SimpleNamespace(sockets=[sock])])

        assert _server_port(uvicorn_server, fallback=8000) == 8000


class TestHandshakeFormat:
    def test_handshake_is_single_json_line_with_prefix(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            _emit_handshake(port=12345, token="tok", version="0.0.1")
        output = buf.getvalue()
        # Exactly one line.
        assert output.count("\n") == 1
        # Marker prefix the Tauri side greps for.
        assert output.startswith("OPENAGENTD_HANDSHAKE ")
        # Parsable JSON after the prefix.
        payload = json.loads(output.removeprefix("OPENAGENTD_HANDSHAKE ").strip())
        assert payload["port"] == 12345
        assert payload["token"] == "tok"
        assert payload["version"] == "0.0.1"
        assert payload["pid"] == os.getpid()

    def test_handshake_omits_token_when_none(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            _emit_handshake(port=1, token=None, version="0")
        payload = json.loads(
            buf.getvalue().removeprefix("OPENAGENTD_HANDSHAKE ").strip()
        )
        assert "token" not in payload


class TestDesktopTokenConfig:
    def test_reuses_existing_desktop_token(self, monkeypatch):
        monkeypatch.setenv("OPENAGENTD_DESKTOP_TOKEN", "existing-token")

        assert _configure_desktop_token(False) == "existing-token"

    def test_empty_existing_desktop_token_is_ignored(self, monkeypatch):
        monkeypatch.setenv("OPENAGENTD_DESKTOP_TOKEN", "")

        assert _configure_desktop_token(False) is None

    def test_generate_desktop_token_sets_env(self, monkeypatch):
        original_token = os.environ.get("OPENAGENTD_DESKTOP_TOKEN")
        monkeypatch.delenv("OPENAGENTD_DESKTOP_TOKEN", raising=False)

        try:
            token = _configure_desktop_token(True)

            assert token
            assert os.environ["OPENAGENTD_DESKTOP_TOKEN"] == token
        finally:
            if original_token is None:
                os.environ.pop("OPENAGENTD_DESKTOP_TOKEN", None)
            else:
                os.environ["OPENAGENTD_DESKTOP_TOKEN"] = original_token


class TestBindAuthPolicy:
    def test_non_loopback_host_without_key_refuses_before_uvicorn_starts(
        self, monkeypatch
    ):
        monkeypatch.delenv("OPENAGENTD_DESKTOP_TOKEN", raising=False)
        monkeypatch.delenv("OPENAGENTD_ACCESS_KEY", raising=False)
        args = SimpleNamespace(
            host="0.0.0.0",
            port=0,
            handshake=False,
            generate_token=False,
            parent_pid=None,
        )

        with (
            patch("app.cli.commands.serve.load_server_settings") as server_settings,
            patch("uvicorn.Config") as config,
            pytest.raises(SystemExit, match="--key.*access key"),
        ):
            server_settings.return_value.access_key = None
            cmd_serve(args)

        config.assert_not_called()


class TestPidAlive:
    def test_current_process_is_alive(self):
        assert _pid_alive(os.getpid()) is True

    def test_unlikely_pid_is_dead(self):
        # Probabilistically not in use; if it is, the test is flaky but
        # not in a way that matters for this assertion's intent.
        assert _pid_alive(2_147_483_640) is False

    def test_live_external_child_is_alive_without_being_killed(self):
        """``_pid_alive`` must not kill the process it probes.

        ``os.kill(pid, 0)`` is a no-op signal on POSIX (existence check),
        which is what we rely on.  Regression coverage in case the probe
        ever gets replaced with something more invasive.
        """
        proc = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(30)"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            # Give the child a beat to actually be schedulable.
            time.sleep(0.1)
            assert _pid_alive(proc.pid) is True
            # The probe must not have killed the child.  ``poll()`` returns
            # None while the process is still running.
            time.sleep(0.1)
            assert proc.poll() is None, "_pid_alive killed the target process"
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)

    def test_exited_child_is_dead(self):
        """``_pid_alive`` must return False once the target has exited."""
        proc = subprocess.Popen(
            [sys.executable, "-c", "import sys; sys.exit(0)"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        proc.wait(timeout=5)
        # Small grace period for the OS to reflect the exit.
        time.sleep(0.1)
        assert _pid_alive(proc.pid) is False
