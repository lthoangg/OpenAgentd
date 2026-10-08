//! `send_to_workspace` (lead, v3 only) — message a session in another
//! registered workspace; see [`crate::workspace_messages`].

use super::invalid_args;
use crate::workspace_messages::{self as wm, Delivery, SendRequest, MAX_SENDS_PER_TURN};
use appv3_db::DbPool;
use appv3_tools::{Tool, ToolContext, ToolOutput, ToolResult};
use async_trait::async_trait;
use serde_json::Value;
use std::sync::atomic::{AtomicUsize, Ordering};

/// Built per lead turn, so `sends` counts this turn's sends.
pub struct SendToWorkspaceTool {
    pub session_id: String,
    pub pool: DbPool,
    pub sends: AtomicUsize,
}

impl SendToWorkspaceTool {
    pub fn new(session_id: String, pool: DbPool) -> Self {
        Self { session_id, pool, sends: AtomicUsize::new(0) }
    }
}

fn opt_str(errs: &mut Vec<String>, o: &serde_json::Map<String, Value>, k: &str) -> Option<String> {
    match o.get(k) {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => {
            errs.push(format!("{k}: Input should be a valid string"));
            None
        }
    }
}

#[async_trait]
impl Tool for SendToWorkspaceTool {
    fn name(&self) -> &str {
        "send_to_workspace"
    }
    async fn run(&self, ctx: &ToolContext, args: Value) -> ToolResult {
        let o = args.as_object().cloned().unwrap_or_default();
        let mut errs = vec![];
        let action = opt_str(&mut errs, &o, "action").unwrap_or_else(|| "send".into());
        if !["send", "list"].contains(&action.as_str()) {
            errs.push("action: Input should be 'send' or 'list'".into());
        }
        let workspace = opt_str(&mut errs, &o, "workspace");
        let message = opt_str(&mut errs, &o, "message");
        let session_id = opt_str(&mut errs, &o, "session_id").filter(|s| !s.trim().is_empty());
        let reply = match o.get("reply") {
            None | Some(Value::Null) => false,
            Some(v) => super::lax_bool(v).unwrap_or_else(|| {
                errs.push("reply: Input should be a valid boolean".into());
                false
            }),
        };
        let mode = opt_str(&mut errs, &o, "mode");
        if let Some(m) = mode.as_deref().filter(|m| !["code", "plan"].contains(m)) {
            errs.push(format!("mode: Input should be 'code' or 'plan'; got '{m}'"));
        }
        if errs.is_empty() && action == "send" {
            if workspace.as_deref().unwrap_or("").trim().is_empty() {
                errs.push("workspace: Value error, workspace is required for action='send'".into());
            }
            if message.as_deref().unwrap_or("").trim().is_empty() {
                errs.push("message: Value error, message is required for action='send'".into());
            }
            if mode.is_some() && session_id.is_some() {
                errs.push("mode: Value error, mode applies to new sessions only; omit it with session_id".into());
            }
        }
        if !errs.is_empty() {
            return Err(invalid_args("send_to_workspace", &errs));
        }
        let current = ctx.workspace.clone().unwrap_or_default();
        if action == "list" {
            let text = wm::list(&self.pool, &current, workspace.as_deref()).await.unwrap_or_else(|e| format!("Error: {e}"));
            return Ok(ToolOutput::text(text));
        }
        if self.sends.fetch_add(1, Ordering::SeqCst) >= MAX_SENDS_PER_TURN {
            return Ok(ToolOutput::text(format!("Error: this turn already sent {MAX_SENDS_PER_TURN} messages to other workspaces. Wait for replies or finish the turn.")));
        }
        let req = SendRequest {
            source_session_id: self.session_id.clone(),
            source_workspace: current,
            workspace: workspace.unwrap_or_default(),
            message: message.unwrap_or_default(),
            session_id,
            reply,
            mode,
        };
        let sent = match wm::send(&self.pool, req).await {
            Ok(s) => s,
            Err(e) => {
                self.sends.fetch_sub(1, Ordering::SeqCst);
                return Ok(ToolOutput::text(format!("Error: {e}")));
            }
        };
        let how = match sent.delivery {
            Delivery::Started => format!("new session {} started", sent.session_id),
            Delivery::Delivered => format!("delivered to session {}", sent.session_id),
            Delivery::Queued => format!("queued in busy session {}; it runs when the current turn ends", sent.session_id),
        };
        // The web tool card parses this line for its "Open in <workspace>"
        // button (`web/src/utils/workspace-messages.ts`, `parseSendResult`).
        let mut text = format!("Sent to '{}' ({}) — {how}.", sent.target.name, sent.target.path);
        if reply {
            text.push_str(" Its final answer will arrive here as a message; do not poll.");
        }
        Ok(ToolOutput::text(text))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn ctx(ws: &std::path::Path) -> ToolContext {
        ToolContext {
            session_id: None,
            agent_name: "code".into(),
            tool_call_id: "c1".into(),
            denied: Arc::new(appv3_tools::DeniedPaths::with(ws, None, Some(vec![]), Some(vec![]))),
            workspace: Some(ws.to_string_lossy().to_string()),
            output: None,
            metadata: Default::default(),
            messages: None,
        }
    }

    #[tokio::test]
    async fn validates_arguments_and_caps_sends_per_turn() {
        let dir = tempfile::tempdir().unwrap();
        let pool = appv3_db::create_pool(dir.path().join("t.db")).await.unwrap();
        let tool = SendToWorkspaceTool::new(uuid::Uuid::now_v7().to_string(), pool);
        let c = ctx(dir.path());
        let err = |r: ToolResult| match r {
            Err(e) => e.to_string(),
            Ok(o) => panic!("expected an argument error, got {o:?}"),
        };
        let e = err(tool.run(&c, serde_json::json!({"message": "hi"})).await);
        assert!(e.contains("workspace is required"), "{e}");
        let e = err(tool.run(&c, serde_json::json!({"workspace": "infra", "message": " "})).await);
        assert!(e.contains("message is required"), "{e}");
        let e = err(tool.run(&c, serde_json::json!({"workspace": "infra", "message": "hi", "session_id": "x", "mode": "plan"})).await);
        assert!(e.contains("new sessions only"), "{e}");
        let e = err(tool.run(&c, serde_json::json!({"action": "nope"})).await);
        assert!(e.contains("'send' or 'list'"), "{e}");
        // A failed send does not use up the turn's budget.
        let r = tool.run(&c, serde_json::json!({"workspace": "/nonexistent/x", "message": "hi"})).await.unwrap();
        assert!(format!("{r:?}").contains("not registered"), "{r:?}");
        assert_eq!(tool.sends.load(Ordering::SeqCst), 0);
        tool.sends.store(MAX_SENDS_PER_TURN, Ordering::SeqCst);
        let r = tool.run(&c, serde_json::json!({"workspace": "infra", "message": "hi"})).await.unwrap();
        assert!(format!("{r:?}").contains("already sent 10 messages"), "{r:?}");
    }
}
