"""Request and response schemas for ``/api/settings`` endpoints."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class SandboxSettingsBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    denied_patterns: list[str] = Field(default_factory=list)


class TitleGenerationSettingsBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool
    model: str = ""
    wait_timeout_seconds: float = 3.0


class MultimodalSectionBody(BaseModel):
    model_config = ConfigDict(extra="allow")

    model: str = ""


class MultimodalSettingsBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    image: MultimodalSectionBody = Field(default_factory=MultimodalSectionBody)
    video: MultimodalSectionBody = Field(default_factory=MultimodalSectionBody)


# ── Providers (Settings → Providers tab) ────────────────────────────────────


class ProviderInfo(BaseModel):
    """One catalog row enriched with the user's current configuration state."""

    model_config = ConfigDict(extra="forbid")

    id: str
    label: str
    description: str
    kind: str  # "api_key" | "oauth" | "local" | "cloud_creds"
    credentials: list[dict[str, object]] = Field(default_factory=list)
    saved_credentials: dict[str, str] = Field(default_factory=dict)
    env_var: str = ""
    env_vars: list[str] = Field(default_factory=list)
    oauth_command: str = ""
    docs_url: str = ""
    # State the UI uses to decide whether to render "Connected" or a CTA.
    is_configured: bool = False
    # Static credential/config presence, before reachability probes. This lets
    # the UI distinguish "not set up" from "saved but currently unreachable".
    is_saved: bool = False
    # True when live model discovery reached the provider. False means saved
    # credentials/tokens exist, but the provider could not be reached now.
    is_reachable: bool | None = None
    # Last explicitly listed provider-local model IDs cached in settings.yaml.
    cached_models: list[str] = Field(default_factory=list)
    # Provider-local model IDs shown in normal model pickers. Empty means all
    # cached models for this provider are visible.
    visible_models: list[str] = Field(default_factory=list)
    # When True the provider is configured but intentionally hidden from all
    # model pickers (user has disconnected it).
    is_disconnected: bool = False
    # Whether this provider honours service_tier="fast" (fast/priority mode).
    supports_fast_mode: bool = False


class ProvidersListBody(BaseModel):
    """``GET /api/settings/providers`` response."""

    model_config = ConfigDict(extra="forbid")

    providers: list[ProviderInfo]
    has_any_configured: bool


class ProviderModelsResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: str
    # Just agent-usable text-chat model IDs. We deliberately don't ship per-model capability
    # flags here: the prefix-based resolver is too coarse for a
    # per-model UI badge ("text-embedding-3-small" would show vision
    # because `openai:` is vision-true), and a curated registry would be
    # stale by the time the user upgraded the app. If capability ever
    # needs to surface on this endpoint, build it from a runtime-fetched
    # registry — see ``documents/techdebts/model-capabilities-registry.md``.
    models: list[str] = Field(default_factory=list)
    source: Literal["provider"]


class ProviderUsageWindow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    used_percent: float
    window_minutes: int | None = None
    resets_at: int | None = None


class ProviderUsageCredits(BaseModel):
    model_config = ConfigDict(extra="forbid")

    has_credits: bool
    unlimited: bool
    balance: str | None = None


class ProviderUsageLimit(BaseModel):
    model_config = ConfigDict(extra="forbid")

    limit_id: str | None = None
    limit_name: str | None = None
    primary: ProviderUsageWindow | None = None
    secondary: ProviderUsageWindow | None = None
    credits: ProviderUsageCredits | None = None
    plan_type: str | None = None
    rate_limit_reached_type: str | None = None


class ProviderUsageResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: str
    limits: list[ProviderUsageLimit] = Field(default_factory=list)


class ProviderUsageSummaryItem(BaseModel):
    """One connected, usage-capable provider's snapshot for the tray/menu."""

    model_config = ConfigDict(extra="forbid")

    provider: str
    label: str
    # "ok"                  — ``usage`` is populated.
    # "credentials_missing" — provider claims to be configured but the
    #                         token/key could not be loaded (e.g. deleted
    #                         out-of-band since the last catalog scan).
    # "unavailable"         — upstream request failed (network, 5xx, auth
    #                         expired and refresh failed, parse error).
    status: Literal["ok", "credentials_missing", "unavailable"] = "ok"
    error: str | None = None
    usage: ProviderUsageResponse | None = None
    # True when this item was served from the last-known-good snapshot
    # because the live fetch failed transiently. The tray renders these
    # with a "last known" marker instead of an error row.
    stale: bool = False


class ProviderUsageSummaryBody(BaseModel):
    """``GET /api/settings/providers/usage-summary`` response.

    Aggregates live usage for every *connected* provider that exposes a
    usage endpoint (builtin OAuth providers and provider plugins that
    define ``get_usage``). Powers the macOS tray "Usage Limits" submenu,
    which polls this single endpoint instead of fanning out one request
    per provider.
    """

    model_config = ConfigDict(extra="forbid")

    items: list[ProviderUsageSummaryItem] = Field(default_factory=list)
    checked_at: int
    # True when this payload was served from the short-lived server-side
    # cache rather than a fresh upstream fetch. Informational only.
    cached: bool = False


class ProviderTestRequest(BaseModel):
    """``POST /api/settings/providers/{id}/test`` request body."""

    model_config = ConfigDict(extra="forbid")

    # ``api_key`` lets the UI verify a key *before* persisting it. Empty
    # string means "use the already-saved key" — useful for re-testing
    # an existing config.
    api_key: str = ""
    model: str
    # Multi-field providers (vertexai) pass their extras here.
    extra: dict[str, str] = Field(default_factory=dict)


class ProviderModelsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    api_key: str = ""
    extra: dict[str, str] = Field(default_factory=dict)


class ProviderTestResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ok: bool
    latency_ms: int | None = None
    error: str | None = None


class ProviderSaveRequest(BaseModel):
    """``PUT /api/settings/providers/{id}`` request body."""

    model_config = ConfigDict(extra="forbid")

    api_key: str = ""
    extra: dict[str, str] = Field(default_factory=dict)


class ProviderSaveResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    saved: bool
    # Convenience: whether this save call resulted in the first
    # configured provider (frontend uses this to decide whether to
    # trigger the seed installer afterward).
    is_first_provider: bool = False


class ProviderVisibleModelsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    models: list[str] = Field(default_factory=list)


class ProviderVisibleModelsResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: str
    visible_models: list[str] = Field(default_factory=list)


class ProviderDisconnectRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    disconnected: bool


class ProviderDisconnectResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: str
    is_disconnected: bool


class SeedInstallRequest(BaseModel):
    """``POST /api/settings/seed`` request body."""

    model_config = ConfigDict(extra="forbid")

    # Optional ``provider:model`` string that substitutes for
    # ``__PROVIDER_MODEL__`` in every seeded agent .md. Empty/null means the
    # seed keeps its internal placeholder until the user configures a model.
    provider_model: str | None = None

    @field_validator("provider_model")
    @classmethod
    def _validate_provider_model(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            return None
        if ":" not in value:
            raise ValueError("provider_model must use '<provider>:<model>' format")
        return value


class SeedInstallResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    agents_written: list[str] = Field(default_factory=list)
    skills_written: list[str] = Field(default_factory=list)
    configs_written: list[str] = Field(default_factory=list)
    agents_removed: list[str] = Field(default_factory=list)
    source: str  # "local", "tag:v0.x.y", or "branch:main"
