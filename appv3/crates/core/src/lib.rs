//! Core configuration, paths, auth policy, path locking, and error primitives.

pub mod auth;
pub mod credentials;
pub mod env;
pub mod error;
pub mod home;
pub mod mimetypes;
pub mod otel;
pub mod path_locks;
pub mod platform;
pub mod proctree;
pub mod pyjson;
pub mod pymath;
pub mod pyyaml;
pub mod release;
pub mod runtime_settings;
pub mod secret_files;
pub mod security;
pub mod settings;
pub mod slug;
pub mod which;

pub use error::{panic_message, AppError, AppResult};
pub use path_locks::{acquire_all_locks, path_lock, PathLockManager};
pub use settings::{settings, Settings};

/// The app version: the workspace `version` in `appv3/Cargo.toml`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// How an `mcp` call names a server that waits on the user's sign-in
/// (`appv3-mcp`'s hub). A call refused for it rides with the call to
/// clients (`appv3_db::api::result_rides_inline`), so the transcript can
/// offer Sign in right there; the web matches this text too
/// (`web/src/components/ToolCall/mcpSignIn.ts`).
pub const MCP_SIGN_IN_NOTE: &str = "needs sign-in: connect it in Settings \u{2192} MCP";
