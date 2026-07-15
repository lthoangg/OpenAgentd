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
    result = None
    if not any(agents_dir.glob("*.md")):
        from app.cli.seed import SeedDownloadError, install_seed
        from app.core.config import PROVIDER_MODEL_TOKEN

        try:
            result = install_seed(
                Path(settings.OPENAGENTD_CONFIG_DIR),
                provider_model=PROVIDER_MODEL_TOKEN,
            )
        except SeedDownloadError as exc:
            logger.warning("workspace_seed_install_failed error={}", exc)

    from app.agent.loader import (
        ensure_builtin_agent_blueprints,
        ensure_builtin_openagentd_lead,
    )

    default_written = ensure_builtin_agent_blueprints(agents_dir, mode="normal")
    if ensure_builtin_openagentd_lead(agents_dir, mode="normal"):
        default_written.append("openagentd.md")
    coding_agents_dir = agents_dir / "coding"
    coding_written = ensure_builtin_agent_blueprints(coding_agents_dir, mode="coding")
    if ensure_builtin_openagentd_lead(coding_agents_dir, mode="coding"):
        coding_written.append("openagentd.md")

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
