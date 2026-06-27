from __future__ import annotations

import os
from typing import Any

import httpx

DEFAULT_BASE = os.environ.get("OPENAGENTD_MANUAL_BASE", "http://localhost:8000/api")


def require_dev_server(base: str) -> None:
    """Fail fast when a manual smoke script is pointed at a non-dev server."""

    try:
        response = httpx.get(
            f"{base.rstrip('/')}/diagnostics", params={"tail": 0}, timeout=10
        )
        response.raise_for_status()
        data: dict[str, Any] = response.json()
    except Exception as exc:  # noqa: BLE001 - diagnostic guard should explain any failure
        raise SystemExit(
            f"Could not verify manual target {base!r} is a dev server: {exc}"
        ) from exc

    dirs = data.get("dirs") if isinstance(data, dict) else None
    data_dir = ""
    if isinstance(dirs, dict):
        data_info = dirs.get("data")
        if isinstance(data_info, dict):
            data_dir = str(data_info.get("path") or "")

    env = data.get("env") if isinstance(data, dict) else None
    app_env = ""
    if isinstance(env, dict):
        app_env = str(env.get("APP_ENV") or "")

    if app_env == "development" or ".openagentd/dev" in data_dir:
        return

    raise SystemExit(
        "Manual smoke scripts must target the development server by default. "
        f"Refusing target {base!r} (APP_ENV={app_env or 'unknown'}, data={data_dir or 'unknown'}). "
        "Start dev with `APP_ENV=development uv run uvicorn app.server:app --port 8000` "
        "or pass --base only if you intentionally want another server."
    )
