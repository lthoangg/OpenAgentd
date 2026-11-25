//! `script`: run JavaScript / TypeScript that calls the agent's own tools
//! (`await tools.grep({...})`), so a chain of calls costs one model round
//! trip and only what the script logs or returns reaches the context.
//!
//! The code runs in a fresh QuickJS sandbox (`appv3_jsplugin::script`) with
//! no I/O of its own. Each `tools.x(args)` is a nested call the agent loop
//! runs through the same path as a direct call (Plan mode, denied paths,
//! plugin hooks, OTEL), handed to this tool as the task-local [`NESTED`]
//! runner. Tools that wait on a person, delegate, or run scripts themselves
//! are refused inside a script.
//!
//! Scripts are reusable: `save_as` stores a script that ran without error
//! under `.agents/scripts/` (or the personal `<config>/scripts/`), `list`
//! shows them, and `path` or `name` runs one again with new `args`.

use appv3_jsplugin::script::{run_script, HostCallFn, HostFuture, ScriptLimits, ScriptOutcome, ScriptSource};
use appv3_tools::{Tool, ToolContext, ToolError, ToolOutput, ToolResult};
use async_trait::async_trait;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const SCRIPT_TOOL: &str = "script";

/// Wall-clock limit of one script: a margin under the provider prompt-cache
/// lifetime, so the model call after a script still reads a warm cache (a
/// chain of direct calls refreshes it at every model call; a script has none
/// inside it). The same as `shell`'s longest timeout.
pub const SCRIPT_TIME_LIMIT: Duration = Duration::from_secs(crate::idle_compaction::PROMPT_CACHE_TTL.as_secs() - 30);
/// Most nested calls one script may make.
pub const MAX_SCRIPT_CALLS: usize = 200;
/// Most characters of logs and return value.
pub const MAX_SCRIPT_OUTPUT: usize = 50_000;
/// Most nested calls listed in the result; the rest are counted.
const MAX_TRACE_LINES: usize = 30;
/// Nested calls a script runs at once.
pub const MAX_CONCURRENT_NESTED: usize = 10;

/// Tools a script may not call, and why.
pub fn refused_in_script(name: &str, args: &Value) -> Option<&'static str> {
    match name {
        SCRIPT_TOOL => Some("a script cannot start another script"),
        "ask_user" | "ask_lead" | "plan" | "update_goal" => Some("it waits on a person or changes the session; call it directly"),
        "team" => Some("delegating runs for longer than a script may; call it directly"),
        "workspace" if args.get("action").and_then(Value::as_str).unwrap_or("send") != "list" => Some("only its 'list' action works in a script; call it directly"),
        _ if crate::confirm::opens(name, &args.to_string()) => Some("it opens a confirmation card; call it directly"),
        _ => None,
    }
}

tokio::task_local! {
    /// Runs one nested call for the `script` call being executed: set by the
    /// agent loop around that call (see `Agent::run_tool_inner`).
    pub static NESTED: HostCallFn;
}

pub struct ScriptTool;

/// Where saved scripts live.
#[derive(Debug, Clone, PartialEq)]
pub struct ScriptDirs {
    /// `<workspace>/.agents/scripts`, in a coding workspace.
    pub project: Option<PathBuf>,
    /// `<config>/scripts`.
    pub personal: PathBuf,
}

impl ScriptDirs {
    pub fn for_ctx(ctx: &ToolContext) -> Self {
        let project = ctx.workspace.as_ref().filter(|w| !w.is_empty()).map(|_| ctx.workspace_root().join(".agents").join("scripts"));
        Self { project, personal: appv3_core::settings().config_dir.join("scripts") }
    }
    fn in_order(&self) -> Vec<&Path> {
        self.project.iter().map(PathBuf::as_path).chain(std::iter::once(self.personal.as_path())).collect()
    }
    /// The file a saved script `name` is in: project first.
    pub fn find(&self, name: &str) -> Option<PathBuf> {
        self.in_order().into_iter().flat_map(|d| [d.join(format!("{name}.ts")), d.join(format!("{name}.js"))]).find(|p| p.is_file())
    }
    /// Where `save_as` writes.
    fn save_dir(&self) -> &Path {
        self.project.as_deref().unwrap_or(&self.personal)
    }
}

/// A saved script's header: `// @description …` and `// @arg name …` lines.
#[derive(Debug, Default, PartialEq)]
pub struct Header {
    pub description: Option<String>,
    pub args: Vec<String>,
}

/// Read the header from the comment lines at the top of `code`.
pub fn parse_header(code: &str) -> Header {
    let mut h = Header::default();
    for line in code.lines().map(str::trim) {
        if line.is_empty() {
            continue;
        }
        let Some(c) = line.strip_prefix("//") else { break };
        let c = c.trim();
        if let Some(d) = c.strip_prefix("@description") {
            h.description = Some(d.trim().to_string()).filter(|d| !d.is_empty());
        } else if let Some(a) = c.strip_prefix("@arg") {
            let a = a.split_whitespace().collect::<Vec<_>>().join(" ");
            if !a.is_empty() {
                h.args.push(a);
            }
        }
    }
    h
}

/// A name `save_as` and `name` accept: 1 to 64 of `a-z`, `0-9` and `-`, not starting with `-`.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && !name.starts_with('-') && name.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

fn list_scripts(dirs: &ScriptDirs) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut out = vec![];
    for (dir, label) in dirs.project.iter().map(|d| (d.as_path(), "project")).chain(std::iter::once((dirs.personal.as_path(), "personal"))) {
        let Ok(rd) = std::fs::read_dir(dir) else { continue };
        let mut files: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_file() && matches!(p.extension().and_then(|e| e.to_str()), Some("ts" | "js"))).collect();
        files.sort();
        for f in files {
            let Some(name) = f.file_stem().and_then(|s| s.to_str()).map(String::from) else { continue };
            if !valid_name(&name) || !seen.insert(name.clone()) {
                continue;
            }
            let h = parse_header(&std::fs::read_to_string(&f).unwrap_or_default());
            let shown = if label == "project" { format!(".agents/scripts/{}", f.file_name().unwrap_or_default().to_string_lossy()) } else { f.display().to_string() };
            let mut entry = format!("- {name} ({label}, {shown}): {}", h.description.as_deref().unwrap_or("no description"));
            for a in &h.args {
                entry.push_str(&format!("\n    arg {a}"));
            }
            out.push(entry);
        }
    }
    if out.is_empty() {
        "No saved scripts. Save one with save_as after it runs without error.".into()
    } else {
        format!("Saved scripts (run with name or path, and args):\n{}", out.join("\n"))
    }
}

/// One nested call, as the trace shows it.
#[derive(Debug, Clone)]
struct CallRecord {
    name: String,
    target: String,
    /// `None` while running.
    end: Option<CallEnd>,
}

#[derive(Debug, Clone)]
enum CallEnd {
    Ok { ms: u128, size: String },
    Failed { error: String },
}

fn clip(s: &str, n: usize) -> String {
    let one_line = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() <= n {
        one_line
    } else {
        format!("{}…", one_line.chars().take(n.saturating_sub(1)).collect::<String>())
    }
}

/// What a nested call works on, in a few words (`"TODO" in crates/agent`).
pub fn call_target(name: &str, args: &Value) -> String {
    let s = |k: &str| args.get(k).and_then(Value::as_str).filter(|v| !v.is_empty());
    let t = match name {
        "grep" => match (s("pattern"), s("directory").filter(|d| *d != ".")) {
            (Some(p), Some(d)) => format!("\"{p}\" in {d}"),
            (Some(p), None) => format!("\"{p}\""),
            _ => String::new(),
        },
        "mcp" => {
            let action = s("action").unwrap_or("call");
            match (s("server"), s("tool"), s("query")) {
                (Some(srv), Some(tool), _) => format!("{action} {srv}/{tool}"),
                (_, _, Some(q)) => format!("{action} \"{q}\""),
                (Some(srv), None, _) => format!("{action} {srv}"),
                _ => action.to_string(),
            }
        }
        _ => ["command", "path", "pattern", "query", "url", "action", "name", "content"].iter().find_map(|k| s(k)).unwrap_or("").to_string(),
    };
    clip(&t, 60)
}

/// `14 lines` / `52 chars`.
fn result_size(text: &str) -> String {
    let lines = text.lines().filter(|l| !l.trim().is_empty()).count();
    if lines > 1 {
        format!("{lines} lines")
    } else {
        format!("{} chars", text.chars().count())
    }
}

impl CallRecord {
    /// The line in the result: `→ grep "TODO" · 41 ms · 11 lines`.
    fn line(&self) -> String {
        let head = if self.target.is_empty() { format!("→ {}", self.name) } else { format!("→ {} {}", self.name, self.target) };
        match &self.end {
            None => format!("{head} · cancelled"),
            Some(CallEnd::Ok { ms, size }) => format!("{head} · {ms} ms · {size}"),
            Some(CallEnd::Failed { error, .. }) => format!("{head} · error: {}", clip(error, 160)),
        }
    }
}

/// The text the model gets: the call trace, then output, then any error.
fn render(outcome: &ScriptOutcome, calls: &[CallRecord], elapsed: Duration, saved: Option<&str>) -> String {
    let mut out = format!("calls ({}, {:.1} s):", calls.len(), elapsed.as_secs_f64());
    for c in calls.iter().take(MAX_TRACE_LINES) {
        out.push('\n');
        out.push_str(&c.line());
    }
    if calls.len() > MAX_TRACE_LINES {
        out.push_str(&format!("\n… {} more", calls.len() - MAX_TRACE_LINES));
    }
    out.push_str("\noutput:");
    let body: Vec<&str> = [outcome.logs.as_str(), outcome.value.as_deref().unwrap_or("")].into_iter().filter(|s| !s.is_empty()).collect();
    if body.is_empty() {
        out.push_str("\n(nothing logged or returned)");
    } else {
        out.push('\n');
        out.push_str(&body.join("\n"));
    }
    if outcome.truncated {
        out.push_str(&format!("\n[output cut at {MAX_SCRIPT_OUTPUT} characters: log less]"));
    }
    if let Some(e) = &outcome.error {
        out.push_str("\nerror: ");
        out.push_str(e);
        if outcome.timed_out {
            out.push_str(". The limit keeps the prompt cache warm. Split the work into smaller scripts, or run long commands with shell background=true and wait=true: their result arrives as a message.");
        }
    }
    if let Some(s) = saved {
        out.push('\n');
        out.push_str(s);
    }
    out
}

enum Source {
    Inline(String),
    File(PathBuf),
    List,
}

fn parse_source(ctx: &ToolContext, args: &Value, dirs: &ScriptDirs) -> Result<Source, ToolError> {
    let s = |k: &str| args.get(k).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty());
    let list = args.get("list").and_then(crate::tools::lax_bool).unwrap_or(false);
    let given = [s("code").is_some(), s("path").is_some(), s("name").is_some(), list].iter().filter(|b| **b).count();
    if given != 1 {
        return Err(ToolError::Argument("Give exactly one of code, path, name or list.".into()));
    }
    if list {
        return Ok(Source::List);
    }
    if let Some(code) = args.get("code").and_then(Value::as_str).filter(|c| !c.trim().is_empty()) {
        return Ok(Source::Inline(code.to_string()));
    }
    if let Some(name) = s("name") {
        if !valid_name(name) {
            return Err(ToolError::Argument(format!("'{name}' is not a script name: use lowercase letters, digits and '-'.")));
        }
        return dirs.find(name).map(Source::File).ok_or_else(|| ToolError::Execution(format!("No saved script named '{name}'. Call script with list: true to see them.")));
    }
    let raw = s("path").unwrap_or_default();
    let resolved = ctx.denied.validate_read_path(raw)?;
    if !resolved.starts_with(&ctx.denied.workspace_root) {
        return Err(ToolError::Execution(format!("'{raw}' is outside the workspace: path runs workspace files only (use name for a personal script).")));
    }
    if !matches!(resolved.extension().and_then(|e| e.to_str()), Some("ts" | "js" | "mts" | "mjs")) {
        return Err(ToolError::Execution(format!("'{raw}' is not a .ts or .js file.")));
    }
    if !resolved.is_file() {
        return Err(ToolError::Execution(format!("File not found: {}", ctx.denied.display_path(&resolved))));
    }
    Ok(Source::File(resolved))
}

/// Shorten a nested `shell` call's timeout to the time the script has left.
fn clamp_shell_timeout(args: &mut Value, left: Duration) {
    let left_s = left.as_secs().max(1);
    let asked = args.get("timeout_seconds").and_then(Value::as_u64).unwrap_or(appv3_tools::shell::DEFAULT_TIMEOUT_SECONDS);
    if asked > left_s {
        if let Some(o) = args.as_object_mut() {
            o.insert("timeout_seconds".into(), Value::from(left_s));
        }
    }
}

#[async_trait]
impl Tool for ScriptTool {
    fn name(&self) -> &str {
        SCRIPT_TOOL
    }

    async fn run(&self, ctx: &ToolContext, args: Value) -> ToolResult {
        let dirs = ScriptDirs::for_ctx(ctx);
        let source = parse_source(ctx, &args, &dirs)?;
        let (code, file) = match source {
            Source::List => return Ok(ToolOutput::text(list_scripts(&dirs))),
            Source::Inline(code) => (code, None),
            Source::File(f) => (std::fs::read_to_string(&f).map_err(|e| ToolError::Execution(format!("Cannot read {}: {e}", f.display())))?, Some(f)),
        };
        let save_as = args.get("save_as").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
        if let Some(n) = save_as {
            if file.is_some() {
                return Err(ToolError::Argument("save_as works with code only; the script is already a file.".into()));
            }
            if !valid_name(n) {
                return Err(ToolError::Argument(format!("save_as '{n}' is not a script name: use 1 to 64 lowercase letters, digits and '-'.")));
            }
        }
        let Ok(runner) = NESTED.try_with(Arc::clone) else {
            return Err(ToolError::Execution("script runs only inside an agent turn".into()));
        };
        let script_args = match args.get("args") {
            None | Some(Value::Null) => Value::Object(Map::new()),
            Some(v @ Value::Object(_)) => v.clone(),
            Some(_) => return Err(ToolError::Argument("args must be an object.".into())),
        };

        let started = Instant::now();
        let deadline = started + SCRIPT_TIME_LIMIT;
        let calls: Arc<Mutex<Vec<CallRecord>>> = Arc::default();
        let sink = ctx.output.clone();
        let trace = calls.clone();
        let host: HostCallFn = Arc::new(move |name: String, mut call_args: Value| -> HostFuture {
            let target = call_target(&name, &call_args);
            let idx = {
                let mut c = trace.lock().unwrap();
                c.push(CallRecord { name: name.clone(), target: target.clone(), end: None });
                c.len()
            };
            if let Some(s) = &sink {
                s(format!("▸ {idx} {name} {target}\n"));
            }
            let (runner, trace, sink) = (runner.clone(), trace.clone(), sink.clone());
            Box::pin(async move {
                let t = Instant::now();
                let result = match refused_in_script(&name, &call_args) {
                    Some(why) => Err(format!("{name} cannot be called from a script: {why}")),
                    None => {
                        if name == "shell" {
                            clamp_shell_timeout(&mut call_args, deadline.saturating_duration_since(Instant::now()));
                        }
                        runner(name, call_args).await
                    }
                };
                let ms = t.elapsed().as_millis();
                let end = match &result {
                    Ok(text) => CallEnd::Ok { ms, size: result_size(text) },
                    Err(e) => CallEnd::Failed { error: e.clone() },
                };
                let line = match &end {
                    CallEnd::Ok { ms, size } => format!("✓ {idx} {ms} ms · {size}\n"),
                    CallEnd::Failed { error, .. } => format!("✗ {idx} error: {}\n", clip(error, 160)),
                };
                if let Some(rec) = trace.lock().unwrap().get_mut(idx - 1) {
                    rec.end = Some(end);
                }
                if let Some(s) = &sink {
                    s(line);
                }
                result
            })
        });
        let limits = ScriptLimits { timeout: SCRIPT_TIME_LIMIT, max_calls: MAX_SCRIPT_CALLS, max_output: MAX_SCRIPT_OUTPUT, ..Default::default() };
        let outcome = run_script(ScriptSource { code: code.clone(), file, args: script_args }, limits, host).await;

        let mut saved = None;
        if let Some(name) = save_as {
            saved = Some(if outcome.error.is_some() {
                "not saved: the script failed".to_string()
            } else if ctx.metadata.lock().unwrap().get("interaction_mode").and_then(Value::as_str) == Some("plan") {
                "not saved: Plan mode cannot write scripts".to_string()
            } else {
                match save_script(&dirs, name, &code, args.get("description").and_then(Value::as_str)) {
                    Ok(p) => format!("saved as {name} ({})", p),
                    Err(e) => format!("not saved: {e}"),
                }
            });
        }
        let records = calls.lock().unwrap().clone();
        Ok(ToolOutput::text(render(&outcome, &records, started.elapsed(), saved.as_deref())))
    }
}

/// Write `code` as script `name`, adding a `@description` line when it has none.
fn save_script(dirs: &ScriptDirs, name: &str, code: &str, description: Option<&str>) -> Result<String, String> {
    let dir = dirs.save_dir();
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    // A TypeScript script keeps working as a `.ts` file, and plain JavaScript is valid TypeScript.
    let path = dir.join(format!("{name}.ts"));
    let mut text = String::new();
    if parse_header(code).description.is_none() {
        if let Some(d) = description.map(str::trim).filter(|d| !d.is_empty()) {
            text.push_str(&format!("// @description {}\n", d.replace('\n', " ")));
        }
    }
    text.push_str(code.trim_end());
    text.push('\n');
    let stale_js = dir.join(format!("{name}.js"));
    appv3_core::secret_files::write_atomic(&path, &text).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    if stale_js.is_file() {
        let _ = std::fs::remove_file(stale_js);
    }
    Ok(if Some(dir) == dirs.project.as_deref() { format!(".agents/scripts/{name}.ts") } else { path.display().to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn headers_come_from_the_leading_comments() {
        let h = parse_header("\n// @description Count TODOs per crate.\n// @arg pattern   Regex to count.\n// plain note\nconst a = 1;\n// @arg late ignored");
        assert_eq!(h, Header { description: Some("Count TODOs per crate.".into()), args: vec!["pattern Regex to count.".into()] });
        assert_eq!(parse_header("const a = 1;"), Header::default());
    }

    #[test]
    fn names_are_plain() {
        for ok in ["count-todos", "a", "x1-2"] {
            assert!(valid_name(ok), "{ok}");
        }
        for no in ["", "-a", "A", "a_b", "a/b", "../x", "a.ts", &"a".repeat(65)] {
            assert!(!valid_name(no), "{no}");
        }
    }

    #[test]
    fn targets_are_short() {
        assert_eq!(call_target("grep", &json!({"pattern": "TODO", "directory": "crates/agent"})), "\"TODO\" in crates/agent");
        assert_eq!(call_target("mcp", &json!({"action": "call", "server": "github", "tool": "list_issues"})), "call github/list_issues");
        assert_eq!(call_target("read", &json!({"path": "a.txt"})), "a.txt");
        assert_eq!(call_target("todo", &json!({})), "");
        assert_eq!(call_target("shell", &json!({"command": "x".repeat(100)})).chars().count(), 60);
    }

    #[test]
    fn refusals_cover_people_delegation_and_recursion() {
        for (name, args) in
            [("script", json!({})), ("ask_user", json!({})), ("plan", json!({})), ("team", json!({})), ("update_goal", json!({})), ("workspace", json!({"action": "send"}))]
        {
            assert!(refused_in_script(name, &args).is_some(), "{name}");
        }
        assert!(refused_in_script("workspace", &json!({"action": "list"})).is_none());
        assert!(refused_in_script("grep", &json!({})).is_none());
    }

    #[test]
    fn shell_timeouts_shrink_to_the_time_left() {
        let mut a = json!({"command": "sleep 1000"});
        clamp_shell_timeout(&mut a, Duration::from_secs(30));
        assert_eq!(a["timeout_seconds"], 30);
        let mut a = json!({"command": "x", "timeout_seconds": 5});
        clamp_shell_timeout(&mut a, Duration::from_secs(30));
        assert_eq!(a["timeout_seconds"], 5);
    }

    #[test]
    fn the_result_lists_calls_then_output_then_the_error() {
        let calls = vec![
            CallRecord { name: "glob".into(), target: "*.toml".into(), end: Some(CallEnd::Ok { ms: 8, size: "14 lines".into() }) },
            CallRecord { name: "read".into(), target: "x".into(), end: Some(CallEnd::Failed { error: "File not found: x".into() }) },
            CallRecord { name: "mcp".into(), target: "call a/b".into(), end: None },
        ];
        let o = ScriptOutcome {
            logs: "hi".into(),
            value: Some("42".into()),
            error: Some("stopped after 270 s, the time limit of a script".into()),
            timed_out: true,
            ..Default::default()
        };
        let text = render(&o, &calls, Duration::from_millis(1800), None);
        assert!(
            text.starts_with(
                "calls (3, 1.8 s):\n→ glob *.toml · 8 ms · 14 lines\n→ read x · error: File not found: x\n→ mcp call a/b · cancelled\noutput:\nhi\n42\nerror: stopped after 270 s"
            ),
            "{text}"
        );
        assert!(text.contains("shell background=true"), "{text}");
        // The closed row's summary is read back from this text.
        assert_eq!(appv3_db::api::script_run("script", &text), Some(serde_json::json!({"calls": 3, "stopped": true})));
        let many: Vec<CallRecord> = (0..35).map(|i| CallRecord { name: "read".into(), target: i.to_string(), end: Some(CallEnd::Ok { ms: 1, size: "1 chars".into() }) }).collect();
        let text = render(&ScriptOutcome::default(), &many, Duration::ZERO, Some("saved as x (.agents/scripts/x.ts)"));
        assert!(text.contains("\n… 5 more\noutput:\n(nothing logged or returned)\nsaved as x"), "{text}");
        assert_eq!(appv3_db::api::script_run("script", &text), Some(serde_json::json!({"calls": 35, "saved": "x"})));
    }

    #[test]
    fn the_time_limit_stays_under_the_prompt_cache_lifetime() {
        assert!(SCRIPT_TIME_LIMIT < crate::idle_compaction::PROMPT_CACHE_TTL);
        assert_eq!(SCRIPT_TIME_LIMIT.as_secs(), appv3_tools::shell::MAX_TIMEOUT_SECONDS);
    }
}
