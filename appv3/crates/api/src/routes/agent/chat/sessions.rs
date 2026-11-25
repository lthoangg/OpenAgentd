//! Sessions as rows: the sidebar list, resolving a workspace to its session,
//! a session's detail, its settings (title, mode, pin, model, thinking level,
//! account), deleting it, and what it still waits for.

use super::super::helpers::*;
use super::super::worktrees;
use super::history::WithMessages;
use super::workspaces::register_session_workspace;
use crate::error::{loc, verr, verr_ctx, ApiError, ApiResult};
use crate::util::*;
use crate::AppState;
use appv3_agent::{manager, store};
use appv3_core::settings;
use appv3_db::api::{session_response, MessagesView, SessionOverlay};
use appv3_db::{self as db, DbPool};
use axum::extract::{Path as AxPath, State};
use axum::http::StatusCode;
use axum::response::Response;
use bytes::Bytes;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

fn running_set() -> HashSet<String> {
    store().running_session_ids().into_iter().collect()
}

pub(super) async fn list_sessions(State(st): State<AppState>, q: Qs) -> ApiResult<Response> {
    let before = q.opt("before");
    let limit = q.int("limit", 20, Some(1), Some(100))?;
    // `workspaces` (repeatable) is a v3 addition: sessions in any listed path,
    // so the sidebar lists a repository and its worktrees as one page. v2
    // ignores it. A `workspace` value joins the same list.
    let mut workspaces: Vec<String> = q.opt("workspace").into_iter().collect();
    workspaces.extend(q.get_all("workspaces"));
    let running = running_set();
    let awaiting = db::sessions_awaiting_input(&st.pool).await?;
    // Leads whose turn ended while subagents (or another workspace) still
    // work for them: not finished, so the active list keeps them.
    let pending = appv3_agent::subagents::sessions_with_pending_work();
    let waiting_on_lead = appv3_agent::subagents::subagents_waiting_on_lead();
    // `sort` and `pinned` are v3 additions (the sidebar's view options); v2
    // ignores them. `sort=activity` orders by `last_message_at`; `pinned=true` is
    // every pinned session in one page, `pinned=false` leaves them out.
    let sort = match q.opt("sort").as_deref() {
        None | Some("") | Some("created") => db::SessionSort::Created,
        Some("activity") => db::SessionSort::Activity,
        Some(_) => return Err(ApiError::unprocessable("Invalid 'sort'.")),
    };
    let pinned = match q.opt("pinned").as_deref() {
        Some("true") => Some(true),
        Some("false") => Some(false),
        _ => None,
    };
    // v3 addition: every session running, waiting on the user, or waiting on
    // work it started (`background_work`), in one page, however old — the
    // sidebar's "Needs you" list, the badge counts and the notch island. v2
    // ignores the parameter and returns a normal page.
    // v3 addition: `remaining` counts the sessions past this page (the
    // sidebar's "Show N more"). Only a paged list with more to show has it.
    let mut remaining: Option<i64> = None;
    let (sessions, next_cursor, has_more) = if q.opt("active").as_deref() == Some("true") {
        let ids: Vec<String> = running.iter().chain(awaiting.iter()).chain(pending.iter()).cloned().collect();
        let mut rows = db::get_sessions_by_ids(&st.pool, &ids).await?;
        rows.retain(|s| s.parent_session_id.is_none() && (workspaces.is_empty() || workspaces.contains(&s.workspace)));
        rows.sort_by(|a, b| (&b.created_at, &b.id).cmp(&(&a.created_at, &a.id)));
        (rows, None, false)
    } else if pinned == Some(true) {
        (db::list_pinned_sessions(&st.pool, &workspaces).await?, None, false)
    } else {
        // `q` is a v3 addition too (sidebar search); v2 ignores it.
        let title_query = q.opt("q");
        let filter = db::SessionListFilter { workspaces: &workspaces, title_query: title_query.as_deref().map(str::trim), sort, pinned };
        let page = db::list_sessions_page(&st.pool, before.as_deref(), limit, &filter).await.map_err(|_| ApiError::unprocessable("Invalid 'before' cursor."))?;
        if let Some(cursor) = page.1.as_deref() {
            remaining = Some(db::count_sessions_before(&st.pool, cursor, &filter).await?);
        }
        page
    };
    let ids: Vec<String> = sessions.iter().map(|s| s.id.clone()).collect();
    let children = db::list_child_sessions(&st.pool, &ids).await?;
    // v3 addition: sessions other workspaces ran for these (`linked_sessions`)
    // and, on any row a send started, who sent it (`sent_from`).
    let linked = db::list_linked_sessions(&st.pool, &ids).await?;
    let senders = sent_from_by_id(&st.pool, sessions.iter().chain(linked.iter().map(|(_, s)| s))).await?;
    let goals = db::live_goal_summaries(&st.pool, &ids).await?;
    let overlay = |s: &db::ChatSession| SessionOverlay {
        running: running.contains(&db::codec::api_uuid(&s.id)),
        needs_input: awaiting.contains(&s.id) || awaiting.contains(&db::codec::api_uuid(&s.id)) || waiting_on_lead.contains(&db::codec::api_uuid(&s.id)),
        background_work: pending.contains(&db::codec::api_uuid(&s.id)),
        goal_status: goals.get(&s.id).map(|g| g.status.clone()),
        goal_turns: goals.get(&s.id).map(|g| (g.turns_used, g.max_turns)),
        sent_from: s.sent_from_session_id.as_ref().and_then(|o| senders.get(o).cloned()),
        ..Default::default()
    };
    let data: Vec<Value> = sessions
        .iter()
        .map(|s| {
            let subs: Vec<Value> = children.iter().filter(|c| c.parent_session_id.as_deref() == Some(s.id.as_str())).map(|c| Value::Object(session_json(c, &overlay(c)))).collect();
            let mut o = overlay(s);
            o.subagents = subs;
            o.linked_sessions = linked.iter().filter(|(root, _)| *root == s.id).map(|(_, l)| Value::Object(session_json(l, &overlay(l)))).collect();
            Value::Object(session_json(s, &o))
        })
        .collect();
    let mut body = json!({"data": data, "next_cursor": next_cursor, "has_more": has_more});
    if let Some(n) = remaining {
        body["remaining"] = json!(n);
    }
    Ok(json(body))
}

/// `sent_from` values for the senders of `sessions`, by sender id (stored
/// form). A sender that is gone has no entry.
pub(super) async fn sent_from_by_id<'a>(pool: &DbPool, sessions: impl Iterator<Item = &'a db::ChatSession>) -> ApiResult<HashMap<String, Value>> {
    let mut ids: Vec<String> = sessions.filter_map(|s| s.sent_from_session_id.clone()).collect();
    ids.sort();
    ids.dedup();
    Ok(db::get_sessions_by_ids(pool, &ids).await?.iter().map(|o| (o.id.clone(), db::api::sent_from_json(o))).collect())
}

/// `session_response` plus, as a v3 addition omitted on Auto, the pinned
/// account's name, so the tray and run chip need no credentials lookup.
pub(super) fn session_json(s: &db::ChatSession, o: &SessionOverlay) -> Map<String, Value> {
    let mut m = session_response(s, o);
    if let Some(label) = s.credential_id.as_deref().and_then(appv3_providers::pool::credential_label_by_id) {
        m.insert("credential_label".into(), Value::String(label));
    }
    m
}

pub(super) async fn resolve_session(State(st): State<AppState>, raw: Bytes) -> ApiResult<Response> {
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
    let credential = opt_str_field(&b, "credential_id")?.filter(|c| !c.trim().is_empty());
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
    // v3 addition: a new session can start pinned to an account.
    let session = match credential.filter(|_| created) {
        Some(cred) => save_run_settings(&st.pool, &session.id.clone(), session, None, None, Some(Some(cred))).await?,
        None => session,
    };
    register_session_workspace(&st.pool, &workspace).await?;
    let mut m = session_json(&session, &SessionOverlay::default());
    m.insert("created".into(), json!(created));
    Ok(json(Value::Object(m)))
}

pub(super) async fn session_detail(State(st): State<AppState>, AxPath(raw): AxPath<String>) -> ApiResult<Response> {
    let sid = path_uuid("session_id", &raw)?;
    let Some(root) = db::get_session(&st.pool, &sid).await? else { return Err(ApiError::not_found("Session not found.")) };
    let (lead, _, _) = db::history_page(&st.pool, &sid, None).await?;
    let pending = manager::find_live_session_serving_session(&sid).and_then(|s| s.pending_interaction_mode());
    let goal = db::live_session_goal(&st.pool, &sid).await?;
    let (goal_status, goal_turns) = (goal.as_ref().map(|g| g.status.clone()), goal.as_ref().map(|g| (g.turns_used, g.max_turns)));
    let sent_from = sent_from_by_id(&st.pool, std::iter::once(&root)).await?.into_values().next();
    let m = session_json(&root, &SessionOverlay { running: store().is_running(&sid), pending_interaction_mode: pending, goal_status, goal_turns, sent_from, ..Default::default() });
    Ok(json_status(StatusCode::OK, &WithMessages { session: m, messages: MessagesView(&lead) }))
}

pub(super) async fn update_session(State(st): State<AppState>, AxPath(raw): AxPath<String>, body: Bytes) -> ApiResult<Response> {
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
    // v3 addition: pin or unpin the session in the sidebar.
    let pinned = match b.get("pinned") {
        None | Some(Value::Null) => None,
        Some(Value::Bool(p)) => Some(*p),
        Some(o) => {
            errs.push(verr("bool_type", &loc(&["body", "pinned"]), "Input should be a valid boolean", o.clone()));
            None
        }
    };
    // v3 additions: the run settings the next message uses, saved as they
    // are chosen. A key that is present sets the field; `null` clears it
    // (the agent's default model or level, or Auto for the credential).
    let mut nullable = |key: &str| -> Option<Option<String>> {
        match b.get(key) {
            None => None,
            Some(Value::Null) => Some(None),
            Some(Value::String(v)) => Some(Some(v.trim().to_string()).filter(|v| !v.is_empty())),
            Some(o) => {
                errs.push(verr("string_type", &loc(&["body", key]), "Input should be a valid string", o.clone()));
                None
            }
        }
    };
    let model = nullable("model");
    let thinking = nullable("thinking_level");
    let credential = nullable("credential_id");
    if !errs.is_empty() {
        return Err(ApiError::validation(errs));
    }
    if title.is_none() && mode.is_none() && pinned.is_none() && model.is_none() && thinking.is_none() && credential.is_none() {
        return Err(value_error("Provide a title, interaction_mode, pinned, model, thinking_level or credential_id.", b));
    }
    if let Some(Some(m)) = &model {
        validate_model_settings(Some(m), None)?;
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
    // Pinning never touches `updated_at`, so it runs first and the other
    // updates below return the row with the new pin.
    let row = match pinned {
        Some(p) => db::set_session_pinned(&st.pool, &sid, p).await?.unwrap_or(row),
        None => row,
    };
    if let Some(live) = live.filter(|l| l.is_busy()) {
        let m = mode.clone().unwrap();
        live.queue_interaction_mode(&m);
        let mut row = row;
        if let Some(t) = clean_title(&title)? {
            row = db::update_session(&st.pool, &sid, db::SessionUpdate::user_title(t)).await?.unwrap_or(row);
        }
        if model.is_some() || thinking.is_some() || credential.is_some() {
            row = save_run_settings(&st.pool, &sid, row, model, thinking, credential).await?;
        }
        let resp = session_json(&row, &SessionOverlay { running: store().is_running(&sid), pending_interaction_mode: Some(m), ..Default::default() });
        return Ok(json(Value::Object(resp)));
    }
    let mut row = row;
    if let Some(t) = clean_title(&title)? {
        row = db::update_session(&st.pool, &sid, db::SessionUpdate::user_title(t)).await?.unwrap_or(row);
    }
    if model.is_some() || thinking.is_some() || credential.is_some() {
        row = save_run_settings(&st.pool, &sid, row, model, thinking, credential).await?;
    }
    if let Some(m) = &mode {
        row = appv3_agent::interaction_mode::set_mode(&st.pool, &sid, m).await?.0;
        // A goal waits in Plan mode; switching to Code starts its next turn.
        if m == "code" && appv3_agent::goal::has_active_goal(&st.pool, &sid).await? {
            resolve_agent_for_existing_session(&st.pool, &sid).await?.goal_after_code_mode(&sid);
        }
    }
    Ok(json(Value::Object(session_json(&row, &SessionOverlay { running: store().is_running(&sid), ..Default::default() }))))
}

/// Store a session's model, thinking level and pinned credential (each
/// `Some` field; `Some(None)` clears it). A pinned credential must be an
/// enabled credential of the session model's provider, from a provider that
/// pools its credentials; changing the model to another provider returns
/// the session to Auto.
pub(super) async fn save_run_settings(
    pool: &DbPool,
    sid: &str,
    row: db::ChatSession,
    model: Option<Option<String>>,
    thinking: Option<Option<String>>,
    credential: Option<Option<String>>,
) -> ApiResult<db::ChatSession> {
    let effective_model = match &model {
        Some(m) => m.clone(),
        None => row.model.clone(),
    };
    let provider_of = |m: &Option<String>| m.as_deref().and_then(|m| m.split_once(':')).map(|(p, _)| p.to_string());
    let mut credential = credential;
    if let Some(Some(id)) = &credential {
        let Some(owner) = appv3_providers::pool::credential_provider(id) else {
            return Err(ApiError::unprocessable("That account or key no longer exists."));
        };
        if provider_of(&effective_model).is_some_and(|p| p != owner) {
            return Err(ApiError::unprocessable("That account or key belongs to another provider than the session's model."));
        }
        if !appv3_providers::pool::pin_usable(&owner, id) {
            return Err(ApiError::unprocessable("That account or key is turned off, or the provider's key comes from the server's environment."));
        }
        // Picking an account is the user forcing it: one cooling after a
        // 429 is tried on the next request instead of being skipped for
        // hours. If it fails again it cools down again and the turn moves on.
        appv3_core::credentials::clear_cooldown(&owner, id);
    } else if credential.is_none() && model.is_some() {
        let pinned_provider = row.credential_id.as_deref().and_then(appv3_providers::pool::credential_provider);
        if pinned_provider.is_some() && pinned_provider != provider_of(&effective_model) {
            credential = Some(None);
        }
    }
    let upd = db::SessionUpdate { model, thinking_level: thinking, credential_id: credential, ..Default::default() };
    Ok(db::update_session(pool, sid, upd).await?.unwrap_or(row))
}

/// `chat_service.delete_session`.
async fn delete_session(pool: &DbPool, session_id: &str) -> ApiResult<bool> {
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
        appv3_agent::side_question::stop_session(sid);
        // Its background commands end with it, before their logs go.
        appv3_agent::background_commands::stop_for_deleted_session(sid).await;
        // A deleted session answers nobody: its senders stop waiting on it.
        appv3_agent::workspace_messages::forget_outstanding_target(sid);
    }
    let pages = appv3_agent::mcp_apps::pages_of(pool, &ids.iter().cloned().collect::<Vec<_>>()).await;
    db::delete_session_rows(pool, session_id).await?;
    if !pages.is_empty() {
        appv3_agent::mcp_apps::remove_unused_pages(pool, Some(pages)).await;
    }
    let s = settings();
    for sid in &ids {
        store().clear(sid);
        appv3_agent::mcp_apps::forget_session(sid);
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

/// `DELETE /sessions/{id}`. With `?remove_worktree=true` (v3 addition), an
/// OpenAgentd worktree the session ran in goes too once nothing else uses
/// it and nothing would be lost; the answer says what happened to it.
pub(super) async fn delete_session_route(State(st): State<AppState>, AxPath(raw): AxPath<String>, q: Qs) -> ApiResult<Response> {
    let sid = path_uuid("session_id", &raw)?;
    let remove_worktree = q.opt("remove_worktree").is_some_and(|v| v == "true" || v == "1");
    let workspace = if remove_worktree { db::get_session(&st.pool, &sid).await?.map(|s| s.workspace).filter(|w| !w.is_empty()) } else { None };
    if !delete_session(&st.pool, &sid).await? {
        return Err(ApiError::not_found("Session not found."));
    }
    if !remove_worktree {
        return Ok(no_content());
    }
    use appv3_agent::worktrees::{remove_if_unused, UnusedWorktree};
    let outcome = match workspace {
        Some(ws) => remove_if_unused(&st.pool, &ws).await.unwrap_or_else(|e| {
            tracing::warn!("worktree_cleanup_failed workspace={ws} err={e}");
            UnusedWorktree::InUse
        }),
        None => UnusedWorktree::InUse,
    };
    Ok(json(match outcome {
        UnusedWorktree::InUse => json!({"deleted": true, "worktree": null}),
        UnusedWorktree::Removed { name } => json!({"deleted": true, "worktree": {"name": name, "removed": true}}),
        UnusedWorktree::Kept { name, reason } => json!({"deleted": true, "worktree": {"name": name, "removed": false, "reason": reason}}),
    }))
}

pub(super) async fn session_subagents(State(st): State<AppState>, AxPath(raw): AxPath<String>) -> ApiResult<Response> {
    let sid = path_uuid("session_id", &raw)?;
    Ok(json(appv3_agent::subagents::list_subagents(&sid, &st.pool).await))
}

/// What a session whose turn ended still waits for (v3 addition): its
/// subagents still running, the sessions in other workspaces that owe it a
/// reply, then its background `shell` commands still running. The same work
/// `background_work` reports as one flag, as rows a person can open. `state`
/// is `working`, `needs_input` (stopped on a question or a plan review) or
/// `idle` (not running: stopped, failed, or not started yet). A command row
/// (`kind: "command"`) carries its `number`, and `waited: false` for one the
/// session does not wait for (a server): listed so it can be seen and
/// stopped, but not counted in `background_work`.
pub(super) async fn session_waiting(State(st): State<AppState>, AxPath(raw): AxPath<String>) -> ApiResult<Response> {
    let sid = path_uuid("session_id", &raw)?;
    let members = appv3_agent::subagents::working_members(&sid);
    let targets = appv3_agent::workspace_messages::outstanding_targets(&sid);
    let ids: Vec<String> = members.iter().map(|(_, id)| id.clone()).chain(targets.iter().cloned()).collect();
    let rows = db::get_sessions_by_ids(&st.pool, &ids).await?;
    let row = |id: &str| rows.iter().find(|r| db::codec::api_uuid(&r.id) == id);
    let title = |id: &str| row(id).and_then(|r| r.title.clone()).filter(|t| !t.trim().is_empty());
    let mut items: Vec<Value> = members
        .iter()
        .map(|(handle, id)| json!({"kind": "subagent", "session_id": id, "title": title(id).unwrap_or_else(|| handle.clone()), "label": handle, "workspace": "", "state": "working"}))
        .collect();
    if !targets.is_empty() {
        let running = running_set();
        let awaiting = db::sessions_awaiting_input(&st.pool).await?;
        for id in &targets {
            let Some(r) = row(id) else { continue };
            let state = if awaiting.contains(&r.id) || awaiting.contains(id) {
                "needs_input"
            } else if running.contains(id) || appv3_agent::subagents::has_pending_work(id) {
                "working"
            } else {
                "idle"
            };
            let label = appv3_agent::workspace_messages::workspace_name(&st.pool, &r.workspace).await;
            items.push(json!({"kind": "session", "session_id": id, "title": title(id), "label": label, "workspace": r.workspace, "state": state}));
        }
    }
    items.extend(appv3_agent::background_commands::running(&sid).iter().map(|c| {
        let title = Some(appv3_agent::background_commands::shown(&c.description)).filter(|d| !d.is_empty());
        json!({"kind": "command", "session_id": sid, "number": c.number, "title": title, "label": appv3_agent::background_commands::shown(&c.command), "workspace": "", "state": "working", "waited": c.wait, "started_at": c.started_at})
    }));
    Ok(json(json!({"items": items})))
}

/// `POST /sessions/{id}/commands/{number}/stop` (v3 addition): the user
/// stops one background command from the session's waiting list. The agent
/// is told it was stopped.
pub(super) async fn stop_command(AxPath((raw, number)): AxPath<(String, String)>) -> ApiResult<Response> {
    let sid = path_uuid("session_id", &raw)?;
    let number: u64 = number.parse().map_err(|_| ApiError::unprocessable("Invalid command number."))?;
    if !appv3_agent::background_commands::stop(&sid, number).await {
        return Err(ApiError::not_found("The command is not running."));
    }
    Ok(no_content())
}
