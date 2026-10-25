//! Move secrets out of legacy stores into `credentials.yaml`: the config
//! dir's `.env` (provider keys, MCP client secrets, values `mcp.json`
//! references) and the builtin OAuth token files in the cache dir.
//!
//! Runs once, when `credentials.yaml` does not exist yet. Afterwards the
//! server never reads secrets from a `.env`; `agentd credentials import`
//! brings in keys from any other dotenv file on request.

use appv3_core::credentials::{self as store, Credential, CredentialsFile};
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// Builtin OAuth providers and their legacy token files (cache dir).
pub const LEGACY_OAUTH_FILES: [(&str, &str); 3] = [("codex", "codex_oauth.json"), ("copilot", "copilot_oauth.json"), ("grok", "grok_oauth.json")];

/// What a migration or import moved (names only, never values).
#[derive(Debug, Default, Clone, PartialEq)]
pub struct ImportReport {
    /// `(provider, variable names)` per credential added.
    pub providers: Vec<(String, Vec<String>)>,
    pub secrets: Vec<String>,
    pub oauth: Vec<String>,
    /// Provider values already stored identically.
    pub unchanged: Vec<String>,
}

impl ImportReport {
    pub fn is_empty(&self) -> bool {
        self.providers.is_empty() && self.secrets.is_empty() && self.oauth.is_empty()
    }
    /// Every variable name this import took out of the dotenv file.
    pub fn moved_names(&self) -> BTreeSet<String> {
        let mut out: BTreeSet<String> = self.providers.iter().flat_map(|(_, n)| n.iter().cloned()).collect();
        out.extend(self.secrets.iter().cloned());
        out.extend(self.unchanged.iter().cloned());
        out
    }
}

/// The provider a variable name configures (`OPENAI_API_KEY` → `openai`,
/// `ROUTER9_BASE_URL` → `router9`, …).
pub fn owner_of(name: &str) -> Option<String> {
    if name.is_empty() {
        return None;
    }
    for spec in crate::factory::COMPAT_SPECS {
        if spec.env_var == name || spec.base_url_env_var == Some(name) {
            return Some(spec.provider_id.to_string());
        }
    }
    if name == "VERTEXAI_API_KEY" {
        return Some("vertexai".into());
    }
    if matches!(name, "COPILOT_GITHUB_TOKEN" | "GITHUB_COPILOT_TOKEN") {
        return Some("copilot".into());
    }
    for e in crate::catalog::all_providers() {
        let id = e.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let str_eq = |v: Option<&Value>| v.and_then(|x| x.as_str()) == Some(name);
        let in_list = |v: Option<&Value>| v.and_then(|x| x.as_array()).is_some_and(|a| a.iter().any(|x| x.as_str() == Some(name)));
        let in_fields = e.get("credentials").and_then(|x| x.as_array()).is_some_and(|a| a.iter().any(|f| str_eq(f.get("name"))));
        if str_eq(e.get("env_var")) || in_list(e.get("env_vars")) || in_fields {
            return Some(id.to_string());
        }
    }
    None
}

fn is_mcp_client_secret(name: &str) -> bool {
    name.ends_with("_MCP_CLIENT_ID") || name.ends_with("_MCP_CLIENT_SECRET")
}

/// `$VAR` / `${VAR}` names referenced from `mcp.json` (text scan).
pub fn mcp_referenced_names(mcp_json: &Path) -> BTreeSet<String> {
    let Ok(text) = std::fs::read_to_string(mcp_json) else { return BTreeSet::new() };
    let re = regex::Regex::new(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)").unwrap();
    re.captures_iter(&text).filter_map(|c| c.get(1).or_else(|| c.get(2)).map(|m| m.as_str().to_string())).collect()
}

/// One `KEY=value` line of a dotenv file.
#[derive(Debug, Clone, PartialEq)]
pub struct DotenvEntry {
    pub line: usize,
    pub key: String,
    pub value: String,
}

/// Ordered dotenv parse (`export`, quotes, inline ` #` comments).
pub fn parse_dotenv(text: &str) -> Vec<DotenvEntry> {
    let mut out = vec![];
    for (i, line) in text.lines().enumerate() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let t = t.strip_prefix("export ").unwrap_or(t);
        let Some((k, v)) = t.split_once('=') else { continue };
        let key = k.trim().to_string();
        let mut v = v.trim().to_string();
        if v.len() >= 2 && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\''))) {
            let dq = v.starts_with('"');
            v = v[1..v.len() - 1].to_string();
            if dq {
                v = v.replace("\\\"", "\"").replace("\\\\", "\\");
            }
        } else if let Some(i) = v.find(" #") {
            v = v[..i].trim_end().to_string();
        }
        if !key.is_empty() {
            out.push(DotenvEntry { line: i, key, value: v });
        }
    }
    out
}

/// Fold dotenv `entries` into `f`: provider values become one credential
/// per provider (skipped when an existing credential already holds the same
/// values), MCP client secrets and `extra_secret_names` become named
/// secrets. Unknown names are left alone.
pub fn fold_dotenv(f: &mut CredentialsFile, entries: &[DotenvEntry], label: &str, extra_secret_names: &BTreeSet<String>) -> ImportReport {
    let mut report = ImportReport::default();
    let mut groups: Vec<(String, Vec<(String, String)>)> = vec![];
    for e in entries.iter().filter(|e| !e.value.is_empty()) {
        if let Some(pid) = owner_of(&e.key) {
            match groups.iter_mut().find(|(p, _)| *p == pid) {
                Some((_, vals)) => {
                    vals.retain(|(k, _)| *k != e.key);
                    vals.push((e.key.clone(), e.value.clone()));
                }
                None => groups.push((pid, vec![(e.key.clone(), e.value.clone())])),
            }
        } else if is_mcp_client_secret(&e.key) || extra_secret_names.contains(&e.key) {
            if f.secrets.get(&e.key) != Some(&e.value) {
                f.secrets.insert(e.key.clone(), e.value.clone());
                report.secrets.push(e.key.clone());
            } else {
                report.unchanged.push(e.key.clone());
            }
        }
    }
    for (pid, vals) in groups {
        let names: Vec<String> = vals.iter().map(|(k, _)| k.clone()).collect();
        let same = f.provider(&pid).iter().any(|c| vals.iter().all(|(k, v)| c.values.get(k) == Some(v)));
        if same {
            report.unchanged.extend(names);
            continue;
        }
        let mut c = Credential::new(label);
        c.values = vals.into_iter().collect();
        f.provider_mut(&pid).push(c);
        report.providers.push((pid, names));
    }
    report
}

/// A readable account name from the token document: an `email` claim of a
/// JWT access/id token, when present.
pub fn oauth_account_label(doc: &Value) -> Option<String> {
    fn find_email(v: &Value) -> Option<String> {
        match v {
            Value::Object(m) => {
                if let Some(e) = m.get("email").and_then(|e| e.as_str()).filter(|e| e.contains('@')) {
                    return Some(e.to_string());
                }
                m.values().find_map(find_email)
            }
            _ => None,
        }
    }
    for key in ["id_token", "access_token"] {
        let Some(tok) = doc.get(key).and_then(|t| t.as_str()) else { continue };
        let parts: Vec<&str> = tok.split('.').collect();
        if parts.len() != 3 {
            continue;
        }
        let claims = crate::codex::b64_lenient(parts[1]).and_then(|b| serde_json::from_slice::<Value>(&b).ok());
        if let Some(e) = claims.as_ref().and_then(find_email) {
            return Some(e);
        }
    }
    None
}

/// Paths a migration reads.
pub struct LegacySources {
    pub dotenv: PathBuf,
    pub cache_dir: PathBuf,
    pub mcp_json: PathBuf,
    pub store: PathBuf,
}

impl LegacySources {
    pub fn active() -> Self {
        let s = appv3_core::settings();
        LegacySources { dotenv: s.env_file(), cache_dir: s.cache_dir.clone(), mcp_json: s.mcp_config_path(), store: store::path() }
    }
}

/// Fold a dotenv file's provider keys and referenced secrets into the
/// store at `src.store`, then drop the moved lines from the file (the
/// original is kept next to it as `.env.migrated`).
pub fn absorb_dotenv(src: &LegacySources, label: &str) -> Result<ImportReport, store::CredentialsError> {
    let io = |e: std::io::Error| store::CredentialsError::Io(e.to_string());
    let Ok(text) = std::fs::read_to_string(&src.dotenv) else { return Ok(ImportReport::default()) };
    let entries = parse_dotenv(&text);
    let refs = mcp_referenced_names(&src.mcp_json);
    let report = store::update_at(&src.store, |f| fold_dotenv(f, &entries, label, &refs))?;
    strip_moved(&src.dotenv, &text, &entries, &report).map_err(io)?;
    Ok(report)
}

fn strip_moved(dotenv: &Path, text: &str, entries: &[DotenvEntry], report: &ImportReport) -> std::io::Result<()> {
    let moved = report.moved_names();
    let moved_lines: BTreeSet<usize> = entries.iter().filter(|e| moved.contains(&e.key)).map(|e| e.line).collect();
    if moved_lines.is_empty() {
        return Ok(());
    }
    appv3_core::secret_files::write_secret_file(&dotenv.with_file_name(".env.migrated"), text)?;
    let kept: Vec<&str> = text.lines().enumerate().filter(|(i, _)| !moved_lines.contains(i)).map(|(_, l)| l).collect();
    appv3_core::secret_files::write_secret_file(dotenv, &(kept.join("\n") + "\n"))
}

/// One-time migration into a store that does not exist yet. Returns `None`
/// when the store already exists or there was nothing to move. The original
/// `.env` is kept as `.env.migrated`; the live `.env` keeps only the lines
/// that were not moved. Legacy OAuth files are left in place.
pub fn migrate_legacy(src: &LegacySources) -> Result<Option<ImportReport>, store::CredentialsError> {
    if src.store.exists() {
        return Ok(None);
    }
    let io = |e: std::io::Error| store::CredentialsError::Io(e.to_string());
    let dotenv_text = std::fs::read_to_string(&src.dotenv).ok();
    let entries = dotenv_text.as_deref().map(parse_dotenv).unwrap_or_default();
    let refs = mcp_referenced_names(&src.mcp_json);
    let mut oauth_docs = vec![];
    for (pid, file) in LEGACY_OAUTH_FILES {
        let p = src.cache_dir.join(file);
        match std::fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
            Some(doc @ Value::Object(_)) => oauth_docs.push((pid, doc)),
            _ => {
                if p.exists() {
                    tracing::warn!("credentials_migration_skipped_unreadable_oauth provider={} path={}", pid, p.display());
                }
            }
        }
    }
    let report = store::update_at(&src.store, |f| {
        // Another process (the CLI beside the server) migrated first.
        if !f.providers.is_empty() || !f.secrets.is_empty() {
            return ImportReport::default();
        }
        let mut report = fold_dotenv(f, &entries, "Default", &refs);
        for (pid, doc) in oauth_docs {
            let mut c = Credential::new(oauth_account_label(&doc).unwrap_or_else(|| "Account 1".into()));
            c.oauth = Some(doc);
            f.provider_mut(pid).push(c);
            report.oauth.push(pid.to_string());
        }
        report
    })?;
    if report.is_empty() {
        return Ok(None);
    }
    if let Some(text) = dotenv_text {
        strip_moved(&src.dotenv, &text, &entries, &report).map_err(io)?;
    }
    tracing::info!("credentials_migrated providers={:?} secrets={:?} oauth={:?}", report.providers.iter().map(|(p, _)| p).collect::<Vec<_>>(), report.secrets, report.oauth);
    Ok(Some(report))
}

/// [`migrate_legacy`] for the active config, logging instead of failing.
pub fn migrate_active() -> Option<ImportReport> {
    let r = match migrate_legacy(&LegacySources::active()) {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("credentials_migration_failed error={}", e);
            None
        }
    };
    warn_ignored_dotenv_credentials();
    r
}

/// Import provider keys and referenced secrets from any dotenv file into
/// the active store (the file itself is not changed).
pub fn import_dotenv(path: &Path, label: &str) -> Result<ImportReport, store::CredentialsError> {
    let text = std::fs::read_to_string(path).map_err(|e| store::CredentialsError::Io(format!("{}: {e}", path.display())))?;
    let entries = parse_dotenv(&text);
    let refs = mcp_referenced_names(&appv3_core::settings().mcp_config_path());
    store::update(|f| fold_dotenv(f, &entries, label, &refs))
}

/// Provider variables a dotenv file put into the environment. They are not
/// used for credentials; say so once at startup.
pub fn ignored_dotenv_credentials() -> Vec<String> {
    appv3_core::env::injected_keys().into_iter().filter(|k| owner_of(k).is_some()).collect()
}

fn warn_ignored_dotenv_credentials() {
    let ignored = ignored_dotenv_credentials();
    if !ignored.is_empty() {
        tracing::warn!(
            "dotenv_credentials_ignored names={:?} hint=\"provider keys now live in credentials.yaml; add them in Settings -> Providers or run `agentd credentials import <file>`\"",
            ignored
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sources(d: &Path) -> LegacySources {
        LegacySources { dotenv: d.join("config/.env"), cache_dir: d.join("cache"), mcp_json: d.join("config/mcp.json"), store: d.join("config/credentials.yaml") }
    }

    fn write(p: &Path, text: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    #[test]
    fn maps_variable_names_to_their_provider() {
        assert_eq!(owner_of("OPENAI_API_KEY").as_deref(), Some("openai"));
        assert_eq!(owner_of("ROUTER9_BASE_URL").as_deref(), Some("router9"));
        assert_eq!(owner_of("ANTHROPIC_BASE_URL").as_deref(), Some("anthropic"));
        assert_eq!(owner_of("GOOGLE_CLOUD_PROJECT").as_deref(), Some("vertexai"));
        assert_eq!(owner_of("AWS_BEARER_TOKEN_BEDROCK").as_deref(), Some("bedrock"));
        assert_eq!(owner_of("LOG_LEVEL"), None);
        assert_eq!(owner_of("APP_ENV"), None);
    }

    #[test]
    fn parses_quotes_exports_and_comments() {
        let e = parse_dotenv("# c\nexport A=1\nB=\"x \\\"q\\\" #\"\nC='y'\nD=z # note\n\nnot a line\n");
        let kv: Vec<(&str, &str)> = e.iter().map(|e| (e.key.as_str(), e.value.as_str())).collect();
        assert_eq!(kv, [("A", "1"), ("B", "x \"q\" #"), ("C", "y"), ("D", "z")]);
    }

    #[test]
    fn migrates_env_keys_mcp_secrets_and_oauth_files_once() {
        let d = tempfile::tempdir().unwrap();
        let src = sources(d.path());
        write(
            &src.dotenv,
            "# Generated by openagentd\nAPP_ENV=production\nOPENAI_API_KEY=sk-test-1\nROUTER9_API_KEY=r9\nROUTER9_BASE_URL=http://127.0.0.1:1/v1\nLOG_LEVEL=DEBUG\nGH_MCP_CLIENT_SECRET=\"s3\"\nMY_TOKEN=tok\nEMPTY_KEY=\nOTHER=keep\n",
        );
        write(&src.mcp_json, r#"{"servers":{"x":{"command":"x","env":{"T":"${MY_TOKEN}"}}}}"#);
        write(&src.cache_dir.join("codex_oauth.json"), r#"{"access_token":"a","refresh_token":"r","expires_at":1.5,"account_id":null}"#);
        write(&src.cache_dir.join("grok_oauth.json"), "not json");

        let report = migrate_legacy(&src).unwrap().expect("migrated");
        assert_eq!(report.providers, [("openai".to_string(), vec!["OPENAI_API_KEY".to_string()]), ("router9".into(), vec!["ROUTER9_API_KEY".into(), "ROUTER9_BASE_URL".into()])]);
        assert_eq!(report.secrets, ["GH_MCP_CLIENT_SECRET", "MY_TOKEN"]);
        assert_eq!(report.oauth, ["codex"]);

        let f = store::load_from(&src.store).unwrap();
        assert_eq!(f.provider("openai")[0].value("OPENAI_API_KEY"), Some("sk-test-1"));
        assert_eq!(f.provider("openai")[0].label, "Default");
        assert_eq!(f.provider("router9")[0].value("ROUTER9_BASE_URL"), Some("http://127.0.0.1:1/v1"));
        assert_eq!(f.secrets.get("GH_MCP_CLIENT_SECRET").map(String::as_str), Some("s3"));
        assert_eq!(f.provider("codex")[0].oauth.as_ref().unwrap()["refresh_token"], "r");
        assert_eq!(f.provider("codex")[0].label, "Account 1");
        assert!(f.provider("grok").is_empty(), "an unreadable token file is skipped");

        let env = std::fs::read_to_string(&src.dotenv).unwrap();
        assert_eq!(env, "# Generated by openagentd\nAPP_ENV=production\nLOG_LEVEL=DEBUG\nEMPTY_KEY=\nOTHER=keep\n");
        assert!(std::fs::read_to_string(src.dotenv.with_file_name(".env.migrated")).unwrap().contains("sk-test-1"), "the original is kept");
        assert!(src.cache_dir.join("codex_oauth.json").exists(), "legacy token files are left in place");

        assert_eq!(migrate_legacy(&src).unwrap(), None, "runs once");
    }

    #[test]
    fn nothing_to_migrate_creates_no_store() {
        let d = tempfile::tempdir().unwrap();
        let src = sources(d.path());
        write(&src.dotenv, "APP_ENV=production\n");
        assert_eq!(migrate_legacy(&src).unwrap(), None);
        assert!(!src.store.exists());
        assert_eq!(std::fs::read_to_string(&src.dotenv).unwrap(), "APP_ENV=production\n");
    }

    #[test]
    fn folding_the_same_values_twice_adds_nothing() {
        let mut f = CredentialsFile::default();
        let entries = parse_dotenv("OPENAI_API_KEY=sk-1\n");
        let r1 = fold_dotenv(&mut f, &entries, "Imported", &BTreeSet::new());
        let r2 = fold_dotenv(&mut f, &entries, "Imported", &BTreeSet::new());
        assert_eq!(r1.providers.len(), 1);
        assert!(r2.is_empty() && r2.unchanged == ["OPENAI_API_KEY"]);
        assert_eq!(f.provider("openai").len(), 1);
        let r3 = fold_dotenv(&mut f, &parse_dotenv("OPENAI_API_KEY=sk-2\n"), "Imported", &BTreeSet::new());
        assert_eq!(r3.providers.len(), 1);
        assert_eq!(f.provider("openai").len(), 2, "a different key is added as another credential");
    }

    #[test]
    fn reads_an_account_email_from_a_jwt_claim() {
        use base64::Engine;
        let claims = serde_json::json!({"https://api.openai.com/profile": {"email": "me@example.com"}});
        let b = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims.to_string());
        let doc = serde_json::json!({"access_token": format!("h.{b}.s")});
        assert_eq!(oauth_account_label(&doc).as_deref(), Some("me@example.com"));
        assert_eq!(oauth_account_label(&serde_json::json!({"access_token": "opaque"})), None);
    }
}
