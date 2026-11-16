//! A session's history: its pages (newest, older and `since` deltas) with
//! the members and usage that ride along, and the tool outputs and
//! arguments history leaves out until a card is opened.

use super::super::helpers::*;
use super::sessions::{sent_from_by_id, session_json};
use crate::error::{ApiError, ApiResult};
use crate::middleware::Peer;
use crate::util::*;
use crate::AppState;
use appv3_agent::{manager, store};
use appv3_db::api::{MessageView, MessagesView, SessionOverlay};
use appv3_db::{self as db, DbPool};
use axum::extract::{Path as AxPath, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde::Serialize;
use serde_json::{json, Map, Value};

/// A tool call's output, which history and the live feed leave out for most
/// tools (`appv3_db::api::result_rides_inline`): fetched when the user opens
/// the call. Looks in the session and the sessions under it.
pub(super) async fn tool_result(State(st): State<AppState>, AxPath((raw, tool_call_id)): AxPath<(String, String)>) -> ApiResult<Response> {
    let sid = path_uuid("session_id", &raw)?;
    let Some(row) = db::find_tool_message_in_tree(&st.pool, &sid, &tool_call_id).await? else {
        return Err(ApiError::not_found("Tool result not found."));
    };
    Ok(json(json!({"tool_call_id": tool_call_id, "name": row.name, "content": row.content.unwrap_or_default()})))
}

/// A tool call's full arguments, which history sends short for a few tools
/// (`appv3_db::tool_args`); the card fetches them when the user opens it.
pub(super) async fn tool_call_arguments(State(st): State<AppState>, AxPath((raw, tool_call_id)): AxPath<(String, String)>) -> ApiResult<Response> {
    let sid = path_uuid("session_id", &raw)?;
    let Some((name, arguments)) = db::find_tool_call_in_tree(&st.pool, &sid, &tool_call_id).await? else {
        return Err(ApiError::not_found("Tool call not found."));
    };
    Ok(json(json!({"tool_call_id": tool_call_id, "name": name, "arguments": arguments})))
}

async fn ensure_agent_ready(root: &db::ChatSession) -> ApiResult<()> {
    if !root.workspace.is_empty() && root.parent_session_id.is_none() {
        // A session whose folder was moved or deleted stays readable: its
        // history lives in the database, only a new turn needs the folder.
        if manager::validate_workspace(&root.workspace, false).is_ok_and(|p| !std::path::Path::new(&p).is_dir()) {
            return Ok(());
        }
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
pub(super) struct WithMessages<'a> {
    #[serde(flatten)]
    pub(super) session: Map<String, Value>,
    pub(super) messages: MessagesView<'a>,
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
    /// First page only, and only when the run since the latest prompt is
    /// longer than the page: that prompt, for the client to pin above it.
    #[serde(skip_serializing_if = "Option::is_none")]
    latest_prompt: Option<MessageView<'a>>,
}

/// A member as the lead's history shows it: who, whether it works, and its
/// usage. Its rows stay out (`messages` is empty, kept for older clients):
/// the lead's view never renders them, and opening a member loads its own
/// session.
fn member_part(statuses: &[(String, String)], sub: &db::ChatSession, totals: &UsageTotals) -> MemberPart<'static> {
    let name = sub.agent_name.clone().unwrap_or_else(|| db::codec::api_uuid(&sub.id));
    let (cost, completion) = totals.get(&sub.id).copied().unwrap_or((0.0, 0));
    let running = statuses.iter().any(|(n, s)| *n == name && s == "working");
    MemberPart { name, session_id: db::codec::api_uuid(&sub.id), messages: MessagesView(&[]), running, estimated_cost_usd: cost, completion_tokens: completion }
}

/// The lead's part of a history response. `totals` is `None` on older pages:
/// the totals cover the whole session, and only the newest page and the
/// delta carry them (the client ignores them anywhere else).
/// `sent_from`: who started this session from another workspace, for the
/// chat view's "handled by" strip (the newest page and the delta carry it).
fn lead_part<'a>(root: &db::ChatSession, msgs: &'a [db::SessionMessage], totals: Option<&UsageTotals>, sent_from: Option<Value>) -> WithMessages<'a> {
    let effective = root.agent_name.clone().unwrap_or_else(|| if root.parent_session_id.is_none() { "code".into() } else { "member".into() });
    let usage = totals.map(|t| t.get(&root.id).copied().unwrap_or((0.0, 0)));
    let rid = db::codec::api_uuid(&root.id);
    let session = session_json(
        root,
        &SessionOverlay {
            agent_name: Some(effective),
            running: store().is_running(&rid),
            estimated_cost_usd: usage.map(|(cost, _)| cost),
            completion_tokens: usage.map(|(_, completion)| completion),
            sent_from,
            ..Default::default()
        },
    );
    WithMessages { session, messages: MessagesView(msgs) }
}

/// The `sent_from` of `root`, when another workspace's send started it.
async fn sender_of(pool: &DbPool, root: &db::ChatSession) -> ApiResult<Option<Value>> {
    if root.sent_from_session_id.is_none() {
        return Ok(None);
    }
    Ok(sent_from_by_id(pool, std::iter::once(root)).await?.into_values().next())
}

/// Usage totals for the lead and its members in one scan.
async fn usage_totals(pool: &DbPool, root: &db::ChatSession, subs: &[db::ChatSession]) -> ApiResult<UsageTotals> {
    let ids: Vec<&str> = std::iter::once(root.id.as_str()).chain(subs.iter().map(|s| s.id.as_str())).collect();
    Ok(db::session_usage_totals_many(pool, &ids).await?)
}

/// Every page carries an `ETag`: a client reopening a session that has not
/// changed gets `304` and no body (a newest page can run to megabytes).
pub(super) async fn agent_history(st: State<AppState>, raw: AxPath<String>, q: Qs, headers: axum::http::HeaderMap, peer: Option<axum::Extension<Peer>>) -> ApiResult<Response> {
    let started = std::time::Instant::now();
    let page = if q.opt("since").is_some() {
        "since"
    } else if q.opt("before").is_some() {
        "older"
    } else {
        "newest"
    };
    let session = raw.0.clone();
    let res = etagged(&headers, agent_history_page(st, raw, q).await).await;
    let (status, bytes) = match &res {
        Ok(r) => (r.status().as_u16(), axum::body::HttpBody::size_hint(r.body()).exact().unwrap_or(0)),
        Err(_) => (0, 0),
    };
    let remote = peer.is_some_and(|p| p.0.remote());
    tracing::info!("history_page_served session_id={} page={} status={} bytes={} remote={} elapsed_ms={}", session, page, status, bytes, remote, started.elapsed().as_millis());
    res
}

/// Bytes of a page's rows by what they hold, to see what makes a history
/// page heavy (logged as `history_page_breakdown`).
#[derive(Default, Debug, PartialEq)]
struct RowBytes {
    content: usize,
    reasoning: usize,
    tool_args: usize,
    tool_results: usize,
    extra: usize,
}

impl RowBytes {
    fn add(&mut self, rows: &[db::SessionMessage]) {
        let len = |s: &Option<String>| s.as_ref().map_or(0, String::len);
        for r in rows {
            if r.role == "tool" {
                // Only what goes out: most tools' output is fetched on demand.
                if let (Some(name), Some(text)) = (r.name.as_deref(), r.content.as_deref()) {
                    if appv3_db::api::result_rides_inline(name, text) {
                        self.tool_results += text.len();
                    }
                }
            } else {
                self.content += len(&r.content);
            }
            self.reasoning += len(&r.reasoning_content);
            self.tool_args += appv3_db::api::display_tool_calls_len(r.tool_calls.as_deref());
            self.extra += appv3_db::api::display_extra_len(r.extra.as_deref());
        }
    }
}

fn log_page_breakdown(sid: &str, lead: &[db::SessionMessage]) {
    let mut l = RowBytes::default();
    l.add(lead);
    tracing::info!(
        "history_page_breakdown session_id={} rows={} content={} reasoning={} tool_args={} tool_results={} extra={}",
        sid,
        lead.len(),
        l.content,
        l.reasoning,
        l.tool_args,
        l.tool_results,
        l.extra,
    );
}

async fn agent_history_page(State(st): State<AppState>, AxPath(raw): AxPath<String>, q: Qs) -> ApiResult<Response> {
    let sid = path_uuid("session_id", &raw)?;
    let before = q.opt("before");
    let since = q.opt("since");
    if before.is_some() && since.is_some() {
        return Err(ApiError::unprocessable("Pass either 'before' or 'since', not both."));
    }
    let pool = &st.pool;
    if let Some(since) = since {
        let since_id = py_uuid(&since).ok_or_else(|| ApiError::unprocessable(format!("Invalid since cursor: {since}")))?;
        let Some(root) = db::get_session(pool, &sid).await? else { return Err(ApiError::not_found("The main agent's session was not found.")) };
        const LIMIT: i64 = 100;
        let (lead_rows, truncated) = db::history_since(pool, &sid, &since_id, LIMIT).await?;
        let subs = db::list_child_sessions(pool, std::slice::from_ref(&sid)).await?;
        ensure_agent_ready(&root).await?;
        let totals = usage_totals(pool, &root, &subs).await?;
        let statuses = store().get_agent_statuses(&sid);
        let lead = lead_part(&root, &lead_rows, Some(&totals), sender_of(pool, &root).await?);
        let members = subs.iter().map(|sub| member_part(&statuses, sub, &totals)).collect();
        return Ok(json_status(StatusCode::OK, &HistoryBody { lead, members, has_more: false, next_cursor: None, truncated, pending_question: None, latest_prompt: None }));
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
    let Some(root) = db::get_session(pool, &sid).await? else { return Err(ApiError::not_found("The main agent's session was not found.")) };
    if !first_page {
        let ((rows, has_more, boundary), ()) =
            futures::future::try_join(async { Ok::<_, ApiError>(db::history_page(pool, &sid, cursor.clone()).await?) }, ensure_agent_ready(&root)).await?;
        let next_cursor = boundary.map(|b| format!("{}|{}", b.seq, db::codec::api_uuid(&b.id)));
        let lead = lead_part(&root, &rows, None, None);
        return Ok(json_status(StatusCode::OK, &HistoryBody { lead, members: vec![], has_more, next_cursor, truncated: false, pending_question: None, latest_prompt: None }));
    }
    // The newest page reaches back to the latest prompt (see
    // `first_history_page`). Its reads are independent, so they run at once:
    // the lead's page, the agent's start, the members with their usage, and
    // the open question. Members come without rows (`member_part`).
    let members = async {
        let subs = db::list_child_sessions(pool, std::slice::from_ref(&sid)).await?;
        let totals = db::session_usage_totals_many(pool, &std::iter::once(root.id.as_str()).chain(subs.iter().map(|s| s.id.as_str())).collect::<Vec<_>>()).await?;
        Ok::<_, ApiError>((subs, totals))
    };
    let (page, (), (subs, totals), pending) =
        futures::future::try_join4(async { Ok::<_, ApiError>(db::first_history_page(pool, &root).await?) }, ensure_agent_ready(&root), members, async {
            Ok::<_, ApiError>(db::get_pending_question(pool, &sid).await?.map(|q| db::api::pending_question_response(&q)))
        })
        .await?;
    let statuses = store().get_agent_statuses(&sid);
    let db::FirstHistoryPage { rows: lead_rows, has_more, boundary, latest_prompt } = page;
    log_page_breakdown(&sid, &lead_rows);
    let next_cursor = boundary.map(|b| format!("{}|{}", b.seq, db::codec::api_uuid(&b.id)));
    let members = subs.iter().map(|sub| member_part(&statuses, sub, &totals)).collect();
    let lead = lead_part(&root, &lead_rows, Some(&totals), sender_of(pool, &root).await?);
    let latest_prompt = latest_prompt.as_ref().map(MessageView);
    Ok(json_status(StatusCode::OK, &HistoryBody { lead, members, has_more, next_cursor, truncated: false, pending_question: pending, latest_prompt }))
}

#[cfg(test)]
mod tests;
