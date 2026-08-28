"""First-run workspace materialisation for non-interactive app starts."""

from __future__ import annotations

from pathlib import Path

from loguru import logger

from app.core.config import settings


def ensure_workspace_initialized() -> None:
    """Create expected local roots and editable defaults if missing."""
    config_dir = Path(settings.OPENAGENTD_CONFIG_DIR)
    agents_dir = Path(settings.AGENTS_DIR)
    is_new_user = (
        not (config_dir / "settings.yaml").exists() and not agents_dir.exists()
    )

    for path in (
        settings.OPENAGENTD_DATA_DIR,
        settings.OPENAGENTD_CONFIG_DIR,
        settings.OPENAGENTD_STATE_DIR,
        settings.OPENAGENTD_CACHE_DIR,
        settings.OPENAGENTD_WORKSPACE_DIR,
        settings.AGENTS_DIR,
        settings.SKILLS_DIR,
    ):
        Path(path).mkdir(parents=True, exist_ok=True)

    for plugin_dir in settings.plugin_dirs():
        plugin_dir.mkdir(parents=True, exist_ok=True)

    from app.agent.tools.multimodalities._config import ensure_default_config
    from app.core.config import DEFAULT_NEW_USER_MODEL, PROVIDER_MODEL_TOKEN
    from app.core.runtime_settings import ensure_runtime_settings

    ensure_runtime_settings(
        config_dir / "settings.yaml",
        provider_model=(
            DEFAULT_NEW_USER_MODEL if is_new_user else PROVIDER_MODEL_TOKEN
        ),
    )
    ensure_default_config()

    from app.agent.loader import (
        ensure_builtin_openagentd_lead,
        configure_unconfigured_agent_models,
    )

    default_written: list[str] = []
    if ensure_builtin_openagentd_lead(agents_dir, mode="coding"):
        default_written.append("openagentd.md")
    coding_agents_dir = agents_dir / "coding"
    coding_written: list[str] = []
    if ensure_builtin_openagentd_lead(coding_agents_dir, mode="coding"):
        coding_written.append("openagentd.md")
    if is_new_user:
        configure_unconfigured_agent_models(agents_dir, DEFAULT_NEW_USER_MODEL)

    logger.info(
        "workspace_builtin_agents_installed agents={} coding_agents={}",
        len(default_written),
        len(coding_written),
    )
