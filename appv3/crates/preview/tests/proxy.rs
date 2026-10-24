//! End-to-end: a real upstream server behind a preview listener.

use appv3_preview::{parse_url_target, static_backend, Backend, Manager, AGENT_PATH, INSPECTOR_PATH};
use axum::extract::ws::{Message, WebSocketUpgrade};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::Redirect;
use axum::routing::get;
use axum::Router;
use futures::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

fn manager() -> &'static Manager {
    Box::leak(Box::default())
}

async fn upstream() -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let app = Router::new()
        .route("/", get(|| async { ([(header::CONTENT_TYPE, "text/html"), (header::X_FRAME_OPTIONS, "DENY")], "<html><head><title>t</title></head><body>hi</body></html>") }))
        .route("/data.json", get(|| async { ([(header::CONTENT_TYPE, "application/json")], "{\"ok\":true}") }))
        .route("/redirect", get(move || async move { Redirect::to(&format!("http://localhost:{port}/login")) }))
        .route(
            "/echo",
            get(|headers: HeaderMap| async move {
                let h = |n: header::HeaderName| headers.get(n).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
                format!("{}|{}|{}", h(header::HOST), h(header::ORIGIN), h(header::ACCEPT_ENCODING))
            }),
        )
        .route(
            "/ws",
            get(|ws: WebSocketUpgrade| async move {
                ws.protocols(["vite-hmr"]).on_upgrade(|mut socket| async move {
                    while let Some(Ok(Message::Text(t))) = socket.recv().await {
                        if socket.send(Message::Text(format!("echo:{}", t.as_str()).into())).await.is_err() {
                            break;
                        }
                    }
                })
            }),
        );
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    port
}

fn http() -> reqwest::Client {
    reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).no_proxy().build().unwrap()
}

#[tokio::test]
async fn proxies_pages_with_the_inspector_and_rewrites_headers() {
    let up = upstream().await;
    let m = manager();
    let (t, _) = parse_url_target(&format!("http://localhost:{up}")).unwrap();
    let p = m.ensure("/w", Backend::Upstream(t), None).await.unwrap();
    let base = format!("http://127.0.0.1:{}", p.port);

    let page = http().get(format!("{base}/")).send().await.unwrap();
    assert_eq!(page.status(), StatusCode::OK);
    assert!(page.headers().get(header::X_FRAME_OPTIONS).is_none());
    let body = page.text().await.unwrap();
    assert!(body.contains(&format!("<head><script src=\"{INSPECTOR_PATH}\"></script><title>")), "{body}");

    let json = http().get(format!("{base}/data.json")).send().await.unwrap().text().await.unwrap();
    assert_eq!(json, "{\"ok\":true}");

    let echo = http().get(format!("{base}/echo")).header(header::ORIGIN, base.clone()).send().await.unwrap().text().await.unwrap();
    assert_eq!(echo, format!("localhost:{up}|http://localhost:{up}|identity"));

    let redirect = http().get(format!("{base}/redirect")).send().await.unwrap();
    assert_eq!(redirect.headers()[header::LOCATION], format!("{base}/login"));

    let script = http().get(format!("{base}{INSPECTOR_PATH}")).send().await.unwrap();
    assert!(script.headers()[header::CONTENT_TYPE].to_str().unwrap().starts_with("text/javascript"));

    let foreign = http().get(format!("{base}/")).header(header::HOST, "evil.example").send().await.unwrap();
    assert_eq!(foreign.status(), StatusCode::FORBIDDEN);
    m.shutdown();
}

#[tokio::test]
async fn relays_websockets_with_the_subprotocol() {
    let up = upstream().await;
    let m = manager();
    let (t, _) = parse_url_target(&format!("http://127.0.0.1:{up}")).unwrap();
    let p = m.ensure("/w", Backend::Upstream(t), None).await.unwrap();
    let mut req = format!("ws://127.0.0.1:{}/ws", p.port).into_client_request().unwrap();
    req.headers_mut().insert(header::SEC_WEBSOCKET_PROTOCOL, "vite-hmr".parse().unwrap());
    let (mut ws, resp) = tokio_tungstenite::connect_async(req).await.unwrap();
    assert_eq!(resp.headers()[header::SEC_WEBSOCKET_PROTOCOL], "vite-hmr");
    ws.send(tokio_tungstenite::tungstenite::Message::text("ping")).await.unwrap();
    let reply = ws.next().await.unwrap().unwrap();
    assert_eq!(reply.into_text().unwrap().as_str(), "echo:ping");
    m.shutdown();
}

#[tokio::test]
async fn shows_a_retry_page_while_the_server_is_down_and_takes_console_batches() {
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let m = manager();
    let (t, _) = parse_url_target(&format!("http://localhost:{closed}")).unwrap();
    let p = m.ensure("/w", Backend::Upstream(t), None).await.unwrap();
    let base = format!("http://127.0.0.1:{}", p.port);
    let page = http().get(format!("{base}/")).header(header::ACCEPT, "text/html").send().await.unwrap();
    assert_eq!(page.status(), StatusCode::BAD_GATEWAY);
    let body = page.text().await.unwrap();
    assert!(body.contains("Nothing is running") && body.contains("upstream-down") && body.contains(INSPECTOR_PATH));
    assert!(body.contains("Or type a workspace file path, like <code>docs/index.html</code>, in the address bar."), "{body}");

    let posted = http().post(format!("{base}/__openagentd/console")).body(r#"{"entries":[{"level":"error","message":"boom","url":"/"}]}"#).send().await.unwrap();
    assert_eq!(posted.status(), StatusCode::NO_CONTENT);
    let entry = m.get(&p.id).unwrap();
    assert_eq!(entry.console()[0].message, "boom");
    assert_eq!(entry.console_error_count(), 1);
    m.shutdown();
}

#[tokio::test]
async fn serves_workspace_files() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("designs")).unwrap();
    std::fs::write(dir.path().join("designs/landing.html"), "<html><head></head><body>x</body></html>").unwrap();
    std::fs::write(dir.path().join(".env"), "SECRET=1").unwrap();
    let m = manager();
    let p = m.ensure("/w", static_backend(dir.path()), None).await.unwrap();
    let base = format!("http://127.0.0.1:{}", p.port);
    let page = http().get(format!("{base}/designs/landing.html")).send().await.unwrap();
    assert_eq!(page.status(), StatusCode::OK);
    assert_eq!(page.headers()[header::CACHE_CONTROL], "no-store");
    assert!(page.text().await.unwrap().contains(INSPECTOR_PATH));
    let env = http().get(format!("{base}/.env")).send().await.unwrap();
    assert_eq!(env.status(), StatusCode::FORBIDDEN);
    let dir_redirect = http().get(format!("{base}/designs")).send().await.unwrap();
    assert_eq!(dir_redirect.status(), StatusCode::FOUND);
    let post = http().post(format!("{base}/designs/landing.html")).send().await.unwrap();
    assert_eq!(post.status(), StatusCode::METHOD_NOT_ALLOWED);
    m.shutdown();
}

#[tokio::test]
async fn relays_agent_commands_through_the_page_long_poll() {
    let dir = tempfile::tempdir().unwrap();
    let m = manager();
    let p = m.ensure("/w", static_backend(dir.path()), None).await.unwrap();
    let base = format!("http://127.0.0.1:{}", p.port);
    let entry = m.get(&p.id).unwrap();

    // The page polls; the agent's command arrives on that poll.
    let poll = tokio::spawn({
        let base = base.clone();
        async move { http().get(format!("{base}{AGENT_PATH}")).send().await.unwrap() }
    });
    while !entry.agent.connected() {
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let run = tokio::spawn({
        let entry = entry.clone();
        async move { entry.agent.run(serde_json::json!({"action": "snapshot"}), std::time::Duration::from_secs(5)).await }
    });
    let cmd: serde_json::Value = poll.await.unwrap().json().await.unwrap();
    assert_eq!(cmd["command"]["action"], "snapshot");
    let id = cmd["id"].as_str().unwrap();

    let posted = http().post(format!("{base}{AGENT_PATH}")).body(format!(r#"{{"id":"{id}","ok":true,"result":{{"text":"page"}}}}"#)).send().await.unwrap();
    assert_eq!(posted.status(), StatusCode::NO_CONTENT);
    assert_eq!(run.await.unwrap().unwrap(), serde_json::json!({"text": "page"}));

    let bad = http().post(format!("{base}{AGENT_PATH}")).body("nope").send().await.unwrap();
    assert_eq!(bad.status(), StatusCode::BAD_REQUEST);
    let big = http().post(format!("{base}{AGENT_PATH}")).body(vec![b' '; 256 * 1024 + 1]).send().await.unwrap();
    assert_eq!(big.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let put = http().put(format!("{base}{AGENT_PATH}")).send().await.unwrap();
    assert_eq!(put.status(), StatusCode::METHOD_NOT_ALLOWED);

    // A pending poll ends promptly when the preview closes.
    let pending = tokio::spawn({
        let base = base.clone();
        async move { http().get(format!("{base}{AGENT_PATH}")).send().await.map(|r| r.status()) }
    });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    m.shutdown();
    let status = tokio::time::timeout(std::time::Duration::from_secs(5), pending).await.expect("poll ended").unwrap();
    assert!(status.map(|s| s == StatusCode::NO_CONTENT).unwrap_or(true));
}

/// A WebSocket endpoint that hands every socket to `tunnel::pipe`, as the
/// API route does after authenticating it.
async fn tunnel_server(entry: std::sync::Arc<appv3_preview::Entry>) -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let app = Router::new().route(
        "/t",
        get(move |ws: WebSocketUpgrade| {
            let entry = entry.clone();
            async move { ws.on_upgrade(move |socket| appv3_preview::tunnel::pipe(entry, socket)) }
        }),
    );
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    port
}

/// Everything the tunnel sends until it closes, as text.
async fn drain<S>(ws: &mut S) -> (String, Option<u16>)
where
    S: futures::Stream<Item = Result<tokio_tungstenite::tungstenite::Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    use tokio_tungstenite::tungstenite::Message as M;
    let mut out = Vec::new();
    let mut code = None;
    while let Ok(Some(Ok(m))) = tokio::time::timeout(std::time::Duration::from_secs(5), ws.next()).await {
        match m {
            M::Binary(b) => out.extend_from_slice(&b),
            M::Close(f) => {
                code = f.map(|f| u16::from(f.code));
                break;
            }
            _ => {}
        }
    }
    (String::from_utf8_lossy(&out).into_owned(), code)
}

#[tokio::test]
async fn tunnels_raw_http_for_a_relay_port() {
    use tokio_tungstenite::tungstenite::Message as M;
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("index.html"), "<html><head></head><body>tunnelled</body></html>").unwrap();
    let m = manager();
    let p = m.ensure("/w", static_backend(dir.path()), None).await.unwrap();
    let entry = m.get(&p.id).unwrap();
    let server = tunnel_server(entry.clone()).await;
    let request = |host: &str| format!("GET /index.html HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");

    // The relay's port is only accepted once registered.
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{server}/t")).await.unwrap();
    ws.send(M::binary(request("127.0.0.1:50999").into_bytes())).await.unwrap();
    let (resp, _) = drain(&mut ws).await;
    assert!(resp.starts_with("HTTP/1.1 403"), "{resp}");

    assert!(entry.add_alias_port(50999));
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{server}/t")).await.unwrap();
    ws.send(M::binary(request("127.0.0.1:50999").into_bytes())).await.unwrap();
    let (resp, _) = drain(&mut ws).await;
    assert!(resp.starts_with("HTTP/1.1 200"), "{resp}");
    assert!(resp.contains(INSPECTOR_PATH) && resp.contains("tunnelled"), "{resp}");

    // A foreign name on the relay's port is still refused (DNS rebinding).
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{server}/t")).await.unwrap();
    ws.send(M::binary(request("evil.example:50999").into_bytes())).await.unwrap();
    let (resp, _) = drain(&mut ws).await;
    assert!(resp.starts_with("HTTP/1.1 403"), "{resp}");

    // Text frames are refused.
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{server}/t")).await.unwrap();
    ws.send(M::text("GET / HTTP/1.1")).await.unwrap();
    assert_eq!(drain(&mut ws).await.1, Some(1003));

    // Closing the preview ends open tunnels.
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{server}/t")).await.unwrap();
    ws.send(M::binary(b"GET /index.html HTTP/1.1\r\n".to_vec())).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(m.close(&p.id));
    let ended = tokio::time::timeout(std::time::Duration::from_secs(5), drain(&mut ws)).await;
    assert!(ended.is_ok(), "the tunnel closes with the preview");
}
