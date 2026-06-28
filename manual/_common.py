from __future__ import annotations

import argparse
import os
from typing import Any

import httpx

DEFAULT_BASE = os.environ.get("OPENAGENTD_MANUAL_BASE", "http://localhost:8000/api")


def add_env_argument(parser: argparse.ArgumentParser) -> None:
    """Add ``--env {development,production}`` to *parser*.

    Call this on every manual script's parser so the user can switch DB /
    path roots without having to prefix the whole command with an env var::

        uv run python -m manual.skill_tool_analytics --env production
    """
    parser.add_argument(
        "--env",
        choices=("development", "production"),
        default=None,
        metavar="ENV",
        help="Override APP_ENV (development|production). Defaults to the current APP_ENV setting.",
    )


def apply_env_override(args: argparse.Namespace) -> None:
    """Inject ``args.env`` into ``os.environ`` before any settings are loaded.

    Must be called **immediately after** ``parse_args()`` and **before** any
    import that transitively touches ``app.core.config.settings``.  That
    module instantiates :class:`~pydantic_settings.BaseSettings` at import
    time, so the env var must be present in ``os.environ`` before the first
    import.
    """
    env = getattr(args, "env", None)
    if env:
        os.environ["APP_ENV"] = env


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
        "Start dev with `uv run uvicorn app.server:app --port 8000` "
        "or pass --base only if you intentionally want another server."
    )
