//! End-to-end HTTP tests: the real `create_app` router (full middleware
//! stack) driven with `tower::ServiceExt::oneshot` against a temp DB, temp
//! XDG roots and a local mock OpenAI-compatible provider.
//!
//! Settings and managers are process-global, so everything runs in one test.

use appv3_api::{create_app, AppState, ConnInfo, Policy};
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode};
use axum::routing::post;
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::Arc;
use tower::ServiceExt;

fn setup_env(root: &std::path::Path, mock: SocketAddr) {
    for (k, d) in [
        ("OPENAGENTD_DATA_DIR", "data"),
        ("OPENAGENTD_CONFIG_DIR", "config"),
        ("OPENAGENTD_STATE_DIR", "state"),
        ("OPENAGENTD_CACHE_DIR", "cache"),
        ("OPENAGENTD_WORKSPACE_DIR", "ws"),
    ] {
        std::env::set_var(k, root.join(d));
    }
    std::env::set_var("HOME", root.join("home"));
    std::env::set_var("APP_ENV", "production");
    std::env::set_var("OPENAGENTD_MODEL_REGISTRY_REFRESH", "false");
    std::env::set_var("SNAPSHOT_MAINTENANCE_ENABLED", "false");
    std::env::set_var("OLLAMA_BASE_URL", format!("http://{mock}/v1"));
    for k in ["OPENAGENTD_DESKTOP_TOKEN", "OPENAGENTD_ACCESS_KEY", "DATABASE_URL"] {
        std::env::remove_var(k);
    }
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
}

/// Streaming chat-completions mock: plain text reply.
async fn mock_openai() -> SocketAddr {
    async fn chat(axum::Json(_req): axum::Json<Value>) -> axum::response::Response {
        let chunk = |delta: Value, finish: Value| {
            format!(
                "data: {}\n\n",
                json!({"id": "c", "object": "chat.completion.chunk", "created": 0, "model": "mock-1",
                       "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]})
            )
        };
        let mut body = chunk(json!({"role": "assistant", "content": "Hello "}), Value::Null);
        body += &chunk(json!({"content": "from mock."}), Value::Null);
        body += &chunk(json!({}), json!("stop"));
        body += &format!(
            "data: {}\n\ndata: [DONE]\n\n",
            json!({"id": "c", "object": "chat.completion.chunk", "created": 0, "model": "mock-1", "choices": [],
                   "usage": {"prompt_tokens": 7, "completion_tokens": 3, "total_tokens": 10}})
        );
        axum::response::Response::builder().header("content-type", "text/event-stream").body(Body::from(body)).unwrap()
    }
    let app = Router::new().route("/v1/chat/completions", post(chat));
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    addr
}

struct Client {
    app: Router,
    /// Address the connection arrived on (uvicorn's `scope["server"]`).
    local: SocketAddr,
}

impl Client {
    fn new(app: Router) -> Self {
        Client { app, local: "127.0.0.1:8000".parse().unwrap() }
    }
    async fn send(&self, mut req: Request<Body>) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
        req.extensions_mut().insert(ConnectInfo(ConnInfo { local: Some(self.local), remote: Some("127.0.0.1:50000".parse().unwrap()) }));
        let resp = self.app.clone().oneshot(req).await.unwrap();
        let (parts, body) = resp.into_parts();
        let bytes = body.collect().await.unwrap().to_bytes().to_vec();
        (parts.status, parts.headers, bytes)
    }
    async fn json(&self, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
        let mut b = Request::builder().method(method).uri(uri);
        let body = match body {
            Some(v) => {
                b = b.header("content-type", "application/json");
                Body::from(v.to_string())
            }
            None => Body::empty(),
        };
        let (s, _, bytes) = self.send(b.body(body).unwrap()).await;
        (s, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }
    async fn form(&self, uri: &str, fields: &[(&str, &str)]) -> (StatusCode, Value) {
        let boundary = "XBOUNDARYX";
        let mut body = String::new();
        for (k, v) in fields {
            body += &format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n");
        }
        body += &format!("--{boundary}--\r\n");
        let req = Request::post(uri).header("content-type", format!("multipart/form-data; boundary={boundary}")).body(Body::from(body)).unwrap();
        let (s, _, bytes) = self.send(req).await;
        (s, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }
}

fn sse_events(raw: &[u8]) -> Vec<(String, Value)> {
    let text = String::from_utf8_lossy(raw);
    let mut out = vec![];
    for block in text.replace("\r\n", "\n").split("\n\n") {
        let mut ev = "message".to_string();
        let mut data = String::new();
        for line in block.lines() {
            if let Some(e) = line.strip_prefix("event:") {
                ev = e.trim().to_string();
            } else if let Some(d) = line.strip_prefix("data:") {
                data += d.trim_start();
            }
        }
        if !data.is_empty() {
            out.push((ev, serde_json::from_str(&data).unwrap_or(Value::String(data))));
        }
    }
    out
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn http_api_end_to_end() {
    let root = tempfile::tempdir().unwrap();
    let mock = mock_openai().await;
    setup_env(root.path(), mock);
    let s = appv3_core::settings();
    std::fs::create_dir_all(s.database_path.parent().unwrap()).unwrap();
    let pool = appv3_db::create_pool(&s.database_path).await.unwrap();
    appv3_db::migrations::run_migrations(&pool).await.unwrap();
    appv3_api::startup::startup(&pool).await.unwrap();
    let c = Client::new(create_app(AppState { pool: pool.clone() }, Policy::from_env()));

    // ── health + security headers ────────────────────────────────────────
    let (st, h, body) = c.send(Request::get("/api/health/live").body(Body::empty()).unwrap()).await;
    assert_eq!(st, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    assert_eq!(h.get("x-content-type-options").unwrap(), "nosniff");
    assert!(h.get("content-security-policy").unwrap().to_str().unwrap().contains("frame-src 'self' http://127.0.0.1:*"));
    assert!(h.get("access-control-allow-origin").is_none(), "no CORS headers without Origin");
    let (st, _) = c.json("GET", "/api/health/ready", None).await;
    assert_eq!(st, StatusCode::OK);
    let live: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(live["capabilities"].as_array().unwrap().iter().any(|c| c == "api.plugins"), "{live}");
    let (st, plugins) = c.json("GET", "/api/plugins", None).await;
    assert_eq!(st, StatusCode::OK);
    assert!(plugins["plugins"].is_array() && plugins["unported"].is_array(), "{plugins}");

    // ── first-run workspace: builtin agents ──────────────────────────────
    let (st, v) = c.json("GET", "/api/agents", None).await;
    assert_eq!(st, StatusCode::OK);
    let names: Vec<&str> = v["agents"].as_array().unwrap().iter().map(|a| a["name"].as_str().unwrap()).collect();
    for n in ["code", "explorer", "researcher"] {
        assert!(names.contains(&n), "{names:?}");
    }

    // ── validation envelopes (pydantic shape) ────────────────────────────
    let (st, v) = c.json("PUT", "/api/settings/denied-paths", Some(json!({"x": 1}))).await;
    assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(v["detail"].is_array() || v["detail"].is_string(), "{v}");
    let (st, v) = c.json("POST", "/api/mcp/servers", Some(json!({"name": "1bad", "server": {"transport": "stdio", "command": "x"}}))).await;
    assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY, "{v}");
    let (st, v) = c.json("GET", "/api/nope", None).await;
    assert_eq!((st, v), (StatusCode::NOT_FOUND, json!({"detail": "Not Found"})));

    // ── skills CRUD ──────────────────────────────────────────────────────
    let (st, v) = c.json("POST", "/api/skills", Some(json!({"name": "my-skill", "content": "---\nname: my-skill\ndescription: d\n---\nbody\n"}))).await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    let (st, _) = c.json("GET", "/api/skills/my-skill", None).await;
    assert_eq!(st, StatusCode::OK);
    let (st, _) = c.json("DELETE", "/api/skills/my-skill", None).await;
    assert_eq!(st, StatusCode::OK);

    // ── chat turn through the mock provider ──────────────────────────────
    let (st, _) = c.json("POST", "/api/settings/default-model", Some(json!({"provider_model": "ollama:mock-1"}))).await;
    assert_eq!(st, StatusCode::OK);
    let (st, _) = c.json("PUT", "/api/settings/title-generation", Some(json!({"enabled": false, "model": "ollama:mock-1", "wait_timeout_seconds": 0}))).await;
    assert_eq!(st, StatusCode::OK);

    // ── workspace messages switch (v3 only) ──────────────────────────────
    let (st, v) = c.json("GET", "/api/settings/workspace-messages", None).await;
    assert_eq!((st, v), (StatusCode::OK, json!({"enabled": true})));
    let (st, v) = c.json("PUT", "/api/settings/workspace-messages", Some(json!({}))).await;
    assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY, "{v}");
    let (st, v) = c.json("PUT", "/api/settings/workspace-messages", Some(json!({"enabled": false}))).await;
    assert_eq!((st, v), (StatusCode::OK, json!({"enabled": false})));
    let (_, v) = c.json("GET", "/api/settings/workspace-messages", None).await;
    assert_eq!(v, json!({"enabled": false}));
    let (st, _) = c.json("PUT", "/api/settings/workspace-messages", Some(json!({"enabled": true}))).await;
    assert_eq!(st, StatusCode::OK);
    let ws = root.path().join("proj");
    std::fs::create_dir_all(&ws).unwrap();
    std::fs::write(ws.join("a.txt"), "x").unwrap();
    let wss = ws.display().to_string();
    let (st, v) = c.form("/api/agent/chat", &[("message", "  ")]).await;
    assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY, "{v}");
    let (st, v) = c.form("/api/agent/chat", &[("message", "hi"), ("workspace", &wss)]).await;
    assert_eq!(st, StatusCode::ACCEPTED, "{v}");
    assert_eq!(v["status"], "accepted");
    let sid = v["session_id"].as_str().unwrap().to_string();

    // ── session plan (v3 only) ───────────────────────────────────────────
    let plan_uri = format!("/api/agent/sessions/{sid}/plan");
    let (st, v) = c.json("GET", &plan_uri, None).await;
    assert_eq!((st, v), (StatusCode::OK, json!({"plan": null})));
    let plan_dir = root.path().join("data").join("sessions").join(&sid);
    std::fs::create_dir_all(&plan_dir).unwrap();
    std::fs::write(plan_dir.join("plan.md"), "## Summary\nShip it.\n").unwrap();
    let (st, v) = c.json("GET", &plan_uri, None).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(v["plan"]["content"], "## Summary\nShip it.");
    assert!(v["plan"]["updated_at"].is_string(), "{v}");
    // A data-dir plan from before v3.1.0 reads as revision 1, outside the workspace.
    assert_eq!((v["plan"]["revision"].clone(), v["plan"]["workspace_path"].clone()), (json!(1), Value::Null), "{v}");
    let (st, v) = c.json("DELETE", &plan_uri, None).await;
    assert_eq!((st, v), (StatusCode::OK, json!({"deleted": true})));
    assert!(!plan_dir.join("plan.md").exists());
    let (st, v) = c.json("DELETE", &plan_uri, None).await;
    assert_eq!((st, v), (StatusCode::OK, json!({"deleted": false})));
    let (st, _) = c.json("GET", "/api/agent/sessions/not-a-uuid/plan", None).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);

    let req = Request::get(format!("/api/agent/{sid}/stream")).body(Body::empty()).unwrap();
    let (st, h, raw) = tokio::time::timeout(std::time::Duration::from_secs(20), c.send(req)).await.expect("stream ends");
    assert_eq!(st, StatusCode::OK);
    assert!(h.get("content-type").unwrap().to_str().unwrap().starts_with("text/event-stream"));
    let events = sse_events(&raw);
    let names: Vec<&str> = events.iter().map(|(e, _)| e.as_str()).collect();
    assert_eq!(names.last(), Some(&"done"), "{names:?}");
    let text: String = events.iter().filter(|(e, _)| e == "message").filter_map(|(_, d)| d["text"].as_str()).collect();
    assert_eq!(text, "Hello from mock.", "{events:?}");

    let mut history = Value::Null;
    for _ in 0..50 {
        let (st, v) = c.json("GET", &format!("/api/agent/{sid}/history"), None).await;
        assert_eq!(st, StatusCode::OK);
        if v["lead"]["messages"].as_array().map(|m| m.len() >= 2).unwrap_or(false) {
            history = v;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let msgs = history["lead"]["messages"].as_array().expect("history persisted");
    assert_eq!(msgs[0]["role"], "user");
    assert_eq!(msgs[0]["content"], "hi");
    assert!(msgs[0]["extra"]["snapshot"].as_str().map(|s| s.len() == 40).unwrap_or(false), "git snapshot recorded: {}", msgs[0]);
    assert_eq!(msgs[1]["role"], "assistant");
    assert_eq!(msgs[1]["content"], "Hello from mock.");
    assert_eq!(msgs[1]["extra"]["usage"], json!({"input": 7, "output": 3}));

    // undo restores the workspace snapshot and reports changed paths
    std::fs::write(ws.join("b.txt"), "later").unwrap();
    let (st, v) = c.json("POST", "/api/agent/commands", Some(json!({"command": "undo", "session_id": sid}))).await;
    assert_eq!(st, StatusCode::ACCEPTED, "{v}");
    assert_eq!(v["changed_paths"]["removed"], json!(["b.txt"]));
    assert!(!ws.join("b.txt").exists());
    let (st, v) = c.json("POST", "/api/agent/commands", Some(json!({"command": "redo-all", "session_id": sid}))).await;
    assert_eq!(st, StatusCode::ACCEPTED, "{v}");
    assert!(ws.join("b.txt").exists());

    let (st, v) = c.json("GET", "/api/agent/sessions?limit=5", None).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(v["data"][0]["id"].as_str().or(v["sessions"][0]["id"].as_str()), Some(sid.as_str()), "{v}");

    // `active=true` (v3 addition) lists only sessions running or waiting on the user
    let (st, v) = c.json("GET", "/api/agent/sessions?active=true", None).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(v, json!({"data": [], "next_cursor": null, "has_more": false}));
    appv3_db::create_pending_question(&pool, &sid, "call-active", &[json!({"question": "Which?", "options": []})]).await.unwrap();
    let (st, v) = c.json("GET", "/api/agent/sessions?active=true&limit=1", None).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(v["data"].as_array().map(Vec::len), Some(1), "{v}");
    assert_eq!(v["data"][0]["id"], json!(sid));
    assert_eq!(v["data"][0]["needs_input"], json!(true));
    assert_eq!(v["has_more"], json!(false));

    // `q` (v3 addition) matches titles case-insensitively; LIKE wildcards are literal
    let (st, v) = c.json("GET", "/api/agent/sessions?q=HI", None).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(v["data"][0]["id"], json!(sid), "{v}");
    for miss in ["zzz", "%25", "h_"] {
        let (_, v) = c.json("GET", &format!("/api/agent/sessions?q={miss}"), None).await;
        assert_eq!(v["data"], json!([]), "q={miss}: {v}");
    }

    // `workspaces` (v3 addition, repeatable) keeps sessions in any listed
    // path: one sidebar list across a repository and its worktrees.
    let tree = "/elsewhere/tree-a";
    let other = appv3_db::create_session(&pool, appv3_db::NewSession { workspace: tree.into(), ..Default::default() }).await.unwrap();
    let other_id = appv3_db::codec::api_uuid(&other.id);
    // The stored path is canonical (`/private/var/…` on macOS), not `wss`.
    let (_, detail) = c.json("GET", &format!("/api/agent/sessions/{sid}"), None).await;
    let sid_ws = detail["workspace"].as_str().expect("session workspace").to_string();
    let enc = |p: &str| form_urlencoded::byte_serialize(p.as_bytes()).collect::<String>();
    let ids = |v: &Value| v["data"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    let (st, v) = c.json("GET", &format!("/api/agent/sessions?workspaces={}&workspaces={}", enc(&sid_ws), enc(tree)), None).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(ids(&v), vec![other_id.clone(), sid.clone()], "newest first across both paths: {v}");
    let (_, v) = c.json("GET", &format!("/api/agent/sessions?workspaces={}", enc(tree)), None).await;
    assert_eq!(ids(&v), vec![other_id.clone()], "{v}");
    let (_, v) = c.json("GET", &format!("/api/agent/sessions?workspaces={}&limit=1", enc(&sid_ws)), None).await;
    assert_eq!((ids(&v), v["has_more"].clone()), (vec![sid.clone()], json!(false)), "{v}");
    let (_, v) = c.json("GET", "/api/agent/sessions?workspaces=%2Fnowhere", None).await;
    assert_eq!(v["data"], json!([]), "{v}");
    // ...and narrows the active list the same way.
    let (_, v) = c.json("GET", &format!("/api/agent/sessions?active=true&workspaces={}&workspaces={}", enc(tree), enc(&sid_ws)), None).await;
    assert_eq!(ids(&v), vec![sid.clone()], "{v}");
    let (_, v) = c.json("GET", &format!("/api/agent/sessions?active=true&workspaces={}", enc(tree)), None).await;
    assert_eq!(v["data"], json!([]), "{v}");
    let (st, _) = c.json("DELETE", &format!("/api/agent/sessions/{other_id}"), None).await;
    assert_eq!(st, StatusCode::NO_CONTENT);

    history_paging_flow(&c, &pool, &ws).await;
    plan_review_flow(&c, &pool, &ws).await;

    let (st, _) = c.json("DELETE", &format!("/api/agent/sessions/{sid}"), None).await;
    assert_eq!(st, StatusCode::NO_CONTENT);
    assert!(!appv3_agent::snapshot::snapshot_dir(&sid).exists());
    let (st, _) = c.json("GET", &format!("/api/agent/sessions/{sid}"), None).await;
    assert_eq!(st, StatusCode::NOT_FOUND);

    // ── desktop token middleware ─────────────────────────────────────────
    let authed = Client::new(create_app(AppState { pool: pool.clone() }, Policy { token: Arc::new("tok".into()), ..Policy::from_env() }));
    let (st, v) = authed.json("GET", "/api/agents", None).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    assert_eq!(v, json!({"detail": "Unauthorized — OpenAgentd access key required."}));
    let (st, _) = authed.json("GET", "/api/health/live", None).await;
    assert_eq!(st, StatusCode::OK);
    let (st, _) = authed.json("GET", "/api/agents?_token=tok", None).await;
    assert_eq!(st, StatusCode::OK);
    let (st, _, _) = authed.send(Request::get("/api/agents").header("authorization", "Bearer tok").body(Body::empty()).unwrap()).await;
    assert_eq!(st, StatusCode::OK);

    // ── CORS preflight (Starlette semantics) with an access key ──────────
    let (st, h, body) = authed
        .send(Request::builder().method("OPTIONS").uri("/api/agents").header("origin", "http://x").header("access-control-request-method", "GET").body(Body::empty()).unwrap())
        .await;
    assert_eq!((st, body.as_slice()), (StatusCode::OK, b"OK".as_slice()));
    assert_eq!(h.get("access-control-allow-origin").unwrap(), "http://x");
    assert_eq!(h.get("access-control-allow-methods").unwrap(), "DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT");

    // ── cross-origin guard without an access key ─────────────────────────
    // Without a key the loopback API trusts its callers, so a web page on
    // another origin must not be able to drive it (terminal tickets, chat).
    let preflight = |origin: &str| {
        Request::builder()
            .method("OPTIONS")
            .uri("/api/terminal/ticket")
            .header("origin", origin)
            .header("access-control-request-method", "POST")
            .header("access-control-request-headers", "content-type")
            .body(Body::empty())
            .unwrap()
    };
    let (st, h, _) = c.send(preflight("https://evil.example")).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    assert!(h.get("access-control-allow-origin").is_none());
    for origin in ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:5173", "http://127.0.0.1:5173"] {
        let (st, h, _) = c.send(preflight(origin)).await;
        assert_eq!(st, StatusCode::OK, "{origin}");
        assert_eq!(h.get("access-control-allow-origin").unwrap(), origin);
    }
    // A "simple" request skips the preflight, so the guard must refuse it outright.
    let ticket = |origin: &str| {
        Request::post("/api/terminal/ticket").header("origin", origin).header("content-type", "text/plain").body(Body::from(json!({"workspace": wss}).to_string())).unwrap()
    };
    let (st, _, body) = c.send(ticket("https://evil.example")).await;
    assert_eq!(st, StatusCode::FORBIDDEN, "{}", String::from_utf8_lossy(&body));
    let (st, _, body) = c.send(ticket("http://localhost:5173")).await;
    assert_eq!(st, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    let upgrade = Request::get("/api/terminal/ws?ticket=x")
        .header("origin", "https://evil.example")
        .header("connection", "upgrade")
        .header("upgrade", "websocket")
        .header("sec-websocket-version", "13")
        .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
        .body(Body::empty())
        .unwrap();
    let (st, _, _) = c.send(upgrade).await;
    assert_eq!(st, StatusCode::FORBIDDEN);
    // DNS rebinding: a same-origin GET carries no Origin, only a foreign Host.
    let (st, _, _) = c.send(Request::get("/api/agents").header("host", "attacker.example:8000").body(Body::empty()).unwrap()).await;
    assert_eq!(st, StatusCode::FORBIDDEN);
    for host in ["localhost:8000", "127.0.0.1:8000", "[::1]:8000"] {
        let (st, _, _) = c.send(Request::get("/api/agents").header("host", host).body(Body::empty()).unwrap()).await;
        assert_eq!(st, StatusCode::OK, "{host}");
    }

    // ── LAN server with an access key (mobile app) ───────────────────────
    // The key is the boundary there: any Host/Origin works once it matches.
    let lan =
        Client { app: create_app(AppState { pool: pool.clone() }, Policy { token: Arc::new("tok".into()), ..Policy::from_env() }), local: "192.168.1.100:4082".parse().unwrap() };
    let lan_get = |origin: &str, auth: Option<&str>| {
        let mut b = Request::get("/api/agents").header("host", "192.168.1.100:4082").header("origin", origin);
        if let Some(a) = auth {
            b = b.header("authorization", a);
        }
        b.body(Body::empty()).unwrap()
    };
    for origin in ["tauri://localhost", "http://tauri.localhost"] {
        let (st, h, _) = lan.send(lan_get(origin, Some("Bearer tok"))).await;
        assert_eq!(st, StatusCode::OK, "{origin}");
        assert_eq!(h.get("access-control-allow-origin").unwrap(), origin);
    }
    let (st, _, _) = lan.send(lan_get("https://evil.example", None)).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);

    preview_routes(&c, root.path()).await;

    appv3_api::startup::shutdown().await;
}

async fn preview_routes(c: &Client, root: &std::path::Path) {
    let ws = root.join("preview-ws");
    std::fs::create_dir_all(ws.join("designs")).unwrap();
    std::fs::write(ws.join("designs/landing.html"), "<html><head></head><body>x</body></html>").unwrap();
    let ws = ws.to_string_lossy().to_string();
    let open = |body: Value| c.json("POST", "/api/preview", Some(body));

    let (st, p) = open(json!({"workspace": ws, "path": "designs/landing.html"})).await;
    assert_eq!(st, StatusCode::OK, "{p}");
    assert_eq!(p["kind"], "file");
    assert_eq!(p["path"], "/designs/landing.html");
    let url = p["url"].as_str().unwrap().to_string();
    assert!(url.starts_with("http://127.0.0.1:"), "{url}");
    let page = reqwest::Client::builder().no_proxy().build().unwrap().get(&url).send().await.unwrap().text().await.unwrap();
    assert!(page.contains("/__openagentd/inspector.js"), "{page}");

    let (_, again) = open(json!({"workspace": ws, "path": "designs/landing.html"})).await;
    assert_eq!(again["id"], p["id"], "the same workspace reuses its listener");

    let api_port = appv3_core::settings().api_port;
    for (body, why) in [
        (json!({"workspace": ws, "url": "http://example.com"}), "non-loopback"),
        (json!({"workspace": ws, "url": format!("http://127.0.0.1:{api_port}")}), "the API itself"),
        (json!({"workspace": ws}), "no target"),
        (json!({"workspace": ws, "url": "http://localhost:5173", "path": "designs/landing.html"}), "two targets"),
        (json!({"workspace": ws, "path": "../outside.html"}), "traversal"),
        (json!({"workspace": ws, "path": "missing.html"}), "missing file"),
        (json!({"workspace": "/definitely/not/here", "url": "http://localhost:5173"}), "bad workspace"),
        (json!({"workspace": ws, "url": "http://localhost:5173", "extra": 1}), "unknown field"),
    ] {
        let (st, v) = open(body).await;
        assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY, "{why}: {v}");
    }

    let (st, list) = c.json("GET", &format!("/api/preview?workspace={}", urlencode(&ws)), None).await;
    assert_eq!(st, StatusCode::OK);
    assert!(list["previews"].as_array().unwrap().iter().any(|x| x["id"] == p["id"]), "{list}");

    let id = p["id"].as_str().unwrap();
    let (st, _) = c.json("DELETE", &format!("/api/preview/{id}"), None).await;
    assert_eq!(st, StatusCode::NO_CONTENT);
    let (st, _) = c.json("DELETE", &format!("/api/preview/{id}"), None).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
}

fn urlencode(s: &str) -> String {
    form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

/// Open a plan review as `submit_plan` does: the call, then its pending row.
async fn open_review(pool: &appv3_db::DbPool, sid: &str, call: &str, revision: u64, in_plan_mode: bool) -> String {
    let tool_calls = json!([{"id": call, "type": "function", "function": {"name": "submit_plan", "arguments": "{}"}}]);
    appv3_db::save_message(pool, sid, appv3_db::NewMessage { tool_calls: Some(tool_calls), ..appv3_db::NewMessage::assistant(None) }).await.unwrap();
    let payload = appv3_agent::tools::plan::review_payload(revision, None, in_plan_mode);
    let q = appv3_db::create_pending_question_with(pool, sid, call, "submit_plan", &payload).await.unwrap();
    appv3_db::codec::api_uuid(&q.id)
}

/// History pages for a lead with a member: the newest page carries the
/// members and the session-wide usage totals; older pages carry only older
/// lead rows. Member rows are shown from the newest page only, and a member's
/// `seq` is not comparable to the lead's cursor, so re-sending them on every
/// older page duplicated them.
async fn history_paging_flow(c: &Client, pool: &appv3_db::DbPool, ws: &std::path::Path) {
    let workspace = ws.display().to_string();
    let lead = appv3_db::create_session(pool, appv3_db::NewSession { workspace: workspace.clone(), ..Default::default() }).await.unwrap();
    let member =
        appv3_db::create_session(pool, appv3_db::NewSession { workspace, parent_session_id: Some(lead.id.clone()), agent_name: Some("explorer".into()), ..Default::default() })
            .await
            .unwrap();
    let costed = |text: String, usd: f64| {
        let mut extra = serde_json::Map::new();
        extra.insert("usage".into(), json!({"cost": {"estimated_usd": usd}, "output": 2}));
        appv3_db::NewMessage { extra: Some(extra), ..appv3_db::NewMessage::assistant(Some(text)) }
    };
    for i in 0..150 {
        appv3_db::save_message(pool, &lead.id, costed(format!("lead {i}"), 0.01)).await.unwrap();
    }
    for i in 0..10 {
        appv3_db::save_message(pool, &member.id, costed(format!("member {i}"), 0.5)).await.unwrap();
    }
    let lid = appv3_db::codec::api_uuid(&lead.id);

    let (st, newest) = c.json("GET", &format!("/api/agent/{lid}/history"), None).await;
    assert_eq!(st, StatusCode::OK, "{newest}");
    assert_eq!(newest["lead"]["messages"].as_array().map(Vec::len), Some(100));
    assert_eq!(newest["has_more"], json!(true));
    let members = newest["members"].as_array().expect("members");
    assert_eq!(members.len(), 1, "{newest}");
    assert_eq!(members[0]["messages"].as_array().map(Vec::len), Some(10));
    assert_eq!(newest["lead"]["estimated_cost_usd"], json!(1.5), "lead total covers every page");
    assert_eq!(newest["lead"]["completion_tokens"], json!(300));
    assert_eq!(members[0]["estimated_cost_usd"], json!(5.0));
    assert_eq!(members[0]["completion_tokens"], json!(20));

    let cursor = newest["next_cursor"].as_str().expect("older page cursor");
    let (st, older) = c.json("GET", &format!("/api/agent/{lid}/history?before={}", urlencode(cursor)), None).await;
    assert_eq!(st, StatusCode::OK, "{older}");
    assert_eq!(older["lead"]["messages"].as_array().map(Vec::len), Some(50));
    assert_eq!(older["has_more"], json!(false));
    assert_eq!(older["members"], json!([]), "older pages must not re-send member rows");
    assert!(older["lead"]["estimated_cost_usd"].is_null(), "older pages skip the session-wide totals: {older}");

    // Cursors are `seq[|id]` and uuid7 ids; v2-era timestamp cursors are gone.
    let seq_only = cursor.split('|').next().unwrap();
    let (st, by_seq) = c.json("GET", &format!("/api/agent/{lid}/history?before={seq_only}"), None).await;
    assert_eq!(st, StatusCode::OK, "{by_seq}");
    let newest_id = newest["lead"]["messages"][99]["id"].as_str().unwrap();
    let (st, delta) = c.json("GET", &format!("/api/agent/{lid}/history?since={newest_id}"), None).await;
    assert_eq!(st, StatusCode::OK, "{delta}");
    assert_eq!(delta["lead"]["messages"], json!([]));
    for q in ["before=2026-09-23T06:56:28Z", "since=2026-09-23T06:56:28Z", "before=2026-09-23T06:56:28Z|"] {
        let (st, body) = c.json("GET", &format!("/api/agent/{lid}/history?{}", q.replace(':', "%3A").replace('|', "%7C")), None).await;
        assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY, "{q}: {body}");
    }

    for id in [&member.id, &lead.id] {
        let (st, _) = c.json("DELETE", &format!("/api/agent/sessions/{}", appv3_db::codec::api_uuid(id)), None).await;
        assert!(st == StatusCode::NO_CONTENT || st == StatusCode::NOT_FOUND, "{st}");
    }
}

async fn tool_result(pool: &appv3_db::DbPool, sid: &str, call: &str) -> String {
    let rows = appv3_db::llm_window_rows(pool, sid, true).await.unwrap();
    rows.iter().find(|r| r.tool_call_id.as_deref() == Some(call)).and_then(|r| r.content.clone()).expect("tool result")
}

async fn wait_idle(sid: &str) {
    if let Some(a) = appv3_agent::manager::find_live_session_serving_session(sid) {
        tokio::time::timeout(std::time::Duration::from_secs(20), a.wait_turn_finished()).await.expect("resumed turn ends");
    }
}

/// Plan routes and plan-review answers on a Plan-mode session in `ws`.
async fn plan_review_flow(c: &Client, pool: &appv3_db::DbPool, ws: &std::path::Path) {
    use appv3_agent::plan::{self, PlanChange, PlanTarget};
    let new = appv3_db::NewSession { workspace: ws.display().to_string(), interaction_mode: Some("plan".into()), ..Default::default() };
    let psid = appv3_db::codec::api_uuid(&appv3_db::create_session(pool, new).await.unwrap().id);
    let dir = appv3_tools::denied::session_artifacts_dir(Some(&psid));
    let saved = plan::save_agent(&dir, PlanTarget::Workspace { root: ws, session_id: &psid, denied: None }, PlanChange::Write("# Ship it\n1. Build")).unwrap();
    let plan_uri = format!("/api/agent/sessions/{psid}/plan");
    let (st, v) = c.json("GET", &plan_uri, None).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!((v["plan"]["revision"].clone(), v["plan"]["approved_revision"].clone()), (json!(1), Value::Null), "{v}");
    let rel = v["plan"]["workspace_path"].as_str().unwrap_or_default();
    assert!(rel.starts_with(".openagentd/plans/ship-it-") && rel.ends_with(".md"), "{v}");
    assert_eq!(v["plan"]["path"], json!(saved.doc.path.display().to_string()));

    // ── a review is open ─────────────────────────────────────────────────
    let qid = open_review(pool, &psid, "call-plan-1", 1, true).await;
    let (_, v) = c.json("GET", &format!("/api/agent/{psid}/question"), None).await;
    assert_eq!((v["question"]["kind"].clone(), v["question"]["plan_revision"].clone()), (json!("plan_review"), json!(1)), "{v}");
    let (st, v) = c.json("DELETE", &plan_uri, None).await;
    assert_eq!((st, v), (StatusCode::CONFLICT, json!({"detail": "The plan is awaiting review."})));

    // The user edits the plan in the panel.
    let (st, v) = c.json("PUT", &plan_uri, Some(json!({"content": "# Ship it", "base_revision": 0}))).await;
    assert_eq!((st, v), (StatusCode::CONFLICT, json!({"detail": "The plan changed since you opened it."})));
    let (st, _) = c.json("PUT", &plan_uri, Some(json!({"content": "  ", "base_revision": 1}))).await;
    assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY);
    let (st, v) = c.json("PUT", &plan_uri, Some(json!({"content": "# Ship it\n1. Build\n2. Test", "base_revision": 1}))).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["plan"]["revision"], 2);
    assert_eq!(std::fs::read_to_string(&saved.doc.path).unwrap(), "# Ship it\n1. Build\n2. Test\n");

    let answer_uri = format!("/api/agent/{psid}/question/{qid}/answer");
    for bad in [json!([]), json!([["Approve", "Request changes"]]), json!([["  "]]), json!([["Approve"], ["x"]])] {
        let (st, v) = c.json("POST", &answer_uri, Some(json!({"answers": bad}))).await;
        assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY, "{bad}: {v}");
    }

    // ── approval: Code mode, the edited plan in the result ───────────────
    let (st, v) = c.json("POST", &answer_uri, Some(json!({"answers": [["Approve"]]}))).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(appv3_db::get_session(pool, &psid).await.unwrap().unwrap().interaction_mode, "code");
    let result = tool_result(pool, &psid, "call-plan-1").await;
    assert!(result.starts_with("The user edited the plan during review; this is revision 2"), "{result}");
    assert!(result.contains("<plan>\n# Ship it\n1. Build\n2. Test\n</plan>\n\nThe user approved plan revision 2."), "{result}");
    let (st, _) = c.json("POST", &answer_uri, Some(json!({"answers": [["Approve"]]}))).await;
    assert_eq!(st, StatusCode::CONFLICT);
    wait_idle(&psid).await;
    let (_, v) = c.json("GET", &plan_uri, None).await;
    assert_eq!(v["plan"]["approved_revision"], 2, "{v}");

    // ── a Code-mode approval keeps a mode switch queued during the review ─
    let qid = open_review(pool, &psid, "call-plan-code", 2, false).await;
    let live = appv3_agent::manager::find_live_session_serving_session(&psid).expect("the resumed session is live");
    live.queue_interaction_mode("plan");
    let (st, v) = c.json("POST", &format!("/api/agent/{psid}/question/{qid}/answer"), Some(json!({"answers": [["Approve"]]}))).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let result = tool_result(pool, &psid, "call-plan-code").await;
    assert!(result.starts_with("The user approved plan revision 2. Implement the plan in"), "{result}");
    wait_idle(&psid).await;
    assert_eq!(appv3_db::get_session(pool, &psid).await.unwrap().unwrap().interaction_mode, "plan", "the switch queued during the review applies");

    // ── a change request keeps Plan mode ─────────────────────────────────
    let qid = open_review(pool, &psid, "call-plan-2", 2, true).await;
    let (st, v) = c.json("POST", &format!("/api/agent/{psid}/question/{qid}/answer"), Some(json!({"answers": [["Split step 2."]]}))).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(appv3_db::get_session(pool, &psid).await.unwrap().unwrap().interaction_mode, "plan");
    let result = tool_result(pool, &psid, "call-plan-2").await;
    assert!(result.starts_with("The user requested changes to plan revision 2:\n\nSplit step 2.\n\nYou are still in Plan mode."), "{result}");
    wait_idle(&psid).await;

    // ── clearing detaches; the workspace file stays ──────────────────────
    let (st, v) = c.json("DELETE", &plan_uri, None).await;
    assert_eq!((st, v), (StatusCode::OK, json!({"deleted": true})));
    assert!(saved.doc.path.exists(), "the workspace plan is the user's file");
    let (_, v) = c.json("GET", &plan_uri, None).await;
    assert_eq!(v, json!({"plan": null}));
    let (st, _) = c.json("PUT", &plan_uri, Some(json!({"content": "# New", "base_revision": 2}))).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    let (st, _) = c.json("DELETE", &format!("/api/agent/sessions/{psid}"), None).await;
    assert_eq!(st, StatusCode::NO_CONTENT);
}
