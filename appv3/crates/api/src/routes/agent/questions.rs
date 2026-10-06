//! `questions.py`, `todos.py`, `permissions.py`, and the v3 session plan.

use super::helpers::get_or_start;
use crate::error::{loc, verr, ApiError, ApiResult};
use crate::util::*;
use crate::AppState;
use appv3_agent::plan::{self, PlanDoc, PlanError, ReviewDecision};
use appv3_agent::{broadcaster, events, manager, store, Envelope};
use appv3_db::{self as db, DbPool};
use axum::extract::{Path as AxPath, State};
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use bytes::Bytes;
use serde_json::{json, Value};

pub const MAX_ANSWER_CHARS: usize = 2000;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/{session_id}/question", get(get_question))
        .route("/{session_id}/question/{question_id}/answer", post(answer))
        .route("/{session_id}/question/{question_id}/dismiss", post(dismiss))
        .route("/sessions/{session_id}/todos", get(todos))
        .route("/sessions/{session_id}/plan", get(get_plan).put(put_plan).delete(delete_plan))
        .route("/{session_id}/permissions", get(list_permissions))
        .route("/{session_id}/permissions/{request_id}/reply", post(reply_permission))
}

async fn get_question(State(st): State<AppState>, AxPath(raw): AxPath<String>) -> ApiResult<Response> {
    let sid = path_uuid("session_id", &raw)?;
    let q = db::get_pending_question(&st.pool, &sid).await?;
    Ok(json(json!({"question": q.map(|q| db::api::pending_question_response(&q))})))
}

async fn open_question(pool: &DbPool, sid: &str, qid: &str) -> ApiResult<db::PendingQuestion> {
    let row = db::get_pending_question(pool, sid).await?;
    match row {
        None => Err(ApiError::new(409, "Question is not open.")),
        Some(r) if db::codec::api_uuid(&r.id) != qid => Err(ApiError::new(404, "Question is not open.")),
        Some(r) => Ok(r),
    }
}

fn parse_answers(b: &Value) -> ApiResult<Vec<Vec<String>>> {
    let Some(v) = b.get("answers") else { return Err(ApiError::validation(vec![verr("missing", &loc(&["body", "answers"]), "Field required", b.clone())])) };
    let Some(groups) = v.as_array() else { return Err(ApiError::validation(vec![verr("list_type", &loc(&["body", "answers"]), "Input should be a valid list", v.clone())])) };
    let mut out = vec![];
    let mut errs = vec![];
    for (i, g) in groups.iter().enumerate() {
        match g.as_array() {
            None => errs.push(verr("list_type", &[json!("body"), json!("answers"), json!(i)], "Input should be a valid list", g.clone())),
            Some(items) => {
                let mut grp = vec![];
                for (j, it) in items.iter().enumerate() {
                    match it.as_str() {
                        Some(s) => grp.push(s.to_string()),
                        None => errs.push(verr("string_type", &[json!("body"), json!("answers"), json!(i), json!(j)], "Input should be a valid string", it.clone())),
                    }
                }
                out.push(grp);
            }
        }
    }
    if !errs.is_empty() {
        return Err(ApiError::validation(errs));
    }
    Ok(out)
}

fn validate_answers(questions: &[Value], answers: &[Vec<String>], max_chars: usize) -> ApiResult<()> {
    if answers.len() > questions.len() {
        return Err(ApiError::unprocessable(format!("Expected at most {} answer groups, got {}.", questions.len(), answers.len())));
    }
    for (i, selected) in answers.iter().enumerate() {
        let q = &questions[i];
        let mut labels: Vec<String> = vec![];
        for o in q.get("options").and_then(|o| o.as_array()).into_iter().flatten() {
            let l = match o.get("label") {
                Some(Value::String(s)) => s.clone(),
                Some(other) => appv3_agent::pystr::py_str(other),
                None => String::new(),
            };
            if !labels.contains(&l) {
                labels.push(l);
            }
        }
        if selected.len() > 1 && q.get("multiple") != Some(&Value::Bool(true)) {
            return Err(ApiError::unprocessable(format!("Question {i} accepts a single answer.")));
        }
        // Every question also takes one typed answer, including rows stored
        // with `custom: false` before that was unconditional.
        let max = labels.len() + 1;
        if selected.len() > max {
            return Err(ApiError::unprocessable(format!("Question {i} accepts at most {max} answers.")));
        }
        for v in selected {
            if v.chars().count() > max_chars {
                return Err(ApiError::unprocessable(format!("Answer to question {i} exceeds {max_chars} characters.")));
            }
        }
    }
    Ok(())
}

fn end_turn(sid: &str) {
    store().push_event(sid, &Envelope::from_parts("done", json!({})), false);
    store().mark_done(sid);
    broadcaster::publish("session_turn_completed", json!({"session_id": sid, "status": "completed"}));
}

async fn resume_agent(pool: &DbPool, sid: &str) -> bool {
    let agent = match manager::find_live_session_serving_session(sid) {
        Some(a) => a,
        None => {
            let row = match db::get_session(pool, sid).await {
                Ok(Some(r)) => r,
                _ => {
                    tracing::warn!("question_resume_session_not_resumable session_id={}", sid);
                    return false;
                }
            };
            if row.workspace.is_empty() {
                tracing::warn!("question_resume_session_not_resumable session_id={} workspace=None", sid);
                return false;
            }
            match get_or_start(&row.workspace, Some(sid)).await {
                Ok(Some(a)) => a,
                _ => {
                    tracing::warn!("question_resume_no_live_agent session_id={}", sid);
                    return false;
                }
            }
        }
    };
    if agent.session_id() != sid {
        if agent.is_busy() {
            tracing::warn!("question_resume_agent_busy_elsewhere session_id={} current_sid={}", sid, agent.session_id());
            return false;
        }
        if agent.attach_to_session(sid, None).await.is_err() {
            return false;
        }
    }
    agent.resume_after_question_answer().await;
    true
}

async fn answer(State(st): State<AppState>, AxPath((sid_raw, qid_raw)): AxPath<(String, String)>, body: Bytes) -> ApiResult<Response> {
    let sid = path_uuid("session_id", &sid_raw)?;
    let qid = path_uuid("question_id", &qid_raw)?;
    let b = body_value(&body)?;
    let answers = parse_answers(&b)?;
    let row = open_question(&st.pool, &sid, &qid).await?;
    if row.kind().as_deref() == Some(plan::PLAN_REVIEW_KIND) {
        return answer_plan_review(&st.pool, &sid, &qid, &row, &answers).await;
    }
    validate_answers(&row.questions(), &answers, MAX_ANSWER_CHARS)?;
    let av = json!(answers);
    if db::resolve_pending_question(&st.pool, &qid, "answered", Some(&av)).await?.is_none() {
        return Err(ApiError::conflict("Question already resolved."));
    }
    store().push_event(&sid, &events::question_answered(&qid, &sid, &av), true);
    let resumed = resume_agent(&st.pool, &sid).await;
    if !resumed {
        end_turn(&sid);
    }
    tracing::info!("question_answered session_id={} question_id={} resumed={}", sid, qid, resumed);
    Ok(json(json!({"status": "ok", "resumed": resumed})))
}

/// Close a plan review. Approval switches a Plan-mode session to Code mode
/// before the turn resumes, so the resumed turn implements with full tool
/// access.
async fn answer_plan_review(pool: &DbPool, sid: &str, qid: &str, row: &db::PendingQuestion, answers: &[Vec<String>]) -> ApiResult<Response> {
    validate_answers(&row.questions(), answers, plan::PLAN_REVIEW_MAX_ANSWER_CHARS)?;
    let decision = plan::review_decision(answers).map_err(ApiError::unprocessable)?;
    let live = manager::find_live_session_serving_session(sid);
    if decision == ReviewDecision::Approve && db::get_session(pool, sid).await?.is_some_and(|s| s.interaction_mode == "plan") {
        // A toggle queued during the review would undo the approval's switch
        // when the resumed turn ends. A Code-mode approval switches nothing,
        // so a queued toggle still applies when that turn ends.
        if let Some(a) = &live {
            a.clear_pending_interaction_mode();
        }
    }
    let av = json!(answers);
    let Some(outcome) = plan::resolve_review(pool, sid, row, &decision, &av).await? else {
        return Err(ApiError::conflict("Question already resolved."));
    };
    store().push_event(sid, &events::question_answered(qid, sid, &av), true);
    if outcome.mode_changed {
        store().push_event(sid, &events::interaction_mode(&live.as_ref().map(|a| a.name()).unwrap_or_default(), "code"), true);
    }
    let resumed = resume_agent(pool, sid).await;
    if !resumed {
        end_turn(sid);
    }
    tracing::info!("plan_review_answered session_id={} question_id={} approved={} resumed={}", sid, qid, outcome.approved, resumed);
    Ok(json(json!({"status": "ok", "resumed": resumed})))
}

async fn dismiss(State(st): State<AppState>, AxPath((sid_raw, qid_raw)): AxPath<(String, String)>) -> ApiResult<Response> {
    let sid = path_uuid("session_id", &sid_raw)?;
    let qid = path_uuid("question_id", &qid_raw)?;
    open_question(&st.pool, &sid, &qid).await?;
    if db::resolve_pending_question(&st.pool, &qid, "dismissed", None).await?.is_none() {
        return Err(ApiError::conflict("Question already resolved."));
    }
    store().push_event(&sid, &events::question_dismissed(&qid, &sid, "dismissed"), true);
    let handled = match manager::find_live_session_serving_session(&sid) {
        Some(a) => a.end_turn_after_question_dismissed(&sid).await,
        None => false,
    };
    if !handled {
        end_turn(&sid);
    }
    tracing::info!("question_dismissed_by_user session_id={} question_id={}", sid, qid);
    Ok(json(json!({"status": "ok", "resumed": false})))
}

async fn todos(AxPath(sid): AxPath<String>) -> ApiResult<Response> {
    if py_uuid(&sid).is_none() {
        return Err(ApiError::bad_request("Invalid session id."));
    }
    let path = appv3_tools::todo::todos_path(&appv3_tools::denied::session_artifacts_dir(Some(&sid)));
    if !path.exists() {
        return Ok(json(json!({"todos": []})));
    }
    let parsed = || -> Option<Vec<Value>> {
        let data: Value = serde_json::from_str(&std::fs::read_to_string(&path).ok()?).ok()?;
        let items = data.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let mut out = vec![];
        for it in items.iter().filter(|i| i.is_object()) {
            let f = |k: &str| it.get(k).and_then(|v| v.as_str()).map(String::from);
            out.push(json!({"task_id": f("task_id")?, "content": f("content")?, "status": f("status")?}));
        }
        Some(out)
    };
    Ok(json(json!({"todos": parsed().unwrap_or_default()})))
}

fn plan_json(doc: &PlanDoc) -> Value {
    json!({
        "content": doc.content,
        "updated_at": doc.updated_at.to_rfc3339(),
        "revision": doc.revision,
        "approved_revision": doc.approved_revision,
        "path": doc.path.display().to_string(),
        "workspace_path": doc.workspace_path(),
    })
}

/// The session plan (`appv3_agent::plan`), with outside edits folded into
/// its revision; v2 has no such route.
async fn get_plan(AxPath(sid): AxPath<String>) -> ApiResult<Response> {
    if py_uuid(&sid).is_none() {
        return Err(ApiError::bad_request("Invalid session id."));
    }
    let dir = appv3_tools::denied::session_artifacts_dir(Some(&sid));
    Ok(json(json!({"plan": plan::sync(&dir).as_ref().map(plan_json)})))
}

/// Save the user's edit from the Plan panel; `base_revision` is the
/// revision they opened. The agent is told on its next turn or in the
/// review result.
async fn put_plan(AxPath(sid): AxPath<String>, body: Bytes) -> ApiResult<Response> {
    if py_uuid(&sid).is_none() {
        return Err(ApiError::bad_request("Invalid session id."));
    }
    let b = body_value(&body)?;
    let content = match b.get("content") {
        Some(Value::String(s)) => s.clone(),
        None => return Err(ApiError::validation(vec![verr("missing", &loc(&["body", "content"]), "Field required", b.clone())])),
        Some(o) => return Err(ApiError::validation(vec![verr("string_type", &loc(&["body", "content"]), "Input should be a valid string", o.clone())])),
    };
    let base_revision = match b.get("base_revision") {
        Some(v) if v.as_u64().is_some() => v.as_u64().unwrap_or_default(),
        None => return Err(ApiError::validation(vec![verr("missing", &loc(&["body", "base_revision"]), "Field required", b.clone())])),
        Some(o) => return Err(ApiError::validation(vec![verr("int_type", &loc(&["body", "base_revision"]), "Input should be a valid integer", o.clone())])),
    };
    let dir = appv3_tools::denied::session_artifacts_dir(Some(&sid));
    match plan::save_user(&dir, &content, base_revision) {
        Ok(doc) => {
            tracing::info!("plan_saved_by_user session_id={} revision={}", sid, doc.revision);
            Ok(json(json!({"plan": plan_json(&doc)})))
        }
        Err(PlanError::NoPlan) => Err(ApiError::not_found("No plan to edit.")),
        Err(e @ PlanError::Conflict) => Err(ApiError::conflict(e.to_string())),
        Err(e @ (PlanError::Empty | PlanError::TooLong)) => Err(ApiError::unprocessable(e.to_string())),
        Err(e @ (PlanError::Escapes | PlanError::Denied(_))) => Err(ApiError::new(403, e.to_string())),
        Err(e) => Err(ApiError::new(500, e.to_string())),
    }
}

/// Stop using the plan in this session. A workspace plan file stays; it is
/// the user's.
async fn delete_plan(State(st): State<AppState>, AxPath(sid): AxPath<String>) -> ApiResult<Response> {
    if py_uuid(&sid).is_none() {
        return Err(ApiError::bad_request("Invalid session id."));
    }
    if db::get_pending_question(&st.pool, &sid).await?.is_some_and(|q| q.kind().as_deref() == Some(plan::PLAN_REVIEW_KIND)) {
        return Err(ApiError::conflict("The plan is awaiting review."));
    }
    let deleted = plan::detach(&appv3_tools::denied::session_artifacts_dir(Some(&sid)))?;
    Ok(json(json!({"deleted": deleted})))
}

/// The v2 route sees the process-default `AutoAllowPermissionService`
/// (session `"default"`), which never holds pending requests.
async fn list_permissions(AxPath(_sid): AxPath<String>) -> Response {
    json(json!({"permissions": []}))
}

async fn reply_permission(AxPath((_sid, rid)): AxPath<(String, String)>, body: Bytes) -> ApiResult<Response> {
    let b = body_value(&body)?;
    let reply = match b.get("reply") {
        Some(Value::String(s)) => s.clone(),
        None => return Err(ApiError::validation(vec![verr("missing", &loc(&["body", "reply"]), "Field required", b.clone())])),
        Some(o) => return Err(ApiError::validation(vec![verr("string_type", &loc(&["body", "reply"]), "Input should be a valid string", o.clone())])),
    };
    opt_str_field(&b, "message")?;
    if !["once", "always", "reject"].contains(&reply.as_str()) {
        return Err(ApiError::unprocessable(format!("Invalid reply '{reply}'. Must be one of: ['always', 'once', 'reject']")));
    }
    Err(ApiError::not_found(format!("Permission request '{rid}' not found or already resolved.")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answer_rules() {
        let qs = vec![json!({"question": "q", "options": [{"label": "A"}, {"label": "B"}], "custom": false})];
        let check = |a: &[Vec<String>]| validate_answers(&qs, a, MAX_ANSWER_CHARS);
        assert!(check(&[vec!["A".into()]]).is_ok());
        assert_eq!(check(&[vec!["A".into(), "B".into()]]).unwrap_err().detail, json!("Question 0 accepts a single answer."));
        assert_eq!(check(&[vec![], vec![]]).unwrap_err().detail, json!("Expected at most 1 answer groups, got 2."));

        // Plan-review feedback may be longer than an `ask_user` answer.
        let review = appv3_agent::tools::plan::review_payload(1, None, true)["questions"].as_array().unwrap().clone();
        let long = vec![vec!["x".repeat(MAX_ANSWER_CHARS + 1)]];
        assert!(validate_answers(&review, &long, MAX_ANSWER_CHARS).is_err());
        assert!(validate_answers(&review, &long, plan::PLAN_REVIEW_MAX_ANSWER_CHARS).is_ok());
        let too_long = vec![vec!["x".repeat(plan::PLAN_REVIEW_MAX_ANSWER_CHARS + 1)]];
        assert_eq!(validate_answers(&review, &too_long, plan::PLAN_REVIEW_MAX_ANSWER_CHARS).unwrap_err().detail, json!("Answer to question 0 exceeds 8000 characters."));
    }

    // Every question takes a typed answer, including rows stored before that
    // was unconditional (`custom: false`): the client always offers one.
    #[test]
    fn typed_answers_are_accepted_even_where_a_stored_question_said_custom_false() {
        let qs = vec![json!({"question": "q", "options": [{"label": "A"}, {"label": "B"}], "multiple": true, "custom": false})];
        let check = |a: &[Vec<String>]| validate_answers(&qs, a, MAX_ANSWER_CHARS);
        assert!(check(&[vec!["Z".into()]]).is_ok());
        assert!(check(&[vec!["A".into(), "B".into(), "Z".into()]]).is_ok());
        assert_eq!(check(&[vec!["A".into(), "B".into(), "Y".into(), "Z".into()]]).unwrap_err().detail, json!("Question 0 accepts at most 3 answers."));
    }
}
