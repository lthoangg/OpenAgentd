//! Which sites the agent may use, and the card that asks the user.
//!
//! The Preview tab of the desktop app shows pages of the public web in a
//! browser profile where the user may be signed in. The user browses any
//! site there; the agent's `preview` tool reads and acts only on sites the
//! user allowed. The rules are a default (ask, or allow every site), a list
//! of allowed hosts and a list of blocked ones, kept in the user's config
//! dir. A site the rules do not settle opens a card: **Allow once** (this
//! chat, in memory), **Always allow** (saved to the list) or **Decline**
//! (this chat, in memory: the agent is refused without asking again).
//! [`answer`] runs on the server when the user answers, so the model never
//! grants itself a site.

use appv3_db::{self as db, DbPool, PendingQuestion};
use appv3_tools::{Suspension, ToolContext, ToolError, ToolOutput, ToolResult};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

pub const SITE_ACCESS_KIND: &str = "site_access";
pub const ALLOW_ONCE: &str = "Allow once";
pub const ALLOW_ALWAYS: &str = "Always allow";
pub const DECLINE: &str = "Decline";
/// Turn metadata: ids of the `preview` calls the agent loop runs as calls
/// that may pause on this card. Any other call is refused instead, because
/// a pause the loop did not plan for would lose the call's result.
pub const SITE_ASK_META: &str = "site_access_calls";
/// Most hosts in either list.
pub const MAX_RULES: usize = 500;
/// Longest typed answer (the user's reason for declining).
pub const MAX_ANSWER_CHARS: usize = 2000;

/// What applies to a site in neither list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DefaultPolicy {
    /// Ask the user the first time the agent uses a site.
    #[default]
    Ask,
    /// Every site that is not blocked.
    Allow,
}

/// The user's rules (`browser-sites.json`).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct SiteRules {
    #[serde(default)]
    pub default: DefaultPolicy,
    #[serde(default)]
    pub allowed: Vec<String>,
    #[serde(default)]
    pub blocked: Vec<String>,
}

/// What the rules say about one host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Allowed,
    Blocked,
    /// The user declined the site in this chat.
    Declined,
    Ask,
}

/// The name a site goes by on the card, in the lists and in a chat's
/// answers: its host without a leading `www.`, the two being one site to
/// the rules.
pub fn site_name(host: &str) -> &str {
    host.strip_prefix("www.").unwrap_or(host)
}

/// A list entry as it is stored: a host (`example.com`, which also covers
/// `www.example.com`) or `*.example.com` (every subdomain, not the bare
/// domain). A pasted URL is cut down to its host, and a leading `www.` goes.
pub fn normalize_rule(raw: &str) -> Result<String, String> {
    let mut text = raw.trim().to_ascii_lowercase();
    if let Some((_, rest)) = text.split_once("://") {
        text = rest.to_string();
    }
    let host = text.split(['/', '?', '#']).next().unwrap_or_default();
    let host = host.rsplit_once('@').map_or(host, |(_, h)| h);
    // A port is not part of a rule: it covers the host on every port.
    let host = match host.rsplit_once(':') {
        Some((h, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => h,
        _ => host,
    };
    let host = host.trim_end_matches('.');
    let (wild, name) = match host.strip_prefix("*.") {
        Some(rest) => (true, rest),
        None => (false, host),
    };
    let name = if wild { name } else { name.strip_prefix("www.").unwrap_or(name) };
    let label_ok = |l: &str| !l.is_empty() && l.len() <= 63 && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') && !l.starts_with('-') && !l.ends_with('-');
    if name.is_empty() || name.len() > 253 || !name.split('.').all(label_ok) {
        return Err(format!("'{}' is not a site: write a host such as example.com, or *.example.com for its subdomains.", raw.trim()));
    }
    Ok(if wild { format!("*.{name}") } else { name.to_string() })
}

fn rule_matches(rule: &str, host: &str) -> bool {
    match rule.strip_prefix("*.") {
        Some(domain) => host.len() > domain.len() + 1 && host.ends_with(domain) && host.as_bytes()[host.len() - domain.len() - 1] == b'.',
        None => host == rule || host.strip_prefix("www.") == Some(rule),
    }
}

impl SiteRules {
    /// The rules with every entry normalized, without duplicates; an entry
    /// that is not a site is an error.
    pub fn checked(self) -> Result<Self, String> {
        let clean = |list: Vec<String>, what: &str| -> Result<Vec<String>, String> {
            if list.len() > MAX_RULES {
                return Err(format!("At most {MAX_RULES} {what} sites."));
            }
            let mut out: Vec<String> = Vec::new();
            for raw in list {
                let rule = normalize_rule(&raw)?;
                if !out.contains(&rule) {
                    out.push(rule);
                }
            }
            Ok(out)
        };
        Ok(Self { default: self.default, allowed: clean(self.allowed, "allowed")?, blocked: clean(self.blocked, "blocked")? })
    }

    /// What the lists and the default say about `host` (lower case, no
    /// port). A blocked site stays blocked whatever else matches.
    pub fn access(&self, host: &str) -> Access {
        if self.blocked.iter().any(|r| rule_matches(r, host)) {
            Access::Blocked
        } else if self.allowed.iter().any(|r| rule_matches(r, host)) || self.default == DefaultPolicy::Allow {
            Access::Allowed
        } else {
            Access::Ask
        }
    }
}

/// Where the rules are kept.
#[derive(Debug, Clone)]
pub struct SiteStore {
    path: PathBuf,
}

fn store_lock() -> &'static Mutex<()> {
    static L: Mutex<()> = Mutex::new(());
    &L
}

impl SiteStore {
    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// `{config dir}/browser-sites.json`. The agent's file and shell tools
    /// refuse this file (`appv3_tools::denied`), so only the user's answer
    /// on a card or a change in Settings writes it.
    pub fn user() -> Self {
        Self::at(appv3_core::settings().config_dir.join(appv3_tools::denied::SITE_RULES_FILE))
    }

    /// The saved rules; the defaults when the file is missing or unreadable
    /// (ask for every site: the careful reading of a broken file).
    pub fn read(&self) -> SiteRules {
        std::fs::read_to_string(&self.path).ok().and_then(|t| serde_json::from_str::<SiteRules>(&t).ok()).and_then(|r| r.checked().ok()).unwrap_or_default()
    }

    pub fn write(&self, rules: &SiteRules) -> std::io::Result<()> {
        let _g = store_lock().lock().unwrap_or_else(|e| e.into_inner());
        self.write_locked(rules)
    }

    fn write_locked(&self, rules: &SiteRules) -> std::io::Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let text = serde_json::to_string_pretty(rules).map_err(std::io::Error::other)?;
        appv3_core::secret_files::write_atomic(&self.path, &(text + "\n"))
    }

    /// Add `host` to the allowed list (and take it off the blocked one).
    pub fn allow(&self, host: &str) -> Result<String, String> {
        let rule = normalize_rule(host)?;
        let _g = store_lock().lock().unwrap_or_else(|e| e.into_inner());
        let mut rules = self.read();
        rules.blocked.retain(|r| r != &rule);
        if !rules.allowed.contains(&rule) {
            if rules.allowed.len() >= MAX_RULES {
                return Err(format!("The list of allowed sites is full ({MAX_RULES})."));
            }
            rules.allowed.push(rule.clone());
        }
        self.write_locked(&rules).map_err(|e| format!("The site could not be saved: {e}."))?;
        Ok(rule)
    }
}

fn store_override() -> &'static Mutex<Option<SiteStore>> {
    static S: OnceLock<Mutex<Option<SiteStore>>> = OnceLock::new();
    S.get_or_init(Default::default)
}

/// The store in use: the user's, unless a test set another.
pub fn store() -> SiteStore {
    store_override().lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_else(SiteStore::user)
}

/// Keep the rules in `store` instead of the user's config dir (tests).
pub fn use_store(store: SiteStore) {
    *store_override().lock().unwrap_or_else(|e| e.into_inner()) = Some(store);
}

/// What the user answered per chat: `(session id, site name)` → allowed.
/// In memory only.
fn chat_answers() -> &'static Mutex<HashMap<(String, String), bool>> {
    static A: OnceLock<Mutex<HashMap<(String, String), bool>>> = OnceLock::new();
    A.get_or_init(Default::default)
}

fn session_key(session_id: &str) -> String {
    db::codec::api_uuid(&db::codec::db_id(session_id))
}

fn remember(session_id: &str, host: &str, allowed: bool) {
    chat_answers().lock().unwrap_or_else(|e| e.into_inner()).insert((session_key(session_id), site_name(host).to_string()), allowed);
}

/// May the agent of `session_id` use `host` now? The lists come first, so
/// a site the user later allows in Settings is no longer declined.
pub fn decide(session_id: Option<&str>, host: &str) -> Access {
    let access = store().read().access(host);
    if access != Access::Ask {
        return access;
    }
    let answered = session_id.and_then(|s| chat_answers().lock().unwrap_or_else(|e| e.into_inner()).get(&(session_key(s), site_name(host).to_string())).copied());
    match answered {
        Some(true) => Access::Allowed,
        Some(false) => Access::Declined,
        None => Access::Ask,
    }
}

/// The `pending_questions` payload of the card for the site `host` is on.
pub fn payload(host: &str, url: &str) -> Value {
    let host = site_name(host);
    json!({
        "kind": SITE_ACCESS_KIND,
        "site": {"host": host, "url": url},
        "questions": [{
            "question": format!("Let the agent use **{host}**? It will read and act on this site's pages as you see them in the Preview tab, including pages behind your sign-in."),
            "header": "Site access",
            "options": [
                {"label": ALLOW_ONCE, "description": "For this chat only.", "recommended": false},
                {"label": ALLOW_ALWAYS, "description": format!("Saves {host} in Settings → Browser."), "recommended": false},
                {"label": DECLINE, "description": "The agent is told it may not use this site.", "recommended": false},
            ],
            "multiple": false,
            "custom": true,
        }],
    })
}

/// Open the card for `host` and pause the turn. Only for a call the agent
/// loop runs as one that may pause ([`SITE_ASK_META`]).
pub async fn ask(ctx: &ToolContext, tool_name: &str, host: &str, url: &str) -> ToolResult {
    let host = site_name(host);
    let no_session = || ToolError::Execution(format!("The user has not allowed the agent to use {host}, and there is no session to ask in."));
    let pool = crate::manager::try_pool().ok_or_else(no_session)?;
    let session_id = ctx.session_id.clone().filter(|s| !s.is_empty()).ok_or_else(no_session)?;
    if ctx.tool_call_id.is_empty() {
        return Ok(ToolOutput::text(format!("The request to use {host} could not be shown to the user (no tool call id).")));
    }
    // In a turn only agents worked in, nobody follows this session to answer.
    let floor = ctx.metadata.lock().unwrap().get(crate::session::TURN_FLOOR_META).and_then(Value::as_i64);
    if let Some(floor) = floor {
        if crate::session::agent_only_since(&pool, &session_id, floor).await {
            return Ok(ToolOutput::text(format!(
                "Not asked: the user is not following this session (another workspace's agent sent this request), so nobody can allow {host}. Say so in your answer; the user can allow the site in Settings → Browser."
            )));
        }
    }
    let payload = payload(host, url);
    let row = db::create_pending_question_with(&pool, &session_id, &ctx.tool_call_id, tool_name, &payload).await.map_err(ToolError::exec)?;
    let sid = session_key(&session_id);
    let qid = db::codec::api_uuid(&row.id);
    let questions = payload["questions"].as_array().cloned().unwrap_or_default();
    crate::store().push_event(&sid, &crate::events::question_asked(&qid, &sid, &ctx.tool_call_id, &questions), false);
    let headline = format!("The agent wants to use {host}");
    crate::tools::publish_input_needed(&pool, &session_id, &qid, "Needs you", |_| headline).await;
    tracing::info!("site_access_asked session_id={} question_id={} host={}", sid, qid, host);
    Err(ToolError::Suspended(Suspension::Question { question_id: qid, session_id: sid }))
}

/// The user's answer to a card.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Once,
    Always,
    /// Declined, with what they typed instead, if anything.
    Decline(Option<String>),
}

/// Only a lone **Allow once** or **Always allow** allows; anything typed is
/// a reason not to.
pub fn decision(answers: &[Vec<String>]) -> Decision {
    let picked: Vec<String> = answers.first().into_iter().flatten().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    match picked.as_slice() {
        [one] if one == ALLOW_ONCE => Decision::Once,
        [one] if one == ALLOW_ALWAYS => Decision::Always,
        _ => {
            let typed: Vec<&str> = picked.iter().map(String::as_str).filter(|s| ![ALLOW_ONCE, ALLOW_ALWAYS, DECLINE].contains(s)).collect();
            Decision::Decline(if typed.is_empty() { None } else { Some(typed.join("\n")) })
        }
    }
}

/// The host a card asks about.
pub fn host_of(row: &PendingQuestion) -> Option<String> {
    serde_json::from_str::<Value>(&row.payload).ok().and_then(|p| p.pointer("/site/host").and_then(Value::as_str).map(String::from)).filter(|h| !h.is_empty())
}

/// The tool result the agent reads after the user answered.
pub fn result_text(host: &str, decision: &Decision, saved: Option<&Result<String, String>>) -> String {
    match (decision, saved) {
        (Decision::Once, _) => format!("The user allowed {host} for this chat. Call preview again to continue."),
        (Decision::Always, Some(Err(why))) => format!("The user allowed {host} for this chat, but it could not be saved for later: {why} Call preview again to continue."),
        (Decision::Always, _) => format!("The user allowed {host}; it is saved, so they are not asked again. Call preview again to continue."),
        (Decision::Decline(None), _) => format!("The user declined: you may not use {host} in this chat."),
        (Decision::Decline(Some(said)), _) => format!("The user did not allow {host} in this chat. They said:\n\n{said}"),
    }
}

/// Close the open card `question_id` with `answers`. `None` when it was no
/// longer open (already answered, or the user moved on).
pub async fn answer(pool: &DbPool, session_id: &str, question_id: &str, answers: &[Vec<String>]) -> anyhow::Result<Option<String>> {
    let Some(row) = db::get_question(pool, question_id).await?.filter(|r| r.status == "pending") else { return Ok(None) };
    let host = host_of(&row).unwrap_or_default();
    let decision = if host.is_empty() { Decision::Decline(None) } else { decision(answers) };
    let saved = matches!(decision, Decision::Always).then(|| store().allow(&host));
    let text = result_text(&host, &decision, saved.as_ref());
    let av = json!(answers);
    if db::resolve_pending_question_with(pool, question_id, "answered", Some(&av), Some(&text)).await?.is_none() {
        return Ok(None);
    }
    // Kept only once the card is closed by this answer.
    if !host.is_empty() {
        remember(session_id, &host, matches!(decision, Decision::Once | Decision::Always));
    }
    tracing::info!("site_access_answered session_id={} question_id={} host={} allowed={}", session_id, question_id, host, !matches!(decision, Decision::Decline(_)));
    Ok(Some(text))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(items: &[&str]) -> Vec<Vec<String>> {
        vec![items.iter().map(|s| s.to_string()).collect()]
    }

    #[test]
    fn a_rule_is_a_host_or_a_wildcard() {
        assert_eq!(normalize_rule("Example.com").unwrap(), "example.com");
        assert_eq!(normalize_rule(" https://www.Example.com:8443/path?q=1 ").unwrap(), "example.com");
        assert_eq!(normalize_rule("*.example.com").unwrap(), "*.example.com");
        assert_eq!(normalize_rule("*.www.example.com").unwrap(), "*.www.example.com");
        assert_eq!(normalize_rule("192.168.1.20:3000").unwrap(), "192.168.1.20");
        assert_eq!(normalize_rule("intranet").unwrap(), "intranet");
        for bad in ["", "   ", "*", "*.", "exa mple.com", "a..b", "-a.com", "a_b.com", "https://", "*.*.example.com", "[::1]"] {
            assert!(normalize_rule(bad).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn a_host_covers_www_and_a_wildcard_covers_subdomains_only() {
        assert!(rule_matches("example.com", "example.com"));
        assert!(rule_matches("example.com", "www.example.com"));
        assert!(!rule_matches("example.com", "app.example.com"));
        assert!(!rule_matches("example.com", "notexample.com"));
        assert!(!rule_matches("example.com", "example.com.evil.test"));
        assert!(rule_matches("*.example.com", "app.example.com"));
        assert!(rule_matches("*.example.com", "a.b.example.com"));
        assert!(!rule_matches("*.example.com", "example.com"));
        assert!(!rule_matches("*.example.com", "evilexample.com"));
    }

    #[test]
    fn blocked_wins_and_the_default_settles_the_rest() {
        let rules = SiteRules { default: DefaultPolicy::Ask, allowed: vec!["example.com".into(), "*.corp.test".into()], blocked: vec!["bad.corp.test".into()] };
        assert_eq!(rules.access("www.example.com"), Access::Allowed);
        assert_eq!(rules.access("wiki.corp.test"), Access::Allowed);
        assert_eq!(rules.access("bad.corp.test"), Access::Blocked);
        assert_eq!(rules.access("other.test"), Access::Ask);
        let open = SiteRules { default: DefaultPolicy::Allow, blocked: vec!["bank.test".into()], ..Default::default() };
        assert_eq!(open.access("anything.test"), Access::Allowed);
        assert_eq!(open.access("www.bank.test"), Access::Blocked);
    }

    #[test]
    fn checked_rules_are_normalized_and_unique() {
        let rules = SiteRules { default: DefaultPolicy::Ask, allowed: vec!["https://www.example.com/x".into(), "EXAMPLE.com".into()], blocked: vec![] }.checked().unwrap();
        assert_eq!(rules.allowed, vec!["example.com"]);
        assert!(SiteRules { allowed: vec!["not a site".into()], ..Default::default() }.checked().is_err());
        assert!(SiteRules { blocked: vec!["x.test".into(); MAX_RULES + 1], ..Default::default() }.checked().is_err());
    }

    #[test]
    fn the_store_saves_an_allowed_site_and_reads_a_broken_file_as_ask() {
        let dir = tempfile::tempdir().unwrap();
        let store = SiteStore::at(dir.path().join("config").join("browser-sites.json"));
        assert_eq!(store.read(), SiteRules::default());
        store.write(&SiteRules { default: DefaultPolicy::Ask, allowed: vec![], blocked: vec!["example.com".into()] }).unwrap();
        assert_eq!(store.allow("www.Example.com").unwrap(), "example.com");
        let rules = store.read();
        assert_eq!(rules.allowed, vec!["example.com"]);
        assert!(rules.blocked.is_empty(), "allowing a site takes it off the blocked list");
        std::fs::write(dir.path().join("config").join("browser-sites.json"), "{not json").unwrap();
        assert_eq!(store.read(), SiteRules::default());
        std::fs::write(dir.path().join("config").join("browser-sites.json"), r#"{"default":"allow","allowed":["bad host"]}"#).unwrap();
        assert_eq!(store.read().default, DefaultPolicy::Ask, "a file with a bad entry is not trusted for its default either");
    }

    #[test]
    fn only_a_lone_allow_allows() {
        assert_eq!(decision(&a(&["Allow once"])), Decision::Once);
        assert_eq!(decision(&a(&[" Always allow "])), Decision::Always);
        assert_eq!(decision(&a(&["Decline"])), Decision::Decline(None));
        assert_eq!(decision(&[]), Decision::Decline(None));
        assert_eq!(decision(&a(&["allow once"])), Decision::Decline(Some("allow once".into())), "a typed answer is not the option");
        assert_eq!(decision(&a(&["Always allow", "but only the docs"])), Decision::Decline(Some("but only the docs".into())));
        assert_eq!(decision(&a(&["Allow once", "Always allow"])), Decision::Decline(None));
    }

    #[test]
    fn the_agents_tools_may_not_touch_the_rules_file() {
        let rules = SiteStore::user().path;
        assert!(appv3_tools::denied::secret_config_files().contains(&rules));
        let ws = tempfile::tempdir().unwrap();
        let denied = appv3_tools::DeniedPaths::new(ws.path(), None);
        let path = rules.to_string_lossy().to_string();
        assert!(denied.validate_read_path(&path).is_err(), "read");
        assert!(denied.validate_path(&path).is_err(), "write");
        assert!(denied.check_command(&format!("echo '{{\"default\":\"allow\"}}' > {path}")).is_some(), "shell");
    }

    #[test]
    fn a_chat_remembers_its_answer_until_the_lists_settle_the_site() {
        let dir = tempfile::tempdir().unwrap();
        use_store(SiteStore::at(dir.path().join("browser-sites.json")));
        let (chat, other) = ("01a20252-6447-729d-873f-a1fb6cac7369", "01a20252-6447-729d-873f-a1fb6cac7370");
        assert_eq!(decide(Some(chat), "www.shop.test"), Access::Ask);
        remember(chat, "www.shop.test", false);
        assert_eq!(decide(Some(chat), "www.shop.test"), Access::Declined);
        assert_eq!(decide(Some(chat), "shop.test"), Access::Declined, "www. and the bare host are one site");
        assert_eq!(decide(Some(chat), "pay.shop.test"), Access::Ask);
        assert_eq!(decide(Some(other), "shop.test"), Access::Ask, "another chat asks for itself");
        assert_eq!(decide(None, "shop.test"), Access::Ask);
        remember(chat, "docs.test", true);
        assert_eq!(decide(Some(chat), "www.docs.test"), Access::Allowed);
        // The lists come first, either way.
        store().allow("shop.test").unwrap();
        assert_eq!(decide(Some(chat), "www.shop.test"), Access::Allowed);
        store().write(&SiteRules { blocked: vec!["docs.test".into()], ..Default::default() }).unwrap();
        assert_eq!(decide(Some(chat), "docs.test"), Access::Blocked);
    }

    #[test]
    fn the_card_names_the_host_and_offers_three_answers() {
        let p = payload("www.threads.net", "https://www.threads.net/");
        assert_eq!(p["kind"], SITE_ACCESS_KIND);
        assert_eq!(p["site"]["host"], "threads.net");
        let labels: Vec<&str> = p["questions"][0]["options"].as_array().unwrap().iter().map(|o| o["label"].as_str().unwrap()).collect();
        assert_eq!(labels, vec![ALLOW_ONCE, ALLOW_ALWAYS, DECLINE]);
        assert!(p["questions"][0]["question"].as_str().unwrap().contains("**threads.net**"));
    }

    #[test]
    fn the_result_tells_the_agent_what_it_may_do() {
        assert!(result_text("x.test", &Decision::Once, None).contains("allowed x.test for this chat"));
        assert!(result_text("x.test", &Decision::Always, Some(&Ok("x.test".into()))).contains("it is saved"));
        assert!(result_text("x.test", &Decision::Always, Some(&Err("disk full.".into()))).contains("could not be saved for later: disk full."));
        assert!(result_text("x.test", &Decision::Decline(None), None).contains("may not use x.test"));
        assert!(result_text("x.test", &Decision::Decline(Some("Not this one".into())), None).ends_with("They said:\n\nNot this one"));
    }
}
