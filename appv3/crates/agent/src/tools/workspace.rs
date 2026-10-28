//! `workspace` (lead, v3 only) — message a session in another
//! registered workspace (see [`crate::workspace_messages`]), and propose a
//! repository's workspace groups for the user to confirm (see
//! [`crate::workspace_groups`]).

use super::invalid_args;
use crate::workspace_messages::{self as wm, Delivery, DeliveryMode, SendRequest, MAX_SENDS_PER_TURN};
use appv3_db::DbPool;
use appv3_tools::{Tool, ToolContext, ToolOutput, ToolResult};
use async_trait::async_trait;
use serde_json::Value;
use std::sync::atomic::{AtomicUsize, Ordering};

/// Built per lead turn, so `sends` counts this turn's sends.
pub struct WorkspaceTool {
    pub session_id: String,
    pub pool: DbPool,
    pub sends: AtomicUsize,
}

impl WorkspaceTool {
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
impl Tool for WorkspaceTool {
    fn name(&self) -> &str {
        "workspace"
    }
    async fn run(&self, ctx: &ToolContext, args: Value) -> ToolResult {
        let o = args.as_object().cloned().unwrap_or_default();
        let mut errs = vec![];
        let action = opt_str(&mut errs, &o, "action").unwrap_or_else(|| "send".into());
        if !["send", "list", "set_groups"].contains(&action.as_str()) {
            errs.push("action: Input should be 'send', 'list' or 'set_groups'".into());
        }
        let plan = ctx.metadata.lock().unwrap().get("interaction_mode").and_then(Value::as_str) == Some("plan");
        if plan && action != "list" && errs.is_empty() {
            return Ok(ToolOutput::text(format!("Error: workspace(action='{action}') is unavailable in Plan mode; only action='list' is.")));
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
        let delivery_raw = opt_str(&mut errs, &o, "delivery");
        let delivery = match delivery_raw.as_deref() {
            None => DeliveryMode::Steer,
            Some(d) => DeliveryMode::parse(d).unwrap_or_else(|| {
                errs.push(format!("delivery: Input should be 'steer', 'queue' or 'stop_and_send'; got '{d}'"));
                DeliveryMode::Steer
            }),
        };
        if errs.is_empty() && action == "send" {
            if workspace.as_deref().unwrap_or("").trim().is_empty() {
                errs.push("workspace: Value error, workspace is required for action='send'".into());
            }
            if message.as_deref().unwrap_or("").trim().is_empty() {
                errs.push("message: Value error, message is required for action='send'".into());
            }
            if delivery_raw.is_some() && session_id.is_none() {
                errs.push("delivery: Value error, delivery applies to an existing session; pass session_id with it".into());
            }
        }
        if !errs.is_empty() {
            return Err(invalid_args("workspace", &errs));
        }
        let current = ctx.workspace.clone().unwrap_or_default();
        if action == "set_groups" {
            let join = crate::workspace_groups::parse_group_names("join", o.get("join")).map_err(|e| invalid_args("workspace", &[e]))?;
            let leave = crate::workspace_groups::parse_group_names("leave", o.get("leave")).map_err(|e| invalid_args("workspace", &[e]))?;
            let brief = match o.get("brief") {
                None | Some(Value::Null) => None,
                Some(Value::String(s)) => Some(s.clone()),
                Some(_) => return Err(invalid_args("workspace", &["brief: Input should be a valid string".into()])),
            };
            let target = workspace.unwrap_or_default();
            return match crate::workspace_groups::propose(&self.pool, &target, &join, &leave, brief.as_deref()).await {
                Err(e) => Ok(ToolOutput::text(format!("Error: {e}"))),
                Ok(None) => Ok(ToolOutput::text("No change: the repository is already in those groups, not in the ones to leave, and the brief is the same.")),
                Ok(Some(p)) => crate::confirm::ask(ctx, Some(&self.pool), "workspace", p).await,
            };
        }
        if action == "list" {
            let text = wm::list(&self.pool, &current, workspace.as_deref()).await.unwrap_or_else(|e| format!("Error: {e}"));
            return Ok(ToolOutput::text(text));
        }
        if self.sends.fetch_add(1, Ordering::SeqCst) >= MAX_SENDS_PER_TURN {
            return Ok(ToolOutput::text(format!("Error: this turn already sent {MAX_SENDS_PER_TURN} messages to other workspaces. Wait for replies or finish the turn.")));
        }
        // Models that fill every enum send `mode` with `session_id` too; an
        // existing session keeps its mode, and the result says so.
        let mode_ignored = mode.is_some() && session_id.is_some();
        let req = SendRequest {
            source_session_id: self.session_id.clone(),
            source_workspace: current,
            workspace: workspace.unwrap_or_default(),
            message: message.unwrap_or_default(),
            session_id,
            reply,
            mode,
            delivery,
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
            Delivery::Queued => format!("queued in busy session {}; it reads the message before its next step", sent.session_id),
            Delivery::Held => format!("queued in busy session {}; it starts when the current turn ends", sent.session_id),
            Delivery::Stopped => format!("stopped the running turn in session {} and sent the message", sent.session_id),
        };
        // The web tool card parses this line for its "Open in <workspace>"
        // button (`web/src/utils/workspace-messages.ts`, `parseSendResult`).
        let mut text = format!("Sent to '{}' ({}) — {how}.", sent.target.name, sent.target.path);
        if reply {
            text.push_str(" Its final answer will arrive here as a message; do not poll.");
        }
        if mode_ignored {
            text.push_str(" Its mode was left as it was: mode applies to new sessions only.");
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
        let tool = WorkspaceTool::new(uuid::Uuid::now_v7().to_string(), pool);
        let c = ctx(dir.path());
        let err = |r: ToolResult| match r {
            Err(e) => e.to_string(),
            Ok(o) => panic!("expected an argument error, got {o:?}"),
        };
        let e = err(tool.run(&c, serde_json::json!({"message": "hi"})).await);
        assert!(e.contains("workspace is required"), "{e}");
        let e = err(tool.run(&c, serde_json::json!({"workspace": "infra", "message": " "})).await);
        assert!(e.contains("message is required"), "{e}");
        let e = err(tool.run(&c, serde_json::json!({"action": "nope"})).await);
        assert!(e.contains("'send', 'list' or 'set_groups'"), "{e}");
        let e = err(tool.run(&c, serde_json::json!({"workspace": "infra", "message": "hi", "session_id": "x", "delivery": "now"})).await);
        assert!(e.contains("'steer', 'queue' or 'stop_and_send'"), "{e}");
        let e = err(tool.run(&c, serde_json::json!({"workspace": "infra", "message": "hi", "delivery": "queue"})).await);
        assert!(e.contains("pass session_id"), "{e}");
        assert_eq!(DeliveryMode::parse("stop_and_send"), Some(DeliveryMode::StopAndSend));
        assert_eq!(DeliveryMode::default(), DeliveryMode::Steer);
        // A failed send does not use up the turn's budget.
        let r = tool.run(&c, serde_json::json!({"workspace": "/nonexistent/x", "message": "hi"})).await.unwrap();
        assert!(format!("{r:?}").contains("not registered"), "{r:?}");
        assert_eq!(tool.sends.load(Ordering::SeqCst), 0);
        tool.sends.store(MAX_SENDS_PER_TURN, Ordering::SeqCst);
        let r = tool.run(&c, serde_json::json!({"workspace": "infra", "message": "hi"})).await.unwrap();
        assert!(format!("{r:?}").contains("already sent 10 messages"), "{r:?}");
    }
}
