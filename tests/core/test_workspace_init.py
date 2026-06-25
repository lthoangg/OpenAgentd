from __future__ import annotations

from pathlib import Path

from app.cli.seed import SeedResult
from app.cli.seed import _install_from_local
from app.cli.seed import _replace_placeholder_if_needed
from app.core.workspace_init import ensure_workspace_initialized


def test_ensure_workspace_initialized_creates_roots_and_seeds(
    monkeypatch,
    tmp_path: Path,
) -> None:
    import app.core.workspace_init as workspace_init

    config = tmp_path / "config"
    called: list[tuple[Path, str]] = []

    monkeypatch.setattr(
        workspace_init.settings, "OPENAGENTD_DATA_DIR", str(tmp_path / "data")
    )
    monkeypatch.setattr(workspace_init.settings, "OPENAGENTD_CONFIG_DIR", str(config))
    monkeypatch.setattr(
        workspace_init.settings, "OPENAGENTD_STATE_DIR", str(tmp_path / "state")
    )
    monkeypatch.setattr(
        workspace_init.settings, "OPENAGENTD_CACHE_DIR", str(tmp_path / "cache")
    )
    monkeypatch.setattr(
        workspace_init.settings, "OPENAGENTD_WORKSPACE_DIR", str(tmp_path / "workspace")
    )
    monkeypatch.setattr(workspace_init.settings, "AGENTS_DIR", str(config / "agents"))
    monkeypatch.setattr(workspace_init.settings, "SKILLS_DIR", str(config / "skills"))
    monkeypatch.setattr(
        workspace_init.settings, "OPENAGENTD_PLUGINS_DIRS", str(config / "plugins")
    )

    def install_seed(config_dir: Path, *, provider_model: str) -> SeedResult:
        called.append((config_dir, provider_model))
        (config_dir / "agents").mkdir(parents=True, exist_ok=True)
        (config_dir / "agents" / "openagentd.md").write_text(
            "---\nmodel: __PROVIDER_MODEL__\n---\n"
        )
        return SeedResult(["openagentd.md"], [], [], [], "test")

    monkeypatch.setattr("app.cli.seed.install_seed", install_seed)

    ensure_workspace_initialized()

    assert (config / "agents").is_dir()
    assert (config / "skills").is_dir()
    assert (config / "plugins").is_dir()
    assert (tmp_path / "cache").is_dir()
    assert (config / "agents" / "executor.md").is_file()
    assert (config / "agents" / "explorer.md").is_file()
    assert (config / "agents" / "coding" / "coder.md").is_file()
    assert (config / "agents" / "coding" / "explorer.md").is_file()
    assert called == [(config, "__PROVIDER_MODEL__")]


def test_ensure_workspace_initialized_skips_seed_when_agents_exist(
    monkeypatch,
    tmp_path: Path,
) -> None:
    import app.core.workspace_init as workspace_init

    config = tmp_path / "config"
    agents = config / "agents"
    agents.mkdir(parents=True)
    (agents / "existing.md").write_text("---\nmodel: openai:gpt-5\n---\n")

    monkeypatch.setattr(
        workspace_init.settings, "OPENAGENTD_DATA_DIR", str(tmp_path / "data")
    )
    monkeypatch.setattr(workspace_init.settings, "OPENAGENTD_CONFIG_DIR", str(config))
    monkeypatch.setattr(
        workspace_init.settings, "OPENAGENTD_STATE_DIR", str(tmp_path / "state")
    )
    monkeypatch.setattr(
        workspace_init.settings, "OPENAGENTD_CACHE_DIR", str(tmp_path / "cache")
    )
    monkeypatch.setattr(
        workspace_init.settings, "OPENAGENTD_WORKSPACE_DIR", str(tmp_path / "workspace")
    )
    monkeypatch.setattr(workspace_init.settings, "AGENTS_DIR", str(agents))
    monkeypatch.setattr(workspace_init.settings, "SKILLS_DIR", str(config / "skills"))
    monkeypatch.setattr(
        workspace_init.settings, "OPENAGENTD_PLUGINS_DIRS", str(config / "plugins")
    )
    monkeypatch.setattr(
        "app.cli.seed.install_seed",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("unexpected seed")
        ),
    )

    ensure_workspace_initialized()

    assert (config / "plugins").is_dir()


def test_ensure_workspace_initialized_materializes_builtins_without_seed(
    monkeypatch,
    tmp_path: Path,
) -> None:
    import app.core.workspace_init as workspace_init

    config = tmp_path / "config"
    monkeypatch.setattr(
        workspace_init.settings, "OPENAGENTD_DATA_DIR", str(tmp_path / "data")
    )
    monkeypatch.setattr(workspace_init.settings, "OPENAGENTD_CONFIG_DIR", str(config))
    monkeypatch.setattr(
        workspace_init.settings, "OPENAGENTD_STATE_DIR", str(tmp_path / "state")
    )
    monkeypatch.setattr(
        workspace_init.settings, "OPENAGENTD_CACHE_DIR", str(tmp_path / "cache")
    )
    monkeypatch.setattr(
        workspace_init.settings, "OPENAGENTD_WORKSPACE_DIR", str(tmp_path / "workspace")
    )
    monkeypatch.setattr(workspace_init.settings, "AGENTS_DIR", str(config / "agents"))
    monkeypatch.setattr(workspace_init.settings, "SKILLS_DIR", str(config / "skills"))
    monkeypatch.setattr(
        workspace_init.settings, "OPENAGENTD_PLUGINS_DIRS", str(config / "plugins")
    )

    from app.cli.seed import SeedDownloadError

    monkeypatch.setattr(
        "app.cli.seed.install_seed",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(SeedDownloadError("offline")),
    )

    ensure_workspace_initialized()

    assert (config / "agents" / "executor.md").is_file()
    assert (config / "agents" / "explorer.md").is_file()
    assert (config / "agents" / "coding" / "coder.md").is_file()
    assert (config / "agents" / "coding" / "explorer.md").is_file()


def test_replace_placeholder_updates_only_seed_model(tmp_path: Path) -> None:
    agent = tmp_path / "agent.md"
    agent.write_text(
        "---\nname: openagentd\nmodel: __PROVIDER_MODEL__\n---\n\nCustom prompt\n",
        encoding="utf-8",
    )

    changed = _replace_placeholder_if_needed(agent, "codex:gpt-5.5")

    assert changed is True
    assert agent.read_text(encoding="utf-8") == (
        "---\nname: openagentd\nmodel: codex:gpt-5.5\n---\n\nCustom prompt\n"
    )


def test_install_seed_writes_runtime_settings_model(tmp_path: Path) -> None:
    seed = tmp_path / "seed"
    seed.mkdir()
    (seed / "agents").mkdir()
    (seed / "skills").mkdir()

    result = _install_from_local(
        seed,
        tmp_path / "config",
        provider_model="codex:gpt-5.5",
    )

    assert result.configs_written == [
        "multimodal.yaml",
        "settings.yaml",
    ]
    settings = (tmp_path / "config" / "settings.yaml").read_text(encoding="utf-8")
    assert "title_generation:" in settings
    assert "model: codex:gpt-5.5" in settings


def test_install_seed_leaves_runtime_settings_model_empty_for_placeholder(
    tmp_path: Path,
) -> None:
    seed = tmp_path / "seed"
    seed.mkdir()
    (seed / "agents").mkdir()
    (seed / "skills").mkdir()

    result = _install_from_local(
        seed,
        tmp_path / "config",
        provider_model="__PROVIDER_MODEL__",
    )

    assert "settings.yaml" in result.configs_written
    settings = (tmp_path / "config" / "settings.yaml").read_text(encoding="utf-8")
    assert "__PROVIDER_MODEL__" not in settings
    assert "model:" not in settings


def test_install_seed_prunes_untouched_removed_first_party_agents(
    tmp_path: Path,
) -> None:
    seed = tmp_path / "seed"
    seed.mkdir()
    (seed / "agents").mkdir()
    (seed / "skills").mkdir()
    config = tmp_path / "config"
    legacy = config / "agents" / "consultant.md"
    legacy.parent.mkdir(parents=True)
    legacy.write_text(
        "---\nname: consultant\nrole: member\nmodel: codex:gpt-5\n---\n\n"
        'You are "consultant".\n\nOld shipped body.\n',
        encoding="utf-8",
    )

    result = _install_from_local(seed, config, provider_model="codex:gpt-5")

    assert result.agents_removed == ["consultant.md"]
    assert not legacy.exists()


def test_install_seed_keeps_custom_file_with_removed_first_party_name(
    tmp_path: Path,
) -> None:
    seed = tmp_path / "seed"
    seed.mkdir()
    (seed / "agents").mkdir()
    (seed / "skills").mkdir()
    config = tmp_path / "config"
    custom = config / "agents" / "coding" / "qa.md"
    custom.parent.mkdir(parents=True)
    custom.write_text(
        "---\nname: qa\nrole: member\nmodel: codex:gpt-5\n---\n\n"
        "Project-specific release checklist owner.\n",
        encoding="utf-8",
    )

    result = _install_from_local(seed, config, provider_model="codex:gpt-5")

    assert result.agents_removed == []
    assert custom.exists()


def test_install_seed_prunes_untouched_coding_executor(tmp_path: Path) -> None:
    seed = tmp_path / "seed"
    seed.mkdir()
    (seed / "agents").mkdir()
    (seed / "skills").mkdir()
    config = tmp_path / "config"
    legacy = config / "agents" / "coding" / "executor.md"
    legacy.parent.mkdir(parents=True)
    legacy.write_text(
        "---\nname: executor\nrole: member\nmodel: codex:gpt-5\n---\n\n"
        'You are "executor".\n\nOld shipped body.\n',
        encoding="utf-8",
    )

    result = _install_from_local(seed, config, provider_model="codex:gpt-5")

    assert result.agents_removed == ["coding/executor.md"]
    assert not legacy.exists()
