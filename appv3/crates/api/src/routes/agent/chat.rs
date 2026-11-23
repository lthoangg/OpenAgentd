//! Talking to an agent: sending a message (run, queue or steer), cancelling
//! a queued one, commands (compact, undo, redo), side questions, the SSE
//! stream and the agent listing. The router also registers the session,
//! history and workspace routes of the submodules.

use super::helpers::*;
use crate::error::{loc, verr, verr_ctx, ApiError, ApiResult};
use crate::sse::sse_response;
use crate::util::*;
use crate::AppState;
use appv3_agent::service::RawAttachment;
use appv3_agent::session::SessionError;
use appv3_agent::{manager, store};
use appv3_core::settings;
use appv3_db::{self as db, DbPool};
use axum::extract::{FromRequest, Multipart, Path as AxPath, Request, State};
use axum::http::header;
use axum::response::Response;
use axum::routing::{delete, get, post};
use axum::Router;
use bytes::Bytes;
use history::{agent_history, tool_call_arguments, tool_result};
use serde_json::{json, Value};
use sessions::{delete_session_route, list_sessions, resolve_session, save_run_settings, session_detail, session_subagents, session_waiting, update_session};
use std::path::{Path, PathBuf};
use workspaces::{browse_workspace, register_session_workspace, relocate_workspace, update_visibility, validate_workspace, workspace_tree};

mod history;
mod sessions;
mod workspaces;

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
        .route("/workspace/relocate", post(relocate_workspace))
        .route("/workspace/tree", get(workspace_tree))
        .route("/sessions/{session_id}", get(session_detail).patch(update_session).delete(delete_session_route))
        .route("/sessions/{session_id}/subagents", get(session_subagents))
        .route("/sessions/{session_id}/waiting", get(session_waiting))
        .route("/{session_id}/history", get(agent_history))
        .route("/{session_id}/tool-results/{tool_call_id}", get(tool_result))
        .route("/{session_id}/tool-calls/{tool_call_id}/arguments", get(tool_call_arguments))
        .route("/sessions/{session_id}/btw", post(ask_side_question).get(list_side_questions).delete(clear_side_questions))
        .route("/sessions/{session_id}/btw/count", get(count_side_questions))
        .route("/sessions/{session_id}/btw/{side_id}/stop", post(stop_side_question))
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
    let keep_goal = form_bool(&form, "keep_goal", &mut errs);
    let fast_mode = form_bool(&form, "fast_mode", &mut errs);
    // v3 addition: "Queue until done". Only matters when the message queues;
    // an idle agent runs it at once, which is what waiting would have done.
    let hold_until_turn_end = form_bool(&form, "hold_until_turn_end", &mut errs);
    let workspace = form.opt("workspace");
    if workspace.is_none() {
        errs.insert(0, verr("missing", &loc(&["body", "workspace"]), "Field required", Value::Null));
    }
    // v3 addition: the mode a session started by this message begins in (the
    // new-session screen's Code / Plan toggle, picked before a session exists).
    let interaction_mode = match form.opt("interaction_mode") {
        None => None,
        Some(m) if m == "code" || m == "plan" => Some(m),
        Some(m) => {
            errs.push(verr_ctx("literal_error", &loc(&["body", "interaction_mode"]), "Input should be 'code' or 'plan'", json!(m), json!({"expected": "'code' or 'plan'"})));
            None
        }
    };
    if !errs.is_empty() {
        return Err(ApiError::validation(errs));
    }
    let message = form.opt("message");
    let session_id = form.opt("session_id");
    let model_raw = form.opt("model");
    let thinking_raw = form.opt("thinking_level");
    // v3 addition: the account a new session's draft was pinned to.
    let credential_raw = form.opt("credential_id").map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
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
    } else if keep_goal && !interrupt {
        Some("keep_goal requires interrupt=true.")
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

    // Only a session this message creates takes `interaction_mode`; an
    // existing one switches through `PATCH /sessions/{id}`. Checked before
    // `resolve_chat_agent`, which already makes the row.
    let starts_in_plan = interaction_mode.as_deref() == Some("plan")
        && match session_id.as_deref() {
            None => true,
            Some(raw) => match py_uuid(raw) {
                Some(canon) => db::get_session(&st.pool, &canon).await?.is_none(),
                None => false,
            },
        };
    let resolved = resolve_chat_agent(&st.pool, session_id, workspace).await?;
    let agent = resolved.agent.clone();
    let sid = resolved.session_id.clone();
    let ws = resolved.workspace.clone();

    if interrupt {
        if keep_goal {
            appv3_agent::service::interrupt_agent_keeping_goal(&agent, Some(&sid)).await;
        } else {
            appv3_agent::service::interrupt_agent(&agent, Some(&sid)).await;
        }
        return Ok(json_code(202, json!({"status": "interrupted", "session_id": sid, "message_id": null})));
    }
    // A first message with no session id starts a session (the web's lazy
    // new-session draft): make its folder a sidebar workspace like
    // `/sessions/resolve` does, so the new session has a tree row to sit in.
    if resolved.existed_id.is_none() {
        if let Some(w) = ws.as_deref() {
            register_session_workspace(&st.pool, w).await?;
        }
    }
    // The new session has no messages yet, so no transition note: the turn
    // adds Plan's instructions itself (`ensure_prompt`) and runs with its tools.
    if starts_in_plan {
        if db::get_session(&st.pool, &sid).await?.is_none() {
            let id = db::codec::parse_uuid(&sid).ok_or_else(|| ApiError::unprocessable("Invalid session id."))?;
            db::create_session(
                &st.pool,
                db::NewSession {
                    id: Some(id),
                    agent_name: Some(agent.name()),
                    workspace: ws.clone().unwrap_or_default(),
                    model: agent.agent().model_id.clone(),
                    ..Default::default()
                },
            )
            .await?;
        }
        db::update_session(&st.pool, &sid, db::SessionUpdate { interaction_mode: Some("plan".into()), ..Default::default() }).await?;
    }
    // Pinned before the message is dispatched, so the first turn already
    // runs on the chosen account.
    if let Some(cred) = credential_raw {
        let row = match db::get_session(&st.pool, &sid).await? {
            Some(row) => row,
            None => {
                let id = db::codec::parse_uuid(&sid).ok_or_else(|| ApiError::unprocessable("Invalid session id."))?;
                let new = db::NewSession {
                    id: Some(id),
                    agent_name: Some(agent.name()),
                    workspace: ws.clone().unwrap_or_default(),
                    model: model.clone().or_else(|| agent.agent().model_id.clone()),
                    ..Default::default()
                };
                db::create_session(&st.pool, new).await?
            }
        };
        let model_change = if model_provided { Some(model.clone()) } else { None };
        save_run_settings(&st.pool, &sid, row, model_change, None, Some(Some(cred))).await?;
    }
    let message = message.unwrap_or_default();
    let attachments = form.files;
    // A message sent right after Stop (Stop & send, or another client) would
    // otherwise queue behind the turn still winding down, and a stopped turn
    // never starts its queue. Waited out before the lock, so nothing blocks on it.
    if agent.is_stopping() {
        agent.wait_for_stop(appv3_agent::service::STOP_SETTLE_TIMEOUT).await;
    }
    let existing_total: usize = attachments.iter().map(|a| a.data.len()).sum();
    let blocks = {
        let (m, s, w, mm) = (message.clone(), sid.clone(), ws.clone(), mentions.clone());
        blocking(move || build_mention_context_blocks(&m, &s, w.as_deref(), existing_total, mm.as_ref())).await
    };
    let _guard = agent.user_message_lock.lock().await;
    if resolved.existed_id.is_some() {
        db::cleanup_reverted_tail(&st.pool, &sid).await?;
    }
    if resolved.existed_id.is_some() && waits_behind_turn(agent.has_active_user_turn(), agent.is_awaiting_question_answer(), hold_until_turn_end) {
        // A question can be open while the turn still runs (it opens before
        // the reply's other tool calls finish). A steer replaces it there
        // too; a held message leaves it for the answer.
        if !hold_until_turn_end {
            agent.dismiss_pending_question("superseded", Some(&sid)).await;
        }
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
                hold_until_turn_end,
            },
        )
        .await?;
        if !agent.has_active_user_turn() {
            agent.activate_queued_user_messages(&sid).await;
        } else if agent.is_stopping() {
            // The stop outlasted the wait above: run the queue once it ends.
            tokio::spawn(appv3_agent::service::activate_queued_after_stop(agent.clone(), sid.clone()));
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
    let sent = appv3_agent::service::dispatch_user_message(&agent, d).await;
    match sent {
        Ok((sid, n, mid)) => {
            tracing::info!("agent_chat_received session_id={} attachments={}", sid, n);
            Ok(json_code(202, json!({"status": "accepted", "session_id": sid, "message_id": mid})))
        }
        Err(appv3_agent::service::DispatchError::Attachment(e)) => Err(ApiError::new(e.status, e.message)),
        Err(appv3_agent::service::DispatchError::Session(e)) => Err(session_err(e)),
    }
}

/// Whether a message to a session that already exists queues instead of
/// running now. A busy agent queues it, except while a question waits: a
/// steer replaces the question, while a held ("Queue until done") message
/// waits for the answer. Answering resumes the turn, and the held message
/// starts its own turn when that one ends.
fn waits_behind_turn(busy: bool, awaiting_question: bool, hold_until_turn_end: bool) -> bool {
    busy && (!awaiting_question || hold_until_turn_end)
}

fn session_err(e: SessionError) -> ApiError {
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
    let keep_files = match body.get("keep_files") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(other) => {
            errs.push(verr("bool_type", &loc(&["body", "keep_files"]), "Input should be a valid boolean", other.clone()));
            false
        }
    };
    if keep_files && !command.is_empty() && command != "undo" {
        errs.push(verr("extra_forbidden", &loc(&["body", "keep_files"]), "keep_files applies only to 'undo'", Value::Bool(true)));
    }
    if !errs.is_empty() {
        return Err(ApiError::validation(errs));
    }
    let agent = resolve_agent_for_existing_session(&st.pool, &session_id).await?;
    let resp =
        |cmd: &str, sid: &str, message: Value, cp: Value| json_code(202, json!({"status": "accepted", "session_id": sid, "command": cmd, "message": message, "changed_paths": cp}));
    let shift_resp = |cmd: &str, shift: &appv3_agent::revert::BoundaryShift| {
        let message = shift.target.as_ref().map(message_response).unwrap_or(Value::Null);
        let changed_paths = json!({"added": shift.added, "modified": shift.modified, "removed": shift.removed});
        json_code(202, json!({"status": "accepted", "session_id": session_id, "command": cmd, "message": message, "changed_paths": changed_paths, "keep_files": shift.keep_files}))
    };
    match command.as_str() {
        "compact" => {
            let sid = agent.handle_compact(&session_id, None).await.map_err(session_err)?;
            tracing::info!("agent_command_compact session_id={}", sid);
            Ok(resp("compact", &sid, Value::Null, Value::Null))
        }
        "undo" => {
            let undo = |pool, sid| appv3_agent::revert::undo_session_messages(pool, sid, keep_files);
            let shift = agent.handle_boundary_command(&session_id, "undo", "No message to undo.", undo).await.map_err(session_err)?;
            Ok(shift_resp("undo", &shift))
        }
        "redo" => {
            let shift = agent.handle_boundary_command(&session_id, "redo", "No undone message to redo.", appv3_agent::revert::redo_session_messages).await.map_err(session_err)?;
            Ok(shift_resp("redo", &shift))
        }
        _ => {
            let shift =
                agent.handle_boundary_command(&session_id, "redo", "No undone message to redo.", appv3_agent::revert::redo_all_session_messages).await.map_err(session_err)?;
            Ok(shift_resp("redo-all", &shift))
        }
    }
}

// ── /sessions/{sid}/btw — side questions ───────────────────────────────────

/// The session must exist; side questions never start an agent.
async fn existing_session_id(pool: &DbPool, raw: &str) -> ApiResult<String> {
    let sid = path_uuid("session_id", raw)?;
    if db::get_session(pool, &sid).await?.is_none() {
        return Err(ApiError::not_found("Session not found."));
    }
    Ok(sid)
}

async fn ask_side_question(State(st): State<AppState>, AxPath(raw): AxPath<String>, body: Bytes) -> ApiResult<Response> {
    let sid = path_uuid("session_id", &raw)?;
    let body = body_value(&body)?;
    let question = match body.get("question") {
        Some(Value::String(q)) => q.trim().to_string(),
        Some(other) => return Err(ApiError::validation(vec![verr("string_type", &loc(&["body", "question"]), "Input should be a valid string", other.clone())])),
        None => return Err(ApiError::validation(vec![verr("missing", &loc(&["body", "question"]), "Field required", body.clone())])),
    };
    let len = question.chars().count();
    if len == 0 || len > appv3_agent::side_question::MAX_QUESTION_CHARS {
        return Err(ApiError::unprocessable(format!("question must be 1 to {} characters.", appv3_agent::side_question::MAX_QUESTION_CHARS)));
    }
    let agent = resolve_agent_for_existing_session(&st.pool, &sid).await?;
    let ask = agent.ask_side_question(&sid, &question).await.map_err(session_err)?;
    tracing::info!("side_question_started session_id={} id={}", sid, ask.id);
    let events = futures::StreamExt::map(tokio_stream::wrappers::UnboundedReceiverStream::new(ask.events), |e| e.to_wire());
    Ok(sse_response(events))
}

async fn list_side_questions(State(st): State<AppState>, AxPath(raw): AxPath<String>, q: Qs) -> ApiResult<Response> {
    let sid = existing_session_id(&st.pool, &raw).await?;
    let limit = q.int("limit", 50, Some(1), Some(appv3_agent::side_question::KEEP_PER_SESSION))?;
    let rows = appv3_agent::side_question::list(&st.pool, &sid, limit).await?;
    let total = db::count_side_questions(&st.pool, &sid).await?;
    Ok(json(json!({"items": rows.iter().map(db::SideQuestion::to_api).collect::<Vec<_>>(), "total": total})))
}

async fn count_side_questions(State(st): State<AppState>, AxPath(raw): AxPath<String>) -> ApiResult<Response> {
    let sid = existing_session_id(&st.pool, &raw).await?;
    Ok(json(json!({"total": db::count_side_questions(&st.pool, &sid).await?})))
}

async fn stop_side_question(AxPath((raw, side)): AxPath<(String, String)>) -> ApiResult<Response> {
    let sid = path_uuid("session_id", &raw)?;
    let id = path_uuid("side_id", &side)?;
    if !appv3_agent::side_question::stop(&sid, &id) {
        return Err(ApiError::not_found("Side question is not running."));
    }
    Ok(no_content())
}

async fn clear_side_questions(State(st): State<AppState>, AxPath(raw): AxPath<String>) -> ApiResult<Response> {
    let sid = existing_session_id(&st.pool, &raw).await?;
    appv3_agent::side_question::clear(&st.pool, &sid).await?;
    Ok(no_content())
}

// ── GET /{sid}/stream ───────────────────────────────────────────────────────

async fn agent_stream(State(st): State<AppState>, AxPath(session_id): AxPath<String>) -> Response {
    if let Some(sid) = py_uuid(&session_id) {
        match db::get_pending_question(&st.pool, &sid).await {
            Ok(Some(row)) => store().ensure_parked_turn(&session_id, &row),
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

fn tool_desc(def: &Value) -> (String, String) {
    let f = def.get("function").unwrap_or(def);
    (f.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(), f.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string())
}

/// Serialise an agent for the `/api/agent` listing.
fn serialize_agent(agent: &appv3_agent::Agent, workspace: Option<&str>, custom: Option<i64>) -> Value {
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
        ("team".to_string(), appv3_agent::tools::team::delegate_description()),
        ("ask_user".to_string(), "Ask the user 1-4 questions and pause the turn until they answer.".to_string()),
        ("plan".to_string(), "Write, edit, or submit this session's plan, which the user reviews in the Plan panel.".to_string()),
    ] {
        if !tools.iter().any(|(x, _)| *x == n) {
            tools.push((n, d));
        }
    }
    // The session injects `browser` for a lead with a workspace, Chat's
    // included (`tool_registry.rs`).
    // `workspace` is injected for leads unless Settings turn it off.
    if appv3_core::runtime_settings::workspace_messages_enabled() && !tools.iter().any(|(x, _)| x == "workspace") {
        if let Some(def) = appv3_tools::contract_definition("workspace") {
            tools.push(tool_desc(&def));
        }
    }
    if workspace.is_some_and(|w| !w.is_empty()) && !tools.iter().any(|(x, _)| x == appv3_agent::tools::browser::BROWSER_TOOL) {
        use appv3_tools::Tool;
        tools.push(tool_desc(&appv3_agent::tools::browser::BrowserTool.definition()));
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
    // The UI can pair a session id with the workspace it is switching to.
    // Serve that workspace's registry, never start the session there.
    async fn start(ws: &str, sid: Option<&str>, fallback: Option<&str>) -> ApiResult<Option<std::sync::Arc<appv3_agent::session::AgentSession>>> {
        match manager::get_or_start_agent_session(ws, sid).await {
            Err(manager::ManagerError::WorkspaceMismatch(m)) => {
                tracing::debug!("agent_registry_session_elsewhere workspace={} detail={}", ws, m);
                get_or_start(ws, fallback).await
            }
            r => r.map_err(manager_err),
        }
    }
    let agent = match workspace.as_deref() {
        Some(ws) => match manager::find_live_session(ws, session_id.as_deref()) {
            Some(a) => Some(a),
            None => start(ws, Some(session_id.as_deref().filter(|s| !s.is_empty()).unwrap_or("__agents__")), Some("__agents__")).await?,
        },
        None => {
            let cwd = std::env::current_dir().unwrap_or_default().display().to_string();
            start(&cwd, session_id.as_deref(), None).await?
        }
    };
    let Some(agent) = agent else { return Err(ApiError::not_found("No agent configured")) };
    agent.refresh_config_if_idle();
    let ws = agent.workspace();
    let custom_threshold = appv3_core::runtime_settings::load_runtime_settings().ok().and_then(|c| c.summarization.prompt_token_threshold);
    let info = serialize_agent(&agent.agent(), Some(&ws), custom_threshold);
    Ok(json(json!({
        "agents": [info],
        "mode": settings().workspace_mode(Some(Path::new(&ws))),
        "workspace": ws,
    })))
}

#[cfg(test)]
mod tests;
