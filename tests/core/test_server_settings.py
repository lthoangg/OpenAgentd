from __future__ import annotations

import os
import stat
from pathlib import Path

import yaml

from app.core.runtime_settings import (
    RuntimeSettings,
    ServerSettings,
    save_runtime_settings,
)
from app.core.server_settings import (
    load_server_settings,
    save_server_settings,
)


def test_server_settings_are_persisted_separately_from_shared_runtime_settings(
    tmp_path: Path,
) -> None:
    shared_path = tmp_path / "settings.yaml"
    shared_path.write_text(
        "title_generation:\n  enabled: false\nproviders:\n  openai:\n    visible_models: []\n",
        encoding="utf-8",
    )
    server_path = tmp_path / "server.yaml"

    save_server_settings(
        ServerSettings(host="0.0.0.0", port=9000, access_key="lan-secret"),
        server_path,
    )

    assert load_server_settings(server_path).model_dump() == {
        "host": "0.0.0.0",
        "port": 9000,
        "access_key": "lan-secret",
    }
    assert "server:" not in shared_path.read_text(encoding="utf-8")
    if os.name != "nt":
        assert stat.S_IMODE(server_path.stat().st_mode) == 0o600


def test_server_settings_migrate_legacy_settings_yaml_once(tmp_path: Path) -> None:
    shared_path = tmp_path / "settings.yaml"
    shared_path.write_text(
        "server:\n  host: 0.0.0.0\n  port: 4082\n  access_key: legacy-secret\n"
        "summarization:\n  prompt_token_threshold: 12000\n",
        encoding="utf-8",
    )
    server_path = tmp_path / "server.yaml"

    result = load_server_settings(server_path, legacy_path=shared_path)

    assert result == ServerSettings(
        host="0.0.0.0", port=4082, access_key="legacy-secret"
    )
    assert yaml.safe_load(server_path.read_text(encoding="utf-8")) == {
        "host": "0.0.0.0",
        "port": 4082,
        "access_key": "legacy-secret",
    }
    migrated_shared = shared_path.read_text(encoding="utf-8")
    assert "summarization:" in migrated_shared
    assert "server:" not in migrated_shared
    assert "legacy-secret" not in migrated_shared


def test_existing_server_yaml_inherits_missing_legacy_access_key(
    tmp_path: Path,
) -> None:
    shared_path = tmp_path / "settings.yaml"
    shared_path.write_text(
        "server:\n  host: 0.0.0.0\n  port: 4082\n  access_key: legacy-secret\n",
        encoding="utf-8",
    )
    server_path = tmp_path / "server.yaml"
    server_path.write_text("host: 0.0.0.0\nport: 4082\n", encoding="utf-8")

    result = load_server_settings(server_path, legacy_path=shared_path)

    assert result == ServerSettings(
        host="0.0.0.0", port=4082, access_key="legacy-secret"
    )
    assert yaml.safe_load(server_path.read_text(encoding="utf-8")) == {
        "host": "0.0.0.0",
        "port": 4082,
        "access_key": "legacy-secret",
    }
    assert "server:" not in shared_path.read_text(encoding="utf-8")


def test_existing_server_yaml_wins_over_legacy_settings(tmp_path: Path) -> None:
    shared_path = tmp_path / "settings.yaml"
    shared_path.write_text(
        "server:\n  host: 0.0.0.0\n  access_key: legacy-secret\n",
        encoding="utf-8",
    )
    server_path = tmp_path / "server.yaml"
    server_path.write_text(
        "host: 127.0.0.1\nport: 5000\naccess_key: current-secret\n",
        encoding="utf-8",
    )

    result = load_server_settings(server_path, legacy_path=shared_path)

    assert result == ServerSettings(
        host="127.0.0.1", port=5000, access_key="current-secret"
    )
    migrated_shared = shared_path.read_text(encoding="utf-8")
    assert "server:" not in migrated_shared
    assert "legacy-secret" not in migrated_shared


def test_shared_runtime_settings_do_not_recreate_server_block(tmp_path: Path) -> None:
    shared_path = tmp_path / "settings.yaml"
    save_runtime_settings(
        RuntimeSettings(
            server=ServerSettings(host="0.0.0.0", port=9000, access_key="must-not-leak")
        ),
        shared_path,
    )

    content = shared_path.read_text(encoding="utf-8")
    assert "server:" not in content
    assert "must-not-leak" not in content
