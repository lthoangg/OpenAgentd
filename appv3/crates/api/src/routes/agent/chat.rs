//! `app/api/routes/agent/chat.py` — chat, commands, SSE stream, agent
//! listing, workspace pickers, session CRUD and history.

use super::helpers::*;
use super::worktrees;
use crate::error::{loc, verr, verr_ctx, ApiError, ApiResult};
use crate::sse::sse_response;
use crate::util::*;
use crate::AppState;
use appv3_agent::service::RawAttachment;
use appv3_agent::session::SessionError;
use appv3_agent::{manager, store};
use appv3_core::settings;
use appv3_db::api::{session_response, MessagesView, SessionOverlay};
use appv3_db::{self as db, DbPool};
use axum::extract::{FromRequest, Multipart, Path as AxPath, Request, State};
use axum::http::{header, StatusCode};
use axum::response::Response;
use axum::routing::{delete, get, post};
use axum::Router;
use bytes::Bytes;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/chat", post(agent_chat))
        .route("/sessions/{session_id}/queued-messages/{message_id}", delete(cancel_queued))
        .route("/commands", post(agent_command))
        .route("/{session_id}/stream", get(agent_stream))
        .route("/agents", get(get_agent_registry))
        .route("/workspace/validate", get(validate_workspace))
        .route("/workspace/browse", get(browse_workspace))
        .route("/sessions", get(list_sessions))
        .route("/sessions/resolve", post(resolve_session))
        .route("/workspace/visibility", axum::routing::patch(update_visibility))
        .route("/workspace/tree", get(workspace_tree))
        .route("/sessions/{session_id}", get(session_detail).patch(update_session).delete(delete_session_route))
        .route("/sessions/{session_id}/subagents", get(session_subagents))
        .route("/{session_id}/history", get(agent_history))
}

fn running_set() -> HashSet<String> {
    store().running_session_ids().into_iter().collect()
}

// ── POST /chat ──────────────────────────────────────────────────────────────

#[derive(Default)]
struct RawForm {
    fields: Vec<(String, String)>,
    files: Vec<RawAttachment>,
}

impl RawForm {
    fn get(&self, k: &str) -> Option<&str> {
        self.fields.iter().rev().find(|(n, _)| n == k).map(|(_, v)| v.as_str())
    }
    fn has(&self, k: &str) -> bool {
        self.fields.iter().any(|(n, _)| n == k)
    }
    /// FastAPI form semantics: `""` is treated as absent.
    fn opt(&self, k: &str) -> Option<String> {
        self.get(k).filter(|v| !v.is_empty()).map(String::from)
    }
}

async fn read_form(req: Request) -> ApiResult<RawForm> {
    let ct = req.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_ascii_lowercase();
    let mut form = RawForm::default();
    if ct.starts_with("multipart/form-data") {
        let mut mp = Multipart::from_request(req, &()).await.map_err(|e| ApiError::bad_request(format!("There was an error parsing the body: {e}")))?;
        loop {
            let field = match mp.next_field().await {
                Ok(Some(f)) => f,
                Ok(None) => break,
                Err(e) => return Err(ApiError::bad_request(format!("There was an error parsing the body: {e}"))),
            };
            let name = field.name().unwrap_or("").to_string();
            let filename = field.file_name().map(String::from);
            let content_type = field.content_type().map(String::from);
            let data = field.bytes().await.map_err(|e| ApiError::bad_request(format!("There was an error parsing the body: {e}")))?;
            match filename {
                Some(f) => {
                    if name == "files" && !f.is_empty() {
                        form.files.push(RawAttachment { filename: f, content_type, data: data.to_vec(), source: None });
                    }
                }
                None => form.fields.push((name, String::from_utf8_lossy(&data).to_string())),
            }
        }
    } else if ct.starts_with("application/x-www-form-urlencoded") {
        let bytes = Bytes::from_request(req, &()).await.map_err(|e| ApiError::bad_request(e.to_string()))?;
        form.fields = form_urlencoded::parse(&bytes).map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    }
    Ok(form)
}

fn form_bool(form: &RawForm, k: &str, errs: &mut Vec<Value>) -> bool {
    match form.opt(k) {
        None => false,
        Some(v) => pydantic_bool(&v).unwrap_or_else(|| {
            errs.push(bool_parsing(&["body", k], &v));
            false
        }),
    }
}

async fn agent_chat(State(st): State<AppState>, req: Request) -> ApiResult<Response> {
    let form = read_form(req).await?;
    let mut errs = vec![];
    let interrupt = form_bool(&form, "interrupt", &mut errs);
    let fast_mode = form_bool(&form, "fast_mode", &mut errs);
    let workspace = form.opt("workspace");
    if workspace.is_none() {
        errs.insert(0, verr("missing", &loc(&["body", "workspace"]), "Field required", Value::Null));
    }
    if !errs.is_empty() {
        return Err(ApiError::validation(errs));
    }
    let message = form.opt("message");
    let session_id = form.opt("session_id");
    let model_raw = form.opt("model");
    let thinking_raw = form.opt("thinking_level");
    let mentions: Option<Vec<String>> = match form.opt("mentions") {
        None => None,
        Some(raw) => match serde_json::from_str::<Value>(&raw) {
            Ok(Value::Array(items)) => {
                let mut out = vec![];
                for it in items {
                    match it {
                        Value::String(s) => out.push(s),
                        _ => return Err(ApiError::unprocessable("Input should be a valid string")),
                    }
                }
                Some(out)
            }
            _ => return Err(ApiError::unprocessable("Invalid JSON for mentions.")),
        },
    };
    // ChatForm._validate_message_or_interrupt
    let invalid = if interrupt && message.is_some() {
        Some("interrupt and message are mutually exclusive.")
    } else if interrupt && session_id.is_none() {
        Some("session_id is required when interrupt=true.")
    } else if !interrupt && message.is_none() {
        Some("message is required when interrupt=false.")
    } else if message.as_deref().map(|m| m.trim().is_empty()).unwrap_or(false) {
        Some("message must not be blank.")
    } else if model_raw.as_deref().map(|m| !m.trim().is_empty() && !m.trim().contains(':')).unwrap_or(false) {
        Some("model must use 'provider:model' format.")
    } else {
        None
    };
    if let Some(msg) = invalid {
        return Err(ApiError::unprocessable(format!("Value error, {msg}")));
    }
    let model_provided = form.has("model");
    let thinking_provided = form.has("thinking_level");
    let (model, thinking_level) = validate_model_settings(model_raw.as_deref(), thinking_raw.as_deref())?;

    let resolved = resolve_chat_agent(&st.pool, session_id, workspace).await?;
    let agent = resolved.agent.clone();
    let sid = resolved.session_id.clone();
    let ws = resolved.workspace.clone();

    if interrupt {
        appv3_agent::service::interrupt_agent(&agent, Some(&sid)).await;
        return Ok(json_code(202, json!({"status": "interrupted", "session_id": sid, "message_id": null})));
    }
    let message = message.unwrap_or_default();
    let attachments = form.files;
    let existing_total: usize = attachments.iter().map(|a| a.data.len()).sum();
    let blocks = {
        let (m, s, w, mm) = (message.clone(), sid.clone(), ws.clone(), mentions.clone());
        blocking(move || build_mention_context_blocks(&m, &s, w.as_deref(), existing_total, mm.as_ref())).await
    };
    let _guard = agent.user_message_lock.lock().await;
    if resolved.existed_id.is_some() {
        db::cleanup_reverted_tail(&st.pool, &sid).await?;
    }
    if resolved.existed_id.is_some() && agent.has_active_user_turn() && !agent.is_awaiting_question_answer() {
        let qid = persist_queued_user_message(
            &st.pool,
            QueueArgs {
                agent: &agent,
                session_id: &sid,
                workspace: ws.as_deref(),
                message: &message,
                attachments: &attachments,
                mention_context_blocks: &blocks,
                mentions: mentions.as_ref(),
                model: model.clone(),
                model_provided,
                thinking_level: thinking_level.clone(),
                thinking_level_provided: thinking_provided,
                fast: fast_mode,
            },
        )
        .await?;
        if !agent.has_active_user_turn() {
            agent.activate_queued_user_messages(&sid).await;
        }
        return Ok(json_code(202, json!({"status": "queued", "session_id": sid, "message_id": qid})));
    }
    let d = appv3_agent::service::Dispatch {
        content: message,
        session_id: Some(sid.clone()),
        attachments,
        mention_context_blocks: Some(blocks),
        workspace: ws,
        model,
        model_provided,
        thinking_level,
        thinking_level_provided: thinking_provided,
        service_tier: fast_mode.then(|| "fast".to_string()),
        mentions,
        origin: "user".into(),
        extra: None,
    };
    match appv3_agent::service::dispatch_user_message(&agent, d).await {
        Ok((sid, n, mid)) => {
            tracing::info!("agent_chat_received session_id={} attachments={}", sid, n);
            Ok(json_code(202, json!({"status": "accepted", "session_id": sid, "message_id": mid})))
        }
        Err(appv3_agent::service::DispatchError::Attachment(e)) => Err(ApiError::new(e.status, e.message)),
        Err(appv3_agent::service::DispatchError::Session(e)) => Err(session_err(e)),
    }
}

pub fn session_err(e: SessionError) -> ApiError {
    match e {
        SessionError::Precondition { message, status } => ApiError::new(status, message),
        other => ApiError::internal(other),
    }
}

async fn cancel_queued(State(st): State<AppState>, AxPath((sid, mid)): AxPath<(String, String)>) -> ApiResult<Response> {
    let sid = path_uuid("session_id", &sid)?;
    let mid = path_uuid("message_id", &mid)?;
    if !db::cancel_queued_user_message(&st.pool, &sid, &mid).await? {
        return Err(ApiError::not_found("Queued message not found."));
    }
    Ok(no_content())
}

// ── POST /commands ──────────────────────────────────────────────────────────

fn changed_paths(s: &appv3_agent::revert::BoundaryShift) -> Value {
    json!({"added": s.added, "modified": s.modified, "removed": s.removed})
}

async fn agent_command(State(st): State<AppState>, raw: Bytes) -> ApiResult<Response> {
    let body = body_value(&raw)?;
    if !body.is_object() {
        return Err(ApiError::validation(vec![verr("model_attributes_type", &loc(&["body"]), "Input should be a valid dictionary or object to extract fields from", body)]));
    }
    let mut errs = vec![];
    const CMDS: [&str; 5] = ["compact", "undo", "redo", "redo-all", "redo_all"];
    let expected = "'compact', 'undo', 'redo', 'redo-all' or 'redo_all'";
    let command = match body.get("command") {
        None => {
            errs.push(verr("missing", &loc(&["body", "command"]), "Field required", body.clone()));
            String::new()
        }
        Some(Value::String(c)) if CMDS.contains(&c.as_str()) => c.clone(),
        Some(other) => {
            errs.push(verr_ctx("literal_error", &loc(&["body", "command"]), &format!("Input should be {expected}"), other.clone(), json!({"expected": expected})));
            String::new()
        }
    };
    let session_id = match body.get("session_id") {
        None => {
            errs.push(verr("missing", &loc(&["body", "session_id"]), "Field required", body.clone()));
            String::new()
        }
        Some(Value::String(s)) => s.clone(),
        Some(other) => {
            errs.push(verr("string_type", &loc(&["body", "session_id"]), "Input should be a valid string", other.clone()));
            String::new()
        }
    };
    if !errs.is_empty() {
        return Err(ApiError::validation(errs));
    }
    let agent = resolve_agent_for_existing_session(&st.pool, &session_id).await?;
    let resp =
        |cmd: &str, sid: &str, message: Value, cp: Value| json_code(202, json!({"status": "accepted", "session_id": sid, "command": cmd, "message": message, "changed_paths": cp}));
    match command.as_str() {
        "compact" => {
            let sid = agent.handle_compact(&session_id, None).await.map_err(session_err)?;
            tracing::info!("agent_command_compact session_id={}", sid);
            Ok(resp("compact", &sid, Value::Null, Value::Null))
        }
        "undo" => {
            let shift = agent.handle_boundary_command(&session_id, "undo", "No message to undo.", appv3_agent::revert::undo_session_messages).await.map_err(session_err)?;
            let msg = shift.target.as_ref().map(message_response).unwrap_or(Value::Null);
            Ok(resp("undo", &session_id, msg, changed_paths(&shift)))
        }
        "redo" => {
            let shift = agent.handle_boundary_command(&session_id, "redo", "No undone message to redo.", appv3_agent::revert::redo_session_messages).await.map_err(session_err)?;
            let msg = shift.target.as_ref().map(message_response).unwrap_or(Value::Null);
            Ok(resp("redo", &session_id, msg, changed_paths(&shift)))
        }
        _ => {
            let shift =
                agent.handle_boundary_command(&session_id, "redo", "No undone message to redo.", appv3_agent::revert::redo_all_session_messages).await.map_err(session_err)?;
            Ok(resp("redo-all", &session_id, Value::Null, changed_paths(&shift)))
        }
    }
}

// ── GET /{sid}/stream ───────────────────────────────────────────────────────

async fn agent_stream(State(st): State<AppState>, AxPath(session_id): AxPath<String>) -> Response {
    if let Some(sid) = py_uuid(&session_id) {
        match db::get_pending_question(&st.pool, &sid).await {
            Ok(Some(_)) => store().ensure_turn(&session_id),
            Ok(None) => {}
            Err(e) => tracing::warn!("stream_ensure_turn_failed session_id={} error={}", session_id, e),
        }
    }
    let sub = store().attach(&session_id);
    let events = async_stream::stream! {
        if let Some(mut sub) = sub {
            while let Some(ev) = sub.next().await {
                yield ev;
            }
        }
    };
    sse_response(events)
}

// ── GET /agents ─────────────────────────────────────────────────────────────

fn custom_threshold() -> Option<i64> {
    appv3_core::runtime_settings::load_runtime_settings().ok().and_then(|c| c.summarization.prompt_token_threshold)
}

fn tool_desc(def: &Value) -> (String, String) {
    let f = def.get("function").unwrap_or(def);
    (f.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(), f.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string())
}

/// `_serialize_agent`.
pub fn serialize_agent(agent: &appv3_agent::Agent, workspace: Option<&str>, custom: Option<i64>) -> Value {
    let ws_path = workspace.filter(|w| !w.is_empty()).map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    let ctx = appv3_tools::ToolContext {
        session_id: None,
        agent_name: agent.name.clone(),
        tool_call_id: String::new(),
        denied: std::sync::Arc::new(appv3_tools::DeniedPaths::new(&ws_path, None)),
        workspace: workspace.map(String::from),
        output: None,
        metadata: Default::default(),
        messages: None,
    };
    let mut tools: Vec<(String, String)> = agent.tools.definitions_for(&ctx).iter().map(tool_desc).collect();
    if let Some(src) = appv3_agent::loader::mcp_source() {
        for server in &agent.mcp_servers {
            for t in src.tools_for_server(server) {
                let (n, d) = tool_desc(&t.definition());
                if !tools.iter().any(|(x, _)| *x == n) {
                    tools.push((n, d));
                }
            }
        }
    }
    for (n, d) in [
        ("delegate".to_string(), appv3_agent::tools::team::delegate_description()),
        ("ask_user".to_string(), "Ask the user 1-4 questions and pause the turn until they answer.".to_string()),
        ("plan".to_string(), "Write or edit this session's plan, which the user reviews in the Plan panel.".to_string()),
        ("submit_plan".to_string(), "Submit the plan for review and pause the turn until the user approves or requests changes.".to_string()),
    ] {
        if !tools.iter().any(|(x, _)| *x == n) {
            tools.push((n, d));
        }
    }
    // The session injects `preview` for coding workspaces (see `session.rs`).
    if let Some(ws) = workspace.filter(|w| !w.is_empty()) {
        if settings().workspace_mode(Some(Path::new(ws))) == "coding" && !tools.iter().any(|(x, _)| x == appv3_agent::tools::preview::PREVIEW_TOOL) {
            use appv3_tools::Tool;
            tools.push(tool_desc(&appv3_agent::tools::preview::PreviewTool.definition()));
        }
    }
    json!({
        "name": agent.name,
        "description": agent.description.clone().unwrap_or_default(),
        "model": agent.model_id,
        // v3 only: lets the UI name the agent's level when the session sets none.
        "thinking_level": agent.thinking_level,
        "summary_trigger_tokens": appv3_agent::hooks::summarization::resolve_prompt_token_threshold(agent.model_id.as_deref(), custom),
        "tools": tools.into_iter().map(|(n, d)| json!({"name": n, "description": d})).collect::<Vec<_>>(),
        "mcp_servers": agent.mcp_servers,
        "capabilities": appv3_providers::registry::capabilities_dict(agent.model_id.as_deref()),
    })
}

async fn get_agent_registry(q: Qs) -> ApiResult<Response> {
    let workspace = q.opt("workspace").filter(|w| !w.is_empty());
    let session_id = q.opt("session_id");
    let agent = match workspace.as_deref() {
        Some(ws) => match manager::find_live_session(ws, session_id.as_deref()) {
            Some(a) => Some(a),
            None => get_or_start(ws, Some(session_id.as_deref().filter(|s| !s.is_empty()).unwrap_or("__agents__"))).await?,
        },
        None => {
            let cwd = std::env::current_dir().unwrap_or_default().display().to_string();
            get_or_start(&cwd, session_id.as_deref()).await?
        }
    };
    let Some(agent) = agent else { return Err(ApiError::not_found("No agent configured")) };
    let ws = agent.workspace();
    let info = serialize_agent(&agent.agent(), Some(&ws), custom_threshold());
    Ok(json(json!({
        "agents": [info],
        "mode": settings().workspace_mode(Some(Path::new(&ws))),
        "workspace": ws,
    })))
}

// ── workspace pickers ───────────────────────────────────────────────────────

async fn validate_workspace(q: Qs) -> ApiResult<Response> {
    let ws = q.req("workspace")?;
    let resolved = manager::validate_workspace(&ws, true).map_err(ApiError::unprocessable)?;
    Ok(json(json!({"workspace": resolved})))
}

async fn browse_workspace(q: Qs) -> ApiResult<Response> {
    let path = q.opt("path").filter(|p| !p.is_empty());
    blocking(move || {
        let root = match &path {
            Some(p) => resolve(&expanduser(p)),
            None => resolve(&home()),
        };
        if !root.is_dir() {
            return Err(ApiError::unprocessable(format!("Not a directory: {}", root.display())));
        }
        let rd = std::fs::read_dir(&root).map_err(|_| ApiError::new(403, format!("Cannot read directory: {}", root.display())))?;
        let mut entries: Vec<std::fs::DirEntry> = rd.flatten().collect();
        entries.sort_by_key(|e| e.file_name().to_string_lossy().to_lowercase());
        let mut dirs = vec![];
        for e in entries {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            if e.path().is_dir() {
                dirs.push(json!({"name": name, "path": resolve(&e.path()).display().to_string()}));
            }
        }
        let parent = root.parent().filter(|p| *p != root.as_path()).map(|p| p.display().to_string());
        Ok(json(json!({"path": root.display().to_string(), "parent": parent, "directories": dirs})))
    })
    .await
}

async fn update_visibility(State(st): State<AppState>, raw: Bytes) -> ApiResult<Response> {
    let b = body_value(&raw)?;
    let mut errs = vec![];
    let ws = match b.get("workspace") {
        Some(Value::String(s)) => s.clone(),
        None => {
            errs.push(verr("missing", &loc(&["body", "workspace"]), "Field required", b.clone()));
            String::new()
        }
        Some(o) => {
            errs.push(verr("string_type", &loc(&["body", "workspace"]), "Input should be a valid string", o.clone()));
            String::new()
        }
    };
    let hidden = match b.get("hidden") {
        None => {
            errs.push(verr("missing", &loc(&["body", "hidden"]), "Field required", b.clone()));
            false
        }
        Some(_) => match opt_bool_field(&b, "hidden") {
            Ok(v) => v.unwrap_or(false),
            Err(e) => return Err(e),
        },
    };
    if !errs.is_empty() {
        return Err(ApiError::validation(errs));
    }
    let workspace = validate_workspace_or_422(&ws, !hidden)?;
    if hidden {
        db::hide_coding_workspace(&st.pool, &workspace).await?;
    } else {
        db::upsert_coding_workspace(&st.pool, &workspace, "repo", None, None, false, false).await?;
    }
    Ok(json(json!({"workspace": workspace, "hidden": hidden})))
}

fn basename(p: &str) -> String {
    Path::new(p).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
}

async fn workspace_tree(State(st): State<AppState>) -> ApiResult<Response> {
    let s = settings();
    let chat_path = s.chat_workspace_root().display().to_string();
    let rows = db::list_visible_coding_workspaces(&st.pool).await?;
    let mut repos: Vec<(String, Map<String, Value>)> = vec![];
    let mut pending = vec![];
    for row in rows {
        if s.is_chat_workspace(Some(Path::new(&row.path))) || s.is_chat_workspace(row.source_path.as_deref().map(Path::new)) {
            continue;
        }
        if row.kind == "worktree" {
            pending.push(row);
            continue;
        }
        let name = row.name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| basename(&row.path));
        let entry = json!({"path": row.path, "name": name, "worktrees": []});
        match repos.iter_mut().find(|(p, _)| *p == row.path) {
            Some(slot) => slot.1 = entry.as_object().unwrap().clone(),
            None => repos.push((row.path.clone(), entry.as_object().unwrap().clone())),
        }
    }
    for row in pending {
        let Some(source) = row.source_path.clone().filter(|p| !p.is_empty()) else { continue };
        if !repos.iter().any(|(p, _)| *p == source) {
            repos.push((source.clone(), json!({"path": source, "name": basename(&source), "worktrees": []}).as_object().unwrap().clone()));
        }
        let name = row.name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| basename(&row.path));
        let slot = repos.iter_mut().find(|(p, _)| *p == source).unwrap();
        slot.1.get_mut("worktrees").unwrap().as_array_mut().unwrap().push(json!({"path": row.path, "name": name, "managed": row.managed}));
    }
    Ok(json(json!({
        "repositories": repos.into_iter().map(|(_, m)| Value::Object(m)).collect::<Vec<_>>(),
        "chat": {"path": chat_path, "name": "Chat"},
    })))
}

// ── sessions ────────────────────────────────────────────────────────────────

async fn list_sessions(State(st): State<AppState>, q: Qs) -> ApiResult<Response> {
    let before = q.opt("before");
    let limit = q.int("limit", 20, Some(1), Some(100))?;
    // `workspaces` (repeatable) is a v3 addition: sessions in any listed path,
    // so the sidebar lists a repository and its worktrees as one page. v2
    // ignores it. A `workspace` value joins the same list.
    let mut workspaces: Vec<String> = q.opt("workspace").into_iter().collect();
    workspaces.extend(q.get_all("workspaces"));
    let running = running_set();
    let awaiting = db::sessions_awaiting_input(&st.pool).await?;
    // v3 addition: every session running or waiting on the user, in one page,
    // however old — the sidebar's "Needs you" list and the badge counts. v2
    // ignores the parameter and returns a normal page.
    let (sessions, next_cursor, has_more) = if q.opt("active").as_deref() == Some("true") {
        let ids: Vec<String> = running.iter().chain(awaiting.iter()).cloned().collect();
        let mut rows = db::get_sessions_by_ids(&st.pool, &ids).await?;
        rows.retain(|s| s.parent_session_id.is_none() && (workspaces.is_empty() || workspaces.contains(&s.workspace)));
        rows.sort_by(|a, b| (&b.created_at, &b.id).cmp(&(&a.created_at, &a.id)));
        (rows, None, false)
    } else {
        // `q` is a v3 addition too (sidebar search); v2 ignores it.
        let title_query = q.opt("q");
        db::list_sessions_page(&st.pool, before.as_deref(), limit, &workspaces, title_query.as_deref().map(str::trim))
            .await
            .map_err(|_| ApiError::unprocessable("Invalid 'before' cursor."))?
    };
    let ids: Vec<String> = sessions.iter().map(|s| s.id.clone()).collect();
    let children = db::list_child_sessions(&st.pool, &ids).await?;
    let overlay = |s: &db::ChatSession| SessionOverlay {
        running: running.contains(&db::codec::api_uuid(&s.id)),
        needs_input: awaiting.contains(&s.id) || awaiting.contains(&db::codec::api_uuid(&s.id)),
        ..Default::default()
    };
    let data: Vec<Value> = sessions
        .iter()
        .map(|s| {
            let subs: Vec<Value> =
                children.iter().filter(|c| c.parent_session_id.as_deref() == Some(s.id.as_str())).map(|c| Value::Object(session_response(c, &overlay(c)))).collect();
            let mut o = overlay(s);
            o.subagents = subs;
            Value::Object(session_response(s, &o))
        })
        .collect();
    Ok(json(json!({"data": data, "next_cursor": next_cursor, "has_more": has_more})))
}

async fn resolve_session(State(st): State<AppState>, raw: Bytes) -> ApiResult<Response> {
    let b = body_value(&raw)?;
    if !b.is_object() {
        return Err(ApiError::validation(vec![verr("model_attributes_type", &loc(&["body"]), "Input should be a valid dictionary or object to extract fields from", b)]));
    }
    let workspace = match b.get("workspace") {
        None => return Err(ApiError::validation(vec![verr("missing", &loc(&["body", "workspace"]), "Field required", b.clone())])),
        Some(Value::String(s)) if s.is_empty() => {
            return Err(ApiError::validation(vec![verr_ctx(
                "string_too_short",
                &loc(&["body", "workspace"]),
                "String should have at least 1 character",
                json!(s),
                json!({"min_length": 1}),
            )]))
        }
        Some(_) => opt_str_field(&b, "workspace")?.unwrap_or_default(),
    };
    let model = opt_str_field(&b, "model")?;
    let thinking = opt_str_field(&b, "thinking_level")?;
    let mut create = opt_bool_field(&b, "create")?.unwrap_or(false);
    let wt_from = opt_str_field(&b, "worktree_from")?;
    let wt_name = opt_str_field(&b, "worktree_name")?;
    let wt_branch = opt_str_field(&b, "worktree_branch")?;
    let (model, thinking) = validate_model_settings(model.as_deref(), thinking.as_deref())?;

    let has = |o: &Option<String>| o.as_deref().map(|s| !s.is_empty()).unwrap_or(false);
    let workspace = if has(&wt_from) || has(&wt_name) || has(&wt_branch) {
        if !has(&wt_from) || !has(&wt_name) {
            return Err(ApiError::unprocessable("worktree_from and worktree_name are required for worktree sessions."));
        }
        let created = worktrees::create_worktree(&st.pool, wt_from.as_deref().unwrap(), wt_name.as_deref(), wt_branch.as_deref(), false).await?;
        create = true;
        created.directory
    } else {
        validate_workspace_or_422(&workspace, true)?
    };
    let mut session = None;
    if !create {
        session = db::get_latest_top_level_session(&st.pool, &workspace).await?;
    }
    let created = session.is_none();
    let session = match session {
        Some(s) => s,
        None => {
            db::create_session(&st.pool, db::NewSession { workspace: workspace.clone(), model, thinking_level: thinking, agent_name: Some("code".into()), ..Default::default() })
                .await?
        }
    };
    if !workspace.is_empty() && !settings().is_chat_workspace(Some(Path::new(&workspace))) {
        match worktrees::find_managed_worktree_source(Path::new(&workspace)).await {
            Some(source) => {
                db::upsert_coding_workspace(&st.pool, &source, "repo", None, None, false, false).await?;
                db::upsert_coding_workspace(&st.pool, &workspace, "worktree", Some(&source), None, true, false).await?;
            }
            None => {
                db::upsert_coding_workspace(&st.pool, &workspace, "repo", None, None, false, false).await?;
            }
        }
    }
    let mut m = session_response(&session, &SessionOverlay::default());
    m.insert("created".into(), json!(created));
    Ok(json(Value::Object(m)))
}

async fn session_detail(State(st): State<AppState>, AxPath(raw): AxPath<String>) -> ApiResult<Response> {
    let sid = path_uuid("session_id", &raw)?;
    let Some(root) = db::get_session(&st.pool, &sid).await? else { return Err(ApiError::not_found("Session not found.")) };
    let (lead, _, _) = db::history_page(&st.pool, &sid, None).await?;
    let pending = manager::find_live_session_serving_session(&sid).and_then(|s| s.pending_interaction_mode());
    let m = session_response(&root, &SessionOverlay { running: store().is_running(&sid), pending_interaction_mode: pending, ..Default::default() });
    Ok(json_status(StatusCode::OK, &WithMessages { session: m, messages: MessagesView(&lead) }))
}

async fn update_session(State(st): State<AppState>, AxPath(raw): AxPath<String>, body: Bytes) -> ApiResult<Response> {
    let sid = path_uuid("session_id", &raw)?;
    let b = body_value(&body)?;
    if !b.is_object() {
        return Err(ApiError::validation(vec![verr("model_attributes_type", &loc(&["body"]), "Input should be a valid dictionary or object to extract fields from", b)]));
    }
    let mut errs = vec![];
    let title = match b.get("title") {
        None | Some(Value::Null) => None,
        Some(Value::String(t)) => {
            let n = t.chars().count();
            if n < 1 {
                errs.push(verr_ctx("string_too_short", &loc(&["body", "title"]), "String should have at least 1 character", json!(t), json!({"min_length": 1})));
            } else if n > 255 {
                errs.push(verr_ctx("string_too_long", &loc(&["body", "title"]), "String should have at most 255 characters", json!(t), json!({"max_length": 255})));
            }
            Some(t.clone())
        }
        Some(o) => {
            errs.push(verr("string_type", &loc(&["body", "title"]), "Input should be a valid string", o.clone()));
            None
        }
    };
    let mode = match b.get("interaction_mode") {
        None | Some(Value::Null) => None,
        Some(Value::String(m)) if m == "code" || m == "plan" => Some(m.clone()),
        Some(o) => {
            errs.push(verr_ctx("literal_error", &loc(&["body", "interaction_mode"]), "Input should be 'code' or 'plan'", o.clone(), json!({"expected": "'code' or 'plan'"})));
            None
        }
    };
    if !errs.is_empty() {
        return Err(ApiError::validation(errs));
    }
    if title.is_none() && mode.is_none() {
        return Err(value_error("Provide a title or interaction_mode.", b));
    }
    let clean_title = |t: &Option<String>| -> ApiResult<Option<String>> {
        match t {
            None => Ok(None),
            Some(t) => {
                let s = t.trim().to_string();
                if s.is_empty() {
                    return Err(ApiError::unprocessable("Title cannot be empty."));
                }
                Ok(Some(s))
            }
        }
    };
    let live = mode.as_ref().and_then(|_| manager::find_live_session_serving_session(&sid));
    let row = db::get_session(&st.pool, &sid).await?.filter(|s| s.parent_session_id.is_none()).ok_or_else(|| ApiError::not_found("Session not found."))?;
    if let Some(live) = live.filter(|l| l.is_busy()) {
        let m = mode.clone().unwrap();
        live.queue_interaction_mode(&m);
        let mut row = row;
        if let Some(t) = clean_title(&title)? {
            row = db::update_session(&st.pool, &sid, db::SessionUpdate::title(t)).await?.unwrap_or(row);
        }
        let resp = session_response(&row, &SessionOverlay { running: store().is_running(&sid), pending_interaction_mode: Some(m), ..Default::default() });
        return Ok(json(Value::Object(resp)));
    }
    let mut row = row;
    if let Some(t) = clean_title(&title)? {
        row = db::update_session(&st.pool, &sid, db::SessionUpdate::title(t)).await?.unwrap_or(row);
    }
    if let Some(m) = &mode {
        row = appv3_agent::interaction_mode::set_mode(&st.pool, &sid, m).await?.0;
    }
    Ok(json(Value::Object(session_response(&row, &SessionOverlay { running: store().is_running(&sid), ..Default::default() }))))
}

/// `chat_service.delete_session`.
pub async fn delete_session(pool: &DbPool, session_id: &str) -> ApiResult<bool> {
    if db::get_session(pool, session_id).await?.is_none() {
        return Ok(false);
    }
    let tree = db::session_descendants(pool, session_id).await?;
    let ids: HashSet<String> = tree.iter().map(|(id, _)| db::codec::api_uuid(id)).collect();
    manager::evict_sessions(&ids).await;
    for sid in &ids {
        appv3_agent::subagents::stop_all_subagents(sid).await;
        appv3_agent::subagents::remove_subagent(sid);
        appv3_agent::subagents::cleanup_lead_session(sid);
    }
    db::delete_session_rows(pool, session_id).await?;
    let s = settings();
    for sid in &ids {
        store().clear(sid);
        appv3_agent::snapshot::remove(sid).await;
        let uploads = s.uploads_dir(sid);
        let artifacts = s.data_dir.join("sessions").join(sid);
        let sid2 = sid.clone();
        blocking(move || {
            for (p, label) in [(uploads, "uploads_dir"), (artifacts, "session_metadata")] {
                if p.exists() {
                    match std::fs::remove_dir_all(&p) {
                        Ok(()) => tracing::info!("{}_deleted session_id={}", label, sid2),
                        Err(e) => tracing::error!("session_path_cleanup_failed path={} label={} error={}", p.display(), label, e),
                    }
                }
            }
        })
        .await;
    }
    tracing::info!("session_deleted session_id={}", session_id);
    Ok(true)
}

async fn delete_session_route(State(st): State<AppState>, AxPath(raw): AxPath<String>) -> ApiResult<Response> {
    let sid = path_uuid("session_id", &raw)?;
    if !delete_session(&st.pool, &sid).await? {
        return Err(ApiError::not_found("Session not found."));
    }
    Ok(no_content())
}

async fn session_subagents(State(st): State<AppState>, AxPath(raw): AxPath<String>) -> ApiResult<Response> {
    let sid = path_uuid("session_id", &raw)?;
    Ok(json(appv3_agent::subagents::list_subagents(&sid, &st.pool).await))
}

// ── history ─────────────────────────────────────────────────────────────────

async fn ensure_agent_ready(root: &db::ChatSession) -> ApiResult<()> {
    if !root.workspace.is_empty() && root.parent_session_id.is_none() {
        get_or_start(&root.workspace, Some(&db::codec::api_uuid(&root.id))).await?;
    } else if root.parent_session_id.is_none() {
        let cwd = std::env::current_dir().unwrap_or_default().display().to_string();
        if get_or_start(&cwd, None).await?.is_none() {
            return Err(ApiError::not_found("No agent configured."));
        }
    }
    Ok(())
}

/// Session-wide `(estimated_cost_usd, completion_tokens)` per session id.
type UsageTotals = std::collections::HashMap<String, (f64, i64)>;

/// A session object with its page of messages appended. History bodies are
/// serialized straight from the rows rather than built as a `Value` tree.
#[derive(Serialize)]
struct WithMessages<'a> {
    #[serde(flatten)]
    session: Map<String, Value>,
    messages: MessagesView<'a>,
}

#[derive(Serialize)]
struct MemberPart<'a> {
    name: String,
    session_id: String,
    messages: MessagesView<'a>,
    running: bool,
    estimated_cost_usd: f64,
    completion_tokens: i64,
}

/// The `/history` envelope.
#[derive(Serialize)]
struct HistoryBody<'a> {
    lead: WithMessages<'a>,
    members: Vec<MemberPart<'a>>,
    has_more: bool,
    next_cursor: Option<String>,
    truncated: bool,
    pending_question: Option<Value>,
}

fn member_part<'a>(statuses: &[(String, String)], sub: &db::ChatSession, msgs: &'a [db::SessionMessage], totals: &UsageTotals) -> MemberPart<'a> {
    let name = sub.agent_name.clone().unwrap_or_else(|| db::codec::api_uuid(&sub.id));
    let (cost, completion) = totals.get(&sub.id).copied().unwrap_or((0.0, 0));
    let running = statuses.iter().any(|(n, s)| *n == name && s == "working");
    MemberPart { name, session_id: db::codec::api_uuid(&sub.id), messages: MessagesView(msgs), running, estimated_cost_usd: cost, completion_tokens: completion }
}

/// The lead's part of a history response. `totals` is `None` on older pages:
/// the totals cover the whole session, and only the newest page and the
/// delta carry them (the client ignores them anywhere else).
fn lead_part<'a>(root: &db::ChatSession, msgs: &'a [db::SessionMessage], totals: Option<&UsageTotals>) -> WithMessages<'a> {
    let effective = root.agent_name.clone().unwrap_or_else(|| if root.parent_session_id.is_none() { "code".into() } else { "member".into() });
    let usage = totals.map(|t| t.get(&root.id).copied().unwrap_or((0.0, 0)));
    let rid = db::codec::api_uuid(&root.id);
    let session = session_response(
        root,
        &SessionOverlay {
            agent_name: Some(effective),
            running: store().is_running(&rid),
            estimated_cost_usd: usage.map(|(cost, _)| cost),
            completion_tokens: usage.map(|(_, completion)| completion),
            ..Default::default()
        },
    );
    WithMessages { session, messages: MessagesView(msgs) }
}

/// Usage totals for the lead and its members in one scan.
async fn usage_totals(pool: &DbPool, root: &db::ChatSession, subs: &[db::ChatSession]) -> ApiResult<UsageTotals> {
    let ids: Vec<&str> = std::iter::once(root.id.as_str()).chain(subs.iter().map(|s| s.id.as_str())).collect();
    Ok(db::session_usage_totals_many(pool, &ids).await?)
}

async fn agent_history(State(st): State<AppState>, AxPath(raw): AxPath<String>, q: Qs) -> ApiResult<Response> {
    let sid = path_uuid("session_id", &raw)?;
    let before = q.opt("before");
    let since = q.opt("since");
    if before.is_some() && since.is_some() {
        return Err(ApiError::unprocessable("Pass either 'before' or 'since', not both."));
    }
    let pool = &st.pool;
    if let Some(since) = since {
        let since_id = py_uuid(&since).ok_or_else(|| ApiError::unprocessable(format!("Invalid since cursor: {since}")))?;
        let Some(root) = db::get_session(pool, &sid).await? else { return Err(ApiError::not_found("Lead session not found.")) };
        const LIMIT: i64 = 100;
        let (lead_rows, mut truncated) = db::history_since(pool, &sid, &since_id, LIMIT).await?;
        let subs = db::list_child_sessions(pool, std::slice::from_ref(&sid)).await?;
        ensure_agent_ready(&root).await?;
        let member_rows = futures::future::try_join_all(subs.iter().map(|sub| db::history_since(pool, &sub.id, &since_id, LIMIT))).await?;
        let totals = usage_totals(pool, &root, &subs).await?;
        let statuses = store().get_agent_statuses(&sid);
        let lead = lead_part(&root, &lead_rows, Some(&totals));
        let mut members = Vec::with_capacity(subs.len());
        for (sub, (rows, _)) in subs.iter().zip(&member_rows) {
            if rows.len() as i64 >= LIMIT {
                truncated = true;
            }
            members.push(member_part(&statuses, sub, rows, &totals));
        }
        return Ok(json_status(StatusCode::OK, &HistoryBody { lead, members, has_more: false, next_cursor: None, truncated, pending_question: None }));
    }

    let mut cursor: Option<(i64, Option<String>)> = None;
    let first_page = before.is_none();
    if let Some(b) = before.as_deref() {
        let invalid = || ApiError::unprocessable(format!("Invalid before cursor: {b}"));
        let (head, raw_id) = match b.split_once('|') {
            Some((h, i)) => (h, Some(i)),
            None => (b, None),
        };
        let before_id = match raw_id.filter(|i| !i.is_empty()) {
            Some(i) => Some(py_uuid(i).ok_or_else(invalid)?),
            None => None,
        };
        cursor = Some((head.trim().parse::<i64>().map_err(|_| invalid())?, before_id));
    }
    let Some(root) = db::get_session(pool, &sid).await? else { return Err(ApiError::not_found("Lead session not found.")) };
    let (lead_rows, has_more, boundary) = db::history_page(pool, &sid, cursor.clone()).await?;
    ensure_agent_ready(&root).await?;
    // Members ride on the newest page only. The client shows member rows from
    // that page alone, and a member's `seq` is its own — paging it with the
    // lead's cursor re-sent (and duplicated) its newest rows on every older page.
    let (subs, member_rows, totals, statuses) = if first_page {
        let subs = db::list_child_sessions(pool, std::slice::from_ref(&sid)).await?;
        let member_rows = futures::future::try_join_all(subs.iter().map(|sub| db::history_page(pool, &sub.id, None))).await?;
        let totals = usage_totals(pool, &root, &subs).await?;
        (subs, member_rows, Some(totals), store().get_agent_statuses(&sid))
    } else {
        (vec![], vec![], None, vec![])
    };
    let next_cursor = boundary.map(|b| format!("{}|{}", b.seq, db::codec::api_uuid(&b.id)));
    let pending = if first_page { db::get_pending_question(pool, &sid).await?.map(|q| db::api::pending_question_response(&q)) } else { None };
    let members = match &totals {
        Some(t) => subs.iter().zip(&member_rows).map(|(sub, (rows, _, _))| member_part(&statuses, sub, rows, t)).collect(),
        None => vec![],
    };
    let lead = lead_part(&root, &lead_rows, totals.as_ref());
    Ok(json_status(StatusCode::OK, &HistoryBody { lead, members, has_more, next_cursor, truncated: false, pending_question: pending }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use appv3_providers::mock::MockProvider;
    use std::sync::Arc;

    fn agent(thinking_level: Option<&str>) -> appv3_agent::Agent {
        let mut agent = appv3_agent::Agent::new(Arc::new(MockProvider::new(vec![])), "code", "Hi", vec![], Some("mock:mock".into()));
        agent.thinking_level = thinking_level.map(String::from);
        agent
    }

    #[test]
    fn serialized_agent_carries_its_thinking_level() {
        let info = serialize_agent(&agent(Some("high")), None, None);
        assert_eq!(info["model"], "mock:mock");
        assert_eq!(info["thinking_level"], "high");
        assert_eq!(serialize_agent(&agent(None), None, None)["thinking_level"], Value::Null);
    }

    #[test]
    fn serialized_agent_lists_preview_only_for_coding_workspaces() {
        let names = |info: &Value| info["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        let dir = tempfile::tempdir().unwrap();
        let coding = serialize_agent(&agent(None), Some(&dir.path().to_string_lossy()), None);
        assert!(names(&coding).contains(&"preview".to_string()), "{coding}");
        assert!(!names(&serialize_agent(&agent(None), None, None)).contains(&"preview".to_string()));
    }

    #[test]
    fn history_body_keeps_its_wire_shape() {
        let row = db::SessionMessage {
            id: "0123456789abcdef0123456789abcdef".into(),
            session_id: "fedcba9876543210fedcba9876543210".into(),
            role: "assistant".into(),
            content: None,
            reasoning_content: None,
            tool_calls: Some(r#"[{"id": "c"}]"#.into()),
            tool_call_id: None,
            name: None,
            extra: None,
            created_at: "2026-09-23 06:56:28.000000".into(),
            seq: 5,
            kind: "chat".into(),
            pinned: false,
        };
        let rows = [row];
        let session: Map<String, Value> = [("id".to_string(), json!("l"))].into_iter().collect();
        let member = MemberPart { name: "m".into(), session_id: "s".into(), messages: MessagesView(&[]), running: true, estimated_cost_usd: 0.5, completion_tokens: 3 };
        let body = HistoryBody {
            lead: WithMessages { session, messages: MessagesView(&rows) },
            members: vec![member],
            has_more: true,
            next_cursor: Some("5|x".into()),
            truncated: false,
            pending_question: None,
        };
        let msg = r#"{"id":"01234567-89ab-cdef-0123-456789abcdef","session_id":"fedcba98-7654-3210-fedc-ba9876543210","role":"assistant","tool_calls":[{"id": "c"}],"seq":5,"kind":"chat","is_summary":false,"created_at":"2026-09-23T06:56:28Z","file_message":false}"#;
        let expected = format!(
            r#"{{"lead":{{"id":"l","messages":[{msg}]}},"members":[{{"name":"m","session_id":"s","messages":[],"running":true,"estimated_cost_usd":0.5,"completion_tokens":3}}],"has_more":true,"next_cursor":"5|x","truncated":false,"pending_question":null}}"#
        );
        assert_eq!(String::from_utf8(serde_json::to_vec(&body).unwrap()).unwrap(), expected);
        let delta = HistoryBody {
            lead: WithMessages { session: Map::new(), messages: MessagesView(&[]) },
            members: vec![],
            has_more: false,
            next_cursor: None,
            truncated: true,
            pending_question: Some(json!({"id": "q"})),
        };
        assert_eq!(
            serde_json::to_string(&delta).unwrap(),
            r#"{"lead":{"messages":[]},"members":[],"has_more":false,"next_cursor":null,"truncated":true,"pending_question":{"id":"q"}}"#
        );
    }
}
