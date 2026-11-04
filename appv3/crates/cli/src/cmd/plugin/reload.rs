//! Asking a running server to reload its plugins after `add` or `remove`,
//! and saying what came of it.

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

/// What the server said after `add` (or, with `removed`, `remove`) asked it
/// to reload; `addr` is where it was looked for.
fn reload_lines(reply: &Reply, name: &str, removed: bool, addr: &str) -> Vec<Line> {
    let later = if removed { "it drops the plugin when it next starts" } else { "it loads the plugin when it next starts" };
    let verb = if removed { "drops" } else { "loads" };
    let say = |tone: Tone, glyph: &str, text: String| vec![verdict(tone, glyph, &text)];
    match reply {
        // Nothing at the configured address does not mean no server runs: the
        // desktop app's listens on a port of its own, and its shell gets no
        // token to ask it. Its config watcher sees the folder change anyway.
        Reply::Down => vec![vec![
            ind(2),
            sp(
                Tone::Dim,
                format!("No server answered at {addr}. One on another port, such as the desktop app's, {verb} the plugin on its own when the folder changes; a stopped one {verb} it when it next starts."),
            ),
        ]],
        Reply::NotFound => vec![vec![ind(2), sp(Tone::Dim, format!("This server cannot reload plugins; {later}."))]],
        Reply::Denied { key_sent: false } => say(Tone::Warn, "⚠", format!("The server needs an access key — set OPENAGENTD_ACCESS_KEY to reload it; {later}.")),
        Reply::Denied { key_sent: true } => say(Tone::Warn, "⚠", format!("The server did not accept the access key — set OPENAGENTD_ACCESS_KEY to its key to reload it; {later}.")),
        Reply::Failed(status) => say(Tone::Warn, "⚠", format!("The server could not reload its plugins (HTTP {status}); {later}.")),
        Reply::Json(body) => match (bundle_named(body, name), removed) {
            (None, true) => say(Tone::Good, "✓", format!("Server: reloaded; {} is gone", exact(name))),
            (Some(b), true) => {
                say(Tone::Warn, "⚠", format!("The server still lists {} (state: {}); it may come from another plugin folder", exact(name), inline(&text_of(b, "state"), 40)))
            }
            (None, false) => say(Tone::Warn, "⚠", format!("The server reloaded but does not list {}; see `agentd server logs`", exact(name))),
            (Some(b), false) => {
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
pub(super) fn reload_server(name: &str, removed: bool) -> (Vec<Line>, bool) {
    match Api::find() {
        Ok(api) => {
            let reply = api.reload();
            (reload_lines(&reply, name, removed, &api.address()), will_load(&reply, name))
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
        let say = |reply: &Reply, removed| text(&reload_lines(reply, "demo", removed, "127.0.0.1:4082"));
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
}
