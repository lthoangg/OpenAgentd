"""Model capability resolution.

Looks up input/output capabilities for a fully-qualified
``provider:model`` string against the curated model registry.

Lookup rule (intentionally trivial):

1. **Exact match** in the model registry → return those flags merged
   onto the all-false defaults.
2. **Anything else** → return the all-false / text-out-only defaults.

There are **no prefix fallbacks and no name-substring heuristics**. A
model that isn't listed is treated as text-in / text-out. The cached
Models.dev registry is therefore authoritative for model metadata.

Why this is fine:

- The chat-attachment gate (``app/services/agent_service.py``) and the
  read tool's image handler (``app/agent/tools/builtin/filesystem/read.py``)
  ask :func:`get_capabilities` before allowing image input. An
  un-curated model just refuses images, which is the safe default.
- A missing cache entry refuses images, which is safer than guessing from a
  model name while the registry is unavailable.
- The runtime cache refreshes from Models.dev without requiring an application
  update.

Usage::

    from app.agent.providers.capabilities import get_capabilities

    caps = get_capabilities("googlegenai:gemini-3.1-pro-preview")
    caps.input.vision          # True
    caps.input.document_text   # True  (always — conversion handles this)
    caps.output.text           # True
    caps.to_dict()             # {"input": {...}, "output": {...}}
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import Any

from loguru import logger

from app.agent.providers.model_registry import load_model_registry


# ── Dataclasses ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ModelInputCapabilities:
    """What the model can accept as input."""

    # Vision — accepts image/* attachments (png/jpg/gif/webp).
    vision: bool = False
    # Document text — conversion turns pdf/docx/txt/csv/json/md into
    # text before the model sees it. True for every model: the
    # conversion happens on the client side, not at the model boundary.
    document_text: bool = True
    # Audio input (reserved — not yet wired through the chat layer).
    audio: bool = False
    # Video input (reserved — not yet wired through the chat layer).
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

    # Text — generates text responses (most chat models).
    text: bool = True
    # Image generation (gpt-image-2, glm-image, cogview, etc.). Image-
    # only models like ``gpt-image-2`` also need ``text: false``.
    image: bool = False
    # Audio generation (TTS / realtime audio models).
    audio: bool = False
    # Video generation (sora-2, veo-3, vidu, cogvideox, etc.).
    video: bool = False

    def to_dict(self) -> dict[str, bool]:
        return {
            "text": self.text,
            "image": self.image,
            "audio": self.audio,
            "video": self.video,
        }


@dataclass(frozen=True)
class ModelCapabilities:
    """Composite input + output capabilities for one ``provider:model`` pair."""

    input: ModelInputCapabilities = ModelInputCapabilities()
    output: ModelOutputCapabilities = ModelOutputCapabilities()

    def to_dict(self) -> dict[str, dict[str, bool]]:
        return {
            "input": self.input.to_dict(),
            "output": self.output.to_dict(),
        }


_DEFAULT = ModelCapabilities()


# ── YAML loader ──────────────────────────────────────────────────────────────


def _load_registry() -> dict[str, ModelCapabilities]:
    """Load capability entries from the cached model registry.


    Malformed entries are logged and skipped — one bad row should not
    crash the whole resolver. The file shipping inside the wheel means
    bad rows are a maintainer bug, not a user-visible failure mode.
    """
    registry: dict[str, ModelCapabilities] = {}
    for key, value in load_model_registry().items():
        capabilities = value.get("capabilities") or {}
        if not capabilities:
            continue
        if not isinstance(capabilities, dict):
            logger.warning(
                "model registry: skipping malformed capabilities for {!r}", key
            )
            continue
        try:
            registry[key] = _merge_caps(capabilities)
        except (TypeError, ValueError) as exc:
            logger.warning(
                "model registry: skipping capabilities for {!r} ({})", key, exc
            )
    logger.debug("model registry: loaded {} capability entries", len(registry))
    return registry


def _merge_caps(spec: dict[str, Any]) -> ModelCapabilities:
    """Sparse-merge a mapping onto :data:`_DEFAULT`.

    Only fields explicitly present in ``spec`` override defaults. This
    lets entries write ``input: { vision: true }`` without spelling out
    every other flag.
    """
    input_spec = spec.get("input") or {}
    output_spec = spec.get("output") or {}
    if not isinstance(input_spec, dict) or not isinstance(output_spec, dict):
        raise TypeError("`input` and `output` must be mappings")

    return ModelCapabilities(
        input=ModelInputCapabilities(
            vision=bool(input_spec.get("vision", _DEFAULT.input.vision)),
            document_text=bool(
                input_spec.get("document_text", _DEFAULT.input.document_text)
            ),
            audio=bool(input_spec.get("audio", _DEFAULT.input.audio)),
            video=bool(input_spec.get("video", _DEFAULT.input.video)),
        ),
        output=ModelOutputCapabilities(
            text=bool(output_spec.get("text", _DEFAULT.output.text)),
            image=bool(output_spec.get("image", _DEFAULT.output.image)),
            audio=bool(output_spec.get("audio", _DEFAULT.output.audio)),
            video=bool(output_spec.get("video", _DEFAULT.output.video)),
        ),
    )


@lru_cache(maxsize=1)
def _registry() -> dict[str, ModelCapabilities]:
    """Cached access to the parsed registry.

    Cached because (a) the file is bundled and cannot change at runtime
    without a process restart, and (b) :func:`get_capabilities` is called
    on every chat turn — the lookup needs to be O(1) without re-parsing
    YAML each time.
    """
    return _load_registry()


# ── Public API ──────────────────────────────────────────────────────────────


def get_capabilities(model_id: str | None) -> ModelCapabilities:
    """Return capabilities for a fully-qualified ``provider:model`` string.

    Args:
        model_id: e.g. ``"openai:gpt-5"``. ``None`` or ``""`` returns
            :data:`_DEFAULT`.

    Returns:
        The exact-match capability entry from the model registry if listed;
        the all-false defaults otherwise.
    """
    if not model_id:
        return _DEFAULT
    return _registry().get(model_id.lower(), _DEFAULT)
