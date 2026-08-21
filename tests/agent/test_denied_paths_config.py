"""Tests for app/agent/denied_paths_config.py — denied_paths.yaml load/save."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest
import yaml

from app.agent.denied_paths_config import (
    DEFAULT_DENIED_PATTERNS,
    DeniedPathsFileConfig,
    load_config,
    save_config,
)


def test_load_missing_file_returns_seed_defaults(tmp_path: Path) -> None:
    cfg = load_config(tmp_path / "absent.yaml")
    assert cfg.denied_patterns == list(DEFAULT_DENIED_PATTERNS)
    # Must not write the file as a side-effect.
    assert not (tmp_path / "absent.yaml").exists()


def test_load_config_reuses_unchanged_content_without_reparsing(tmp_path: Path) -> None:
    target = tmp_path / "denied_paths.yaml"
    target.write_text("denied_patterns: ['**/secrets/**']\n", encoding="utf-8")

    with patch(
        "app.agent.denied_paths_config.yaml.safe_load", wraps=yaml.safe_load
    ) as load:
        assert load_config(target).denied_patterns == ["**/secrets/**"]
        assert load_config(target).denied_patterns == ["**/secrets/**"]

    assert load.call_count == 1


def test_load_config_does_not_cache_oversized_content(tmp_path: Path) -> None:
    target = tmp_path / "denied_paths.yaml"
    target.write_text(
        "denied_patterns: ['**/secrets/**']\n# " + ("x" * 200_000),
        encoding="utf-8",
    )

    with patch(
        "app.agent.denied_paths_config.yaml.safe_load", wraps=yaml.safe_load
    ) as load:
        assert load_config(target).denied_patterns == ["**/secrets/**"]
        assert load_config(target).denied_patterns == ["**/secrets/**"]

    assert load.call_count == 2


def test_load_config_does_not_cache_malformed_errors(tmp_path: Path) -> None:
    target = tmp_path / "denied_paths.yaml"
    target.write_text("denied_patterns: [", encoding="utf-8")

    with patch(
        "app.agent.denied_paths_config.yaml.safe_load", wraps=yaml.safe_load
    ) as load:
        with pytest.raises(ValueError, match="Invalid YAML"):
            load_config(target)
        with pytest.raises(ValueError, match="Invalid YAML"):
            load_config(target)

    assert load.call_count == 2


def test_save_config_invalidates_cached_content(tmp_path: Path) -> None:
    target = tmp_path / "denied_paths.yaml"
    target.write_text("denied_patterns: ['**/secrets/**']\n", encoding="utf-8")

    assert load_config(target).denied_patterns == ["**/secrets/**"]

    save_config(DeniedPathsFileConfig(denied_patterns=["**/.env"]), path=target)

    assert load_config(target).denied_patterns == ["**/.env"]


def test_cached_patterns_preserve_denial_behavior(tmp_path: Path) -> None:
    target = tmp_path / "denied_paths.yaml"
    save_config(
        DeniedPathsFileConfig(denied_patterns=["**/.env", "**/secrets/**"]),
        path=target,
    )

    first = load_config(target)
    second = load_config(target)

    assert first.denied_patterns == ["**/.env", "**/secrets/**"]
    assert second.denied_patterns == ["**/.env", "**/secrets/**"]


def test_load_config_falls_back_to_legacy_sandbox_yaml(tmp_path: Path) -> None:
    legacy = tmp_path / "sandbox.yaml"
    legacy.write_text("denied_patterns: ['**/legacy/**']\n", encoding="utf-8")

    with patch(
        "app.agent.denied_paths_config.config_path",
        return_value=tmp_path / "denied_paths.yaml",
    ):
        with patch(
            "app.agent.denied_paths_config.legacy_config_path", return_value=legacy
        ):
            cfg = load_config()
            assert cfg.denied_patterns == ["**/legacy/**"]
