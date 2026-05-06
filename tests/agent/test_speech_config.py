"""Unit tests for app/agent/speech/_config.py."""

from __future__ import annotations

import os
from unittest.mock import patch

import pytest
import yaml

import app.agent.speech._config as speech_config
from app.agent.speech._config import VoiceConfig


def test_load_raw_missing_file_returns_none(tmp_path) -> None:
    path = tmp_path / "speech.yaml"

    with patch("app.agent.speech._config._config_path", return_value=path):
        with patch.object(speech_config, "_cache", None):
            assert speech_config._load_raw() is None


def test_load_raw_yaml_parse_failure_returns_none_and_logs_warning(tmp_path) -> None:
    path = tmp_path / "speech.yaml"
    path.write_text("voice: [broken", encoding="utf-8")

    with patch("app.agent.speech._config._config_path", return_value=path):
        with patch.object(speech_config, "_cache", None):
            with patch.object(speech_config.logger, "warning") as warning_mock:
                assert speech_config._load_raw() is None

    warning_mock.assert_called_once()


def test_load_raw_non_mapping_yaml_returns_none_and_logs_warning(tmp_path) -> None:
    path = tmp_path / "speech.yaml"
    path.write_text("just-a-string", encoding="utf-8")

    with patch("app.agent.speech._config._config_path", return_value=path):
        with patch.object(speech_config, "_cache", None):
            with patch.object(speech_config.logger, "warning") as warning_mock:
                assert speech_config._load_raw() is None

    warning_mock.assert_called_once()


def test_load_raw_valid_file_returns_dict(tmp_path) -> None:
    path = tmp_path / "speech.yaml"
    path.write_text("voice:\n  enabled: true\n", encoding="utf-8")

    with patch("app.agent.speech._config._config_path", return_value=path):
        with patch.object(speech_config, "_cache", None):
            assert speech_config._load_raw() == {"voice": {"enabled": True}}


def test_load_raw_mtime_cache_hit_returns_same_object_without_reread(tmp_path) -> None:
    path = tmp_path / "speech.yaml"
    path.write_text(
        "voice:\n  enabled: true\n  model: local:base\n",
        encoding="utf-8",
    )

    with patch("app.agent.speech._config._config_path", return_value=path):
        with patch.object(speech_config, "_cache", None):
            with patch(
                "app.agent.speech._config.yaml.safe_load", wraps=yaml.safe_load
            ) as safe_load_mock:
                first = speech_config._load_raw()
                second = speech_config._load_raw()

    assert first is second
    assert safe_load_mock.call_count == 1


def test_load_raw_mtime_cache_miss_rereads_file(tmp_path) -> None:
    path = tmp_path / "speech.yaml"
    path.write_text(
        "voice:\n  enabled: true\n  model: local:base\n",
        encoding="utf-8",
    )

    with patch("app.agent.speech._config._config_path", return_value=path):
        with patch.object(speech_config, "_cache", None):
            with patch(
                "app.agent.speech._config.yaml.safe_load", wraps=yaml.safe_load
            ) as safe_load_mock:
                first = speech_config._load_raw()
                old_mtime = path.stat().st_mtime_ns
                path.write_text(
                    "voice:\n  enabled: true\n  model: local:other\n",
                    encoding="utf-8",
                )
                os.utime(
                    path, ns=(old_mtime + 1_000_000_000, old_mtime + 1_000_000_000)
                )
                second = speech_config._load_raw()

    assert first is not second
    assert second["voice"]["model"] == "local:other"
    assert safe_load_mock.call_count == 2


def test_get_voice_config_missing_file_returns_none(tmp_path) -> None:
    path = tmp_path / "speech.yaml"

    with patch("app.agent.speech._config._config_path", return_value=path):
        with patch.object(speech_config, "_cache", None):
            assert speech_config.get_voice_config() is None


def test_get_voice_config_missing_voice_section_returns_none(tmp_path) -> None:
    path = tmp_path / "speech.yaml"
    path.write_text("tts: {}\n", encoding="utf-8")

    with patch("app.agent.speech._config._config_path", return_value=path):
        with patch.object(speech_config, "_cache", None):
            assert speech_config.get_voice_config() is None


def test_get_voice_config_enabled_false_returns_none(tmp_path) -> None:
    path = tmp_path / "speech.yaml"
    path.write_text(
        "voice:\n  enabled: false\n  model: local:base\n",
        encoding="utf-8",
    )

    with patch("app.agent.speech._config._config_path", return_value=path):
        with patch.object(speech_config, "_cache", None):
            assert speech_config.get_voice_config() is None


def test_get_voice_config_non_bool_enabled_returns_none(tmp_path) -> None:
    path = tmp_path / "speech.yaml"
    path.write_text(
        "voice:\n  enabled: 1\n  model: local:base\n",
        encoding="utf-8",
    )

    with patch("app.agent.speech._config._config_path", return_value=path):
        with patch.object(speech_config, "_cache", None):
            assert speech_config.get_voice_config() is None


def test_get_voice_config_model_missing_colon_returns_none(tmp_path) -> None:
    path = tmp_path / "speech.yaml"
    path.write_text(
        "voice:\n  enabled: true\n  model: localbase\n",
        encoding="utf-8",
    )

    with patch("app.agent.speech._config._config_path", return_value=path):
        with patch.object(speech_config, "_cache", None):
            assert speech_config.get_voice_config() is None


def test_get_voice_config_blank_provider_returns_none(tmp_path) -> None:
    path = tmp_path / "speech.yaml"
    path.write_text(
        "voice:\n  enabled: true\n  model: :base\n",
        encoding="utf-8",
    )

    with patch("app.agent.speech._config._config_path", return_value=path):
        with patch.object(speech_config, "_cache", None):
            assert speech_config.get_voice_config() is None


def test_get_voice_config_blank_name_returns_none(tmp_path) -> None:
    path = tmp_path / "speech.yaml"
    path.write_text(
        "voice:\n  enabled: true\n  model: local:\n",
        encoding="utf-8",
    )

    with patch("app.agent.speech._config._config_path", return_value=path):
        with patch.object(speech_config, "_cache", None):
            assert speech_config.get_voice_config() is None


def test_get_voice_config_valid_enabled_config_returns_voice_config(tmp_path) -> None:
    path = tmp_path / "speech.yaml"
    path.write_text(
        "voice:\n  enabled: true\n  model: local:base\n  language: en\n  max_file_mb: 10\n",
        encoding="utf-8",
    )

    with patch("app.agent.speech._config._config_path", return_value=path):
        with patch.object(speech_config, "_cache", None):
            cfg = speech_config.get_voice_config()

    assert cfg == VoiceConfig(
        provider="local", model="base", language="en", max_file_mb=10
    )


def test_get_voice_config_non_string_language_falls_back_to_auto(tmp_path) -> None:
    path = tmp_path / "speech.yaml"
    path.write_text(
        "voice:\n  enabled: true\n  model: local:base\n  language: 123\n",
        encoding="utf-8",
    )

    with patch("app.agent.speech._config._config_path", return_value=path):
        with patch.object(speech_config, "_cache", None):
            cfg = speech_config.get_voice_config()

    assert cfg is not None
    assert cfg.language == "auto"


@pytest.mark.parametrize("max_file_mb", [0, -1])
def test_get_voice_config_invalid_max_file_mb_falls_back_to_25(
    tmp_path, max_file_mb: int
) -> None:
    path = tmp_path / "speech.yaml"
    path.write_text(
        f"voice:\n  enabled: true\n  model: local:base\n  max_file_mb: {max_file_mb}\n",
        encoding="utf-8",
    )

    with patch("app.agent.speech._config._config_path", return_value=path):
        with patch.object(speech_config, "_cache", None):
            cfg = speech_config.get_voice_config()

    assert cfg is not None
    assert cfg.max_file_mb == 25


def test_save_speech_config_invalid_model_raises_value_error(tmp_path) -> None:
    path = tmp_path / "speech.yaml"

    with patch("app.agent.speech._config._config_path", return_value=path):
        with patch.object(speech_config, "_cache", None):
            with pytest.raises(ValueError):
                speech_config.save_speech_config(
                    enabled=True,
                    model="localbase",
                    language="en",
                    max_file_mb=10,
                )


def test_save_speech_config_writes_correct_yaml_and_round_trips(tmp_path) -> None:
    path = tmp_path / "speech.yaml"

    with patch("app.agent.speech._config._config_path", return_value=path):
        with patch.object(speech_config, "_cache", None):
            speech_config.save_speech_config(
                enabled=True,
                model="local:base",
                language="fr",
                max_file_mb=7,
            )
            cfg = speech_config.get_voice_config()

    assert cfg == VoiceConfig(
        provider="local", model="base", language="fr", max_file_mb=7
    )


def test_save_speech_config_preserves_existing_top_level_sections(tmp_path) -> None:
    path = tmp_path / "speech.yaml"
    path.write_text("tts: {}\n", encoding="utf-8")

    with patch("app.agent.speech._config._config_path", return_value=path):
        with patch.object(speech_config, "_cache", None):
            speech_config.save_speech_config(
                enabled=True,
                model="local:base",
                language="en",
                max_file_mb=25,
            )
            raw = speech_config._load_raw()

    assert raw is not None
    assert raw["tts"] == {}
    assert raw["voice"] == {
        "enabled": True,
        "model": "local:base",
        "language": "en",
        "max_file_mb": 25,
    }


def test_save_speech_config_busts_cache_after_save(tmp_path) -> None:
    path = tmp_path / "speech.yaml"

    with patch("app.agent.speech._config._config_path", return_value=path):
        with patch.object(speech_config, "_cache", None):
            speech_config.save_speech_config(
                enabled=True,
                model="local:base",
                language="en",
                max_file_mb=25,
            )
            first = speech_config.get_voice_config()
            speech_config.save_speech_config(
                enabled=True,
                model="local:tiny",
                language="de",
                max_file_mb=12,
            )
            second = speech_config.get_voice_config()

    assert first == VoiceConfig(
        provider="local", model="base", language="en", max_file_mb=25
    )
    assert second == VoiceConfig(
        provider="local", model="tiny", language="de", max_file_mb=12
    )
