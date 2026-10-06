//! `plan` and `submit_plan` — the lead's session plan and its review gate.
//!
//! `plan` writes the plan file ([`crate::plan`]) in either mode; `submit_plan`
//! opens a plan review, a `pending_questions` row with
//! `payload.kind = "plan_review"`, and pauses the turn like `ask_user`. The
//! answer route closes it ([`crate::plan::resolve_review`]).

use super::{invalid_args, publish_input_needed};
use crate::events;
use crate::plan::{self, PlanChange, PlanEdit, PlanTarget, APPROVE_LABEL, PLAN_REVIEW_KIND, REQUEST_CHANGES_LABEL};
use crate::stream_store::store;
use appv3_db::DbPool;
use appv3_tools::{denied, Suspension, Tool, ToolContext, ToolError, ToolOutput, ToolResult};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::path::Path;

pub const PLAN_TOOL: &str = "plan";
pub const SUBMIT_PLAN_TOOL: &str = "submit_plan";
const MAX_EDITS: usize = 20;
const MAX_SUMMARY_CHARS: usize = 300;

fn in_plan_mode(ctx: &ToolContext) -> bool {
    ctx.metadata.lock().unwrap().get("interaction_mode").and_then(Value::as_str) == Some("plan")
}

/// A JSON value models sometimes send as a string holding JSON.
fn unstring(v: &Value) -> Value {
    match v {
        Value::String(s) => serde_json::from_str(s.trim()).unwrap_or_else(|_| v.clone()),
        other => other.clone(),
    }
}

enum PlanArgs {
    Write(String),
    Edit(Vec<PlanEdit>),
}

fn parse_plan_args(args: &Value) -> Result<PlanArgs, Vec<String>> {
    let text = |v: Option<&Value>, loc: &str| -> Result<String, String> {
        match v {
            None | Some(Value::Null) => Err(format!("{loc}: Field required")),
            Some(Value::String(s)) => Ok(s.clone()),
            Some(_) => Err(format!("{loc}: Input should be a valid string")),
        }
    };
    match args.get("action").and_then(Value::as_str) {
        Some("write") => text(args.get("content"), "content").map(PlanArgs::Write).map_err(|e| vec![e]),
        Some("edit") => {
            let raw = args.get("edits").map(unstring);
            let items = match raw {
                None | Some(Value::Null) => return Err(vec!["edits: Field required".into()]),
                Some(Value::Array(a)) => a,
                Some(_) => return Err(vec!["edits: Input should be a valid list".into()]),
            };
            if items.is_empty() || items.len() > MAX_EDITS {
                return Err(vec![format!("edits: List should have 1 to {MAX_EDITS} items, not {}", items.len())]);
            }
            let mut errs = vec![];
            let mut edits = vec![];
            for (i, e) in items.iter().enumerate() {
                match (text(e.get("old"), &format!("edits -> {i} -> old")), text(e.get("new"), &format!("edits -> {i} -> new"))) {
                    (Ok(old), Ok(new)) => edits.push(PlanEdit { old, new }),
                    (a, b) => errs.extend([a.err(), b.err()].into_iter().flatten()),
                }
            }
            if errs.is_empty() {
                Ok(PlanArgs::Edit(edits))
            } else {
                Err(errs)
            }
        }
        None if args.get("action").is_none() => Err(vec!["action: Field required".into()]),
        _ => Err(vec!["action: Input should be 'write' or 'edit'".into()]),
    }
}

/// The lead's session plan (both modes).
pub struct PlanTool {
    pub session_id: String,
    /// A project workspace: the plan lives in `.openagentd/plans/`.
    pub coding: bool,
}

/// Save a `plan` call's change and describe the result for the model.
fn save_plan(dir: &Path, target: PlanTarget, parsed: &PlanArgs, plan_mode: bool) -> Result<String, plan::PlanError> {
    let change = match parsed {
        PlanArgs::Write(body) => PlanChange::Write(body),
        PlanArgs::Edit(edits) => PlanChange::Edit(edits),
    };
    let out = plan::save_agent(dir, target, change)?;
    let doc = &out.doc;
    if !out.changed {
        return Ok(format!("Plan unchanged (revision {}).", doc.revision));
    }
    let lines = doc.content.lines().count();
    let mut text = format!("Plan saved as revision {} ({lines} line{}) at {}.", doc.revision, if lines == 1 { "" } else { "s" }, doc.display_path());
    if out.included_user_edits {
        text.push_str(" This revision includes the user's edits.");
    }
    if plan_mode {
        text.push_str(" Call submit_plan when it is ready for review.");
    }
    tracing::info!("plan_saved dir={} revision={} path={}", dir.display(), doc.revision, doc.path.display());
    Ok(text)
}

#[async_trait]
impl Tool for PlanTool {
    fn name(&self) -> &str {
        PLAN_TOOL
    }

    async fn run(&self, ctx: &ToolContext, args: Value) -> ToolResult {
        let parsed = parse_plan_args(&args).map_err(|e| invalid_args(PLAN_TOOL, &e))?;
        let dir = denied::session_artifacts_dir(Some(&self.session_id));
        let target =
            if self.coding { PlanTarget::Workspace { root: &ctx.denied.workspace_root, session_id: &self.session_id, denied: Some(&ctx.denied) } } else { PlanTarget::DataDir };
        save_plan(&dir, target, &parsed, in_plan_mode(ctx)).map(ToolOutput::text).map_err(ToolError::exec)
    }
}

/// The `pending_questions` payload of a plan review.
pub fn review_payload(revision: u64, summary: Option<&str>, in_plan_mode: bool) -> Value {
    let question = match summary {
        Some(s) => format!("Review plan revision {revision}. {s}"),
        None => format!("Review plan revision {revision}."),
    };
    let approve_desc = if in_plan_mode { "Switch to Code mode and implement this plan." } else { "Approve and implement this plan." };
    let changes_desc = if in_plan_mode { "Stay in Plan mode and describe what to change." } else { "Describe what to change in the plan." };
    json!({
        "kind": PLAN_REVIEW_KIND,
        "plan_revision": revision,
        "summary": summary,
        "questions": [{
            "question": question,
            "header": "Plan review",
            "options": [
                {"label": APPROVE_LABEL, "description": approve_desc, "recommended": false},
                {"label": REQUEST_CHANGES_LABEL, "description": changes_desc, "recommended": false},
            ],
            "multiple": false,
            "custom": true,
        }],
    })
}

fn parse_summary(args: &Value) -> Result<Option<String>, Vec<String>> {
    match args.get("summary") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.chars().count() > MAX_SUMMARY_CHARS => Err(vec![format!("summary: String should have at most {MAX_SUMMARY_CHARS} characters")]),
        Some(Value::String(s)) => Ok(Some(s.trim().to_string()).filter(|s| !s.is_empty())),
        Some(_) => Err(vec!["summary: Input should be a valid string".into()]),
    }
}

/// The plan a `submit_plan` call would put up for review.
fn reviewable(dir: &Path) -> Result<plan::PlanDoc, ToolError> {
    plan::sync(dir).ok_or_else(|| ToolError::Execution("There is no plan to submit. Write it with the plan tool first.".into()))
}

/// Hand the plan to the user for review.
pub struct SubmitPlanTool {
    pub session_id: String,
    pub pool: DbPool,
}

#[async_trait]
impl Tool for SubmitPlanTool {
    fn name(&self) -> &str {
        SUBMIT_PLAN_TOOL
    }

    async fn run(&self, ctx: &ToolContext, args: Value) -> ToolResult {
        let summary = parse_summary(&args).map_err(|e| invalid_args(SUBMIT_PLAN_TOOL, &e))?;
        let doc = reviewable(&denied::session_artifacts_dir(Some(&self.session_id)))?;
        if ctx.tool_call_id.is_empty() {
            return Ok(ToolOutput::text("The plan could not be submitted (no tool call id). Ask the user to review it in the Plan panel."));
        }
        let in_plan = in_plan_mode(ctx);
        let payload = review_payload(doc.revision, summary.as_deref(), in_plan);
        let row = appv3_db::create_pending_question_with(&self.pool, &self.session_id, &ctx.tool_call_id, SUBMIT_PLAN_TOOL, &payload).await.map_err(ToolError::exec)?;
        let sid = appv3_db::codec::api_uuid(&appv3_db::codec::db_id(&self.session_id));
        let qid = appv3_db::codec::api_uuid(&row.id);
        let questions = payload["questions"].as_array().cloned().unwrap_or_default();
        store().push_event(&sid, &events::plan_review_asked(&qid, &sid, &ctx.tool_call_id, &questions, doc.revision), false);
        publish_input_needed(&self.pool, &self.session_id, &qid, "Plan ready", |_| summary.clone().unwrap_or_else(|| "Review the agent's plan".into())).await;
        tracing::info!("plan_review_opened session_id={} question_id={} revision={}", sid, qid, doc.revision);
        Err(ToolError::Suspended(Suspension::Question { question_id: qid, session_id: sid }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "01a0ecf9-22d0-7665-96c1-611316df61f9";

    fn args(v: Value) -> PlanArgs {
        parse_plan_args(&v).unwrap()
    }

    #[test]
    fn plan_arguments_are_validated() {
        let err = |v: Value| parse_plan_args(&v).err().unwrap();
        assert_eq!(err(json!({})), vec!["action: Field required"]);
        assert_eq!(err(json!({"action": "replace"})), vec!["action: Input should be 'write' or 'edit'"]);
        assert_eq!(err(json!({"action": "write"})), vec!["content: Field required"]);
        assert_eq!(err(json!({"action": "edit", "edits": []})), vec!["edits: List should have 1 to 20 items, not 0"]);
        assert_eq!(err(json!({"action": "edit", "edits": [{"old": "a"}]})), vec!["edits -> 0 -> new: Field required"]);
        let edits = json!({"action": "edit", "edits": "[{\"old\": \"a\", \"new\": \"b\"}]"});
        assert!(matches!(parse_plan_args(&edits), Ok(PlanArgs::Edit(e)) if e == vec![PlanEdit { old: "a".into(), new: "b".into() }]));
    }

    #[test]
    fn summaries_are_optional_and_capped() {
        assert_eq!(parse_summary(&json!({})), Ok(None));
        assert_eq!(parse_summary(&json!({"summary": "  "})), Ok(None));
        assert_eq!(parse_summary(&json!({"summary": "Split step 2"})), Ok(Some("Split step 2".into())));
        assert!(parse_summary(&json!({"summary": "x".repeat(301)})).is_err());
    }

    #[test]
    fn the_review_payload_offers_approve_and_request_changes() {
        let p = review_payload(3, Some("Now with tests."), true);
        assert_eq!(p["kind"], "plan_review");
        assert_eq!(p["plan_revision"], 3);
        assert_eq!(p["questions"][0]["question"], "Review plan revision 3. Now with tests.");
        let labels: Vec<&str> = p["questions"][0]["options"].as_array().unwrap().iter().map(|o| o["label"].as_str().unwrap()).collect();
        assert_eq!(labels, ["Approve", "Request changes"]);
        assert_eq!(review_payload(1, None, true)["summary"], Value::Null);

        let code_p = review_payload(1, None, false);
        assert_eq!(code_p["questions"][0]["options"][0]["description"], "Approve and implement this plan.");
        assert_eq!(code_p["questions"][0]["options"][1]["description"], "Describe what to change in the plan.");
    }

    #[test]
    fn plan_results_name_the_revision_and_path() {
        let d = tempfile::tempdir().unwrap();
        let (dir, root) = (d.path().join("sid"), d.path().join("ws"));
        std::fs::create_dir_all(&root).unwrap();
        let ws = || PlanTarget::Workspace { root: &root, session_id: SID, denied: None };
        let wrote = save_plan(&dir, ws(), &args(json!({"action": "write", "content": "# Ship it\n1. a"})), true).unwrap();
        assert_eq!(wrote, "Plan saved as revision 1 (2 lines) at .openagentd/plans/ship-it-16df61f9.md. Call submit_plan when it is ready for review.");
        let same = save_plan(&dir, ws(), &args(json!({"action": "edit", "edits": [{"old": "1. a", "new": "1. a"}]})), false).unwrap();
        assert_eq!(same, "Plan unchanged (revision 1).");
        let edited = save_plan(&dir, ws(), &args(json!({"action": "edit", "edits": [{"old": "1. a", "new": "1. b"}]})), false).unwrap();
        assert_eq!(edited, "Plan saved as revision 2 (2 lines) at .openagentd/plans/ship-it-16df61f9.md.");
        let missing = save_plan(&dir, ws(), &args(json!({"action": "edit", "edits": [{"old": "zzz", "new": "y"}]})), false).unwrap_err();
        assert_eq!(missing.to_string(), "edits -> 0: old text not found in the plan.");
    }

    #[test]
    fn the_write_guard_refuses_once_over_user_edits() {
        let d = tempfile::tempdir().unwrap();
        let write = |body: &str| args(json!({"action": "write", "content": body}));
        save_plan(d.path(), PlanTarget::DataDir, &write("# P\n1. a"), true).unwrap();
        let path = plan::data_plan_path(d.path());
        std::fs::write(&path, "# P\n1. a (user)").unwrap();
        let refused = save_plan(d.path(), PlanTarget::DataDir, &write("# P\n1. mine"), true).unwrap_err();
        assert_eq!(
            refused.to_string(),
            format!(
                "The user edited the plan since you last saw it (revision 2). Read {} and apply your change with action \"edit\", or call write again to replace their version.",
                path.display()
            )
        );
        let replaced = save_plan(d.path(), PlanTarget::DataDir, &write("# P\n1. mine"), true).unwrap();
        assert!(replaced.starts_with("Plan saved as revision 3 "), "{replaced}");

        std::fs::write(&path, "# P\n1. mine\n2. theirs").unwrap();
        let merged = save_plan(d.path(), PlanTarget::DataDir, &args(json!({"action": "edit", "edits": [{"old": "mine", "new": "ours"}]})), false).unwrap();
        assert!(merged.ends_with(" This revision includes the user's edits."), "{merged}");
    }

    #[test]
    fn submit_plan_needs_a_plan() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(reviewable(d.path()).unwrap_err().to_string(), "There is no plan to submit. Write it with the plan tool first.");
        save_plan(d.path(), PlanTarget::DataDir, &args(json!({"action": "write", "content": "# P"})), true).unwrap();
        assert_eq!(reviewable(d.path()).unwrap().revision, 1);
    }
}
