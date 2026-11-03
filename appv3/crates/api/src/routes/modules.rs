//! `GET /api/modules`: the server's modules and the state of each.
//!
//! v3-only. `state` is `pending`, `running`, `stopped`, `failed` (its start
//! returned `error`) or `blocked` (`error` names the dependency it waits
//! for). `start_ms` is how long its last start took.

use crate::util::json;
use crate::AppState;
use appv3_kernel::ModuleStatus;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use serde_json::{json as j, Value};

pub fn router() -> Router<AppState> {
    Router::new().route("/", get(list_modules))
}

async fn list_modules() -> Response {
    json(body(&appv3_kernel::global().status()))
}

fn body(modules: &[ModuleStatus]) -> Value {
    let list: Vec<Value> = modules
        .iter()
        .map(|m| {
            j!({
                "id": m.id,
                "deps": m.deps,
                "critical": m.critical,
                "state": m.state.as_str(),
                "error": m.error,
                "start_ms": m.start_ms.map(|ms| (ms * 10.0).round() / 10.0),
            })
        })
        .collect();
    j!({ "modules": list })
}

#[cfg(test)]
mod tests {
    use super::*;
    use appv3_kernel::State;

    #[test]
    fn reports_each_module_with_its_state() {
        let m = |id: &str, state, error: Option<&str>, start_ms| ModuleStatus {
            id: id.into(),
            deps: vec!["workspace".into()],
            critical: false,
            state,
            error: error.map(Into::into),
            start_ms,
        };
        let v = body(&[m("lsp", State::Running, None, Some(0.4321)), m("mcp", State::Failed, Some("bad config"), Some(2.0)), m("scheduler", State::Pending, None, None)]);
        assert_eq!(
            v,
            j!({"modules": [
                {"id": "lsp", "deps": ["workspace"], "critical": false, "state": "running", "error": null, "start_ms": 0.4},
                {"id": "mcp", "deps": ["workspace"], "critical": false, "state": "failed", "error": "bad config", "start_ms": 2.0},
                {"id": "scheduler", "deps": ["workspace"], "critical": false, "state": "pending", "error": null, "start_ms": null},
            ]})
        );
    }
}
