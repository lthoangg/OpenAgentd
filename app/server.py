"""Uvicorn entry point.

Run with:
    uv run python -m app.server
    # or
    uv run uvicorn app.server:app --reload
"""

import os

import uvicorn

from app.api.app import create_app
from app.cli.net import require_loopback_or_auth
from app.core.config import settings
from app.core.logging_config import setup_logging
from app.core.server_settings import load_server_settings

setup_logging(
    settings.LOG_LEVEL
)  # configure sinks before anything else imports the logger


app = create_app()

if __name__ == "__main__":
    require_loopback_or_auth(
        host=settings.API_HOST,
        has_auth=bool(
            os.environ.get("OPENAGENTD_DESKTOP_TOKEN")
            or os.environ.get("OPENAGENTD_ACCESS_KEY")
            or load_server_settings().access_key
            or settings.API_ALLOW_INSECURE_LAN
        ),
    )
    uvicorn.run(
        "app.server:app",
        host=settings.API_HOST,
        port=settings.API_PORT,
        reload=settings.API_RELOAD,
    )
