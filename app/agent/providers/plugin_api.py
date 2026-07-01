from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

from app.agent.providers.base import LLMProviderBase
from app.api.schemas.settings import ProviderUsageResponse

ProviderKind = Literal["api_key", "oauth"]
OAuthEventSink = Callable[[str, dict[str, Any]], None]


class CredentialStore(Protocol):
    def get(self, name: str, default: str = "") -> str: ...

    def token_path(self, filename: str) -> str: ...


@dataclass(frozen=True)
class ProviderCredentialField:
    name: str
    label: str
    secret: bool = True
    required: bool = True
    placeholder: str = ""


@dataclass(frozen=True)
class ProviderBuildContext:
    provider_id: str
    model: str
    model_kwargs: dict[str, object]
    credentials: CredentialStore


@dataclass(frozen=True)
class ProviderPlugin:
    id: str
    label: str
    description: str
    kind: ProviderKind
    factory: Callable[[ProviderBuildContext], LLMProviderBase]
    credentials: list[ProviderCredentialField] = field(default_factory=list)
    login: Callable[[OAuthEventSink | None], None] | None = None
    oauth_callback: Callable[[str, OAuthEventSink | None], None] | None = None
    is_configured: Callable[[CredentialStore], bool] | None = None
    discover_models: Callable[[CredentialStore], Awaitable[list[str]]] | None = None
    get_usage: Callable[[CredentialStore], Awaitable[ProviderUsageResponse]] | None = (
        None
    )
    models_dev_provider_id: str = ""
    metadata_source_provider: str = ""
    model_registry_aliases: dict[str, str] = field(default_factory=dict)
    docs_url: str = ""
    oauth_command: str = ""
    supports_fast_mode: bool = False


def credential_map(fields: list[ProviderCredentialField]) -> list[dict[str, object]]:
    return [
        {
            "name": field.name,
            "label": field.label,
            "secret": field.secret,
            "required": field.required,
            "placeholder": field.placeholder,
        }
        for field in fields
    ]


def values_from_mapping(
    mapping: Mapping[str, str], fields: list[ProviderCredentialField]
) -> dict[str, str]:
    return {
        field.name: mapping[field.name] for field in fields if mapping.get(field.name)
    }
