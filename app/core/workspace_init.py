"""First-run workspace materialisation for non-interactive app starts."""

from __future__ import annotations

from pathlib import Path

from loguru import logger

from app.core.config import settings


def ensure_workspace_initialized() -> None:
    """Create expected local roots and seed editable defaults if missing."""
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

    agents_dir = Path(settings.AGENTS_DIR)
    if any(agents_dir.glob("*.md")):
        return

    from app.cli.seed import PROVIDER_MODEL_TOKEN, SeedDownloadError, install_seed

    try:
        result = install_seed(
            Path(settings.OPENAGENTD_CONFIG_DIR),
            provider_model=PROVIDER_MODEL_TOKEN,
        )
    except SeedDownloadError as exc:
        logger.warning("workspace_seed_install_failed error={}", exc)
        result = None

    from app.agent.loader import ensure_builtin_agent_blueprints

    default_written = ensure_builtin_agent_blueprints(agents_dir, mode="normal")
    coding_written = ensure_builtin_agent_blueprints(
        agents_dir / "coding", mode="coding"
    )

    if result is None:
        logger.info(
            "workspace_builtin_agents_installed agents={} coding_agents={}",
            len(default_written),
            len(coding_written),
        )
        return

    logger.info(
        "workspace_seed_installed agents={} skills={} configs={} source={} builtin_agents={} builtin_coding_agents={}",
        len(result.agents_written),
        len(result.skills_written),
        len(result.configs_written),
        result.source,
        len(default_written),
        len(coding_written),
    )
