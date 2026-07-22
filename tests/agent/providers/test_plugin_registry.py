from __future__ import annotations

from pathlib import Path
from textwrap import dedent
from typing import Any

import pytest

import app.agent.providers.plugin_registry as plugin_registry
from app.agent.providers.base import LLMProviderBase
from app.agent.providers.catalog import all_providers, find
from app.agent.providers.factory import build_provider
from app.agent.providers.model_discovery import discover_provider_models
from app.agent.providers.plugin_registry import (
    ProviderCredentialStore,
    clear_provider_plugin_cache,
    provider_plugins,
)
from app.agent.schemas.chat import AssistantMessage, ChatMessage
from app.core.config import settings


@pytest.fixture(autouse=True)
def _clear_plugin_cache() -> None:
    clear_provider_plugin_cache()
    yield
    clear_provider_plugin_cache()


def _write_plugin(directory: Path, body: str) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "sample_provider.py").write_text(
        dedent(body).lstrip(), encoding="utf-8"
    )


def _point_plugin_dirs(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    plugin_dir = tmp_path / "config" / "plugins"
    monkeypatch.setattr(settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.setattr(settings, "OPENAGENTD_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setattr(settings, "OPENAGENTD_PLUGINS_DIRS", str(plugin_dir))
    return plugin_dir


def test_provider_plugin_loads_and_is_exposed_in_catalog(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    plugin_dir = _point_plugin_dirs(monkeypatch, tmp_path)
    _write_plugin(
        plugin_dir,
        """
        from app.agent.providers.base import LLMProviderBase
        from app.agent.providers.plugin_api import ProviderPlugin, ProviderCredentialField

        class DummyProvider(LLMProviderBase):
            async def chat(self, messages, tools=None, **kwargs):
                raise AssertionError("not used")
            async def stream(self, messages, tools=None, **kwargs):
                if False:
                    yield None

        def build(ctx):
            return DummyProvider(model_kwargs=ctx.model_kwargs)

        provider = ProviderPlugin(
            id="sample",
            label="Sample Provider",
            description="Synthetic provider for tests.",
            kind="api_key",
            credentials=[ProviderCredentialField(name="SAMPLE_KEY", label="Sample key")],
            factory=build,
        )
        """,
    )

    plugins = provider_plugins()
    assert set(plugins) == {"sample"}

    entry = find("sample")
    assert entry is not None
    assert entry["env_var"] == "SAMPLE_KEY"
    assert entry["credentials"][0]["label"] == "Sample key"
    assert "sample" in {provider["id"] for provider in all_providers()}


def test_broken_provider_plugin_is_isolated(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    plugin_dir = _point_plugin_dirs(monkeypatch, tmp_path)
    plugin_dir.mkdir(parents=True)
    (plugin_dir / "bad.py").write_text("raise RuntimeError('boom')", encoding="utf-8")
    _write_plugin(
        plugin_dir,
        """
        from app.agent.providers.base import LLMProviderBase
        from app.agent.providers.plugin_api import ProviderPlugin

        class DummyProvider(LLMProviderBase):
            async def chat(self, messages, tools=None, **kwargs):
                raise AssertionError("not used")
            async def stream(self, messages, tools=None, **kwargs):
                if False:
                    yield None

        provider = ProviderPlugin(
            id="healthy",
            label="Healthy",
            description="Loads even when another plugin fails.",
            kind="api_key",
            factory=lambda ctx: DummyProvider(),
        )
        """,
    )

    assert set(provider_plugins()) == {"healthy"}


def test_provider_factory_dispatches_to_plugin_with_saved_credentials(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    plugin_dir = _point_plugin_dirs(monkeypatch, tmp_path)
    (tmp_path / "config").mkdir(parents=True)
    (tmp_path / "config" / ".env").write_text("SAMPLE_KEY=saved\n", encoding="utf-8")
    _write_plugin(
        plugin_dir,
        """
        from app.agent.providers.base import LLMProviderBase
        from app.agent.providers.plugin_api import ProviderPlugin, ProviderCredentialField
        from app.agent.schemas.chat import AssistantMessage

        class DummyProvider(LLMProviderBase):
            def __init__(self, model, key, model_kwargs):
                super().__init__(model_kwargs=model_kwargs)
                self.model = model
                self.key = key
            async def chat(self, messages, tools=None, **kwargs):
                return AssistantMessage(content=f"{self.model}:{self.key}:{self.model_kwargs['flag']}")
            async def stream(self, messages, tools=None, **kwargs):
                if False:
                    yield None

        def build(ctx):
            return DummyProvider(ctx.model, ctx.credentials.get("SAMPLE_KEY"), ctx.model_kwargs)

        provider = ProviderPlugin(
            id="sample",
            label="Sample",
            description="Factory test provider.",
            kind="api_key",
            credentials=[ProviderCredentialField(name="SAMPLE_KEY", label="Sample key")],
            factory=build,
        )
        """,
    )

    provider = build_provider("sample:model-a", {"flag": "x"})

    assert provider.model == "model-a"
    assert getattr(provider, "key") == "saved"
    assert getattr(provider, "model_kwargs") == {"flag": "x"}


async def test_plugin_model_discovery_uses_overrides_before_saved_env(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    plugin_dir = _point_plugin_dirs(monkeypatch, tmp_path)
    (tmp_path / "config").mkdir(parents=True)
    (tmp_path / "config" / ".env").write_text("SAMPLE_KEY=saved\n", encoding="utf-8")
    _write_plugin(
        plugin_dir,
        """
        from app.agent.providers.base import LLMProviderBase
        from app.agent.providers.plugin_api import ProviderPlugin, ProviderCredentialField

        class DummyProvider(LLMProviderBase):
            async def chat(self, messages, tools=None, **kwargs):
                raise AssertionError("not used")
            async def stream(self, messages, tools=None, **kwargs):
                if False:
                    yield None

        async def discover(credentials):
            return [credentials.get("SAMPLE_KEY")]

        provider = ProviderPlugin(
            id="sample",
            label="Sample",
            description="Discovery test provider.",
            kind="api_key",
            credentials=[ProviderCredentialField(name="SAMPLE_KEY", label="Sample key")],
            factory=lambda ctx: DummyProvider(),
            discover_models=discover,
        )
        """,
    )

    entry = find("sample")
    assert entry is not None

    assert await discover_provider_models(entry) == ["saved"]
    assert await discover_provider_models(
        entry, overrides={"SAMPLE_KEY": "candidate"}
    ) == ["candidate"]


def test_provider_plugins_returns_empty_when_plugin_dir_is_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A never-created (or since-deleted) plugins dir must not raise.

    ``openagentd init`` creates ``{config}/plugins/`` lazily; users who
    never installed a plugin (or deleted the directory) should see an
    empty plugin set everywhere that consumes it — including the tray's
    usage-summary aggregator — rather than an exception on the next
    provider listing or poll.
    """
    _point_plugin_dirs(monkeypatch, tmp_path)  # never created on disk

    assert provider_plugins() == {}
    assert all_providers()  # builtin catalog still loads


def test_credential_stores_share_unchanged_saved_env_parse(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    (config_dir / ".env").write_text("SAMPLE_KEY=saved\n", encoding="utf-8")
    monkeypatch.setattr(settings, "OPENAGENTD_CONFIG_DIR", str(config_dir))
    monkeypatch.delenv("SAMPLE_KEY", raising=False)
    parse_count = 0
    original_dotenv_values = plugin_registry.dotenv_values

    def count_parses(*args, **kwargs):
        nonlocal parse_count
        parse_count += 1
        return original_dotenv_values(*args, **kwargs)

    monkeypatch.setattr(plugin_registry, "dotenv_values", count_parses)

    assert ProviderCredentialStore("one").get("SAMPLE_KEY") == "saved"
    assert ProviderCredentialStore("two").get("SAMPLE_KEY") == "saved"
    assert parse_count == 1


def test_credential_stores_refresh_when_saved_env_changes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    env_file = config_dir / ".env"
    monkeypatch.setattr(settings, "OPENAGENTD_CONFIG_DIR", str(config_dir))
    monkeypatch.delenv("SAMPLE_KEY", raising=False)

    assert ProviderCredentialStore("missing").get("SAMPLE_KEY", "missing") == "missing"

    env_file.write_text("SAMPLE_KEY=original\n", encoding="utf-8")
    store = ProviderCredentialStore("one")
    assert store.get("SAMPLE_KEY") == "original"

    env_file.write_text("SAMPLE_KEY=edited\n", encoding="utf-8")
    assert store.get("SAMPLE_KEY") == "edited"

    replacement = config_dir / ".env.replacement"
    replacement.write_text("SAMPLE_KEY=replaced\n", encoding="utf-8")
    replacement.replace(env_file)
    assert ProviderCredentialStore("two").get("SAMPLE_KEY") == "replaced"

    env_file.unlink()
    assert ProviderCredentialStore("three").get("SAMPLE_KEY", "missing") == "missing"


def test_credential_store_token_path_is_provider_scoped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "OPENAGENTD_CACHE_DIR", str(tmp_path / "cache"))

    first = ProviderCredentialStore("one").token_path("token.json")
    second = ProviderCredentialStore("two").token_path("token.json")

    assert first != second
    assert first.endswith("provider-plugins/one/token.json")
    assert second.endswith("provider-plugins/two/token.json")


class _DummyProvider(LLMProviderBase):
    async def chat(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs: Any,
    ) -> AssistantMessage:
        return AssistantMessage(content="ok")

    async def stream(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs: Any,
    ):
        if False:
            yield None


# ── supports_fast_mode ────────────────────────────────────────────────────────


def test_plugin_supports_fast_mode_defaults_false() -> None:
    """ProviderPlugin.supports_fast_mode is False when not specified."""
    from app.agent.providers.plugin_api import ProviderPlugin

    plugin = ProviderPlugin(
        id="myplugin",
        label="My Plugin",
        description="A plugin.",
        kind="api_key",
        factory=lambda ctx: None,  # type: ignore[arg-type]
    )
    assert plugin.supports_fast_mode is False


def test_plugin_supports_fast_mode_can_be_set_true() -> None:
    """ProviderPlugin.supports_fast_mode is forwarded when explicitly set."""
    from app.agent.providers.plugin_api import ProviderPlugin

    plugin = ProviderPlugin(
        id="fastplugin",
        label="Fast Plugin",
        description="A plugin that supports fast mode.",
        kind="api_key",
        factory=lambda ctx: None,  # type: ignore[arg-type]
        supports_fast_mode=True,
    )
    assert plugin.supports_fast_mode is True


def test_builtin_providers_fast_mode_flags() -> None:
    """Known builtin providers have the correct supports_fast_mode flag."""
    from app.agent.providers.catalog import all_providers

    entries = {e["id"]: e for e in all_providers()}

    for provider_id in ("anthropic", "googlegenai", "openai", "codex", "vertexai"):
        assert entries[provider_id].get("supports_fast_mode") is True, (
            f"{provider_id} should support fast mode"
        )

    for provider_id in ("ollama", "openrouter", "deepseek", "xai", "nvidia"):
        assert not entries[provider_id].get("supports_fast_mode"), (
            f"{provider_id} should not support fast mode"
        )


def test_plugin_supports_fast_mode_forwarded_to_all_providers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A plugin with supports_fast_mode=True appears with that flag in all_providers()."""
    plugin_dir = _point_plugin_dirs(monkeypatch, tmp_path)
    _write_plugin(
        plugin_dir,
        """
        from app.agent.providers.base import LLMProviderBase
        from app.agent.providers.plugin_api import ProviderPlugin

        class DummyProvider(LLMProviderBase):
            async def chat(self, messages, tools=None, **kwargs): ...
            async def stream(self, messages, tools=None, **kwargs):
                if False: yield None

        provider = ProviderPlugin(
            id="fastplugin",
            label="Fast Plugin",
            description="Supports fast mode.",
            kind="api_key",
            factory=lambda ctx: DummyProvider(),
            supports_fast_mode=True,
        )
        """,
    )

    entry = find("fastplugin")
    assert entry is not None
    assert entry.get("supports_fast_mode") is True


def test_plugin_without_fast_mode_forwarded_as_false(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A plugin without supports_fast_mode appears with False in all_providers()."""
    plugin_dir = _point_plugin_dirs(monkeypatch, tmp_path)
    _write_plugin(
        plugin_dir,
        """
        from app.agent.providers.base import LLMProviderBase
        from app.agent.providers.plugin_api import ProviderPlugin

        class DummyProvider(LLMProviderBase):
            async def chat(self, messages, tools=None, **kwargs): ...
            async def stream(self, messages, tools=None, **kwargs):
                if False: yield None

        provider = ProviderPlugin(
            id="slowplugin",
            label="Slow Plugin",
            description="No fast mode.",
            kind="api_key",
            factory=lambda ctx: DummyProvider(),
        )
        """,
    )

    entry = find("slowplugin")
    assert entry is not None
    assert not entry.get("supports_fast_mode")


# ── supports_prompt_cache_key ──────────────────────────────────────────────


def test_plugin_supports_prompt_cache_key_defaults_false() -> None:
    """ProviderPlugin.supports_prompt_cache_key is False when not specified."""
    from app.agent.providers.plugin_api import ProviderPlugin

    plugin = ProviderPlugin(
        id="myplugin",
        label="My Plugin",
        description="A plugin.",
        kind="api_key",
        factory=lambda ctx: None,  # type: ignore[arg-type]
    )
    assert plugin.supports_prompt_cache_key is False


def test_plugin_supports_prompt_cache_key_can_be_set_true() -> None:
    """ProviderPlugin.supports_prompt_cache_key is forwarded when explicitly set."""
    from app.agent.providers.plugin_api import ProviderPlugin

    plugin = ProviderPlugin(
        id="cacheplugin",
        label="Cache Plugin",
        description="A plugin that supports prompt cache keys.",
        kind="api_key",
        factory=lambda ctx: None,  # type: ignore[arg-type]
        supports_prompt_cache_key=True,
    )
    assert plugin.supports_prompt_cache_key is True


def test_builtin_providers_prompt_cache_key_flags() -> None:
    """Known builtin providers have the correct supports_prompt_cache_key flag."""
    from app.agent.providers.catalog import all_providers

    entries = {e["id"]: e for e in all_providers()}

    for provider_id in ("codex", "grok"):
        assert entries[provider_id].get("supports_prompt_cache_key") is True, (
            f"{provider_id} should support prompt_cache_key"
        )

    for provider_id in ("anthropic", "googlegenai", "openai", "ollama", "xai"):
        assert not entries[provider_id].get("supports_prompt_cache_key"), (
            f"{provider_id} should not support prompt_cache_key"
        )


def test_plugin_supports_prompt_cache_key_forwarded_to_all_providers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A plugin with supports_prompt_cache_key=True appears with that flag
    in all_providers()."""
    plugin_dir = _point_plugin_dirs(monkeypatch, tmp_path)
    _write_plugin(
        plugin_dir,
        """
        from app.agent.providers.base import LLMProviderBase
        from app.agent.providers.plugin_api import ProviderPlugin

        class DummyProvider(LLMProviderBase):
            async def chat(self, messages, tools=None, **kwargs): ...
            async def stream(self, messages, tools=None, **kwargs):
                if False: yield None

        provider = ProviderPlugin(
            id="cacheplugin",
            label="Cache Plugin",
            description="Supports prompt cache keys.",
            kind="api_key",
            factory=lambda ctx: DummyProvider(),
            supports_prompt_cache_key=True,
        )
        """,
    )

    entry = find("cacheplugin")
    assert entry is not None
    assert entry.get("supports_prompt_cache_key") is True


def test_plugin_without_prompt_cache_key_forwarded_as_false(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A plugin without supports_prompt_cache_key appears with False in
    all_providers()."""
    plugin_dir = _point_plugin_dirs(monkeypatch, tmp_path)
    _write_plugin(
        plugin_dir,
        """
        from app.agent.providers.base import LLMProviderBase
        from app.agent.providers.plugin_api import ProviderPlugin

        class DummyProvider(LLMProviderBase):
            async def chat(self, messages, tools=None, **kwargs): ...
            async def stream(self, messages, tools=None, **kwargs):
                if False: yield None

        provider = ProviderPlugin(
            id="nocacheplugin",
            label="No Cache Plugin",
            description="No prompt cache key support.",
            kind="api_key",
            factory=lambda ctx: DummyProvider(),
        )
        """,
    )

    entry = find("nocacheplugin")
    assert entry is not None
    assert not entry.get("supports_prompt_cache_key")
