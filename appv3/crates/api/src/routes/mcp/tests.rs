use super::*;
use appv3_kernel::{Module, Registrar};
use appv3_mcp::PluginServers;
use axum::body::Body as HttpBody;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;

/// A plugin's module as far as the kernel sees it: it contributes its
/// servers when it starts (the sync is called by the test, as the real
/// module's hooks do).
struct PluginModule {
    id: String,
    plugin: String,
    servers: Vec<(String, ServerConfig)>,
}

impl Module for PluginModule {
    fn id(&self) -> &str {
        &self.id
    }
    fn register(&self, r: &mut Registrar) -> anyhow::Result<()> {
        r.add(PluginServers { plugin: self.plugin.clone(), servers: self.servers.clone() });
        Ok(())
    }
}

/// A server that is disabled, so it never starts a process.
fn plugin_server() -> ServerConfig {
    let mut env = IndexMap::new();
    env.insert("TOKEN".to_string(), "s3cret".to_string());
    ServerConfig::Stdio { command: "npx".into(), args: vec!["-y".into(), "srv".into()], env, enabled: false, timeout: None, cwd: Some("/plugins/routes-mcp".into()) }
}

fn status(plugin: Option<&str>) -> ServerStatus {
    ServerStatus {
        name: "n".into(),
        transport: "stdio".into(),
        enabled: true,
        state: "ready".into(),
        error: None,
        tool_names: vec!["n_t".into()],
        started_at: None,
        plugin: plugin.map(String::from),
        project: None,
    }
}

async fn send(app: &Router, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    let mut req = Request::builder().method(method).uri(uri);
    let body = match body {
        Some(v) => {
            req = req.header("content-type", "application/json");
            HttpBody::from(v.to_string())
        }
        None => HttpBody::empty(),
    };
    let resp = app.clone().oneshot(req.body(body).unwrap()).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

/// The user's servers read as they always did; a plugin's adds `plugin`.
#[test]
fn only_a_plugins_server_carries_a_plugin_label() {
    let cfg = ServerConfig::Stdio { command: "x".into(), args: vec![], env: IndexMap::new(), enabled: true, timeout: None, cwd: None };
    let user = status_json(&status(None), Some(&cfg));
    assert!(user.get("plugin").is_none());
    assert_eq!(
        user.to_string(),
        r#"{"name":"n","transport":"stdio","enabled":true,"state":"ready","error":null,"tool_names":["n_t"],"started_at":null,"config":{"transport":"stdio","command":"x","args":[],"env":{},"enabled":true},"signed_in":false,"gallery":null}"#
    );
    let plugin = status_json(&status(Some("p")), Some(&cfg));
    assert_eq!(plugin["plugin"], "p");
    assert_eq!(plugin.to_string(), format!(r#"{},"plugin":"p"}}"#, user.to_string().strip_suffix('}').unwrap()), "the label is the only difference");
}

/// A connector at a gallery entry's address carries that entry's id, name
/// and logo; one at any other address carries none.
#[test]
fn a_gallery_connector_carries_its_name_and_logo() {
    let http = |url: &str| ServerConfig::Http {
        url: url.into(),
        kind: HttpKind::Auto,
        headers: IndexMap::new(),
        enabled: true,
        timeout: None,
        oauth: None,
    };
    let notion = status_json(&status(None), Some(&http("https://MCP.notion.com/mcp/")));
    assert_eq!(notion["gallery"]["id"], "notion");
    assert_eq!(notion["gallery"]["name"], "Notion");
    assert!(notion["gallery"]["icon"]["path"].as_str().is_some_and(|p| p.starts_with('M')));
    assert!(status_json(&status(None), Some(&http("https://example.com/mcp")))["gallery"].is_null());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn plugin_servers_are_listed_read_only_and_reached_by_their_encoded_full_name() {
    let kernel = appv3_kernel::global();
    let module = "plugin:routes-mcp";
    kernel.add(PluginModule { id: module.into(), plugin: "routes-mcp".into(), servers: vec![("github".into(), plugin_server())] }).unwrap();
    kernel.start(module).await.unwrap();
    mcp_manager().sync_plugin_servers().await;

    let dir = tempfile::tempdir().unwrap();
    let pool = appv3_db::create_pool(dir.path().join("oad.db")).await.unwrap();
    let app = crate::routes::router().with_state(AppState { pool });
    // `encodeURIComponent("routes-mcp/github")`: the `/` stays inside one path segment.
    let uri = "/api/mcp/servers/routes-mcp%2Fgithub";

    let (st, v) = send(&app, "GET", uri, None).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(
        (v["name"].as_str(), v["plugin"].as_str(), v["transport"].as_str(), v["state"].as_str()),
        (Some("routes-mcp/github"), Some("routes-mcp"), Some("stdio"), Some("stopped")),
        "{v}"
    );
    assert_eq!((v["config"]["command"].as_str(), v["config"]["cwd"].as_str()), (Some("npx"), Some("/plugins/routes-mcp")));
    assert_eq!(v["config"]["env"], json!({"TOKEN": "********"}));
    assert!(!v.to_string().contains("s3cret"), "{v}");

    // Read-only: neither a change nor a delete, and nothing happens to the server.
    let detail = "routes-mcp/github comes from plugin routes-mcp; manage it in Settings → Plugins";
    let put = json!({"server": {"transport": "stdio", "command": "x", "args": [], "env": {}, "enabled": true}});
    assert_eq!(send(&app, "PUT", uri, Some(put)).await, (StatusCode::CONFLICT, json!({"detail": detail})));
    assert_eq!(send(&app, "DELETE", uri, None).await, (StatusCode::CONFLICT, json!({"detail": detail})));
    assert_eq!(mcp_manager().get_status("routes-mcp/github").unwrap().plugin.as_deref(), Some("routes-mcp"));

    // A restart is allowed.
    let (st, v) = send(&app, "POST", &format!("{uri}/restart"), None).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!((v["name"].as_str(), v["plugin"].as_str()), (Some("routes-mcp/github"), Some("routes-mcp")), "{v}");

    // Signing in resolves the name too (a stdio server does not sign in).
    let (st, v) = send(&app, "POST", &format!("{uri}/oauth/connect"), None).await;
    assert_eq!(
        (st, v),
        (
            StatusCode::BAD_REQUEST,
            json!({"detail": "MCP server 'routes-mcp/github' does not sign in with OAuth: it is a stdio server, or its Authorization header sets its credentials."})
        )
    );

    // The list carries it with its label.
    let list = list_json(&cfgmod::McpConfig::default());
    let listed = list["servers"].as_array().unwrap().iter().find(|s| s["name"] == "routes-mcp/github").expect("listed");
    assert_eq!(listed["plugin"], "routes-mcp");

    // Another server of the same plugin is not there.
    let (st, v) = send(&app, "GET", "/api/mcp/servers/routes-mcp%2Fnope", None).await;
    assert_eq!((st, v), (StatusCode::NOT_FOUND, json!({"detail": "MCP server 'routes-mcp/nope' not found."})));

    // The plugin stops (the kernel drops its contribution, the hook syncs): the server is gone.
    kernel.stop(module).await;
    mcp_manager().sync_plugin_servers().await;
    let (st, _) = send(&app, "GET", uri, None).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    assert!(list_json(&cfgmod::McpConfig::default())["servers"].as_array().unwrap().iter().all(|s| s["name"] != "routes-mcp/github"));
    kernel.remove(module).await;
}

/// A project's servers are listed with `?workspace=` only, approved and
/// revoked by key, and the project's file, not the API, changes them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn project_servers_are_listed_per_workspace_and_approved_by_key() {
    let dir = tempfile::tempdir().unwrap();
    mcp_manager().use_approvals(appv3_mcp::project::Approvals::at(dir.path().join("approvals.json")));
    let ws = dir.path().join("repo");
    std::fs::create_dir_all(ws.join(".agents")).unwrap();
    // Disabled, so approving it starts no process.
    let file = json!({"mcpServers": {"docs": {"command": "npx", "args": ["docs-mcp"], "env": {"KEY": "${DOCS_KEY}", "RAW": "s3cret"}, "enabled": false}}});
    std::fs::write(ws.join(".agents").join("mcp.json"), file.to_string()).unwrap();
    let ws_s = ws.display().to_string();
    let key = appv3_mcp::project::runner_key(&ws_s, "docs");
    let pool = appv3_db::create_pool(dir.path().join("oad.db")).await.unwrap();
    let app = crate::routes::router().with_state(AppState { pool });
    let q = |s: &str| s.replace('/', "%2F").replace('@', "%40");
    let list_uri = format!("/api/mcp/servers?workspace={}", q(&ws_s));

    let (st, v) = send(&app, "GET", &list_uri, None).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let docs = v["servers"].as_array().unwrap().iter().find(|s| s["name"] == key).cloned().expect("listed in its workspace");
    assert_eq!(docs["project"], json!({"workspace": ws_s, "name": "docs"}));
    assert_eq!(docs["state"], "needs_approval");
    assert_eq!(docs["config"]["env"], json!({"KEY": "${DOCS_KEY}", "RAW": "********"}));
    assert_eq!(docs["config"]["cwd"].as_str(), Some(ws_s.as_str()));
    assert!(!v.to_string().contains("s3cret"), "{v}");
    let (_, all) = send(&app, "GET", "/api/mcp/servers", None).await;
    assert!(all["servers"].as_array().unwrap().iter().all(|s| s["name"] != key), "not in the global list: {all}");

    let uri = format!("/api/mcp/servers/{}", q(&key));
    let put = json!({"server": {"transport": "stdio", "command": "x", "args": [], "env": {}, "enabled": true}});
    let (st, v) = send(&app, "PUT", &uri, Some(put)).await;
    assert!(st == StatusCode::CONFLICT && v["detail"].as_str().unwrap().contains(".agents"), "{st} {v}");
    assert_eq!(send(&app, "DELETE", &uri, None).await.0, StatusCode::CONFLICT);
    let (st, v) = send(&app, "POST", &format!("{uri}/restart"), None).await;
    assert!(st == StatusCode::CONFLICT && v["detail"].as_str().unwrap().contains("needs the user's approval"), "{st} {v}");

    let (st, v) = send(&app, "POST", &format!("{uri}/approve"), None).await;
    assert_eq!((st, v["state"].as_str(), v["enabled"].as_bool()), (StatusCode::OK, Some("stopped"), Some(false)), "{v}");
    assert!(std::fs::read_to_string(dir.path().join("approvals.json")).unwrap().contains("docs"));
    let (st, v) = send(&app, "POST", &format!("{uri}/revoke"), None).await;
    assert_eq!((st, v["state"].as_str()), (StatusCode::OK, Some("needs_approval")), "{v}");
    assert_eq!(send(&app, "POST", "/api/mcp/servers/docs/approve", None).await.0, StatusCode::NOT_FOUND, "a user's name is not a project's server");

    std::fs::write(ws.join(".agents").join("mcp.json"), "{ broken").unwrap();
    let (_, v) = send(&app, "GET", &list_uri, None).await;
    assert!(v["project_error"].as_str().unwrap().contains("Invalid JSON"), "{v}");
    assert!(v["servers"].as_array().unwrap().iter().all(|s| s["name"] != key), "a broken file runs nothing: {v}");
}
