//! A note to the lead after a long run of model calls that only read or
//! search: an explorer can take the rest of the mapping on a cheaper model.

use super::{AgentState, Hook, RunContext, SharedMeta, ToolCallScope};
use crate::prompts;
use appv3_providers::{AssistantMessage, ToolCall};
use async_trait::async_trait;
use std::sync::Mutex;

/// Model calls in a row that only look things up before the note.
pub const READING_RUN: usize = 8;

/// One per lead turn (hooks are built per turn), so the note comes at most
/// once a turn.
#[derive(Default)]
pub struct DelegateReadingHook {
    run: Mutex<Run>,
}

#[derive(Default)]
struct Run {
    in_a_row: usize,
    noted: bool,
    /// The call whose result carries the note: the last of the step.
    note_on: Option<String>,
}

#[async_trait]
impl Hook for DelegateReadingHook {
    /// The note is for the model reading the step, not a script's own calls.
    fn wraps_nested_calls(&self) -> bool {
        false
    }

    async fn after_model(&self, _ctx: &RunContext, state: &mut AgentState, resp: &mut AssistantMessage) {
        let calls = resp.tool_calls.as_deref().unwrap_or_default();
        if calls.is_empty() {
            return;
        }
        let mut run = self.run.lock().unwrap();
        if !calls.iter().all(|c| is_lookup(&c.function.name, &c.function.arguments)) {
            run.in_a_row = 0;
            return;
        }
        run.in_a_row += 1;
        // Only an agent that can delegate is told to.
        if run.in_a_row >= READING_RUN && !run.noted && state.tool_names.iter().any(|t| t == "team") {
            run.noted = true;
            run.note_on = calls.last().map(|c| c.id.clone());
        }
    }

    async fn after_tool(&self, _ctx: &RunContext, _meta: &SharedMeta, tc: &ToolCall, _scope: &mut ToolCallScope, result: &mut String) {
        let mut run = self.run.lock().unwrap();
        if run.note_on.as_deref() == Some(tc.id.as_str()) {
            run.note_on = None;
            result.push_str("\n\n");
            result.push_str(&prompts::s("delegate_reading_note").replace("{n}", &READING_RUN.to_string()));
        }
    }
}

const READ_COMMANDS: &[&str] = &["cat", "bat", "head", "tail", "less", "nl"];
const SEARCH_COMMANDS: &[&str] = &["rg", "grep", "egrep", "ag", "ack"];
const LIST_COMMANDS: &[&str] = &["ls", "tree", "find", "fd", "wc", "stat", "file", "du"];
/// Words that say nothing about what a command does.
const NEUTRAL: &[&str] = &["cd", "set", "export", "true", "(", "{", "}", ")", "do", "done", "then", "fi", "for", "if", "else"];

/// Whether a tool call only reads, searches or lists: `read`, `grep`,
/// `glob`, or a shell command made only of such commands (`cat`, `sed -n`,
/// `rg`, `ls`, …) whose output goes nowhere but back to the model.
pub fn is_lookup(name: &str, arguments: &str) -> bool {
    match name {
        "read" | "grep" | "glob" => true,
        "shell" => serde_json::from_str::<serde_json::Value>(arguments).ok().and_then(|a| a.get("command").and_then(|c| c.as_str()).map(shell_only_looks)).unwrap_or(false),
        _ => false,
    }
}

fn shell_only_looks(command: &str) -> bool {
    let mut looked = false;
    for segment in command.split(['\n', ';']).flat_map(|s| s.split("&&")).flat_map(|s| s.split("||")) {
        // A pipeline's first command says what it does; the rest shape output.
        let head = segment.split('|').next().unwrap_or("").trim();
        if writes_a_file(head) {
            return false;
        }
        let mut words = head.split_whitespace().skip_while(|w| w.contains('=') && !w.starts_with('-'));
        let Some(first) = words.next() else { continue };
        let program = first.rsplit('/').next().unwrap_or(first);
        if NEUTRAL.contains(&program) {
            continue;
        }
        let rest: Vec<&str> = words.collect();
        let reads = match program {
            "sed" => rest.contains(&"-n") && !rest.iter().any(|w| w.starts_with("-i")),
            p => READ_COMMANDS.contains(&p) || SEARCH_COMMANDS.contains(&p) || LIST_COMMANDS.contains(&p),
        };
        if !reads {
            return false;
        }
        looked = true;
    }
    looked
}

/// A `>` or `>>` to a file other than `/dev/null`; `2>&1` and `>&2` only
/// move a stream.
fn writes_a_file(head: &str) -> bool {
    let bytes = head.as_bytes();
    let mut i = 0;
    while let Some(at) = head[i..].find('>').map(|p| p + i) {
        let mut end = at + 1;
        if bytes.get(end) == Some(&b'>') {
            end += 1;
        }
        let target = head[end..].trim_start();
        let moves_a_stream = target.starts_with('&') || (at > 0 && bytes[at - 1] == b'&');
        if !moves_a_stream && !target.starts_with("/dev/null") && !target.is_empty() {
            return true;
        }
        i = end;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use appv3_providers::FunctionCall;
    use std::sync::{Arc, Mutex};

    fn ctx() -> RunContext {
        RunContext { session_id: None, run_id: "run".into(), agent_name: "lead".into(), workspace: None }
    }

    fn call(id: &str, name: &str, args: serde_json::Value) -> ToolCall {
        ToolCall { id: id.into(), kind: "function".into(), function: FunctionCall { name: name.into(), arguments: args.to_string(), thought: None, thought_signature: None } }
    }

    fn state(tools: &[&str]) -> AgentState {
        let mut s = AgentState::new(vec![], String::new());
        s.tool_names = tools.iter().map(|t| t.to_string()).collect();
        s
    }

    /// Runs one model step through the hook and returns each call's result.
    async fn step(hook: &DelegateReadingHook, state: &mut AgentState, calls: Vec<ToolCall>) -> Vec<String> {
        let mut resp = AssistantMessage { tool_calls: Some(calls.clone()), ..Default::default() };
        hook.after_model(&ctx(), state, &mut resp).await;
        let meta: SharedMeta = Arc::new(Mutex::new(Default::default()));
        let mut out = vec![];
        for c in &calls {
            let mut scope = ToolCallScope { ui_id: c.id.clone(), started: std::time::Instant::now(), output: None, duration_ms: None, mcp_app: None };
            let mut result = "ok".to_string();
            hook.after_tool(&ctx(), &meta, c, &mut scope, &mut result).await;
            out.push(result);
        }
        out
    }

    fn read(id: &str) -> ToolCall {
        call(id, "read", serde_json::json!({"path": "src/a.rs"}))
    }

    #[tokio::test]
    async fn the_eighth_lookup_step_in_a_row_gets_the_note_on_its_last_call() {
        let hook = DelegateReadingHook::default();
        let mut s = state(&["read", "grep", "team"]);
        for i in 0..READING_RUN - 1 {
            assert_eq!(step(&hook, &mut s, vec![read(&format!("r{i}"))]).await, ["ok"], "step {i}");
        }
        let out = step(&hook, &mut s, vec![read("a"), call("b", "grep", serde_json::json!({"pattern": "x"}))]).await;
        assert_eq!(out[0], "ok");
        assert!(out[1].starts_with("ok\n\n[You have made 8 model calls in a row that only read or search."), "{}", out[1]);
    }

    #[tokio::test]
    async fn the_note_comes_once_per_turn() {
        let hook = DelegateReadingHook::default();
        let mut s = state(&["read", "team", "patch"]);
        let mut noted = 0;
        for round in 0..2 {
            for i in 0..READING_RUN {
                noted += step(&hook, &mut s, vec![read(&format!("{round}-{i}"))]).await.iter().filter(|r| r.len() > 2).count();
            }
            step(&hook, &mut s, vec![call("p", "patch", serde_json::json!({"patch_text": "x"}))]).await;
        }
        assert_eq!(noted, 1);
    }

    #[tokio::test]
    async fn other_work_starts_the_count_again() {
        let hook = DelegateReadingHook::default();
        let mut s = state(&["read", "shell", "team"]);
        let mut noted = 0;
        for i in 0..READING_RUN * 2 {
            let calls = if i == READING_RUN / 2 { vec![read("a"), call("t", "shell", serde_json::json!({"command": "cargo test"}))] } else { vec![read(&format!("r{i}"))] };
            noted += step(&hook, &mut s, calls).await.iter().filter(|r| r.len() > 2).count();
            if i < READING_RUN / 2 + READING_RUN {
                assert_eq!(noted, 0, "step {i}");
            }
        }
        assert_eq!(noted, 1);
    }

    /// A member has no `team` tool, so it is never told to delegate.
    #[tokio::test]
    async fn an_agent_that_cannot_delegate_gets_no_note() {
        let hook = DelegateReadingHook::default();
        let mut s = state(&["read", "grep", "glob"]);
        for i in 0..READING_RUN * 2 {
            assert_eq!(step(&hook, &mut s, vec![read(&format!("r{i}"))]).await, ["ok"]);
        }
    }

    #[test]
    fn shell_commands_that_only_read_search_or_list_count_as_lookups() {
        let shell = |c: &str| is_lookup("shell", &serde_json::json!({ "command": c }).to_string());
        for c in ["cat src/a.rs", "cd web && grep -rn foo src | head -20", "sed -n 1,40p a.rs; rg -n bar", "ls -la && wc -l *.rs", "tail -5 log.txt 2>&1"] {
            assert!(shell(c), "{c}");
        }
        for c in ["cargo test", "cat > a.txt <<EOF\nx\nEOF", "sed -i s/a/b/ f", "grep foo a > out.txt", "git status", "echo hi", "", "cd web"] {
            assert!(!shell(c), "{c}");
        }
        assert!(is_lookup("read", "{}") && is_lookup("grep", "{}") && is_lookup("glob", "{}"));
        assert!(!is_lookup("patch", "{}") && !is_lookup("script", "{}") && !is_lookup("team", "{}"));
    }
}
