//! `secret` — ask the user for API keys by name, without ever seeing them.
//!
//! `request` opens a card with a masked field per key and pauses the turn
//! (see [`crate::secret_request`]); keys already usable in this project need
//! no card. `list` names the keys this project can use. The agent then uses
//! a key through the shell tool's `secrets` argument as `$NAME`.

use super::{invalid_args, lax_bool, publish_input_needed};
use crate::secret_request::{self as sr, KeyAsk};
use crate::stream_store::store;
use appv3_core::agent_secrets;
use appv3_db::DbPool;
use appv3_tools::{Suspension, Tool, ToolContext, ToolError, ToolOutput, ToolResult};
use async_trait::async_trait;
use serde_json::Value;
use std::path::Path;

pub const SECRET_TOOL: &str = "secret";
/// Most keys on one card.
pub const MAX_KEYS: usize = 8;
/// Longest reason; must match `maxLength` in `tool_definitions.json`.
pub const MAX_REASON_CHARS: usize = 600;
const MAX_URL_CHARS: usize = 500;

pub struct SecretTool {
    pub session_id: String,
    pub pool: DbPool,
}

/// Whether `arguments` (a `secret` call's raw JSON) opens a card.
pub fn requests(arguments: &str) -> bool {
    serde_json::from_str::<Value>(arguments).ok().and_then(|a| a.get("action").and_then(Value::as_str).map(|s| s.trim() == "request")).unwrap_or(false)
}

fn parse_keys(args: &Value) -> Result<Vec<KeyAsk>, Vec<String>> {
    let mut errs = vec![];
    let raw = match args.get("keys") {
        Some(Value::Array(a)) => a.clone(),
        Some(Value::String(s)) => match serde_json::from_str::<Value>(s) {
            Ok(Value::Array(a)) => a,
            _ => return Err(vec!["keys: Input should be a valid list".into()]),
        },
        None | Some(Value::Null) => return Err(vec!["keys: Field required for action='request'".into()]),
        Some(_) => return Err(vec!["keys: Input should be a valid list".into()]),
    };
    if raw.is_empty() || raw.len() > MAX_KEYS {
        return Err(vec![format!("keys: List should have 1 to {MAX_KEYS} items, not {}", raw.len())]);
    }
    let mut out: Vec<KeyAsk> = vec![];
    for (i, k) in raw.iter().enumerate() {
        let (name, o) = match k {
            Value::String(s) => (s.trim().to_string(), None),
            Value::Object(o) => (o.get("name").and_then(Value::as_str).unwrap_or_default().trim().to_string(), Some(o)),
            _ => {
                errs.push(format!("keys -> {i}: Input should be an object with a name"));
                continue;
            }
        };
        if let Err(e) = agent_secrets::check_name(&name) {
            errs.push(format!("keys -> {i} -> name: {e}"));
            continue;
        }
        if out.iter().any(|x| x.name == name) {
            errs.push(format!("keys -> {i} -> name: {name} is listed twice"));
            continue;
        }
        let flag = |key: &str| o.and_then(|o| o.get(key)).and_then(lax_bool).unwrap_or(false);
        let help_url = o.and_then(|o| o.get("help_url")).and_then(Value::as_str).map(str::trim).filter(|u| !u.is_empty()).map(String::from);
        if let Some(u) = &help_url {
            if !(u.starts_with("https://") || u.starts_with("http://")) || u.chars().count() > MAX_URL_CHARS {
                errs.push(format!("keys -> {i} -> help_url: must be an http(s) URL of at most {MAX_URL_CHARS} characters"));
                continue;
            }
        }
        out.push(KeyAsk { name, help_url, optional: flag("optional"), multiline: flag("multiline") });
    }
    if errs.is_empty() {
        Ok(out)
    } else {
        Err(errs)
    }
}

fn project(ctx: &ToolContext) -> Result<String, ToolError> {
    let ws = ctx.workspace.as_deref().filter(|w| !w.is_empty()).ok_or_else(|| ToolError::Execution("Secrets belong to a project, and this session has no workspace.".into()))?;
    Ok(agent_secrets::project_of(Path::new(ws)))
}

fn usage_hint(names: &[String]) -> String {
    let quoted: Vec<String> = names.iter().map(|n| format!("\"{n}\"")).collect();
    format!("Use them in commands with the shell tool's `secrets` argument, e.g. secrets: [{}], and refer to each as ${}.", quoted.join(", "), names[0])
}

#[async_trait]
impl Tool for SecretTool {
    fn name(&self) -> &str {
        SECRET_TOOL
    }

    async fn run(&self, ctx: &ToolContext, args: Value) -> ToolResult {
        let action = args.get("action").and_then(Value::as_str).map(str::trim).unwrap_or("");
        match action {
            "list" => {
                let project = project(ctx)?;
                let names = agent_secrets::usable_names(&appv3_core::credentials::snapshot(), &project);
                if names.is_empty() {
                    return Ok(ToolOutput::text("No secrets are available in this project yet. Ask the user for one with action='request'."));
                }
                Ok(ToolOutput::text(format!("Available in this project: {}. {}", names.join(", "), usage_hint(&names))))
            }
            "request" => self.request(ctx, &args).await,
            _ => Err(invalid_args(SECRET_TOOL, &["action: Input should be 'request' or 'list'".into()])),
        }
    }
}

impl SecretTool {
    async fn request(&self, ctx: &ToolContext, args: &Value) -> ToolResult {
        let mut errs = vec![];
        let reason = args.get("reason").and_then(Value::as_str).map(str::trim).unwrap_or("").to_string();
        if reason.is_empty() {
            errs.push("reason: Field required: say why the task needs these keys".into());
        } else if reason.chars().count() > MAX_REASON_CHARS {
            errs.push(format!("reason: String should have at most {MAX_REASON_CHARS} characters"));
        }
        let keys = match parse_keys(args) {
            Ok(k) => k,
            Err(e) => {
                errs.extend(e);
                vec![]
            }
        };
        if !errs.is_empty() {
            return Err(invalid_args(SECRET_TOOL, &errs));
        }
        let replace = args.get("replace").and_then(lax_bool).unwrap_or(false);
        let project = project(ctx)?;
        let card = sr::card(&appv3_core::credentials::snapshot(), &project, &reason, &keys, replace);
        if sr::all_available(&card) {
            let names: Vec<String> = keys.iter().map(|k| k.name.clone()).collect();
            return Ok(ToolOutput::text(format!("Already available in this project: {}. {}", names.join(", "), usage_hint(&names))));
        }
        if ctx.tool_call_id.is_empty() {
            return Ok(ToolOutput::text("Your request could not be shown to the user (no tool call id)."));
        }
        if let Some(text) = self.agent_only_guidance(ctx).await {
            return Ok(ToolOutput::text(text));
        }
        let payload = sr::payload(&card);
        let row = appv3_db::create_pending_question_with(&self.pool, &self.session_id, &ctx.tool_call_id, SECRET_TOOL, &payload).await.map_err(ToolError::exec)?;
        let sid = appv3_db::codec::api_uuid(&appv3_db::codec::db_id(&self.session_id));
        let qid = appv3_db::codec::api_uuid(&row.id);
        let questions = payload["questions"].as_array().cloned().unwrap_or_default();
        store().push_event(&sid, &crate::events::secret_request_asked(&qid, &sid, &ctx.tool_call_id, &questions, &card), false);
        let names: Vec<String> =
            card["keys"].as_array().into_iter().flatten().filter(|k| k["state"] != sr::state::AVAILABLE).filter_map(|k| k["name"].as_str().map(String::from)).collect();
        let headline = if names.len() == 1 { format!("The agent needs {}", names[0]) } else { format!("The agent needs {} secrets", names.len()) };
        publish_input_needed(&self.pool, &self.session_id, &qid, "Needs you", |_| headline).await;
        tracing::info!("secret_request_opened session_id={} question_id={} keys={}", sid, qid, names.len());
        Err(ToolError::Suspended(Suspension::Question { question_id: qid, session_id: sid }))
    }

    /// In a turn only agents worked in, nobody follows this session to answer.
    async fn agent_only_guidance(&self, ctx: &ToolContext) -> Option<String> {
        let floor = ctx.metadata.lock().unwrap().get(crate::session::TURN_FLOOR_META).and_then(Value::as_i64)?;
        if !crate::session::agent_only_since(&self.pool, &self.session_id, floor).await {
            return None;
        }
        Some("Not asked: the user is not following this session (another workspace's agent sent this request). Report which keys are missing in your answer; the user can add them in Settings → Secrets.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keys_are_validated_by_name_and_count() {
        assert!(parse_keys(&json!({"keys": [{"name": "STRIPE_SECRET_KEY"}, "AWS_ACCESS_KEY_ID"]})).is_ok());
        let e = parse_keys(&json!({"keys": [{"name": "PATH"}]})).unwrap_err();
        assert!(e[0].contains("changes how commands run"), "{e:?}");
        let e = parse_keys(&json!({"keys": [{"name": "A_KEY"}, {"name": "A_KEY"}]})).unwrap_err();
        assert!(e[0].contains("listed twice"), "{e:?}");
        let many: Vec<Value> = (0..9).map(|i| json!({"name": format!("K{i}")})).collect();
        assert!(parse_keys(&json!({"keys": many})).is_err());
        let e = parse_keys(&json!({"keys": [{"name": "A_KEY", "help_url": "javascript:alert(1)"}]})).unwrap_err();
        assert!(e[0].contains("http(s) URL"), "{e:?}");
    }

    #[test]
    fn only_a_request_opens_a_card() {
        assert!(requests(r#"{"action": "request", "keys": []}"#));
        assert!(!requests(r#"{"action": "list"}"#));
        assert!(!requests("nope"));
    }
}
