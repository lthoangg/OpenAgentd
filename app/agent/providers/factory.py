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
from typing import Protocol

from pydantic import SecretStr

from app.agent.providers.base import LLMProviderBase
from app.agent.providers.bedrock import BedrockProvider
from app.agent.providers.codex import CodexProvider
from app.agent.providers.copilot import CopilotProvider
from app.agent.providers.deepseek import DeepSeekProvider
from app.agent.providers.geminicli import GeminiCLIProvider
from app.agent.providers.googlegenai import GoogleGenAIProvider
from app.agent.providers.ollama import OllamaProvider
from app.agent.providers.openai import OpenAIProvider
from app.agent.providers.vertexai import VertexAIProvider
from app.agent.providers.xai import XAIProvider
from app.agent.providers.zai import ZAIProvider

# Sorted for stable error output. Keep in sync with the ``match`` below.
SUPPORTED_PROVIDERS: tuple[str, ...] = (
    "bedrock",
    "cliproxy",
    "codex",
    "copilot",
    "deepseek",
    "geminicli",
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
            return OpenAIProvider(
                api_key=require_api_key(s.OPENAI_API_KEY, "OPENAI_API_KEY", "OpenAI"),
                model=model,
                model_kwargs=kwargs,
            )
        case "openrouter":
            return OpenAIProvider(
                api_key=require_api_key(
                    s.OPENROUTER_API_KEY, "OPENROUTER_API_KEY", "OpenRouter"
                ),
                model=model,
                base_url="https://openrouter.ai/api/v1",
                model_kwargs=kwargs,
            )
        case "nvidia":
            return OpenAIProvider(
                api_key=require_api_key(s.NVIDIA_API_KEY, "NVIDIA_API_KEY", "NVIDIA"),
                model=model,
                base_url="https://integrate.api.nvidia.com/v1",
                model_kwargs=kwargs,
            )
        case "router9":
            # 9Router (https://github.com/decolua/9router) — local OpenAI-compatible
            # proxy. Default port 20128; override with ROUTER9_BASE_URL.
            return OpenAIProvider(
                api_key=require_api_key(
                    s.ROUTER9_API_KEY, "ROUTER9_API_KEY", "9Router"
                ),
                model=model,
                base_url=os.getenv("ROUTER9_BASE_URL")
                or s.ROUTER9_BASE_URL
                or "http://localhost:20128/v1",
                model_kwargs=kwargs,
            )
        case "cliproxy":
            # CLIProxyAPI — wraps Gemini CLI / Codex / Claude Code as
            # OpenAI-compatible. Default port 8317; override with CLIPROXY_BASE_URL.
            return OpenAIProvider(
                api_key=require_api_key(
                    s.CLIPROXY_API_KEY, "CLIPROXY_API_KEY", "CLIProxyAPI"
                ),
                model=model,
                base_url=os.getenv("CLIPROXY_BASE_URL")
                or s.CLIPROXY_BASE_URL
                or "http://localhost:8317/v1",
                model_kwargs=kwargs,
            )
        case "googlegenai":
            return GoogleGenAIProvider(
                api_key=require_api_key(s.GOOGLE_API_KEY, "GOOGLE_API_KEY", "Google"),
                model=model,
                model_kwargs=kwargs,
            )
        case "geminicli":
            # geminicli reads OAuth files itself — no API key.
            return GeminiCLIProvider(model=model, model_kwargs=kwargs)
        case "vertexai":
            return VertexAIProvider(
                api_key=require_api_key(
                    s.VERTEXAI_API_KEY, "VERTEXAI_API_KEY", "Vertex AI"
                ),
                model=model,
                model_kwargs=kwargs,
                project=s.GOOGLE_CLOUD_PROJECT,
                location=s.GOOGLE_CLOUD_LOCATION,
            )
        case "copilot":
            # copilot uses OAuth tokens — no API key.
            return CopilotProvider(model=model, model_kwargs=kwargs)
        case "codex":
            # codex uses OAuth tokens — no API key.
            return CodexProvider(model=model, model_kwargs=kwargs)
        case "xai":
            return XAIProvider(
                api_key=require_api_key(s.XAI_API_KEY, "XAI_API_KEY", "xAI"),
                model=model,
                model_kwargs=kwargs,
            )
        case "deepseek":
            return DeepSeekProvider(
                api_key=require_api_key(
                    s.DEEPSEEK_API_KEY, "DEEPSEEK_API_KEY", "DeepSeek"
                ),
                model=model,
                model_kwargs=kwargs,
            )
        case "ollama":
            # Local Ollama daemon. OLLAMA_API_KEY defaults to "ollama" so
            # the OpenAI SDK's required Authorization header is satisfied;
            # the daemon ignores it. Override OLLAMA_BASE_URL when the
            # daemon runs on another host/port. Cloud models are reachable
            # through the same daemon with the "-cloud" suffix once the
            # user has run "ollama signin".
            return OllamaProvider(
                api_key=require_api_key(s.OLLAMA_API_KEY, "OLLAMA_API_KEY", "Ollama"),
                model=model,
                base_url=os.getenv("OLLAMA_BASE_URL")
                or s.OLLAMA_BASE_URL
                or "http://localhost:11434/v1",
                model_kwargs=kwargs,
            )
        case "zai":
            return ZAIProvider(
                api_key=require_api_key(s.ZAI_API_KEY, "ZAI_API_KEY", "ZAI"),
                model=model,
                model_kwargs=kwargs,
            )
        case "bedrock":
            # Auth: explicit API key pair → named profile → boto3 default chain.
            # Region: AWS_BEDROCK_REGION setting → AWS_DEFAULT_REGION env → us-east-1.
            access_key: str | None = None
            secret_key: str | None = None
            if s.AWS_BEDROCK_PROFILE is None:
                # Try to pull explicit keys from standard AWS env vars or settings.
                # boto3 reads these env vars natively too, but we support them through
                # settings as well (e.g. set in .env for dev).
                import os as _os

                access_key = _os.getenv("AWS_ACCESS_KEY_ID") or None
                secret_key = _os.getenv("AWS_SECRET_ACCESS_KEY") or None
            return BedrockProvider(
                model=model,
                region_name=s.AWS_BEDROCK_REGION,
                profile_name=s.AWS_BEDROCK_PROFILE,
                aws_access_key_id=access_key,
                aws_secret_access_key=secret_key,
                model_kwargs=kwargs,
            )
        case _:
            raise ValueError(
                f"Unsupported provider '{name}'. "
                f"Supported providers: {', '.join(SUPPORTED_PROVIDERS)}"
            )
