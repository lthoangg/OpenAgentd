"""Generic ``/api/settings`` endpoints.

Exposes the user-editable sandbox deny-list and application update controls.
"""

from __future__ import annotations

import os
import shlex
import shutil
import signal
import subprocess
import time

from fastapi import APIRouter, BackgroundTasks, HTTPException
import httpx
from loguru import logger

from app.agent.sandbox_config import SandboxFileConfig, load_config, save_config
from app.api.schemas.settings import (
    SandboxSettingsBody,
    UpdateInstallBody,
    UpdateStatusBody,
)
from app.core.config import settings
from app.core.logging_config import LOGS_DIR
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


def _self_terminate_after_response() -> None:
    """Send SIGTERM to ourselves after the HTTP response has flushed.

    Runs as a FastAPI ``BackgroundTasks`` callable, *after* the response is
    delivered to the client.  The detached restarter spawned by
    :func:`install_update` is already waiting for our PID to disappear before
    it runs ``openagentd update`` and ``openagentd start``.
    """
    # Small grace period to let uvicorn flush the response and close the
    # socket cleanly before we tear the process down.
    time.sleep(0.5)
    logger.info("update_install_self_terminating pid={}", os.getpid())
    os.kill(os.getpid(), signal.SIGTERM)


@router.post("/update/install")
async def install_update(
    background_tasks: BackgroundTasks,
) -> UpdateInstallBody:
    """Start a detached self-update, then exit so the new server can take over.

    The previous implementation chained ``update && stop && start`` in a single
    shell.  Any non-zero exit short-circuited the chain (a flaky ``update``
    would block the restart entirely), and stdout/stderr were redirected to
    ``/dev/null`` so failures were undiagnosable.  Fixed in v0.3.2.

    The current flow:

    1. Spawn a detached ``/bin/sh`` script that polls ``kill -0 $parent_pid``
       until our process is gone, then runs ``openagentd update`` and
       ``openagentd start`` *unconditionally* (no ``&&`` chain).
    2. Append all output to ``$STATE_DIR/logs/self-update.log`` so failures
       leave a trail.
    3. Return the HTTP response, then SIGTERM ourselves via a background task
       so the response flushes before shutdown — preventing the spurious
       "Install failed" toast that the client used to see when the connection
       was severed mid-response.
    """
    blocked_reason = _install_blocked_reason()
    if blocked_reason is not None:
        raise HTTPException(status_code=409, detail=blocked_reason)

    executable = shutil.which("openagentd")
    assert executable is not None
    quoted_executable = shlex.quote(executable)

    log_path = LOGS_DIR / "self-update.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    quoted_log = shlex.quote(str(log_path))
    parent_pid = os.getpid()

    # POSIX-only restarter.  Windows users must reinstall via
    # ``uv tool install --upgrade openagentd`` from a terminal.
    script = (
        f'echo "[$(date -u +%FT%TZ)] self-update starting parent_pid={parent_pid}" '
        f">> {quoted_log} 2>&1; "
        # Wait for the running server to exit (we SIGTERM ourselves as soon
        # as the response is flushed via BackgroundTasks).
        f"while kill -0 {parent_pid} 2>/dev/null; do sleep 0.2; done; "
        f'echo "[$(date -u +%FT%TZ)] parent exited, running update" '
        f">> {quoted_log} 2>&1; "
        # Run update — log failures but do not abort the restart.
        f"{quoted_executable} update >> {quoted_log} 2>&1 || "
        f'echo "[$(date -u +%FT%TZ)] update step exited non-zero; '
        f'continuing to start" >> {quoted_log} 2>&1; '
        # Give the OS a moment to release the listening port.
        f"sleep 1; "
        f'echo "[$(date -u +%FT%TZ)] starting server" >> {quoted_log} 2>&1; '
        f"exec {quoted_executable} start >> {quoted_log} 2>&1"
    )
    subprocess.Popen(
        ["/bin/sh", "-c", script],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    logger.info("update_install_started executable={} log={}", executable, log_path)
    background_tasks.add_task(_self_terminate_after_response)
    return UpdateInstallBody(status="started")
