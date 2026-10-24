//! Server lifespan — port of `app/api/app.py::lifespan` and
//! `app/core/workspace_init.py`.

use appv3_agent::{loader, manager, scheduler};
use appv3_core::settings;
use appv3_db::DbPool;
use serde_json::json;

const DEFAULT_NEW_USER_MODEL: &str = "__PROVIDER_MODEL__";

/// `multimodalities._config.ensure_default_config`.
pub fn ensure_default_multimodal_config() -> std::io::Result<bool> {
    let path = settings().config_dir.join("multimodal.yaml");
    if path.exists() {
        return Ok(false);
    }
    let cfg = json!({
        "image": {"model": "googlegenai:gemini-3.1-flash-image-preview", "aspect_ratio": "1:1", "image_size": "1K"},
        "video": {"model": "googlegenai:veo-3.1-generate-preview", "aspect_ratio": "16:9", "resolution": "720p", "duration_seconds": "8"},
    });
    let text = appv3_core::pyyaml::safe_dump(&cfg);
    std::fs::create_dir_all(&settings().config_dir)?;
    std::fs::write(path, text)?;
    Ok(true)
}

/// `ensure_workspace_initialized`.
pub fn ensure_workspace_initialized() -> anyhow::Result<()> {
    let s = settings();
    let is_new_user = !s.runtime_settings_path().exists() && !s.agents_dir.exists();
    s.ensure_dirs()?;
    for d in &s.plugins_dirs {
        std::fs::create_dir_all(d)?;
    }
    let mem = s.memory_dir();
    std::fs::create_dir_all(&mem)?;
    let pref = mem.join("preferences.md");
    if !pref.exists() {
        std::fs::write(&pref, appv3_memory::PREFERENCES_TEMPLATE)?;
    }
    appv3_core::runtime_settings::ensure_runtime_settings(&s.runtime_settings_path(), DEFAULT_NEW_USER_MODEL)?;
    ensure_default_multimodal_config()?;
    let mut written = 0;
    if loader::ensure_builtin_code_agent(&s.agents_dir)? {
        written += 1;
    }
    written += loader::ensure_builtin_member_agents(&s.agents_dir)?.len();
    if is_new_user {
        loader::configure_unconfigured_agent_models(&s.agents_dir, DEFAULT_NEW_USER_MODEL);
    }
    tracing::info!("workspace_builtin_agents_installed agents={}", written);
    Ok(())
}

/// Lifespan startup. Returns an error when the agents dir is invalid (v2
/// re-raises and the server never starts).
pub async fn startup(pool: &DbPool) -> anyhow::Result<()> {
    tracing::info!("server_starting version={} app_env={}", appv3_core::VERSION, settings().app_env);
    ensure_workspace_initialized()?;
    manager::init(pool.clone(), loader::default_provider_factory());
    // No turn survives a restart: a goal that was running waits for Resume.
    appv3_agent::goal::pause_after_restart(pool).await;
    let sched = scheduler::init(pool.clone());
    appv3_agent::stream_store::store().spawn_sweeper();
    appv3_agent::snapshot::start_maintenance(pool.clone());
    // v2: refresh_model_registry(force=True) in the background; the
    // registry route awaits it.
    if let Ok(guard) = crate::registry_refresh_gate().try_write_owned() {
        tokio::spawn(async move {
            appv3_providers::registry::refresh_model_registry(true).await;
            drop(guard);
        });
    }
    appv3_tools::lsp::set_event_publisher(appv3_agent::broadcaster::publish);
    appv3_tools::lsp::lsp_manager().start();
    appv3_mcp::set_event_publisher(appv3_agent::broadcaster::publish);
    appv3_tools::shell::prewarm_snapshot();
    crate::config_watch::start();
    appv3_core::otel::setup("openagentd", None);
    appv3_core::otel::start_retention();
    let mcp = appv3_mcp::mcp_manager();
    match appv3_mcp::config::load_config() {
        Err(e) => tracing::error!("mcp_config_invalid err={}", e),
        Ok(c) if c.servers.is_empty() => tracing::info!("mcp_no_servers_configured"),
        Ok(_) => mcp.start().await,
    }
    match manager::validate_agents_dir(None) {
        Ok(false) => tracing::warn!("agents_dir_empty_or_missing path={}", settings().agents_dir.display()),
        Ok(true) => {}
        Err(e) => {
            tracing::error!("agents_dir_invalid path={} error={}", settings().agents_dir.display(), e);
            anyhow::bail!(e);
        }
    }
    if sched.has_enabled_tasks().await {
        sched.start().await?;
    } else {
        tracing::info!("scheduler_no_enabled_tasks");
    }
    // Idle-compaction countdowns live in memory; resume the ones the
    // restart dropped while the provider's prompt cache is still warm.
    let p = pool.clone();
    tokio::spawn(async move {
        appv3_agent::idle_compaction::resume_after_restart(&p).await;
    });
    Ok(())
}

/// End every open SSE stream (global feed and per-session turn streams).
/// Called as soon as the shutdown signal arrives: the streams never finish
/// on their own, and the graceful drain waits for every open response.
pub fn close_event_streams() {
    appv3_agent::broadcaster::broadcaster().close();
    appv3_agent::stream_store::store().close_all();
}

/// Lifespan shutdown.
pub async fn shutdown() {
    // A startup registry refresh still on the network must not outlast the
    // desktop's shutdown grace period.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(1), crate::registry_refresh_gate().read()).await;
    appv3_terminal::close_all().await;
    appv3_preview::shutdown();
    scheduler::scheduler().stop();
    appv3_agent::snapshot::stop_maintenance();
    manager::stop().await;
    // A lead's Stop only signals its members; their last saves must land
    // before the database closes.
    appv3_agent::subagents::stop_all_members(std::time::Duration::from_secs(5)).await;
    appv3_mcp::mcp_manager().stop().await;
    appv3_tools::lsp::lsp_manager().stop().await;
    appv3_core::otel::stop_retention();
    appv3_core::otel::shutdown();
    tracing::info!("server_shutdown");
}
