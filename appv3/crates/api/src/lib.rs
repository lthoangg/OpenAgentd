//! HTTP API — port of `app/api` (FastAPI) onto axum. Every route lives under
//! `/api/*` exactly as in v2; there is no static SPA mount.

pub mod config_watch;
pub mod error;
pub mod fileresp;
pub mod middleware;
pub mod mux;
pub mod network_access;
pub mod observability;
pub mod providers;
pub mod routes;
pub mod schema;
pub mod sse;
pub mod startup;
pub mod usage;
pub mod util;
pub mod watch;

use appv3_db::DbPool;
use axum::extract::DefaultBodyLimit;
use axum::Router;

pub use error::{ApiError, ApiResult};
pub use middleware::{ConnInfo, NoDelayTcpListener, Policy};

#[derive(Clone)]
pub struct AppState {
    pub pool: DbPool,
}

/// `app.state.model_registry_refresh_task` — the startup refresh holds the
/// write half; `/api/agents/registry` awaits a read before answering.
pub fn registry_refresh_gate() -> std::sync::Arc<tokio::sync::RwLock<()>> {
    static G: std::sync::OnceLock<std::sync::Arc<tokio::sync::RwLock<()>>> = std::sync::OnceLock::new();
    G.get_or_init(Default::default).clone()
}

/// `create_app()` — routers + v2 middleware stack.
pub fn create_app(state: AppState, policy: Policy) -> Router {
    let cors = middleware::Cors::new(appv3_core::settings().cors_origins.as_deref(), &policy);
    routes::router()
        .with_state(state)
        .layer(middleware::catch_panic_layer())
        .layer(DefaultBodyLimit::max(policy.max_bytes as usize))
        .layer(axum::middleware::from_fn_with_state(policy.clone(), middleware::network_bind_guard))
        .layer(axum::middleware::from_fn_with_state(policy.clone(), middleware::request_size_limit))
        .layer(middleware::gzip_layer())
        .layer(axum::middleware::from_fn(middleware::skip_gzip_for_loopback))
        .layer(axum::middleware::from_fn_with_state(policy, middleware::desktop_token))
        .layer(axum::middleware::from_fn(middleware::security_headers))
        .layer(axum::middleware::from_fn_with_state(cors, middleware::cors))
}
