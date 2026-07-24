from __future__ import annotations

from app.agent.providers.catalog import find
from app.cli.commands.auth import _PROVIDERS
from app.services.provider_connection import provider_is_configured


def test_grok_build_is_registered_as_a_distinct_oauth_provider() -> None:
    entry = find("grok")

    assert entry is not None
    assert entry["label"] == "Grok Build"
    assert entry["kind"] == "oauth"
    assert entry["oauth_command"] == "openagentd auth grok"
    assert entry["metadata_source_provider"] == "xai"


def test_grok_build_auth_uses_the_grok_provider_prefix() -> None:
    assert _PROVIDERS["grok"][0] == "app.agent.providers.grok.oauth"


def test_grok_build_is_configured_when_its_oauth_token_exists(
    tmp_path, monkeypatch
) -> None:
    entry = {
        "id": "grok",
        "label": "Grok Build",
        "description": "Grok Build subscription access.",
        "kind": "oauth",
    }
    monkeypatch.setattr(
        "app.services.provider_connection.settings.OPENAGENTD_CACHE_DIR",
        str(tmp_path),
    )
    (tmp_path / "grok_oauth.json").write_text("{}", encoding="utf-8")

    assert provider_is_configured(entry) is True
