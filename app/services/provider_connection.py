"""Shared "is this provider actually connected?" logic.

Extracted from ``app/api/routes/settings.py`` so non-route services (e.g.
the usage-summary aggregator used by the desktop tray) can determine
connection state without importing FastAPI route modules.

This is a static/synchronous check — it does not probe daemons or
networks. See ``app/api/routes/settings.py::_provider_is_reachable`` for
the async variant that adds a live daemon ping for local providers.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import TYPE_CHECKING

from app.core.config import settings

if TYPE_CHECKING:
    from app.agent.providers.catalog import ProviderEntry


def provider_is_configured(entry: "ProviderEntry") -> bool:
    """Return True if the user's .env/token store has credentials for this provider."""
    kind = entry.get("kind")
    from app.agent.providers.plugin_registry import (
        ProviderCredentialStore,
        find_provider_plugin,
    )

    plugin = find_provider_plugin(entry["id"])
    if plugin is not None:
        store = ProviderCredentialStore(plugin.id)
        if plugin.is_configured is not None:
            return plugin.is_configured(store)
        return all(
            store.get(field.name) for field in plugin.credentials if field.required
        )
    if kind == "local":
        return True
    if kind == "oauth":
        if entry["id"] == "copilot":
            if (
                os.environ.get("COPILOT_GITHUB_TOKEN")
                or os.environ.get("GH_TOKEN")
                or os.environ.get("GITHUB_TOKEN")
                or os.environ.get("GITHUB_COPILOT_TOKEN")
            ):
                return True
        cache_dir = Path(settings.OPENAGENTD_CACHE_DIR or "")
        token_files = {
            "codex": cache_dir / "codex_oauth.json",
            "copilot": cache_dir / "copilot_oauth.json",
            "grok": cache_dir / "grok_oauth.json",
        }
        token_file = token_files.get(entry["id"])
        return bool(token_file and token_file.is_file())
    if kind == "cloud_creds":
        if entry["id"] == "bedrock":
            # Do not probe the default botocore chain here: static settings
            # checks must not trigger instance/container metadata requests.
            store = ProviderCredentialStore(entry["id"])
            return bool(
                os.environ.get("AWS_BEARER_TOKEN_BEDROCK")
                or store.get("AWS_BEARER_TOKEN_BEDROCK")
                or os.environ.get("AWS_BEDROCK_PROFILE")
                or store.get("AWS_BEDROCK_PROFILE")
                or os.environ.get("AWS_PROFILE")
            )
        # Vertex AI: need project + location *and* gcloud ADC. We can't
        # check gcloud from here without shelling out, so the UI's
        # "Test connection" button is the source of truth.
        names = entry.get("env_vars") or []
        return all(os.environ.get(name) for name in names)
    # api_key
    env_var = entry.get("env_var") or ""
    if not env_var:
        return False
    store = ProviderCredentialStore(entry["id"])
    return bool(store.get(env_var))
