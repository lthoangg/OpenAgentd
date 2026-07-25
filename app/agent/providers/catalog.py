"""Single source of truth for the LLM provider catalog.

The provider settings API and desktop/web UI consume this catalog. Adding a
new provider means one
entry here plus a new ``case`` branch in
:func:`app.agent.providers.factory.build_provider`.

The catalog is intentionally a plain dict with one row per provider —
NOT a class hierarchy — because the data shape is uniform and the
frontend consumes it as JSON.
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict

from app.agent.providers.plugin_api import credential_map

ProviderKind = Literal["api_key", "oauth", "local", "cloud_creds"]


class ProviderEntry(TypedDict, total=False):
    """One provider's metadata.

    ``kind`` decides how the UI collects credentials:

    - ``api_key`` — single text input for ``env_var``.
    - ``oauth`` — browser/device flow handled by
      :mod:`app.cli.commands.auth`. Surfaces a "Connect" button.
    - ``local`` — no credentials needed (e.g. Ollama daemon on
      127.0.0.1). UI shows a connection status instead of inputs.
    - ``cloud_creds`` — needs more than one field (e.g. Vertex AI:
      project + location + gcloud auth). UI renders the field list
      from ``env_vars``.

    """

    id: str
    label: str
    description: str
    kind: ProviderKind
    env_var: str  # primary env var for api_key providers
    env_vars: list[str]  # multi-field providers (vertexai)
    credentials: list[dict[str, object]]
    oauth_command: str  # CLI fallback hint for oauth providers
    docs_url: str  # link to provider's API key dashboard
    models_dev_provider_id: str  # provider id used by models.dev when different
    metadata_source_provider: str  # source provider for same-model-id metadata aliases
    model_registry_aliases: dict[str, str]  # target model -> source provider:model
    supports_fast_mode: bool  # whether the provider honours service_tier="fast"
    supports_prompt_cache_key: bool  # whether the provider honours prompt_cache_key


_CATALOG: list[ProviderEntry] = [
    {
        "id": "anthropic",
        "label": "Anthropic Claude",
        "description": "Claude API via Anthropic Messages.",
        "kind": "api_key",
        "env_var": "ANTHROPIC_API_KEY",
        "supports_fast_mode": True,
        "models_dev_provider_id": "anthropic",
        "credentials": [
            {
                "name": "ANTHROPIC_API_KEY",
                "label": "Anthropic API key",
                "secret": True,
                "required": True,
                "placeholder": "sk-ant-...",
            },
            {
                "name": "ANTHROPIC_BASE_URL",
                "label": "Base URL",
                "secret": False,
                "required": False,
                "placeholder": "https://api.anthropic.com",
            },
        ],
        "docs_url": "https://console.anthropic.com/settings/keys",
    },
    {
        "id": "googlegenai",
        "label": "Google Gemini",
        "description": "Google AI Studio — free tier available.",
        "kind": "api_key",
        "env_var": "GOOGLE_API_KEY",
        "supports_fast_mode": True,
        "models_dev_provider_id": "google",
        "docs_url": "https://aistudio.google.com/apikey",
    },
    {
        "id": "openai",
        "label": "OpenAI",
        "description": "GPT-5.x, GPT-4.1, etc.",
        "kind": "api_key",
        "env_var": "OPENAI_API_KEY",
        "supports_fast_mode": True,
        "docs_url": "https://platform.openai.com/api-keys",
    },
    {
        "id": "openrouter",
        "label": "OpenRouter",
        "description": "Many models, free tiers available.",
        "kind": "api_key",
        "env_var": "OPENROUTER_API_KEY",
        "models_dev_provider_id": "openrouter",
        "docs_url": "https://openrouter.ai/keys",
    },
    {
        "id": "zai",
        "label": "Z.AI / GLM",
        "description": "Z.AI's GLM-5 family.",
        "kind": "api_key",
        "env_var": "ZAI_API_KEY",
        "models_dev_provider_id": "zai",
        "docs_url": "https://z.ai/manage-apikey/apikey-list",
    },
    {
        "id": "nvidia",
        "label": "NVIDIA NIM",
        "description": "NVIDIA-hosted open models.",
        "kind": "api_key",
        "env_var": "NVIDIA_API_KEY",
        "models_dev_provider_id": "nvidia",
        "docs_url": "https://build.nvidia.com",
    },
    {
        "id": "xai",
        "label": "xAI Grok",
        "description": "xAI's Grok family.",
        "kind": "api_key",
        "env_var": "XAI_API_KEY",
        "models_dev_provider_id": "xai",
        "docs_url": "https://console.x.ai",
    },
    {
        "id": "grok",
        "label": "Grok Build",
        "description": "Use your Grok subscription through Grok Build OAuth.",
        "kind": "oauth",
        "env_var": "",
        # xAI's Responses API routes requests sharing a prompt_cache_key to
        # the same backend server, which is required to hit its per-server
        # prefix KV cache (a byte-stable message prefix alone is necessary
        # but not sufficient).
        # https://docs.x.ai/developers/advanced-api-usage/prompt-caching/maximizing-cache-hits
        "supports_prompt_cache_key": True,
        "metadata_source_provider": "xai",
        "oauth_command": "openagentd auth grok",
        "docs_url": "https://docs.x.ai/build/overview",
    },
    {
        "id": "deepseek",
        "label": "DeepSeek",
        "description": "DeepSeek's direct API.",
        "kind": "api_key",
        "env_var": "DEEPSEEK_API_KEY",
        "models_dev_provider_id": "deepseek",
        "docs_url": "https://platform.deepseek.com/api_keys",
    },
    {
        "id": "router9",
        "label": "9Router",
        "description": "Local proxy aggregating 40+ providers.",
        "kind": "api_key",
        "env_var": "ROUTER9_API_KEY",
        "docs_url": "https://github.com/decolua/9router",
    },
    {
        "id": "cliproxy",
        "label": "CLIProxyAPI",
        "description": "Local proxy for Gemini CLI / Codex / Claude Code OAuth.",
        "kind": "api_key",
        "env_var": "CLIPROXY_API_KEY",
        "docs_url": "https://github.com/luispater/CLIProxyAPI",
    },
    {
        "id": "ollama",
        "label": "Ollama (local)",
        "description": "Run models locally with the Ollama daemon.",
        "kind": "local",
        "env_var": "OLLAMA_API_KEY",
        "docs_url": "https://ollama.com/library",
    },
    {
        "id": "copilot",
        "label": "GitHub Copilot",
        "description": "Use your Copilot subscription — OAuth, no API key.",
        "kind": "oauth",
        "env_var": "",
        "models_dev_provider_id": "github-copilot",
        "oauth_command": "openagentd auth copilot",
        "docs_url": "https://github.com/features/copilot",
    },
    {
        "id": "codex",
        "label": "OpenAI Codex",
        "description": "Use your ChatGPT subscription via Codex OAuth.",
        "kind": "oauth",
        "env_var": "",
        "supports_fast_mode": True,
        "supports_prompt_cache_key": True,
        "metadata_source_provider": "openai",
        "oauth_command": "openagentd auth codex",
        "docs_url": "https://platform.openai.com/docs/codex",
    },
    {
        "id": "bedrock",
        "label": "AWS Bedrock",
        "description": "AWS Bedrock Mantle using a bearer token or AWS profile. Region defaults to us-east-1.",
        "kind": "cloud_creds",
        "env_var": "",
        "models_dev_provider_id": "amazon-bedrock",
        "env_vars": [
            "AWS_BEDROCK_REGION",
            "AWS_BEDROCK_PROFILE",
            "AWS_BEARER_TOKEN_BEDROCK",
        ],
        "credentials": [
            {
                "name": "AWS_BEDROCK_REGION",
                "label": "AWS Bedrock Region",
                "secret": False,
                "required": False,
                "placeholder": "us-east-1",
            },
            {
                "name": "AWS_BEDROCK_PROFILE",
                "label": "AWS Profile",
                "secret": False,
                "required": False,
                "placeholder": "default",
            },
            {
                "name": "AWS_BEARER_TOKEN_BEDROCK",
                "label": "Bedrock API Key",
                "secret": True,
                "required": False,
                "placeholder": "••••••••",
            },
        ],
        "docs_url": "https://docs.aws.amazon.com/bedrock/latest/userguide/setting-up.html",
    },
    {
        "id": "vertexai",
        "label": "Google Vertex AI",
        "description": "Google Cloud's enterprise-grade Gemini.",
        "kind": "cloud_creds",
        "env_var": "",
        "supports_fast_mode": True,
        "models_dev_provider_id": "google-vertex",
        "env_vars": ["GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"],
        "docs_url": "https://cloud.google.com/vertex-ai/docs/start/cloud-environment",
    },
]


def builtin_providers() -> list[ProviderEntry]:
    """Return built-in providers without loading user plugins."""
    return list(_CATALOG)


def all_providers() -> list[ProviderEntry]:
    """Return the full catalog in display order."""
    entries = builtin_providers()
    builtins = {entry["id"] for entry in entries}
    from app.agent.providers.plugin_registry import provider_plugins

    for plugin in provider_plugins().values():
        if plugin.id in builtins:
            continue
        entry: ProviderEntry = {
            "id": plugin.id,
            "label": plugin.label,
            "description": plugin.description,
            "kind": plugin.kind,
            "env_var": plugin.credentials[0].name if plugin.credentials else "",
            "env_vars": [field.name for field in plugin.credentials],
            "oauth_command": plugin.oauth_command,
            "docs_url": plugin.docs_url,
            "models_dev_provider_id": plugin.models_dev_provider_id,
            "metadata_source_provider": plugin.metadata_source_provider,
            "model_registry_aliases": dict(plugin.model_registry_aliases),
            "supports_fast_mode": plugin.supports_fast_mode,
            "supports_prompt_cache_key": plugin.supports_prompt_cache_key,
        }
        entry["credentials"] = credential_map(plugin.credentials)
        entries.append(entry)
    return entries


def find(provider_id: str) -> ProviderEntry | None:
    """Return one entry by ``id`` or None if not in the catalog."""
    for entry in all_providers():
        if entry["id"] == provider_id:
            return entry
    return None


def runtime_model_metadata_overlay() -> dict[str, dict[str, Any]]:
    """Return provider-owned metadata that overrides shared catalog aliases."""
    from app.agent.providers.codex.catalog import (
        cached_codex_catalog,
        model_registry_overlay,
    )

    return model_registry_overlay(cached_codex_catalog())


def refresh_runtime_model_metadata(*, force: bool = True) -> None:
    """Refresh provider-owned runtime model metadata."""
    from app.agent.providers.codex.catalog import load_codex_catalog

    load_codex_catalog(force=force)


# Exported so provider configuration surfaces share the same env-var mapping.
PROVIDER_KEY_VAR: dict[str, str] = {
    entry["id"]: entry["env_var"] for entry in _CATALOG if entry.get("env_var")
}
