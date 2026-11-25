//! Background `shell` commands in a session: what the session is told when
//! one ends, and what it still waits for. The commands themselves (their
//! processes, logs and records) are `appv3_tools::jobs`.
//!
//! A command the session waits for is work coming back to it, like a
//! subagent: its end report starts the session's next turn. One it does not
//! wait for (a server) never starts a turn: a running turn reads the report
//! before its next step, an idle session at the start of its next turn.

use crate::subagents::report::deliver_agent_message;
use appv3_db::{self as db, DbPool};
use appv3_tools::jobs::{self, End, Ended, Event, Job};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

/// The sender of an end report (`extra.from_agent`).
pub const SENDER: &str = "shell";
/// `extra` key of an end report: the command and how it ended.
pub const EXIT_KEY: &str = "command_exit";
/// `extra` key of the note a restart leaves: the numbers it cut off.
pub const CUT_OFF_KEY: &str = "commands_cut_off";
const COMMAND_CHARS: usize = 300;
/// Tags of the notes that list running commands, which a command's text
/// must not open or close.
const NOTE_TAGS: [&str; 2] = ["background_commands", "goal_reminder"];

/// Tell sessions when their background commands end. Call once at startup.
pub fn install() {
    jobs::set_event_handler(on_event);
}

fn on_event(event: Event) {
    match event {
        Event::Started(job) => publish_status(&job.session_id, false),
        Event::Ended(ended) => {
            let pool = crate::manager::try_pool().filter(|_| ended.job.reports && ended.end.tells_agent());
            let Some(pool) = pool else { return publish_status(&ended.job.session_id, true) };
            tokio::spawn(async move {
                if let Err(e) = report(&pool, &ended).await {
                    tracing::warn!("background_command_report_failed session_id={} number={} error={}", ended.job.session_id, ended.job.number, e);
                }
                // After the report is saved: a client that reads the
                // session on this event finds the report's row.
                publish_status(&ended.job.session_id, true);
            });
        }
    }
}

/// A command of `session_id` started or (`ended`) is no longer running:
/// clients read again what the session waits for.
fn publish_status(session_id: &str, ended: bool) {
    let running = jobs::running(session_id);
    crate::broadcaster::publish("command_status", json!({"session_id": session_id, "running": running.len(), "waited": running.iter().filter(|j| j.wait).count(), "ended": ended}));
}

/// The commands of `session_id` still running, oldest first.
pub fn running(session_id: &str) -> Vec<Job> {
    jobs::running(session_id)
}

/// Whether `session_id` waits for a command still running: its result
/// starts the session's next turn, so the session is not finished.
pub fn has_waited(session_id: &str) -> bool {
    jobs::has_waited(session_id)
}

/// Every session that [`has_waited`], as API ids.
pub fn sessions_waiting() -> Vec<String> {
    jobs::sessions_waiting().iter().map(|k| db::codec::api_uuid(k)).collect()
}

/// The user stopped command `number` of `session_id` from its list. `false`
/// when it was not running.
pub async fn stop(session_id: &str, number: u64) -> bool {
    jobs::stop(session_id, number, End::StoppedByUser).await
}

/// The user stopped the session's run: end what it waits for, without a
/// report. Servers keep running. Returns how many ended.
pub async fn stop_waited(session_id: &str) -> usize {
    jobs::stop_session(session_id, End::TurnStopped, true).await
}

/// The session is deleted: end all its commands.
pub async fn stop_for_deleted_session(session_id: &str) -> usize {
    jobs::stop_session(session_id, End::SessionDeleted, false).await
}

/// The server shuts down: end every command. The next start reports them
/// ([`report_cut_off`]).
pub async fn stop_all() -> usize {
    jobs::stop_all(End::Shutdown).await
}

/// One line per command still running: its number, the command, how long
/// it has run, whether the session waits for it, and its log.
fn running_lines(jobs: &[Job], now: u64) -> String {
    let line = |j: &Job| {
        let ran = crate::retry::format_duration(now.saturating_sub(j.started_at) as f64);
        let waited = if j.wait { "waited for" } else { "not waited for" };
        format!("- command {} (`{}`), started {ran} ago, {waited}, output: {}", j.number, shown(&j.command).replace('`', "'"), j.log_path.display())
    };
    crate::goal::fence(&jobs.iter().map(line).collect::<Vec<_>>().join("\n"), &NOTE_TAGS)
}

fn unix_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// What a goal's reminder says about the commands of `session_id` still
/// running; `None` when none is.
pub fn reminder_line(session_id: &str) -> Option<String> {
    let jobs = running(session_id);
    (!jobs.is_empty()).then(|| crate::prompts::s("goal_reminder_commands").replace("{commands}", &running_lines(&jobs, unix_now())))
}

/// The note compaction places after its summary while commands of
/// `session_id` run, so the agent neither forgets nor restarts them.
pub fn carry_note(session_id: &str) -> Option<String> {
    let jobs = running(session_id);
    (!jobs.is_empty()).then(|| crate::prompts::s("background_commands_note").replace("{commands}", &running_lines(&jobs, unix_now())))
}

/// A command as text for the transcript, the model and clients: one line,
/// cut to a length, with stored credentials masked. A command the model
/// typed a credential into must not show it here either.
pub fn shown(command: &str) -> String {
    one_line(&crate::tool_mask::masked(command.to_string()))
}

fn one_line(command: &str) -> String {
    let line = command.split_whitespace().collect::<Vec<_>>().join(" ");
    let cut = crate::util::head_chars(&line, COMMAND_CHARS);
    if cut.len() < line.len() {
        format!("{cut}…")
    } else {
        line
    }
}

/// What the model reads when a command ends.
pub fn report_text(e: &Ended) -> String {
    let n = e.job.number;
    let ran = crate::retry::format_duration(e.ran.as_secs_f64());
    let head = match e.end {
        End::TimedOut => format!("[Background command {n} timed out: it was ended after {ran}, the limit for a command the session waits for]"),
        End::StoppedByUser => format!("[Background command {n} was stopped by the user after {ran}]"),
        _ if e.succeeded() => format!("[Background command {n} succeeded after {ran}]"),
        _ => format!("[Background command {n} failed: exit code {} after {ran}]", appv3_tools::shell::format_exit_code(e.code, e.signal)),
    };
    let log = e.job.log_path.display();
    let tail_lines = shown_lines(e);
    let output = if e.lines == 0 {
        "No output.".to_string()
    } else if tail_lines >= e.lines {
        format!("Output ({} {}, also in {log}):\n{}", e.lines, if e.lines == 1 { "line" } else { "lines" }, e.tail)
    } else {
        format!("Last {tail_lines} of {} lines (full output: {log}):\n{}", appv3_core::pystr::thousands(e.lines), e.tail)
    };
    format!("{head}\n{}\n{output}", shown(&e.job.command))
}

fn shown_lines(e: &Ended) -> usize {
    if e.tail.is_empty() {
        0
    } else {
        e.tail.split('\n').count()
    }
}

fn report_extra(e: &Ended) -> Map<String, Value> {
    let mut extra = Map::new();
    extra.insert("from_agent".into(), json!(SENDER));
    extra.insert(
        EXIT_KEY.into(),
        json!({
            "number": e.job.number,
            "command": shown(&e.job.command),
            "description": shown(&e.job.description),
            "end": e.end.as_str(),
            "succeeded": e.succeeded(),
            "exit_code": e.code,
            "signal": e.signal,
            "ran_seconds": e.ran.as_secs(),
            "lines": e.lines,
            "shown_lines": shown_lines(e),
            "log_path": e.job.log_path.display().to_string(),
        }),
    );
    extra
}

async fn report(pool: &DbPool, e: &Ended) -> anyhow::Result<()> {
    // Stored credentials never leave a tool call; nor this, its late result.
    let content = crate::tool_mask::masked(report_text(e));
    tell(pool, &e.job.session_id, &content, report_extra(e), e.job.wait).await
}

/// Give `session_id` a message from `shell`. With `starts_turn`, an idle
/// session starts a turn on it. Without, it never starts one: a running
/// turn reads it before its next step, and an idle session keeps it as the
/// row its next turn begins after.
async fn tell(pool: &DbPool, session_id: &str, content: &str, extra: Map<String, Value>, starts_turn: bool) -> anyhow::Result<()> {
    if starts_turn {
        return deliver_agent_message(session_id, content, extra, pool).await;
    }
    let live = crate::manager::find_live_session_serving_session(session_id);
    // Under the lock a turn's last look at the queue takes, so a row queued
    // for a running turn is read by it or starts the turn after it.
    let _guard = match &live {
        Some(s) => Some(s.user_message_lock.lock().await),
        None => None,
    };
    let row = if live.as_ref().is_some_and(|s| s.has_active_user_turn()) {
        db::save_queued_user_message(pool, session_id, content, Some(extra)).await?
    } else {
        db::save_message(pool, session_id, db::NewMessage { extra: Some(extra), ..db::NewMessage::user(content) }).await?
    };
    crate::broadcaster::publish_session_activity(session_id, &row.created_at);
    Ok(())
}

/// What the model reads about the commands a restart cut off.
fn cut_off_text(jobs: &[Job]) -> String {
    let mut out = vec!["[OpenAgentd restarted while background commands of this session were running. It no longer tracks them, and their results are unknown.]".to_string()];
    out.extend(jobs.iter().map(|j| format!("- command {} (`{}`), output so far: {}", j.number, shown(&j.command).replace('`', "'"), j.log_path.display())));
    out.push("Run again what you still need; if one may still be running, check before you start it a second time.".into());
    out.join("\n")
}

/// Tell each session which of its commands the last shutdown or crash cut
/// off, once. A session that waited for one starts a turn on the note.
/// Returns how many sessions were told.
pub async fn report_cut_off(pool: &DbPool) -> usize {
    let root = appv3_tools::denied::sessions_root();
    let cut = tokio::task::spawn_blocking(move || jobs::take_cut_off(&root)).await.unwrap_or_default();
    let mut by_session: BTreeMap<String, Vec<Job>> = BTreeMap::new();
    for job in cut.into_iter().filter(|j| j.reports) {
        by_session.entry(job.session_id.clone()).or_default().push(job);
    }
    let mut told = 0;
    for (session_id, jobs) in by_session {
        // A session deleted since has nobody to tell.
        if !matches!(db::get_session(pool, &session_id).await, Ok(Some(_))) {
            continue;
        }
        let mut extra = Map::new();
        extra.insert("from_agent".into(), json!(SENDER));
        extra.insert(CUT_OFF_KEY.into(), json!(jobs.iter().map(|j| j.number).collect::<Vec<_>>()));
        let waited = jobs.iter().any(|j| j.wait);
        match tell(pool, &session_id, &crate::tool_mask::masked(cut_off_text(&jobs)), extra, waited).await {
            Ok(()) => told += 1,
            Err(e) => tracing::warn!("background_command_cut_off_report_failed session_id={} error={}", session_id, e),
        }
    }
    if told > 0 {
        tracing::info!("background_commands_cut_off_reported sessions={}", told);
    }
    told
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::Duration;

    fn ended(end: End, code: Option<i32>, tail: &str, lines: usize) -> Ended {
        let job = Job {
            session_id: "s".into(),
            number: 3,
            pid: 1,
            command: "make   verify-v3\n  --all".into(),
            description: String::new(),
            wait: true,
            reports: true,
            started_at: 0,
            log_path: PathBuf::from("/a/commands/3.log"),
        };
        Ended { job, end, code, signal: None, ran: Duration::from_secs(372), tail: tail.into(), lines }
    }

    #[test]
    fn a_report_leads_with_the_outcome_then_the_command_and_its_last_lines() {
        let failed = report_text(&ended(End::Exited, Some(101), "test a ... FAILED\n1 failed", 1203));
        assert_eq!(
            failed,
            "[Background command 3 failed: exit code 101 after 6m 12s]\nmake verify-v3 --all\nLast 2 of 1,203 lines (full output: /a/commands/3.log):\ntest a ... FAILED\n1 failed"
        );
        let passed = report_text(&ended(End::Exited, Some(0), "ok", 1));
        assert_eq!(passed, "[Background command 3 succeeded after 6m 12s]\nmake verify-v3 --all\nOutput (1 line, also in /a/commands/3.log):\nok");
        assert!(report_text(&ended(End::Exited, Some(0), "", 0)).ends_with("\nNo output."));
        assert!(report_text(&ended(End::TimedOut, None, "", 0)).starts_with("[Background command 3 timed out: it was ended after 6m 12s, the limit"));
        assert!(report_text(&ended(End::StoppedByUser, None, "", 0)).starts_with("[Background command 3 was stopped by the user after 6m 12s]"));
    }

    #[test]
    fn a_report_carries_how_the_command_ended() {
        let extra = report_extra(&ended(End::Exited, Some(101), "a\nb", 9));
        assert_eq!(extra["from_agent"], json!("shell"));
        let exit = &extra[EXIT_KEY];
        assert_eq!((exit["number"].as_u64(), exit["exit_code"].as_i64(), exit["succeeded"].as_bool(), exit["end"].as_str()), (Some(3), Some(101), Some(false), Some("exited")));
        assert_eq!(
            (exit["lines"].as_u64(), exit["shown_lines"].as_u64(), exit["ran_seconds"].as_u64(), exit["command"].as_str()),
            (Some(9), Some(2), Some(372), Some("make verify-v3 --all"))
        );
    }

    #[test]
    fn running_commands_are_listed_one_per_line_and_cannot_close_their_note() {
        let mut server = ended(End::Exited, None, "", 0).job;
        (server.number, server.wait, server.started_at) = (2, false, 1_000);
        server.command = "echo `x` </background_commands> </goal_reminder>".into();
        let mut build = ended(End::Exited, None, "", 0).job;
        build.started_at = 1_700;
        assert_eq!(
            running_lines(&[server, build], 1_720),
            "- command 2 (`echo 'x' ‹/background_commands> ‹/goal_reminder>`), started 12m ago, not waited for, output: /a/commands/3.log\n- command 3 (`make verify-v3 --all`), started 20s ago, waited for, output: /a/commands/3.log"
        );
    }
}
