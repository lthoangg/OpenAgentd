"""Static checks for managed development launch targets."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path


def _target_body(name: str) -> str:
    lines = Path("Makefile").read_text().splitlines()
    start = lines.index(next(line for line in lines if line.startswith(f"{name}:")))
    body: list[str] = []
    for line in lines[start + 1 :]:
        if line and not line.startswith(("\t", " ")):
            break
        body.append(line)
    return "\n".join(body)


def test_v3_dev_targets_keep_source_checkout_data_out_of_production():
    # The source-checkout targets pin development: an inherited
    # OPENAGENTD_ENV=production must not move them onto the installed app's
    # database.
    for name in ("run", "dev"):
        body = _target_body(name)
        assert "server serve" in body
        assert "OPENAGENTD_ENV=development cargo run" in body, name


def _dry_run(*args: str, env: dict[str, str] | None = None) -> str:
    return subprocess.run(
        ["make", "-n", *args],
        check=True,
        capture_output=True,
        text=True,
        env={**os.environ, **(env or {})},
    ).stdout


def test_dev_takes_its_ports_so_checkouts_can_run_side_by_side():
    out = _dry_run("dev", "PORT=8001", "WEB_PORT=5174")
    assert "server serve --port 8001" in out
    assert "nc -z 127.0.0.1 8001" in out
    assert "--port 5174 --strictPort" in out
    # Only this checkout's ports are stopped, never another checkout's.
    assert "for port in 8001 5174" in out
    assert "8000" not in out and "5173" not in out


def test_dev_ports_default_and_ignore_an_inherited_port():
    # PORT is a common environment variable; only the make command line sets it.
    out = _dry_run("dev", env={"PORT": "9999", "WEB_PORT": "9998"})
    assert "server serve --port 8000" in out
    assert "for port in 8000 5173" in out
    assert "9999" not in out and "9998" not in out


def test_run_takes_its_port():
    assert "server serve --port 8001" in _dry_run("run", "PORT=8001")
