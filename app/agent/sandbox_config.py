"""Config schema and file I/O for ``{CONFIG_DIR}/sandbox.yaml``.

User-configurable extension to the sandbox denylist: a list of glob
patterns that, when matched against a resolved absolute path, cause the
sandbox to reject access.  Patterns ship seeded with ``**/.env`` and
``**/.env.*`` on first run so secret files are protected by default;
users can edit/remove them via the Settings UI.

File shape (YAML)::

    denied_patterns:
      - "**/.env"
      - "**/.env.*"
      - "**/secrets/**"
"""

from __future__ import annotations

import os
import tempfile
from functools import lru_cache
from pathlib import Path

import yaml
from loguru import logger
from pydantic import BaseModel, ConfigDict, Field

from app.core.config import settings

_CONFIG_FILENAME = "sandbox.yaml"
_PARSED_CONFIG_CACHE_MAX_SIZE = 64
_MAX_CACHED_CONFIG_CHARS = 128 * 1024

#: Patterns seeded into a freshly-created ``sandbox.yaml``.  Chosen to
#: cover the most common "sensitive file" case without being noisy.
DEFAULT_DENIED_PATTERNS: tuple[str, ...] = (
    "**/.env",
    "**/.env.*",
)


class SandboxFileConfig(BaseModel):
    """Top-level shape of ``sandbox.yaml``."""

    model_config = ConfigDict(extra="forbid")

    denied_patterns: list[str] = Field(
        default_factory=lambda: list(DEFAULT_DENIED_PATTERNS),
        description="Glob patterns seeded from DEFAULT_DENIED_PATTERNS when not specified.",
    )


def config_path() -> Path:
    """Return the resolved path to ``sandbox.yaml``."""
    return Path(settings.OPENAGENTD_CONFIG_DIR) / _CONFIG_FILENAME


def _parse_config_text(path: Path, text: str) -> tuple[str, ...]:
    try:
        raw = yaml.safe_load(text) or {}
    except yaml.YAMLError as exc:
        raise ValueError(f"Invalid YAML in {path}: {exc}") from exc

    if not isinstance(raw, dict):
        raise ValueError(f"{path}: expected a YAML mapping at top level")

    cfg = SandboxFileConfig.model_validate(raw)
    return tuple(pattern for pattern in cfg.denied_patterns if pattern.strip())


@lru_cache(maxsize=_PARSED_CONFIG_CACHE_MAX_SIZE)
def _parse_config(path: Path, text: str) -> tuple[str, ...]:
    """Parse successful config content into immutable cached patterns."""
    return _parse_config_text(path, text)


def load_config(path: Path | None = None) -> SandboxFileConfig:
    """Load ``sandbox.yaml`` from disk.

    When the file does not exist, returns the seed defaults without
    writing — the file is only created on the first PUT from the
    Settings UI (or whenever the user hand-edits the file).  Empty/blank
    patterns are dropped silently.

    Raises ``ValueError`` if the file exists but is malformed.
    """
    resolved = path or config_path()
    if not resolved.exists():
        return SandboxFileConfig()

    text = resolved.read_text(encoding="utf-8")
    parser = (
        _parse_config if len(text) <= _MAX_CACHED_CONFIG_CHARS else _parse_config_text
    )
    patterns = parser(resolved.absolute(), text)
    return SandboxFileConfig(denied_patterns=list(patterns))


def save_config(cfg: SandboxFileConfig, path: Path | None = None) -> Path:
    """Persist ``cfg`` to disk atomically. Returns the resolved path."""
    resolved = path or config_path()
    resolved.parent.mkdir(parents=True, exist_ok=True)

    payload = cfg.model_dump(mode="json")
    text = yaml.safe_dump(payload, sort_keys=False, default_flow_style=False)

    # Atomic write: tmp file in same dir, then rename.
    fd, tmp_name = tempfile.mkstemp(
        prefix=".sandbox.yaml.", suffix=".tmp", dir=resolved.parent
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp_name, resolved)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise

    logger.info(
        "sandbox_config_saved path={} patterns={}",
        resolved,
        len(cfg.denied_patterns),
    )
    _parse_config.cache_clear()
    return resolved
