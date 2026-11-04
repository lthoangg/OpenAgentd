//! Server lifespan and workspace initialisation.

use appv3_agent::loader;
use appv3_core::settings;
use appv3_db::DbPool;
use serde_json::json;

const DEFAULT_NEW_USER_MODEL: &str = "__PROVIDER_MODEL__";

/// Writes the default `multimodal.yaml` when none exists.
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

/// Lifespan startup: starts the built-in modules (`crate::modules`) on the
/// global kernel, then one module per plugin folder (`crate::plugins`).
/// Returns the error of a critical module that cannot start, e.g. an
/// invalid agents dir (v2 re-raises and the server never starts).
pub async fn startup(pool: &DbPool) -> anyhow::Result<()> {
    tracing::info!("server_starting version={} app_env={}", appv3_core::VERSION, settings().app_env);
    let k = appv3_kernel::global();
    for m in crate::modules::builtin(pool) {
        k.add(m)?;
    }
    k.start_all().await?;
    crate::plugins::reload().await;
    Ok(())
}

/// End every open SSE stream (global feed and per-session turn streams).
/// Called as soon as the shutdown signal arrives: the streams never finish
/// on their own, and the graceful drain waits for every open response.
pub fn close_event_streams() {
    appv3_agent::broadcaster::broadcaster().close();
    appv3_agent::stream_store::store().close_all();
}

/// Lifespan shutdown: stops the modules in reverse start order.
pub async fn shutdown() {
    appv3_kernel::global().stop_all().await;
    tracing::info!("server_shutdown");
}
