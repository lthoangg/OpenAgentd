//! Configuring MCP servers: shared by the Settings API (`/api/mcp`) and by
//! the `mcp` tool's `servers`, `save` and `remove` actions. The tool never
//! writes `mcp.json` itself: `save` and `remove` become a card the user
//! confirms ([`appv3_agent::confirm`]), and [`apply`] runs on the server
//! once they choose Apply.
//!
//! The agent never reads a secret: every view it gets masks `env` and
//! `headers` values and OAuth client credentials. A `${NAME}` reference is
//! not a secret, so it shows as written.

use crate::config::{self as cfgmod, OAuthConfig, ServerConfig};
use crate::{McpManager, ServerStatus};
use appv3_agent::confirm::Proposal;
use indexmap::IndexMap;
use serde_json::{json, Value};
use std::hash::{Hash, Hasher};
use std::time::Duration;

/// Stands for a stored value the reader may not see.
pub const MASK: &str = "********";
pub const SAVE_CHANGE: &str = "mcp_save";
pub const REMOVE_CHANGE: &str = "mcp_remove";
/// How long `apply` waits for a saved server to become ready.
const START_WAIT: Duration = Duration::from_secs(15);
const MAX_TOOL_NAMES: usize = 20;

// ── secrets in config ───────────────────────────────────────────────────────

fn whole_ref_re() -> &'static regex::Regex {
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"^\$\{[A-Za-z_][A-Za-z0-9_]*\}$").unwrap());
    &RE
}

fn oauth_env_key(name: &str, field: &str) -> String {
    let re = regex::Regex::new(r"[^A-Za-z0-9]+").unwrap();
    let p = re.replace_all(name, "_").trim_matches('_').to_uppercase();
    format!("{}_MCP_{field}", if p.is_empty() { "MCP".to_string() } else { p })
}

/// Store MCP client secrets as named secrets in `credentials.yaml`;
/// `mcp.json` keeps only the `${NAME}` references.
fn save_env_values(values: &[(String, String)]) -> std::io::Result<()> {
    if values.is_empty() {
        return Ok(());
    }
    let values = values.to_vec();
    appv3_core::credentials::update(move |f| {
        for (k, v) in values {
            f.secrets.insert(k, v);
        }
    })?;
    Ok(())
}

/// Move literal OAuth client credentials out of `mcp.json` into
/// `credentials.yaml` (`_store_oauth_secrets`).
pub fn store_oauth_secrets(name: &str, cfg: ServerConfig) -> std::io::Result<ServerConfig> {
    let ServerConfig::Http { url, headers, oauth: Some(o), enabled, timeout } = cfg else { return Ok(cfg) };
    let re = whole_ref_re();
    let mut env = vec![];
    let mut client_id = o.client_id.clone();
    let mut client_secret = o.client_secret.clone();
    if let Some(id) = client_id.clone().filter(|v| !v.is_empty() && v != MASK && !re.is_match(v)) {
        let key = oauth_env_key(name, "CLIENT_ID");
        env.push((key.clone(), id));
        client_id = Some(format!("${{{key}}}"));
    }
    if let Some(sec) = client_secret.clone().filter(|v| !v.is_empty() && v != MASK && !re.is_match(v)) {
        let key = oauth_env_key(name, "CLIENT_SECRET");
        env.push((key.clone(), sec));
        client_secret = Some(format!("${{{key}}}"));
    }
    save_env_values(&env)?;
    Ok(ServerConfig::Http { url, headers, oauth: Some(OAuthConfig { client_id, client_secret }), enabled, timeout })
}

fn keep_masked(new: IndexMap<String, String>, old: &IndexMap<String, String>) -> IndexMap<String, String> {
    new.into_iter().map(|(k, v)| if v == MASK && old.contains_key(&k) { (k.clone(), old[&k].clone()) } else { (k, v) }).collect()
}

/// Put the stored values back where `new` carries [`MASK`] for them
/// (`_merge_masked_http_headers` + `_merge_masked_oauth`, and `env`).
pub fn merge_masked(new: ServerConfig, existing: Option<&ServerConfig>) -> ServerConfig {
    match (new, existing) {
        (ServerConfig::Http { url, headers, oauth, enabled, timeout }, Some(ServerConfig::Http { headers: old_h, oauth: old_o, .. })) => {
            let oauth = match (oauth, old_o) {
                (Some(n), Some(o)) => Some(OAuthConfig {
                    client_id: if n.client_id.as_deref() == Some(MASK) { o.client_id.clone() } else { n.client_id },
                    client_secret: if n.client_secret.as_deref() == Some(MASK) { o.client_secret.clone() } else { n.client_secret },
                }),
                (n, _) => n,
            };
            ServerConfig::Http { url, headers: keep_masked(headers, old_h), oauth, enabled, timeout }
        }
        (ServerConfig::Stdio { command, args, env, enabled, timeout }, Some(ServerConfig::Stdio { env: old_env, .. })) => {
            ServerConfig::Stdio { command, args, env: keep_masked(env, old_env), enabled, timeout }
        }
        (new, _) => new,
    }
}

fn has_mask(cfg: &ServerConfig) -> bool {
    match cfg {
        ServerConfig::Stdio { env, .. } => env.values().any(|v| v == MASK),
        ServerConfig::Http { headers, oauth, .. } => {
            headers.values().any(|v| v == MASK) || oauth.as_ref().is_some_and(|o| o.client_id.as_deref() == Some(MASK) || o.client_secret.as_deref() == Some(MASK))
        }
    }
}

fn mask_value(v: &str) -> String {
    if whole_ref_re().is_match(v) {
        v.to_string()
    } else {
        MASK.to_string()
    }
}

fn mask_map(m: &IndexMap<String, String>) -> Value {
    Value::Object(m.iter().map(|(k, v)| (k.clone(), json!(mask_value(v)))).collect())
}

/// A server's config as the agent may see it: `env` and `headers` values
/// and OAuth credentials masked, `${NAME}` references kept.
pub fn agent_view(cfg: &ServerConfig) -> Value {
    let mut v = match cfg {
        ServerConfig::Stdio { command, args, env, enabled, .. } => json!({"transport": "stdio", "command": command, "args": args, "env": mask_map(env), "enabled": enabled}),
        ServerConfig::Http { url, headers, oauth, enabled, .. } => {
            let oauth = oauth.as_ref().map(|o| {
                let m = |s: &Option<String>| s.as_deref().filter(|s| !s.is_empty()).map(mask_value);
                json!({"client_id": m(&o.client_id), "client_secret": m(&o.client_secret)})
            });
            json!({"transport": "http", "url": url, "headers": mask_map(headers), "oauth": oauth, "enabled": enabled})
        }
    };
    if let Some(t) = cfg.timeout() {
        v["timeout"] = json!(t);
    }
    v
}

/// Validate one server entry exactly as `mcp.json` is validated.
pub fn parse_entry(name: &str, entry: &Value) -> Result<ServerConfig, String> {
    cfgmod::validate_server_name(name)?;
    if !entry.is_object() {
        return Err("config must be a JSON object: {\"command\": …} for stdio or {\"url\": …} for http.".into());
    }
    let mut cfg = cfgmod::parse_config(&json!({"servers": {name: entry}})).map_err(|e| e.replace("for MCPConfig", "for this server config"))?;
    cfg.servers.shift_remove(name).ok_or_else(|| "config is empty.".into())
}

/// A fingerprint of `name`'s stored entry (`"absent"` without one), so a
/// confirmed change applies only to the entry the card described.
fn fingerprint(cfg: Option<&ServerConfig>) -> String {
    match cfg {
        None => "absent".into(),
        Some(c) => {
            let mut h = std::hash::DefaultHasher::new();
            c.dump().to_string().hash(&mut h);
            format!("{:016x}", h.finish())
        }
    }
}

// ── the agent's views and proposals ─────────────────────────────────────────

fn state_line(st: &ServerStatus) -> String {
    let state = if !st.enabled { "disabled".to_string() } else { st.state.clone() };
    let mut line = format!("- {} ({}, {state})", st.name, st.transport);
    if let Some(e) = st.error.as_deref().filter(|e| !e.is_empty()) {
        line.push_str(&format!(" — error: {e}"));
    }
    if st.state == "auth_required" {
        line.push_str(" — needs sign-in: the user connects it in Settings → MCP");
    }
    if !st.tool_names.is_empty() {
        let shown: Vec<&str> = st.tool_names.iter().take(MAX_TOOL_NAMES).map(String::as_str).collect();
        let more = st.tool_names.len().saturating_sub(MAX_TOOL_NAMES);
        line.push_str(&format!(" — {} tools: {}{}", st.tool_names.len(), shown.join(", "), if more > 0 { format!(", … {more} more") } else { String::new() }));
    }
    line
}

/// `mcp(action='servers')`: every configured server, its state and its
/// config with secrets masked.
pub fn servers_text(m: &McpManager) -> String {
    let cfg = match cfgmod::load_config() {
        Ok(c) => c,
        Err(e) => return format!("mcp.json is invalid, so no server runs from it: {e}"),
    };
    if cfg.servers.is_empty() {
        return "No MCP servers are configured. Add one with action='save'.".into();
    }
    let mut lines = vec!["MCP servers (secrets show as ********; send them back unchanged to keep them):".to_string()];
    for (name, sc) in &cfg.servers {
        let st = m.get_status(name).unwrap_or_else(|| ServerStatus {
            name: name.clone(),
            transport: sc.transport().into(),
            enabled: sc.enabled(),
            state: "stopped".into(),
            error: None,
            tool_names: vec![],
            started_at: None,
        });
        lines.push(state_line(&st));
        lines.push(format!("  config: {}", agent_view(sc)));
    }
    lines.join("\n")
}

fn clip(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

fn keys(m: &IndexMap<String, String>) -> String {
    m.keys().map(|k| format!("`{k}`")).collect::<Vec<_>>().join(", ")
}

fn describe(cfg: &ServerConfig) -> String {
    match cfg {
        ServerConfig::Stdio { command, args, env, .. } => {
            let line = std::iter::once(command.as_str()).chain(args.iter().map(String::as_str)).collect::<Vec<_>>().join(" ");
            let env = if env.is_empty() { String::new() } else { format!(" with environment variables {}", keys(env)) };
            format!("runs `{}` on this computer{env}", clip(&line, 300).replace('`', "'"))
        }
        ServerConfig::Http { url, headers, oauth, .. } => {
            let hdr = if headers.is_empty() { String::new() } else { format!(" with headers {}", keys(headers)) };
            let oauth = if oauth.is_some() { ", signing in with OAuth" } else { "" };
            format!("connects to `{}`{hdr}{oauth}", clip(url, 300).replace('`', "'"))
        }
    }
}

/// The card for `mcp(action='save')`: add `name`, or replace its entry.
pub fn propose_save(name: &str, entry: &Value) -> Result<Proposal, String> {
    let sc = parse_entry(name, entry)?;
    let cfg = cfgmod::load_config().map_err(|e| format!("mcp.json is invalid, so it cannot be changed from chat: {e}"))?;
    let existing = cfg.servers.get(name);
    if existing.is_none() && has_mask(&sc) {
        return Err(format!("'{MASK}' stands for a stored value, and '{name}' has none. Leave the value out; the user enters secrets in Settings → MCP."));
    }
    let merged = merge_masked(sc.clone(), existing);
    if has_mask(&merged) {
        return Err(format!("'{MASK}' stands for a stored value, but '{name}' has no stored value under that key."));
    }
    if existing.is_some_and(|e| *e == merged) {
        return Err(format!("No change: '{name}' is already configured like that."));
    }
    let verb = if existing.is_some() { "Update" } else { "Add" };
    let mut q = format!("{verb} MCP server **{name}**: {}.", describe(&merged));
    q.push_str(if merged.enabled() { " It starts now and runs in every later session." } else { " It is saved disabled and does not start." });
    let apply = if merged.enabled() { "Save it to mcp.json and start it." } else { "Save it to mcp.json." };
    Ok(Proposal { question: q, apply: apply.into(), change: json!({"type": SAVE_CHANGE, "name": name, "config": entry, "before": fingerprint(existing)}) })
}

/// The card for `mcp(action='remove')`.
pub fn propose_remove(name: &str) -> Result<Proposal, String> {
    let cfg = cfgmod::load_config().map_err(|e| format!("mcp.json is invalid, so it cannot be changed from chat: {e}"))?;
    let Some(existing) = cfg.servers.get(name) else {
        let names: Vec<&str> = cfg.servers.keys().map(String::as_str).collect();
        return Err(format!("MCP server '{name}' is not configured. Servers: {}.", if names.is_empty() { "none".to_string() } else { names.join(", ") }));
    };
    Ok(Proposal {
        question: format!("Remove MCP server **{name}** (it {}). It stops now.", describe(existing)),
        apply: "Remove it from mcp.json and stop it.".into(),
        change: json!({"type": REMOVE_CHANGE, "name": name, "before": fingerprint(Some(existing))}),
    })
}

/// What the agent reads about a server after a change.
pub fn status_sentence(st: &ServerStatus) -> String {
    let n = &st.name;
    match st.state.as_str() {
        _ if !st.enabled => format!("MCP server '{n}' is saved, disabled."),
        "ready" => {
            let shown: Vec<&str> = st.tool_names.iter().take(MAX_TOOL_NAMES).map(String::as_str).collect();
            format!(
                "MCP server '{n}' is ready with {} tool{}{}. Find them with mcp(action='search', server='{n}').",
                st.tool_names.len(),
                if st.tool_names.len() == 1 { "" } else { "s" },
                if shown.is_empty() { String::new() } else { format!(": {}", shown.join(", ")) }
            )
        }
        "auth_required" => format!("MCP server '{n}' is saved but needs sign-in: ask the user to open Settings → MCP and click Connect on '{n}'. Its tools appear once they have."),
        "error" => format!(
            "MCP server '{n}' is saved but failed to start: {}. Fix it with action='save', or remove it.",
            st.error.as_deref().filter(|e| !e.is_empty()).unwrap_or("unknown error")
        ),
        s => format!("MCP server '{n}' is saved and still {s}; check it with action='servers'."),
    }
}

/// Apply a confirmed `mcp_save` / `mcp_remove` change on `m`, if the entry
/// is still the one the card described.
pub async fn apply(m: &McpManager, change: &Value) -> Result<String, String> {
    let name = change["name"].as_str().unwrap_or_default().to_string();
    let mut cfg = cfgmod::load_config().map_err(|e| format!("mcp.json is invalid: {e}"))?;
    if change["before"].as_str() != Some(fingerprint(cfg.servers.get(&name)).as_str()) {
        return Err(format!("MCP server '{name}' changed since this was proposed. Check it with action='servers' and propose again."));
    }
    match change["type"].as_str() {
        Some(SAVE_CHANGE) => {
            let sc = parse_entry(&name, &change["config"])?;
            let sc = merge_masked(sc, cfg.servers.get(&name));
            let sc = store_oauth_secrets(&name, sc).map_err(|e| e.to_string())?;
            cfg.servers.insert(name.clone(), sc);
            cfgmod::save_config(&cfg)?;
            let st = m.restart_server(&name, START_WAIT).await.map_err(|e| format!("it was saved but could not start: {e}"))?;
            tracing::info!("mcp_server_saved_from_chat server={} state={}", name, st.state);
            Ok(status_sentence(&st))
        }
        Some(REMOVE_CHANGE) => {
            cfg.servers.shift_remove(&name);
            cfgmod::save_config(&cfg)?;
            m.remove_runner(&name).await;
            tracing::info!("mcp_server_removed_from_chat server={}", name);
            Ok(format!("MCP server '{name}' is removed and stopped."))
        }
        other => Err(format!("unknown MCP change '{}'.", other.unwrap_or(""))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(v: Value) -> ServerConfig {
        parse_entry("s", &v).unwrap()
    }

    #[test]
    fn the_agent_view_masks_every_secret_but_references() {
        let v = agent_view(&entry(json!({"command": "npx", "args": ["-y", "srv"], "env": {"TOKEN": "ghp_live", "REF": "${GITHUB_TOKEN}"}})));
        assert_eq!(v["env"], json!({"TOKEN": MASK, "REF": "${GITHUB_TOKEN}"}));
        assert_eq!(v["args"], json!(["-y", "srv"]));
        let v = agent_view(&entry(json!({"url": "https://x/mcp", "headers": {"Authorization": "Bearer abc"}, "oauth": {"client_id": "id", "client_secret": "sec"}})));
        assert_eq!(v["headers"], json!({"Authorization": MASK}));
        assert_eq!(v["oauth"], json!({"client_id": MASK, "client_secret": MASK}));
        assert!(!v.to_string().contains("abc") && !v.to_string().contains("sec\""), "{v}");
    }

    #[test]
    fn masked_values_keep_what_is_stored() {
        let old = entry(json!({"command": "a", "env": {"TOKEN": "t1", "MODE": "x"}}));
        let new = entry(json!({"command": "b", "env": {"TOKEN": MASK, "MODE": "y"}}));
        assert_eq!(merge_masked(new, Some(&old)), entry(json!({"command": "b", "env": {"TOKEN": "t1", "MODE": "y"}})));
        let old = entry(json!({"url": "https://x", "headers": {"A": "s"}}));
        let new = entry(json!({"url": "https://y", "headers": {"A": MASK}}));
        assert_eq!(merge_masked(new, Some(&old)), entry(json!({"url": "https://y", "headers": {"A": "s"}})));
    }

    #[test]
    fn an_entry_is_validated_like_mcp_json() {
        assert!(parse_entry("1bad", &json!({"command": "x"})).unwrap_err().starts_with("Invalid MCP server name"));
        assert!(parse_entry("ok", &json!({"command": ""})).unwrap_err().contains("at least 1 character"));
        assert!(parse_entry("ok", &json!({"command": "x", "nope": 1})).unwrap_err().contains("Extra inputs are not permitted"));
        assert!(parse_entry("ok", &json!("npx")).unwrap_err().starts_with("config must be a JSON object"));
        assert_eq!(parse_entry("ok", &json!({"url": "https://x"})).unwrap().transport(), "http");
    }
}
