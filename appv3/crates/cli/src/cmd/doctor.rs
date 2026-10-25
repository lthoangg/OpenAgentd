//! `agentd doctor`: credentials, database, port, and agents checks.

use crate::paths::find_pids;
use crate::ui::{bold, cyan, dim, tilde, Checks};
use anyhow::Result;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

/// Lead-agent providers that need neither an API key nor an OAuth login.
const KEYLESS_PROVIDERS: &[&str] = &["vertexai", "cliproxy", "router9", "ollama"];

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

pub fn doctor() -> Result<ExitCode> {
    // Non-secret settings may still come from a dotenv file; provider keys
    // live in credentials.yaml.
    appv3_core::env::init_env();
    let s = appv3_core::settings();
    appv3_core::env::load_config_env(&s.config_dir);
    crate::cmd::auth::migrate_first();

    println!();
    println!("  {}  {}", bold(&cyan("agentd doctor")), dim(&format!("v{}", appv3_core::VERSION)));
    println!();
    let mut checks = Checks::default();

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

    // Database.
    if s.database_path.exists() {
        checks.ok(&format!("Database: {}", tilde(&s.database_path)));
    } else {
        checks.warn(&format!("Database not found: {}  (created on first start)", tilde(&s.database_path)));
    }

    // Server port.
    match crate::net::server_settings() {
        Err(e) => checks.fail(&format!("{e:#}")),
        Ok(cfg) => {
            let (_, port) = crate::net::resolve_addr(None, None, &cfg);
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

    // Agents.
    if !md_files(&s.agents_dir).is_empty() {
        checks.ok(&format!("Agents: {}", tilde(&s.agents_dir)));
    } else {
        checks.fail(&format!("Agents not found: {}  (start the server to restore the defaults)", tilde(&s.agents_dir)));
    }

    println!();
    println!("  {}", checks.summary());
    println!();
    Ok(if checks.failures > 0 { ExitCode::FAILURE } else { ExitCode::SUCCESS })
}

#[cfg(test)]
mod tests {
    use super::read_lead_provider;

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
}
