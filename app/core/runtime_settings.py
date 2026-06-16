from __future__ import annotations

from pathlib import Path

import yaml
from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.core.config import settings

PROVIDER_MODEL_PLACEHOLDER = "__PROVIDER_MODEL__"


class TitleGenerationSettings(BaseModel):
    model_config = ConfigDict(extra="ignore")

    enabled: bool = True
    model: str | None = None
    wait_timeout_seconds: float = 3.0


class DreamSettings(BaseModel):
    model_config = ConfigDict(extra="ignore")

    enabled: bool = False
    model: str | None = None
    schedule: str = "0 2 * * *"

    @model_validator(mode="after")
    def _validate_model(self) -> "DreamSettings":
        if self.model and ":" not in self.model:
            raise ValueError("Dream model must be 'provider:model'.")
        return self


class MemoryVectorSettings(BaseModel):
    model_config = ConfigDict(extra="ignore")

    enabled: bool = False
    backend: str = "disabled"
    embedding_model: str | None = None
    dim: int | None = None
    index_path: str | None = None


class ServerSettings(BaseModel):
    model_config = ConfigDict(extra="ignore")

    host: str = "127.0.0.1"
    port: int = 4082
    access_key: str | None = None


class ProviderUiSettings(BaseModel):
    model_config = ConfigDict(extra="ignore")

    visible_models: list[str] = Field(default_factory=list)


class RuntimeSettings(BaseModel):
    model_config = ConfigDict(extra="ignore")

    title_generation: TitleGenerationSettings = Field(
        default_factory=TitleGenerationSettings
    )
    dream: DreamSettings = Field(default_factory=DreamSettings)
    memory_vector: MemoryVectorSettings = Field(default_factory=MemoryVectorSettings)
    server: ServerSettings = Field(default_factory=ServerSettings)
    providers: dict[str, ProviderUiSettings] = Field(default_factory=dict)


def provider_visible_models(provider_id: str) -> list[str]:
    return (
        load_runtime_settings()
        .providers.get(provider_id, ProviderUiSettings())
        .visible_models
    )


def set_provider_visible_models(provider_id: str, models: list[str]) -> None:
    cfg = load_runtime_settings()
    cleaned = sorted({model.strip() for model in models if model.strip()})
    if cleaned:
        cfg.providers[provider_id] = ProviderUiSettings(visible_models=cleaned)
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
    data = cfg.model_dump(mode="json", exclude_none=True)
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
            dream=DreamSettings(model=model),
        ),
        path,
    )
    return True
