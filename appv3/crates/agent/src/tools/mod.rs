//! Session-bound tools (v2 `app/agent/tools/builtin/{question,team,member,skill,schedule}.py`).

pub mod ask_user;
pub mod plan;
pub mod preview;
pub mod send_to_workspace;
pub mod team;

use crate::broadcaster;
use crate::notification;
use appv3_db::DbPool;
use appv3_tools::ToolError;
use serde_json::json;

/// v2 `Tool.arun` validation failure text.
pub fn invalid_args(tool: &str, errors: &[String]) -> ToolError {
    ToolError::Argument(format!("Invalid arguments for tool '{tool}': {}", errors.join("; ")))
}

/// Pydantic lax bool.
pub fn lax_bool(v: &serde_json::Value) -> Option<bool> {
    appv3_tools::args::coerce_bool(v)
}

/// The desktop notification for a turn that now waits on the user. `title`
/// is a short status that gets ` · <workspace>` appended; `body` receives the
/// session title and its result is clamped to one line.
pub(crate) async fn publish_input_needed(pool: &DbPool, session_id: &str, question_id: &str, status: &str, body: impl FnOnce(Option<String>) -> String) {
    let session = appv3_db::get_session(pool, session_id).await.ok().flatten();
    let session_title = session.as_ref().and_then(|s| s.title.clone());
    let workspace = session.as_ref().map(|s| s.workspace.clone()).filter(|w| !w.is_empty());
    let sid = appv3_db::codec::api_uuid(&appv3_db::codec::db_id(session_id));
    let body = notification::body(&body(session_title)).unwrap_or_default();
    broadcaster::publish(
        "desktop_notification",
        json!({
            "type": "desktop_notification",
            "notification_id": uuid::Uuid::new_v4().to_string(),
            "kind": "input_needed",
            "session_id": sid,
            "title": notification::title(status, workspace.as_deref()),
            "body": body,
            "metadata": {"session_id": sid, "question_id": question_id, "mode": "coding", "workspace": workspace},
        }),
    );
}
