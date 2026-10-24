//! `update_goal` — the lead reports on its `/goal` ([`crate::goal`]).
//!
//! Listed for every lead session, goal or not, so the tool definitions (part
//! of the cached prompt prefix) stay the same; it fails without a goal.

use super::invalid_args;
use crate::session::AgentSession;
use appv3_tools::{Tool, ToolContext, ToolError, ToolOutput, ToolResult};
use async_trait::async_trait;
use serde_json::Value;
use std::sync::Weak;

pub const UPDATE_GOAL_TOOL: &str = "update_goal";
/// `maxLength` of `evidence` and `reason` in the tool's schema.
const MAX_EVIDENCE_CHARS: usize = 4000;
const MAX_REASON_CHARS: usize = 2000;

pub struct UpdateGoalTool {
    pub session: Weak<AgentSession>,
}

fn text_arg(args: &Value, key: &str, max: usize) -> Result<String, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::String(s)) if s.chars().count() > max => Err(format!("{key}: String should have at most {max} characters")),
        Some(Value::String(s)) => Ok(s.clone()),
        Some(_) => Err(format!("{key}: Input should be a valid string")),
    }
}

#[async_trait]
impl Tool for UpdateGoalTool {
    fn name(&self) -> &str {
        UPDATE_GOAL_TOOL
    }

    async fn run(&self, ctx: &ToolContext, args: Value) -> ToolResult {
        let status = match args.get("status").and_then(Value::as_str) {
            Some(s @ ("complete" | "blocked")) => s.to_string(),
            None if args.get("status").is_none() => return Err(invalid_args(UPDATE_GOAL_TOOL, &["status: Field required".into()])),
            _ => return Err(invalid_args(UPDATE_GOAL_TOOL, &["status: Input should be 'complete' or 'blocked'".into()])),
        };
        let Some(session) = self.session.upgrade() else {
            return Err(ToolError::Execution("The session is gone.".into()));
        };
        let result = if status == "complete" {
            let evidence = text_arg(&args, "evidence", MAX_EVIDENCE_CHARS).map_err(|e| invalid_args(UPDATE_GOAL_TOOL, &[e]))?;
            session.goal_claim_complete(ctx, &evidence).await
        } else {
            let reason = text_arg(&args, "reason", MAX_REASON_CHARS).map_err(|e| invalid_args(UPDATE_GOAL_TOOL, &[e]))?;
            session.goal_claim_blocked(ctx, &reason).await
        };
        result.map(ToolOutput::text).map_err(ToolError::Execution)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn text_args_keep_to_their_schema_length() {
        assert_eq!(text_arg(&json!({"evidence": "ok"}), "evidence", MAX_EVIDENCE_CHARS).unwrap(), "ok");
        assert_eq!(text_arg(&json!({}), "evidence", MAX_EVIDENCE_CHARS).unwrap(), "");
        let long = json!({"evidence": "é".repeat(MAX_EVIDENCE_CHARS + 1)});
        assert_eq!(text_arg(&long, "evidence", MAX_EVIDENCE_CHARS).unwrap_err(), "evidence: String should have at most 4000 characters");
        assert!(text_arg(&json!({"reason": 3}), "reason", MAX_REASON_CHARS).is_err());
    }
}
