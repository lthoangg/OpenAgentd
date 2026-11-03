//! Language-server support plus the (currently
//! unregistered, as in v2) `lsp` navigation tool.

pub mod client;
pub mod managed;
pub mod manager;
pub mod tool;

use serde_json::Value;
use std::sync::OnceLock;

pub use client::LspClient;
pub use managed::{managed_lsp_tools, ManagedLspStatus};
pub use manager::{check_lsp_diagnostics, lsp_manager, LspManager};

type Publisher = Box<dyn Fn(&str, Value) + Send + Sync>;

static PUBLISHER: OnceLock<Publisher> = OnceLock::new();

/// Wire `event_broadcaster.publish` (lives in the agent crate).
pub fn set_event_publisher(f: impl Fn(&str, Value) + Send + Sync + 'static) {
    let _ = PUBLISHER.set(Box::new(f));
}

pub(crate) fn publish(event: &str, data: Value) {
    if let Some(p) = PUBLISHER.get() {
        p(event, data);
    }
}

/// Python truthiness of a JSON value.
pub(crate) fn py_falsy(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::Bool(b) => !b,
        Value::Number(n) => n.as_f64() == Some(0.0),
        Value::String(s) => s.is_empty(),
        Value::Array(a) => a.is_empty(),
        Value::Object(o) => o.is_empty(),
    }
}

/// Python `str()` of a JSON-decoded value.
pub(crate) fn py_str(v: &Value) -> String {
    match v {
        Value::Null => "None".into(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        Value::String(s) => s.clone(),
        Value::Number(n) => match n.as_i64().or_else(|| n.as_u64().map(|u| u as i64)) {
            Some(i) if !n.is_f64() => i.to_string(),
            _ => appv3_core::pyjson::float_repr(n.as_f64().unwrap_or(0.0)),
        },
        other => py_repr(other),
    }
}

/// Python `repr()` of a JSON-decoded value.
pub(crate) fn py_repr(v: &Value) -> String {
    match v {
        Value::String(s) => crate::py_repr_str(s),
        Value::Array(a) => format!("[{}]", a.iter().map(py_repr).collect::<Vec<_>>().join(", ")),
        Value::Object(o) => format!("{{{}}}", o.iter().map(|(k, v)| format!("{}: {}", crate::py_repr_str(k), py_repr(v))).collect::<Vec<_>>().join(", ")),
        other => py_str(other),
    }
}

pub(crate) fn py_strip(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c))
}

/// Python `str(OSError)` for spawn / filesystem failures.
pub(crate) fn py_os_error(e: &std::io::Error, filename: &str) -> String {
    match e.raw_os_error() {
        Some(code) => {
            let msg = std::io::Error::from_raw_os_error(code).to_string();
            let msg = msg.split(" (os error").next().unwrap_or(&msg).to_string();
            format!("[Errno {code}] {msg}: {}", crate::py_repr_str(filename))
        }
        None => e.to_string(),
    }
}

/// `shutil.which(name, path=path)`.
pub(crate) fn which_in(name: &str, path: &str) -> Option<std::path::PathBuf> {
    appv3_core::which::which_in(name, path)
}

/// `os.access(path, os.X_OK)`.
pub(crate) fn is_executable(p: &std::path::Path) -> bool {
    #[cfg(unix)]
    {
        nix::unistd::access(p, nix::unistd::AccessFlags::X_OK).is_ok()
    }
    #[cfg(not(unix))]
    {
        p.exists()
    }
}
