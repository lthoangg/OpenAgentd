"""Model metadata resolution.

Looks up per-model limits and other metadata for a fully-qualified
``provider:model`` string against the curated model registry.

This module intentionally stays API-compatible with the old metadata resolver,
but its source data now lives beside modality gates in the model registry.
"""

from __future__ import annotations

from datetime import datetime, timezone
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

from loguru import logger

from app.agent.providers.model_registry import load_model_registry


@dataclass(frozen=True)
class ModelLimits:
    """Token limits for one model.

    ``context_length`` is the total input-plus-output window;
    ``max_input_tokens`` and ``max_completion_tokens`` are the directional
    limits when the provider publishes them. ``None`` means unknown, not
    unlimited.
    """

    context_length: int | None = None
    max_input_tokens: int | None = None
    max_completion_tokens: int | None = None

    def to_dict(self) -> dict[str, int | None]:
        return {
            "context_length": self.context_length,
            "max_input_tokens": self.max_input_tokens,
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
class OffPeakPricing:
    """Time-of-day rate adjustment for providers with off-peak billing.

    ``multiplier`` scales every rate (input/output/cache_read/cache_write)
    when ``at`` falls OUTSIDE every ``peak_windows`` entry. Each window is
    ``(weekday, start_hour, end_hour)`` in UTC, end exclusive — e.g. DeepSeek
    bills half price off-peak, with peak hours Monday–Friday 01:00–04:00 and
    06:00–10:00 UTC (``weekday`` 0 = Monday).
    """

    multiplier: float
    peak_windows: tuple[tuple[int, int, int], ...]

    def is_off_peak(self, at: datetime) -> bool:
        if at.tzinfo is None:
            at = at.replace(tzinfo=timezone.utc)
        at = at.astimezone(timezone.utc)
        for weekday, start_hour, end_hour in self.peak_windows:
            if at.weekday() == weekday and start_hour <= at.hour < end_hour:
                return False
        return True

    def apply(self, cost: ModelCost) -> ModelCost:
        scale = self.multiplier
        return ModelCost(
            input=cost.input * scale if cost.input is not None else None,
            output=cost.output * scale if cost.output is not None else None,
            cache_read=(
                cost.cache_read * scale if cost.cache_read is not None else None
            ),
            cache_write=(
                cost.cache_write * scale if cost.cache_write is not None else None
            ),
        )


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
    if endpoint_variant not in {"default", "openai"} or api_family not in {
        "chat_completions",
        "generate_content",
        "messages",
        "responses",
    }:
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
            max_input_tokens=_positive_int(
                limits_spec.get("max_input_tokens"), "limits.max_input_tokens"
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


#: Provider-level time-of-day pricing rules, keyed by registry provider id
#: (the ``provider:`` prefix of a fully-qualified model id). Only providers
#: whose API publishes an off-peak billing schedule need an entry.
#:
#: DeepSeek: off-peak rates are half of the peak rates; peak hours are
#: 01:00–04:00 and 06:00–10:00 UTC, Monday through Friday (weekday 0 = Mon).
_OFF_PEAK_RULES: dict[str, OffPeakPricing] = {
    "deepseek": OffPeakPricing(
        multiplier=0.5,
        peak_windows=(
            (0, 1, 4),
            (0, 6, 10),
            (1, 1, 4),
            (1, 6, 10),
            (2, 1, 4),
            (2, 6, 10),
            (3, 1, 4),
            (3, 6, 10),
            (4, 1, 4),
            (4, 6, 10),
        ),
    ),
}

# DeepSeek's published prices are not always updated in models.dev promptly.
# Keep the official V4 price table here so estimates use the vendor's rates
# (values are USD per 1M tokens; the off-peak rule above halves them).
_DEEPSEEK_COSTS: dict[str, ModelCost] = {
    "deepseek-v4-flash": ModelCost(input=0.44, output=1.32, cache_read=0.014),
    "deepseek-v4-pro": ModelCost(input=1.32, output=3.96, cache_read=0.044),
    "deepseek-v4-flash-vision-exp": ModelCost(
        input=0.44, output=1.32, cache_read=0.014
    ),
}

#: Preferred provider order for resolving a bare model id (no ``provider:``
#: prefix) against the registry. The official vendor for a model family
#: should win over reseller proxies, which mark prices up or omit them.
_BARE_ID_PROVIDER_PREFERENCE = (
    "openai",
    "anthropic",
    "google",
    "googlegenai",
    "deepseek",
    "xai",
    "zai",
    "codex",
    "meta",
    "mistral",
    "groq",
)


def _resolve_bare_model_metadata(
    lowered: str, reg: dict[str, ModelMetadata]
) -> ModelMetadata | None:
    """Resolve a bare model id to the most useful registry entry.

    The old first-match scan returned whichever reseller proxy happened to
    sort first — for ``claude-sonnet-4-5`` that was a price-less stub, so the
    whole estimated cost (including Anthropic's cache_write bucket) silently
    vanished. Prefer the official vendor's priced entry, then any priced
    entry, then the first match.
    """
    for provider in _BARE_ID_PROVIDER_PREFERENCE:
        meta = reg.get(f"{provider}:{lowered}")
        if meta is not None and (
            meta.cost.input is not None or meta.cost.output is not None
        ):
            return meta
    for key, meta in reg.items():
        if key.endswith(f":{lowered}") and (
            meta.cost.input is not None or meta.cost.output is not None
        ):
            return meta
    for key, meta in reg.items():
        if key.endswith(f":{lowered}"):
            return meta
    return None


def get_model_metadata(model_id: str | None) -> ModelMetadata:
    """Return metadata for a fully-qualified ``provider:model`` string."""
    if not model_id:
        return _DEFAULT
    lowered = model_id.lower()
    reg = _registry()
    if lowered in reg:
        return reg[lowered]
    if ":" not in lowered:
        resolved = _resolve_bare_model_metadata(lowered, reg)
        if resolved is not None:
            return resolved
    return _DEFAULT


def get_model_limits(model_id: str | None) -> ModelLimits:
    """Return token limits for a fully-qualified ``provider:model`` string."""
    return get_model_metadata(model_id).limits


def get_model_cost(model_id: str | None) -> ModelCost:
    """Return pricing metadata for a fully-qualified ``provider:model`` string."""
    if model_id and ":" in model_id:
        provider, model = model_id.split(":", 1)
        if provider.lower() == "deepseek":
            official = _DEEPSEEK_COSTS.get(model.lower())
            if official is not None:
                return official
    return get_model_metadata(model_id).cost


def get_cost_at(model_id: str | None, at: datetime) -> ModelCost:
    """Return the model's cost at time ``at``, applying off-peak adjustments.

    Only the estimate path consults this — metadata lookups stay
    time-independent via :func:`get_model_cost`. The adjustment is keyed on
    the ``provider:`` prefix, so a bare model id (which resolves via the
    suffix fallback) is never mis-attributed to a provider rule.
    """
    cost = get_model_cost(model_id)
    if not model_id or ":" not in model_id:
        return cost
    rule = _OFF_PEAK_RULES.get(model_id.split(":", 1)[0].lower())
    if rule is None or not rule.is_off_peak(at):
        return cost
    return rule.apply(cost)


def get_model_thinking_levels(model_id: str | None) -> tuple[str, ...]:
    """Return supported thinking levels for a fully-qualified model ID."""
    return get_model_metadata(model_id).thinking.levels


def get_model_transport(model_id: str | None) -> ModelTransport | None:
    """Return a normalized transport selection when the catalog defines one."""
    return get_model_metadata(model_id).transport
