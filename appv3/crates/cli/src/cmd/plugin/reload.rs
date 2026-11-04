//! Asking a running server to reload its plugins after `add`, `remove`,
//! `enable` or `disable`, and saying what came of it.

use super::render::{exact, ind, inline, note, sp, verdict, Line, Tone};
use super::server::{state_tone, strings, text_of, Api, Reply};
use crate::net::{http_post_with_headers, is_port_reachable};
use crate::ui::dim;
use serde_json::Value;
use std::time::Duration;

/// A reload restarts the plugins that changed, which can start MCP servers.
const RELOAD_TIMEOUT: Duration = Duration::from_secs(90);

impl Api {
    /// Asks the server to reload its plugins; `Down` when it is not running.
    fn reload(&self) -> Reply {
        if !is_port_reachable(&self.host, self.port) {
            return Reply::Down;
        }
        println!("  {}", dim("Reloading the server's plugins..."));
        self.call(http_post_with_headers, "/api/plugins/reload", RELOAD_TIMEOUT)
    }
}

/// The bundle `name` in a `/api/plugins` body.
fn bundle_named<'a>(body: &'a Value, name: &str) -> Option<&'a Value> {
    body.get("bundles")?.as_array()?.iter().find(|b| b.get("name").and_then(Value::as_str) == Some(name))
}

/// What happened to the plugin that the reload is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Change {
    /// Installed: the server should now run it.
    Added,
    /// Deleted: the server should not list it.
    Removed,
    /// Turned on in `plugins.json`: reported like `Added`.
    Enabled,
    /// Turned off in `plugins.json`: still listed, in state `disabled`.
    Disabled,
}

impl Change {
    /// What a server that picks the change up by itself does, and what a stopped one does at its next start.
    fn on_its_own(self) -> (&'static str, &'static str) {
        match self {
            Change::Added => ("loads the plugin on its own when the folder changes", "loads it when it next starts"),
            Change::Removed => ("drops the plugin on its own when the folder changes", "drops it when it next starts"),
            Change::Enabled => ("turns the plugin on on its own when plugins.json changes", "turns it on when it next starts"),
            Change::Disabled => ("turns the plugin off on its own when plugins.json changes", "leaves it off when it next starts"),
        }
    }

    fn later(self) -> &'static str {
        match self {
            Change::Added | Change::Enabled => "it loads the plugin when it next starts",
            Change::Removed => "it drops the plugin when it next starts",
            Change::Disabled => "it leaves the plugin off when it next starts",
        }
    }
}

/// What the server said after `add`, `remove`, `enable` or `disable` (`change`)
/// asked it to reload; `addr` is where it was looked for.
fn reload_lines(reply: &Reply, name: &str, change: Change, addr: &str) -> Vec<Line> {
    let later = change.later();
    let (own, stopped) = change.on_its_own();
    let say = |tone: Tone, glyph: &str, text: String| vec![verdict(tone, glyph, &text)];
    match reply {
        // Nothing at the configured address does not mean no server runs: the
        // desktop app's listens on a port of its own, and its shell gets no
        // token to ask it. Its config watcher sees the folder change anyway.
        Reply::Down => vec![vec![ind(2), sp(Tone::Dim, format!("No server answered at {addr}. One on another port, such as the desktop app's, {own}; a stopped one {stopped}."))]],
        Reply::NotFound => vec![vec![ind(2), sp(Tone::Dim, format!("This server cannot reload plugins; {later}."))]],
        Reply::Denied { key_sent: false } => say(Tone::Warn, "⚠", format!("The server needs an access key — set OPENAGENTD_ACCESS_KEY to reload it; {later}.")),
        Reply::Denied { key_sent: true } => say(Tone::Warn, "⚠", format!("The server did not accept the access key — set OPENAGENTD_ACCESS_KEY to its key to reload it; {later}.")),
        Reply::Failed(status) => say(Tone::Warn, "⚠", format!("The server could not reload its plugins (HTTP {status}); {later}.")),
        Reply::Json(body) => match (bundle_named(body, name), change) {
            (None, Change::Removed) => say(Tone::Good, "✓", format!("Server: reloaded; {} is gone", exact(name))),
            (Some(b), Change::Removed) => {
                say(Tone::Warn, "⚠", format!("The server still lists {} (state: {}); it may come from another plugin folder", exact(name), inline(&text_of(b, "state"), 40)))
            }
            // A disabled bundle is still listed, in state "disabled".
            (None, Change::Disabled) => say(Tone::Good, "✓", format!("Server: reloaded; {} is off", exact(name))),
            (Some(b), Change::Disabled) => {
                let state = text_of(b, "state");
                if state == "disabled" {
                    say(Tone::Good, "✓", format!("Server: reloaded; {} is off", exact(name)))
                } else {
                    say(Tone::Warn, "⚠", format!("The server reloaded but still reports {} as {}; see `agentd server logs`", exact(name), inline(&state, 40)))
                }
            }
            (None, Change::Added | Change::Enabled) => say(Tone::Warn, "⚠", format!("The server reloaded but does not list {}; see `agentd server logs`", exact(name))),
            (Some(b), Change::Added | Change::Enabled) => {
                let state = text_of(b, "state");
                let errors = strings(b.get("errors"));
                let (mut tone, mut glyph, mut label) = (state_tone(&state).0, state_tone(&state).1, inline(&state, 40));
                // The code failing leaves the skills and MCP servers running: not a plain success.
                if state == "running" && !errors.is_empty() {
                    (tone, glyph) = (Tone::Warn, "⚠");
                    label.push_str(", with errors");
                }
                let mut out = say(tone, glyph, format!("Server: {label}"));
                out.extend(errors.iter().map(|e| note(5, Tone::Bad, "✗", e)));
                out.extend(strings(b.get("warnings")).iter().map(|w| note(5, Tone::Warn, "⚠", w)));
                out
            }
        },
    }
}

/// Whether the server will give new sessions what the plugin adds.
fn will_load(reply: &Reply, name: &str) -> bool {
    match reply {
        Reply::Json(body) => bundle_named(body, name).is_none_or(|b| !matches!(text_of(b, "state").as_str(), "failed" | "blocked" | "disabled")),
        _ => true,
    }
}

/// Asks the running server to reload its plugins and says what came of it;
/// `true` when new sessions will get the plugin (now, or when the server
/// next starts).
pub(super) fn reload_server(name: &str, change: Change) -> (Vec<Line>, bool) {
    match Api::find() {
        Ok(api) => {
            let reply = api.reload();
            (reload_lines(&reply, name, change, &api.address()), will_load(&reply, name))
        }
        Err(e) => (vec![verdict(Tone::Warn, "⚠", &format!("{}; the server picks the change up when it next starts", inline(&format!("{e:#}"), 200)))], true),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cmd::plugin::testing::text;
    use serde_json::json;

    #[test]
    fn after_an_install_the_server_says_what_became_of_the_plugin() {
        let reloaded = |bundle: Value| Reply::Json(json!({"bundles": [bundle]}));
        let say = |reply: &Reply, removed| text(&reload_lines(reply, "demo", if removed { Change::Removed } else { Change::Added }, "127.0.0.1:4082"));
        // Run from the desktop app's shell, the CLI cannot see that server (another port, no
        // token): it must not claim no server is running.
        assert_eq!(
            say(&Reply::Down, false),
            ["  No server answered at 127.0.0.1:4082. One on another port, such as the desktop app's, loads the plugin on its own when the folder changes; a stopped one loads it when it next starts."]
        );
        assert_eq!(
            say(&Reply::Down, true),
            ["  No server answered at 127.0.0.1:4082. One on another port, such as the desktop app's, drops the plugin on its own when the folder changes; a stopped one drops it when it next starts."]
        );
        assert_eq!(say(&Reply::NotFound, false), ["  This server cannot reload plugins; it loads the plugin when it next starts."]);
        assert!(say(&Reply::Denied { key_sent: false }, false)[0].contains("needs an access key — set OPENAGENTD_ACCESS_KEY"));
        assert!(say(&Reply::Denied { key_sent: true }, false)[0].contains("did not accept the access key"));
        assert!(say(&Reply::Failed(500), false)[0].contains("HTTP 500"));

        let running = reloaded(json!({"name": "demo", "state": "running", "errors": [], "warnings": ["w\u{1b}[2Jx"]}));
        assert_eq!(say(&running, false), ["  ✓  Server: running", "     ⚠ w [2Jx"]);
        let failed = reloaded(json!({"name": "demo", "state": "failed", "errors": ["start mcp: boom"], "warnings": []}));
        assert_eq!(say(&failed, false), ["  ✗  Server: failed", "     ✗ start mcp: boom"]);
        // Running, but its code did not load: not a plain success.
        let partly = reloaded(json!({"name": "demo", "state": "running", "errors": ["dev.openagentd/plugin.ts: boom"], "warnings": []}));
        assert_eq!(say(&partly, false), ["  ⚠  Server: running, with errors", "     ✗ dev.openagentd/plugin.ts: boom"]);
        assert!(will_load(&partly, "demo"), "the skills and MCP servers still load");
        assert!(say(&reloaded(json!({"name": "demo", "state": "blocked", "errors": ["needs mcp"]})), false)[0].starts_with("  ⚠  Server: blocked"));
        assert!(say(&reloaded(json!({"name": "other", "state": "running"})), false)[0].contains("does not list demo"));
        assert!(say(&reloaded(json!({"name": "other", "state": "running"})), true)[0].contains("demo is gone"));
        assert!(say(&running, true)[0].contains("still lists demo"));

        assert!(will_load(&Reply::Down, "demo") && will_load(&Reply::NotFound, "demo") && will_load(&running, "demo"));
        assert!(will_load(&reloaded(json!({"name": "other", "state": "failed"})), "demo"));
        assert!(!will_load(&failed, "demo"));
        assert!(!will_load(&reloaded(json!({"name": "demo", "state": "disabled"})), "demo"));
    }

    #[test]
    fn after_a_disable_the_server_lists_the_plugin_as_off() {
        let reloaded = |bundle: Value| Reply::Json(json!({"bundles": [bundle]}));
        let say = |reply: &Reply, change| text(&reload_lines(reply, "demo", change, "127.0.0.1:4082"));
        let off = reloaded(json!({"name": "demo", "state": "disabled", "enabled": false}));
        assert_eq!(say(&off, Change::Disabled), ["  ✓  Server: reloaded; demo is off"]);
        assert_eq!(say(&Reply::Json(json!({"bundles": []})), Change::Disabled), ["  ✓  Server: reloaded; demo is off"]);
        let on = reloaded(json!({"name": "demo", "state": "running", "errors": []}));
        assert_eq!(say(&on, Change::Disabled), ["  ⚠  The server reloaded but still reports demo as running; see `agentd server logs`"]);
        assert_eq!(say(&on, Change::Enabled), say(&on, Change::Added));
        assert_eq!(
            say(&Reply::Down, Change::Disabled),
            ["  No server answered at 127.0.0.1:4082. One on another port, such as the desktop app's, turns the plugin off on its own when plugins.json changes; a stopped one leaves it off when it next starts."]
        );
        assert_eq!(
            say(&Reply::Down, Change::Enabled),
            ["  No server answered at 127.0.0.1:4082. One on another port, such as the desktop app's, turns the plugin on on its own when plugins.json changes; a stopped one turns it on when it next starts."]
        );
        assert_eq!(say(&Reply::NotFound, Change::Disabled), ["  This server cannot reload plugins; it leaves the plugin off when it next starts."]);
    }
}
