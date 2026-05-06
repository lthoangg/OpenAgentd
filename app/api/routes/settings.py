"""Generic ``/api/settings`` endpoints.

Exposes the user-editable sandbox deny-list and application update controls.
"""

from __future__ import annotations

import shlex
import shutil
import subprocess

from fastapi import APIRouter, HTTPException
import httpx
from loguru import logger

from app.agent.sandbox_config import SandboxFileConfig, load_config, save_config
from app.api.schemas.settings import (
    SandboxSettingsBody,
    UpdateInstallBody,
    UpdateStatusBody,
)
from app.core.config import settings
from app.core.version import VERSION

router = APIRouter()

_PYPI_JSON_URL = "https://pypi.org/pypi/openagentd/json"


def _version_key(version: str) -> tuple[int, ...]:
    """Compare simple published versions without adding a runtime dependency."""
    parts: list[int] = []
    for part in version.split("."):
        digits = "".join(ch for ch in part if ch.isdigit())
        parts.append(int(digits) if digits else 0)
    return tuple(parts)


def _install_blocked_reason() -> str | None:
    if settings.APP_ENV == "development":
        return "Automatic install is only available for the installed app."
    if shutil.which("openagentd") is None:
        return "Could not find the `openagentd` executable on PATH."
    return None


@router.get("/sandbox")
async def get_sandbox_settings() -> SandboxSettingsBody:
    """Return the current sandbox deny-list.

    On first run this seeds ``sandbox.yaml`` with sensible defaults
    (``**/.env``, ``**/.env.*``).
    """
    try:
        cfg = load_config()
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return SandboxSettingsBody(denied_patterns=list(cfg.denied_patterns))


@router.put("/sandbox")
async def update_sandbox_settings(body: SandboxSettingsBody) -> SandboxSettingsBody:
    """Replace the sandbox deny-list with the supplied glob patterns."""
    cleaned = [p.strip() for p in body.denied_patterns if p.strip()]
    save_config(SandboxFileConfig(denied_patterns=cleaned))
    return SandboxSettingsBody(denied_patterns=cleaned)


@router.get("/update")
async def get_update_status() -> UpdateStatusBody:
    """Check PyPI for the latest published OpenAgentd version."""
    blocked_reason = _install_blocked_reason()
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.get(_PYPI_JSON_URL)
            response.raise_for_status()
    except httpx.HTTPError as exc:
        logger.warning("update_check_failed error={}", exc)
        raise HTTPException(
            status_code=502, detail="Could not check for updates"
        ) from exc

    try:
        latest = response.json().get("info", {}).get("version")
    except ValueError as exc:
        raise HTTPException(
            status_code=502, detail="PyPI did not return valid JSON"
        ) from exc
    if not isinstance(latest, str) or not latest:
        raise HTTPException(
            status_code=502, detail="PyPI did not return a package version"
        )

    return UpdateStatusBody(
        current_version=VERSION,
        latest_version=latest,
        update_available=_version_key(latest) > _version_key(VERSION),
        can_install=blocked_reason is None,
        install_blocked_reason=blocked_reason,
    )


@router.post("/update/install")
async def install_update() -> UpdateInstallBody:
    """Start a background self-update, then restart the production server."""
    blocked_reason = _install_blocked_reason()
    if blocked_reason is not None:
        raise HTTPException(status_code=409, detail=blocked_reason)

    executable = shutil.which("openagentd")
    assert executable is not None
    quoted_executable = shlex.quote(executable)
    command = (
        f"sleep 1; {quoted_executable} update && "
        f"{quoted_executable} stop && {quoted_executable} start"
    )
    subprocess.Popen(
        ["/bin/sh", "-lc", command],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    logger.info("update_install_started executable={}", executable)
    return UpdateInstallBody(status="started")
