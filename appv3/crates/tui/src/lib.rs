//! `openagentd tui`: a terminal client for the OpenAgentd API, in the style
//! of Claude Code. It talks to a running server over HTTP and SSE, like the
//! web UI, and prints the conversation into the terminal's own scrollback.

mod app;
mod client;
mod editor;
mod input;
mod markdown;
mod render;
mod sse;
mod term;
mod theme;
mod transcript;
mod view;
mod wrap;

pub use app::{run, Options, SessionPick};
pub use theme::ThemeChoice;
