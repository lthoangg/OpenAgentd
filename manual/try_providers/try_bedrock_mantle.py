"""Test Bedrock Mantle's documented OpenAI-compatible routes.

The OpenAI SDK is an optional smoke-test dependency. Run with:

  uv run --with openai \
    python -m manual.try_providers.try_bedrock_mantle
  uv run --with openai \
    python -m manual.try_providers.try_bedrock_mantle \
      --model openai.gpt-5.6-luna --responses

Set ``AWS_BEARER_TOKEN_BEDROCK`` to test a direct short-lived bearer token, or
omit it to mint one with ``aws-bedrock-token-generator``. The generator uses the
normal AWS credential chain; ``--profile`` sets ``AWS_PROFILE`` for this process.
Tokens are passed directly to the client and are never printed or persisted.
"""

from __future__ import annotations

import argparse
import os

from app.agent.providers.bedrock.bedrock import resolve_bedrock_region
from app.agent.providers.model_metadata import get_model_transport
from app.core.config import settings


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Test Bedrock Mantle's OpenAI-compatible routes"
    )
    parser.add_argument(
        "--model",
        default="openai.gpt-oss-20b",
        help="Mantle model ID (default: openai.gpt-oss-20b)",
    )
    parser.add_argument(
        "--profile",
        default=None,
        help="AWS profile (defaults to AWS_BEDROCK_PROFILE)",
    )
    parser.add_argument(
        "--region",
        default=None,
        help="AWS region (defaults to AWS_BEDROCK_REGION or us-east-1)",
    )
    parser.add_argument("--project", default="default", help="Bedrock Mantle project")
    parser.add_argument(
        "--prompt",
        default="Write a haiku about Python programming.",
        help="Prompt to send",
    )
    parser.add_argument(
        "--responses",
        action="store_true",
        help="Use /v1/responses instead of /v1/chat/completions",
    )
    parser.add_argument("--no-stream", action="store_true")
    parser.add_argument("--list-models", action="store_true")
    args = parser.parse_args()

    try:
        from openai import OpenAI
    except ImportError as exc:
        raise SystemExit(
            "Missing OpenAI smoke-test dependency. Run with:\n"
            "  uv run --with openai python -m manual.try_providers.try_bedrock_mantle\n"
            "Add --with aws-bedrock-token-generator when not setting "
            "AWS_BEARER_TOKEN_BEDROCK."
        ) from exc

    profile = args.profile or settings.AWS_BEDROCK_PROFILE
    region = resolve_bedrock_region(args.region)
    configured_token = settings.AWS_BEARER_TOKEN_BEDROCK
    token = os.getenv("AWS_BEARER_TOKEN_BEDROCK") or (
        configured_token.get_secret_value() if configured_token else None
    )
    token_source = "AWS_BEARER_TOKEN_BEDROCK"
    if not token:
        try:
            from aws_bedrock_token_generator import provide_token
        except ImportError as exc:
            raise SystemExit(
                "Set AWS_BEARER_TOKEN_BEDROCK, or install the profile-token "
                "generator with:\n"
                "  uv run --with openai --with aws-bedrock-token-generator "
                "python -m manual.try_providers.try_bedrock_mantle"
            ) from exc
        if profile:
            os.environ["AWS_PROFILE"] = profile
        token = provide_token(region=region)
        token_source = "AWS profile/default credential chain"

    transport = get_model_transport(f"bedrock:{args.model}")
    use_responses = args.responses or (
        transport is not None and transport.api_family == "responses"
    )
    endpoint_variant = (
        transport.endpoint_variant if transport is not None else "default"
    )
    api_prefix = "openai/v1" if endpoint_variant == "openai" else "v1"
    if args.list_models:
        api_prefix = "v1"
    client = OpenAI(
        api_key=token,
        base_url=f"https://bedrock-mantle.{region}.api.aws/{api_prefix}",
        project=args.project,
    )

    print(f"region: {region}")
    print(f"token source: {token_source}")
    if token_source != "AWS_BEARER_TOKEN_BEDROCK":
        print(f"profile: {profile or '(default credential chain)'}")

    if args.list_models:
        models = list(client.models.list())
        print(f"models: {len(models)}")
        for model in models:
            print(model.id)
        return

    if use_responses:
        if args.no_stream:
            response = client.responses.create(
                model=args.model, input=args.prompt, store=False
            )
            print(response.output_text)
            if response.usage:
                print(
                    "usage: "
                    f"in={response.usage.input_tokens} "
                    f"out={response.usage.output_tokens} "
                    f"total={response.usage.total_tokens}"
                )
            return

        stream = client.responses.create(
            model=args.model,
            input=args.prompt,
            stream=True,
            store=False,
        )
        for event in stream:
            if event.type == "response.output_text.delta":
                print(event.delta, end="", flush=True)
        print()
        return

    if args.no_stream:
        response = client.chat.completions.create(
            model=args.model,
            messages=[{"role": "user", "content": args.prompt}],
            store=False,
        )
        print(response.choices[0].message.content or "")
        if response.usage:
            print(
                "usage: "
                f"in={response.usage.prompt_tokens} "
                f"out={response.usage.completion_tokens} "
                f"total={response.usage.total_tokens}"
            )
        return

    stream = client.chat.completions.create(
        model=args.model,
        messages=[{"role": "user", "content": args.prompt}],
        stream=True,
        store=False,
    )
    for chunk in stream:
        if not chunk.choices:
            continue
        print(chunk.choices[0].delta.content or "", end="", flush=True)
    print()


if __name__ == "__main__":
    main()
