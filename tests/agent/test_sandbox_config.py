"""Tests for app/agent/sandbox_config.py — sandbox.yaml load/save."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest
import yaml

from app.agent.sandbox_config import (
    DEFAULT_DENIED_PATTERNS,
    SandboxFileConfig,
    load_config,
    save_config,
)


def test_load_missing_file_returns_seed_defaults(tmp_path: Path) -> None:
    cfg = load_config(tmp_path / "absent.yaml")
    assert cfg.denied_patterns == list(DEFAULT_DENIED_PATTERNS)
    # Must not write the file as a side-effect.
    assert not (tmp_path / "absent.yaml").exists()


def test_load_config_reuses_unchanged_content_without_reparsing(tmp_path: Path) -> None:
    target = tmp_path / "sandbox.yaml"
    target.write_text("denied_patterns: ['**/secrets/**']\n", encoding="utf-8")

    with patch("app.agent.sandbox_config.yaml.safe_load", wraps=yaml.safe_load) as load:
        assert load_config(target).denied_patterns == ["**/secrets/**"]
        assert load_config(target).denied_patterns == ["**/secrets/**"]

    assert load.call_count == 1


def test_load_config_does_not_cache_oversized_content(tmp_path: Path) -> None:
    target = tmp_path / "sandbox.yaml"
    target.write_text(
        "denied_patterns: ['**/secrets/**']\n# " + ("x" * 200_000),
        encoding="utf-8",
    )

    with patch("app.agent.sandbox_config.yaml.safe_load", wraps=yaml.safe_load) as load:
        assert load_config(target).denied_patterns == ["**/secrets/**"]
        assert load_config(target).denied_patterns == ["**/secrets/**"]

    assert load.call_count == 2


def test_load_config_returns_fresh_mutable_config_from_cached_content(
    tmp_path: Path,
) -> None:
    target = tmp_path / "sandbox.yaml"
    target.write_text("denied_patterns: ['**/secrets/**']\n", encoding="utf-8")

    first = load_config(target)
    first.denied_patterns.append("**/mutated/**")

    assert load_config(target).denied_patterns == ["**/secrets/**"]


def test_load_config_sees_direct_same_size_content_edit(tmp_path: Path) -> None:
    target = tmp_path / "sandbox.yaml"
    target.write_text("denied_patterns: ['**/alpha/**']\n", encoding="utf-8")
    assert load_config(target).denied_patterns == ["**/alpha/**"]

    # Deliberately same byte length: metadata-only keys can miss this edit.
    target.write_text("denied_patterns: ['**/bravo/**']\n", encoding="utf-8")

    assert load_config(target).denied_patterns == ["**/bravo/**"]


def test_save_config_invalidates_cached_content(tmp_path: Path) -> None:
    target = tmp_path / "sandbox.yaml"
    target.write_text("denied_patterns: ['**/before/**']\n", encoding="utf-8")

    with patch("app.agent.sandbox_config.yaml.safe_load", wraps=yaml.safe_load) as load:
        assert load_config(target).denied_patterns == ["**/before/**"]
        # Identical content would otherwise match the content key, so this
        # proves save_config invalidates rather than merely relying on a miss.
        save_config(SandboxFileConfig(denied_patterns=["**/before/**"]), target)
        assert load_config(target).denied_patterns == ["**/before/**"]

    assert load.call_count == 2


def test_load_config_does_not_cache_malformed_errors(tmp_path: Path) -> None:
    target = tmp_path / "sandbox.yaml"
    target.write_text("not: valid: yaml: [\n", encoding="utf-8")

    with patch("app.agent.sandbox_config.yaml.safe_load", wraps=yaml.safe_load) as load:
        for _ in range(2):
            with pytest.raises(ValueError, match="Invalid YAML"):
                load_config(target)

    assert load.call_count == 2


def test_load_config_recovers_after_malformed_file_is_fixed(tmp_path: Path) -> None:
    target = tmp_path / "sandbox.yaml"
    target.write_text("not: valid: yaml: [\n", encoding="utf-8")
    with pytest.raises(ValueError, match="Invalid YAML"):
        load_config(target)

    target.write_text("denied_patterns: ['**/recovered/**']\n", encoding="utf-8")

    assert load_config(target).denied_patterns == ["**/recovered/**"]


def test_save_then_load_roundtrip(tmp_path: Path) -> None:
    target = tmp_path / "sandbox.yaml"
    save_config(SandboxFileConfig(denied_patterns=["**/foo", "bar/*"]), target)

    cfg = load_config(target)
    assert cfg.denied_patterns == ["**/foo", "bar/*"]


def test_cached_patterns_preserve_sandbox_denial_behavior(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.agent.sandbox import SandboxConfig

    target = tmp_path / "sandbox.yaml"
    target.write_text("denied_patterns: ['**/secrets/**']\n", encoding="utf-8")
    monkeypatch.setattr("app.agent.sandbox_config.config_path", lambda: target)

    sandbox = SandboxConfig(workspace=str(tmp_path / "workspace"), denied_roots=[])

    with pytest.raises(PermissionError):
        sandbox.validate_path(tmp_path / "workspace" / "secrets" / "token.txt")


def test_load_drops_blank_patterns(tmp_path: Path) -> None:
    target = tmp_path / "sandbox.yaml"
    target.write_text("denied_patterns:\n  - '**/foo'\n  - ''\n  - '   '\n")
    cfg = load_config(target)
    assert cfg.denied_patterns == ["**/foo"]


def test_load_invalid_yaml_raises(tmp_path: Path) -> None:
    target = tmp_path / "sandbox.yaml"
    target.write_text("not: valid: yaml: [\n")
    with pytest.raises(ValueError, match="Invalid YAML"):
        load_config(target)


def test_load_top_level_must_be_mapping(tmp_path: Path) -> None:
    target = tmp_path / "sandbox.yaml"
    target.write_text("- just\n- a\n- list\n")
    with pytest.raises(ValueError, match="expected a YAML mapping"):
        load_config(target)


def test_save_creates_parent_directory(tmp_path: Path) -> None:
    target = tmp_path / "nested" / "dir" / "sandbox.yaml"
    save_config(SandboxFileConfig(denied_patterns=["x"]), target)
    assert target.exists()


# ============================================================================
# NEW TESTS: Core behavior of the default factory change
# ============================================================================


def test_sandbox_file_config_default_seeding() -> None:
    """SandboxFileConfig() with no args yields DEFAULT_DENIED_PATTERNS, not []."""
    cfg = SandboxFileConfig()
    assert cfg.denied_patterns == list(DEFAULT_DENIED_PATTERNS)
    assert cfg.denied_patterns == ["**/.env", "**/.env.*"]


def test_sandbox_file_config_default_factory_independence() -> None:
    """Each instance gets a fresh list; mutations don't affect others."""
    cfg1 = SandboxFileConfig()
    cfg2 = SandboxFileConfig()

    # Mutate cfg1's list
    cfg1.denied_patterns.append("custom_pattern")

    # cfg2 should still have the original defaults
    assert cfg2.denied_patterns == list(DEFAULT_DENIED_PATTERNS)
    assert "custom_pattern" not in cfg2.denied_patterns


def test_sandbox_file_config_explicit_patterns_override_default() -> None:
    """Passing denied_patterns explicitly overrides the default."""
    cfg = SandboxFileConfig(denied_patterns=["**/secrets", "**/private"])
    assert cfg.denied_patterns == ["**/secrets", "**/private"]
    assert "**/.env" not in cfg.denied_patterns


def test_sandbox_file_config_explicit_empty_list() -> None:
    """Passing an empty list explicitly is allowed and respected."""
    cfg = SandboxFileConfig(denied_patterns=[])
    assert cfg.denied_patterns == []


def test_load_config_yaml_missing_denied_patterns_key() -> None:
    """YAML file exists but denied_patterns key is absent → uses default."""
    target = Path("/tmp/test_sandbox_missing_key.yaml")
    try:
        # Write a YAML file with no denied_patterns key
        target.write_text("# empty config\n")
        cfg = load_config(target)
        # Should seed with defaults, not return []
        assert cfg.denied_patterns == list(DEFAULT_DENIED_PATTERNS)
    finally:
        target.unlink(missing_ok=True)


def test_load_config_yaml_explicit_empty_list() -> None:
    """YAML file with explicit empty denied_patterns → returns []."""
    target = Path("/tmp/test_sandbox_explicit_empty.yaml")
    try:
        target.write_text("denied_patterns: []\n")
        cfg = load_config(target)
        # User explicitly cleared it; should not seed
        assert cfg.denied_patterns == []
    finally:
        target.unlink(missing_ok=True)


def test_load_config_yaml_explicit_empty_list_with_tmp_path(tmp_path: Path) -> None:
    """YAML file with explicit empty denied_patterns → returns [] (using tmp_path)."""
    target = tmp_path / "sandbox.yaml"
    target.write_text("denied_patterns: []\n")
    cfg = load_config(target)
    assert cfg.denied_patterns == []


def test_save_then_load_empty_list_roundtrip(tmp_path: Path) -> None:
    """Save empty list, then load it back — should persist as empty."""
    target = tmp_path / "sandbox.yaml"
    cfg_to_save = SandboxFileConfig(denied_patterns=[])
    save_config(cfg_to_save, target)

    cfg_loaded = load_config(target)
    assert cfg_loaded.denied_patterns == []


def test_save_config_returns_resolved_path(tmp_path: Path) -> None:
    """save_config returns the resolved target path."""
    target = tmp_path / "sandbox.yaml"
    cfg = SandboxFileConfig(denied_patterns=["test"])
    returned_path = save_config(cfg, target)

    assert returned_path == target
    assert returned_path.exists()


def test_save_config_atomic_write_creates_valid_yaml(tmp_path: Path) -> None:
    """save_config writes valid YAML that can be parsed back."""
    target = tmp_path / "sandbox.yaml"
    cfg = SandboxFileConfig(denied_patterns=["**/foo", "**/bar"])
    save_config(cfg, target)

    # Read the file and verify it's valid YAML
    import yaml

    content = target.read_text(encoding="utf-8")
    parsed = yaml.safe_load(content)
    assert isinstance(parsed, dict)
    assert "denied_patterns" in parsed
    assert parsed["denied_patterns"] == ["**/foo", "**/bar"]


def test_sandbox_file_config_extra_forbid_rejects_unknown_keys() -> None:
    """SandboxFileConfig with extra='forbid' rejects unknown YAML keys."""
    from pydantic import ValidationError

    with pytest.raises(ValidationError) as exc_info:
        SandboxFileConfig.model_validate(
            {
                "denied_patterns": ["test"],
                "unknown_key": "should_fail",
            }
        )
    assert "unknown_key" in str(exc_info.value)


def test_load_config_extra_forbid_rejects_unknown_keys(tmp_path: Path) -> None:
    """load_config rejects YAML with unknown keys due to extra='forbid'."""
    from pydantic import ValidationError

    target = tmp_path / "sandbox.yaml"
    target.write_text("denied_patterns: ['test']\nunknown_field: value\n")

    with pytest.raises(ValidationError) as exc_info:
        load_config(target)
    assert "unknown_field" in str(exc_info.value)


def test_load_config_whitespace_only_patterns_stripped(tmp_path: Path) -> None:
    """Patterns with only whitespace are stripped and dropped."""
    target = tmp_path / "sandbox.yaml"
    # Use actual whitespace (spaces and tabs), not escape sequences
    target.write_text(
        "denied_patterns:\n"
        "  - '**/foo'\n"
        "  - '   '\n"
        "  - '		'\n"  # actual tab characters
        "  - '**/bar'\n"
    )
    cfg = load_config(target)
    # Only non-whitespace patterns remain
    assert cfg.denied_patterns == ["**/foo", "**/bar"]


def test_load_config_all_whitespace_patterns_results_in_empty(tmp_path: Path) -> None:
    """If all patterns are whitespace-only, result is empty list."""
    target = tmp_path / "sandbox.yaml"
    # Use actual whitespace characters (spaces and tabs)
    target.write_text(
        "denied_patterns:\n"
        "  - '   '\n"
        "  - '	'\n"  # actual tab
        "  - '  '\n"
    )
    cfg = load_config(target)
    assert cfg.denied_patterns == []


def test_save_config_with_nested_parent_creates_all_dirs(tmp_path: Path) -> None:
    """save_config creates all parent directories if they don't exist."""
    target = tmp_path / "a" / "b" / "c" / "d" / "sandbox.yaml"
    cfg = SandboxFileConfig(denied_patterns=["test"])
    returned = save_config(cfg, target)

    assert returned == target
    assert target.exists()
    assert target.parent.exists()


def test_load_config_preserves_pattern_order(tmp_path: Path) -> None:
    """Pattern order is preserved through load/save cycle."""
    target = tmp_path / "sandbox.yaml"
    patterns = ["**/z", "**/a", "**/m", "**/b"]
    cfg_to_save = SandboxFileConfig(denied_patterns=patterns)
    save_config(cfg_to_save, target)

    cfg_loaded = load_config(target)
    assert cfg_loaded.denied_patterns == patterns


def test_load_config_yaml_null_value_becomes_empty_dict(tmp_path: Path) -> None:
    """YAML file with null content is treated as empty dict, uses defaults."""
    target = tmp_path / "sandbox.yaml"
    target.write_text("null\n")
    cfg = load_config(target)
    # null becomes {}, so denied_patterns key is missing → uses default
    assert cfg.denied_patterns == list(DEFAULT_DENIED_PATTERNS)


def test_load_config_yaml_empty_file_uses_defaults(tmp_path: Path) -> None:
    """Empty YAML file is treated as empty dict, uses defaults."""
    target = tmp_path / "sandbox.yaml"
    target.write_text("")
    cfg = load_config(target)
    assert cfg.denied_patterns == list(DEFAULT_DENIED_PATTERNS)


def test_sandbox_file_config_field_description() -> None:
    """SandboxFileConfig.denied_patterns has the expected description."""
    field_info = SandboxFileConfig.model_fields["denied_patterns"]
    assert "DEFAULT_DENIED_PATTERNS" in field_info.description
