//! `pending_questions` queries.

use crate::codec::{db_id, json_db, new_id, now_db};
use crate::models::{PendingQuestion, SessionMessage};
use crate::pool::DbPool;
use crate::queries::messages::{save_message, NewMessage};
use crate::queries::sessions::bump_history_revision;
use anyhow::Result;
use serde_json::{Map, Value};

pub const ASK_USER_TOOL: &str = "ask_user";

/// Stand-in tool result held while the user has not replied.
pub const PLACEHOLDER_RESULT: &str = "Waiting for the user to answer. Do not continue until their reply arrives.";

fn resolution_text(status: &str) -> &'static str {
    match status {
        "dismissed" => "Question(s) being dismissed.",
        "superseded" => "Superseded — the user sent a new instruction instead of answering.",
        _ => "This question is no longer relevant and was discarded.",
    }
}

/// Format the user's answers as text for the model.
pub fn format_answers_for_model(questions: &[Value], answers: Option<&Value>) -> String {
    let answers = answers.and_then(|a| a.as_array()).cloned().unwrap_or_default();
    let parts: Vec<String> = questions
        .iter()
        .enumerate()
        .map(|(i, q)| {
            let selected: Vec<String> = answers.get(i).and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect()).unwrap_or_default();
            let rendered = if selected.is_empty() { "Unanswered".to_string() } else { selected.join(", ") };
            format!("\"{}\"=\"{}\"", q.get("question").and_then(|s| s.as_str()).unwrap_or(""), rendered)
        })
        .collect();
    format!("User has answered your questions: {}. Continue with the user's answers in mind.", parts.join(", "))
}

/// Record a suspension and its placeholder tool result.
pub async fn create_pending_question(pool: &DbPool, session_id: &str, tool_call_id: &str, questions: &[Value]) -> Result<PendingQuestion> {
    let payload = serde_json::json!({ "questions": questions });
    create_pending_question_with(pool, session_id, tool_call_id, ASK_USER_TOOL, &payload).await
}

/// [`create_pending_question`] for any suspending tool: `payload` is stored
/// as-is (it must carry `questions`), and the placeholder tool message is
/// named `tool_name` so it pairs with the call that suspended.
pub async fn create_pending_question_with(pool: &DbPool, session_id: &str, tool_call_id: &str, tool_name: &str, payload: &Value) -> Result<PendingQuestion> {
    let sid = db_id(session_id);
    let id = new_id();
    sqlx::query(
        "INSERT INTO pending_questions (id, session_id, tool_call_id, payload, status, answers, created_at, answered_at) \
         VALUES (?, ?, ?, ?, 'pending', 'null', ?, NULL)",
    )
    .bind(&id)
    .bind(&sid)
    .bind(tool_call_id)
    .bind(json_db(Some(payload)))
    .bind(now_db())
    .execute(pool)
    .await?;
    let mut extra = Map::new();
    extra.insert("pending_question".into(), Value::Bool(true));
    save_message(pool, &sid, NewMessage { extra: Some(extra), ..NewMessage::tool(tool_call_id, tool_name, PLACEHOLDER_RESULT) }).await?;
    Ok(get_question(pool, &id).await?.expect("row just inserted"))
}

pub async fn get_question(pool: &DbPool, id: &str) -> Result<Option<PendingQuestion>> {
    Ok(sqlx::query_as::<_, PendingQuestion>("SELECT * FROM pending_questions WHERE id = ?").bind(db_id(id)).fetch_optional(pool).await?)
}

/// Open question for a session, if it is waiting.
pub async fn get_pending_question(pool: &DbPool, session_id: &str) -> Result<Option<PendingQuestion>> {
    Ok(sqlx::query_as::<_, PendingQuestion>("SELECT * FROM pending_questions WHERE session_id = ? AND status = 'pending' LIMIT 1")
        .bind(db_id(session_id))
        .fetch_optional(pool)
        .await?)
}

/// Every session id (on-disk form) with an open question.
pub async fn sessions_awaiting_input(pool: &DbPool) -> Result<std::collections::HashSet<String>> {
    let rows: Vec<String> = sqlx::query_scalar("SELECT session_id FROM pending_questions WHERE status = 'pending'").fetch_all(pool).await?;
    Ok(rows.into_iter().collect())
}

/// Close an open question and rewrite its placeholder. `None` when it was
/// already resolved (lost race) — the caller must then not resume the turn.
pub async fn resolve_pending_question(pool: &DbPool, question_id: &str, status: &str, answers: Option<&Value>) -> Result<Option<PendingQuestion>> {
    resolve_pending_question_with(pool, question_id, status, answers, None).await
}

/// [`resolve_pending_question`] with the tool result an answer writes:
/// `answered_content` replaces the default answer summary (other statuses
/// keep their standard sentence).
pub async fn resolve_pending_question_with(
    pool: &DbPool,
    question_id: &str,
    status: &str,
    answers: Option<&Value>,
    answered_content: Option<&str>,
) -> Result<Option<PendingQuestion>> {
    let qid = db_id(question_id);
    let answers_v = answers.filter(|a| a.as_array().map(|x| !x.is_empty()).unwrap_or(false));
    let updated = sqlx::query("UPDATE pending_questions SET status = ?, answers = ?, answered_at = ? WHERE id = ? AND status = 'pending'")
        .bind(status)
        .bind(json_db(answers_v))
        .bind(now_db())
        .bind(&qid)
        .execute(pool)
        .await?
        .rows_affected();
    if updated == 0 {
        return Ok(None);
    }
    let Some(row) = get_question(pool, &qid).await? else { return Ok(None) };
    let content = match (status, answered_content) {
        ("answered", Some(text)) => text.to_string(),
        ("answered", None) => format_answers_for_model(&row.questions(), row.answers_json().as_ref()),
        _ => resolution_text(status).to_string(),
    };
    let placeholder = sqlx::query_as::<_, SessionMessage>("SELECT * FROM session_messages WHERE session_id = ? AND tool_call_id = ? LIMIT 1")
        .bind(&row.session_id)
        .bind(&row.tool_call_id)
        .fetch_optional(pool)
        .await?;
    if let Some(p) = placeholder {
        let mut extra = match p.extra_json() {
            Some(Value::Object(m)) => m,
            _ => Map::new(),
        };
        extra.remove("pending_question");
        crate::queries::messages::update_message_content(pool, &p.id, Some(&content), Some(&extra)).await?;
        bump_history_revision(pool, &row.session_id, true).await?;
    }
    Ok(Some(row))
}
