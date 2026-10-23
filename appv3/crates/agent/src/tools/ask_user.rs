//! `ask_user` — hand the turn to the user (port of `tools/builtin/question.py`).

use super::{invalid_args, lax_bool, publish_input_needed};
use crate::events;
use crate::stream_store::store;
use appv3_db::DbPool;
use appv3_tools::{Suspension, Tool, ToolContext, ToolError, ToolOutput, ToolResult};
use async_trait::async_trait;
use serde_json::{json, Map, Value};
use std::collections::HashSet;

/// Longest question text; must match `maxLength` in `tool_definitions.json`.
const MAX_QUESTION_CHARS: usize = 1000;
/// Longest option description; must match `maxLength` in `tool_definitions.json`.
const MAX_OPTION_DESCRIPTION_CHARS: usize = 400;

pub struct AskUserTool {
    pub session_id: String,
    pub pool: DbPool,
    pub agent_name: String,
}

fn str_len_err(errs: &mut Vec<String>, loc: &str, s: &str, min: usize, max: usize) {
    let n = s.chars().count();
    if n < min {
        errs.push(format!("{loc}: String should have at least {min} character{}", if min == 1 { "" } else { "s" }));
    } else if n > max {
        errs.push(format!("{loc}: String should have at most {max} characters"));
    }
}

fn coerce_questions(v: Value) -> Value {
    let v = match v {
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                return Value::String(s);
            }
            match serde_json::from_str::<Value>(t) {
                Ok(p) => p,
                Err(_) => return Value::String(s),
            }
        }
        other => other,
    };
    if let Value::Object(o) = &v {
        if o.contains_key("question") {
            return Value::Array(vec![v]);
        }
        if let Some(q) = o.get("questions") {
            return coerce_questions(q.clone());
        }
    }
    v
}

fn req_string(errs: &mut Vec<String>, o: &Map<String, Value>, key: &str, loc: &str) -> String {
    match o.get(key) {
        None => {
            errs.push(format!("{loc}: Field required"));
            String::new()
        }
        Some(Value::String(s)) => s.clone(),
        Some(_) => {
            errs.push(format!("{loc}: Input should be a valid string"));
            String::new()
        }
    }
}

fn opt_bool(errs: &mut Vec<String>, o: &Map<String, Value>, key: &str, loc: &str, default: bool) -> bool {
    match o.get(key) {
        None => default,
        Some(v) => match lax_bool(v) {
            Some(b) => b,
            None => {
                errs.push(format!("{loc}: Input should be a valid boolean"));
                default
            }
        },
    }
}

/// Validate + normalise `AskUserArgs`; returns the `model_dump()` payload.
pub fn validate_args(args: &Value) -> Result<Vec<Value>, Vec<String>> {
    let mut errs = Vec::new();
    let mut args = args.clone();
    if let Value::Object(o) = &args {
        if !o.contains_key("questions") && o.contains_key("question") {
            args = json!({"questions": [args.clone()]});
        }
    }
    let raw = match args.get("questions") {
        None => return Err(vec!["questions: Field required".into()]),
        Some(q) => coerce_questions(q.clone()),
    };
    let Value::Array(items) = raw else {
        return Err(vec!["questions: Input should be a valid list".into()]);
    };
    if items.is_empty() {
        return Err(vec!["questions: List should have at least 1 item after validation, not 0".into()]);
    }
    if items.len() > 4 {
        return Err(vec![format!("questions: List should have at most 4 items after validation, not {}", items.len())]);
    }
    let mut out = Vec::new();
    for (qi, q) in items.iter().enumerate() {
        let loc = format!("questions -> {qi}");
        let Value::Object(o) = q else {
            errs.push(format!("{loc}: Input should be a valid dictionary or instance of Question"));
            continue;
        };
        let before = errs.len();
        let question = req_string(&mut errs, o, "question", &format!("{loc} -> question"));
        if errs.len() == before {
            str_len_err(&mut errs, &format!("{loc} -> question"), &question, 1, MAX_QUESTION_CHARS);
        }
        let b2 = errs.len();
        let header = req_string(&mut errs, o, "header", &format!("{loc} -> header"));
        if errs.len() == b2 {
            str_len_err(&mut errs, &format!("{loc} -> header"), &header, 1, 30);
        }
        let mut options = Vec::new();
        let mut opts_ok = true;
        match o.get("options") {
            None => {}
            Some(Value::Array(arr)) => {
                if arr.len() > 5 {
                    errs.push(format!("{loc} -> options: List should have at most 5 items after validation, not {}", arr.len()));
                    opts_ok = false;
                } else {
                    for (oi, opt) in arr.iter().enumerate() {
                        let ol = format!("{loc} -> options -> {oi}");
                        let Value::Object(oo) = opt else {
                            errs.push(format!("{ol}: Input should be a valid dictionary or instance of QuestionOption"));
                            opts_ok = false;
                            continue;
                        };
                        let b = errs.len();
                        let label = req_string(&mut errs, oo, "label", &format!("{ol} -> label"));
                        if errs.len() == b {
                            str_len_err(&mut errs, &format!("{ol} -> label"), &label, 1, 60);
                        }
                        let description = match oo.get("description") {
                            None | Some(Value::Null) => Value::Null,
                            Some(Value::String(s)) => {
                                if s.chars().count() > MAX_OPTION_DESCRIPTION_CHARS {
                                    errs.push(format!("{ol} -> description: String should have at most {MAX_OPTION_DESCRIPTION_CHARS} characters"));
                                }
                                Value::String(s.clone())
                            }
                            Some(_) => {
                                errs.push(format!("{ol} -> description: Input should be a valid string"));
                                Value::Null
                            }
                        };
                        let recommended = opt_bool(&mut errs, oo, "recommended", &format!("{ol} -> recommended"), false);
                        if errs.len() > b {
                            opts_ok = false;
                        }
                        options.push(json!({"label": label, "description": description, "recommended": recommended}));
                    }
                    if opts_ok {
                        let labels: Vec<String> = options.iter().map(|o| o["label"].as_str().unwrap_or("").trim().to_lowercase()).collect();
                        let uniq: HashSet<&String> = labels.iter().collect();
                        if uniq.len() != labels.len() {
                            errs.push(format!("{loc} -> options: Value error, option labels must be unique within a question"));
                            opts_ok = false;
                        }
                    }
                }
            }
            Some(_) => {
                errs.push(format!("{loc} -> options: Input should be a valid list"));
                opts_ok = false;
            }
        }
        let multiple = opt_bool(&mut errs, o, "multiple", &format!("{loc} -> multiple"), false);
        if errs.len() == before && opts_ok && !multiple && options.iter().filter(|o| o["recommended"] == json!(true)).count() > 1 {
            errs.push(format!("{loc}: Value error, a single-select question may recommend at most one option; set multiple=true to recommend several"));
        }
        // The user may always type their own answer, so a `custom` arg (from an
        // older schema) is ignored. The payload keeps `custom: true` because
        // clients on an earlier web build only offer free text when it is set.
        out.push(json!({"question": question, "header": header, "options": options, "multiple": multiple, "custom": true}));
    }
    if errs.is_empty() {
        Ok(out)
    } else {
        Err(errs)
    }
}

#[async_trait]
impl Tool for AskUserTool {
    fn name(&self) -> &str {
        "ask_user"
    }

    async fn run(&self, ctx: &ToolContext, args: Value) -> ToolResult {
        let payload = validate_args(&args).map_err(|e| invalid_args("ask_user", &e))?;
        if ctx.tool_call_id.is_empty() {
            return Ok(ToolOutput::text("Your question could not be delivered (no tool call id). Continue with your best judgment."));
        }
        let row = appv3_db::create_pending_question(&self.pool, &self.session_id, &ctx.tool_call_id, &payload).await.map_err(ToolError::exec)?;
        let sid = appv3_db::codec::api_uuid(&appv3_db::codec::db_id(&self.session_id));
        let qid = appv3_db::codec::api_uuid(&row.id);
        store().push_event(&sid, &events::question_asked(&qid, &sid, &ctx.tool_call_id, &payload), false);
        let headline = payload.first().and_then(|q| q.get("question")).and_then(|v| v.as_str()).unwrap_or("").to_string();
        publish_input_needed(&self.pool, &self.session_id, &qid, "Needs input", |title| {
            if !headline.trim().is_empty() {
                headline
            } else {
                title.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| "The agent has a question".into())
            }
        })
        .await;
        let _ = &self.agent_name;
        Err(ToolError::Suspended(Suspension::Question { question_id: qid, session_id: sid }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation_matches_pydantic_messages() {
        assert_eq!(validate_args(&json!({})).unwrap_err(), vec!["questions: Field required"]);
        let ok = validate_args(&json!({"question": "Q?", "header": "H"})).unwrap();
        assert_eq!(ok[0], json!({"question": "Q?", "header": "H", "options": [], "multiple": false, "custom": true}));
        let e = validate_args(&json!({"questions": [{"question": "Q", "header": "H", "options": [{"label": "a"}, {"label": "A "}]}]})).unwrap_err();
        assert_eq!(e[0], "questions -> 0 -> options: Value error, option labels must be unique within a question");
    }

    // The user can always type their own answer; a model that still sends
    // `custom` (an older schema in its context) cannot turn that off.
    #[test]
    fn every_question_allows_a_typed_answer() {
        let ok = validate_args(&json!({"questions": [
            {"question": "Q", "header": "H", "custom": false},
            {"question": "R", "header": "H", "options": [{"label": "a"}, {"label": "b"}], "custom": "no"},
        ]}))
        .unwrap();
        assert_eq!(ok[0]["custom"], json!(true));
        assert_eq!(ok[1]["custom"], json!(true));
    }

    #[test]
    fn the_model_facing_schema_has_no_custom_switch() {
        let def = appv3_tools::contract_definition("ask_user").unwrap();
        let props = def.pointer("/function/parameters/properties/questions/items/properties").unwrap();
        assert!(props.get("custom").is_none(), "{props}");
    }

    /// Models kept writing past the old 500/200 limits, each a wasted turn.
    #[test]
    fn length_limits_match_the_schema() {
        let q = |question: String, description: String| json!({"question": question, "header": "H", "options": [{"label": "a", "description": description}, {"label": "b"}]});
        assert!(validate_args(&q("x".repeat(1000), "d".repeat(400))).is_ok());
        assert!(validate_args(&q("x".repeat(1001), "d".into())).is_err());
        assert!(validate_args(&q("x".into(), "d".repeat(401))).is_err());
        let def = appv3_tools::contract_definition("ask_user").unwrap();
        let props = def.pointer("/function/parameters/properties/questions/items/properties").unwrap();
        assert_eq!(props.pointer("/question/maxLength"), Some(&json!(MAX_QUESTION_CHARS)));
        assert_eq!(props.pointer("/options/items/properties/description/maxLength"), Some(&json!(MAX_OPTION_DESCRIPTION_CHARS)));
    }
}
