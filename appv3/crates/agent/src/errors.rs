//! Turn-level error types and `format_agent_error` (port of `app/agent/errors.py`).

use serde_json::{json, Value};

#[derive(Debug, Clone, thiserror::Error)]
pub enum AgentError {
    #[error("{0}")]
    RateLimit(String),
    #[error("{message}")]
    Connection { message: String, error_type: Option<String>, provider: Option<String> },
    #[error("{message}")]
    Auth { message: String, status: Option<u16>, provider: Option<String> },
    #[error("{message}")]
    Request { message: String, status: Option<u16>, provider: Option<String> },
    /// The model's safety classifier declined (`stop_reason: "refusal"`).
    #[error("{message}")]
    Refusal { message: String, provider: Option<String> },
    #[error("{0}")]
    Unconfigured(String),
    /// Plain `RuntimeError` / generic exception text.
    #[error("{0}")]
    Other(String),
    /// Hard cancellation (v2 `CancelledError`) — not an error state.
    #[error("cancelled")]
    Cancelled,
}

/// `(type(exc).__name__, qualified name)` of the v2 exception class.
pub fn python_exception_names(e: &AgentError) -> (&'static str, String) {
    let (name, module) = match e {
        AgentError::RateLimit(_) => ("ProviderRateLimitError", "app.agent.errors"),
        AgentError::Connection { .. } => ("ProviderConnectionError", "app.agent.errors"),
        AgentError::Auth { .. } => ("ProviderAuthenticationError", "app.agent.errors"),
        AgentError::Request { .. } => ("ProviderRequestError", "app.agent.errors"),
        AgentError::Refusal { .. } => ("ModelRefusalError", "app.agent.errors"),
        AgentError::Unconfigured(_) => ("UnconfiguredProviderError", "app.agent.providers.unconfigured"),
        AgentError::Other(_) => ("RuntimeError", "builtins"),
        AgentError::Cancelled => ("CancelledError", "asyncio.exceptions"),
    };
    (name, if module == "builtins" { name.to_string() } else { format!("{module}.{name}") })
}

impl AgentError {
    pub fn is_logged_as_warning(&self) -> bool {
        !matches!(self, AgentError::Other(_))
    }
}

/// v2 `format_agent_error` → `{message, title, code, category[, agent]}`.
pub fn format_agent_error(e: &AgentError, agent: Option<&str>) -> Value {
    let (title, code, category) = match e {
        AgentError::Auth { .. } => ("Provider Authentication Failed".to_string(), "provider_auth_failed", "provider"),
        AgentError::RateLimit(_) => ("Rate Limit Exceeded".to_string(), "provider_rate_limit", "provider"),
        AgentError::Connection { provider, .. } => (
            match provider {
                Some(p) if !p.is_empty() => format!("{p} Connection Failed"),
                _ => "Provider Connection Failed".to_string(),
            },
            "provider_connection_failed",
            "network",
        ),
        AgentError::Request { .. } => ("Provider Request Error".to_string(), "provider_request_failed", "provider"),
        AgentError::Refusal { .. } => ("Model Declined to Continue".to_string(), "model_refusal", "provider"),
        AgentError::Unconfigured(_) => ("Agent Not Configured".to_string(), "agent_not_configured", "provider"),
        AgentError::Other(_) | AgentError::Cancelled => ("Agent Execution Error".to_string(), "agent_execution_failed", "system"),
    };
    let mut v = json!({"message": e.to_string(), "title": title, "code": code, "category": category});
    if let Some(a) = agent.filter(|a| !a.is_empty()) {
        v["agent"] = json!(a);
    }
    v
}
