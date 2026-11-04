//! The arguments clients receive for a tool call in history.
//!
//! A few tools carry long arguments that a transcript row does not need to
//! show until the user opens it: a shell command beside its description, a
//! patch's whole envelope, a plan's Markdown. History sends a short form of
//! those (with the full size beside it) and clients fetch the full arguments
//! when the row is opened. The agent reads full arguments from the database.

use serde_json::{json, Map, Value};

/// Longest shell command a call without a description keeps (in chars).
const SHELL_COMMAND_KEEP: usize = 200;

/// The short form of `args` for a `tool` call, or `None` when the call goes
/// out as stored (another tool, nothing to cut, or arguments that are not a
/// JSON object).
pub fn display_args(tool: &str, args: &str) -> Option<String> {
    if !matches!(tool, "shell" | "patch" | "plan") {
        return None;
    }
    let Ok(Value::Object(mut m)) = serde_json::from_str::<Value>(args) else { return None };
    let changed = match tool {
        "shell" => short_shell(&mut m),
        "patch" => short_patch(&mut m),
        _ => short_plan(&mut m),
    };
    changed.then(|| Value::Object(m).to_string())
}

/// A described call keeps its description; a bare one the first line of
/// its command, cut at [`SHELL_COMMAND_KEEP`] chars.
fn short_shell(m: &mut Map<String, Value>) -> bool {
    let described = m.get("description").and_then(Value::as_str).is_some_and(|d| !d.trim().is_empty());
    if described {
        return m.remove("command").is_some();
    }
    let Some(command) = m.get("command").and_then(Value::as_str) else { return false };
    let first = command.lines().next().unwrap_or("");
    let kept: String = first.chars().take(SHELL_COMMAND_KEEP).collect();
    if kept == command.trim_end() {
        return false;
    }
    m.insert("command".into(), Value::String(kept));
    m.insert("command_truncated".into(), Value::Bool(true));
    true
}

/// The envelope becomes the files it touches with their line counts.
fn short_patch(m: &mut Map<String, Value>) -> bool {
    let Some(text) = m.get("patch_text").and_then(Value::as_str) else { return false };
    let files = patch_files(text);
    m.remove("patch_text");
    m.insert("files".into(), Value::Array(files));
    true
}

/// The Markdown and edits go; the action, flags and summary stay.
fn short_plan(m: &mut Map<String, Value>) -> bool {
    let content = m.remove("content").is_some();
    let edits = m.remove("edits");
    if let Some(Value::Array(e)) = &edits {
        m.insert("edit_count".into(), json!(e.len()));
    }
    content || edits.is_some()
}

/// Files in a patch envelope, counted the way the web diff view counts
/// them (`web/src/components/ToolCall/diffUtils.ts` `parsePatchText`).
fn patch_files(text: &str) -> Vec<Value> {
    let text = text.replace("\r\n", "\n");
    let mut lines: Vec<&str> = text.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    if lines.first() != Some(&"*** Begin Patch") {
        return Vec::new();
    }
    let end = if lines.last() == Some(&"*** End Patch") { lines.len() - 1 } else { lines.len() };
    let mut files: Vec<Map<String, Value>> = Vec::new();
    let mut counts: Vec<(usize, usize)> = Vec::new();
    for line in &lines[1..end.max(1)] {
        let header = [("*** Add File: ", "add"), ("*** Update File: ", "update"), ("*** Delete File: ", "delete")]
            .into_iter()
            .find_map(|(prefix, kind)| line.strip_prefix(prefix).map(|p| (p.trim(), kind)));
        if let Some((path, kind)) = header {
            files.push(Map::from_iter([("path".to_string(), json!(path)), ("kind".to_string(), json!(kind))]));
            counts.push((0, 0));
            continue;
        }
        let (Some(file), Some(count)) = (files.last_mut(), counts.last_mut()) else { continue };
        if let Some(to) = line.strip_prefix("*** Move to: ") {
            file.insert("move_to".into(), json!(to.trim()));
            continue;
        }
        match file["kind"].as_str() {
            Some("add") if line.starts_with('+') || !(line.starts_with("***") || line.starts_with("@@")) => count.0 += 1,
            Some("update") if line.starts_with('+') => count.0 += 1,
            Some("update") if line.starts_with('-') => count.1 += 1,
            _ => {}
        }
    }
    files
        .into_iter()
        .zip(counts)
        .map(|(mut f, (additions, deletions))| {
            let move_to = f.remove("move_to");
            f.insert("additions".into(), json!(additions));
            f.insert("deletions".into(), json!(deletions));
            if let Some(to) = move_to {
                f.insert("move_to".into(), to);
            }
            Value::Object(f)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn short(tool: &str, args: Value) -> Option<Value> {
        display_args(tool, &args.to_string()).map(|s| serde_json::from_str(&s).unwrap())
    }

    #[test]
    fn a_described_shell_call_drops_its_command() {
        let got = short("shell", json!({"command": "cargo test -p appv3-db", "description": "Run the db tests", "timeout_seconds": 200}));
        assert_eq!(got, Some(json!({"description": "Run the db tests", "timeout_seconds": 200})));
    }

    #[test]
    fn a_bare_shell_call_keeps_the_first_line_of_a_long_command() {
        let long = format!("echo {}", "x".repeat(300));
        let got = short("shell", json!({"command": long})).unwrap();
        assert_eq!(got["command"].as_str().unwrap().chars().count(), SHELL_COMMAND_KEEP);
        assert_eq!(got["command_truncated"], json!(true));

        let got = short("shell", json!({"command": "cd web &&\n bun test", "workdir": "web"})).unwrap();
        assert_eq!(got, json!({"command": "cd web &&", "workdir": "web", "command_truncated": true}));
    }

    #[test]
    fn a_short_bare_shell_call_goes_out_as_is() {
        assert_eq!(short("shell", json!({"command": "git status --short"})), None);
        assert_eq!(short("shell", json!({"description": "Nothing to run"})), None);
    }

    #[test]
    fn a_patch_call_lists_its_files_with_line_counts() {
        let patch = "*** Begin Patch\n*** Add File: new.txt\n+one\n+two\n*** Update File: src/a.rs\n*** Move to: src/b.rs\n@@ fn main\n-old\n+new\n+more\n keep\n*** Delete File: gone.txt\n*** End Patch\n";
        let got = short("patch", json!({"patch_text": patch}));
        assert_eq!(
            got,
            Some(json!({"files": [
                {"path": "new.txt", "kind": "add", "additions": 2, "deletions": 0},
                {"path": "src/a.rs", "kind": "update", "additions": 2, "deletions": 1, "move_to": "src/b.rs"},
                {"path": "gone.txt", "kind": "delete", "additions": 0, "deletions": 0},
            ]}))
        );
    }

    #[test]
    fn a_patch_counts_crlf_lines_and_unprefixed_added_lines() {
        let patch = "*** Begin Patch\r\n*** Add File: a.md\r\n# Title\r\n\r\n+body\r\n*** End Patch";
        let got = short("patch", json!({"patch_text": patch})).unwrap();
        assert_eq!(got["files"], json!([{"path": "a.md", "kind": "add", "additions": 3, "deletions": 0}]));
    }

    #[test]
    fn a_plan_call_keeps_its_action_flags_and_summary() {
        let got = short("plan", json!({"action": "write", "content": "# Plan\n\nbody", "submit": true, "summary": "First draft"}));
        assert_eq!(got, Some(json!({"action": "write", "submit": true, "summary": "First draft"})));

        let got = short("plan", json!({"action": "edit", "edits": [{"old": "a", "new": "b"}, {"old": "c", "new": "d"}]}));
        assert_eq!(got, Some(json!({"action": "edit", "edit_count": 2})));

        assert_eq!(short("plan", json!({"submit": true})), None);
    }

    #[test]
    fn other_tools_and_unreadable_arguments_go_out_as_is() {
        assert_eq!(short("read", json!({"path": "a.rs"})), None);
        assert_eq!(display_args("shell", "{\"command\": \"echo"), None);
        assert_eq!(display_args("patch", "[]"), None);
        assert_eq!(short("patch", json!({"patch_text": 3})), None);
    }
}
