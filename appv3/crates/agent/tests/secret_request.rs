//! The `secret` tool end to end: a card asks for keys by name, values reach
//! the store only (as `PUT /api/secrets` puts them), the agent learns names,
//! uses keys through `shell`'s `secrets`, and reads `[secret NAME]` wherever
//! a value would have appeared. Scenario ids refer to the plan's scenarios.md.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::secret_request::{self as sr, KeyAnswer, SecretAnswer, SECRET_KIND};
use appv3_agent::session::{AgentSession, UserMessage};
use appv3_agent::Agent;
use appv3_core::agent_secrets::{self, Change};
use appv3_providers::mock::{MockProvider, MockTurn};
use appv3_providers::{ChatMessage, LlmProvider};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

fn root() -> &'static Path {
    static ROOT: OnceLock<tempfile::TempDir> = OnceLock::new();
    ROOT.get_or_init(|| {
        let dir = tempfile::tempdir().unwrap();
        for (k, d) in [
            ("OPENAGENTD_DATA_DIR", "data"),
            ("OPENAGENTD_CONFIG_DIR", "config"),
            ("OPENAGENTD_STATE_DIR", "state"),
            ("OPENAGENTD_CACHE_DIR", "cache"),
            ("OPENAGENTD_WORKSPACE_DIR", "ws"),
        ] {
            std::env::set_var(k, dir.path().join(d));
        }
        std::env::set_var("HOME", dir.path().join("home"));
        std::env::set_var("USERPROFILE", dir.path().join("home"));
        std::env::remove_var("CHAT_WORKSPACE_DIR");
        std::fs::create_dir_all(dir.path().join("home")).unwrap();
        std::fs::create_dir_all(dir.path().join("config")).unwrap();
        std::fs::write(dir.path().join("config").join("settings.yaml"), "title_generation:\n  enabled: false\n").unwrap();
        appv3_core::settings::install(appv3_core::settings::Settings::from_env());
        dir
    })
    .path()
}

/// A git repository folder (a `.git` directory is enough to be a project).
fn repo(name: &str) -> PathBuf {
    let p = root().join("repos").join(name);
    std::fs::create_dir_all(p.join(".git")).unwrap();
    dunce::canonicalize(p).unwrap()
}

fn project(p: &Path) -> String {
    agent_secrets::project_of(p)
}

/// Save a value the way `PUT /api/secrets` does.
fn put(name: &str, value: &str, projects: &[&str]) -> String {
    appv3_core::credentials::update(|f| {
        agent_secrets::set(
            f,
            name,
            Change { value: Some(value.into()), projects: Some(projects.iter().map(|s| s.to_string()).collect()), source: "chat".into(), ..Default::default() },
        )
    })
    .unwrap()
    .unwrap()
}

fn put_id(name: &str, id: &str, value: &str) {
    appv3_core::credentials::update(|f| agent_secrets::set(f, name, Change { id: Some(id.into()), value: Some(value.into()), ..Default::default() })).unwrap().unwrap();
}

fn value_in(name: &str, p: &Path) -> Option<String> {
    agent_secrets::resolve(&appv3_core::credentials::snapshot(), name, &project(p)).map(|s| s.value.clone())
}

struct Harness {
    pool: appv3_db::DbPool,
    session: Arc<AgentSession>,
    provider: Arc<MockProvider>,
    sid: String,
}

async fn harness(name: &str, ws: &Path, turns: Vec<MockTurn>) -> Harness {
    let pool = appv3_db::create_pool(root().join(format!("{name}.db"))).await.unwrap();
    let provider = Arc::new(MockProvider::new(turns));
    let p: Arc<dyn LlmProvider> = provider.clone();
    let p2 = p.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
    let id = uuid::Uuid::now_v7();
    let sid = id.to_string();
    let workspace = ws.display().to_string();
    let agent = Agent::new(p, "code", "You are a test agent.", vec![Arc::new(appv3_tools::shell::ShellTool)], Some("mock:mock".into()));
    let session = AgentSession::new(agent, None, Some(workspace.clone()), pool.clone(), factory, None);
    appv3_db::create_session(&pool, appv3_db::NewSession { id: Some(id), workspace, ..Default::default() }).await.unwrap();
    Harness { pool, session, provider, sid }
}

impl Harness {
    async fn send(&self, text: &str) {
        self.session.handle_user_message(UserMessage { content: text.into(), session_id: self.sid.clone(), origin: "user".into(), ..Default::default() }).await.unwrap();
        self.settle().await;
    }
    async fn settle(&self) {
        tokio::time::timeout(Duration::from_secs(20), self.session.wait_turn_finished()).await.expect("turn settles");
    }
    async fn card(&self) -> (appv3_db::PendingQuestion, serde_json::Value) {
        let row = appv3_db::get_pending_question(&self.pool, &self.sid).await.unwrap().expect("an open card");
        assert_eq!(row.kind().as_deref(), Some(SECRET_KIND));
        let card = row.secret_request().expect("card data");
        (row, card)
    }
    async fn answer(&self, row: &appv3_db::PendingQuestion, a: SecretAnswer) -> String {
        let qid = appv3_db::codec::api_uuid(&row.id);
        let text = sr::answer(&self.pool, &self.sid, &qid, &a).await.unwrap().expect("the card was open");
        self.session.resume_after_question_answer().await;
        self.settle().await;
        text
    }
    fn tool_result(&self, call: usize, id: &str) -> String {
        let calls = self.provider.calls.lock().unwrap();
        calls[call]
            .0
            .iter()
            .find_map(|m| match m {
                ChatMessage::Tool { tool_call_id, .. } if tool_call_id == id => m.content().map(String::from),
                _ => None,
            })
            .unwrap_or_else(|| panic!("no result for {id}"))
    }
    /// Every stored row of the session, as text, to search for values.
    async fn stored_text(&self) -> String {
        let rows: Vec<(String,)> =
            sqlx::query_as("SELECT COALESCE(content, '') || COALESCE(reasoning_content, '') || COALESCE(tool_calls, '') || COALESCE(extra, '') FROM session_messages")
                .fetch_all(&self.pool)
                .await
                .unwrap();
        let mut out: String = rows.into_iter().map(|r| r.0 + "\n").collect();
        let q: Vec<(String, Option<String>)> = sqlx::query_as("SELECT payload, answers FROM pending_questions").fetch_all(&self.pool).await.unwrap();
        out.push_str(&format!("{q:?}"));
        out
    }
}

fn req(keys: serde_json::Value) -> String {
    json!({"action": "request", "reason": "Checkout stores receipts in S3 and charges through Stripe.", "keys": keys}).to_string()
}

fn provided(names: &[&str]) -> SecretAnswer {
    SecretAnswer { keys: names.iter().map(|n| KeyAnswer { name: n.to_string(), action: "provided".into(), id: None }).collect(), ..Default::default() }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn b3_one_card_new_keys_and_a_different_stripe_value_for_client_b() {
    let (a, b) = (repo("client-a"), repo("client-b"));
    put("STRIPE_SECRET_KEY", "sk_test_client_a_01", &[&project(&a)]);
    // The shell tool runs PowerShell on Windows, where `$NAME` is not the environment.
    let command = if cfg!(windows) {
        "Write-Output \"key=$env:STRIPE_SECRET_KEY id=$env:AWS_ACCESS_KEY_ID\"; Write-Output $env:STRIPE_SECRET_KEY.Length"
    } else {
        "echo \"key=$STRIPE_SECRET_KEY id=$AWS_ACCESS_KEY_ID\"; printf %s \"$STRIPE_SECRET_KEY\" | wc -c"
    };
    let shell = json!({"command": command, "secrets": ["STRIPE_SECRET_KEY", "AWS_ACCESS_KEY_ID"]});
    let h = harness(
        "b3",
        &b,
        vec![
            MockProvider::tool_call("c1", "secret", &req(json!([{"name": "AWS_ACCESS_KEY_ID"}, {"name": "AWS_SECRET_ACCESS_KEY"}, {"name": "STRIPE_SECRET_KEY"}]))),
            MockProvider::tool_call("c2", "shell", &shell.to_string()),
            MockProvider::text("Done."),
        ],
    )
    .await;
    h.send("Wire up checkout.").await;
    assert_eq!(h.session.state(), "waiting_input", "the request pauses the turn");
    let (row, card) = h.card().await;
    let states: Vec<&str> = card["keys"].as_array().unwrap().iter().map(|k| k["state"].as_str().unwrap()).collect();
    assert_eq!(states, ["new", "new", "elsewhere"]);
    assert_eq!(card["keys"][2]["values"][0]["projects"][0]["name"], json!("client-a"));

    // The card PUTs each value for this project, then answers with names.
    let pb = project(&b);
    put("AWS_ACCESS_KEY_ID", "AKIA_EXAMPLE_CLIENT_B", &[&pb]);
    put("AWS_SECRET_ACCESS_KEY", "wJalrEXAMPLEclientBsecret", &[&pb]);
    put("STRIPE_SECRET_KEY", "sk_test_client_b_0002", &[&pb]);
    let text = h.answer(&row, provided(&["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "STRIPE_SECRET_KEY"])).await;
    assert!(text.starts_with("The user provided AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, STRIPE_SECRET_KEY."), "{text}");
    assert!(text.contains("secrets: [\"AWS_ACCESS_KEY_ID\", \"AWS_SECRET_ACCESS_KEY\", \"STRIPE_SECRET_KEY\"]"), "{text}");
    assert_eq!(h.tool_result(1, "c1"), text, "the agent reads names only");

    let out = h.tool_result(2, "c2");
    assert!(out.contains("key=[secret STRIPE_SECRET_KEY] id=[secret AWS_ACCESS_KEY_ID]"), "values are masked: {out}");
    assert!(out.contains("21"), "the command saw client-b's 21-character key: {out}");
    assert_eq!(value_in("STRIPE_SECRET_KEY", &a).as_deref(), Some("sk_test_client_a_01"), "client-a keeps its own");
    assert_eq!(value_in("STRIPE_SECRET_KEY", &b).as_deref(), Some("sk_test_client_b_0002"));

    let stored = h.stored_text().await;
    for v in ["sk_test_client_a_01", "sk_test_client_b_0002", "AKIA_EXAMPLE_CLIENT_B", "wJalrEXAMPLEclientBsecret"] {
        assert!(!stored.contains(v), "{v} reached the session's rows");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn b2_a_token_saved_for_another_project_is_reused_and_a9_then_needs_no_card() {
    let (x, y) = (repo("tools-x"), repo("tools-y"));
    let id = put("RELEASE_TOKEN", "rel_token_value_123", &[&project(&x)]);
    let ask = req(json!([{"name": "RELEASE_TOKEN"}]));
    let h = harness("b2", &y, vec![MockProvider::tool_call("c1", "secret", &ask), MockProvider::tool_call("c2", "secret", &ask), MockProvider::text("OK.")]).await;
    h.send("Cut a release.").await;
    let (row, card) = h.card().await;
    assert_eq!(card["keys"][0]["state"], json!("elsewhere"));
    let text = h.answer(&row, SecretAnswer { keys: vec![KeyAnswer { name: "RELEASE_TOKEN".into(), action: "reuse".into(), id: Some(id) }], ..Default::default() }).await;
    assert!(text.starts_with("They chose saved values for RELEASE_TOKEN."), "{text}");
    assert_eq!(value_in("RELEASE_TOKEN", &y).as_deref(), Some("rel_token_value_123"));
    assert_eq!(value_in("RELEASE_TOKEN", &x).as_deref(), Some("rel_token_value_123"));
    // Asked again: usable here now, so no card.
    assert!(h.tool_result(2, "c2").starts_with("Already available in this project: RELEASE_TOKEN."));
    assert!(appv3_db::get_pending_question(&h.pool, &h.sid).await.unwrap().is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn d2_a_rejected_key_is_replaced_only_in_this_project() {
    let (w, d) = (repo("weather-app"), repo("dashboard"));
    let id = put("OPENWEATHER_API_KEY", "owm_old_value_0001", &[&project(&w), &project(&d)]);
    let ask = json!({"action": "request", "reason": "The saved key was rejected: 401 Invalid API key.", "replace": true, "keys": [{"name": "OPENWEATHER_API_KEY"}]}).to_string();
    let h = harness("d2", &w, vec![MockProvider::tool_call("c1", "secret", &ask), MockProvider::text("OK.")]).await;
    h.send("The weather call fails.").await;
    let (row, card) = h.card().await;
    assert_eq!(card["keys"][0]["state"], json!("replace"));
    assert_eq!(card["keys"][0]["values"][0]["id"], json!(id));
    // "Use the new value only in this project": a new value for this project.
    put("OPENWEATHER_API_KEY", "owm_new_value_0002", &[&project(&w)]);
    let text = h.answer(&row, provided(&["OPENWEATHER_API_KEY"])).await;
    assert!(text.starts_with("The user saved new values for OPENWEATHER_API_KEY."), "{text}");
    assert_eq!(value_in("OPENWEATHER_API_KEY", &w).as_deref(), Some("owm_new_value_0002"));
    assert_eq!(value_in("OPENWEATHER_API_KEY", &d).as_deref(), Some("owm_old_value_0001"), "the other project is unchanged");
    // "Everywhere" instead rewrites the shared value in place.
    put_id("OPENWEATHER_API_KEY", &id, "owm_rotated_0003");
    assert_eq!(value_in("OPENWEATHER_API_KEY", &d).as_deref(), Some("owm_rotated_0003"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn c4_a_secret_not_usable_here_is_refused_and_a8_a_decline_is_reported() {
    let (p, other) = (repo("refuse-p"), repo("refuse-other"));
    put("ONLY_ELSEWHERE_KEY", "elsewhere_value_123", &[&project(&other)]);
    let shell = json!({"command": "echo $ONLY_ELSEWHERE_KEY", "secrets": ["ONLY_ELSEWHERE_KEY"]}).to_string();
    let h = harness(
        "c4",
        &p,
        vec![MockProvider::tool_call("c1", "shell", &shell), MockProvider::tool_call("c2", "secret", &req(json!([{"name": "ONLY_ELSEWHERE_KEY"}]))), MockProvider::text("OK.")],
    )
    .await;
    h.send("Go.").await;
    let (row, _) = h.card().await;
    let text = h.answer(&row, SecretAnswer { declined: true, reason: Some("Use the sandbox account instead.".into()), ..Default::default() }).await;
    let refused = h.tool_result(1, "c1");
    assert!(refused.contains("ONLY_ELSEWHERE_KEY is not available in this project") && refused.contains("`secret` tool"), "{refused}");
    assert!(text.starts_with("The user declined to provide ONLY_ELSEWHERE_KEY.") && text.contains("Use the sandbox account instead."), "{text}");
    assert_eq!(value_in("ONLY_ELSEWHERE_KEY", &p), None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn e1_a_stored_value_in_any_tool_output_is_masked() {
    let p = repo("mask-p");
    put("MASKED_API_KEY", "mask_me_value_9876", &["*"]);
    std::fs::write(p.join("notes.txt"), "the key is mask_me_value_9876\n").unwrap();
    let h = harness("e1", &p, vec![MockProvider::tool_call("c1", "shell", &json!({"command": "cat notes.txt"}).to_string()), MockProvider::text("OK.")]).await;
    h.send("Read the notes.").await;
    let out = h.tool_result(1, "c1");
    assert!(out.contains("the key is [secret MASKED_API_KEY]"), "{out}");
    assert!(!h.stored_text().await.contains("mask_me_value_9876"));
}
