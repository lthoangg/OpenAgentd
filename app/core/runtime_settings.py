from __future__ import annotations

from pathlib import Path

import yaml
from pydantic import BaseModel, ConfigDict, Field

from app.core.config import settings

PROVIDER_MODEL_PLACEHOLDER = "__PROVIDER_MODEL__"


class SummarizationSettings(BaseModel):
    model_config = ConfigDict(extra="ignore")

    # User-supplied token threshold.  ``None`` means "use the auto-computed
    # value (ratio * context_length)".
    # When set and below the auto value, it triggers summarisation earlier.
    # Values >= auto are silently treated as auto.
    prompt_token_threshold: int | None = None


class TitleGenerationSettings(BaseModel):
    model_config = ConfigDict(extra="ignore")

    enabled: bool = True
    model: str | None = None
    wait_timeout_seconds: float = 3.0


class ServerSettings(BaseModel):
    model_config = ConfigDict(extra="ignore")

    host: str = "127.0.0.1"
    port: int = 4082
    access_key: str | None = None


class ProviderUiSettings(BaseModel):
    model_config = ConfigDict(extra="ignore")

    visible_models: list[str] = Field(default_factory=list)
    cached_models: list[str] = Field(default_factory=list)
    last_listed_at: int | None = None
    is_disconnected: bool = False


class RuntimeSettings(BaseModel):
    model_config = ConfigDict(extra="ignore")

    title_generation: TitleGenerationSettings = Field(
        default_factory=TitleGenerationSettings
    )
    summarization: SummarizationSettings = Field(default_factory=SummarizationSettings)
    server: ServerSettings = Field(default_factory=ServerSettings)
    providers: dict[str, ProviderUiSettings] = Field(default_factory=dict)
    lsp: dict[str, list[str]] = Field(default_factory=dict)


def provider_visible_models(provider_id: str) -> list[str]:
    return (
        load_runtime_settings()
        .providers.get(provider_id, ProviderUiSettings())
        .visible_models
    )


def set_provider_visible_models(provider_id: str, models: list[str]) -> None:
    cfg = load_runtime_settings()
    current = cfg.providers.get(provider_id, ProviderUiSettings())
    cleaned = sorted({model.strip() for model in models if model.strip()})
    if cleaned or current.cached_models or current.last_listed_at is not None:
        cfg.providers[provider_id] = current.model_copy(
            update={"visible_models": cleaned}
        )
    else:
        cfg.providers.pop(provider_id, None)
    save_runtime_settings(cfg)


def provider_cached_models(provider_id: str) -> list[str]:
    return (
        load_runtime_settings()
        .providers.get(provider_id, ProviderUiSettings())
        .cached_models
    )


def set_provider_cached_models(provider_id: str, models: list[str]) -> None:
    import time

    cfg = load_runtime_settings()
    current = cfg.providers.get(provider_id, ProviderUiSettings())
    cleaned = sorted({model.strip() for model in models if model.strip()})
    next_settings = current.model_copy(
        update={"cached_models": cleaned, "last_listed_at": int(time.time())}
    )
    if (
        cleaned
        or next_settings.visible_models
        or next_settings.last_listed_at is not None
    ):
        cfg.providers[provider_id] = next_settings
    else:
        cfg.providers.pop(provider_id, None)
    save_runtime_settings(cfg)


def clear_provider_cached_models(provider_id: str) -> None:
    cfg = load_runtime_settings()
    current = cfg.providers.get(provider_id)
    if current is None:
        return
    next_settings = current.model_copy(
        update={"cached_models": [], "last_listed_at": None}
    )
    if next_settings.visible_models:
        cfg.providers[provider_id] = next_settings
    else:
        cfg.providers.pop(provider_id, None)
    save_runtime_settings(cfg)


def provider_is_disconnected(provider_id: str) -> bool:
    return (
        load_runtime_settings()
        .providers.get(provider_id, ProviderUiSettings())
        .is_disconnected
    )


def set_provider_disconnected(provider_id: str, *, disconnected: bool) -> None:
    cfg = load_runtime_settings()
    current = cfg.providers.get(provider_id, ProviderUiSettings())
    updated = current.model_copy(update={"is_disconnected": disconnected})
    # Keep the entry only if it has something worth persisting.
    if (
        updated.is_disconnected
        or updated.visible_models
        or updated.cached_models
        or updated.last_listed_at is not None
    ):
        cfg.providers[provider_id] = updated
    else:
        cfg.providers.pop(provider_id, None)
    save_runtime_settings(cfg)


def runtime_settings_path() -> Path:
    return Path(settings.OPENAGENTD_CONFIG_DIR) / "settings.yaml"


def load_runtime_settings(path: Path | None = None) -> RuntimeSettings:
    resolved = path or runtime_settings_path()
    if not resolved.exists():
        return RuntimeSettings()
    try:
        raw = yaml.safe_load(resolved.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as exc:
        raise ValueError(f"settings.yaml YAML parse error: {exc}") from exc
    if not isinstance(raw, dict):
        raise ValueError("settings.yaml must contain a YAML mapping.")
    return RuntimeSettings.model_validate(raw)


def save_runtime_settings(cfg: RuntimeSettings, path: Path | None = None) -> Path:
    resolved = path or runtime_settings_path()
    resolved.parent.mkdir(parents=True, exist_ok=True)
    # CLI bind/auth state is persisted separately in server.yaml. Keep the
    # field on RuntimeSettings only so older settings.yaml files can migrate.
    data = cfg.model_dump(mode="json", exclude_none=True, exclude={"server"})
    resolved.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
    return resolved


def _seed_model_value(provider_model: str) -> str | None:
    provider_model = provider_model.strip()
    if not provider_model or provider_model == PROVIDER_MODEL_PLACEHOLDER:
        return None
    return provider_model


def ensure_runtime_settings(path: Path, *, provider_model: str) -> bool:
    if path.exists():
        return False
    model = _seed_model_value(provider_model)
    save_runtime_settings(
        RuntimeSettings(
            title_generation=TitleGenerationSettings(model=model),
        ),
        path,
    )
    return True
