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


def test_dev_lan_uses_the_guarded_server_module_entry_point():
    body = _target_body("dev-lan")

    assert (
        "API_HOST=0.0.0.0 API_PORT=8000 API_RELOAD=true uv run python -m app.server"
    ) in body
    assert "uv run uvicorn app.server:app" not in body
    assert "bun dev --host 0.0.0.0" in body
