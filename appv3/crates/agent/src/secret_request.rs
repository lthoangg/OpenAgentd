//! The card the `secret` tool opens, and its answer.
//!
//! A request names the keys a task needs. The card shows a masked field for
//! each one; the browser sends each value straight to `PUT /api/secrets`
//! (the only route that ever takes a value), then answers the card with
//! names and choices only. [`answer`] checks those names against the store,
//! records reuse of a value saved for another project, and writes the tool
//! result the agent reads: names, never values.

use appv3_core::agent_secrets::{self, AgentSecret, ALL_PROJECTS};
use appv3_core::credentials::CredentialsFile;
use appv3_db::{self as db, DbPool};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;

pub const SECRET_KIND: &str = "secret_request";
/// Longest reason the user types when declining.
pub const MAX_REASON_CHARS: usize = 2000;

/// A key's state on the card.
pub mod state {
    /// Usable here already; not shown on the card.
    pub const AVAILABLE: &str = "available";
    /// Never saved: paste it.
    pub const NEW: &str = "new";
    /// Saved for other projects only: reuse one, or paste a different one.
    pub const ELSEWHERE: &str = "elsewhere";
    /// Usable here, and the agent says it was rejected: replace it.
    pub const REPLACE: &str = "replace";
}

/// One key the agent asks for.
#[derive(Debug, Clone)]
pub struct KeyAsk {
    pub name: String,
    pub help_url: Option<String>,
    pub optional: bool,
    pub multiline: bool,
}

/// The display name of a project key (its folder name).
pub fn project_name(key: &str) -> String {
    if key == ALL_PROJECTS {
        return "all projects".into();
    }
    Path::new(key).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| key.to_string())
}

fn value_json(s: &AgentSecret) -> Value {
    json!({
        "id": s.id,
        "all": s.for_all(),
        "projects": s.projects.iter().filter(|p| *p != ALL_PROJECTS).map(|p| json!({"key": p, "name": project_name(p)})).collect::<Vec<_>>(),
        "updated": s.updated,
    })
}

/// The card data for `keys` in `project`: each key's state and the saved
/// values it may reuse or replace (ids and projects, never a value).
pub fn card(f: &CredentialsFile, project: &str, reason: &str, keys: &[KeyAsk], replace: bool) -> Value {
    let rows: Vec<Value> = keys
        .iter()
        .map(|k| {
            let here = agent_secrets::resolve(f, &k.name, project);
            let (st, values): (&str, Vec<Value>) = match here {
                Some(s) if replace => (state::REPLACE, vec![value_json(s)]),
                Some(_) => (state::AVAILABLE, vec![]),
                None => {
                    let others: Vec<Value> = f.agent_secrets.get(&k.name).map(|l| l.iter().filter(|s| !s.value.is_empty()).map(value_json).collect()).unwrap_or_default();
                    if others.is_empty() {
                        (state::NEW, vec![])
                    } else {
                        (state::ELSEWHERE, others)
                    }
                }
            };
            json!({"name": k.name, "help_url": k.help_url, "optional": k.optional, "multiline": k.multiline, "state": st, "values": values})
        })
        .collect();
    json!({"project": project, "project_name": project_name(project), "reason": reason, "replace": replace, "keys": rows})
}

/// Whether every key of a card is usable already (no card needed).
pub fn all_available(card: &Value) -> bool {
    card["keys"].as_array().is_some_and(|k| k.iter().all(|k| k["state"] == state::AVAILABLE))
}

/// The `pending_questions` payload: the card, plus a plain question older
/// clients show (they cannot answer it; a typed answer is refused).
pub fn payload(card: &Value) -> Value {
    let names: Vec<&str> = card["keys"].as_array().into_iter().flatten().filter(|k| k["state"] != state::AVAILABLE).filter_map(|k| k["name"].as_str()).collect();
    let question = format!("The agent needs {}. Update OpenAgentd to answer this card.", names.join(", "));
    json!({
        "kind": SECRET_KIND,
        "secret": card,
        "questions": [{"question": question, "header": "Secrets", "options": [], "multiple": false, "custom": false}],
    })
}

/// How the user answered one key.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct KeyAnswer {
    pub name: String,
    /// `provided` (its value was saved through `/api/secrets`), `reuse`
    /// (use the saved value `id`), or `skip`.
    pub action: String,
    #[serde(default)]
    pub id: Option<String>,
}

/// The card's answer: names and choices only.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
pub struct SecretAnswer {
    #[serde(default)]
    pub declined: bool,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub keys: Vec<KeyAnswer>,
}

#[derive(Default)]
struct Outcome {
    provided: Vec<String>,
    reused: Vec<String>,
    skipped: Vec<String>,
    available: Vec<String>,
    failed: Vec<String>,
}

fn list(names: &[String]) -> String {
    names.join(", ")
}

fn result_text(o: &Outcome, replace: bool) -> String {
    let mut parts = vec![];
    if !o.provided.is_empty() {
        parts.push(format!("The user {} {}.", if replace { "saved new values for" } else { "provided" }, list(&o.provided)));
    }
    if !o.reused.is_empty() {
        parts.push(format!("They chose saved values for {}.", list(&o.reused)));
    }
    if !o.available.is_empty() {
        parts.push(format!("Already available: {}.", list(&o.available)));
    }
    if !o.skipped.is_empty() {
        parts.push(format!("Skipped: {}.", list(&o.skipped)));
    }
    if !o.failed.is_empty() {
        parts.push(format!("Not saved: {}.", o.failed.join("; ")));
    }
    let usable: Vec<String> = o.provided.iter().chain(&o.reused).chain(&o.available).cloned().collect();
    if usable.is_empty() {
        parts.push("No secret is available yet. Do not ask the user to paste a key in chat; ask with `secret` again only if they say so.".into());
    } else {
        let quoted: Vec<String> = usable.iter().map(|n| format!("\"{n}\"")).collect();
        parts.push(format!(
            "Use them in commands with the shell tool's `secrets` argument, e.g. secrets: [{}], and refer to each as ${}. You never see the values; never ask the user to paste them in chat.",
            quoted.join(", "),
            usable[0]
        ));
    }
    parts.join(" ")
}

/// What the transcript shows for the answer (one line each; names only):
/// stored as the question's answers and sent with `question_answered`.
fn summary_lines(o: &Outcome, declined: bool, replace: bool) -> Vec<String> {
    if declined {
        return vec!["Declined".into()];
    }
    let mut lines = vec![];
    let mut add = |label: &str, names: &[String]| {
        if !names.is_empty() {
            lines.push(format!("{label}: {}", names.join(", ")));
        }
    };
    add(if replace { "Replaced" } else { "Provided" }, &o.provided);
    add("Using saved", &o.reused);
    add("Already available", &o.available);
    add("Skipped", &o.skipped);
    add("Not saved", &o.failed);
    lines
}

/// Close the open secret card `question_id` with `a`. Returns the tool
/// result the agent reads, or `None` when the card was no longer open.
pub async fn answer(pool: &DbPool, session_id: &str, question_id: &str, a: &SecretAnswer) -> anyhow::Result<Option<String>> {
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _g = LOCK.lock().await;
    let Some(row) = db::get_question(pool, question_id).await?.filter(|r| r.status == "pending" && r.kind().as_deref() == Some(SECRET_KIND)) else { return Ok(None) };
    let card = row.secret_request().unwrap_or_default();
    let project = card["project"].as_str().unwrap_or_default().to_string();
    let replace = card["replace"].as_bool().unwrap_or(false);
    let reason = a.reason.as_deref().map(str::trim).filter(|r| !r.is_empty()).map(|r| r.chars().take(MAX_REASON_CHARS).collect::<String>());
    let mut o = Outcome::default();
    let text = if a.declined {
        let names: Vec<String> =
            card["keys"].as_array().into_iter().flatten().filter(|k| k["state"] != state::AVAILABLE).filter_map(|k| k["name"].as_str().map(String::from)).collect();
        let mut t = format!("The user declined to provide {}.", list(&names));
        if let Some(r) = &reason {
            t.push_str(&format!(" They said:\n\n{r}\n\n"));
        }
        t.push_str(" Do not ask for them again unless the user says so, and never ask them to paste a key in chat.");
        t.trim().to_string()
    } else {
        for k in card["keys"].as_array().into_iter().flatten() {
            let name = k["name"].as_str().unwrap_or_default().to_string();
            if k["state"] == state::AVAILABLE {
                o.available.push(name);
                continue;
            }
            match a.keys.iter().find(|x| x.name == name) {
                Some(x) if x.action == "provided" => {
                    let f = appv3_core::credentials::snapshot();
                    match agent_secrets::resolve(&f, &name, &project) {
                        Some(_) => o.provided.push(name),
                        None => o.failed.push(format!("{name} (no value reached the server)")),
                    }
                }
                Some(x) if x.action == "reuse" => {
                    let id = x.id.clone().unwrap_or_default();
                    let done = appv3_core::credentials::update(|f| agent_secrets::add_project(f, &name, &id, &project)).map_err(|e| e.to_string()).and_then(|r| r);
                    match done {
                        Ok(()) => o.reused.push(name),
                        Err(e) => o.failed.push(format!("{name} ({e})")),
                    }
                }
                _ => o.skipped.push(name),
            }
        }
        let mut t = result_text(&o, replace);
        if let Some(r) = &reason {
            t.push_str(&format!(" The user added:\n\n{r}"));
        }
        t
    };
    let summary = json!([summary_lines(&o, a.declined, replace)]);
    if db::resolve_pending_question_with(pool, question_id, "answered", Some(&summary), Some(&text)).await?.is_none() {
        return Ok(None);
    }
    tracing::info!("secret_request_answered session_id={} question_id={} declined={}", session_id, question_id, a.declined);
    Ok(Some(text))
}

/// The answer's summary (names only) for the `question_answered` event.
pub async fn answered_summary(pool: &DbPool, question_id: &str) -> Value {
    db::get_question(pool, question_id).await.ok().flatten().and_then(|r| r.answers_json()).unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use appv3_core::agent_secrets::{set, Change};

    fn ask(name: &str) -> KeyAsk {
        KeyAsk { name: name.into(), help_url: None, optional: false, multiline: false }
    }

    fn put(f: &mut CredentialsFile, name: &str, value: &str, projects: &[&str]) -> String {
        set(f, name, Change { value: Some(value.into()), projects: Some(projects.iter().map(|s| s.to_string()).collect()), ..Default::default() }).unwrap()
    }

    #[test]
    fn the_card_says_what_each_key_needs_and_never_holds_a_value() {
        let mut f = CredentialsFile::default();
        let a = put(&mut f, "STRIPE_SECRET_KEY", "sk_live_client_a", &["/w/client-a"]);
        put(&mut f, "GITHUB_TOKEN", "ghp_everywhere_1", &["*"]);
        let c = card(&f, "/w/client-b", "Checkout", &[ask("AWS_ACCESS_KEY_ID"), ask("STRIPE_SECRET_KEY"), ask("GITHUB_TOKEN")], false);
        let states: Vec<&str> = c["keys"].as_array().unwrap().iter().map(|k| k["state"].as_str().unwrap()).collect();
        assert_eq!(states, ["new", "elsewhere", "available"]);
        assert_eq!(c["keys"][1]["values"][0]["id"], json!(a));
        assert_eq!(c["keys"][1]["values"][0]["projects"][0]["name"], json!("client-a"));
        assert_eq!(c["project_name"], json!("client-b"));
        let text = payload(&c).to_string();
        assert!(!text.contains("sk_live_client_a") && !text.contains("ghp_everywhere_1"), "{text}");
        assert!(!all_available(&c));
    }

    #[test]
    fn a9_keys_usable_here_need_no_card_unless_they_are_replaced() {
        let mut f = CredentialsFile::default();
        put(&mut f, "K", "value-123456", &["/p"]);
        assert!(all_available(&card(&f, "/p", "r", &[ask("K")], false)));
        let c = card(&f, "/p", "r", &[ask("K")], true);
        assert_eq!(c["keys"][0]["state"], json!("replace"));
        assert!(!all_available(&c));
    }
}
