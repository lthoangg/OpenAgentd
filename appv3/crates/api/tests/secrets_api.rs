//! `/api/secrets` and the secret card's answer route: values go in through
//! `PUT` only, never come back out (API, rows, events, the server log), a
//! typed answer from an older client is refused, and connectors resolve
//! `${NAME}` from the right value. One test: settings are process-global.

use appv3_agent::secret_request::{self as sr, KeyAsk};
use appv3_api::{create_app, AppState, ConnInfo, Policy};
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::io::Write;
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

async fn call(app: &Router, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    let mut b = Request::builder().method(method).uri(uri);
    let body = match body {
        Some(v) => {
            b = b.header("content-type", "application/json");
            Body::from(v.to_string())
        }
        None => Body::empty(),
    };
    let mut req = b.body(body).unwrap();
    req.extensions_mut().insert(ConnectInfo(ConnInfo { local: Some("127.0.0.1:8000".parse().unwrap()), remote: Some("127.0.0.1:50000".parse().unwrap()) }));
    let resp = app.clone().oneshot(req).await.unwrap();
    let (parts, body) = resp.into_parts();
    (parts.status, serde_json::from_slice(&body.collect().await.unwrap().to_bytes()).unwrap_or(Value::Null))
}

/// Everything the server logs, at every level.
#[derive(Clone, Default)]
struct Log(Arc<Mutex<Vec<u8>>>);
impl Write for Log {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
impl Log {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
    }
}

fn repo(root: &std::path::Path, name: &str) -> String {
    let p = root.join("repos").join(name);
    std::fs::create_dir_all(p.join(".git")).unwrap();
    dunce::canonicalize(p).unwrap().display().to_string()
}

const VALUES: [&str; 5] = ["sk_test_client_a_01", "sk_test_client_b_0002", "AKIA_EXAMPLE_CLIENT_B", "ghp_every_project_123", "typed_in_old_client_99"];

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn secrets_go_in_by_put_only_and_never_come_back_out() {
    let log = Log::default();
    let writer = log.clone();
    tracing_subscriber::fmt().with_max_level(tracing::Level::TRACE).with_writer(move || writer.clone()).with_ansi(false).init();

    let root = tempfile::tempdir().unwrap();
    for (k, d) in [
        ("OPENAGENTD_DATA_DIR", "data"),
        ("OPENAGENTD_CONFIG_DIR", "config"),
        ("OPENAGENTD_STATE_DIR", "state"),
        ("OPENAGENTD_CACHE_DIR", "cache"),
        ("OPENAGENTD_WORKSPACE_DIR", "ws"),
    ] {
        std::env::set_var(k, root.path().join(d));
    }
    std::env::set_var("HOME", root.path().join("home"));
    std::env::set_var("OPENAGENTD_ENV", "production");
    std::env::set_var("OPENAGENTD_MODEL_REGISTRY_REFRESH", "false");
    std::env::set_var("OPENAGENTD_SNAPSHOT_MAINTENANCE_ENABLED", "false");
    for k in ["OPENAGENTD_DESKTOP_TOKEN", "OPENAGENTD_ACCESS_KEY", "DATABASE_URL", "OPENAGENTD_DATABASE_URL", "STRIPE_SECRET_KEY", "GITHUB_TOKEN"] {
        std::env::remove_var(k);
    }
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
    let s = appv3_core::settings();
    std::fs::create_dir_all(s.database_path.parent().unwrap()).unwrap();
    let pool = appv3_db::create_pool(&s.database_path).await.unwrap();
    appv3_db::migrations::run_migrations(&pool).await.unwrap();
    appv3_api::startup::startup(&pool).await.unwrap();
    let app = create_app(AppState { pool: pool.clone() }, Policy::from_env());
    let (a, b) = (repo(root.path(), "client-a"), repo(root.path(), "client-b"));

    // ── PUT saves; GET lists names and projects, never a value ──────────
    let (st, v) = call(&app, "PUT", "/api/secrets/STRIPE_SECRET_KEY", Some(json!({"value": " sk_test_client_a_01\n", "projects": [a.clone()], "source": "chat"}))).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let a_id = v["id"].as_str().unwrap().to_string();
    let (st, v) = call(&app, "PUT", "/api/secrets/GITHUB_TOKEN", Some(json!({"value": "ghp_every_project_123", "projects": ["*"]}))).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let (_, listing) = call(&app, "GET", &format!("/api/secrets?workspace={b}"), None).await;
    assert_eq!(listing["project"]["name"], json!("client-b"));
    assert_eq!(listing["usable"], json!(["GITHUB_TOKEN"]));
    let stripe = listing["secrets"].as_array().unwrap().iter().find(|s| s["name"] == "STRIPE_SECRET_KEY").unwrap();
    assert_eq!((stripe["projects"][0]["name"].as_str(), stripe["all"].as_bool()), (Some("client-a"), Some(false)));
    assert_eq!(
        appv3_core::agent_secrets::resolve(&appv3_core::credentials::snapshot(), "STRIPE_SECRET_KEY", &a).unwrap().value,
        "sk_test_client_a_01",
        "a pasted space and newline are trimmed"
    );

    // ── refused names and a second every-project value ──────────────────
    let (st, v) = call(&app, "PUT", "/api/secrets/LD_PRELOAD", Some(json!({"value": "x".repeat(20), "projects": ["*"]}))).await;
    assert!(st == StatusCode::UNPROCESSABLE_ENTITY && v.to_string().contains("changes how commands run"), "{st} {v}");
    let (st, _) = call(&app, "PUT", "/api/secrets/GITHUB_TOKEN", Some(json!({"value": "ghp_second_value_00", "projects": ["*"]}))).await;
    assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY);

    // ── a card in client-b: a typed answer is refused, PUT + names work ─
    let sid = uuid::Uuid::now_v7();
    appv3_db::create_session(&pool, appv3_db::NewSession { id: Some(sid), workspace: b.clone(), ..Default::default() }).await.unwrap();
    let sid = sid.to_string();
    let keys = [
        KeyAsk { name: "AWS_ACCESS_KEY_ID".into(), help_url: None, optional: false, multiline: false },
        KeyAsk { name: "STRIPE_SECRET_KEY".into(), help_url: None, optional: false, multiline: false },
    ];
    let card = sr::card(&appv3_core::credentials::snapshot(), &b, "Checkout", &keys, false);
    let row = appv3_db::create_pending_question_with(&pool, &sid, "c1", "secret", &sr::payload(&card)).await.unwrap();
    let qid = appv3_db::codec::api_uuid(&row.id);
    // A client attached to the session's stream sees every frame of the card.
    appv3_agent::store().init_turn(&sid, false);
    let mut sub = appv3_agent::store().attach(&sid).expect("a streaming turn");
    appv3_agent::store().push_event(&sid, &appv3_agent::events::secret_request_asked(&qid, &sid, "c1", &row.questions(), &card), false);
    let (_, q) = call(&app, "GET", &format!("/api/agent/{sid}/question"), None).await;
    assert_eq!(q["question"]["kind"], json!("secret_request"));
    assert_eq!(q["question"]["secret"]["keys"][1]["state"], json!("elsewhere"));
    let answer_uri = format!("/api/agent/{sid}/question/{qid}/answer");
    let (st, _) = call(&app, "POST", &answer_uri, Some(json!({"answers": [["typed_in_old_client_99"]]}))).await;
    assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY, "an older client's typed answer is not taken");
    assert!(appv3_db::get_pending_question(&pool, &sid).await.unwrap().is_some(), "the card stays open");

    for (name, value) in [("AWS_ACCESS_KEY_ID", "AKIA_EXAMPLE_CLIENT_B"), ("STRIPE_SECRET_KEY", "sk_test_client_b_0002")] {
        let (st, v) = call(&app, "PUT", &format!("/api/secrets/{name}"), Some(json!({"value": value, "projects": [b.clone()], "source": "chat"}))).await;
        assert_eq!(st, StatusCode::OK, "{v}");
    }
    let body = json!({"secret": {"keys": [{"name": "AWS_ACCESS_KEY_ID", "action": "provided"}, {"name": "STRIPE_SECRET_KEY", "action": "provided"}]}});
    let (st, v) = call(&app, "POST", &answer_uri, Some(body)).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let result: (String,) = sqlx::query_as("SELECT content FROM session_messages WHERE tool_call_id = 'c1'").fetch_one(&pool).await.unwrap();
    assert!(result.0.starts_with("The user provided AWS_ACCESS_KEY_ID, STRIPE_SECRET_KEY."), "{}", result.0);
    let snap = appv3_core::credentials::snapshot();
    assert_eq!(appv3_core::agent_secrets::resolve(&snap, "STRIPE_SECRET_KEY", &a).unwrap().value, "sk_test_client_a_01", "client-a keeps its own");
    assert_eq!(appv3_core::agent_secrets::resolve(&snap, "STRIPE_SECRET_KEY", &b).unwrap().value, "sk_test_client_b_0002");

    // ── connectors: a project's server gets its project's value; the ─────
    // ── user's own servers get only the every-project value ─────────────
    use appv3_mcp::config::{resolve_secret_refs_in, resolve_secret_refs_with};
    assert_eq!(resolve_secret_refs_with("${GITHUB_TOKEN}", true), "ghp_every_project_123");
    assert_eq!(resolve_secret_refs_with("${STRIPE_SECRET_KEY}", true), "${STRIPE_SECRET_KEY}", "a project's own value is not the user's servers'");
    assert_eq!(resolve_secret_refs_in("${STRIPE_SECRET_KEY}", false, Some(&b)), "sk_test_client_b_0002");
    assert_eq!(resolve_secret_refs_in("${STRIPE_SECRET_KEY}", false, Some(&a)), "sk_test_client_a_01");

    // ── nothing returned or stored anywhere but credentials.yaml ────────
    let (_, listing) = call(&app, "GET", "/api/secrets", None).await;
    let rows: Vec<(String,)> = sqlx::query_as("SELECT COALESCE(content, '') || COALESCE(extra, '') FROM session_messages").fetch_all(&pool).await.unwrap();
    let qrows: Vec<(String, Option<String>)> = sqlx::query_as("SELECT payload, answers FROM pending_questions").fetch_all(&pool).await.unwrap();
    let mut events = String::new();
    while let Ok(Some(frame)) = tokio::time::timeout(std::time::Duration::from_millis(300), sub.next()).await {
        events.push_str(&format!("{} {}\n", frame.event, frame.data));
    }
    assert!(events.contains("question_asked") && events.contains("question_answered"), "{events}");
    let logged = log.text();
    assert!(logged.contains("agent_secret_saved name=STRIPE_SECRET_KEY"), "the log names what was saved");
    for v in VALUES {
        assert!(!listing.to_string().contains(v), "{v} in GET");
        assert!(!format!("{rows:?}{qrows:?}").contains(v), "{v} in the database");
        assert!(!events.contains(v), "{v} in the event stream");
        assert!(!logged.contains(v), "{v} in the server log");
    }

    // ── delete ──────────────────────────────────────────────────────────
    assert_eq!(call(&app, "DELETE", &format!("/api/secrets/STRIPE_SECRET_KEY/{a_id}"), None).await.0, StatusCode::OK);
    assert!(appv3_core::agent_secrets::resolve(&appv3_core::credentials::snapshot(), "STRIPE_SECRET_KEY", &a).is_none());
    assert_eq!(call(&app, "DELETE", &format!("/api/secrets/STRIPE_SECRET_KEY/{a_id}"), None).await.0, StatusCode::NOT_FOUND);

    // ── a file broken by hand: every route that reads it gives the same ──
    // ── answer, which says where it is broken and repeats none of it ─────
    let path = appv3_core::credentials::path();
    let mut text = std::fs::read_to_string(&path).unwrap();
    text.push_str("secrets:\n  HAND_EDIT: \"sk_hand_edit_unclosed_7\n");
    std::fs::write(&path, &text).unwrap();
    let detail = json!(format!("credentials.yaml is not valid: YAML syntax error at line {}, column 14", text.lines().count()));
    for (method, uri, body) in [
        ("GET", "/api/secrets", None),
        ("PUT", "/api/secrets/GITHUB_TOKEN", Some(json!({"value": "ghp_another_value_456", "projects": [a.clone()]}))),
        ("DELETE", "/api/secrets/GITHUB_TOKEN/any", None),
        ("GET", "/api/settings/providers/openai/credentials", None),
    ] {
        let (st, v) = call(&app, method, uri, body).await;
        assert_eq!((st, &v["detail"]), (StatusCode::UNPROCESSABLE_ENTITY, &detail), "{method} {uri}: {v}");
    }
    assert!(!log.text().contains("sk_hand_edit_unclosed_7"), "the broken line's value in the server log");
}
