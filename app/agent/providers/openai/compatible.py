from __future__ import annotations

from dataclasses import dataclass

from app.agent.providers.opencode.constants import (
    GO_API_KEY_ENV,
    GO_BASE_URL,
    GO_LABEL,
    GO_PROVIDER_ID,
    PUBLIC_API_KEY,
    ZEN_API_KEY_ENV,
    ZEN_BASE_URL,
    ZEN_LABEL,
    ZEN_PROVIDER_ID,
)


@dataclass(frozen=True)
class OpenAICompatibleProviderSpec:
    provider_id: str
    label: str
    env_var: str
    base_url: str
    base_url_env_var: str | None = None
    default_api_key: str = ""


OPENAI_COMPATIBLE_PROVIDER_SPECS: dict[str, OpenAICompatibleProviderSpec] = {
    ZEN_PROVIDER_ID: OpenAICompatibleProviderSpec(
        provider_id=ZEN_PROVIDER_ID,
        label=ZEN_LABEL,
        env_var=ZEN_API_KEY_ENV,
        base_url=ZEN_BASE_URL,
        default_api_key=PUBLIC_API_KEY,
    ),
    GO_PROVIDER_ID: OpenAICompatibleProviderSpec(
        provider_id=GO_PROVIDER_ID,
        label=GO_LABEL,
        env_var=GO_API_KEY_ENV,
        base_url=GO_BASE_URL,
    ),
    "openrouter": OpenAICompatibleProviderSpec(
        provider_id="openrouter",
        label="OpenRouter",
        env_var="OPENROUTER_API_KEY",
        base_url="https://openrouter.ai/api/v1",
    ),
    "nvidia": OpenAICompatibleProviderSpec(
        provider_id="nvidia",
        label="NVIDIA",
        env_var="NVIDIA_API_KEY",
        base_url="https://integrate.api.nvidia.com/v1",
    ),
    "router9": OpenAICompatibleProviderSpec(
        provider_id="router9",
        label="9Router",
        env_var="ROUTER9_API_KEY",
        base_url="http://localhost:20128/v1",
        base_url_env_var="ROUTER9_BASE_URL",
    ),
    "cliproxy": OpenAICompatibleProviderSpec(
        provider_id="cliproxy",
        label="CLIProxyAPI",
        env_var="CLIPROXY_API_KEY",
        base_url="http://localhost:8317/v1",
        base_url_env_var="CLIPROXY_BASE_URL",
    ),
    "ollama": OpenAICompatibleProviderSpec(
        provider_id="ollama",
        label="Ollama",
        env_var="OLLAMA_API_KEY",
        base_url="http://localhost:11434/v1",
        base_url_env_var="OLLAMA_BASE_URL",
        default_api_key="ollama",
    ),
    "xai": OpenAICompatibleProviderSpec(
        provider_id="xai",
        label="xAI",
        env_var="XAI_API_KEY",
        base_url="https://api.x.ai/v1",
    ),
    "deepseek": OpenAICompatibleProviderSpec(
        provider_id="deepseek",
        label="DeepSeek",
        env_var="DEEPSEEK_API_KEY",
        base_url="https://api.deepseek.com/v1",
    ),
}
