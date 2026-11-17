//! Where MCP secrets are kept: `mcp.json` holds `${NAME}` references and the
//! values live in `credentials.yaml`, whichever way a server is saved (an old
//! file at startup, Settings, or the agent's `mcp` tool). The Settings API
//! never returns a stored value, a project's server cannot reach a model
//! provider's key, and the agent's file tools cannot open `mcp.json`.
//!
//! Settings and managers are process-global, so everything runs in one test
//! against temporary folders.

use appv3_api::{create_app, AppState, ConnInfo, Policy};
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
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

fn secrets() -> indexmap::IndexMap<String, String> {
    appv3_core::credentials::load().unwrap().secrets.clone()
}

#[cfg(unix)]
fn mode(p: &std::path::Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).unwrap().permissions().mode() & 0o777
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn mcp_secrets_live_in_the_credential_store() {
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
    for k in ["OPENAGENTD_DESKTOP_TOKEN", "OPENAGENTD_ACCESS_KEY", "DATABASE_URL", "OPENAGENTD_DATABASE_URL", "OPENAI_API_KEY", "GITHUB_TOKEN", "PROJ_NAMED"] {
        std::env::remove_var(k);
    }
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
    let s = appv3_core::settings();
    let mcp_json = s.mcp_config_path();

    // A provider key, and secrets the user named.
    appv3_core::credentials::update(|f| {
        let mut c = appv3_core::credentials::Credential::new("openai");
        c.values.insert("OPENAI_API_KEY".into(), "sk-provider".into());
        f.provider_mut("openai").push(c);
        f.secrets.insert("GITHUB_TOKEN".into(), "gh-mine".into());
        f.secrets.insert("PROJ_NAMED".into(), "named-v".into());
    })
    .unwrap();

    // ── an older mcp.json, readable by everyone, is migrated at startup ──
    std::fs::create_dir_all(mcp_json.parent().unwrap()).unwrap();
    std::fs::write(
        &mcp_json,
        json!({"servers": {"discord": {"command": "discord-mcp", "env": {"DISCORD_TOKEN": "tok-literal", "DISCORD_GUILDS": "123", "REF": "${GITHUB_TOKEN}"}, "enabled": false}}})
            .to_string(),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&mcp_json, std::fs::Permissions::from_mode(0o644)).unwrap();
    }
    std::fs::create_dir_all(s.database_path.parent().unwrap()).unwrap();
    let pool = appv3_db::create_pool(&s.database_path).await.unwrap();
    appv3_db::migrations::run_migrations(&pool).await.unwrap();
    appv3_api::startup::startup(&pool).await.unwrap();
    let app = create_app(AppState { pool: pool.clone() }, Policy::from_env());

    let raw = std::fs::read_to_string(&mcp_json).unwrap();
    assert!(!raw.contains("tok-literal") && !raw.contains("\"123\""), "{raw}");
    assert!(raw.contains("${DISCORD_MCP_ENV_DISCORD_TOKEN}") && raw.contains("${GITHUB_TOKEN}"), "{raw}");
    assert_eq!(secrets()["DISCORD_MCP_ENV_DISCORD_TOKEN"], "tok-literal");
    #[cfg(unix)]
    assert_eq!(mode(&mcp_json), 0o600);

    // ── the Settings API never returns a stored value ────────────────────
    let (st, v) = call(&app, "GET", "/api/mcp/servers/discord", None).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["config"]["env"], json!({"DISCORD_TOKEN": "********", "DISCORD_GUILDS": "********", "REF": "${GITHUB_TOKEN}"}));
    let (_, list) = call(&app, "GET", "/api/mcp/servers", None).await;
    assert!(!list.to_string().contains("tok-literal") && !list.to_string().contains("DISCORD_MCP_ENV"), "{list}");

    // Saving the masks back keeps the stored values.
    let put = |env: Value| json!({"server": {"transport": "stdio", "command": "discord-mcp", "args": [], "env": env, "enabled": false}});
    let (st, v) = call(&app, "PUT", "/api/mcp/servers/discord", Some(put(json!({"DISCORD_TOKEN": "********", "DISCORD_GUILDS": "********", "REF": "${GITHUB_TOKEN}"})))).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!((secrets()["DISCORD_MCP_ENV_DISCORD_TOKEN"].as_str(), secrets()["DISCORD_MCP_ENV_DISCORD_GUILDS"].as_str()), ("tok-literal", "123"));
    assert!(!std::fs::read_to_string(&mcp_json).unwrap().contains("********"));

    // A new value replaces it; a removed key takes its secret with it.
    let (st, v) = call(&app, "PUT", "/api/mcp/servers/discord", Some(put(json!({"DISCORD_TOKEN": "tok-new", "REF": "${GITHUB_TOKEN}"})))).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["config"]["env"]["DISCORD_TOKEN"], "********", "{v}");
    assert_eq!(secrets()["DISCORD_MCP_ENV_DISCORD_TOKEN"], "tok-new");
    assert!(!secrets().contains_key("DISCORD_MCP_ENV_DISCORD_GUILDS"));
    assert!(!std::fs::read_to_string(&mcp_json).unwrap().contains("tok-new"));

    // ── a server added in Settings ───────────────────────────────────────
    let web = json!({"name": "web", "server": {"transport": "http", "url": "https://example.invalid/mcp", "headers": {"Authorization": "Bearer hdr-literal"}, "enabled": false}});
    let (st, v) = call(&app, "POST", "/api/mcp/servers", Some(web)).await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    assert_eq!(v["config"]["headers"]["Authorization"], "********");
    assert!(!std::fs::read_to_string(&mcp_json).unwrap().contains("hdr-literal"));
    assert_eq!(secrets()["WEB_MCP_HEADER_AUTHORIZATION"], "Bearer hdr-literal");

    // ── a server the agent saves with the mcp tool (after the user's yes) ─
    let change = json!({"type": "mcp_save", "name": "agentsrv", "config": {"command": "x", "env": {"API_TOKEN": "agent-literal"}, "enabled": false}, "before": "absent"});
    appv3_mcp::admin::apply(&appv3_mcp::mcp_manager(), &change).await.unwrap();
    assert!(!std::fs::read_to_string(&mcp_json).unwrap().contains("agent-literal"));
    assert_eq!(secrets()["AGENTSRV_MCP_ENV_API_TOKEN"], "agent-literal");

    // ── deleting a server deletes its secrets, never the user's own ──────
    assert_eq!(call(&app, "DELETE", "/api/mcp/servers/discord", None).await, (StatusCode::OK, json!({"name": "discord"})));
    let left = secrets();
    assert!(!left.contains_key("DISCORD_MCP_ENV_DISCORD_TOKEN"), "{:?}", left.keys());
    assert_eq!((left["GITHUB_TOKEN"].as_str(), left["PROJ_NAMED"].as_str()), ("gh-mine", "named-v"));

    // ── a project's server reaches named secrets, not provider keys ──────
    use appv3_mcp::config::resolve_secret_refs_with;
    assert_eq!(resolve_secret_refs_with("${OPENAI_API_KEY}", true), "sk-provider", "the user's own servers as before");
    assert_eq!(resolve_secret_refs_with("${OPENAI_API_KEY}", false), "${OPENAI_API_KEY}");
    assert_eq!(resolve_secret_refs_with("${PROJ_NAMED}", false), "named-v");

    // ── the agent's file and shell tools cannot open mcp.json ────────────
    let ws = root.path().join("ws").join("repo");
    let denied = appv3_tools::denied::DeniedPaths::new(&ws, None);
    let p = mcp_json.display().to_string();
    assert!(denied.validate_read_path(&p).is_err() && denied.validate_path(&p).is_err());
    assert!(denied.check_command(&format!("cat {p}")).is_some());
    assert!(denied.validate_read_path(ws.join(".agents").join("mcp.json").to_str().unwrap()).is_ok(), "a project's own file stays readable");
}
