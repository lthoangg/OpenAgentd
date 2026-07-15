"""Model metadata resolution.

Looks up per-model limits and other metadata for a fully-qualified
``provider:model`` string against the curated model registry.

This module intentionally stays API-compatible with the old metadata resolver,
but its source data now lives beside modality gates in the model registry.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import Any

from loguru import logger

from app.agent.providers.model_registry import load_model_registry


@dataclass(frozen=True)
class ModelLimits:
    """Token limits for one model.

    ``None`` means unknown, not unlimited.
    """

    context_length: int | None = None
    max_completion_tokens: int | None = None

    def to_dict(self) -> dict[str, int | None]:
        return {
            "context_length": self.context_length,
            "max_completion_tokens": self.max_completion_tokens,
        }


@dataclass(frozen=True)
class ModelThinking:
    """Reasoning/thinking controls supported by one model."""

    levels: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, list[str]]:
        return {"levels": list(self.levels)}


@dataclass(frozen=True)
class ModelCost:
    """Per-token pricing metadata when known."""

    input: float | None = None
    output: float | None = None
    cache_read: float | None = None
    cache_write: float | None = None

    def to_dict(self) -> dict[str, float | None]:
        return {
            "input": self.input,
            "output": self.output,
            "cache_read": self.cache_read,
            "cache_write": self.cache_write,
        }


@dataclass(frozen=True)
class ModelFeatures:
    """Operational flags and lifecycle metadata from the model catalog."""

    tool_call: bool | None = None
    attachment: bool | None = None
    temperature: bool | None = None
    reasoning: bool | None = None
    status: str | None = None
    release_date: str | None = None

    def to_dict(self) -> dict[str, bool | str | None]:
        return {
            "tool_call": self.tool_call,
            "attachment": self.attachment,
            "temperature": self.temperature,
            "reasoning": self.reasoning,
            "status": self.status,
            "release_date": self.release_date,
        }


@dataclass(frozen=True)
class ModelTransport:
    """A provider-neutral, region-independent transport selection."""

    endpoint_variant: str
    api_family: str


@dataclass(frozen=True)
class ModelMetadata:
    """Non-modality metadata for one ``provider:model`` pair."""

    limits: ModelLimits = ModelLimits()
    thinking: ModelThinking = ModelThinking()
    cost: ModelCost = ModelCost()
    features: ModelFeatures = ModelFeatures()
    transport: ModelTransport | None = None

    def to_dict(
        self,
    ) -> dict[
        str,
        dict[str, int | None]
        | dict[str, list[str]]
        | dict[str, float | None]
        | dict[str, bool | str | None],
    ]:
        return {
            "limits": self.limits.to_dict(),
            "thinking": self.thinking.to_dict(),
            "cost": self.cost.to_dict(),
            "features": self.features.to_dict(),
        }


_DEFAULT = ModelMetadata()


def _positive_int(value: Any, field: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"`{field}` must be a positive integer")
    if value <= 0:
        raise ValueError(f"`{field}` must be a positive integer")
    return value


def _string_tuple(value: Any, field: str) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise TypeError(f"`{field}` must be a list of strings")
    return tuple(value)


def _finite_float(value: Any, field: str) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise TypeError(f"`{field}` must be a number")
    return float(value)


def _optional_bool(value: Any, field: str) -> bool | None:
    if value is None:
        return None
    if not isinstance(value, bool):
        raise TypeError(f"`{field}` must be a boolean")
    return value


def _optional_string(value: Any, field: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise TypeError(f"`{field}` must be a string")
    return value


def _transport(value: Any) -> ModelTransport | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise TypeError("`transport` must be a mapping")
    endpoint_variant = value.get("endpoint_variant")
    api_family = value.get("api_family")
    if endpoint_variant not in {"default", "openai"} or api_family != "responses":
        raise ValueError(
            "`transport` must contain a known endpoint variant and API family"
        )
    return ModelTransport(
        endpoint_variant=endpoint_variant,
        api_family=api_family,
    )


def _merge_metadata(spec: dict[str, Any]) -> ModelMetadata:
    limits_spec = spec.get("limits") or {}
    thinking_spec = spec.get("thinking") or {}
    cost_spec = spec.get("cost") or {}
    features_spec = spec.get("features") or {}
    transport_spec = spec.get("transport")
    if not isinstance(limits_spec, dict):
        raise TypeError("`limits` must be a mapping")
    if not isinstance(thinking_spec, dict):
        raise TypeError("`thinking` must be a mapping")
    if not isinstance(cost_spec, dict):
        raise TypeError("`cost` must be a mapping")
    if not isinstance(features_spec, dict):
        raise TypeError("`features` must be a mapping")

    return ModelMetadata(
        limits=ModelLimits(
            context_length=_positive_int(
                limits_spec.get("context_length"), "limits.context_length"
            ),
            max_completion_tokens=_positive_int(
                limits_spec.get("max_completion_tokens"),
                "limits.max_completion_tokens",
            ),
        ),
        thinking=ModelThinking(
            levels=_string_tuple(thinking_spec.get("levels"), "thinking.levels")
        ),
        cost=ModelCost(
            input=_finite_float(cost_spec.get("input"), "cost.input"),
            output=_finite_float(cost_spec.get("output"), "cost.output"),
            cache_read=_finite_float(cost_spec.get("cache_read"), "cost.cache_read"),
            cache_write=_finite_float(cost_spec.get("cache_write"), "cost.cache_write"),
        ),
        features=ModelFeatures(
            tool_call=_optional_bool(
                features_spec.get("tool_call"), "features.tool_call"
            ),
            attachment=_optional_bool(
                features_spec.get("attachment"), "features.attachment"
            ),
            temperature=_optional_bool(
                features_spec.get("temperature"), "features.temperature"
            ),
            reasoning=_optional_bool(
                features_spec.get("reasoning"), "features.reasoning"
            ),
            status=_optional_string(features_spec.get("status"), "features.status"),
            release_date=_optional_string(
                features_spec.get("release_date"), "features.release_date"
            ),
        ),
        transport=_transport(transport_spec),
    )


def _load_registry() -> dict[str, ModelMetadata]:
    registry: dict[str, ModelMetadata] = {}
    for key, value in load_model_registry().items():
        metadata = {
            field: value[field]
            for field in ("limits", "thinking", "cost", "features", "transport")
            if field in value
        }
        if not metadata:
            continue
        try:
            registry[key] = _merge_metadata(metadata)
        except (TypeError, ValueError) as exc:
            logger.warning("model registry: skipping metadata for {!r} ({})", key, exc)
    logger.debug("model registry: loaded {} metadata entries", len(registry))
    return registry


@lru_cache(maxsize=1)
def _registry() -> dict[str, ModelMetadata]:
    return _load_registry()


def get_model_metadata(model_id: str | None) -> ModelMetadata:
    """Return metadata for a fully-qualified ``provider:model`` string."""
    if not model_id:
        return _DEFAULT
    return _registry().get(model_id.lower(), _DEFAULT)


def get_model_limits(model_id: str | None) -> ModelLimits:
    """Return token limits for a fully-qualified ``provider:model`` string."""
    return get_model_metadata(model_id).limits


def get_model_cost(model_id: str | None) -> ModelCost:
    """Return pricing metadata for a fully-qualified ``provider:model`` string."""
    return get_model_metadata(model_id).cost


def get_model_features(model_id: str | None) -> ModelFeatures:
    """Return support flags for a fully-qualified ``provider:model`` string."""
    return get_model_metadata(model_id).features


def get_model_thinking_levels(model_id: str | None) -> tuple[str, ...]:
    """Return supported thinking levels for a fully-qualified model ID."""
    return get_model_metadata(model_id).thinking.levels


def get_model_transport(model_id: str | None) -> ModelTransport | None:
    """Return a normalized transport selection when the catalog defines one."""
    return get_model_metadata(model_id).transport
