"""AWS Bedrock Mantle provider.

Mantle exposes Bedrock models through Anthropic Messages or OpenAI-compatible
surfaces.  This provider intentionally has no Bedrock Runtime/Converse fallback.
Bearer tokens are supplied directly or generated from the selected botocore
credential chain for each request; generated tokens are never persisted or logged.
"""

from __future__ import annotations

import os
import re
from collections.abc import AsyncIterator
from typing import Any

from pydantic.types import SecretStr

from app.agent.providers.anthropic.anthropic import AnthropicProvider
from app.agent.providers.base import LLMProviderBase
from app.agent.providers.model_metadata import get_model_transport
from app.agent.providers.openai.openai import OpenAIProvider
from app.agent.providers.openai.responses import ResponsesHandler
from app.agent.schemas.chat import AssistantMessage, ChatCompletionChunk, ChatMessage


_AWS_REGION = re.compile(r"[a-z]{2}(?:-[a-z0-9]+)+-\d")


def resolve_bedrock_region(region_name: str | None) -> str:
    """Resolve and validate the region used to construct the Mantle host."""
    from app.core.config import settings

    region = (
        region_name
        or settings.AWS_BEDROCK_REGION
        or os.getenv("AWS_DEFAULT_REGION")
        or "us-east-1"
    )
    if _AWS_REGION.fullmatch(region) is None:
        raise ValueError(f"Invalid AWS Bedrock region: {region!r}")
    return region


def _generate_profile_token(region: str, profile_name: str | None) -> str:
    """Generate one bearer token from a named profile or botocore's default chain."""
    from importlib import import_module

    from botocore.session import Session

    generator_module: Any = import_module("aws_bedrock_token_generator")
    session = Session(profile=profile_name) if profile_name else Session()
    credentials = session.get_credentials()
    return generator_module.BedrockTokenGenerator().get_token(credentials, region)


def _is_anthropic_model(model: str) -> bool:
    return model.startswith("anthropic.") or ".anthropic." in model


class _MantleOpenAIProvider(OpenAIProvider):
    """OpenAI delegate that always preserves encrypted reasoning for Mantle."""

    def _make_responses_handler(
        self, model: str, base_url: str, headers: dict[str, str]
    ) -> ResponsesHandler:
        return ResponsesHandler(
            model,
            base_url,
            headers,
            preserve_stateless_reasoning=True,
        )


class BedrockProvider(LLMProviderBase):
    """Delegate Bedrock models exclusively to AWS Bedrock Mantle.

    ``bearer_token`` has precedence.  Without it, a token is generated from
    ``profile_name`` or botocore's default credential chain immediately before
    every chat or stream request.
    """

    def __init__(
        self,
        *,
        model: str,
        region_name: str | None = None,
        profile_name: str | None = None,
        bearer_token: str | SecretStr | None = None,
        max_tokens: int | None = None,
        model_kwargs: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(max_tokens=max_tokens, model_kwargs=model_kwargs)
        self.model = model
        self._region = resolve_bedrock_region(region_name)
        self._profile_name = profile_name
        self._bearer_token = (
            bearer_token.get_secret_value()
            if isinstance(bearer_token, SecretStr)
            else bearer_token
        )

    def _fresh_bearer_token(self) -> str:
        """Return a direct token or create a new credential-chain token."""
        if self._bearer_token:
            return self._bearer_token
        try:
            return _generate_profile_token(self._region, self._profile_name)
        except Exception as exc:
            # Provider errors must not expose credential/token implementation data.
            raise RuntimeError(
                "Bedrock bearer token generation failed. Reauthenticate the configured "
                "AWS profile with `aws login` or `aws sso login`, or configure "
                "AWS_BEARER_TOKEN_BEDROCK."
            ) from exc

    def _delegate(self) -> AnthropicProvider | OpenAIProvider:
        token = self._fresh_bearer_token()
        if _is_anthropic_model(self.model):
            from app.agent.providers.model_metadata import get_model_limits

            limits = get_model_limits(f"bedrock:{self.model}")
            return AnthropicProvider(
                api_key=token,
                model=self.model,
                base_url=f"https://bedrock-mantle.{self._region}.api.aws/anthropic",
                max_tokens=(
                    self.max_tokens
                    if self.max_tokens is not None
                    else limits.max_completion_tokens
                ),
                model_kwargs=self.model_kwargs,
            )

        transport = get_model_transport(f"bedrock:{self.model}")
        variant = transport.endpoint_variant if transport is not None else "default"
        suffix = "/openai/v1" if variant == "openai" else "/v1"
        kwargs = dict(self.model_kwargs)
        # A normalized transport can require Responses. Explicit user selection
        # remains authoritative, including an explicit False; absent transport
        # metadata keeps OpenAIProvider's normal Chat Completions default.
        if transport is not None and "responses_api" not in kwargs:
            kwargs["responses_api"] = transport.api_family == "responses"
        return _MantleOpenAIProvider(
            api_key=token,
            model=self.model,
            base_url=f"https://bedrock-mantle.{self._region}.api.aws{suffix}",
            max_tokens=self.max_tokens,
            model_kwargs=kwargs,
        )

    async def chat(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs: Any,
    ) -> AssistantMessage:
        delegate = self._delegate()
        try:
            return await delegate.chat(messages, tools, **kwargs)
        finally:
            await delegate.aclose()

    async def stream(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[ChatCompletionChunk]:
        delegate = self._delegate()
        try:
            async for chunk in delegate.stream(messages, tools, **kwargs):
                yield chunk
        finally:
            await delegate.aclose()
