//! The agent crate's integration tests, one module per file beside this one.
//!
//! They build as one test binary instead of one per file: each binary links
//! separately, and on macOS the first run of every newly linked binary can
//! wait for a malware scan, so one binary pays those costs once instead of
//! once per file. nextest still runs every test in
//! its own process, so tests that set environment variables stay isolated.
//! Run one file's tests with `cargo nextest run -p appv3-agent <file_stem>::`.

mod bench_turn;
mod bundled_skill_references;
mod cancel_running_tool;
mod checkpoint_atomicity;
mod common;
mod confirm_change;
mod delegate_pending_work;
mod force_stop;
mod goal_loop;
mod goal_questions;
mod heal_orphans;
mod idle_compaction;
mod idle_compaction_restart;
mod inflight_shared_session;
mod lead_eviction_subagents;
mod mcp_hub_tool;
mod model_facing_text;
mod perf_bench;
mod perf_seed_reopen;
mod pin_switch;
mod plan_review;
mod question_opens_early;
mod question_resolution;
mod queued_messages;
mod quiet_turns;
mod refusal;
mod request_snapshot;
mod restart_resume;
mod restart_resume_cases;
mod run_model_pinning;
mod runtime_protocol;
mod scheduled_session_tools;
mod scheduled_task_sessions;
mod scheduled_turn_race;
mod script_tool;
mod secret_request;
mod session_eviction;
mod session_pin;
mod session_turn;
mod session_workspace_isolation;
mod side_question;
mod skill_session_freeze;
mod steer_model_switch;
mod stop_and_send;
mod stop_dismisses_question;
mod subagent_ask_lead_answer;
mod subagent_failure_report;
mod subagent_follow_up_busy;
mod subagent_from_lead;
mod subagent_interrupt;
mod subagent_restart_resume;
mod subagent_shutdown;
mod subagent_stall;
mod subagent_unload;
mod summarization_live_threshold;
mod thinking_duration;
mod turn_claims;
mod turn_panic;
mod turn_snapshot;
mod turn_thinking_level;
mod workspace_delivery;
mod workspace_messages;
mod workspace_relocate;
mod workspace_worktrees;
mod worktree_reconcile;
mod worktree_remove;

/// A file under `tests/` that is not a module above would never compile or run.
#[test]
fn every_test_file_is_a_module_of_this_binary() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests");
    let main = std::fs::read_to_string(dir.join("main.rs")).unwrap();
    let mut missing: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            let stem = path.file_stem()?.to_string_lossy().into_owned();
            (path.extension()? == "rs" && stem != "main" && !main.contains(&format!("\nmod {stem};"))).then_some(stem)
        })
        .collect();
    missing.sort();
    assert!(missing.is_empty(), "add `mod <name>;` to tests/main.rs for {missing:?}");
}
