from __future__ import annotations

from collections.abc import Iterable

from app.agent.providers import model_metadata

from .constants import PROVIDER_IDS, ZEN_PROVIDER_ID


def model_is_accessible(
    provider_id: str,
    model_id: str,
    *,
    has_credentials: bool,
) -> bool:
    """Return whether the current OpenCode credentials may use a model."""
    if provider_id not in PROVIDER_IDS:
        return True
    if not has_credentials:
        return False
    return not (
        provider_id == ZEN_PROVIDER_ID
        and model_metadata.get_model_cost(f"{ZEN_PROVIDER_ID}:{model_id}").input == 0
    )


def filter_opencode_models_for_access(
    provider_id: str,
    model_ids: Iterable[str],
    *,
    has_credentials: bool,
) -> list[str]:
    """Hide OpenCode models that the current credentials cannot use."""
    if provider_id not in PROVIDER_IDS:
        return list(model_ids)
    if not has_credentials:
        return []
    return [
        model_id
        for model_id in model_ids
        if model_is_accessible(
            provider_id,
            model_id,
            has_credentials=has_credentials,
        )
    ]
