"""Static checks for managed development launch targets."""

from __future__ import annotations

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
