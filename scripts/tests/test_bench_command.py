"""``scripts/bench/command.py`` builds the ``agentd run`` line a task container runs."""

from __future__ import annotations

import importlib.util
import json
import subprocess
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parents[1] / "bench/command.py"
_spec = importlib.util.spec_from_file_location("bench_command", _SCRIPT)
assert _spec and _spec.loader
command = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(command)

# Stands in for agentd: prints its arguments and the CA file it was told to use.
_FAKE = """#!/usr/bin/env python3
import json, os, sys
print(json.dumps({"args": sys.argv[1:], "ca": os.environ.get("SSL_CERT_FILE")}))
"""


def _run(tmp_path: Path, instruction: str, *, thinking: str | None = None, ca_bundle: bool = False) -> dict:
    binary = tmp_path / "agentd"
    binary.write_text(_FAKE)
    binary.chmod(0o755)
    ca_file = tmp_path / "ca.pem"
    if ca_bundle:
        ca_file.write_text("certificates")
    line = command.run_command(
        binary=str(binary), model="acme:big", thinking=thinking, instruction=instruction, logs=str(tmp_path), ca_file=str(ca_file)
    )
    subprocess.run(["sh", "-c", line], check=True, env={"PATH": "/usr/bin:/bin:/usr/local/bin"})
    return json.loads((tmp_path / "openagentd.jsonl").read_text())


def test_the_instruction_arrives_whole_as_the_prompt(tmp_path: Path) -> None:
    instruction = "Fix the build.\nIt's \"broken\"; run $(make) && `test`."
    seen = _run(tmp_path, instruction, thinking="high")
    assert seen["args"] == ["run", "--json", "--model", "acme:big", "--thinking", "high", f"--prompt={instruction}"]


def test_an_instruction_that_starts_with_a_dash_is_still_the_prompt(tmp_path: Path) -> None:
    # `--prompt '- Tips: …'` reads the value as another flag.
    seen = _run(tmp_path, "- You are given a model.\n- Recover it.")
    assert seen["args"][-1] == "--prompt=- You are given a model.\n- Recover it."


def test_uses_the_uploaded_ca_bundle_only_when_there_is_one(tmp_path: Path) -> None:
    assert _run(tmp_path, "hi")["ca"] is None
    assert _run(tmp_path, "hi", ca_bundle=True)["ca"] == str(tmp_path / "ca.pem")
