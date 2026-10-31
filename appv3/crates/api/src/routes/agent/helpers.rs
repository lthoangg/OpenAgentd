//! `app/api/routes/agent/_helpers.py`.

use crate::error::{ApiError, ApiResult};
use appv3_agent::manager;
use appv3_agent::service::{categorize, RawAttachment, GLOBAL_SIZE_LIMIT, MENTION_MAX_BYTES};
use appv3_agent::session::{session_workspace_dir, AgentSession};
use appv3_db::{self as db, DbPool, NewMessage};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub fn message_response(m: &db::SessionMessage) -> Value {
    Value::Object(db::api::message_response(m))
}

pub fn validate_workspace_or_422(ws: &str, require_exists: bool) -> ApiResult<String> {
    manager::validate_workspace(ws, require_exists).map_err(ApiError::unprocessable)
}

pub fn manager_err(e: manager::ManagerError) -> ApiError {
    match e {
        manager::ManagerError::InvalidWorkspace(m) | manager::ManagerError::Profile(m) => ApiError::unprocessable(m),
        manager::ManagerError::WorkspaceMismatch(m) => ApiError::conflict(m),
        manager::ManagerError::Other(e) => ApiError::internal(e),
    }
}

pub fn goal_err(e: appv3_agent::goal::GoalError) -> ApiError {
    match e {
        appv3_agent::goal::GoalError::Invalid(m) => ApiError::unprocessable(m),
        appv3_agent::goal::GoalError::Db(e) => ApiError::internal(e),
    }
}

pub async fn get_or_start(ws: &str, sid: Option<&str>) -> ApiResult<Option<Arc<AgentSession>>> {
    manager::get_or_start_agent_session(ws, sid).await.map_err(manager_err)
}

pub async fn require_started(ws: &str, sid: Option<&str>) -> ApiResult<Arc<AgentSession>> {
    get_or_start(ws, sid).await?.ok_or_else(|| ApiError::not_found("No agent configured."))
}

/// `validate_model_settings`.
pub fn validate_model_settings(model: Option<&str>, thinking: Option<&str>) -> ApiResult<(Option<String>, Option<String>)> {
    let m = model.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let t = thinking.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    // v2: `model.strip() if model else None` keeps "" → None; a
    // whitespace-only model strips to "" which is falsy → no registry check.
    if let Some(ref id) = m {
        if !crate::providers::is_registered_model_id(id) {
            return Err(ApiError::unprocessable("Choose a model from the registry."));
        }
    }
    Ok((m, t))
}

pub struct ResolvedChatAgent {
    pub agent: Arc<AgentSession>,
    pub session_id: String,
    pub existed_id: Option<String>,
    pub workspace: Option<String>,
}

/// `resolve_agent_for_existing_session`.
pub async fn resolve_agent_for_existing_session(pool: &DbPool, session_id: &str) -> ApiResult<Arc<AgentSession>> {
    let sid = crate::util::py_uuid(session_id).ok_or_else(|| ApiError::unprocessable("Invalid session id."))?;
    let existing = db::get_session(pool, &sid).await?;
    let Some(existing) = existing.filter(|s| !s.workspace.is_empty()) else { return Err(ApiError::not_found("Session not found.")) };
    if existing.parent_session_id.is_some() {
        return Err(ApiError::bad_request("Cannot run commands directly on a subagent session. Subagents are orchestrated exclusively by the lead agent."));
    }
    let ws = validate_workspace_or_422(&existing.workspace, true)?;
    require_started(&ws, Some(session_id)).await
}

/// `resolve_chat_agent`.
pub async fn resolve_chat_agent(pool: &DbPool, session_id: Option<String>, workspace: Option<String>) -> ApiResult<ResolvedChatAgent> {
    let mut existing = None;
    let mut existed_id = None;
    if let Some(sid) = session_id.as_deref() {
        let canon = crate::util::py_uuid(sid).ok_or_else(|| ApiError::unprocessable("Invalid session id."))?;
        existing = db::get_session(pool, &canon).await?;
        existed_id = Some(canon);
    }
    if existing.as_ref().map(|e| e.parent_session_id.is_some()).unwrap_or(false) {
        return Err(ApiError::bad_request("Cannot chat directly with a subagent session. Subagents are orchestrated exclusively by the lead agent."));
    }
    let (sid, ws) = match existing.as_ref().filter(|e| !e.workspace.is_empty()) {
        Some(e) => {
            let persisted = validate_workspace_or_422(&e.workspace, true)?;
            if let Some(req) = workspace.as_deref() {
                let requested = validate_workspace_or_422(req, true)?;
                if requested != persisted {
                    return Err(ApiError::conflict(format!("Session belongs to a different coding workspace: {persisted}")));
                }
            }
            (session_id.clone().unwrap(), persisted)
        }
        None => {
            let sid = session_id.clone().unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
            let ws = validate_workspace_or_422(workspace.as_deref().unwrap_or(""), true)?;
            (sid, ws)
        }
    };
    let agent = require_started(&ws, Some(&sid)).await?;
    Ok(ResolvedChatAgent { agent, session_id: sid, existed_id, workspace: Some(ws) })
}

pub struct QueueArgs<'a> {
    pub agent: &'a AgentSession,
    pub session_id: &'a str,
    pub workspace: Option<&'a str>,
    pub message: &'a str,
    pub attachments: &'a [RawAttachment],
    pub mention_context_blocks: &'a [String],
    pub mentions: Option<&'a Vec<String>>,
    pub model: Option<String>,
    pub model_provided: bool,
    pub thinking_level: Option<String>,
    pub thinking_level_provided: bool,
    pub fast: bool,
}

/// `persist_queued_user_message` → queued message id.
pub async fn persist_queued_user_message(pool: &DbPool, a: QueueArgs<'_>) -> ApiResult<String> {
    let mut metas: Vec<Value> = vec![];
    if !a.attachments.is_empty() {
        metas = appv3_agent::service::validate_and_persist_attachments(a.attachments, Some(a.session_id), a.workspace).await.map_err(|e| ApiError::new(e.status, e.message))?.1;
    }
    let agent_model = a.agent.model_id();
    let mut extra = Map::new();
    let eff = a.model.clone().filter(|m| !m.is_empty()).unwrap_or_else(|| agent_model.clone());
    if !eff.is_empty() {
        extra.insert("model".into(), json!(eff));
    }
    if let Some(t) = a.thinking_level.as_ref().filter(|t| !t.is_empty()) {
        extra.insert("thinking_level".into(), json!(t));
    }
    if a.fast {
        extra.insert("service_tier".into(), json!("fast"));
    }
    if !metas.is_empty() {
        extra.insert("attachments".into(), Value::Array(metas.clone()));
    }
    if let Some(m) = a.mentions.filter(|m| !m.is_empty()) {
        extra.insert("mentions".into(), json!(m));
    }
    if let Some(row) = db::get_session(pool, a.session_id).await? {
        let mut upd = db::SessionUpdate::default();
        if a.model_provided {
            upd.model = Some(a.model.clone());
        }
        if a.thinking_level_provided {
            upd.thinking_level = Some(a.thinking_level.clone());
        }
        let row = db::update_session(pool, a.session_id, upd).await?.unwrap_or(row);
        let eff = row.model.clone().filter(|m| !m.is_empty()).unwrap_or(agent_model);
        if !eff.is_empty() {
            extra.insert("model".into(), json!(eff));
        }
        if let Some(t) = row.thinking_level.as_ref().filter(|t| !t.is_empty()) {
            extra.insert("thinking_level".into(), json!(t));
        }
        if a.fast {
            extra.insert("service_tier".into(), json!("fast"));
        }
    }
    let queued = db::save_queued_user_message(pool, a.session_id, a.message, Some(extra)).await?;
    appv3_agent::broadcaster::publish_session_activity(a.session_id, &queued.created_at);
    let qid = db::codec::api_uuid(&queued.id);
    for block in a.mention_context_blocks {
        let mut e = Map::new();
        e.insert("hidden_from_user".into(), json!(true));
        e.insert("hidden_from_summary".into(), json!(true));
        e.insert("attachment_for_message_id".into(), json!(qid));
        e.insert("mention_context".into(), json!(true));
        db::save_message(pool, a.session_id, NewMessage { extra: Some(e), ..NewMessage::user(block.clone()) }).await?;
    }
    tracing::info!("agent_chat_queued session_id={} message_id={} attachments={}", a.session_id, qid, metas.len());
    Ok(qid)
}

// ── @-mentions ──────────────────────────────────────────────────────────────

const MAX_MENTION_ATTACHMENTS: usize = 20;
const MENTION_INLINE_MAX_CHARS: usize = 32_000;

fn is_abs_like(rel: &str) -> bool {
    rel.starts_with('/') || (rel.len() >= 2 && rel.as_bytes()[1] == b':')
}

fn safe_join(root: &Path, rel: &str, want_dir: bool) -> Option<PathBuf> {
    if rel.is_empty() || is_abs_like(rel) {
        return None;
    }
    let resolved = crate::util::resolve(&root.join(rel));
    let root_r = crate::util::resolve(root);
    if !resolved.starts_with(&root_r) {
        return None;
    }
    let ok = if want_dir { resolved.is_dir() } else { resolved.is_file() };
    ok.then_some(resolved)
}

/// `_parse_line_ref` → (path, label, start, end).
fn parse_line_ref(rel: &str) -> (String, String, Option<usize>, Option<usize>) {
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"^(?P<path>.+)#L(?P<start>\d+)(?:-L?(?P<end>\d+))?$").unwrap());
    let Some(c) = RE.captures(rel) else { return (rel.into(), rel.into(), None, None) };
    let path = c["path"].to_string();
    let (Ok(start), end) = (c["start"].parse::<usize>(), c.name("end").map(|m| m.as_str().parse::<usize>())) else {
        return (rel.into(), rel.into(), None, None);
    };
    let end = match end {
        Some(Ok(e)) => e,
        Some(Err(_)) => return (rel.into(), rel.into(), None, None),
        None => start,
    };
    if start < 1 || end < start {
        return (rel.into(), rel.into(), None, None);
    }
    let label = if start == end { format!("{path}#L{start}") } else { format!("{path}#L{start}-L{end}") };
    (path, label, Some(start), Some(end))
}

/// Python `str.splitlines(keepends=True)`.
fn splitlines_keepends(s: &str) -> Vec<&str> {
    let mut out = vec![];
    let mut start = 0;
    let bytes: Vec<(usize, char)> = s.char_indices().collect();
    let mut i = 0;
    while i < bytes.len() {
        let (idx, ch) = bytes[i];
        let is_break = matches!(ch, '\n' | '\r' | '\x0b' | '\x0c' | '\x1c' | '\x1d' | '\x1e' | '\u{85}' | '\u{2028}' | '\u{2029}');
        if is_break {
            let mut end = idx + ch.len_utf8();
            if ch == '\r' && i + 1 < bytes.len() && bytes[i + 1].1 == '\n' {
                end += 1;
                i += 1;
            }
            out.push(&s[start..end]);
            start = end;
        }
        i += 1;
    }
    if start < s.len() {
        out.push(&s[start..]);
    }
    out
}

fn is_likely_binary(data: &[u8]) -> bool {
    if data.contains(&0) {
        return true;
    }
    let sample = &data[..data.len().min(8192)];
    if sample.is_empty() {
        return false;
    }
    let control = sample.iter().filter(|b| **b < 32 && !matches!(**b, 9 | 10 | 13)).count();
    control as f64 / sample.len() as f64 > 0.30
}

fn fmt_thousands(n: usize) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

fn maybe_truncate_inline(text: &str, cap: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= cap {
        return text.to_string();
    }
    let half = cap / 2;
    let head: String = chars[..half].iter().collect();
    let tail: String = chars[chars.len() - half..].iter().collect();
    let omitted = chars.len() - 2 * half;
    format!("{head}\n\n... [Middle truncated — {} chars elided. Use the Read tool for full content.] ...\n\n{tail}", fmt_thousands(omitted))
}

/// Latin-1 decode (never fails).
fn latin1(data: &[u8]) -> String {
    data.iter().map(|b| *b as char).collect()
}

fn build_text_block(data: &[u8], label: &str) -> String {
    let text = match std::str::from_utf8(data) {
        Ok(t) => t.to_string(),
        Err(_) => latin1(data),
    };
    let body = maybe_truncate_inline(&text, MENTION_INLINE_MAX_CHARS);
    if label.contains("#L") {
        format!("[File: {label} — selected lines already loaded; use this block directly instead of reading the same range]\n{body}\n[End file: {label}]")
    } else {
        format!("[File: {label}]\n{body}\n[End file: {label}]")
    }
}

fn directory_listing_block(rel: &str, dir: &Path) -> String {
    let Ok(rd) = std::fs::read_dir(dir) else { return format!("[Directory: {rel}]\n[Unable to list directory.]\n[End directory: {rel}]") };
    let mut children: Vec<(bool, String)> = rd.flatten().map(|e| (e.path().is_dir(), e.file_name().to_string_lossy().to_string())).collect();
    children.sort_by(|a, b| (!a.0, &a.1).cmp(&(!b.0, &b.1)));
    let mut entries: Vec<String> = children.iter().take(50).map(|(d, n)| format!("- {n}{}", if *d { "/" } else { "" })).collect();
    if children.len() > 50 {
        entries.push(format!("... ({} more entries)", children.len() - 50));
    }
    let body = if entries.is_empty() { "[Empty directory]".to_string() } else { entries.join("\n") };
    format!("[Directory: {rel}]\n{body}\n[End directory: {rel}]")
}

/// `_read_mention_as_attachment` → inlinable bytes, or `None`.
fn read_mention(label: &str, abs: &Path, start: Option<usize>, end: Option<usize>) -> Option<Vec<u8>> {
    let mime = appv3_core::mimetypes::guess_type(&abs.to_string_lossy());
    let cat = categorize(label, mime.as_deref()).unwrap_or("text");
    if cat != "text" {
        return None;
    }
    let mut data = std::fs::read(abs).ok()?;
    if is_likely_binary(&data) {
        return None;
    }
    if let (Some(s), Some(e)) = (start, end) {
        let text = std::str::from_utf8(&data).ok()?;
        let lines = splitlines_keepends(text);
        data = if s > lines.len() { vec![] } else { lines[s - 1..e.min(lines.len())].concat().into_bytes() };
    }
    if data.is_empty() || data.len() > MENTION_MAX_BYTES {
        return None;
    }
    Some(data)
}

/// `build_mention_context_blocks`.
pub fn build_mention_context_blocks(message: &str, session_id: &str, workspace: Option<&str>, existing_total: usize, mentions: Option<&Vec<String>>) -> Vec<String> {
    let Some(mentions) = mentions.filter(|m| !m.is_empty()) else { return vec![] };
    let root = session_workspace_dir(session_id, workspace);
    let mut raw: Vec<&String> = vec![];
    for p in mentions {
        if p.is_empty() || raw.contains(&p) {
            continue;
        }
        raw.push(p);
        if raw.len() >= MAX_MENTION_ATTACHMENTS {
            break;
        }
    }
    let mut out = vec![];
    let mut total = existing_total;
    for rel in raw {
        if !message.contains(&format!("@{rel}")) && !message.contains(&format!("@{rel}/")) {
            continue;
        }
        if let Some(stripped) = rel.strip_suffix('/') {
            let Some(dir) = safe_join(&root, stripped, true) else { continue };
            let block = directory_listing_block(rel, &dir);
            total += block.len();
            if total > GLOBAL_SIZE_LIMIT {
                break;
            }
            out.push(block);
            continue;
        }
        let (file_rel, label, s, e) = parse_line_ref(rel);
        let Some(abs) = safe_join(&root, &file_rel, false) else {
            if let Some(dir) = safe_join(&root, &file_rel, true) {
                let block = directory_listing_block(&format!("{file_rel}/"), &dir);
                total += block.len();
                if total > GLOBAL_SIZE_LIMIT {
                    break;
                }
                out.push(block);
            }
            continue;
        };
        match read_mention(&label, &abs, s, e) {
            None => {
                let mime = appv3_core::mimetypes::guess_type(&abs.to_string_lossy());
                if let Some(c @ ("image" | "document")) = categorize(&file_rel, mime.as_deref()) {
                    let kind = if c == "image" { "image" } else { "document" };
                    let block = format!("[Mentioned {kind}: {label} — use the read tool to view this file]");
                    total += block.len();
                    if total > GLOBAL_SIZE_LIMIT {
                        break;
                    }
                    out.push(block);
                }
            }
            Some(data) => {
                let block = build_text_block(&data, &label);
                total += data.len();
                if total > GLOBAL_SIZE_LIMIT {
                    break;
                }
                out.push(block);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_refs() {
        assert_eq!(parse_line_ref("a.py#L3-L5"), ("a.py".into(), "a.py#L3-L5".into(), Some(3), Some(5)));
        assert_eq!(parse_line_ref("a.py#L3-5"), ("a.py".into(), "a.py#L3-L5".into(), Some(3), Some(5)));
        assert_eq!(parse_line_ref("a.py#L3"), ("a.py".into(), "a.py#L3".into(), Some(3), Some(3)));
        assert_eq!(parse_line_ref("a.py#L5-L3").2, None);
        assert_eq!(splitlines_keepends("a\r\nb\nc"), vec!["a\r\n", "b\n", "c"]);
        assert_eq!(fmt_thousands(1234567), "1,234,567");
    }
}
