"""Loader for ``{CONFIG_DIR}/multimodal.yaml``.

Tiny wrapper around ``yaml.safe_load`` + a dataclass — matches the project's
other YAML configs (see ``app.agent.providers.capabilities``).  Cached per
file-path + mtime so tool calls don't re-read the file on every invocation.

Config shape (per media section)::

    image:
      model: openai:gpt-image-2   # "<provider>:<model>" — same format as agent .md files
      size: 1024x1024              # extras — passed through to the backend
      quality: auto

The ``model`` field carries both the provider and the model name,
mirroring how agent ``.md`` files declare their LLM (e.g.
``model: openai:gpt-5``). Auth is **not** configured in YAML — each
provider backend owns its credential lookup (``openai`` reads
``OPENAI_API_KEY``).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from loguru import logger

from app.core.config import settings

_CONFIG_FILENAME = "multimodal.yaml"


@dataclass(frozen=True)
class MediaSectionConfig:
    """Resolved config for one media kind (``image`` / ``audio`` / ``video``)."""

    provider: str
    model: str
    # Arbitrary extra fields (size, quality, voice, …) passed straight through.
    extras: dict[str, Any]


def _config_path() -> Path:
    return Path(settings.OPENAGENTD_CONFIG_DIR) / _CONFIG_FILENAME


# Me cache: (path_str, mtime_ns) -> parsed dict.  None signals "file missing".
_cache: tuple[tuple[str, int], dict[str, Any] | None] | None = None


def _load_raw() -> dict[str, Any] | None:
    """Read + parse the YAML file, with mtime-based caching. ``None`` if missing."""
    global _cache
    path = _config_path()
    try:
        mtime = path.stat().st_mtime_ns
    except FileNotFoundError:
        _cache = ((str(path), 0), None)
        return None

    key = (str(path), mtime)
    if _cache is not None and _cache[0] == key:
        return _cache[1]

    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as exc:
        logger.warning("multimodal_yaml_invalid path={} err={}", path, exc)
        _cache = (key, None)
        return None

    if not isinstance(data, dict):
        logger.warning("multimodal_yaml_not_mapping path={}", path)
        _cache = (key, None)
        return None

    _cache = (key, data)
    return data


def get_section(kind: str) -> MediaSectionConfig | None:
    """Return resolved config for ``kind`` or ``None`` if absent/malformed.

    The ``model`` field must be a ``"provider:name"`` string (same format
    agent ``.md`` files use). Malformed or legacy shapes log a warning and
    return ``None`` so the tool surfaces a "not configured" error.
    """
    raw = _load_raw()
    if not raw:
        return None
    section = raw.get(kind)
    if not isinstance(section, dict):
        return None

    # Me fail loudly on the legacy shape so misconfigurations don't silently regress.
    if "provider" in section:
        logger.warning(
            "multimodal_section_legacy_shape kind={} "
            "hint='provider' key is no longer accepted — use "
            "'model: <provider>:<name>' (e.g. 'openai:gpt-image-2')",
            kind,
        )
        return None

    model_str = section.get("model")
    if not isinstance(model_str, str):
        logger.warning("multimodal_section_model_missing kind={}", kind)
        return None

    if ":" not in model_str:
        logger.warning(
            "multimodal_section_model_invalid kind={} model={} "
            "hint=expected 'provider:name' (e.g. 'openai:gpt-image-2')",
            kind,
            model_str,
        )
        return None

    provider, _, name = model_str.partition(":")
    provider = provider.strip()
    name = name.strip()
    if not provider or not name:
        logger.warning(
            "multimodal_section_model_invalid kind={} model={}", kind, model_str
        )
        return None

    extras = {k: v for k, v in section.items() if k != "model"}
    return MediaSectionConfig(provider=provider, model=name, extras=extras)
