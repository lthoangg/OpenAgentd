//! Agent runtime — port of `app/agent` (loop, hooks, session) and the
//! runtime-facing services (`memory_stream_store`, `event_broadcaster`,
//! `agent_manager`, `agent_service`).

pub mod agent;
pub mod broadcaster;
pub mod checkpointer;
pub mod errors;
pub mod events;
pub mod history;
pub mod hooks;
pub mod interaction_mode;
pub mod loader;
pub mod manager;
pub mod notification;
pub mod plan;
pub mod plugins;
pub mod prompts;
pub mod pystr;
pub mod queue;
pub mod retry;
pub mod revert;
pub mod scheduler;
pub mod service;
pub mod session;
pub mod skills;
pub mod snapshot;
mod snapshot_gix;
pub mod stream_store;
pub mod streaming;
pub mod subagents;
pub mod tools;
pub mod util;
pub mod workspace_messages;

pub use agent::{Agent, RunOptions, RunOutcome};
pub use errors::{format_agent_error, AgentError};
pub use events::{Envelope, WireEvent};
pub use stream_store::store;
