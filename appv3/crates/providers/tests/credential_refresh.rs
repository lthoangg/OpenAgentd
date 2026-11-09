//! A pooled provider owns one built member per stored credential and keeps
//! it only while the stored values match: a key rewritten in
//! `credentials.yaml` (an edit, or a refresh writing new tokens) is used on
//! the next request, without rebuilding the provider. Synthetic keys only.

use appv3_core::credentials as store;
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

/// OpenAI-compatible server: every request gets a one-word streamed answer
/// naming its bearer key, which is also recorded.
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
            let body = format!(
                "data: {{\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"m\",\"choices\":[{{\"index\":0,\"delta\":{{\"content\":\"{key}\"}},\"finish_reason\":null}}]}}\n\ndata: {{\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"m\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"stop\"}}]}}\n\ndata: [DONE]\n\n"
            );
            let resp = format!("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
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
async fn a_rewritten_key_serves_the_next_request_without_rebuilding_the_provider() {
    let root = tempfile::tempdir().unwrap();
    setup(root.path());
    let (base, keys) = fake_server().await;
    let work = add("Work", "synthetic-old", &base);

    let p = tokio::task::spawn_blocking(|| build_provider(Some("router9:m"), Kwargs::new())).await.unwrap().unwrap();
    assert_eq!(ask(&p).await.unwrap(), "synthetic-old");
    assert_eq!(ask(&p).await.unwrap(), "synthetic-old", "an unchanged credential keeps its member");
    assert_eq!(p.served_credential(), Some((work.clone(), "Work".to_string())));

    store::update(|f| {
        let c = f.provider_mut("router9").iter_mut().find(|c| c.id == work).unwrap();
        c.values.insert("ROUTER9_API_KEY".into(), "synthetic-new".into());
    })
    .unwrap();
    assert_eq!(ask(&p).await.unwrap(), "synthetic-new", "the member built from the old key was replaced");
    assert_eq!(*keys.lock().unwrap(), ["synthetic-old", "synthetic-old", "synthetic-new"]);
    assert_eq!(p.served_credential().map(|(id, _)| id), Some(work), "the same stored credential still owns the requests");
}
