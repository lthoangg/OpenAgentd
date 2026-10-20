//! Raw row types. Every column is kept in its on-disk representation
//! (see [`crate::codec`]); convert at the API edge with [`crate::api`].

use crate::codec::{json_col, parse_uuid};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

/// Sparse allocation step for `session_messages.seq` (v2 `SEQ_STEP`).
pub const SEQ_STEP: i64 = 1024;

/// `session_messages.kind` values (v2 `MessageKind`).
pub mod kind {
    pub const CHAT: &str = "chat";
    pub const NOTE: &str = "note";
    pub const QUEUED: &str = "queued";
    pub const SUMMARY: &str = "summary";
    pub const REVERTED: &str = "reverted";
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct ChatSession {
    pub id: String,
    pub parent_session_id: Option<String>,
    pub agent_name: Option<String>,
    pub title: Option<String>,
    pub scheduled_task_name: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub workspace: String,
    pub revert: Option<String>,
    pub model: Option<String>,
    pub thinking_level: Option<String>,
    pub history_revision: i64,
    pub history_structure_revision: i64,
    pub interaction_mode: String,
    /// When the user pinned the session in the sidebar; `None` = unpinned.
    pub pinned_at: Option<String>,
    /// Newest non-summary message, or creation for an empty session: what
    /// "Recent activity" sorts by and the sidebar's age shows. `None` only for
    /// a row written outside [`crate::create_session`].
    pub last_message_at: Option<String>,
}

impl ChatSession {
    pub fn uuid(&self) -> Uuid {
        parse_uuid(&self.id).unwrap_or_default()
    }
    pub fn revert_json(&self) -> Option<Value> {
        json_col(self.revert.as_deref()).filter(|v| v.is_object())
    }
    /// `revert.message_id` as a UUID, if a boundary is staged.
    pub fn revert_message_id(&self) -> Option<Uuid> {
        self.revert_json()?.get("message_id")?.as_str().and_then(parse_uuid)
    }
    /// `revert.snapshot` — the redo anchor.
    pub fn redo_anchor(&self) -> Option<String> {
        self.revert_json()?.get("snapshot")?.as_str().filter(|s| !s.is_empty()).map(str::to_string)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct SessionMessage {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub content: Option<String>,
    pub reasoning_content: Option<String>,
    pub tool_calls: Option<String>,
    pub tool_call_id: Option<String>,
    pub name: Option<String>,
    pub extra: Option<String>,
    pub created_at: String,
    pub seq: i64,
    pub kind: String,
    pub pinned: bool,
}

impl SessionMessage {
    pub fn uuid(&self) -> Uuid {
        parse_uuid(&self.id).unwrap_or_default()
    }
    pub fn extra_json(&self) -> Option<Value> {
        json_col(self.extra.as_deref())
    }
    pub fn tool_calls_json(&self) -> Option<Value> {
        json_col(self.tool_calls.as_deref()).filter(|v| v.is_array())
    }
    /// `extra.snapshot` — the workspace snapshot taken before this user turn.
    pub fn snapshot(&self) -> Option<String> {
        self.extra_json()?.get("snapshot")?.as_str().filter(|s| !s.is_empty()).map(str::to_string)
    }
    /// `extra.from_agent` is absent or `"user"` — authored by the human.
    pub fn is_from_user(&self) -> bool {
        match self.extra_json().as_ref().and_then(|e| e.get("from_agent")) {
            None | Some(Value::Null) => true,
            Some(Value::String(s)) => s == "user",
            _ => false,
        }
    }
}

/// The columns tool-call pairing needs from an LLM-window row. Skips
/// `content`/`extra`, which hold whole tool outputs on long sessions.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ToolPairRow {
    pub session_id: String,
    pub role: String,
    pub tool_calls: Option<String>,
    pub tool_call_id: Option<String>,
    pub created_at: String,
    pub seq: i64,
}

impl ToolPairRow {
    pub fn tool_calls_json(&self) -> Option<Value> {
        json_col(self.tool_calls.as_deref()).filter(|v| v.is_array())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct CodingWorkspace {
    pub id: String,
    pub path: String,
    pub kind: String,
    pub source_path: Option<String>,
    pub name: Option<String>,
    pub managed: bool,
    pub hidden: bool,
    pub deleted_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct PendingQuestion {
    pub id: String,
    pub session_id: String,
    pub tool_call_id: String,
    pub payload: String,
    pub status: String,
    pub answers: Option<String>,
    pub created_at: String,
    pub answered_at: Option<String>,
}

impl PendingQuestion {
    pub fn questions(&self) -> Vec<Value> {
        json_col(Some(&self.payload)).and_then(|p| p.get("questions").cloned()).and_then(|q| q.as_array().cloned()).unwrap_or_default()
    }
    pub fn answers_json(&self) -> Option<Value> {
        json_col(self.answers.as_deref())
    }
    /// The suspension's kind (`payload.kind`); `None` for an `ask_user` question.
    pub fn kind(&self) -> Option<String> {
        json_col(Some(&self.payload)).and_then(|p| p.get("kind").and_then(|k| k.as_str()).map(String::from))
    }
    /// The plan revision a plan review was opened for (`payload.plan_revision`).
    pub fn plan_revision(&self) -> Option<u64> {
        json_col(Some(&self.payload)).and_then(|p| p.get("plan_revision").and_then(|r| r.as_u64()))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct ScheduledTask {
    pub id: String,
    pub name: String,
    pub schedule_type: String,
    pub at_datetime: Option<String>,
    pub every_seconds: Option<i64>,
    pub cron_expression: Option<String>,
    pub timezone: String,
    pub prompt: String,
    pub session_id: Option<String>,
    pub enabled: bool,
    pub status: String,
    pub run_count: i64,
    pub last_run_at: Option<String>,
    pub last_error: Option<String>,
    pub next_fire_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub workspace: String,
    pub max_runs: Option<i64>,
    pub slug: String,
}
