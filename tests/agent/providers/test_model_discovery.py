from __future__ import annotations

import sys
from types import SimpleNamespace

import pytest

from app.agent.providers.model_discovery import _bedrock_models


class _BedrockClient:
    def list_foundation_models(self, **kwargs):
        assert kwargs == {"byOutputModality": "TEXT"}
        return {
            "modelSummaries": [
                {"modelId": "anthropic.claude-sonnet-4-6"},
                {"modelId": "amazon.nova-pro-v1:0"},
            ]
        }

    def list_inference_profiles(self, **kwargs):
        assert kwargs["typeEquals"] in {"SYSTEM_DEFINED", "APPLICATION"}
        assert kwargs["maxResults"] == 1000
        if kwargs["typeEquals"] == "SYSTEM_DEFINED":
            return {
                "inferenceProfileSummaries": [
                    {
                        "inferenceProfileId": "global.anthropic.claude-sonnet-4-6",
                        "status": "ACTIVE",
                    }
                ]
            }
        return {
            "inferenceProfileSummaries": [
                {
                    "inferenceProfileId": "my-serverless-profile",
                    "type": "APPLICATION",
                    "status": "ACTIVE",
                },
                {
                    "inferenceProfileId": "inactive-profile",
                    "type": "APPLICATION",
                    "status": "DELETING",
                },
            ]
        }


@pytest.mark.asyncio
async def test_bedrock_models_include_foundation_and_inference_profiles(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _BedrockClient()
    monkeypatch.setitem(
        sys.modules,
        "boto3",
        SimpleNamespace(client=lambda *args, **kwargs: client),
    )

    models = await _bedrock_models(
        {"AWS_BEDROCK_REGION": "us-east-1", "AWS_BEDROCK_PROFILE": ""}
    )

    assert models == [
        "amazon.nova-pro-v1:0",
        "anthropic.claude-sonnet-4-6",
        "global.anthropic.claude-sonnet-4-6",
        "my-serverless-profile",
    ]
