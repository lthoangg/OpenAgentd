//! `agentd plugin list`: the installed plugins and their state, from the
//! running server when there is one, else from the plugin folders.

use super::render::{blank, emit, exact, heading, ind, inline, note, pad, plural, sp, verdict, Line, Tone};
use super::server::{state_tone, strings, text_of, Api, Reply};
use super::{installed, Ctx, Installed};
use crate::net::http_get_with_headers;
use anyhow::Result;
use appv3_plugins::disabled;
use serde_json::Value;
use std::collections::BTreeSet;
use std::process::ExitCode;
use std::time::Duration;

const LIST_TIMEOUT: Duration = Duration::from_secs(10);

/// One plugin bundle of `list`.
#[derive(Debug, PartialEq, Eq)]
struct Row {
    name: String,
    version: Option<String>,
    enabled: bool,
    state: String,
    skills: usize,
    mcp_servers: usize,
    /// `None`: the plugin has code, which only a server runs.
    tools: Option<usize>,
    errors: Vec<String>,
    warnings: Vec<String>,
}

impl Row {
    fn version_text(&self) -> String {
        self.version.as_deref().map(|v| inline(v, 40)).filter(|v| !v.is_empty()).unwrap_or_else(|| "-".to_string())
    }

    fn counts(&self) -> String {
        let tools = self.tools.map_or_else(|| "has code".to_string(), |n| plural(n, "tool", "tools"));
        format!("{}, {}, {tools}", plural(self.skills, "skill", "skills"), plural(self.mcp_servers, "MCP server", "MCP servers"))
    }
}

/// A plugin of one file (`*.ts` / `*.js`), the kind that came before bundles.
#[derive(Debug, PartialEq, Eq)]
struct SingleFile {
    file: String,
    status: String,
    detail: String,
    errors: Vec<String>,
}

fn server_row(b: &Value) -> Row {
    let count = |key: &str| b.get(key).and_then(Value::as_array).map_or(0, Vec::len);
    Row {
        name: b.get("name").and_then(Value::as_str).unwrap_or("?").to_string(),
        version: b.get("version").and_then(Value::as_str).map(str::to_string),
        enabled: b.get("enabled").and_then(Value::as_bool).unwrap_or(true),
        state: text_of(b, "state"),
        skills: count("skills"),
        mcp_servers: count("mcp_servers"),
        tools: Some(count("tools")),
        errors: strings(b.get("errors")),
        warnings: strings(b.get("warnings")),
    }
}

fn disk_rows(items: &[Installed], off: &BTreeSet<String>) -> Vec<Row> {
    items
        .iter()
        .map(|i| match &i.bundle {
            Ok(b) => Row {
                name: b.name.clone(),
                version: b.version.clone(),
                enabled: !off.contains(&b.name),
                state: "valid".to_string(),
                skills: b.skills.len(),
                mcp_servers: b.mcp_servers.len(),
                tools: if b.code.is_some() { None } else { Some(0) },
                errors: vec![],
                warnings: b.warnings.clone(),
            },
            Err(why) => Row {
                name: i.folder_name(),
                version: None,
                enabled: !off.contains(&i.folder_name()),
                state: "invalid".to_string(),
                skills: 0,
                mcp_servers: 0,
                tools: Some(0),
                errors: vec![why.clone()],
                warnings: vec![],
            },
        })
        .collect()
}

fn render_rows(rows: &[Row]) -> Vec<Line> {
    let width = |f: fn(&Row) -> usize| rows.iter().map(f).max().unwrap_or(0);
    let (names, versions, states) = (width(|r| exact(&r.name).chars().count()), width(|r| r.version_text().chars().count()), width(|r| r.state.chars().count()));
    let mut out = vec![];
    for r in rows {
        let tone = match r.state.as_str() {
            "valid" => Tone::Good,
            "invalid" => Tone::Bad,
            other => state_tone(other).0,
        };
        let switch = if r.enabled { sp(Tone::Good, pad("enabled", 8)) } else { sp(Tone::Dim, pad("disabled", 8)) };
        out.push(vec![
            ind(2),
            sp(Tone::Bold, pad(&exact(&r.name), names)),
            ind(2),
            sp(Tone::Dim, pad(&r.version_text(), versions)),
            ind(2),
            switch,
            ind(2),
            sp(tone, pad(&inline(&r.state, 40), states)),
            ind(2),
            sp(Tone::Dim, r.counts()),
        ]);
        out.extend(r.errors.iter().map(|e| note(4, Tone::Bad, "✗", e)));
        out.extend(r.warnings.iter().map(|w| note(4, Tone::Warn, "⚠", w)));
    }
    out
}

fn render_single_files(files: &[SingleFile]) -> Vec<Line> {
    if files.is_empty() {
        return vec![];
    }
    let width = files.iter().map(|f| exact(&f.file).chars().count()).max().unwrap_or(0);
    let status = files.iter().map(|f| f.status.chars().count()).max().unwrap_or(0);
    let mut out = vec![blank(), heading("Single-file plugins")];
    for f in files {
        let tone = match f.status.as_str() {
            "loaded" => Tone::Good,
            "error" => Tone::Bad,
            _ => Tone::Dim,
        };
        out.push(vec![ind(4), sp(Tone::Bold, pad(&exact(&f.file), width)), ind(2), sp(tone, pad(&f.status, status)), ind(2), sp(Tone::Dim, inline(&f.detail, 120))]);
        out.extend(f.errors.iter().map(|e| note(6, Tone::Bad, "✗", e)));
    }
    out
}

/// The "Plugins" of a running server: `GET /api/plugins`.
fn server_view(body: &Value, at: &str) -> Vec<Line> {
    let mut out = vec![vec![ind(2), sp(Tone::Bold, "Plugins"), ind(2), sp(Tone::Dim, format!("from the server at {at}"))], blank()];
    match body.get("bundles").and_then(Value::as_array) {
        None => out.push(vec![ind(2), sp(Tone::Dim, "This server does not report plugin bundles.")]),
        Some(list) if list.is_empty() => out.push(vec![ind(2), sp(Tone::Dim, "No plugin is installed. Add one with: agentd plugin add <folder or git URL>")]),
        Some(list) => out.extend(render_rows(&list.iter().map(server_row).collect::<Vec<_>>())),
    }
    let files: Vec<SingleFile> = body
        .get("plugins")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|p| {
                    let mut detail = vec![];
                    if let Some(id) = p.get("provider").and_then(Value::as_str) {
                        detail.push(format!("provider {id}"));
                    }
                    let hooks = strings(p.get("hooks"));
                    if !hooks.is_empty() {
                        detail.push(format!("hooks {}", hooks.join(", ")));
                    }
                    SingleFile {
                        file: p.get("file").and_then(Value::as_str).unwrap_or("?").to_string(),
                        status: text_of(p, "status"),
                        detail: detail.join("; "),
                        errors: strings(p.get("errors")),
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    out.extend(render_single_files(&files));
    let python = body.get("unported").and_then(Value::as_array).map(|a| a.iter().filter_map(|p| p.get("file").and_then(Value::as_str)).collect::<Vec<_>>()).unwrap_or_default();
    if !python.is_empty() {
        out.push(blank());
        out.push(heading("Not loaded"));
        out.extend(python.iter().map(|f| vec![ind(4), sp(Tone::Dim, format!("{}  Python plugins are not supported", exact(f)))]));
    }
    let dirs = strings(body.get("dirs"));
    if !dirs.is_empty() {
        out.push(blank());
        out.push(vec![ind(2), sp(Tone::Dim, format!("Folders  {}", dirs.iter().map(|d| exact(d)).collect::<Vec<_>>().join(", ")))]);
    }
    out
}

/// Why `list` shows the disk instead of a server looked for at `addr`.
fn disk_reason(reply: &Reply, find_error: Option<&str>, addr: &str) -> Line {
    match (reply, find_error) {
        (_, Some(e)) => verdict(Tone::Warn, "⚠", &format!("{}; showing what is on disk", inline(e, 200))),
        (Reply::Denied { key_sent: false }, _) => verdict(Tone::Warn, "⚠", "The server needs an access key — set OPENAGENTD_ACCESS_KEY to see its view; showing what is on disk"),
        (Reply::Denied { key_sent: true }, _) => {
            verdict(Tone::Warn, "⚠", "The server did not accept the access key — set OPENAGENTD_ACCESS_KEY to its key to see its view; showing what is on disk")
        }
        (Reply::NotFound, _) => vec![ind(2), sp(Tone::Dim, "This server does not report plugins; showing what is on disk")],
        (Reply::Failed(status), _) => verdict(Tone::Warn, "⚠", &format!("The server answered HTTP {status}; showing what is on disk")),
        _ => vec![ind(2), sp(Tone::Dim, format!("No server answered at {addr}; showing what is on disk"))],
    }
}

/// The plugin folders as they are on disk: manifests are read, no code runs.
fn disk_view(ctx: &Ctx, reason: Line) -> Vec<Line> {
    let items = installed(&ctx.dirs, &ctx.data_root);
    let rows = disk_rows(&items, &disabled(&ctx.config_dir));
    let mut out = vec![vec![ind(2), sp(Tone::Bold, "Plugins")], reason, blank()];
    if rows.is_empty() {
        out.push(vec![ind(2), sp(Tone::Dim, "No plugin is installed. Add one with: agentd plugin add <folder or git URL>")]);
    }
    out.extend(render_rows(&rows));
    if rows.iter().any(|r| r.tools.is_none()) {
        out.push(blank());
        out.push(vec![ind(2), sp(Tone::Dim, "Tools come from plugin code, which only a running server loads.")]);
    }
    let files: Vec<SingleFile> = appv3_jsplugin::plugin_files(&ctx.dirs)
        .iter()
        .map(|f| SingleFile {
            file: f.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            status: "not loaded".to_string(),
            detail: "loaded when the server starts".to_string(),
            errors: vec![],
        })
        .collect();
    out.extend(render_single_files(&files));
    out.push(blank());
    out.push(vec![ind(2), sp(Tone::Dim, format!("Folders  {}", ctx.dirs.iter().map(|d| exact(&d.to_string_lossy())).collect::<Vec<_>>().join(", ")))]);
    out
}

pub(super) fn list() -> Result<ExitCode> {
    let ctx = Ctx::new();
    let api = Api::find();
    let reply = match &api {
        Ok(api) => api.call(http_get_with_headers, "/api/plugins", LIST_TIMEOUT),
        Err(_) => Reply::Down,
    };
    let mut out = vec![blank()];
    match (&reply, &api) {
        (Reply::Json(body), Ok(api)) => out.extend(server_view(body, &api.address())),
        _ => {
            let addr = api.as_ref().map(Api::address).unwrap_or_default();
            out.extend(disk_view(&ctx, disk_reason(&reply, api.as_ref().err().map(|e| format!("{e:#}")).as_deref(), &addr)))
        }
    }
    out.push(blank());
    emit(&out);
    Ok(ExitCode::SUCCESS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cmd::plugin::testing::{demo_plugin, put, text};
    use appv3_plugins::PLUGIN_SCHEMA;
    use serde_json::json;

    #[test]
    fn the_server_view_lists_bundles_with_state_counts_and_problems() {
        let body = json!({
            "dirs": ["/cfg/plugins"],
            "plugins": [
                {"name": "scrub", "file": "scrub.ts", "path": "/cfg/plugins/scrub.ts", "status": "loaded", "provider": null, "hooks": ["tool.after"], "errors": []},
                {"name": "bad", "file": "bad.ts", "path": "/cfg/plugins/bad.ts", "status": "error", "provider": null, "hooks": [], "errors": ["bad.ts:1:5: Unexpected token"]},
                {"name": "acme", "file": "acme.ts", "path": "/cfg/plugins/acme.ts", "status": "loaded", "provider": "acme", "hooks": [], "errors": []}
            ],
            "unported": [{"name": "old", "file": "old.py", "path": "/cfg/plugins/old.py"}],
            "bundles": [
                {"name": "changelog-tools", "version": "1.2.0", "description": "d", "path": "/p", "enabled": true, "state": "running",
                 "errors": [], "warnings": ["plugin.json: unknown field 'x' ignored"],
                 "skills": [{"name": "changelog-tools/release-notes", "description": "d"}],
                 "mcp_servers": [{"name": "changelog-tools/echo", "transport": "stdio", "command": "x", "args": [], "url": null}],
                 "tools": [{"name": "changelog-tools/a", "description": "d", "read_only": true}, {"name": "changelog-tools/b", "description": "d", "read_only": false}],
                 "permissions": null, "has_code": true},
                {"name": "review-kit", "version": null, "enabled": false, "state": "disabled", "errors": [], "warnings": [], "skills": [], "mcp_servers": [], "tools": []},
                {"name": "broken", "version": "0.1.0", "enabled": true, "state": "failed", "errors": ["start mcp: boom\u{1b}[2J"], "warnings": [], "skills": [], "mcp_servers": [], "tools": []}
            ]
        });
        assert_eq!(
            text(&server_view(&body, "127.0.0.1:4082")),
            [
                "  Plugins  from the server at 127.0.0.1:4082",
                "",
                "  changelog-tools  1.2.0  enabled   running   1 skill, 1 MCP server, 2 tools",
                "    ⚠ plugin.json: unknown field 'x' ignored",
                "  review-kit       -      disabled  disabled  0 skills, 0 MCP servers, 0 tools",
                "  broken           0.1.0  enabled   failed    0 skills, 0 MCP servers, 0 tools",
                "    ✗ start mcp: boom [2J",
                "",
                "  Single-file plugins",
                "    scrub.ts  loaded  hooks tool.after",
                "    bad.ts    error",
                "      ✗ bad.ts:1:5: Unexpected token",
                "    acme.ts   loaded  provider acme",
                "",
                "  Not loaded",
                "    old.py  Python plugins are not supported",
                "",
                "  Folders  /cfg/plugins",
            ]
        );
    }

    #[test]
    fn a_server_without_bundles_or_with_none_says_so() {
        let old = json!({"dirs": [], "plugins": [], "unported": []});
        assert_eq!(text(&server_view(&old, "h:1")), ["  Plugins  from the server at h:1", "", "  This server does not report plugin bundles."]);
        let none = json!({"dirs": ["/d"], "plugins": [], "unported": [], "bundles": []});
        assert_eq!(
            text(&server_view(&none, "h:1")),
            ["  Plugins  from the server at h:1", "", "  No plugin is installed. Add one with: agentd plugin add <folder or git URL>", "", "  Folders  /d"]
        );
    }

    #[test]
    fn the_disk_view_reads_manifests_and_marks_what_is_off() {
        let dir = tempfile::tempdir().unwrap();
        let plugins = dir.path().join("plugins");
        demo_plugin(&plugins.join("demo"));
        put(&plugins.join("demo"), "dev.openagentd/plugin.ts", "export default {}");
        put(&plugins.join("broken"), "plugin.json", "{ not json");
        put(&plugins.join("plain"), "plugin.json", &json!({"$schema": PLUGIN_SCHEMA, "name": "plain", "version": "0.1.0"}).to_string());
        put(&plugins.join(".agentd-add-staging"), "plugin.json", "{}");
        let items = installed(std::slice::from_ref(&plugins), &dir.path().join("data"));
        let off = BTreeSet::from(["demo".to_string(), "broken".to_string()]);
        let lines = text(&render_rows(&disk_rows(&items, &off)));
        assert_eq!(lines.len(), 5, "{lines:#?}");
        assert_eq!(lines[0], "  broken  -      disabled  invalid  0 skills, 0 MCP servers, 0 tools");
        assert!(lines[1].starts_with("    ✗ plugin.json: is not valid JSON"), "{}", lines[1]);
        assert_eq!(lines[2], "  demo    1.2.3  disabled  valid    1 skill, 2 MCP servers, has code");
        assert_eq!(lines[3], "    ⚠ plugin.json: unknown field 'mystery' ignored");
        assert_eq!(lines[4], "  plain   0.1.0  enabled   valid    0 skills, 0 MCP servers, 0 tools");
    }

    #[test]
    fn the_reason_for_showing_the_disk_is_told() {
        let why = |reply: Reply, err: Option<&str>| text(&[disk_reason(&reply, err, "127.0.0.1:4082")]).remove(0);
        assert_eq!(why(Reply::Down, None), "  No server answered at 127.0.0.1:4082; showing what is on disk");
        assert!(why(Reply::Denied { key_sent: false }, None).contains("OPENAGENTD_ACCESS_KEY"));
        assert!(why(Reply::Denied { key_sent: true }, None).contains("did not accept"));
        assert!(why(Reply::NotFound, None).contains("does not report plugins"));
        assert!(why(Reply::Failed(502), None).contains("HTTP 502"));
        assert!(why(Reply::Down, Some("read server.yaml: bad")).contains("read server.yaml: bad"));
    }
}
