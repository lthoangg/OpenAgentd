//! `delegate` (lead) and `ask_lead` / `send_to_lead` (member) — ports of
//! `tools/builtin/team.py` and `member.py`.

use super::invalid_args;
use crate::loader::{self, ProviderFactory};
use crate::subagents;
use appv3_db::DbPool;
use appv3_tools::{Suspension, Tool, ToolContext, ToolError, ToolOutput, ToolResult};
use async_trait::async_trait;
use serde_json::{Map, Value};

fn alias<'a>(o: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|k| o.get(*k))
}

fn req_str(errs: &mut Vec<String>, o: &Map<String, Value>, keys: &[&str]) -> String {
    match alias(o, keys) {
        None => {
            errs.push(format!("{}: Field required", keys[0]));
            String::new()
        }
        Some(Value::String(s)) => s.clone(),
        Some(_) => {
            errs.push(format!("{}: Input should be a valid string", keys[0]));
            String::new()
        }
    }
}

/// `_build_delegate_description`.
pub fn delegate_description() -> String {
    let mut profiles = loader::load_member_profiles(&subagents::agents_dir());
    profiles.sort_by(|a, b| a.0.cmp(&b.0));
    let doc = if profiles.is_empty() {
        "\n\n".to_string()
    } else {
        let bullets: Vec<String> = profiles
            .iter()
            .map(|(n, p)| match p.description.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
                Some(d) => format!("- profile='{n}': {d}"),
                None => format!("- profile='{n}'"),
            })
            .collect();
        format!("\n\nAvailable subagent profiles:\n{}\n\n", bullets.join("\n"))
    };
    format!(
        "Delegate a focused task to a specialized subagent running asynchronously in the background. Returns immediately after dispatching; the subagent's deliverable arrives as a message when it finishes, so don't wait or poll for it.{doc}To run tasks concurrently, call delegate multiple times in the same turn. To reply to a subagent that asked a question or send follow-up instructions, provide target='<handle>' (e.g. target='explorer#1')."
    )
}

pub struct DelegateTool {
    pub lead_session_id: String,
    pub pool: DbPool,
    pub provider_factory: ProviderFactory,
}

#[async_trait]
impl Tool for DelegateTool {
    fn name(&self) -> &str {
        "delegate"
    }
    fn definition(&self) -> Value {
        let mut d = appv3_tools::contract_definition("delegate").unwrap_or_default();
        if let Some(x) = d.pointer_mut("/function/description") {
            *x = Value::String(delegate_description());
        }
        d
    }
    async fn run(&self, ctx: &ToolContext, args: Value) -> ToolResult {
        let o = args.as_object().cloned().unwrap_or_default();
        let mut errs = vec![];
        let mut profile = req_str(&mut errs, &o, &["profile", "agent", "member", "role"]);
        let mut task = req_str(&mut errs, &o, &["task", "message", "instruction", "query"]);
        if errs.is_empty() {
            if profile.trim().is_empty() {
                errs.push("profile: Value error, Field must not be blank".into());
            }
            if task.trim().is_empty() {
                errs.push("task: Value error, Field must not be blank".into());
            }
        }
        let target = match alias(&o, &["target", "member_id", "to"]) {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.clone()),
            Some(_) => {
                errs.push("target: Input should be a valid string".into());
                None
            }
        };
        if !errs.is_empty() {
            return Err(invalid_args("delegate", &errs));
        }
        profile = profile.trim().to_string();
        task = task.trim().to_string();
        let workspace = ctx.workspace.clone().unwrap_or_default();
        let res = match target.as_deref().filter(|t| !t.is_empty()) {
            Some(t) => subagents::send_subagent_message(&self.lead_session_id, t, &task, &self.pool).await,
            None => subagents::spawn_subagent(&self.lead_session_id, &profile, &task, None, None, None, &workspace, &self.pool, &self.provider_factory).await,
        };
        let text = match res {
            Err(e) => format!("Error delegating to subagent: {e}"),
            Ok(r) => {
                if let Some(t) = target.as_deref().filter(|t| !t.is_empty()) {
                    let mid = r.get("member_id").and_then(|v| v.as_str()).unwrap_or(t);
                    format!("Message delivered to subagent '{mid}'. It is running in the background and will deliver its response as a message to you once finished.")
                } else {
                    let mid = r.get("member_id").and_then(|v| v.as_str()).unwrap_or(&profile);
                    // The task is already in this call's arguments; repeating it only costs tokens.
                    format!("Subagent '{mid}' dispatched. Its deliverable will arrive as a message when it finishes.")
                }
            }
        };
        Ok(ToolOutput::text(text))
    }
}

pub struct AskLeadTool {
    pub lead_session_id: String,
    pub member_handle: String,
}

#[async_trait]
impl Tool for AskLeadTool {
    fn name(&self) -> &str {
        "ask_lead"
    }
    async fn run(&self, ctx: &ToolContext, args: Value) -> ToolResult {
        let o = args.as_object().cloned().unwrap_or_default();
        let mut errs = vec![];
        let question = match o.get("question") {
            None => {
                errs.push("question: Field required".into());
                String::new()
            }
            Some(Value::String(s)) if s.is_empty() => {
                errs.push("question: String should have at least 1 character".into());
                String::new()
            }
            Some(Value::String(s)) if s.trim().is_empty() => {
                errs.push("question: Value error, question must not be blank".into());
                String::new()
            }
            Some(Value::String(s)) => s.clone(),
            Some(_) => {
                errs.push("question: Input should be a valid string".into());
                String::new()
            }
        };
        let options: Option<Vec<String>> = match o.get("options") {
            None | Some(Value::Null) => None,
            Some(Value::Array(a)) => {
                let mut v = vec![];
                for (i, x) in a.iter().enumerate() {
                    match x {
                        Value::String(s) => v.push(s.clone()),
                        _ => errs.push(format!("options.{i}: Input should be a valid string")),
                    }
                }
                Some(v)
            }
            Some(_) => {
                errs.push("options: Input should be a valid list".into());
                None
            }
        };
        if !errs.is_empty() {
            return Err(invalid_args("ask_lead", &errs));
        }
        let tcid = if ctx.tool_call_id.is_empty() { None } else { Some(ctx.tool_call_id.clone()) };
        subagents::with_instance(&self.lead_session_id, &self.member_handle, |i| {
            i.pending_lead_question = Some(serde_json::json!({"question": question, "options": options.clone().unwrap_or_default()}));
            i.status = "waiting_lead".into();
            if let Some(t) = &tcid {
                i.pending_tool_call_id = Some(t.clone());
            }
        });
        Err(ToolError::Suspended(Suspension::Lead { question, options: options.unwrap_or_default(), tool_call_id: tcid }))
    }
}
