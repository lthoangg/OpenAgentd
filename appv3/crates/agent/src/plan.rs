//! The session plan: a Markdown document the lead writes with the `plan`
//! tool and the user reviews (and may edit) in the Plan panel.
//!
//! In a project workspace the plan is `<workspace>/.openagentd/plans/<slug>-<id8>.md`,
//! ignored by git through the folder's own `.gitignore`; chat sessions keep it
//! at `<data_dir>/sessions/<sid>/plan.md`. The bookkeeping (which file, its
//! revision, the revision the agent last saw, the revision the user approved)
//! lives in `plan.state.json` beside the session's other artifacts, so the
//! workspace only ever holds Markdown.
//!
//! Edits are detected by content hash whoever makes them (the Plan panel, an
//! outside editor, git) and reported to the agent once: in the review result
//! when the user edits during a review, else in a note at the next turn
//! ([`announce_user_edits`]). Compaction restates the plan through
//! [`carry_note`], because the messages that wrote it do not survive it.

use appv3_db::{self as db, DbPool, NewMessage, PendingQuestion};
use appv3_tools::{denied, todo, DeniedPaths};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

/// The plan file of a chat session (and of sessions from before v3.1.0).
pub const PLAN_FILENAME: &str = "plan.md";
pub const PLAN_STATE_FILENAME: &str = "plan.state.json";
/// Where project workspaces keep plans, relative to the workspace root.
pub const WORKSPACE_PLANS_DIR: &str = ".openagentd/plans";
/// Written once when the plans folder is created, so plans stay out of git,
/// snapshots, and discard-all unless the user deletes it to commit them.
const PLANS_GITIGNORE: &str = "*\n";
pub const PLAN_MAX_CHARS: usize = 100_000;

/// `pending_questions.payload.kind` of a plan review.
pub const PLAN_REVIEW_KIND: &str = "plan_review";
pub const APPROVE_LABEL: &str = "Approve";
pub const REQUEST_CHANGES_LABEL: &str = "Request changes";
/// Longest review answer (feedback); `ask_user` answers keep their own cap.
pub const PLAN_REVIEW_MAX_ANSWER_CHARS: usize = 8000;

/// `extra` key marking the compaction note that restates the plan.
pub const SESSION_PLAN_KEY: &str = "session_plan";
/// `extra` key marking the note that shows the agent the user's edits.
pub const PLAN_EDIT_NOTE_KEY: &str = "plan_edit_note";

/// Appended to the summariser's request while a plan exists, so the summary
/// records progress against the plan instead of a second, lossy copy.
pub const PLAN_SUMMARY_RULE: &str = "A `<session_plan>` note keeps this session's plan file verbatim next to this summary. Do not restate its steps: refer to them by number or title when recording progress, and record any user-requested changes to the plan.";

const CARRY_GUIDANCE: &str = "This is the session's latest plan, restated verbatim after context compaction; the summary records progress. The plan outranks the summary on scope and step order, and the task board records step status. In Code mode, continue from the first unfinished step; in Plan mode, revise it with the `plan` tool and resubmit it with `submit_plan`. If the user has since redirected the work, follow the user. Change the plan with the `plan` tool only when the user changes its scope; track progress with `todo_manage`.";

/// Every read-modify-write of a plan and its state holds this, so parallel
/// `plan` calls and the HTTP routes never lose an update. Held only for the
/// synchronous file work.
fn lock() -> MutexGuard<'static, ()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(())).lock().unwrap_or_else(|e| e.into_inner())
}

/// The data-dir plan file of the session whose artifacts dir is `dir`.
pub fn data_plan_path(dir: &Path) -> PathBuf {
    dir.join(PLAN_FILENAME)
}

fn state_path(dir: &Path) -> PathBuf {
    dir.join(PLAN_STATE_FILENAME)
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
struct PlanState {
    /// The plan file; `None` means the data-dir `plan.md`.
    #[serde(default)]
    path: Option<PathBuf>,
    /// The resolved workspace root a workspace plan must stay inside.
    #[serde(default)]
    root: Option<PathBuf>,
    revision: u64,
    /// Hash of the trimmed content at `revision`.
    sha256: String,
    /// The revision the agent was last shown.
    agent_revision: u64,
    #[serde(default)]
    approved_revision: Option<u64>,
}

/// The plan as it is now.
#[derive(Debug, Clone, PartialEq)]
pub struct PlanDoc {
    pub content: String,
    pub path: PathBuf,
    root: Option<PathBuf>,
    pub updated_at: DateTime<Utc>,
    pub revision: u64,
    pub agent_revision: u64,
    pub approved_revision: Option<u64>,
}

impl PlanDoc {
    /// The plan changed since the agent last saw it (the user edited it).
    pub fn unseen_edits(&self) -> bool {
        self.revision > self.agent_revision
    }
    /// The path relative to the workspace root (`/`-separated), for a workspace plan.
    pub fn workspace_path(&self) -> Option<String> {
        let rel = self.path.strip_prefix(self.root.as_ref()?).ok()?;
        Some(rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/"))
    }
    /// How tool results and notes name the file: workspace-relative when it
    /// is in the workspace, else absolute.
    pub fn display_path(&self) -> String {
        self.workspace_path().unwrap_or_else(|| self.path.display().to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PlanError {
    #[error("There is no plan yet. Use action \"write\".")]
    NoPlan,
    #[error("The plan cannot be empty.")]
    Empty,
    #[error("The plan exceeds {PLAN_MAX_CHARS} characters.")]
    TooLong,
    #[error("edits -> {0}: old text must not be empty.")]
    EditEmpty(usize),
    #[error("edits -> {0}: old text not found in the plan.")]
    EditNotFound(usize),
    #[error("edits -> {0}: old text matches {1} places; include more surrounding text.")]
    EditAmbiguous(usize, usize),
    #[error("The user edited the plan since you last saw it (revision {revision}). Read {path} and apply your change with action \"edit\", or call write again to replace their version.")]
    UnseenEdits { revision: u64, path: String },
    #[error("The plan folder resolves outside the workspace.")]
    Escapes,
    #[error("The plan folder is inside a denied path: {0}")]
    Denied(String),
    #[error("The plan changed since you opened it.")]
    Conflict,
    #[error("{0}")]
    Io(String),
}

impl From<std::io::Error> for PlanError {
    fn from(e: std::io::Error) -> Self {
        PlanError::Io(e.to_string())
    }
}

/// One exact-text replacement of a `plan` edit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanEdit {
    pub old: String,
    pub new: String,
}

/// What a `plan` call asks for.
pub enum PlanChange<'a> {
    Write(&'a str),
    Edit(&'a [PlanEdit]),
}

/// Where a first plan is created.
pub enum PlanTarget<'a> {
    /// A project workspace: `<root>/.openagentd/plans/`.
    Workspace { root: &'a Path, session_id: &'a str, denied: Option<&'a DeniedPaths> },
    /// The session's data dir (chat workspaces).
    DataDir,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SaveOutcome {
    pub doc: PlanDoc,
    pub changed: bool,
    /// The saved revision includes user edits the agent had not seen.
    pub included_user_edits: bool,
}

fn sha(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.trim().as_bytes()))
}

fn read_state(dir: &Path) -> Option<PlanState> {
    serde_json::from_str(&std::fs::read_to_string(state_path(dir)).ok()?).ok()
}

fn write_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, text)?;
    std::fs::rename(tmp, path)
}

fn write_state(dir: &Path, st: &PlanState) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    write_atomic(&state_path(dir), &serde_json::to_string_pretty(st).unwrap_or_default())
}

/// The state and file path of the session's plan, if it has one. A data-dir
/// `plan.md` without state (sessions from before v3.1.0) reads as revision 1.
fn current(dir: &Path) -> Option<(PlanState, PathBuf)> {
    if let Some(st) = read_state(dir) {
        let path = st.path.clone().unwrap_or_else(|| data_plan_path(dir));
        return Some((st, path));
    }
    let path = data_plan_path(dir);
    let text = std::fs::read_to_string(&path).ok()?;
    Some((PlanState { path: None, root: None, revision: 1, sha256: sha(&text), agent_revision: 1, approved_revision: None }, path))
}

/// Read the plan and fold in any change made outside the plan tools.
fn sync_locked(dir: &Path) -> Option<(PlanDoc, PlanState)> {
    let (mut st, path) = current(dir)?;
    let text = std::fs::read_to_string(&path).ok()?;
    let content = text.trim();
    if content.is_empty() {
        return None;
    }
    let hash = sha(content);
    if st.sha256 != hash {
        st.revision += 1;
        st.sha256 = hash;
        if let Err(e) = write_state(dir, &st) {
            tracing::warn!("plan_state_write_failed dir={} error={}", dir.display(), e);
        }
    }
    let updated_at = std::fs::metadata(&path).and_then(|m| m.modified()).map(DateTime::<Utc>::from).unwrap_or_else(|_| Utc::now());
    let doc = PlanDoc {
        content: content.to_string(),
        path,
        root: st.root.clone(),
        updated_at,
        revision: st.revision,
        agent_revision: st.agent_revision,
        approved_revision: st.approved_revision,
    };
    Some((doc, st))
}

/// The session's plan, with outside edits folded into its revision.
pub fn sync(dir: &Path) -> Option<PlanDoc> {
    let _g = lock();
    sync_locked(dir).map(|(doc, _)| doc)
}

/// `body` after applying `edits` in order; each old text must match once.
pub fn apply_edits(current: &str, edits: &[PlanEdit]) -> Result<String, PlanError> {
    let mut text = current.to_string();
    for (i, e) in edits.iter().enumerate() {
        if e.old.is_empty() {
            return Err(PlanError::EditEmpty(i));
        }
        match text.matches(e.old.as_str()).count() {
            0 => return Err(PlanError::EditNotFound(i)),
            1 => text = text.replacen(e.old.as_str(), &e.new, 1),
            n => return Err(PlanError::EditAmbiguous(i, n)),
        }
    }
    Ok(text)
}

fn checked_body(body: &str) -> Result<String, PlanError> {
    let body = body.trim();
    if body.is_empty() {
        return Err(PlanError::Empty);
    }
    if body.chars().count() > PLAN_MAX_CHARS {
        return Err(PlanError::TooLong);
    }
    Ok(body.to_string())
}

/// The file-name stem for a plan: its first `# ` heading, as a slug.
fn slug(body: &str) -> String {
    let heading = body.lines().find_map(|l| l.trim().strip_prefix("# ")).unwrap_or("");
    let mut out = String::new();
    for c in heading.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let mut out: String = out.trim_matches('-').chars().take(48).collect();
    out = out.trim_end_matches('-').to_string();
    if out.is_empty() {
        "plan".into()
    } else {
        out
    }
}

/// The last 8 hex digits of the session id. The first digits of a v7 id are
/// a timestamp, which sessions created in the same minute share.
fn id8(session_id: &str) -> String {
    let hex: String = session_id.chars().filter(char::is_ascii_hexdigit).collect();
    hex[hex.len().saturating_sub(8)..].to_ascii_lowercase()
}

/// Refuse a plan location that a symlink carries out of the workspace, or
/// that the denied-paths policy covers.
fn check_inside(path: &Path, root: &Path, denied: Option<&DeniedPaths>) -> Result<PathBuf, PlanError> {
    let resolved = denied::resolve(path);
    if !resolved.starts_with(root) {
        return Err(PlanError::Escapes);
    }
    if denied.is_some_and(|d| d.is_denied_path(&resolved)) {
        return Err(PlanError::Denied(resolved.display().to_string()));
    }
    Ok(resolved)
}

/// A new, unused plan file in the workspace's plans folder.
fn new_workspace_file(root: &Path, session_id: &str, denied: Option<&DeniedPaths>, body: &str) -> Result<(PathBuf, PathBuf), PlanError> {
    let root = denied::resolve(root);
    let dir = root.join(WORKSPACE_PLANS_DIR);
    // Checked before creating anything, so a symlinked `.openagentd` cannot
    // make us create folders elsewhere, and again once the folder exists.
    check_inside(&dir, &root, denied)?;
    let created = !dir.exists();
    std::fs::create_dir_all(&dir)?;
    let dir = check_inside(&dir, &root, denied)?;
    if created {
        std::fs::write(dir.join(".gitignore"), PLANS_GITIGNORE)?;
    }
    let stem = format!("{}-{}", slug(body), id8(session_id));
    for n in 1..=100 {
        let name = if n == 1 { format!("{stem}.md") } else { format!("{stem}-{n}.md") };
        let candidate = dir.join(name);
        if std::fs::symlink_metadata(&candidate).is_err() {
            return Ok((candidate, root));
        }
    }
    Err(PlanError::Io("No free plan file name.".into()))
}

/// Save a change the agent made with the `plan` tool.
///
/// A full write over user edits the agent has not seen is refused once (the
/// refusal counts as showing them); an edit applies on top of them.
pub fn save_agent(dir: &Path, target: PlanTarget, change: PlanChange) -> Result<SaveOutcome, PlanError> {
    let _g = lock();
    let existing = sync_locked(dir);
    let unseen = existing.as_ref().is_some_and(|(d, _)| d.unseen_edits());
    let body = match change {
        PlanChange::Write(text) => {
            if let Some((doc, mut st)) = existing.clone().filter(|_| unseen) {
                st.agent_revision = st.revision;
                write_state(dir, &st)?;
                return Err(PlanError::UnseenEdits { revision: doc.revision, path: doc.display_path() });
            }
            checked_body(text)?
        }
        PlanChange::Edit(edits) => {
            let Some((doc, _)) = &existing else { return Err(PlanError::NoPlan) };
            checked_body(&apply_edits(&doc.content, edits)?)?
        }
    };
    let (mut st, old_path) = match &existing {
        Some((doc, st)) => (st.clone(), Some(doc.path.clone())),
        None => (PlanState::default(), None),
    };
    let changed = existing.as_ref().map(|(d, _)| d.content != body).unwrap_or(true);
    let denied = match &target {
        PlanTarget::Workspace { denied, .. } => *denied,
        PlanTarget::DataDir => None,
    };
    // A workspace plan stays where it is; anything else (new, or a data-dir
    // plan from before v3.1.0) moves into the workspace on its next write.
    let (path, root) = match (&st.path, &st.root, target) {
        (Some(p), Some(root), _) => (check_inside(p, root, denied)?, Some(root.clone())),
        (_, _, PlanTarget::Workspace { root, session_id, denied }) => {
            let (p, r) = new_workspace_file(root, session_id, denied, &body)?;
            (p, Some(r))
        }
        (_, _, PlanTarget::DataDir) => (data_plan_path(dir), None),
    };
    let moved = old_path.as_ref().is_some_and(|p| *p != path);
    if changed || moved {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        write_atomic(&path, &format!("{body}\n"))?;
        st.revision += 1;
    }
    if moved {
        let _ = std::fs::remove_file(data_plan_path(dir));
    }
    st.path = if root.is_some() { Some(path.clone()) } else { None };
    st.root = root;
    st.sha256 = sha(&body);
    st.agent_revision = st.revision;
    write_state(dir, &st)?;
    let updated_at = std::fs::metadata(&path).and_then(|m| m.modified()).map(DateTime::<Utc>::from).unwrap_or_else(|_| Utc::now());
    let doc = PlanDoc { content: body, path, root: st.root.clone(), updated_at, revision: st.revision, agent_revision: st.agent_revision, approved_revision: st.approved_revision };
    Ok(SaveOutcome { doc, changed: changed || moved, included_user_edits: unseen })
}

/// Save the user's edit from the Plan panel. `base_revision` is the revision
/// they opened; anything newer is a conflict. The agent is told on its next
/// turn or in the review result.
pub fn save_user(dir: &Path, body: &str, base_revision: u64) -> Result<PlanDoc, PlanError> {
    let body = checked_body(body)?;
    let _g = lock();
    let Some((doc, mut st)) = sync_locked(dir) else { return Err(PlanError::NoPlan) };
    if doc.revision != base_revision {
        return Err(PlanError::Conflict);
    }
    if body == doc.content {
        return Ok(doc);
    }
    if let Some(root) = &st.root {
        check_inside(&doc.path, root, Some(&DeniedPaths::new(root, None)))?;
    }
    write_atomic(&doc.path, &format!("{body}\n"))?;
    st.revision += 1;
    st.sha256 = sha(&body);
    write_state(dir, &st)?;
    Ok(sync_locked(dir).map(|(d, _)| d).unwrap_or(doc))
}

fn update_state(dir: &Path, f: impl FnOnce(&mut PlanState)) {
    let _g = lock();
    let Some((mut st, _)) = current(dir) else { return };
    f(&mut st);
    if let Err(e) = write_state(dir, &st) {
        tracing::warn!("plan_state_write_failed dir={} error={}", dir.display(), e);
    }
}

/// Record that the agent has been shown `revision`.
pub fn mark_seen(dir: &Path, revision: u64) {
    update_state(dir, |st| st.agent_revision = st.agent_revision.max(revision));
}

/// Record that the user approved `revision`.
pub fn mark_approved(dir: &Path, revision: u64) {
    update_state(dir, |st| st.approved_revision = Some(revision));
}

/// Stop using the plan in this session. A workspace plan file is the user's
/// and stays; the state and any data-dir plan are removed. Returns whether
/// there was a plan.
pub fn detach(dir: &Path) -> std::io::Result<bool> {
    let _g = lock();
    let mut had = false;
    for p in [state_path(dir), data_plan_path(dir)] {
        match std::fs::remove_file(p) {
            Ok(()) => had = true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    Ok(had)
}

/// The note compaction places before the summary, or `None` with no plan.
///
/// Once every tracked task is finished the plan is only pointed at, so a
/// completed plan does not cost its full size at every later compaction.
pub fn carry_note(dir: &Path) -> Option<String> {
    let doc = sync(dir)?;
    let path = doc.display_path();
    let stamp = doc.updated_at.to_rfc3339_opts(SecondsFormat::Secs, true);
    let store = todo::load_store(&todo::todos_path(dir));
    let items = store["items"].as_array().cloned().unwrap_or_default();
    let finished = !items.is_empty() && items.iter().all(|i| matches!(i["status"].as_str(), Some("completed" | "cancelled")));
    if finished {
        return Some(format!(
            "<session_plan path=\"{path}\" updated_at=\"{stamp}\" status=\"tasks_finished\">\nAll tracked tasks for this session's plan are finished, so the plan is not restated. Read the file at `path` if you need it again.\n</session_plan>"
        ));
    }
    let mut note = format!("<session_plan path=\"{path}\" updated_at=\"{stamp}\">\n{}\n</session_plan>", doc.content);
    if !items.is_empty() {
        note.push_str(&format!("\n<task_board>\n{}\n</task_board>", todo::format_items(&items)));
    }
    note.push_str("\n\n");
    note.push_str(CARRY_GUIDANCE);
    Some(note)
}

/// The user's decision in a plan review.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReviewDecision {
    Approve,
    /// Changes, with the user's feedback if they wrote any.
    Changes(Option<String>),
}

/// Read a review answer: exactly one group holding one non-blank string.
pub fn review_decision(answers: &[Vec<String>]) -> Result<ReviewDecision, String> {
    let invalid = || format!("A plan review takes one answer: \"{APPROVE_LABEL}\", \"{REQUEST_CHANGES_LABEL}\", or your feedback.");
    let [group] = answers else { return Err(invalid()) };
    let [answer] = group.as_slice() else { return Err(invalid()) };
    let answer = answer.trim();
    Ok(match answer {
        "" => return Err(invalid()),
        APPROVE_LABEL => ReviewDecision::Approve,
        REQUEST_CHANGES_LABEL => ReviewDecision::Changes(None),
        text => ReviewDecision::Changes(Some(text.to_string())),
    })
}

/// The `submit_plan` tool result a review answer writes. `doc` is the plan
/// now; when the user edited it, the text carries their version.
pub fn review_result_text(decision: &ReviewDecision, doc: Option<&PlanDoc>, submitted_revision: u64, in_plan_mode: bool) -> String {
    let n = doc.map(|d| d.revision).unwrap_or(submitted_revision);
    let path = doc.map(PlanDoc::display_path).unwrap_or_else(|| "the session plan".into());
    let mut text = String::new();
    if let Some(d) = doc.filter(|d| d.unseen_edits()) {
        text.push_str(&format!("The user edited the plan during review; this is revision {n}, saved at {path}:\n\n<plan>\n{}\n</plan>\n\n", d.content));
    }
    text.push_str(&match decision {
        ReviewDecision::Approve => {
            let switched = if in_plan_mode { " The session is now in Code mode with full tool access." } else { "" };
            format!("The user approved plan revision {n}.{switched} Implement the plan in `{path}` from its first step and track progress with `todo_manage`.")
        }
        ReviewDecision::Changes(Some(feedback)) => {
            let still = if in_plan_mode { "You are still in Plan mode. " } else { "" };
            format!(
                "The user requested changes to plan revision {n}:\n\n{feedback}\n\n{still}Address every point, update the plan with the `plan` tool, then call `submit_plan` again."
            )
        }
        ReviewDecision::Changes(None) => {
            format!("The user requested changes to plan revision {n} without saying what to change. Ask them with `ask_user`, then update the plan and call `submit_plan` again.")
        }
    });
    text
}

pub struct ReviewOutcome {
    pub approved: bool,
    /// Approval switched the session to Code mode (it was not already).
    pub mode_changed: bool,
}

/// Close an open plan review with the user's decision. On approval the
/// session switches to Code mode and the plan is marked approved. `None`
/// when the review was already closed (lost race); do not resume then.
pub async fn resolve_review(pool: &DbPool, session_id: &str, question: &PendingQuestion, decision: &ReviewDecision, answers: &Value) -> anyhow::Result<Option<ReviewOutcome>> {
    let dir = denied::session_artifacts_dir(Some(session_id));
    let doc = sync(&dir);
    let session = db::get_session(pool, session_id).await?.ok_or_else(|| anyhow::anyhow!("Session not found."))?;
    let in_plan = session.interaction_mode == "plan";
    let text = review_result_text(decision, doc.as_ref(), question.plan_revision().unwrap_or(0), in_plan);
    if db::resolve_pending_question_with(pool, &question.id, "answered", Some(answers), Some(&text)).await?.is_none() {
        return Ok(None);
    }
    if let Some(d) = &doc {
        mark_seen(&dir, d.revision);
    }
    let approved = *decision == ReviewDecision::Approve;
    let mut mode_changed = false;
    if approved {
        mode_changed = crate::interaction_mode::set_mode(pool, session_id, "code").await?.1;
        if let Some(d) = &doc {
            mark_approved(&dir, d.revision);
        }
    }
    Ok(Some(ReviewOutcome { approved, mode_changed }))
}

/// The note that shows the agent the user's edits to the plan.
fn edit_note(doc: &PlanDoc) -> String {
    format!(
        "<plan_updated path=\"{}\" revision=\"{}\">\n{}\n</plan_updated>\nThe user edited the session plan since you last saw it. Follow this version.",
        doc.display_path(),
        doc.revision,
        doc.content
    )
}

/// Before a lead turn: if the plan changed since the agent last saw it, add
/// a hidden note with the new version. Returns whether one was added.
pub async fn announce_user_edits(pool: &DbPool, session_id: &str, dir: &Path) -> anyhow::Result<bool> {
    let Some(doc) = sync(dir).filter(PlanDoc::unseen_edits) else { return Ok(false) };
    let mut extra = Map::new();
    extra.insert("hidden_from_user".into(), json!(true));
    extra.insert(PLAN_EDIT_NOTE_KEY.into(), json!(true));
    db::save_message(pool, session_id, NewMessage { kind: Some("note".into()), extra: Some(extra), ..NewMessage::user(edit_note(&doc)) }).await?;
    db::bump_history_revision(pool, session_id, true).await?;
    mark_seen(dir, doc.revision);
    tracing::info!("plan_user_edits_announced session_id={} revision={}", session_id, doc.revision);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "01a0ecf9-22d0-7665-96c1-611316df61f9";

    fn workspace(root: &Path) -> PlanTarget<'_> {
        PlanTarget::Workspace { root, session_id: SID, denied: None }
    }

    fn edit(old: &str, new: &str) -> PlanEdit {
        PlanEdit { old: old.into(), new: new.into() }
    }

    #[test]
    fn edits_apply_in_order_and_must_match_once() {
        let plan = "## Steps\n1. Build\n2. Test\n";
        assert_eq!(apply_edits(plan, &[edit("1. Build", "1. Build it"), edit("Build it", "Compile")]).unwrap(), "## Steps\n1. Compile\n2. Test\n");
        assert_eq!(apply_edits(plan, &[edit("3. Ship", "x")]), Err(PlanError::EditNotFound(0)));
        assert_eq!(apply_edits(plan, &[edit("Build", "B"), edit("\n", "")]), Err(PlanError::EditAmbiguous(1, 3)));
        assert_eq!(apply_edits(plan, &[edit("", "x")]), Err(PlanError::EditEmpty(0)));
    }

    #[test]
    fn file_names_come_from_the_heading_and_the_end_of_the_session_id() {
        assert_eq!(slug("Intro\n# Plan Review: Loop & UI!\nbody"), "plan-review-loop-ui");
        assert_eq!(slug("no heading"), "plan");
        assert_eq!(slug(&format!("# {}", "x".repeat(80))).len(), 48);
        assert_eq!(id8(SID), "16df61f9");
    }

    #[test]
    fn a_workspace_plan_is_created_in_a_git_ignored_folder() {
        let d = tempfile::tempdir().unwrap();
        let (dir, root) = (d.path().join("sid"), d.path().join("ws"));
        std::fs::create_dir_all(&root).unwrap();
        let out = save_agent(&dir, workspace(&root), PlanChange::Write("# Fix it\n1. a")).unwrap();
        assert_eq!(out.doc.workspace_path().as_deref(), Some(".openagentd/plans/fix-it-16df61f9.md"));
        assert_eq!(std::fs::read_to_string(&out.doc.path).unwrap(), "# Fix it\n1. a\n");
        let plans = denied::resolve(&root).join(WORKSPACE_PLANS_DIR);
        assert_eq!(std::fs::read_to_string(plans.join(".gitignore")).unwrap(), "*\n");
        assert_eq!((out.doc.revision, out.doc.agent_revision, out.changed), (1, 1, true));

        // A user who deletes the .gitignore to commit plans keeps it deleted.
        std::fs::remove_file(plans.join(".gitignore")).unwrap();
        let other = tempfile::tempdir().unwrap();
        save_agent(other.path(), PlanTarget::Workspace { root: &root, session_id: "aaaaaaaa-0000-0000-0000-000000000001", denied: None }, PlanChange::Write("# Other")).unwrap();
        assert!(!plans.join(".gitignore").exists());
    }

    #[test]
    fn a_taken_file_name_gets_a_suffix() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().join("ws");
        let plans = root.join(WORKSPACE_PLANS_DIR);
        std::fs::create_dir_all(&plans).unwrap();
        std::fs::write(plans.join("plan-16df61f9.md"), "someone else's").unwrap();
        let out = save_agent(&d.path().join("sid"), workspace(&root), PlanChange::Write("body")).unwrap();
        assert!(out.doc.path.ends_with("plan-16df61f9-2.md"));
        assert_eq!(std::fs::read_to_string(plans.join("plan-16df61f9.md")).unwrap(), "someone else's");
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_plans_folder_outside_the_workspace_is_refused() {
        let d = tempfile::tempdir().unwrap();
        let (root, outside) = (d.path().join("ws"), d.path().join("outside"));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join(".openagentd")).unwrap();
        let err = save_agent(&d.path().join("sid"), workspace(&root), PlanChange::Write("# Plan")).unwrap_err();
        assert_eq!(err, PlanError::Escapes);
        assert!(!outside.join("plans").exists(), "nothing is created through the link");
    }

    #[test]
    fn a_chat_plan_stays_in_the_data_dir() {
        let d = tempfile::tempdir().unwrap();
        let out = save_agent(d.path(), PlanTarget::DataDir, PlanChange::Write("  ## Plan\n1. a\n")).unwrap();
        assert_eq!(out.doc.path, data_plan_path(d.path()));
        assert_eq!(out.doc.workspace_path(), None);
        assert_eq!(std::fs::read_to_string(data_plan_path(d.path())).unwrap(), "## Plan\n1. a\n");
        let again = save_agent(d.path(), PlanTarget::DataDir, PlanChange::Write("## Plan\n1. a")).unwrap();
        assert_eq!((again.changed, again.doc.revision), (false, 1), "identical content is not a revision");
    }

    #[test]
    fn a_legacy_data_dir_plan_reads_as_revision_one_and_moves_on_its_next_write() {
        let d = tempfile::tempdir().unwrap();
        let (dir, root) = (d.path().join("sid"), d.path().join("ws"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(data_plan_path(&dir), "## Old plan\n").unwrap();
        let doc = sync(&dir).unwrap();
        assert_eq!((doc.revision, doc.agent_revision, doc.unseen_edits()), (1, 1, false));
        let out = save_agent(&dir, workspace(&root), PlanChange::Edit(&[edit("Old", "New")])).unwrap();
        assert_eq!(out.doc.revision, 2);
        assert!(out.doc.workspace_path().is_some());
        assert!(!data_plan_path(&dir).exists());
    }

    #[test]
    fn outside_edits_bump_the_revision_once_and_are_unseen_until_shown() {
        let d = tempfile::tempdir().unwrap();
        let out = save_agent(d.path(), PlanTarget::DataDir, PlanChange::Write("## Plan\n1. a")).unwrap();
        std::fs::write(&out.doc.path, "## Plan\n1. a\n2. b\n").unwrap();
        let doc = sync(d.path()).unwrap();
        assert_eq!((doc.revision, doc.unseen_edits()), (2, true));
        assert_eq!(sync(d.path()).unwrap().revision, 2, "the same edit counts once");
        std::fs::write(&out.doc.path, "## Plan\n1. a\n2. b").unwrap();
        assert_eq!(sync(d.path()).unwrap().revision, 2, "whitespace at the ends is not an edit");
        mark_seen(d.path(), 2);
        assert!(!sync(d.path()).unwrap().unseen_edits());
    }

    #[test]
    fn a_write_over_unseen_edits_is_refused_once_and_an_edit_includes_them() {
        let d = tempfile::tempdir().unwrap();
        let out = save_agent(d.path(), PlanTarget::DataDir, PlanChange::Write("## Plan\n1. a")).unwrap();
        std::fs::write(&out.doc.path, "## Plan\n1. a (user)").unwrap();
        let err = save_agent(d.path(), PlanTarget::DataDir, PlanChange::Write("## Plan\n1. mine")).unwrap_err();
        assert!(matches!(err, PlanError::UnseenEdits { revision: 2, .. }), "{err:?}");
        let second = save_agent(d.path(), PlanTarget::DataDir, PlanChange::Write("## Plan\n1. mine")).unwrap();
        assert_eq!((second.doc.revision, second.included_user_edits), (3, false));

        std::fs::write(&out.doc.path, "## Plan\n1. mine\n2. theirs").unwrap();
        let edited = save_agent(d.path(), PlanTarget::DataDir, PlanChange::Edit(&[edit("mine", "ours")])).unwrap();
        assert_eq!(edited.doc.content, "## Plan\n1. ours\n2. theirs");
        assert!(edited.included_user_edits);
        assert_eq!((edited.doc.revision, edited.doc.agent_revision), (5, 5));
    }

    #[test]
    fn user_saves_check_the_revision_they_opened() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(save_user(d.path(), "x", 0), Err(PlanError::NoPlan));
        save_agent(d.path(), PlanTarget::DataDir, PlanChange::Write("## Plan")).unwrap();
        assert_eq!(save_user(d.path(), "## Mine", 7), Err(PlanError::Conflict));
        assert_eq!(save_user(d.path(), "  ", 1), Err(PlanError::Empty));
        let doc = save_user(d.path(), "## Mine", 1).unwrap();
        assert_eq!((doc.content.as_str(), doc.revision, doc.agent_revision), ("## Mine", 2, 1));
    }

    #[test]
    fn detach_keeps_a_workspace_file() {
        let d = tempfile::tempdir().unwrap();
        let (dir, root) = (d.path().join("sid"), d.path().join("ws"));
        std::fs::create_dir_all(&root).unwrap();
        let out = save_agent(&dir, workspace(&root), PlanChange::Write("# P")).unwrap();
        assert!(detach(&dir).unwrap());
        assert!(sync(&dir).is_none());
        assert!(out.doc.path.exists());
        assert!(!detach(&dir).unwrap());
    }

    #[test]
    fn review_answers_parse_to_a_decision() {
        let one = |s: &str| vec![vec![s.to_string()]];
        assert_eq!(review_decision(&one("Approve")), Ok(ReviewDecision::Approve));
        assert_eq!(review_decision(&one("Request changes")), Ok(ReviewDecision::Changes(None)));
        assert_eq!(review_decision(&one(" Drop step 2 ")), Ok(ReviewDecision::Changes(Some("Drop step 2".into()))));
        assert!(review_decision(&one("  ")).is_err());
        assert!(review_decision(&[]).is_err());
        assert!(review_decision(&[vec!["Approve".into(), "x".into()]]).is_err());
        assert!(review_decision(&[vec!["Approve".into()], vec!["x".into()]]).is_err());
    }

    #[test]
    fn review_results_name_the_revision_and_carry_user_edits() {
        let d = tempfile::tempdir().unwrap();
        save_agent(d.path(), PlanTarget::DataDir, PlanChange::Write("## Plan")).unwrap();
        let doc = sync(d.path()).unwrap();
        let approved = review_result_text(&ReviewDecision::Approve, Some(&doc), 1, true);
        assert!(approved.starts_with("The user approved plan revision 1. The session is now in Code mode"), "{approved}");
        let approved_code = review_result_text(&ReviewDecision::Approve, Some(&doc), 1, false);
        assert!(approved_code.starts_with("The user approved plan revision 1. Implement the plan in"), "{approved_code}");
        assert!(!approved_code.contains("The session is now in Code mode"));

        let changes = review_result_text(&ReviewDecision::Changes(Some("Split step 2".into())), Some(&doc), 1, true);
        assert!(changes.contains("revision 1:\n\nSplit step 2\n\nYou are still in Plan mode."), "{changes}");
        let changes_code = review_result_text(&ReviewDecision::Changes(Some("Split step 2".into())), Some(&doc), 1, false);
        assert!(changes_code.contains("revision 1:\n\nSplit step 2\n\nAddress every point,"), "{changes_code}");
        assert!(!changes_code.contains("You are still in Plan mode."));

        assert!(review_result_text(&ReviewDecision::Changes(None), Some(&doc), 1, true).contains("without saying what to change"));

        save_user(d.path(), "## Plan\n1. user step", 1).unwrap();
        let edited = review_result_text(&ReviewDecision::Approve, sync(d.path()).as_ref(), 1, true);
        assert!(edited.starts_with("The user edited the plan during review; this is revision 2"), "{edited}");
        assert!(edited.contains("<plan>\n## Plan\n1. user step\n</plan>\n\nThe user approved plan revision 2."));
    }

    #[test]
    fn carry_note_restates_plan_and_board() {
        let d = tempfile::tempdir().unwrap();
        assert!(carry_note(d.path()).is_none());
        save_agent(d.path(), PlanTarget::DataDir, PlanChange::Write("## Steps\n1. Build\n2. Test")).unwrap();
        let note = carry_note(d.path()).unwrap();
        assert!(note.starts_with(&format!("<session_plan path=\"{}\"", data_plan_path(d.path()).display())));
        assert!(note.contains("\n## Steps\n1. Build\n2. Test\n</session_plan>"));
        assert!(!note.contains("<task_board>"));
        assert!(note.ends_with(CARRY_GUIDANCE));

        let todos = todo::todos_path(d.path());
        todo::apply(&todos, &[json!({"action": "create", "content": "Build", "status": "completed"}), json!({"action": "create", "content": "Test"})]).unwrap();
        let note = carry_note(d.path()).unwrap();
        assert!(note.contains("<task_board>\n[task_1] [completed] Build\n[task_2] [pending] Test\n</task_board>"));
    }

    #[test]
    fn carry_note_only_points_at_a_finished_plan() {
        let d = tempfile::tempdir().unwrap();
        save_agent(d.path(), PlanTarget::DataDir, PlanChange::Write("## Steps\n1. Build")).unwrap();
        todo::apply(&todo::todos_path(d.path()), &[json!({"action": "create", "content": "Build", "status": "completed"})]).unwrap();
        let note = carry_note(d.path()).unwrap();
        assert!(note.contains("status=\"tasks_finished\""));
        assert!(!note.contains("1. Build"));
    }
}
