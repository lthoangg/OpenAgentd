from __future__ import annotations

from pathlib import Path
from textwrap import dedent
from typing import Any

import pytest

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
