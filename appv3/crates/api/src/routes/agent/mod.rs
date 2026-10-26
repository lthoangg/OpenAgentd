//! `/api/agent` router group (`app/api/routes/agent/__init__.py`).

pub mod chat;
pub mod files;
pub mod goal;
pub mod helpers;
pub mod memory;
pub mod questions;
pub mod workspace_groups;
pub mod worktrees;

use crate::AppState;
use axum::Router;

pub fn router() -> Router<AppState> {
    Router::new()
        .merge(chat::router())
        .merge(files::router())
        .merge(goal::router())
        .merge(memory::router())
        .merge(questions::router())
        .merge(worktrees::router())
        .merge(workspace_groups::router())
}
