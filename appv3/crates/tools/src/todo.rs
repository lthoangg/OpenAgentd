//! `todo` — port of `builtin/todo.py` (file store `.todos.json`).

use crate::{Tool, ToolContext, ToolError, ToolOutput, ToolResult};
use async_trait::async_trait;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

pub const TODOS_FILENAME: &str = ".todos.json";

pub fn todos_path(artifacts_dir: &Path) -> PathBuf {
    artifacts_dir.join(TODOS_FILENAME)
}

pub fn load_store(path: &Path) -> Value {
    if let Ok(t) = std::fs::read_to_string(path) {
        if let Ok(v) = serde_json::from_str::<Value>(&t) {
            if v.get("items").is_some() {
                return v;
            }
        }
    }
    json!({"counter": 0, "items": []})
}

/// `json.dumps(store, indent=2, ensure_ascii=False)`.
fn dumps_indent2(v: &Value) -> String {
    let buf = Vec::new();
    let fmt = serde_json::ser::PrettyFormatter::with_indent(b"  ");
    let mut ser = serde_json::Serializer::with_formatter(buf, fmt);
    serde::Serialize::serialize(v, &mut ser).unwrap();
    String::from_utf8(ser.into_inner()).unwrap()
}

fn save_store(path: &Path, store: &Value) -> std::io::Result<()> {
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, dumps_indent2(store))?;
    std::fs::rename(tmp, path)
}

pub fn format_items(items: &[Value]) -> String {
    if items.is_empty() {
        return "No todos.".into();
    }
    items
        .iter()
        .map(|i| format!("[{}] [{}] {}", i["task_id"].as_str().unwrap_or(""), i["status"].as_str().unwrap_or(""), i["content"].as_str().unwrap_or("")))
        .collect::<Vec<_>>()
        .join("\n")
}

fn consolidate(parts: &[String]) -> Vec<String> {
    let mut grouped: Vec<(String, Vec<String>)> = vec![];
    let mut slots: Vec<(bool, String)> = vec![];
    for p in parts {
        let (verb, subject) = p.split_once(' ').unwrap_or((p, ""));
        if subject.is_empty() || p.contains(':') {
            slots.push((true, p.clone()));
            continue;
        }
        match grouped.iter_mut().find(|(v, _)| v == verb) {
            Some((_, b)) => {
                if !b.iter().any(|s| s == subject) {
                    b.push(subject.into());
                }
            }
            None => {
                grouped.push((verb.into(), vec![subject.into()]));
                slots.push((false, verb.into()));
            }
        }
    }
    slots.into_iter().map(|(verbatim, v)| if verbatim { v } else { format!("{v} {}", grouped.iter().find(|(g, _)| *g == v).unwrap().1.join(", ")) }).collect()
}

#[derive(Debug, Clone)]
struct Action {
    action: String,
    task_id: Option<String>,
    content: Option<String>,
    status: Option<String>,
}

const STATUSES: &[&str] = &["pending", "in_progress", "completed", "cancelled", "finished"];

fn parse_action(v: &Value, idx: usize, errs: &mut Vec<String>) -> Option<Action> {
    let Some(o) = v.as_object() else {
        errs.push(format!("actions -> {idx}: Input should be a valid dictionary or instance of TodoAction"));
        return None;
    };
    let raw_action = match o.get("action") {
        Some(Value::String(s)) => s.trim().to_lowercase(),
        None => {
            errs.push(format!("actions -> {idx} -> action: Field required"));
            return None;
        }
        _ => {
            errs.push(format!("actions -> {idx} -> action: Input should be 'create', 'update', 'delete', 'read' or 'clear'"));
            return None;
        }
    };
    let action = match raw_action.as_str() {
        "add" | "insert" | "new" => "create",
        "remove" | "rm" | "del" => "delete",
        "list" | "get" | "view" | "show" => "read",
        a => a,
    }
    .to_string();
    if !["create", "update", "delete", "read", "clear"].contains(&action.as_str()) {
        errs.push(format!("actions -> {idx} -> action: Input should be 'create', 'update', 'delete', 'read' or 'clear'"));
        return None;
    }
    let s = |k: &str| o.get(k).and_then(|v| v.as_str()).map(String::from);
    let content = s("content");
    if let Some(c) = &content {
        if c.trim().is_empty() {
            errs.push(format!("actions -> {idx} -> content: Value error, content must not be blank"));
            return None;
        }
    }
    let mut status = s("status");
    if let Some(st) = &status {
        if !STATUSES.contains(&st.as_str()) {
            errs.push(format!("actions -> {idx} -> status: Input should be 'pending', 'in_progress', 'completed', 'cancelled' or 'finished'"));
            return None;
        }
    }
    let task_id = s("task_id");
    let fail = |errs: &mut Vec<String>, m: &str| errs.push(format!("actions -> {idx}: Value error, {m}"));
    match action.as_str() {
        "create" => {
            if content.is_none() {
                fail(errs, "content is required for create action");
                return None;
            }
            if status.is_none() {
                status = Some("pending".into());
            } else if status.as_deref() == Some("finished") {
                fail(errs, "status 'finished' is only valid for clear action");
                return None;
            }
        }
        "update" | "delete" => {
            if task_id.is_none() {
                fail(errs, &format!("task_id is required for {action} action"));
                return None;
            }
            if action == "update" && status.as_deref() == Some("finished") {
                fail(errs, "status 'finished' is only valid for clear action");
                return None;
            }
        }
        // No status clears the whole board (v2 defaulted to "finished",
        // which left an abandoned plan's unfinished tasks behind).
        "clear" if status.is_some() && !matches!(status.as_deref(), Some("completed" | "cancelled" | "finished")) => {
            fail(errs, "status for clear must be 'completed', 'cancelled', or 'finished'");
            return None;
        }
        _ => {}
    }
    Some(Action { action, task_id, content, status })
}

/// Apply actions to the store at *path* and return the tool text.
pub fn apply(path: &Path, actions: &[Value]) -> Result<String, ToolError> {
    let mut errs = vec![];
    let parsed: Vec<Action> = actions.iter().enumerate().filter_map(|(i, a)| parse_action(a, i, &mut errs)).collect();
    if !errs.is_empty() {
        return Err(ToolError::Argument(format!("Invalid arguments for tool 'todo': {}", errs.join("; "))));
    }
    let mut store = load_store(path);
    if !store["items"].is_array() {
        store["items"] = json!([]);
    }
    let mut counter = store["counter"].as_i64().unwrap_or(0);
    let mut items: Vec<Value> = store["items"].as_array().cloned().unwrap_or_default();
    let mut log: Vec<String> = vec![];
    for a in &parsed {
        match a.action.as_str() {
            "create" => {
                counter += 1;
                let id = format!("task_{counter}");
                let mut m = Map::new();
                m.insert("task_id".into(), json!(id));
                m.insert("content".into(), json!(a.content));
                m.insert("status".into(), json!(a.status.clone().unwrap_or_else(|| "pending".into())));
                items.push(Value::Object(m));
                log.push(format!("created {id}"));
            }
            "update" => {
                let tid = a.task_id.clone().unwrap();
                match items.iter_mut().find(|i| i["task_id"] == tid.as_str()) {
                    Some(i) => {
                        if let Some(c) = &a.content {
                            i["content"] = json!(c);
                        }
                        if let Some(s) = &a.status {
                            i["status"] = json!(s);
                        }
                        log.push(format!("updated {tid}"));
                    }
                    None => log.push(format!("unknown {tid}")),
                }
            }
            "delete" => {
                let tid = a.task_id.clone().unwrap();
                let before = items.len();
                items.retain(|i| i["task_id"] != tid.as_str());
                log.push(if items.len() < before { format!("deleted {tid}") } else { format!("unknown {tid}") });
            }
            "clear" => {
                let before = items.len();
                match a.status.as_deref() {
                    None => items.clear(),
                    Some("finished") => items.retain(|i| !matches!(i["status"].as_str(), Some("completed" | "cancelled"))),
                    Some(st) => items.retain(|i| i["status"] != st),
                }
                log.push(format!("cleared {} tasks", before - items.len()));
            }
            _ => {}
        }
    }
    store["counter"] = json!(counter);
    store["items"] = json!(items);
    save_store(path, &store)?;
    let outcomes = consolidate(&log);
    let has_read = parsed.iter().any(|a| a.action == "read");
    if has_read || outcomes.is_empty() {
        return Ok(format_items(&items));
    }
    Ok(outcomes.join("; "))
}

/// v2 `_coerce_actions` / `_normalize_args`.
pub fn normalize_actions(args: &Value) -> Result<Vec<Value>, ToolError> {
    let mut v = match args.get("actions") {
        Some(a) => a.clone(),
        None if args.get("action").is_some() => json!([args]),
        None => return Err(ToolError::Argument("Invalid arguments for tool 'todo': actions: Field required".into())),
    };
    if let Value::String(s) = &v {
        if let Ok(p) = serde_json::from_str::<Value>(s.trim()) {
            v = p;
        }
    }
    if v.is_object() {
        v = json!([v]);
    }
    match v {
        Value::Array(a) => Ok(a),
        _ => Err(ToolError::Argument("Invalid arguments for tool 'todo': actions: Input should be a valid list".into())),
    }
}

pub struct TodoTool;

#[async_trait]
impl Tool for TodoTool {
    fn name(&self) -> &str {
        "todo"
    }
    async fn run(&self, ctx: &ToolContext, args: Value) -> ToolResult {
        let actions = normalize_actions(&args)?;
        let path = todos_path(&ctx.artifacts_dir());
        Ok(ToolOutput::Text(apply(&path, &actions)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_update_read() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join(TODOS_FILENAME);
        let out = apply(&p, &[json!({"action": "create", "content": "a"}), json!({"action": "add", "content": "b"})]).unwrap();
        assert_eq!(out, "created task_1, task_2");
        let out = apply(&p, &[json!({"action": "update", "task_id": "task_1", "status": "completed"}), json!({"action": "update", "task_id": "task_9"})]).unwrap();
        assert_eq!(out, "updated task_1; unknown task_9");
        let out = apply(&p, &[json!({"action": "read"})]).unwrap();
        assert_eq!(out, "[task_1] [completed] a\n[task_2] [pending] b");
        let out = apply(&p, &[json!({"action": "clear", "status": "completed"})]).unwrap();
        assert_eq!(out, "cleared 1 tasks");
        let raw = std::fs::read_to_string(&p).unwrap();
        assert!(raw.starts_with("{\n  \"counter\": 2,"));
    }

    /// A bare `clear` empties the board, so a new plan never inherits the
    /// unfinished tasks of an abandoned one. A status narrows it.
    #[test]
    fn clear_without_status_removes_every_task() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join(TODOS_FILENAME);
        let board = [
            json!({"action": "create", "content": "done", "status": "completed"}),
            json!({"action": "create", "content": "dropped", "status": "cancelled"}),
            json!({"action": "create", "content": "doing", "status": "in_progress"}),
            json!({"action": "create", "content": "next"}),
        ];
        apply(&p, &board).unwrap();
        assert_eq!(apply(&p, &[json!({"action": "clear", "status": "finished"})]).unwrap(), "cleared 2 tasks");
        assert_eq!(apply(&p, &[json!({"action": "read"})]).unwrap(), "[task_3] [in_progress] doing\n[task_4] [pending] next");
        assert_eq!(apply(&p, &[json!({"action": "clear"}), json!({"action": "create", "content": "fresh"})]).unwrap(), "cleared 2 tasks; created task_5");
        assert_eq!(apply(&p, &[json!({"action": "read"})]).unwrap(), "[task_5] [pending] fresh");
    }
}
