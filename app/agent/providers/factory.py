"""Provider factory — resolves a ``"provider:model"`` string to an
:class:`LLMProviderBase` instance.

One ``match`` over the prefix before ``:``. Adding a provider means one
new ``case`` and one entry to :data:`SUPPORTED_PROVIDERS`.

Usage::

    from app.agent.providers.factory import build_provider

    provider = build_provider(
        "openai:gpt-5",
        model_kwargs={"temperature": 0.2},
    )
"""

from __future__ import annotations

import os
from typing import Protocol, cast

from pydantic import SecretStr

from app.agent.providers.anthropic import AnthropicProvider
from app.agent.providers.base import LLMProviderBase
from app.agent.providers.bedrock import BedrockProvider
from app.agent.providers.codex import CodexProvider
from app.agent.providers.copilot import CopilotProvider
from app.agent.providers.deepseek import DeepSeekProvider
from app.agent.providers.googlegenai import GoogleGenAIProvider
from app.agent.providers.ollama import OllamaProvider
from app.agent.providers.openai import ChatCompletionsOnlyProvider, OpenAIProvider
from app.agent.providers.openai.compatible import OPENAI_COMPATIBLE_PROVIDER_SPECS
from app.agent.providers.router9 import Router9Provider
from app.agent.providers.unconfigured import UnconfiguredProviderError
from app.agent.providers.vertexai import VertexAIProvider
from app.agent.providers.xai import XAIProvider
from app.agent.providers.zai import ZAIProvider

# Sorted for stable error output. Keep in sync with the ``match`` below.
SUPPORTED_PROVIDERS: tuple[str, ...] = (
    "anthropic",
    "bedrock",
    "cliproxy",
    "codex",
    "copilot",
    "deepseek",
    "googlegenai",
    "nvidia",
    "ollama",
    "openai",
    "openrouter",
    "router9",
    "vertexai",
    "xai",
    "zai",
)


class ProviderFactory(Protocol):
    """Callable that builds a provider from a 'provider:model' string.

    ``build_provider`` matches this shape; the protocol exists so callers
    (the agent loader, tests) can swap it for a stub.
    """

    def __call__(
        self,
        model_str: str | None,
        model_kwargs: dict[str, object] | None = None,
    ) -> LLMProviderBase: ...


def require_api_key(secret: SecretStr | None, env_var: str, label: str) -> str:
    """Resolve an API key from a Pydantic ``SecretStr`` or env var.

    Raises ``ValueError`` with a uniform message when neither is set.
    """
    if secret is not None:
        try:
            value = secret.get_secret_value()
            if value:
                return value
        except AttributeError:
            # Treat plain strings the same as SecretStr in tests.
            if isinstance(secret, str) and secret:
                return secret
    env_value = os.getenv(env_var, "")
    if env_value:
        return env_value
    raise ValueError(f"{label} API key is required. Set {env_var} in your .env file.")


def _with_provider_name(
    provider: LLMProviderBase, provider_name: str
) -> LLMProviderBase:
    provider.provider_name = provider_name
    return provider


def build_provider(
    model_str: str | None,
    model_kwargs: dict[str, object] | None = None,
) -> LLMProviderBase:
    """Build a provider instance for ``"<provider>:<model>"``.

    Raises:
        ValueError: when *model_str* is empty, malformed, or names an
            unknown provider, or when the required API key for the
            selected provider is missing.
    """
    if not model_str:
        raise ValueError(
            "No model specified. Set 'model' in the agent's .md frontmatter "
            "(format: 'provider:model', e.g. 'googlegenai:gemini-3.1-flash')."
        )
    # Agents seeded with the placeholder token surface as "not configured"
    # rather than the generic invalid-format error — the caller (loader)
    # catches this specifically to substitute an UnconfiguredProvider stub
    # so the agent loads but defers the failure to LLM-call time.
    from app.cli.seed import PROVIDER_MODEL_TOKEN

    if model_str == PROVIDER_MODEL_TOKEN or PROVIDER_MODEL_TOKEN in model_str:
        raise UnconfiguredProviderError()
    if ":" not in model_str:
        raise ValueError(
            f"Invalid model format '{model_str}'. "
            f"Expected 'provider:model' (e.g. 'zai:glm-5-turbo', "
            f"'googlegenai:gemini-3.1-flash')."
        )

    name, model = model_str.split(":", 1)
    kwargs = model_kwargs or {}
    # Local import so tests can ``patch("app.core.config.settings", ...)`` and
    # so importing this module stays cheap (no env-var validation at import).
    from app.core.config import settings as s

    match name:
        case "openai":
            return _with_provider_name(
                OpenAIProvider(
                    api_key=require_api_key(
                        s.OPENAI_API_KEY, "OPENAI_API_KEY", "OpenAI"
                    ),
                    model=model,
                    model_kwargs=kwargs,
                ),
                name,
            )
        case _ if name in OPENAI_COMPATIBLE_PROVIDER_SPECS:
            spec = OPENAI_COMPATIBLE_PROVIDER_SPECS[name]
            configured_key = getattr(s, spec.env_var, None)
            api_key = configured_key
            if not spec.default_api_key:
                api_key = require_api_key(configured_key, spec.env_var, spec.label)
            typed_api_key = cast(str | SecretStr | None, api_key)
            base_url = spec.base_url
            if spec.base_url_env_var:
                base_url = (
                    os.getenv(spec.base_url_env_var)
                    or getattr(s, spec.base_url_env_var, "")
                    or spec.base_url
                )
            if name == "deepseek":
                return _with_provider_name(
                    DeepSeekProvider(
                        api_key=cast(str, typed_api_key),
                        model=model,
                        model_kwargs=kwargs,
                    ),
                    name,
                )
            if name == "xai":
                return _with_provider_name(
                    XAIProvider(
                        api_key=cast(str, typed_api_key),
                        model=model,
                        model_kwargs=kwargs,
                    ),
                    name,
                )
            if name == "ollama":
                return _with_provider_name(
                    OllamaProvider(
                        api_key=typed_api_key,
                        model=model,
                        base_url=base_url,
                        model_kwargs=kwargs,
                    ),
                    name,
                )
            if name == "router9":
                return _with_provider_name(
                    Router9Provider(
                        api_key=cast(str | SecretStr, typed_api_key),
                        model=model,
                        base_url=base_url,
                        model_kwargs=kwargs,
                    ),
                    name,
                )
            return _with_provider_name(
                ChatCompletionsOnlyProvider(
                    api_key=cast(str | SecretStr, typed_api_key),
                    model=model,
                    base_url=base_url,
                    model_kwargs=kwargs,
                ),
                name,
            )
        case "anthropic":
            return _with_provider_name(
                AnthropicProvider(
                    api_key=require_api_key(
                        s.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY", "Anthropic"
                    ),
                    model=model,
                    base_url=os.getenv("ANTHROPIC_BASE_URL")
                    or s.ANTHROPIC_BASE_URL
                    or "https://api.anthropic.com",
                    model_kwargs=kwargs,
                ),
                name,
            )
        case "googlegenai":
            return _with_provider_name(
                GoogleGenAIProvider(
                    api_key=require_api_key(
                        s.GOOGLE_API_KEY, "GOOGLE_API_KEY", "Google"
                    ),
                    model=model,
                    model_kwargs=kwargs,
                ),
                name,
            )
        case "vertexai":
            return _with_provider_name(
                VertexAIProvider(
                    api_key=require_api_key(
                        s.VERTEXAI_API_KEY, "VERTEXAI_API_KEY", "Vertex AI"
                    ),
                    model=model,
                    model_kwargs=kwargs,
                    project=s.GOOGLE_CLOUD_PROJECT,
                    location=s.GOOGLE_CLOUD_LOCATION,
                ),
                name,
            )
        case "copilot":
            # copilot uses OAuth tokens — no API key.
            return _with_provider_name(
                CopilotProvider(model=model, model_kwargs=kwargs), name
            )
        case "codex":
            # codex uses OAuth tokens — no API key.
            return _with_provider_name(
                CodexProvider(model=model, model_kwargs=kwargs), name
            )
        case "zai":
            return _with_provider_name(
                ZAIProvider(
                    api_key=require_api_key(s.ZAI_API_KEY, "ZAI_API_KEY", "ZAI"),
                    model=model,
                    model_kwargs=kwargs,
                ),
                name,
            )
        case "bedrock":
            # Auth: explicit API key pair → named profile → boto3 default chain.
            # Region: AWS_BEDROCK_REGION setting → AWS_DEFAULT_REGION env → us-east-1.
            import os as _os

            access_key: str | None = None
            secret_key: str | None = None
            profile_name = s.AWS_BEDROCK_PROFILE or _os.getenv("AWS_BEDROCK_PROFILE")
            if profile_name is None:
                # Try to pull explicit keys from standard AWS env vars or settings.
                # boto3 reads these env vars natively too, but we support them through
                # settings as well (e.g. set in .env for dev).
                access_key = _os.getenv("AWS_ACCESS_KEY_ID") or None
                secret_key = _os.getenv("AWS_SECRET_ACCESS_KEY") or None
            return _with_provider_name(
                BedrockProvider(
                    model=model,
                    region_name=s.AWS_BEDROCK_REGION
                    or _os.getenv("AWS_BEDROCK_REGION"),
                    profile_name=profile_name,
                    aws_access_key_id=access_key,
                    aws_secret_access_key=secret_key,
                    model_kwargs=kwargs,
                ),
                name,
            )
        case _:
            from app.agent.providers.plugin_registry import (
                ProviderCredentialStore,
                find_provider_plugin,
            )

            plugin = find_provider_plugin(name)
            if plugin is not None:
                from app.agent.providers.plugin_api import ProviderBuildContext

                return _with_provider_name(
                    plugin.factory(
                        ProviderBuildContext(
                            provider_id=name,
                            model=model,
                            model_kwargs=kwargs,
                            credentials=ProviderCredentialStore(name),
                        )
                    ),
                    name,
                )
            raise UnconfiguredProviderError(
                message=(
                    f"Unsupported provider '{name}'. "
                    f"Supported providers: {', '.join(SUPPORTED_PROVIDERS)}"
                )
            )
