"""Model capability detection.

Resolves input and output capabilities from the fully-qualified
``provider:model`` string stored in ``Agent.model_id``.

Defaults and prefix fallbacks are defined in this module (infrastructure
logic).  Exact per-model overrides are loaded from ``capabilities.yaml``.

Lookup order:
1. Exact match in ``capabilities.yaml`` (case-insensitive).
2. Longest prefix match in ``_PREFIX_FALLBACKS``.
3. ``_DEFAULT``.

Usage::

    from app.agent.providers.capabilities import get_capabilities

    caps = get_capabilities("googlegenai:gemini-3.1-pro-preview")
    caps.input.vision          # True — accepts image/png, image/jpeg, etc.
    caps.input.document_text   # True — markitdown conversion for pdf/docx/txt/csv/json/md
    caps.output.text           # True — generates text responses
    caps.to_dict()             # {"input": {...}, "output": {...}}
"""

from __future__ import annotations

import functools
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from loguru import logger

# ── Path to the YAML registry ────────────────────────────────────────────────
_YAML_PATH = Path(__file__).parent / "capabilities.yaml"


# ── Dataclasses ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ModelInputCapabilities:
    """What the model can accept as input."""

    # Vision — accepts image/* files (png/jpg/gif/webp)
    vision: bool = False
    # Document text — markitdown conversion for pdf/docx/txt/csv/json/md
    document_text: bool = True
    # Audio input (not yet implemented — reserved for future use)
    audio: bool = False
    # Video input (not yet implemented — reserved for future use)
    video: bool = False

    def to_dict(self) -> dict[str, bool]:
        return {
            "vision": self.vision,
            "document_text": self.document_text,
            "audio": self.audio,
            "video": self.video,
        }


@dataclass(frozen=True)
class ModelOutputCapabilities:
    """What the model can generate as output."""

    # Text — generates text responses (almost all models)
    text: bool = True
    # Image generation (not yet implemented — reserved for future use)
    image: bool = False
    # Audio generation (not yet implemented — reserved for future use)
    audio: bool = False

    def to_dict(self) -> dict[str, bool]:
        return {
            "text": self.text,
            "image": self.image,
            "audio": self.audio,
        }


@dataclass(frozen=True)
class ModelCapabilities:
    """Composite input + output capabilities for a specific provider:model pair."""

    input: ModelInputCapabilities = ModelInputCapabilities()
    output: ModelOutputCapabilities = ModelOutputCapabilities()

    def to_dict(self) -> dict[str, dict[str, bool]]:
        return {
            "input": self.input.to_dict(),
            "output": self.output.to_dict(),
        }


# ── Defaults & prefix fallbacks (infrastructure logic) ───────────────────────

_DEFAULT = ModelCapabilities()

_PREFIX_FALLBACKS: list[tuple[str, ModelCapabilities]] = [
    # All Gemini providers: vision-capable
    ("googlegenai:", ModelCapabilities(input=ModelInputCapabilities(vision=True))),
    ("vertexai:", ModelCapabilities(input=ModelInputCapabilities(vision=True))),
    ("geminicli:", ModelCapabilities(input=ModelInputCapabilities(vision=True))),
    # OpenAI generic: assume vision-capable
    ("openai:", ModelCapabilities(input=ModelInputCapabilities(vision=True))),
    # Copilot generic: conservative — no vision
    ("copilot:", ModelCapabilities(input=ModelInputCapabilities(vision=False))),
    # Codex (ChatGPT subscription): conservative — no vision
    ("codex:", ModelCapabilities(input=ModelInputCapabilities(vision=False))),
    # xAI (Grok): multimodal models support vision (e.g. grok-4); conservative default
    ("xai:", ModelCapabilities(input=ModelInputCapabilities(vision=True))),
    # ZAI generic: conservative — no vision
    ("zai:", ModelCapabilities(input=ModelInputCapabilities(vision=False))),
    # DeepSeek: text-only (no vision in deepseek-chat / deepseek-reasoner)
    ("deepseek:", ModelCapabilities(input=ModelInputCapabilities(vision=False))),
    # OpenRouter: too varied — text only unless more specific
    ("openrouter:", ModelCapabilities(input=ModelInputCapabilities(vision=False))),
    # NVIDIA NIM: too varied — text only unless more specific
    ("nvidia:", ModelCapabilities(input=ModelInputCapabilities(vision=False))),
    # Ollama: catalog spans text-only (Llama, Qwen, DeepSeek) and vision
    # (Llava, Llama 3.2-vision, qwen3-vl). Conservative default — list
    # exact vision models in capabilities.yaml when needed.
    ("ollama:", ModelCapabilities(input=ModelInputCapabilities(vision=False))),
    # 9Router: aggregator proxy fronts many vision-capable models (Claude,
    # Gemini, GPT-4o, etc.); default vision=true and let exact entries opt out.
    ("router9:", ModelCapabilities(input=ModelInputCapabilities(vision=True))),
    # CLIProxyAPI: wraps Gemini/ChatGPT/Claude via local proxy; many of those
    # are vision-capable, so default vision=true and let exact entries opt out.
    ("cliproxy:", ModelCapabilities(input=ModelInputCapabilities(vision=True))),
    # AWS Bedrock: too varied across model families — conservative text-only default.
    # Claude and Nova vision models are listed as exact entries in capabilities.yaml.
    ("bedrock:", ModelCapabilities(input=ModelInputCapabilities(vision=False))),
]


# ── YAML loading (exact model overrides only) ────────────────────────────────


def _parse_input(
    raw: dict[str, Any] | None,
    defaults: ModelInputCapabilities,
) -> ModelInputCapabilities:
    """Merge a sparse ``input:`` dict onto *defaults*."""
    if not raw:
        return defaults
    return ModelInputCapabilities(
        vision=raw.get("vision", defaults.vision),
        document_text=raw.get("document_text", defaults.document_text),
        audio=raw.get("audio", defaults.audio),
        video=raw.get("video", defaults.video),
    )


def _parse_output(
    raw: dict[str, Any] | None,
    defaults: ModelOutputCapabilities,
) -> ModelOutputCapabilities:
    """Merge a sparse ``output:`` dict onto *defaults*."""
    if not raw:
        return defaults
    return ModelOutputCapabilities(
        text=raw.get("text", defaults.text),
        image=raw.get("image", defaults.image),
        audio=raw.get("audio", defaults.audio),
    )


def _parse_capabilities(
    raw: dict[str, Any],
    default_input: ModelInputCapabilities,
    default_output: ModelOutputCapabilities,
) -> ModelCapabilities:
    """Parse a capabilities entry with sparse merge onto defaults."""
    return ModelCapabilities(
        input=_parse_input(raw.get("input"), default_input),
        output=_parse_output(raw.get("output"), default_output),
    )


@functools.lru_cache(maxsize=1)
def _load_exact_models() -> dict[str, ModelCapabilities]:
    """Load exact model overrides from ``capabilities.yaml`` (cached).

    Returns an empty dict if the file is missing or malformed — the caller
    falls through to prefix/default lookup.
    """
    try:
        raw = yaml.safe_load(_YAML_PATH.read_text(encoding="utf-8"))
    except Exception:
        logger.warning(
            "capabilities_yaml_load_failed path={} — using prefix/default only",
            _YAML_PATH,
        )
        return {}

    if not isinstance(raw, dict):
        logger.warning("capabilities_yaml_invalid_format — using prefix/default only")
        return {}

    default_input = _DEFAULT.input
    default_output = _DEFAULT.output

    exact: dict[str, ModelCapabilities] = {}
    for model_key, entry in raw.items():
        if isinstance(entry, dict):
            exact[model_key.lower()] = _parse_capabilities(
                entry,
                default_input,
                default_output,
            )

    return exact


# ── Public API ───────────────────────────────────────────────────────────────


def get_capabilities(model_id: str | None) -> ModelCapabilities:
    """Return capability set for a fully-qualified provider:model string.

    Lookup order:
    1. Exact match in ``capabilities.yaml`` (case-insensitive).
    2. Longest prefix match in ``_PREFIX_FALLBACKS``.
    3. ``_DEFAULT``.

    Args:
        model_id: e.g. ``"googlegenai:gemini-3.1-pro-preview"``, ``"openai:gpt-5"``.
            ``None`` returns the defaults.
    """
    if not model_id:
        return _DEFAULT

    key = model_id.lower()

    # 1. Exact match from YAML
    exact = _load_exact_models()
    if key in exact:
        return exact[key]

    # 2. Longest prefix match
    best_prefix = ""
    best_caps: ModelCapabilities | None = None
    for prefix, caps in _PREFIX_FALLBACKS:
        if key.startswith(prefix) and len(prefix) > len(best_prefix):
            best_prefix = prefix
            best_caps = caps

    if best_caps is not None:
        return best_caps

    # 3. Default
    return _DEFAULT


def reload_capabilities() -> None:
    """Clear the cached registry — next ``get_capabilities()`` call reloads YAML.

    Useful for tests or hot-reload scenarios.
    """
    _load_exact_models.cache_clear()
