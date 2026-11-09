//! `agentd doctor`: credentials, database, port, and agents checks, then the
//! modules of the local server when it is running.

use crate::net::{display_host, http_get_with_headers, resolve_addr};
use crate::paths::find_pids;
use crate::ui::{self, dim, tilde, tilde_text, Checks};
use anyhow::Result;
use appv3_core::runtime_settings::ServerYaml;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

/// Lead-agent providers that need neither an API key nor an OAuth login.
const KEYLESS_PROVIDERS: &[&str] = &["vertexai", "cliproxy", "router9", "ollama"];

/// Longest wait for the module list; a running server answers at once.
const MODULES_TIMEOUT: Duration = Duration::from_secs(2);

/// `(provider id, API key variable)` in catalog order.
fn provider_key_vars() -> Vec<(String, String)> {
    appv3_providers::catalog::builtin_providers()
        .iter()
        .filter_map(|e| {
            let var = e.get("env_var").and_then(|v| v.as_str()).filter(|s| !s.is_empty())?;
            Some((e["id"].as_str().unwrap_or("").to_string(), var.to_string()))
        })
        .collect()
}

/// Where a provider's key comes from: the exported environment or the store.
fn key_source(provider: &str, var: &str) -> Option<&'static str> {
    if appv3_core::credentials::env_override(var).is_some() {
        return Some("environment");
    }
    appv3_core::credentials::stored(Some(provider), var).map(|_| "credentials.yaml")
}

fn md_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
    let mut v: Vec<_> = rd.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "md")).collect();
    v.sort();
    v
}

/// Provider prefix of the lead agent's `model:` (`code.md`, else the first agent).
fn read_lead_provider(agents_dir: &Path) -> Option<String> {
    let candidates = md_files(agents_dir);
    let lead = agents_dir.join("code.md");
    let target = if lead.is_file() { lead } else { candidates.first()?.clone() };
    let text = std::fs::read_to_string(target).ok()?;
    let mut lines = text.lines().map(str::trim);
    if lines.next()? != "---" {
        return None;
    }
    let model = lines.take_while(|l| *l != "---").find_map(|l| l.strip_prefix("model:"))?;
    let (provider, _) = model.trim().trim_matches(['"', '\'']).split_once(':')?;
    Some(provider.trim().to_string()).filter(|p| !p.is_empty())
}

/// Accounts of the builtin OAuth provider `p` that hold a login (copilot
/// also counts an exported GitHub token).
fn oauth_accounts(p: &str) -> usize {
    let stored = appv3_core::credentials::snapshot().enabled(p).iter().filter(|c| c.has_secret()).count();
    stored + usize::from(p == "copilot" && appv3_providers::copilot::env_github_token().is_some())
}

/// How a line of the Modules section is drawn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mark {
    /// A ✓ check.
    Ok,
    /// A ⚠ check.
    Warn,
    /// A ✗ check.
    Fail,
    /// Dim text, not a check.
    Dim,
}

/// The Modules section: lines under its title, then an optional dim note
/// (the module counts, or why there is no list).
#[derive(Debug, PartialEq, Eq)]
struct ModulesSection {
    lines: Vec<(Mark, String)>,
    note: Option<String>,
}

impl ModulesSection {
    fn note_only(text: &str) -> Self {
        Self { lines: vec![], note: Some(text.into()) }
    }

    fn warning_only(text: impl Into<String>) -> Self {
        Self { lines: vec![(Mark::Warn, text.into())], note: None }
    }
}

/// `s` on one line: control characters and runs of whitespace become one space.
fn one_line(s: &str) -> String {
    s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The string field `key` of `m` on one line, or `missing` when it is absent
/// or blank.
fn text_field(m: &Value, key: &str, missing: &str) -> String {
    let text = m.get(key).and_then(Value::as_str).map(one_line).unwrap_or_default();
    if text.is_empty() {
        missing.to_string()
    } else {
        text
    }
}

/// `16 modules, 14 running, 1 failed, 1 blocked`: failed, blocked, stopped
/// and pending only when there are any, any other state as `other`.
fn module_counts(states: &[&str]) -> String {
    let count = |state: &str| states.iter().filter(|s| **s == state).count();
    let total = states.len();
    let mut out = format!("{total} module{}, {} running", if total == 1 { "" } else { "s" }, count("running"));
    let mut named = count("running");
    for state in ["failed", "blocked", "stopped", "pending"] {
        let n = count(state);
        if n > 0 {
            out += &format!(", {n} {state}");
            named += n;
        }
    }
    if total > named {
        out += &format!(", {} other", total - named);
    }
    out
}

/// One line per module of a `GET /api/modules` body, then the module counts;
/// `None` when the body holds no module list. A running module is a ✓, a
/// failed one a ✗ and a blocked one a ⚠ (both with the server's reason);
/// any other state is dim.
fn module_lines(body: &Value) -> Option<ModulesSection> {
    let modules = body.get("modules")?.as_array()?;
    let rows: Vec<(String, String, String)> = modules.iter().map(|m| (text_field(m, "id", "?"), text_field(m, "state", "unknown"), text_field(m, "error", ""))).collect();
    let width = rows.iter().map(|(id, ..)| id.chars().count()).max().unwrap_or(0);
    let lines = rows
        .iter()
        .map(|(id, state, why)| {
            let (mark, reason) = match state.as_str() {
                "running" => (Mark::Ok, ""),
                "failed" => (Mark::Fail, why.as_str()),
                "blocked" => (Mark::Warn, why.as_str()),
                _ => (Mark::Dim, ""),
            };
            let because = if reason.is_empty() { String::new() } else { format!(" — {reason}") };
            (mark, format!("{id:<width$}  {state}{because}"))
        })
        .collect();
    let states: Vec<&str> = rows.iter().map(|(_, state, _)| state.as_str()).collect();
    Some(ModulesSection { lines, note: Some(module_counts(&states)) })
}

/// The section for the server's answer to `GET /api/modules`: `None` when
/// nothing answered, `key_sent` when the request carried an access key.
fn modules_section(answer: Option<(u16, &[u8])>, key_sent: bool) -> ModulesSection {
    match answer {
        None => ModulesSection::note_only("Start the server to see its modules."),
        Some((200, body)) => {
            serde_json::from_slice::<Value>(body).ok().as_ref().and_then(module_lines).unwrap_or_else(|| ModulesSection::warning_only("The server's module list could not be read"))
        }
        Some((401, _)) if key_sent => ModulesSection::warning_only("The server did not accept the access key — set OPENAGENTD_ACCESS_KEY to its key to see its modules"),
        Some((401, _)) => ModulesSection::warning_only("The server needs an access key — set OPENAGENTD_ACCESS_KEY to see its modules"),
        Some((404, _)) => ModulesSection::note_only("This server does not report modules."),
        Some((status, _)) => ModulesSection::warning_only(format!("Could not list the server's modules (HTTP {status})")),
    }
}

/// All running: one ✓ line instead of one per module. Anything else is
/// listed in full, so the module that needs a look stands out.
fn collapsed(section: ModulesSection) -> ModulesSection {
    let all_ok = !section.lines.is_empty() && section.lines.iter().all(|(m, _)| *m == Mark::Ok);
    if !all_ok {
        return section;
    }
    let n = section.lines.len();
    ModulesSection { lines: vec![(Mark::Ok, format!("{n} of {n} modules running"))], note: None }
}

/// The Modules section: the local server's modules and their state, or why
/// they are not listed. Its lines count in the summary and the exit code
/// like any other check.
fn report_modules(checks: &mut Checks, cfg: &ServerYaml) {
    let (host, port) = resolve_addr(None, None, cfg);
    // The key the server enforces: desktop token, then OPENAGENTD_ACCESS_KEY,
    // then server.yaml.
    let key = appv3_core::auth::configured_access_token();
    let bearer = format!("Bearer {key}");
    let headers: Vec<(&str, &str)> = if key.is_empty() { vec![] } else { vec![("Authorization", bearer.as_str())] };
    let answer = http_get_with_headers(&display_host(&host), port, "/api/modules", &headers, MODULES_TIMEOUT);
    let section = collapsed(modules_section(answer.as_ref().map(|(status, body)| (*status, body.as_slice())), !key.is_empty()));
    ui::section("Modules");
    for (mark, text) in &section.lines {
        match mark {
            Mark::Ok => checks.ok(text),
            Mark::Warn => checks.warn(text),
            Mark::Fail => checks.fail(text),
            Mark::Dim => println!("  {}  {}", dim("·"), dim(text)),
        }
    }
    if let Some(note) = &section.note {
        // Under the checks' text, or flush with the title when there are none.
        let indent = if section.lines.is_empty() { "  " } else { "     " };
        println!("{indent}{}", dim(note));
    }
}

/// Whether a newer agentd is out. An update is a warning; a failed check
/// (offline, a mirror down) is only a dim note.
fn report_update(checks: &mut Checks) {
    let current = appv3_core::VERSION;
    let latest = tokio::runtime::Builder::new_current_thread().enable_all().build().ok().and_then(|rt| {
        rt.block_on(async {
            let client = reqwest::Client::builder().user_agent(format!("openagentd/{current}")).timeout(UPDATE_TIMEOUT).build().ok()?;
            crate::cmd::self_update::latest_version(&client, &appv3_core::release::releases_base()).await.ok()
        })
    });
    match latest {
        Some(v) if appv3_core::release::is_newer(&v, current) => {
            let how = if appv3_core::release::is_desktop_bundled(&appv3_core::release::current_exe()) { "update the desktop app" } else { "run `agentd upgrade`" };
            checks.warn(&format!("agentd v{v} is out (this is v{current}) — {how}"));
        }
        Some(_) => checks.ok(&format!("agentd v{current} is the latest release")),
        None => ui::mark_line(&ui::idle_mark(), &dim("Could not check for a newer release")),
    }
}

/// Longest wait for the latest-release lookup.
const UPDATE_TIMEOUT: Duration = Duration::from_secs(3);

pub fn doctor() -> Result<ExitCode> {
    // Non-secret settings may still come from a dotenv file; provider keys
    // live in credentials.yaml.
    appv3_core::env::init_env();
    let s = appv3_core::settings();
    appv3_core::env::load_config_env(&s.config_dir);
    crate::cmd::auth::migrate_first();
    crate::dotenv::migrate();

    ui::header("agentd doctor", &format!("v{}", appv3_core::VERSION));
    let mut checks = Checks::default();
    println!("  {}", ui::bold("Config"));

    // Provider credentials.
    match appv3_core::credentials::load() {
        Ok(f) => {
            let n: usize = f.providers.values().map(Vec::len).sum();
            if n > 0 || appv3_core::credentials::path().exists() {
                checks.ok(&format!("Credentials: {}  ({n} stored)", tilde(&appv3_core::credentials::path())));
            }
        }
        Err(e) => checks.fail(&format!("{e}")),
    }
    let ignored = appv3_providers::credentials_migration::ignored_dotenv_credentials();
    if !ignored.is_empty() {
        checks.warn(&format!("Ignored provider keys from a .env file: {}", ignored.join(", ")));
        println!("     {}", dim("Add them in Settings → Providers, or run `agentd credentials import <file>`"));
    }
    for n in appv3_core::env::env_notices() {
        checks.warn(&tilde_text(&n));
    }
    // Database.
    if s.database_path.exists() {
        checks.ok(&format!("Database: {}", tilde(&s.database_path)));
    } else {
        checks.warn(&format!("Database not found: {}  (created on first start)", tilde(&s.database_path)));
    }
    // Agents.
    if !md_files(&s.agents_dir).is_empty() {
        checks.ok(&format!("Agents: {}", tilde(&s.agents_dir)));
    } else {
        checks.fail(&format!("Agents not found: {}  (start the server to restore the defaults)", tilde(&s.agents_dir)));
    }

    ui::section("Providers");
    let key_vars = provider_key_vars();
    let lead = read_lead_provider(&s.agents_dir);
    let mut found: Vec<&str> = vec![];
    for (id, var) in key_vars.iter().map(|(p, v)| (p.as_str(), v.as_str())).chain([("vertexai", "VERTEXAI_API_KEY")]) {
        if let Some(src) = key_source(id, var) {
            let n = appv3_core::credentials::snapshot().enabled(id).len();
            let more = if src == "credentials.yaml" && n > 1 { format!(", {n} keys") } else { String::new() };
            checks.ok(&format!("API key: {var}  ({src}{more})"));
            found.push(var);
        }
    }
    let lead_oauth = lead.as_deref().filter(|p| appv3_providers::oauth::is_builtin(p));
    let lead_keyless = lead.as_deref().is_some_and(|p| KEYLESS_PROVIDERS.contains(&p));
    if found.is_empty() && lead_oauth.is_none() && !lead_keyless {
        if lead.is_none() {
            checks.warn("No agents configured — cannot verify provider credentials");
        } else {
            checks.fail("No LLM provider API key configured");
            let names: Vec<&str> = key_vars.iter().map(|(_, v)| v.as_str()).collect();
            println!("     {}", dim(&format!("Add one in Settings → Providers, or export one of: {}", names.join(", "))));
        }
    }
    if let Some(p) = lead_oauth {
        let n = oauth_accounts(p);
        if n > 0 {
            let more = if n > 1 { format!(" ({n} accounts)") } else { String::new() };
            checks.ok(&format!("Lead agent provider '{p}' is logged in{more}"));
        } else {
            checks.fail(&format!("Lead agent provider '{p}' is not logged in — run `agentd auth {p}`"));
        }
    } else if let Some(p) = lead.as_deref() {
        if lead_keyless {
            checks.ok(&format!("Lead agent provider '{p}' needs no API key"));
        } else {
            match key_vars.iter().find(|(id, _)| id == p).map(|(_, v)| v.as_str()) {
                None => checks.warn(&format!("Lead agent uses an unknown provider: {p}")),
                Some(k) if found.contains(&k) => checks.ok(&format!("Lead agent key is set: {k}")),
                Some(k) => checks.fail(&format!("Lead agent uses '{p}' but {k} is not set")),
            }
        }
    }

    ui::section("Server");
    let server = crate::net::server_settings();
    match &server {
        Err(e) => checks.fail(&format!("{e:#}")),
        Ok(cfg) => {
            let (_, port) = resolve_addr(None, None, cfg);
            let running = find_pids();
            if !running.is_empty() {
                let pids: Vec<String> = running.iter().map(|p| p.to_string()).collect();
                checks.ok(&format!("Port {port}: used by the running server (pid {})", pids.join(", ")));
            } else if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
                checks.ok(&format!("Port {port} is available"));
            } else {
                checks.warn(&format!("Port {port} is in use by another process"));
            }
        }
    }

    report_update(&mut checks);

    // Modules of the running server.
    if let Ok(cfg) = &server {
        report_modules(&mut checks, cfg);
    }

    println!();
    println!("  {}", checks.summary());
    println!();
    Ok(if checks.failures > 0 { ExitCode::FAILURE } else { ExitCode::SUCCESS })
}

#[cfg(test)]
mod tests {
    use super::{collapsed, module_lines, modules_section, read_lead_provider, Mark, ModulesSection};
    use serde_json::{json, Value};

    #[test]
    fn lead_provider_comes_from_code_md_frontmatter() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_lead_provider(dir.path()), None);
        std::fs::write(dir.path().join("a.md"), "---\nname: a\nmodel: \"anthropic:claude\"\n---\nbody\n").unwrap();
        assert_eq!(read_lead_provider(dir.path()).as_deref(), Some("anthropic"));
        std::fs::write(dir.path().join("code.md"), "---\r\nname: code\r\nmodel: openai:gpt-5.5\r\n---\r\nbody model: x:y\r\n").unwrap();
        assert_eq!(read_lead_provider(dir.path()).as_deref(), Some("openai"));
        std::fs::write(dir.path().join("code.md"), "no frontmatter\nmodel: openai:gpt\n").unwrap();
        assert_eq!(read_lead_provider(dir.path()), None);
    }

    fn module(id: &str, state: &str, error: Option<&str>) -> Value {
        json!({"id": id, "deps": [], "critical": false, "state": state, "error": error, "start_ms": 0.4})
    }

    fn section(modules: &[Value]) -> ModulesSection {
        module_lines(&json!({ "modules": modules })).expect("a module list")
    }

    fn line(mark: Mark, text: &str) -> (Mark, String) {
        (mark, text.to_string())
    }

    #[test]
    fn running_modules_are_ok_checks_aligned_on_the_longest_id() {
        let s = section(&[module("workspace", "running", None), module("restart_resume", "running", None)]);
        assert_eq!(s.lines, [line(Mark::Ok, "workspace       running"), line(Mark::Ok, "restart_resume  running")]);
        assert_eq!(s.note.as_deref(), Some("2 modules, 2 running"));
    }

    #[test]
    fn a_failed_module_is_an_error_with_its_reason_on_one_line() {
        let s = section(&[module("mcp", "failed", Some("spawn foo:\nNo such file\t(os error 2)")), module("lsp", "failed", None)]);
        assert_eq!(s.lines, [line(Mark::Fail, "mcp  failed — spawn foo: No such file (os error 2)"), line(Mark::Fail, "lsp  failed")]);
        assert_eq!(s.note.as_deref(), Some("2 modules, 0 running, 2 failed"));
    }

    #[test]
    fn a_blocked_module_is_a_warning_naming_what_it_waits_for() {
        let s = section(&[module("mcp", "failed", Some("bad config")), module("scheduler", "blocked", Some("needs mcp, which is failed"))]);
        assert_eq!(s.lines[1], line(Mark::Warn, "scheduler  blocked — needs mcp, which is failed"));
        assert_eq!(s.note.as_deref(), Some("2 modules, 0 running, 1 failed, 1 blocked"));
    }

    #[test]
    fn other_states_are_dim_and_show_no_reason() {
        let s = section(&[module("lsp", "pending", None), module("mcp", "stopped", Some("not shown")), module("foo", "starting", None)]);
        assert_eq!(s.lines, [line(Mark::Dim, "lsp  pending"), line(Mark::Dim, "mcp  stopped"), line(Mark::Dim, "foo  starting")]);
    }

    #[test]
    fn the_summary_counts_modules_by_state() {
        let running: Vec<Value> = (0..16).map(|i| module(&format!("m{i}"), "running", None)).collect();
        assert_eq!(section(&running).note.as_deref(), Some("16 modules, 16 running"));
        assert_eq!(section(&running[..1]).note.as_deref(), Some("1 module, 1 running"));
        assert_eq!(section(&[]).note.as_deref(), Some("0 modules, 0 running"));
        let mixed = section(&[
            module("a", "running", None),
            module("b", "failed", Some("x")),
            module("c", "blocked", Some("y")),
            module("d", "stopped", None),
            module("e", "pending", None),
            module("f", "starting", None),
        ]);
        assert_eq!(mixed.note.as_deref(), Some("6 modules, 1 running, 1 failed, 1 blocked, 1 stopped, 1 pending, 1 other"));
    }

    #[test]
    fn all_running_modules_fold_into_one_line() {
        let all = collapsed(section(&[module("lsp", "running", None), module("mcp", "running", None)]));
        assert_eq!((all.lines, all.note), (vec![line(Mark::Ok, "2 of 2 modules running")], None));
        let mixed = collapsed(section(&[module("lsp", "running", None), module("mcp", "failed", Some("x"))]));
        assert_eq!(mixed.lines.len(), 2, "a failure lists every module");
        assert_eq!(mixed.note.as_deref(), Some("2 modules, 1 running, 1 failed"));
        let none = collapsed(ModulesSection::note_only("Start the server to see its modules."));
        assert_eq!((none.lines.len(), none.note.as_deref()), (0, Some("Start the server to see its modules.")));
    }

    #[test]
    fn a_reason_cannot_smuggle_terminal_escapes() {
        let s = section(&[module("mcp", "failed", Some("a\u{1b}[31mb\r\n\tc"))]);
        assert_eq!(s.lines, [line(Mark::Fail, "mcp  failed — a [31mb c")]);
        assert!(!s.lines[0].1.chars().any(char::is_control));
    }

    #[test]
    fn odd_entries_do_not_break_the_section() {
        let s = section(&[json!({"state": "running"}), json!({"id": "x"}), json!(7)]);
        assert_eq!(s.lines, [line(Mark::Ok, "?  running"), line(Mark::Dim, "x  unknown"), line(Mark::Dim, "?  unknown")]);
        assert_eq!(s.note.as_deref(), Some("3 modules, 1 running, 2 other"));
        for body in [json!({"modules": "nope"}), json!({}), json!([])] {
            assert_eq!(module_lines(&body), None, "{body}");
        }
    }

    #[test]
    fn the_servers_answer_decides_what_the_section_says() {
        let body = br#"{"modules": [{"id": "lsp", "state": "running", "error": null}]}"#;
        let listed = modules_section(Some((200, body)), false);
        assert_eq!((listed.lines, listed.note.as_deref()), (vec![line(Mark::Ok, "lsp  running")], Some("1 module, 1 running")));

        let none = modules_section(None, false);
        assert_eq!((none.lines.len(), none.note.as_deref()), (0, Some("Start the server to see its modules.")));
        let old = modules_section(Some((404, b"{}")), true);
        assert_eq!((old.lines.len(), old.note.as_deref()), (0, Some("This server does not report modules.")));

        for key_sent in [false, true] {
            let s = modules_section(Some((401, b"{}")), key_sent);
            assert_eq!((s.lines.len(), s.lines[0].0, s.note), (1, Mark::Warn, None));
            assert!(s.lines[0].1.contains("OPENAGENTD_ACCESS_KEY"), "{:?}", s.lines);
        }
        assert!(modules_section(Some((401, b"")), false).lines[0].1.contains("needs an access key"));
        assert!(modules_section(Some((401, b"")), true).lines[0].1.contains("did not accept the access key"));

        let broken = modules_section(Some((500, b"boom")), false);
        assert_eq!((broken.lines[0].0, broken.lines[0].1.contains("HTTP 500")), (Mark::Warn, true));
        for body in [&b"not json"[..], b"{}", br#"{"modules": 3}"#] {
            assert_eq!(modules_section(Some((200, body)), false).lines[0].0, Mark::Warn, "{}", String::from_utf8_lossy(body));
        }
    }
}
