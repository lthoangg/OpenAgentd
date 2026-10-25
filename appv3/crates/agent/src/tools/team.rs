//! `team` (lead) and `ask_lead` / `send_to_lead` (member) — ports of
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
        "Delegate a focused task to a specialized subagent running asynchronously in the background. Returns immediately after dispatching; the subagent's deliverable arrives as a message when it finishes, so don't wait or poll for it.{doc}To run tasks concurrently, call team multiple times in the same turn. To reply to a subagent that asked a question or send follow-up instructions, provide target='<handle>' (e.g. target='explorer#1'). action='interrupt' redirects one at once, dropping its current step; action='stop' ends its work without a report (a later task resumes it); action='list' shows their status. A subagent that fails or stalls messages you why: retry it, use another profile, or do it yourself."
    )
}

/// What a `team` call asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DelegateAction {
    Spawn,
    Send,
    Interrupt,
    Stop,
    List,
}

/// A validated `team` call.
#[derive(Debug, PartialEq, Eq)]
pub struct DelegateCall {
    pub action: DelegateAction,
    pub profile: String,
    pub target: String,
    pub task: String,
}

fn opt_str(errs: &mut Vec<String>, o: &Map<String, Value>, keys: &[&str]) -> String {
    match alias(o, keys) {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.trim().to_string(),
        Some(_) => {
            errs.push(format!("{}: Input should be a valid string", keys[0]));
            String::new()
        }
    }
}

/// Parse and validate `team` arguments. Without `action`, a call with a
/// `target` sends to that subagent and one without spawns a new subagent.
pub fn parse_delegate(args: &Value) -> Result<DelegateCall, Vec<String>> {
    let o = args.as_object().cloned().unwrap_or_default();
    let mut errs = vec![];
    let target = opt_str(&mut errs, &o, &["target", "member_id", "to"]);
    let action = match alias(&o, &["action"]) {
        None | Some(Value::Null) => Some(if target.is_empty() { DelegateAction::Spawn } else { DelegateAction::Send }),
        Some(Value::String(s)) => match s.trim() {
            "" => Some(if target.is_empty() { DelegateAction::Spawn } else { DelegateAction::Send }),
            "spawn" => Some(DelegateAction::Spawn),
            "send" => Some(DelegateAction::Send),
            "interrupt" => Some(DelegateAction::Interrupt),
            "stop" => Some(DelegateAction::Stop),
            "list" => Some(DelegateAction::List),
            other => {
                errs.push(format!("action: Input should be 'spawn', 'send', 'interrupt', 'stop' or 'list', got '{other}'"));
                None
            }
        },
        Some(_) => {
            errs.push("action: Input should be a valid string".into());
            None
        }
    };
    let (profile, task) = match action {
        Some(DelegateAction::Spawn) => {
            let profile = req_str(&mut errs, &o, &["profile", "agent", "member", "role"]);
            let task = req_str(&mut errs, &o, &["task", "message", "instruction", "query"]);
            if errs.is_empty() {
                if profile.trim().is_empty() {
                    errs.push("profile: Value error, Field must not be blank".into());
                }
                if task.trim().is_empty() {
                    errs.push("task: Value error, Field must not be blank".into());
                }
            }
            (profile.trim().to_string(), task.trim().to_string())
        }
        Some(DelegateAction::Send | DelegateAction::Interrupt) => {
            let task = req_str(&mut errs, &o, &["task", "message", "instruction", "query"]);
            if errs.is_empty() && task.trim().is_empty() {
                errs.push("task: Value error, Field must not be blank".into());
            }
            (opt_str(&mut errs, &o, &["profile", "agent", "member", "role"]), task.trim().to_string())
        }
        _ => (String::new(), String::new()),
    };
    if matches!(action, Some(DelegateAction::Send | DelegateAction::Interrupt | DelegateAction::Stop)) && target.is_empty() && !errs.iter().any(|e| e.starts_with("target")) {
        errs.push("target: Field required for this action (the subagent's handle, e.g. 'explorer#1')".into());
    }
    match action {
        Some(action) if errs.is_empty() => Ok(DelegateCall { action, profile, target, task }),
        _ => Err(errs),
    }
}

pub struct DelegateTool {
    pub lead_session_id: String,
    pub pool: DbPool,
    pub provider_factory: ProviderFactory,
}

#[async_trait]
impl Tool for DelegateTool {
    fn name(&self) -> &str {
        "team"
    }
    fn definition(&self) -> Value {
        let mut d = appv3_tools::contract_definition("team").unwrap_or_default();
        if let Some(x) = d.pointer_mut("/function/description") {
            *x = Value::String(delegate_description());
        }
        d
    }
    async fn run(&self, ctx: &ToolContext, args: Value) -> ToolResult {
        let call = parse_delegate(&args).map_err(|errs| invalid_args("team", &errs))?;
        let DelegateCall { action, profile, target, task } = call;
        let workspace = ctx.workspace.clone().unwrap_or_default();
        let lead = self.lead_session_id.as_str();
        let res = match action {
            DelegateAction::List => return Ok(ToolOutput::text(subagents::describe_subagents(lead))),
            DelegateAction::Spawn => subagents::spawn_subagent(lead, &profile, &task, None, None, None, &workspace, &self.pool, &self.provider_factory).await,
            DelegateAction::Send => subagents::send_subagent_message(lead, &target, &task, &self.pool).await,
            DelegateAction::Interrupt => subagents::interrupt_subagent(lead, &target, &task, &self.pool).await,
            DelegateAction::Stop => subagents::stop_subagent(lead, &target).await,
        };
        Ok(ToolOutput::text(match res {
            Err(e) => format!("Error delegating to subagent: {e}"),
            Ok(r) => delegate_result_text(action, &r, if target.is_empty() { &profile } else { &target }),
        }))
    }
}

/// What the lead reads after a successful `team` call.
pub fn delegate_result_text(action: DelegateAction, r: &Value, fallback: &str) -> String {
    let mid = r.get("member_id").and_then(|v| v.as_str()).unwrap_or(fallback);
    let flag = |k: &str| r.get(k).and_then(Value::as_bool).unwrap_or(false);
    match action {
        // The task is already in this call's arguments; repeating it only costs tokens.
        DelegateAction::Spawn => format!("Subagent '{mid}' dispatched. Its deliverable will arrive as a message when it finishes."),
        DelegateAction::Send if flag("queued") => format!(
            "Message queued for subagent '{mid}'. It is still working and will read this when its current work ends, then reply as a message. To redirect it now, use action='interrupt'."
        ),
        DelegateAction::Send => format!("Message delivered to subagent '{mid}'. It is running in the background and will deliver its response as a message to you once finished."),
        DelegateAction::Interrupt if flag("interrupted") => {
            format!("Subagent '{mid}' was interrupted and is now working on your message. Its interrupted step sends no report; its reply will arrive as a message.")
        }
        DelegateAction::Interrupt => format!("Subagent '{mid}' was not mid-step; your message started its next turn. Its reply will arrive as a message."),
        DelegateAction::Stop if flag("was_running") => format!("Subagent '{mid}' stopped. It sends no report. Its work so far is kept: send it a task to resume with its context."),
        DelegateAction::Stop => {
            let status = r.get("status").and_then(Value::as_str).unwrap_or("idle");
            format!("Subagent '{mid}' was not running (status: {status}); nothing to stop.")
        }
        DelegateAction::List => String::new(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn call(action: DelegateAction, profile: &str, target: &str, task: &str) -> DelegateCall {
        DelegateCall { action, profile: profile.into(), target: target.into(), task: task.into() }
    }

    /// Calls written before `action` existed mean what they meant then.
    #[test]
    fn a_call_without_an_action_spawns_or_sends_as_before() {
        assert_eq!(parse_delegate(&json!({"profile": "explorer", "task": " map it "})), Ok(call(DelegateAction::Spawn, "explorer", "", "map it")));
        assert_eq!(parse_delegate(&json!({"profile": "explorer", "target": "explorer#1", "task": "go on"})), Ok(call(DelegateAction::Send, "explorer", "explorer#1", "go on")));
        assert_eq!(parse_delegate(&json!({"target": "explorer#1", "task": "go on", "action": null})), Ok(call(DelegateAction::Send, "", "explorer#1", "go on")));
        assert_eq!(parse_delegate(&json!({"task": "map it"})), Err(vec!["profile: Field required".to_string()]));
    }

    #[test]
    fn each_action_asks_only_for_what_it_needs() {
        assert_eq!(parse_delegate(&json!({"action": "list"})), Ok(call(DelegateAction::List, "", "", "")));
        assert_eq!(parse_delegate(&json!({"action": "stop", "target": "worker#2"})), Ok(call(DelegateAction::Stop, "", "worker#2", "")));
        assert_eq!(
            parse_delegate(&json!({"action": "interrupt", "target": "worker#2", "task": "only the API crate"})),
            Ok(call(DelegateAction::Interrupt, "", "worker#2", "only the API crate"))
        );
        assert_eq!(parse_delegate(&json!({"action": "stop"})), Err(vec!["target: Field required for this action (the subagent's handle, e.g. 'explorer#1')".to_string()]));
        assert_eq!(parse_delegate(&json!({"action": "interrupt", "target": "worker#2"})), Err(vec!["task: Field required".to_string()]));
        assert_eq!(
            parse_delegate(&json!({"action": "pause", "target": "worker#2"})),
            Err(vec!["action: Input should be 'spawn', 'send', 'interrupt', 'stop' or 'list', got 'pause'".to_string()])
        );
    }

    #[test]
    fn the_result_says_what_happened_to_the_subagent() {
        let r = |v: Value| v;
        assert!(delegate_result_text(DelegateAction::Send, &r(json!({"member_id": "w#1", "queued": true})), "w#1").contains("will read this when its current work ends"));
        assert!(delegate_result_text(DelegateAction::Send, &r(json!({"member_id": "w#1"})), "w#1").starts_with("Message delivered to subagent 'w#1'."));
        assert!(delegate_result_text(DelegateAction::Interrupt, &r(json!({"member_id": "w#1", "interrupted": true})), "w#1").contains("was interrupted"));
        assert!(delegate_result_text(DelegateAction::Stop, &r(json!({"member_id": "w#1", "was_running": true})), "w#1").starts_with("Subagent 'w#1' stopped."));
        assert_eq!(
            delegate_result_text(DelegateAction::Stop, &r(json!({"member_id": "w#1", "status": "completed", "was_running": false})), "w#1"),
            "Subagent 'w#1' was not running (status: completed); nothing to stop."
        );
    }
}
