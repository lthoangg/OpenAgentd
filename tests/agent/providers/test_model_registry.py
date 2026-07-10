from __future__ import annotations

from pathlib import Path

import pytest

from app.agent.providers import capabilities, model_metadata, model_registry
from app.agent.providers.capabilities import get_capabilities
from app.agent.providers.model_metadata import (
    get_model_cost,
    get_model_features,
    get_model_limits,
    get_model_thinking_levels,
)


def _clear_registry_caches() -> None:
    model_registry.clear_model_registry_caches()


@pytest.fixture(autouse=True)
def _registry_cache_cleanup():
    _clear_registry_caches()
    yield
    _clear_registry_caches()


def test_models_dev_metadata_is_normalized(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        model_registry.settings, "OPENAGENTD_CACHE_DIR", str(tmp_path / "cache")
    )
    monkeypatch.setattr(
        model_registry.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path / "config")
    )
    monkeypatch.setattr(
        model_registry.settings, "OPENAGENTD_MODEL_REGISTRY_REFRESH", True
    )
    monkeypatch.setattr(
        model_registry,
        "_fetch_models_dev",
        lambda: {
            "openai": {
                "id": "openai",
                "models": {
                    "gpt-live": {
                        "id": "gpt-live",
                        "modalities": {"input": ["text", "image"], "output": ["text"]},
                        "limit": {"context": 123000, "output": 4567},
                        "cost": {
                            "input": 1.25,
                            "output": 10.0,
                            "cache_read": 0.1,
                            "cache_write": 0.2,
                        },
                        "tool_call": True,
                        "attachment": True,
                        "temperature": False,
                        "reasoning": True,
                        "reasoning_options": [
                            {
                                "type": "effort",
                                "values": ["none", "low", "medium", "high", "xhigh"],
                            },
                            {"type": "budget_tokens", "min": 1024},
                        ],
                        "status": "beta",
                        "release_date": "2026-01-02",
                    }
                },
            }
        },
    )

    assert get_capabilities("openai:gpt-live").input.vision is True
    limits = get_model_limits("openai:gpt-live")
    assert limits.context_length == 123000
    assert limits.max_completion_tokens == 4567
    cost = get_model_cost("openai:gpt-live")
    assert cost.input == 1.25
    assert cost.output == 10.0
    assert cost.cache_read == 0.1
    assert cost.cache_write == 0.2
    features = get_model_features("openai:gpt-live")
    assert features.tool_call is True
    assert features.attachment is True
    assert features.temperature is False
    assert features.reasoning is True
    assert get_model_thinking_levels("openai:gpt-live") == (
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
    )
    assert features.status == "beta"
    assert features.release_date == "2026-01-02"


def test_models_dev_budget_reasoning_maps_to_standard_thinking_levels(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        model_registry.settings, "OPENAGENTD_CACHE_DIR", str(tmp_path / "cache")
    )
    monkeypatch.setattr(
        model_registry.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path / "config")
    )
    monkeypatch.setattr(
        model_registry.settings, "OPENAGENTD_MODEL_REGISTRY_REFRESH", True
    )
    monkeypatch.setattr(
        model_registry,
        "_fetch_models_dev",
        lambda: {
            "anthropic": {
                "id": "anthropic",
                "models": {
                    "claude-haiku-4-5-20251001": {
                        "id": "claude-haiku-4-5-20251001",
                        "reasoning": True,
                        "reasoning_options": [{"type": "budget_tokens", "min": 1024}],
                    }
                },
            }
        },
    )

    assert get_model_thinking_levels("anthropic:claude-haiku-4-5-20251001") == (
        "none",
        "low",
        "medium",
        "high",
    )


def test_models_dev_provider_aliases(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        model_registry.settings, "OPENAGENTD_CACHE_DIR", str(tmp_path / "cache")
    )
    monkeypatch.setattr(
        model_registry.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path / "config")
    )
    monkeypatch.setattr(
        model_registry.settings, "OPENAGENTD_MODEL_REGISTRY_REFRESH", True
    )
    monkeypatch.setattr(
        model_registry,
        "_fetch_models_dev",
        lambda: {
            "amazon-bedrock": {
                "id": "amazon-bedrock",
                "models": {
                    "anthropic.claude-sonnet-4-6": {
                        "id": "anthropic.claude-sonnet-4-6",
                        "modalities": {"input": ["text", "image"], "output": ["text"]},
                        "limit": {"context": 2000, "output": 200},
                    }
                },
            },
            "google": {
                "id": "google",
                "models": {
                    "gemini-live": {
                        "id": "gemini-live",
                        "modalities": {"input": ["text", "image"], "output": ["text"]},
                        "limit": {"context": 1000, "output": 100},
                    }
                },
            },
        },
    )

    assert get_capabilities("bedrock:anthropic.claude-sonnet-4-6").input.vision is True
    assert (
        get_model_limits("bedrock:anthropic.claude-sonnet-4-6").context_length == 2000
    )
    assert get_capabilities("googlegenai:gemini-live").input.vision is True
    assert get_model_limits("googlegenai:gemini-live").context_length == 1000


def test_provider_owned_model_registry_aliases(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        model_registry.settings, "OPENAGENTD_CACHE_DIR", str(tmp_path / "cache")
    )
    monkeypatch.setattr(
        model_registry.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path / "config")
    )
    monkeypatch.setattr(
        model_registry.settings, "OPENAGENTD_MODEL_REGISTRY_REFRESH", True
    )
    monkeypatch.setattr(
        model_registry,
        "_provider_entries",
        lambda include_plugins: [
            {
                "id": "runtime",
                "metadata_source_provider": "openai",
                "model_registry_aliases": {"renamed-live": "openai:gpt-renamed-source"},
            }
        ],
    )
    monkeypatch.setattr(
        model_registry,
        "_fetch_models_dev",
        lambda: {
            "openai": {
                "id": "openai",
                "models": {
                    "gpt-live": {
                        "id": "gpt-live",
                        "modalities": {"input": ["text", "image"], "output": ["text"]},
                        "limit": {"context": 222000, "output": 333},
                    },
                    "gpt-renamed-source": {
                        "id": "gpt-renamed-source",
                        "modalities": {"input": ["text", "image"], "output": ["text"]},
                        "limit": {"context": 666000, "output": 777},
                    },
                },
            },
        },
    )

    assert get_capabilities("runtime:gpt-live").input.vision is True
    assert get_model_limits("runtime:gpt-live").context_length == 222000
    assert get_capabilities("runtime:renamed-live").input.vision is True
    assert get_model_limits("runtime:renamed-live").context_length == 666000


def test_provider_aliases_are_ignored_when_plugins_are_excluded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        model_registry,
        "_provider_entries",
        lambda include_plugins: [
            {
                "id": "builtin-runtime",
                "models_dev_provider_id": "builtin-source",
                "metadata_source_provider": "openai",
            },
            *(
                [
                    {
                        "id": "plugin-runtime",
                        "models_dev_provider_id": "plugin-source",
                        "metadata_source_provider": "anthropic",
                        "model_registry_aliases": {
                            "plugin-renamed": "openai:gpt-source"
                        },
                    }
                ]
                if include_plugins
                else []
            ),
        ],
    )

    data = {
        "builtin-source": {
            "models": {
                "builtin-model": {
                    "modalities": {"input": ["image"], "output": ["text"]}
                }
            }
        },
        "plugin-source": {
            "models": {
                "plugin-model": {"modalities": {"input": ["image"], "output": ["text"]}}
            }
        },
    }

    with_plugins = model_registry._normalize_models_dev(data, include_plugins=True)
    without_plugins = model_registry._normalize_models_dev(data, include_plugins=False)
    registry = {
        "openai:gpt-source": {"limits": {"context_length": 123}},
        "anthropic:claude-source": {"limits": {"context_length": 456}},
    }

    assert "plugin-runtime:plugin-model" in with_plugins
    assert "plugin-source:plugin-model" in without_plugins
    assert "plugin-runtime:plugin-model" not in without_plugins

    with_plugin_aliases = model_registry.apply_model_registry_aliases(
        registry, overwrite=True, include_plugins=True
    )
    without_plugin_aliases = model_registry.apply_model_registry_aliases(
        registry, overwrite=True, include_plugins=False
    )
    assert (
        with_plugin_aliases["plugin-runtime:plugin-renamed"]["limits"]["context_length"]
        == 123
    )
    assert "plugin-runtime:plugin-renamed" not in without_plugin_aliases


def test_model_aliases_ignore_malformed_and_missing_sources(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        model_registry,
        "_provider_entries",
        lambda include_plugins: [
            {
                "id": "runtime",
                "model_registry_aliases": {
                    "renamed": "openai:gpt-source",
                    "other:explicit": "openai:gpt-source",
                    "missing": "openai:missing",
                    123: "openai:gpt-source",
                    "bad-source": 456,
                },
            },
            {"id": "broken", "metadata_source_provider": 123},
            {"metadata_source_provider": "openai"},
        ],
    )

    aliased = model_registry.apply_model_registry_aliases(
        {"openai:gpt-source": {"limits": {"context_length": 123}}},
        overwrite=True,
    )

    assert aliased["runtime:renamed"]["limits"]["context_length"] == 123
    assert aliased["other:explicit"]["limits"]["context_length"] == 123
    assert "runtime:missing" not in aliased
    assert "runtime:bad-source" not in aliased
    assert "broken:gpt-source" not in aliased


def test_refreshed_source_metadata_updates_stale_alias_entry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        model_registry.settings, "OPENAGENTD_CACHE_DIR", str(tmp_path / "cache")
    )
    monkeypatch.setattr(
        model_registry.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path / "config")
    )
    monkeypatch.setattr(
        model_registry.settings, "OPENAGENTD_MODEL_REGISTRY_REFRESH", True
    )
    monkeypatch.setattr(
        model_registry,
        "_provider_entries",
        lambda include_plugins: [
            {"id": "runtime", "metadata_source_provider": "openai"}
        ],
    )
    monkeypatch.setattr(
        model_registry,
        "_load_bundled_registry",
        lambda: {
            "runtime:gpt-live": {
                "capabilities": {"input": {"audio": True}},
                "limits": {"context_length": 100, "max_completion_tokens": 20},
            }
        },
    )
    monkeypatch.setattr(
        model_registry,
        "_fetch_models_dev",
        lambda: {
            "openai": {
                "models": {
                    "gpt-live": {
                        "modalities": {"input": ["text", "image"], "output": ["text"]},
                        "limit": {"context": 900, "output": 80},
                    }
                }
            }
        },
    )

    caps = get_capabilities("runtime:gpt-live")
    limits = get_model_limits("runtime:gpt-live")
    assert caps.input.audio is True
    assert caps.input.vision is True
    assert limits.context_length == 900
    assert limits.max_completion_tokens == 80


def test_user_overlay_wins_over_models_dev(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    (config_dir / "model_registry.yaml").write_text(
        """
openai:gpt-live:
  capabilities:
    input: {audio: true}
  limits: {context_length: 999, max_completion_tokens: 88}
""".strip(),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        model_registry.settings, "OPENAGENTD_CACHE_DIR", str(tmp_path / "cache")
    )
    monkeypatch.setattr(
        model_registry.settings, "OPENAGENTD_CONFIG_DIR", str(config_dir)
    )
    monkeypatch.setattr(
        model_registry.settings, "OPENAGENTD_MODEL_REGISTRY_REFRESH", True
    )
    monkeypatch.setattr(
        model_registry,
        "_fetch_models_dev",
        lambda: {
            "openai": {
                "id": "openai",
                "models": {
                    "gpt-live": {
                        "id": "gpt-live",
                        "modalities": {"input": ["text", "image"], "output": ["text"]},
                        "limit": {"context": 123000, "output": 4567},
                    }
                },
            }
        },
    )

    caps = get_capabilities("openai:gpt-live")
    assert caps.input.vision is True
    assert caps.input.audio is True
    limits = get_model_limits("openai:gpt-live")
    assert limits.context_length == 999
    assert limits.max_completion_tokens == 88


def test_user_overlay_propagates_to_metadata_aliases(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    (config_dir / "model_registry.yaml").write_text(
        """
openai:gpt-live:
  limits: {context_length: 999}
codex:gpt-live:
  limits: {max_completion_tokens: 88}
""".strip(),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        model_registry.settings, "OPENAGENTD_CACHE_DIR", str(tmp_path / "cache")
    )
    monkeypatch.setattr(
        model_registry.settings, "OPENAGENTD_CONFIG_DIR", str(config_dir)
    )
    monkeypatch.setattr(
        model_registry.settings, "OPENAGENTD_MODEL_REGISTRY_REFRESH", True
    )
    monkeypatch.setattr(
        model_registry,
        "_fetch_models_dev",
        lambda: {
            "openai": {
                "id": "openai",
                "models": {
                    "gpt-live": {
                        "id": "gpt-live",
                        "modalities": {"input": ["text", "image"], "output": ["text"]},
                        "limit": {"context": 123000, "output": 4567},
                    }
                },
            }
        },
    )

    limits = get_model_limits("codex:gpt-live")
    assert limits.context_length == 999
    assert limits.max_completion_tokens == 88


def test_refresh_model_registry_and_force_fetch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cache_dir = tmp_path / "cache"
    config_dir = tmp_path / "config"
    cache_dir.mkdir(parents=True, exist_ok=True)
    config_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(
        model_registry.settings, "OPENAGENTD_CACHE_DIR", str(cache_dir)
    )
    monkeypatch.setattr(
        model_registry.settings, "OPENAGENTD_CONFIG_DIR", str(config_dir)
    )
    monkeypatch.setattr(
        model_registry.settings, "OPENAGENTD_MODEL_REGISTRY_REFRESH", True
    )

    call_count = 0
    payloads = [
        {
            "openai": {
                "id": "openai",
                "models": {
                    "gpt-live": {
                        "id": "gpt-live",
                        "modalities": {"input": ["text"], "output": ["text"]},
                        "limit": {"context": 1000},
                    }
                },
            }
        },
        {
            "openai": {
                "id": "openai",
                "models": {
                    "gpt-live": {
                        "id": "gpt-live",
                        "modalities": {"input": ["text", "image"], "output": ["text"]},
                        "limit": {"context": 2000},
                    }
                },
            }
        },
    ]

    def mock_fetch():
        nonlocal call_count
        val = payloads[call_count]
        call_count += 1
        return val

    monkeypatch.setattr(model_registry, "_fetch_models_dev", mock_fetch)

    _clear_registry_caches()
    assert get_model_limits("openai:gpt-live").context_length == 1000
    assert call_count == 1

    assert get_model_limits("openai:gpt-live").context_length == 1000
    assert call_count == 1

    model_registry.clear_model_registry_caches()
    assert get_model_limits("openai:gpt-live").context_length == 1000
    assert call_count == 1

    model_registry.refresh_model_registry()
    assert call_count == 2

    assert get_model_limits("openai:gpt-live").context_length == 2000

