//! Router assembly (`app/api/app.py::create_app` include_router calls).

pub mod agent;
pub mod agents;
pub mod desktop;
pub mod events;
pub mod health;
pub mod library;
pub mod mcp;
pub mod misc;
pub mod plugins;
pub mod preview;
pub mod scheduler;
pub mod settings;
pub mod terminal;

use crate::util::json_code;
use crate::AppState;
use axum::Router;
use serde_json::json;

pub fn router() -> Router<AppState> {
    Router::new()
        .nest("/api/health", health::router())
        .nest("/api/events", events::router())
        .nest("/api/agent", agent::router())
        .nest("/api/agents", agents::router())
        .nest("/api/skills", library::skills_router())
        .nest("/api/commands", library::commands_router())
        .nest("/api/snippets", library::snippets_router())
        .nest("/api/scheduler", scheduler::router())
        .nest("/api/settings", settings::router())
        .nest("/api/mcp", mcp::router())
        .nest("/api/plugins", plugins::router())
        .nest("/api/auth", misc::auth_router())
        .nest("/api/diagnostics", misc::diagnostics_router())
        .nest("/api/observability", misc::observability_router())
        .nest("/api/terminal", terminal::router())
        .nest("/api/preview", preview::router())
        .nest("/api/desktop", desktop::router())
        .fallback(|| async { json_code(404, json!({"detail": "Not Found"})) })
        .method_not_allowed_fallback(|| async { json_code(405, json!({"detail": "Method Not Allowed"})) })
}
