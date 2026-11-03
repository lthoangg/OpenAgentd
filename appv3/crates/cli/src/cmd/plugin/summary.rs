//! What a plugin asks for, as the user sees it before installing: the
//! summary of its manifest, and what its code reports when it is loaded once
//! with nothing granted.

use super::render::{blank, clip, exact, heading, ind, inline, item, note, pad, shell_word, sp, Line, Tone};
use super::server::strings;
use appv3_jsplugin::{JsPlugin, LoadOptions, Sandbox};
use appv3_plugins::{data_dir_name, Bundle, Net, Permissions, Transport};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::Path;
use std::sync::OnceLock;

/// Variables the plugin loader sets itself for MCP servers; not the user's.
const OWN_VARIABLES: [&str; 2] = ["PLUGIN_ROOT", "PLUGIN_DATA"];

/// The names of the user's variables that a server's `env` or headers refer
/// to (`$NAME`, `${NAME}`). The MCP manager fills them in from the
/// environment and the stored credentials, so a plugin can hand one to a
/// process or a remote server.
fn referenced_variables(t: &Transport) -> Vec<String> {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)").expect("a valid pattern"));
    let values: Vec<&String> = match t {
        Transport::Stdio { env, .. } => env.values().collect(),
        Transport::Http { headers, .. } => headers.values().collect(),
    };
    let mut out: Vec<String> = vec![];
    for value in values {
        for caps in re.captures_iter(value) {
            let name = caps.get(1).or_else(|| caps.get(2)).map_or("", |m| m.as_str());
            if !OWN_VARIABLES.contains(&name) && !out.iter().any(|o| o == name) {
                out.push(name.to_string());
            }
        }
    }
    out
}

/// What the code asks to be allowed; empty for nothing.
fn permission_items(p: &Permissions) -> Vec<String> {
    let list = |items: Vec<String>| items.iter().map(|i| exact(i)).collect::<Vec<_>>().join(", ");
    let mut out = vec![];
    match &p.net {
        Net::None => {}
        Net::Any => out.push("net: any host".to_string()),
        Net::Hosts(hosts) => out.push(format!("net: {}", list(hosts.clone()))),
    }
    if p.listen {
        out.push("listen: a local port (loopback only)".to_string());
    }
    if !p.fs.is_empty() {
        out.push(format!("fs: {} (read and write)", list(p.fs.iter().map(|d| d.to_string_lossy().into_owned()).collect())));
    }
    if !p.subprocess.is_empty() {
        out.push(format!("subprocess: {}", list(p.subprocess.clone())));
    }
    if !p.env.is_empty() {
        out.push(format!("env: {}", list(p.env.clone())));
    }
    out
}

/// Name, version, description, skills, MCP servers with their exact
/// commands, permissions, and warnings. With `installed_at`, paths inside the
/// plugin show where it will be installed rather than where it is staged.
pub(super) fn summary(b: &Bundle, installed_at: Option<&Path>) -> Vec<Line> {
    let root = b.root.to_string_lossy().into_owned();
    let mapped = |s: &str| match installed_at {
        Some(to) => s.replace(&root, &to.to_string_lossy()),
        None => s.to_string(),
    };
    let word = |s: &str| exact(&shell_word(&mapped(s)));

    let mut out = vec![blank()];
    let version = b.version.as_deref().map(|v| inline(v, 40)).filter(|v| !v.is_empty()).unwrap_or_else(|| "no version".to_string());
    out.push(vec![ind(2), sp(Tone::Bold, exact(&b.name)), ind(2), sp(Tone::Dim, version)]);
    if let Some(d) = b.description.as_deref().map(|d| inline(d, 300)).filter(|d| !d.is_empty()) {
        out.push(vec![ind(2), sp(Tone::Plain, d)]);
    }
    out.push(blank());

    out.push(heading("Skills"));
    if b.skills.is_empty() {
        out.push(item(Tone::Dim, "none"));
    }
    out.extend(b.skills.iter().map(|s| item(Tone::Plain, exact(&s.name))));

    out.push(heading("MCP servers"));
    if b.mcp_servers.is_empty() {
        out.push(item(Tone::Dim, "none"));
    }
    if b.mcp_servers.iter().any(|s| matches!(s.transport, Transport::Stdio { .. })) {
        out.push(item(Tone::Warn, "MCP servers run as local processes with your user's permissions and are not sandboxed, so check the commands."));
    }
    if b.mcp_servers.iter().any(|s| matches!(s.transport, Transport::Http { .. })) {
        out.push(item(Tone::Warn, "HTTP servers are remote: they see every call the agent makes to them."));
    }
    for server in &b.mcp_servers {
        let what = match &server.transport {
            Transport::Stdio { command, args, .. } => std::iter::once(command).chain(args).map(|w| word(w)).collect::<Vec<_>>().join(" "),
            Transport::Http { url, .. } => exact(&mapped(url)),
        };
        out.push(vec![ind(4), sp(Tone::Bold, exact(&server.name)), ind(2), sp(Tone::Plain, what)]);
        // What the plugin sets for the server, as written: `PATH` or `NODE_OPTIONS` change what the command runs.
        let (label, own): (&str, Vec<String>) = match &server.transport {
            Transport::Stdio { env, .. } => ("env", env.iter().filter(|(k, _)| !OWN_VARIABLES.contains(&k.as_str())).map(|(k, v)| format!("{k}={}", mapped(v))).collect()),
            Transport::Http { headers, .. } => ("headers", headers.iter().map(|(k, v)| format!("{k}: {}", mapped(v))).collect()),
        };
        if !own.is_empty() {
            let shown = own.iter().map(|p| clip(&exact(p), 120)).collect::<Vec<_>>().join(", ");
            out.push(vec![ind(6), sp(Tone::Dim, format!("{label}  ")), sp(Tone::Plain, shown)]);
        }
        let vars = referenced_variables(&server.transport);
        if !vars.is_empty() {
            let names = vars.iter().map(|v| exact(v)).collect::<Vec<_>>().join(", ");
            out.push(vec![ind(6), sp(Tone::Warn, "⚠"), sp(Tone::Plain, format!(" receives your {names} (from your environment or credentials)"))]);
        }
    }

    out.push(heading("Permissions"));
    let asked = permission_items(&b.permissions);
    if asked.is_empty() {
        out.push(item(Tone::Dim, "none"));
    }
    out.extend(asked.into_iter().map(|p| item(Tone::Plain, p)));

    if !b.warnings.is_empty() {
        out.push(heading("Warnings"));
        out.extend(b.warnings.iter().map(|w| note(4, Tone::Warn, "⚠", w)));
    }
    out
}

// ── the plugin's code, loaded with nothing granted ──────────────────────────

struct ToolInfo {
    name: String,
    description: String,
    read_only: bool,
}

pub(super) struct CodeReport {
    tools: Vec<ToolInfo>,
    /// Hook names (`tool.before`, ...).
    hooks: Vec<String>,
    /// The id of the model provider the code declares.
    provider: Option<String>,
    /// What the code itself reported, plus schema problems.
    pub(super) warnings: Vec<String>,
}

/// `tool NAME: input property 'P' has no description` (the plugin runtime's
/// wording) as the `NAME.P: no description` that `schema_problems` gives for
/// the same fact.
fn already_reported(warning: &str) -> Option<String> {
    let rest = warning.strip_prefix("tool ")?;
    let (name, rest) = rest.split_once(": input property '")?;
    let property = rest.strip_suffix("' has no description")?;
    Some(format!("{name}.{property}: no description"))
}

fn code_report(plugin: &JsPlugin) -> CodeReport {
    let tools: Vec<ToolInfo> = plugin.tools().iter().map(|t| ToolInfo { name: t.name.clone(), description: t.description.clone(), read_only: t.read_only }).collect();
    let hooks = strings(plugin.describe.pointer("/default/hooks"));
    let provider = plugin.describe.pointer("/default/provider/id").and_then(Value::as_str).map(str::to_string);
    let mut warnings = plugin.warnings().to_vec();
    // The tool definition as a model is given it: what a provider adapter would drop shows here.
    let known: HashSet<String> = warnings.iter().filter_map(|w| already_reported(w)).collect();
    for t in plugin.tools() {
        let definition = json!({"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.input_schema}});
        warnings.extend(appv3_tools::schema_problems(&definition).into_iter().filter(|p| !known.contains(p)));
    }
    CodeReport { tools, hooks, provider, warnings }
}

/// Loads the plugin's code once with [`Permissions::default`]: it may read
/// its own files and use a scratch data folder, and nothing else. `None`
/// when the plugin has no code.
pub(super) fn load_code(b: &Bundle, scratch: &Path) -> Option<Result<CodeReport, String>> {
    let code = b.code.as_ref()?;
    let sandbox = Sandbox { plugin: b.name.clone(), root: b.root.clone(), data_dir: scratch.join(data_dir_name(&b.name)), permissions: Permissions::default() };
    Some(JsPlugin::load_with(code, LoadOptions { sandbox: Some(sandbox) }).map(|p| code_report(&p)))
}

pub(super) fn code_lines(code: &Result<CodeReport, String>) -> Vec<Line> {
    let title = vec![ind(2), sp(Tone::Bold, "Tools"), ind(2), sp(Tone::Dim, "(the code ran once, with no permissions)")];
    let report = match code {
        Ok(r) => r,
        Err(why) => return vec![title, note(4, Tone::Bad, "✗", &format!("the code failed to load: {why}"))],
    };
    let mut out = vec![title];
    if report.tools.is_empty() {
        out.push(item(Tone::Dim, "none"));
    }
    let width = report.tools.iter().map(|t| t.name.chars().count()).max().unwrap_or(0);
    for t in &report.tools {
        let kind = if t.read_only { "read-only" } else { "" };
        out.push(vec![ind(4), sp(Tone::Bold, pad(&exact(&t.name), width)), ind(2), sp(Tone::Dim, pad(kind, 9)), ind(2), sp(Tone::Plain, inline(&t.description, 100))]);
    }
    if !report.hooks.is_empty() {
        out.push(vec![ind(2), sp(Tone::Bold, "Hooks"), ind(2), sp(Tone::Dim, "(they run around the agent's tool calls)")]);
        out.push(item(Tone::Plain, report.hooks.iter().map(|h| exact(h)).collect::<Vec<_>>().join(", ")));
    }
    if let Some(id) = &report.provider {
        out.push(vec![ind(2), sp(Tone::Bold, "Provider"), ind(2), sp(Tone::Dim, "(a model provider: it receives the conversation)")]);
        out.push(item(Tone::Plain, exact(id)));
    }
    out.extend(report.warnings.iter().map(|w| note(4, Tone::Warn, "⚠", w)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cmd::plugin::testing::{demo_plugin, put, text};
    use appv3_plugins::{load, PLUGIN_SCHEMA};

    #[test]
    fn the_summary_shows_what_the_plugin_asks_for_and_its_exact_commands() {
        let d = tempfile::tempdir().unwrap();
        demo_plugin(d.path());
        let data = tempfile::tempdir().unwrap();
        let bundle = load(d.path(), data.path()).unwrap();
        let root = bundle.root.to_string_lossy().into_owned();
        let data_dir = bundle.data_dir.to_string_lossy().into_owned();
        let lines = text(&summary(&bundle, None));
        let expected = vec![
            String::new(),
            "  demo  1.2.3".to_string(),
            "  Demo [31m plugin with two lines".to_string(),
            String::new(),
            "  Skills".to_string(),
            "    helper".to_string(),
            "  MCP servers".to_string(),
            "    MCP servers run as local processes with your user's permissions and are not sandboxed, so check the commands.".to_string(),
            "    HTTP servers are remote: they see every call the agent makes to them.".to_string(),
            format!("    local  npx -y @acme/server --label 'two words' 'it'\\''s' {root}/data"),
            format!("      env  API_KEY=${{GITHUB_TOKEN}}, MODE=fast, OTHER=$OTHER_VAR and {data_dir}"),
            "      ⚠ receives your GITHUB_TOKEN, OTHER_VAR (from your environment or credentials)".to_string(),
            "    remote  https://mcp.example.com/api".to_string(),
            "      headers  Authorization: Bearer ${REMOTE_KEY}".to_string(),
            "      ⚠ receives your REMOTE_KEY (from your environment or credentials)".to_string(),
            "  Permissions".to_string(),
            "    net: api.example.com, *.example.org".to_string(),
            "    listen: a local port (loopback only)".to_string(),
            "    fs: /tmp/oad-shared (read and write)".to_string(),
            "    subprocess: git".to_string(),
            "    env: HOME, TOKEN".to_string(),
            "  Warnings".to_string(),
            "    ⚠ plugin.json: unknown field 'mystery' ignored".to_string(),
        ];
        assert_eq!(lines, expected);
    }

    #[test]
    fn the_summary_names_the_final_path_not_the_staging_one() {
        let d = tempfile::tempdir().unwrap();
        demo_plugin(d.path());
        let data = tempfile::tempdir().unwrap();
        let bundle = load(d.path(), data.path()).unwrap();
        let lines = text(&summary(&bundle, Some(Path::new("/plugins/demo"))));
        assert!(lines.contains(&"    local  npx -y @acme/server --label 'two words' 'it'\\''s' /plugins/demo/data".to_string()), "{lines:#?}");
        assert!(!lines.iter().any(|l| l.contains(&bundle.root.to_string_lossy().into_owned())));
    }

    #[test]
    fn a_plugin_that_asks_for_nothing_says_so() {
        let d = tempfile::tempdir().unwrap();
        put(d.path(), "plugin.json", &json!({"$schema": PLUGIN_SCHEMA, "name": "empty"}).to_string());
        let data = tempfile::tempdir().unwrap();
        let lines = text(&summary(&load(d.path(), data.path()).unwrap(), None));
        assert_eq!(lines, ["", "  empty  no version", "", "  Skills", "    none", "  MCP servers", "    none", "  Permissions", "    none"]);
    }

    #[test]
    fn permissions_name_every_kind() {
        assert!(permission_items(&Permissions::default()).is_empty());
        let any = Permissions { net: Net::Any, ..Default::default() };
        assert_eq!(permission_items(&any), ["net: any host"]);
    }

    // ── the code check ──────────────────────────────────────────────────────

    fn code_plugin(root: &Path, code: &str, permissions: Value) {
        let manifest = json!({"$schema": PLUGIN_SCHEMA, "name": "coder", "extensions": {"dev.openagentd": {"permissions": permissions}}});
        put(root, "plugin.json", &manifest.to_string());
        put(root, "dev.openagentd/plugin.ts", code);
    }

    fn run_code(code: &str, permissions: Value) -> Result<CodeReport, String> {
        let d = tempfile::tempdir().unwrap();
        code_plugin(d.path(), code, permissions);
        let data = tempfile::tempdir().unwrap();
        let bundle = load(d.path(), data.path()).unwrap();
        let scratch = tempfile::tempdir().unwrap();
        let report = load_code(&bundle, scratch.path()).expect("the plugin has code");
        // The data folder the code was given is scratch, not the plugin's real one.
        assert!(!bundle.data_dir.exists());
        report
    }

    #[test]
    fn the_code_check_lists_tools_hooks_and_schema_problems_once() {
        let code = r#"
import { defineTool } from "openagentd";
export default {
  tools: [
    defineTool({
      name: "draft", description: "Draft notes.", readOnly: true,
      input: { type: "object", properties: { since: { type: "string" }, meta: { type: "object", description: "Extra.", additionalProperties: false } } },
      run: () => "ok",
    }),
    defineTool({ name: "ship", description: "Ship it.", input: { type: "object", properties: {} }, run: () => "ok" }),
  ],
  hooks: { "tool.before": () => {} },
};
"#;
        let report = run_code(code, json!({})).unwrap();
        let names: Vec<(&str, bool)> = report.tools.iter().map(|t| (t.name.as_str(), t.read_only)).collect();
        assert_eq!(names, [("draft", true), ("ship", false)]);
        assert_eq!(report.hooks, ["tool.before"]);
        assert_eq!(report.provider, None);
        // The missing description is reported by the runtime and by the schema check: once.
        assert_eq!(report.warnings, ["tool draft: input property 'since' has no description", "draft.meta: uses 'additionalProperties', which a provider adapter drops"]);
    }

    #[test]
    fn the_code_check_runs_with_no_permissions_even_when_the_manifest_grants_some() {
        let code = r#"
import { env } from "openagentd";
env.get("TOKEN");
export default { tools: [] };
"#;
        let e = run_code(code, json!({"env": ["TOKEN"]})).err().expect("the load must fail");
        assert!(e.contains("may not read the environment variable TOKEN"), "{e}");
        // Without that line the same plugin loads.
        assert!(run_code("export default { tools: [] };", json!({"env": ["TOKEN"]})).unwrap().tools.is_empty());
    }

    #[test]
    fn code_that_throws_fails_the_check() {
        let e = run_code("throw new Error(\"boom at load\");", json!({})).err().expect("the load must fail");
        assert!(e.contains("boom at load"), "{e}");
        let lines = text(&code_lines(&Err(e)));
        assert_eq!(lines[0], "  Tools  (the code ran once, with no permissions)");
        assert!(lines[1].starts_with("    ✗ the code failed to load: ") && lines[1].contains("boom at load"), "{lines:?}");
    }

    #[test]
    fn the_tools_section_lines_up_and_cleans_descriptions() {
        let tool = |name: &str, description: &str, read_only| ToolInfo { name: name.into(), description: description.into(), read_only };
        let report = CodeReport {
            tools: vec![tool("draft", "Draft notes.\u{1b}[2J", true), tool("publish_all", "Publish.", false)],
            hooks: vec!["tool.before".into(), "tool.after".into()],
            provider: Some("acme".into()),
            warnings: vec!["tool x: input property 'y' has no description".into()],
        };
        assert_eq!(
            text(&code_lines(&Ok(report))),
            [
                "  Tools  (the code ran once, with no permissions)",
                "    draft        read-only  Draft notes. [2J",
                "    publish_all             Publish.",
                "  Hooks  (they run around the agent's tool calls)",
                "    tool.before, tool.after",
                "  Provider  (a model provider: it receives the conversation)",
                "    acme",
                "    ⚠ tool x: input property 'y' has no description",
            ]
        );
        let none = CodeReport { tools: vec![], hooks: vec![], provider: None, warnings: vec![] };
        assert_eq!(text(&code_lines(&Ok(none))), ["  Tools  (the code ran once, with no permissions)", "    none"]);
    }

    #[test]
    fn a_missing_description_is_recognised_in_both_wordings() {
        assert_eq!(already_reported("tool draft: input property 'since' has no description").as_deref(), Some("draft.since: no description"));
        assert_eq!(already_reported("tool draft: something else"), None);
        assert_eq!(already_reported("draft.since: no description"), None);
    }
}
