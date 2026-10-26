//! Connecting the first provider gives agents that have no model yet the
//! provider's suggested one, so a saved key alone is enough to chat. Models
//! the user chose are never replaced.
//!
//! Settings and the plugin registry are process-global, so this file is its
//! own test binary with one test and a fixture plugin written to a temp dir.

use appv3_api::{create_app, AppState, ConnInfo, Policy};
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::time::Duration;
use tower::ServiceExt;

// A key provider that lists two models once a key is stored.
const KEYONLY: &str = r#"
export const provider = {
  id: "keyonly", label: "Key only", description: "key", kind: "api_key",
  credentials: [{ name: "KEYONLY_KEY", label: "Key", secret: true, required: true }],
  build() { throw new Error("fixture does not build"); },
  isConfigured(c) { return !!c.get("KEYONLY_KEY"); },
  discoverModels(c) { return c.get("KEYONLY_KEY") ? ["model-a", "model-b"] : []; },
};
"#;

// Fixture values, not real keys.
const FIRST_KEY: &str = concat!("fixture", "-one");
const SECOND_KEY: &str = concat!("fixture", "-two");

struct Client {
    app: Router,
}

impl Client {
    async fn json(&self, method: &str, uri: &str, body: Value) -> (StatusCode, Value) {
        let mut req = Request::builder().method(method).uri(uri).header("content-type", "application/json").body(Body::from(body.to_string())).unwrap();
        let local: SocketAddr = "127.0.0.1:8000".parse().unwrap();
        req.extensions_mut().insert(ConnectInfo(ConnInfo { local: Some(local), remote: Some("127.0.0.1:50000".parse().unwrap()) }));
        let resp = self.app.clone().oneshot(req).await.unwrap();
        let (parts, body) = resp.into_parts();
        let bytes = tokio::time::timeout(Duration::from_secs(20), body.collect()).await.expect("response body ended").unwrap().to_bytes();
        (parts.status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }
}

fn agent(name: &str, role: &str, model: &str) -> String {
    format!("---\nname: {name}\nrole: {role}\ndescription: {name} agent\nmodel: {model}\n---\nYou are {name}.\n")
}

fn model_of(path: &std::path::Path) -> String {
    let text = std::fs::read_to_string(path).unwrap();
    text.lines().find_map(|l| l.strip_prefix("model: ")).unwrap_or_default().to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn saving_the_first_key_sets_the_suggested_model_on_unconfigured_agents() {
    let root = tempfile::tempdir().unwrap();
    let r = root.path();
    for (k, d) in [
        ("OPENAGENTD_DATA_DIR", "data"),
        ("OPENAGENTD_CONFIG_DIR", "config"),
        ("OPENAGENTD_STATE_DIR", "state"),
        ("OPENAGENTD_CACHE_DIR", "cache"),
        ("OPENAGENTD_WORKSPACE_DIR", "ws"),
    ] {
        std::env::set_var(k, r.join(d));
    }
    std::env::set_var("HOME", r.join("home"));
    std::env::set_var("OPENAGENTD_ENV", "production");
    std::env::set_var("OPENAGENTD_MODEL_REGISTRY_REFRESH", "false");
    std::env::set_var("OPENAGENTD_PLUGINS_DIRS", r.join("plugins"));
    for k in ["OPENAGENTD_DESKTOP_TOKEN", "OPENAGENTD_ACCESS_KEY", "DATABASE_URL", "OPENAGENTD_DATABASE_URL", "AGENTS_DIR", "KEYONLY_KEY"] {
        std::env::remove_var(k);
    }
    std::fs::create_dir_all(r.join("plugins")).unwrap();
    std::fs::write(r.join("plugins").join("keyonly.js"), KEYONLY).unwrap();
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
    let s = appv3_core::settings();
    std::fs::create_dir_all(s.database_path.parent().unwrap()).unwrap();
    std::fs::create_dir_all(&s.agents_dir).unwrap();
    let code = s.agents_dir.join("code.md");
    let explorer = s.agents_dir.join("explorer.md");
    let mine = s.agents_dir.join("mine.md");
    std::fs::write(&code, agent("code", "lead", "__PROVIDER_MODEL__")).unwrap();
    std::fs::write(&explorer, agent("explorer", "member", "__PROVIDER_MODEL__")).unwrap();
    std::fs::write(&mine, agent("mine", "member", "openai:gpt-5.5")).unwrap();
    let pool = appv3_db::create_pool(&s.database_path).await.unwrap();
    appv3_db::migrations::run_migrations(&pool).await.unwrap();
    appv3_agent::manager::init(pool.clone(), appv3_agent::loader::default_provider_factory());
    let c = Client { app: create_app(AppState { pool }, Policy::from_env()) };
    let ws = r.join("ws").join("proj");
    std::fs::create_dir_all(&ws).unwrap();
    let registry = format!("/api/agent/agents?workspace={}", form_urlencoded::byte_serialize(ws.display().to_string().as_bytes()).collect::<String>());
    let lead_model = |v: &Value| v["agents"][0]["model"].clone();

    // An idle agent session is already serving the registry.
    let (st, v) = c.json("GET", &registry, Value::Null).await;
    assert_eq!((st, lead_model(&v)), (StatusCode::OK, json!("__PROVIDER_MODEL__")), "{v}");

    // ── the first saved key gives waiting agents a model ─────────────────
    let (st, v) = c.json("PUT", "/api/settings/providers/keyonly", json!({"api_key": FIRST_KEY})).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["default_model"], json!("keyonly:model-a"), "{v}");
    assert_eq!(v["agents_updated"], json!(["code.md", "explorer.md"]), "{v}");
    assert_eq!(model_of(&code), "keyonly:model-a");
    assert_eq!(model_of(&explorer), "keyonly:model-a");
    assert_eq!(model_of(&mine), "openai:gpt-5.5", "a model the user chose is kept");
    // The idle session picks the change up without waiting for a turn.
    let (_, v) = c.json("GET", &registry, Value::Null).await;
    assert_eq!(lead_model(&v), json!("keyonly:model-a"), "{v}");

    // ── once every agent has a model, a later save changes nothing ───────
    let (st, v) = c.json("PUT", "/api/settings/providers/keyonly", json!({"api_key": SECOND_KEY})).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!((v["default_model"].clone(), v["agents_updated"].clone()), (Value::Null, json!([])), "{v}");
    assert_eq!(model_of(&code), "keyonly:model-a");

    // ── "Use" for a detected provider: the server picks the model ────────
    std::fs::write(&code, agent("code", "lead", "__PROVIDER_MODEL__")).unwrap();
    let (st, v) = c.json("POST", "/api/settings/default-model", json!({"provider": "keyonly"})).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!((v["provider_model"].clone(), v["agents_updated"].clone()), (json!("keyonly:model-a"), json!(["code.md"])), "{v}");
    assert_eq!(model_of(&code), "keyonly:model-a");

    // An explicit model still works, and bad bodies are refused.
    let (st, v) = c.json("POST", "/api/settings/default-model", json!({"provider_model": "keyonly:model-b"})).await;
    assert_eq!((st, v["agents_updated"].clone()), (StatusCode::OK, json!([])), "nothing is waiting: {v}");
    let (st, v) = c.json("POST", "/api/settings/default-model", json!({})).await;
    assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY, "{v}");
    let (st, v) = c.json("POST", "/api/settings/default-model", json!({"provider_model": "no-colon"})).await;
    assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY, "{v}");
    let (st, v) = c.json("POST", "/api/settings/default-model", json!({"provider": "nope"})).await;
    assert_eq!(st, StatusCode::NOT_FOUND, "{v}");
}
