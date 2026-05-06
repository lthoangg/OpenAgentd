"""Loader for ``{CONFIG_DIR}/speech.yaml``.

Reads the ``voice`` section (and future ``tts`` / ``stt`` sections) from a
dedicated ``speech.yaml`` file.  Voice input is intentionally separate from
``multimodal.yaml`` because image/video are *output* generation tools while
voice is *input* transcription — opposite directions of the audio modality.

Config shape::

    voice:
      enabled: true
      model: local:base   # "<provider>:<name>" — same format as agent .md files
      language: auto      # or e.g. "en", "fr"
      max_file_mb: 25

Caching: the file is re-read on mtime change so config edits take effect
without a server restart.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from loguru import logger

from app.core.config import settings

_CONFIG_FILENAME = "speech.yaml"


def _config_path() -> Path:
    return Path(settings.OPENAGENTD_CONFIG_DIR) / _CONFIG_FILENAME


# Cache: (path_str, mtime_ns) -> parsed dict.  None signals "file missing/invalid".
_cache: tuple[tuple[str, int], dict[str, Any] | None] | None = None


def _load_raw() -> dict[str, Any] | None:
    """Read + parse speech.yaml with mtime-based caching. ``None`` if missing."""
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
        logger.warning("speech_yaml_invalid path={} err={}", path, exc)
        _cache = (key, None)
        return None

    if not isinstance(data, dict):
        logger.warning("speech_yaml_not_mapping path={}", path)
        _cache = (key, None)
        return None

    _cache = (key, data)
    return data


@dataclass(frozen=True)
class VoiceConfig:
    """Resolved config for the ``voice`` section of ``speech.yaml``.

    ``get_voice_config()`` returns ``None`` when voice is disabled or
    misconfigured — a ``VoiceConfig`` instance always represents an
    enabled, valid configuration.
    """

    provider: str
    model: str
    language: str
    max_file_mb: int


def save_speech_config(
    *,
    enabled: bool,
    model: str,
    language: str,
    max_file_mb: int,
) -> None:
    """Write the ``voice`` section of ``speech.yaml``, preserving any other
    top-level sections (future ``tts:``, etc.).

    Raises ``ValueError`` if ``model`` is not a valid ``"provider:name"`` string.
    """
    if ":" not in model or not all(model.partition(":")[::2]):
        raise ValueError(f"Invalid model '{model}': expected 'provider:name'")

    path = _config_path()
    # Load existing file so we don't clobber future sections (e.g. tts:).
    try:
        existing: dict[str, Any] = (
            yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        )
        if not isinstance(existing, dict):
            existing = {}
    except FileNotFoundError:
        existing = {}
    except yaml.YAMLError:
        existing = {}

    existing["voice"] = {
        "enabled": enabled,
        "model": model,
        "language": language,
        "max_file_mb": max_file_mb,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        yaml.dump(existing, default_flow_style=False, allow_unicode=True),
        encoding="utf-8",
    )

    # Bust the cache so the next read picks up the new file.
    global _cache
    _cache = None


def get_voice_config() -> VoiceConfig | None:
    """Return resolved voice config or ``None`` if absent/disabled/malformed.

    Returns ``None`` when:
    - ``speech.yaml`` is missing.
    - The ``voice`` section is absent.
    - ``enabled`` is ``false``.
    - ``model`` is not a valid ``"provider:name"`` string.
    """
    raw = _load_raw()
    if not raw:
        return None
    section = raw.get("voice")
    if not isinstance(section, dict):
        return None

    enabled = section.get("enabled", False)
    if not isinstance(enabled, bool):
        logger.warning("speech_voice_enabled_invalid value={}", enabled)
        return None
    if not enabled:
        return None

    model_str = section.get("model")
    if not isinstance(model_str, str) or ":" not in model_str:
        logger.warning("speech_voice_model_invalid model={}", model_str)
        return None

    provider, _, model_name = model_str.partition(":")
    provider = provider.strip()
    model_name = model_name.strip()
    if not provider or not model_name:
        logger.warning("speech_voice_model_invalid model={}", model_str)
        return None

    language = section.get("language", "auto")
    if not isinstance(language, str):
        language = "auto"

    max_file_mb = section.get("max_file_mb", 25)
    if not isinstance(max_file_mb, int) or max_file_mb <= 0:
        max_file_mb = 25

    return VoiceConfig(
        provider=provider,
        model=model_name,
        language=language,
        max_file_mb=max_file_mb,
    )
