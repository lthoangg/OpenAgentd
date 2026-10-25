//! A provider with several stored credentials: requests stick to one key,
//! a quota failure moves the provider to the next, and edits to
//! `credentials.yaml` take effect without rebuilding the provider.

use appv3_core::credentials as store;
use appv3_providers::pool::CREDENTIAL_HEADER;
use appv3_providers::{build_provider, ChatMessage, Kwargs, LlmProvider};
use futures::StreamExt;
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn quota_on_one_key_moves_the_provider_to_the_next_and_it_sticks() {
    let root = tempfile::tempdir().unwrap();
    setup(root.path());
    let (base, keys) = fake_server().await;
    let personal = add("Personal", "limited", &base);
    add("Work", "work-key", &base);

    let p = tokio::task::spawn_blocking(|| build_provider(Some("router9:m"), Kwargs::new())).await.unwrap().unwrap();
    let err = ask(&p).await.unwrap_err();
    assert_eq!(err.status(), Some(429));
    assert_eq!(err.header(CREDENTIAL_HEADER), Some(personal.as_str()), "the error names the credential that served it");

    assert_eq!(p.rotate_credential(&err, "quota", 120.0).as_deref(), Some("Work"));
    assert_eq!(ask(&p).await.unwrap(), "work-key");
    assert_eq!(ask(&p).await.unwrap(), "work-key", "stays on the working key");
    assert_eq!(*keys.lock().unwrap(), ["limited", "work-key", "work-key"]);
    assert_eq!(store::cooldown("router9", &personal).map(|c| c.reason).as_deref(), Some("quota"));

    // With nothing else ready, there is nowhere to go.
    store::clear_cooldown("router9", &personal);
    let only = store::update(|f| {
        f.provider_mut("router9").retain(|c| c.label == "Personal");
        f.provider("router9")[0].id.clone()
    })
    .unwrap();
    let err = ask(&p).await.unwrap_err();
    assert_eq!(err.header(CREDENTIAL_HEADER), Some(only.as_str()), "a removed key stops serving at once");
    assert_eq!(p.rotate_credential(&err, "quota", 120.0), None);

    // A key added while the provider is live joins the pool.
    store::clear_cooldown("router9", &only);
    add("Backup", "backup-key", &base);
    let err = ask(&p).await.unwrap_err();
    assert_eq!(p.rotate_credential(&err, "quota", 120.0).as_deref(), Some("Backup"));
    assert_eq!(ask(&p).await.unwrap(), "backup-key");
}
