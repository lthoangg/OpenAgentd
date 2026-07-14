"""CLI server bind and access-key settings.

These settings are intentionally separate from the shared agent/runtime
configuration in ``settings.yaml``. The desktop builtin sidecar and terminal
server may share agents and sessions, but each has its own authentication
lifecycle: desktop uses an ephemeral launch token, while the CLI server persists
its host, port, and access key here.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import cast

import yaml

from app.core.config import settings
from app.core.runtime_settings import ServerSettings, runtime_settings_path


def server_settings_path() -> Path:
    return Path(settings.OPENAGENTD_CONFIG_DIR) / "server.yaml"


def _pop_legacy_server_settings(
    path: Path, *, validate: bool = False
) -> object | ServerSettings | None:
    if not path.exists():
        return None
    try:
        shared = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as exc:
        raise ValueError(f"settings.yaml YAML parse error: {exc}") from exc
    if not isinstance(shared, dict):
        raise ValueError("settings.yaml must contain a YAML mapping.")
    legacy_server = shared.pop("server", None)
    if legacy_server is not None:
        if validate:
            legacy_server = ServerSettings.model_validate(legacy_server)
        path.write_text(yaml.safe_dump(shared, sort_keys=False), encoding="utf-8")
    return legacy_server


def load_server_settings(
    path: Path | None = None,
    *,
    legacy_path: Path | None = None,
) -> ServerSettings:
    resolved = path or server_settings_path()
    if resolved.exists():
        try:
            raw = yaml.safe_load(resolved.read_text(encoding="utf-8")) or {}
        except yaml.YAMLError as exc:
            raise ValueError(f"server.yaml YAML parse error: {exc}") from exc
        if not isinstance(raw, dict):
            raise ValueError("server.yaml must contain a YAML mapping.")
        current = ServerSettings.model_validate(raw)
        legacy = _pop_legacy_server_settings(legacy_path or runtime_settings_path())
        if current.access_key is None and isinstance(legacy, dict):
            legacy_key = cast(dict[str, object], legacy).get("access_key")
            if isinstance(legacy_key, str) and legacy_key:
                current.access_key = legacy_key
                save_server_settings(current, resolved)
        return current

    legacy = legacy_path or runtime_settings_path()
    migrated = _pop_legacy_server_settings(legacy, validate=True)
    if isinstance(migrated, ServerSettings):
        save_server_settings(migrated, resolved)
        return migrated

    return ServerSettings()


def save_server_settings(cfg: ServerSettings, path: Path | None = None) -> Path:
    resolved = path or server_settings_path()
    resolved.parent.mkdir(parents=True, exist_ok=True)
    data = cfg.model_dump(mode="json", exclude_none=True)
    resolved.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
    if os.name != "nt":
        resolved.chmod(0o600)
    return resolved
