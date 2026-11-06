//! A session locked to one stored credential: requests start on it while it
//! is ready, never move the provider's shared choice, fall through to the
//! other ready keys while it cools down, and go back to it once it recovers.

use appv3_core::credentials as store;
use appv3_providers::pool::{CREDENTIAL_HEADER, PIN_KWARG};
use appv3_providers::{build_provider, ChatMessage, Kwargs, LlmProvider};
use futures::StreamExt;
use serde_json::json;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn setup(root: &std::path::Path) {
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
    std::env::set_var("OPENAGENTD_MODEL_REGISTRY_REFRESH", "false");
    std::env::remove_var("ROUTER9_API_KEY");
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
}

/// OpenAI-compatible server: the bearer key `limited` gets a quota 429,
/// any other key a one-word streamed answer naming the key.
async fn fake_server() -> (String, Arc<Mutex<Vec<String>>>) {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    let keys: Arc<Mutex<Vec<String>>> = Default::default();
    let seen = keys.clone();
    tokio::spawn(async move {
        loop {
            let (mut s, _) = l.accept().await.unwrap();
            let mut buf = vec![0u8; 65536];
            let mut got = 0;
            let head = loop {
                let k = s.read(&mut buf[got..]).await.unwrap();
                got += k;
                let text = String::from_utf8_lossy(&buf[..got]).to_string();
                if let Some(h) = text.find("\r\n\r\n") {
                    let cl: usize = text[..h].lines().find_map(|l| l.to_lowercase().strip_prefix("content-length: ").map(|v| v.trim().parse().unwrap())).unwrap_or(0);
                    if got >= h + 4 + cl || k == 0 {
                        break text[..h].to_string();
                    }
                }
            };
            let key = head.lines().find_map(|l| l.to_lowercase().strip_prefix("authorization: bearer ").map(|v| v.trim().to_string())).unwrap_or_default();
            seen.lock().unwrap().push(key.clone());
            let resp = if key == "limited" {
                let body = r#"{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}"#;
                format!("HTTP/1.1 429 Too Many Requests\r\ncontent-type: application/json\r\nretry-after: 120\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len())
            } else {
                let body = format!(
                    "data: {{\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"m\",\"choices\":[{{\"index\":0,\"delta\":{{\"content\":\"{key}\"}},\"finish_reason\":null}}]}}\n\ndata: {{\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"m\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"stop\"}}]}}\n\ndata: [DONE]\n\n"
                );
                format!("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len())
            };
            s.write_all(resp.as_bytes()).await.unwrap();
            let _ = s.shutdown().await;
        }
    });
    (format!("http://{addr}/v1"), keys)
}

async fn ask(p: &Arc<dyn LlmProvider>) -> Result<String, appv3_providers::ProviderError> {
    let mut s = p.stream(&[ChatMessage::user("hi")], None, &Kwargs::new()).await?;
    let mut out = String::new();
    while let Some(c) = s.next().await {
        out.extend(c?.choices.iter().filter_map(|ch| ch.delta.content.clone()));
    }
    Ok(out)
}

fn add(label: &str, key: &str, base: &str) -> String {
    store::update(|f| {
        let mut c = store::Credential::new(label);
        c.values.insert("ROUTER9_API_KEY".into(), key.into());
        c.values.insert("ROUTER9_BASE_URL".into(), base.into());
        f.provider_mut("router9").push(c.clone());
        c.id
    })
    .unwrap()
}

fn pinned(id: &str) -> Kwargs {
    let mut kw = Kwargs::new();
    kw.insert(PIN_KWARG.into(), json!(id));
    kw
}

async fn build(kw: Kwargs) -> Arc<dyn LlmProvider> {
    tokio::task::spawn_blocking(move || build_provider(Some("router9:m"), kw)).await.unwrap().unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_locked_session_starts_on_its_credential_and_moves_on_when_it_is_limited() {
    let root = tempfile::tempdir().unwrap();
    setup(root.path());
    let (base, keys) = fake_server().await;
    let work = add("Work", "work-key", &base);
    let personal = add("Personal", "personal-key", &base);
    let limited = add("Limited", "limited", &base);

    // Locked to the second key: that key is called, and the shared "in use"
    // choice stays where unlocked sessions left it.
    let p = build(pinned(&personal)).await;
    assert_eq!(ask(&p).await.unwrap(), "personal-key");
    assert_eq!(ask(&p).await.unwrap(), "personal-key");
    assert_eq!(p.served_credential(), Some((personal.clone(), "Personal".to_string())));
    assert_eq!(p.pinned_credential().as_deref(), Some("Personal"));
    assert_ne!(store::current("router9").as_deref(), Some(personal.as_str()), "a lock never moves the shared choice");

    // While the locked key cools down, requests go to the next ready key
    // instead, still without moving the shared choice.
    store::set_cooldown("router9", &personal, store::now_s() + 300.0, "quota");
    assert_eq!(ask(&p).await.unwrap(), "work-key");
    assert_eq!(p.served_credential().map(|(id, _)| id), Some(work.clone()));
    assert_ne!(store::current("router9").as_deref(), Some(work.as_str()), "a fallback does not move the shared choice either");
    assert_eq!(p.credential_recovery_secs(), None, "another key is ready: nothing to wait for");

    // Once it recovers, the session is back on the locked key.
    store::clear_cooldown("router9", &personal);
    assert_eq!(ask(&p).await.unwrap(), "personal-key");
    assert_eq!(*keys.lock().unwrap(), ["personal-key", "personal-key", "work-key", "personal-key"]);

    // A quota error from the locked key itself rotates to the next ready key
    // and names it, and the next request goes there.
    let q = build(pinned(&limited)).await;
    let err = ask(&q).await.unwrap_err();
    assert_eq!(err.status(), Some(429));
    assert_eq!(err.header(CREDENTIAL_HEADER), Some(limited.as_str()));
    assert_eq!(q.rotate_credential(&err, "quota", 120.0).as_deref(), Some("Work"));
    assert!(store::cooldown("router9", &limited).is_some(), "the cooldown is shared");
    assert_eq!(ask(&q).await.unwrap(), "work-key");

    // Every key limited: no rotation, and the wait is the earliest recovery.
    store::set_cooldown("router9", &work, store::now_s() + 600.0, "quota");
    store::set_cooldown("router9", &personal, store::now_s() + 60.0, "quota");
    let err = appv3_providers::ProviderError::Http { status: 429, body: String::new(), headers: vec![(CREDENTIAL_HEADER.to_string(), work.clone())], message: "limited".into() };
    assert_eq!(q.rotate_credential(&err, "quota", 600.0), None);
    assert!(q.credential_recovery_secs().is_some_and(|s| s > 30.0 && s <= 60.0), "waits for the first key to reset");
    for id in [&work, &personal, &limited] {
        store::clear_cooldown("router9", id);
    }

    // A lock to a credential that is gone (or turned off) is dropped.
    let auto = build(pinned("no-such-credential")).await;
    assert_eq!(auto.pinned_credential(), None);
    assert_eq!(ask(&auto).await.unwrap(), "work-key");
    assert_eq!(auto.served_credential().map(|(id, _)| id), Some(work.clone()));
    assert!(!appv3_providers::pool::pin_usable("router9", "no-such-credential"));
    assert!(appv3_providers::pool::pin_usable("router9", &work));
}
