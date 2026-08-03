from app.agent.providers import model_registry


def test_models_dev_opencode_transport_uses_model_sdk_package() -> None:
    registry = model_registry._normalize_models_dev(
        {
            "opencode": {
                "models": {
                    "gpt-model": {"provider": {"npm": "@ai-sdk/openai"}},
                    "claude-model": {"provider": {"npm": "@ai-sdk/anthropic"}},
                    "gemini-model": {"provider": {"npm": "@ai-sdk/google"}},
                    "grok-build-0.1": {},
                    "compatible-model": {},
                }
            },
            "opencode-go": {
                "models": {
                    "gpt-model": {"provider": {"npm": "@ai-sdk/openai"}},
                    "grok-4.5": {"provider": {"npm": "@ai-sdk/openai"}},
                    "compatible-model": {},
                }
            },
        }
    )

    assert registry["opencode:gpt-model"]["transport"]["api_family"] == "responses"
    assert registry["opencode:claude-model"]["transport"]["api_family"] == "messages"
    assert (
        registry["opencode:gemini-model"]["transport"]["api_family"]
        == "generate_content"
    )
    assert (
        registry["opencode:compatible-model"]["transport"]["api_family"]
        == "chat_completions"
    )
    assert registry["opencode:grok-build-0.1"]["transport"]["api_family"] == "responses"
    assert registry["opencode-go:gpt-model"]["transport"]["api_family"] == "responses"
    assert (
        registry["opencode-go:grok-4.5"]["transport"]["api_family"]
        == "chat_completions"
    )
    assert (
        registry["opencode-go:compatible-model"]["transport"]["api_family"]
        == "chat_completions"
    )
