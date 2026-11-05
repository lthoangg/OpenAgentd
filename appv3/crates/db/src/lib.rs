//! Persistence layer for OpenAgentd v3.
//!
//! The SQLite file is shared with v2: see [`codec`] for the on-disk encoding
//! and [`migrations`] for schema/version handling.

pub mod api;
pub mod codec;
pub mod migrations;
pub mod models;
pub mod pool;
pub mod queries;
pub mod tool_args;

pub use models::*;
pub use pool::{close_pool, create_pool, DbPool};
pub use queries::*;
