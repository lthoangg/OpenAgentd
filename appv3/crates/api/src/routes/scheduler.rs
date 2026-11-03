//! Scheduler routes.

use crate::error::{loc, verr, ApiError, ApiResult};
use crate::util::*;
use crate::AppState;
use appv3_agent::scheduler::{scheduler, SchedulerError, TaskCreate, TaskUpdate};
use appv3_db::api::scheduled_task_response;
use axum::extract::Path as AxPath;
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use bytes::Bytes;
use serde_json::{json, Value};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/tasks", get(list).post(create))
        .route("/tasks/{slug}", get(get_task).put(update).delete(delete_task))
        .route("/tasks/{slug}/pause", post(pause))
        .route("/tasks/{slug}/resume", post(resume))
        .route("/tasks/{slug}/trigger", post(trigger))
}

fn nf() -> ApiError {
    ApiError::not_found("Scheduled task not found.")
}

fn errs_to_api(errs: Vec<(String, String)>, input: &Value) -> ApiError {
    ApiError::validation(
        errs.into_iter()
            .map(|(l, m)| {
                let kind = if m.starts_with("Value error") {
                    "value_error"
                } else if m.contains("greater than") {
                    "greater_than"
                } else {
                    "string_too_short"
                };
                let lv = if l.is_empty() { loc(&["body"]) } else { loc(&["body", &l]) };
                verr(kind, &lv, &m, input.get(&l).cloned().unwrap_or_else(|| input.clone()))
            })
            .collect(),
    )
}

fn req_string(b: &Value, k: &str, errs: &mut Vec<Value>) -> String {
    match b.get(k) {
        Some(Value::String(s)) => s.clone(),
        None => {
            errs.push(verr("missing", &loc(&["body", k]), "Field required", b.clone()));
            String::new()
        }
        Some(o) => {
            errs.push(verr("string_type", &loc(&["body", k]), "Input should be a valid string", o.clone()));
            String::new()
        }
    }
}

fn opt_dt(b: &Value, k: &str) -> ApiResult<Option<chrono::DateTime<chrono::Utc>>> {
    match b.get(k) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => appv3_db::codec::parse_dt(s).map(Some).ok_or_else(|| {
            ApiError::validation(vec![verr("datetime_from_date_parsing", &loc(&["body", k]), "Input should be a valid datetime or date, invalid character in year", json!(s))])
        }),
        Some(o) => Err(ApiError::validation(vec![verr("datetime_type", &loc(&["body", k]), "Input should be a valid datetime", o.clone())])),
    }
}

fn sched_err(e: SchedulerError, name: Option<&str>) -> ApiError {
    match e {
        SchedulerError::NotFound(_) => nf(),
        SchedulerError::InvalidTarget(m) => ApiError::unprocessable(m),
        SchedulerError::Other(err) => {
            let msg = format!("{err:#}");
            if msg.contains("UNIQUE constraint failed") {
                if let Some(n) = name {
                    return ApiError::conflict(format!("A task named '{n}' already exists."));
                }
            }
            ApiError::internal(msg)
        }
    }
}

async fn create(raw: Bytes) -> ApiResult<Response> {
    let b = body_value(&raw)?;
    let mut errs = vec![];
    let name = req_string(&b, "name", &mut errs);
    let workspace = req_string(&b, "workspace", &mut errs);
    let schedule_type = req_string(&b, "schedule_type", &mut errs);
    let prompt = req_string(&b, "prompt", &mut errs);
    if !errs.is_empty() {
        return Err(ApiError::validation(errs));
    }
    let mut body = TaskCreate {
        name: name.clone(),
        slug: opt_str_field(&b, "slug")?,
        workspace,
        schedule_type,
        at_datetime: opt_dt(&b, "at_datetime")?,
        every_seconds: opt_int_field(&b, "every_seconds")?,
        cron_expression: opt_str_field(&b, "cron_expression")?,
        timezone: opt_str_field(&b, "timezone")?.unwrap_or_else(|| "UTC".into()),
        prompt,
        session_id: opt_str_field(&b, "session_id")?,
        max_runs: opt_int_field(&b, "max_runs")?,
        enabled: opt_bool_field(&b, "enabled")?.unwrap_or(true),
    };
    body.validate().map_err(|e| errs_to_api(e, &b))?;
    let saved = scheduler().create(body).await.map_err(|e| sched_err(e, Some(&name)))?;
    Ok(json_code(201, scheduled_task_response(&saved)))
}

async fn list() -> ApiResult<Response> {
    let tasks = scheduler().list_tasks().await?;
    Ok(json(json!({"tasks": tasks.iter().map(scheduled_task_response).collect::<Vec<_>>()})))
}

async fn get_task(AxPath(slug): AxPath<String>) -> ApiResult<Response> {
    let t = scheduler().get_task(&slug).await?.ok_or_else(nf)?;
    Ok(json(scheduled_task_response(&t)))
}

async fn update(AxPath(slug): AxPath<String>, raw: Bytes) -> ApiResult<Response> {
    let b = body_value(&raw)?;
    if !b.is_object() {
        return Err(ApiError::validation(vec![verr("model_attributes_type", &loc(&["body"]), "Input should be a valid dictionary or object to extract fields from", b)]));
    }
    let mut body = TaskUpdate {
        slug: opt_str_field(&b, "slug")?,
        workspace: opt_str_field(&b, "workspace")?,
        schedule_type: opt_str_field(&b, "schedule_type")?,
        at_datetime: opt_dt(&b, "at_datetime")?,
        every_seconds: opt_int_field(&b, "every_seconds")?,
        cron_expression: opt_str_field(&b, "cron_expression")?,
        timezone: opt_str_field(&b, "timezone")?,
        prompt: opt_str_field(&b, "prompt")?,
        session_id: opt_str_field(&b, "session_id")?,
        max_runs: opt_int_field(&b, "max_runs")?,
        max_runs_set: b.get("max_runs").is_some(),
        enabled: opt_bool_field(&b, "enabled")?,
    };
    body.validate().map_err(|e| errs_to_api(e, &b))?;
    let t = scheduler().apply_update(&slug, body).await.map_err(|e| sched_err(e, None))?;
    Ok(json(scheduled_task_response(&t)))
}

async fn delete_task(AxPath(slug): AxPath<String>) -> ApiResult<Response> {
    scheduler().get_task(&slug).await?.ok_or_else(nf)?;
    scheduler().remove(&slug).await?;
    Ok(no_content())
}

async fn pause(AxPath(slug): AxPath<String>) -> ApiResult<Response> {
    scheduler().get_task(&slug).await?.ok_or_else(nf)?;
    Ok(json(scheduled_task_response(&scheduler().pause(&slug).await?)))
}

async fn resume(AxPath(slug): AxPath<String>) -> ApiResult<Response> {
    scheduler().get_task(&slug).await?.ok_or_else(nf)?;
    Ok(json(scheduled_task_response(&scheduler().resume(&slug).await?)))
}

async fn trigger(AxPath(slug): AxPath<String>) -> ApiResult<Response> {
    scheduler().get_task(&slug).await?.ok_or_else(nf)?;
    scheduler().trigger(&slug).await?;
    Ok(json_code(202, json!({"status": "dispatched"})))
}
