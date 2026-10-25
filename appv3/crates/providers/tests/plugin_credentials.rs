use appv3_core::credentials as store;
use appv3_providers::creds::CredentialStore;
use appv3_providers::js_plugin::JsProviderPlugin;
use appv3_providers::plugin::ProviderPlugin;
use serde_json::json;
use std::sync::{Arc, Mutex};

fn setup(root: &std::path::Path) {
    for (key, dir) in [
        ("OPENAGENTD_CONFIG_DIR", "config"),
        ("OPENAGENTD_CACHE_DIR", "cache"),
        ("OPENAGENTD_DATA_DIR", "data"),
        ("OPENAGENTD_STATE_DIR", "state"),
        ("OPENAGENTD_WORKSPACE_DIR", "workspace"),
    ] {
        std::env::set_var(key, root.join(dir));
    }
    std::env::remove_var("PLUGIN_KEY");
    std::env::set_var("OPENAGENTD_PLUGINS_DIRS", root.join("plugins"));
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
    appv3_providers::js_plugin::register_natives();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn plugin_helpers_honor_the_pinned_credential_instead_of_the_active_one() {
    let root = tempfile::tempdir().unwrap();
    setup(root.path());
    let path = root.path().join("scoped.ts");
    std::fs::write(
        &path,
        r#"
export const provider = {
  id: "scoped", label: "Scoped", kind: "api_key",
  credentials: [{ name: "PLUGIN_KEY", label: "Key", secret: true }],
  build() { return { base: "anthropic", options: { apiKey: "unused" } }; },
  isConfigured(c) { return c.get("PLUGIN_KEY") === "pinned"; },
  getUsage(c) { return { provider: "scoped", limits: [{ limit_name: c.get("PLUGIN_KEY") }] }; },
};
"#,
    )
    .unwrap();
    let plugin = JsProviderPlugin::from_plugin(&appv3_jsplugin::JsPlugin::load(&path).unwrap()).unwrap();
    store::update(|f| {
        let mut active = store::Credential::new("Active");
        active.values.insert("PLUGIN_KEY".into(), "active".into());
        f.provider_mut("scoped").push(active);
    })
    .unwrap();
    let pinned = CredentialStore::for_credential("scoped", [("PLUGIN_KEY".into(), "pinned".into())].into_iter().collect());
    assert_eq!(plugin.is_configured(&pinned), Some(true), "the Rust-to-JS bridge must preserve the pinned values");
    let usage = plugin.get_usage(&pinned).await.unwrap_or_else(|_| panic!("plugin usage failed"));
    assert_eq!(usage["limits"][0]["limit_name"], json!("pinned"));
    assert_eq!(CredentialStore::for_provider("scoped", Default::default()).get("PLUGIN_KEY"), "active");
    let empty = CredentialStore::for_credential("scoped", Default::default());
    assert_eq!(empty.get("PLUGIN_KEY"), "", "a missing value never leaks in from the active credential");
    verify_oauth_isolation(root.path()).await;
    verify_plugin_pool(root.path()).await;
}

async fn verify_oauth_isolation(root: &std::path::Path) {
    let path = root.join("accounts.ts");
    std::fs::write(
        &path,
        r#"
export const provider = {
  id: "accounts", label: "Accounts", kind: "oauth", supportsMultipleCredentials: true,
  build() { return { base: "anthropic", options: { apiKey: "unused" } }; },
  login(emit, ctx) {
    ctx.credentials.writeOAuth({ access_token: ctx.credentialId }, { label: ctx.credentialId });
    ctx.credentials.writeJson("pending.json", { id: ctx.credentialId });
    emit("success", { id: ctx.credentialId });
  },
  oauthCallback(code, emit, ctx) {
    const c = ctx.credentials;
    const before = c.readOAuth();
    if (code === "revoke") { c.removeOAuth(before); return; }
    if (code === "race") {
      if (c.writeOAuth({ access_token: "stale" }, { expected: { access_token: "wrong" } })) throw Error("stale refresh won");
    } else {
      c.writeOAuth({ access_token: code }, { expected: before });
    }
    emit("success", { id: c.readJson("pending.json").id });
  },
  getUsage(c) { return { provider: "accounts", limits: [{ limit_name: c.readOAuth()?.access_token ?? "revoked" }] }; },
};
"#,
    )
    .unwrap();
    let plugin = JsProviderPlugin::from_plugin(&appv3_jsplugin::JsPlugin::load(&path).unwrap()).unwrap();
    assert!(plugin.info().supports_multiple_credentials);
    let (a, b) = store::update(|f| {
        let a = store::Credential::new("A");
        let b = store::Credential::new("B");
        f.provider_mut("accounts").extend([a.clone(), b.clone()]);
        (a.id, b.id)
    })
    .unwrap();
    let events = Arc::new(Mutex::new(vec![]));
    let seen = events.clone();
    let sink: appv3_providers::plugin::OAuthSink = Arc::new(move |_, data| seen.lock().unwrap().push(data));
    let account = |id: &str| CredentialStore::for_account("accounts", id);
    let (ra, rb) = tokio::join!(plugin.login_for(sink.clone(), account(&a)), plugin.login_for(sink.clone(), account(&b)));
    ra.unwrap();
    rb.unwrap();
    assert_eq!(store::snapshot().find("accounts", &a).unwrap().oauth.as_ref().unwrap()["access_token"], a);
    assert_eq!(store::snapshot().find("accounts", &b).unwrap().oauth.as_ref().unwrap()["access_token"], b);
    plugin.oauth_callback_for("fresh-a", sink.clone(), account(&a)).await.unwrap();
    plugin.oauth_callback_for("race", sink.clone(), account(&a)).await.unwrap();
    let usage = plugin.get_usage(&account(&a)).await.unwrap_or_else(|_| panic!("account usage failed"));
    assert_eq!(usage["limits"][0]["limit_name"], "fresh-a");
    let usage = plugin.get_usage(&account(&b)).await.unwrap_or_else(|_| panic!("account usage failed"));
    assert_eq!(usage["limits"][0]["limit_name"], b);
    assert_eq!(events.lock().unwrap().last().unwrap()["id"], a, "callback reads only its own pending state");
    plugin.oauth_callback_for("revoke", sink.clone(), account(&a)).await.unwrap();
    assert!(store::snapshot().find("accounts", &a).unwrap().oauth.is_none());
    assert!(store::snapshot().find("accounts", &b).unwrap().oauth.is_some());
    store::update(|f| {
        f.remove("accounts", &a);
    })
    .unwrap();
    assert!(plugin.login_for(sink, account(&a)).await.unwrap_err().contains("no longer exists"));
    assert!(store::snapshot().find("accounts", &a).is_none(), "a late login cannot recreate a removed account");
}

async fn verify_plugin_pool(root: &std::path::Path) {
    use appv3_providers::{ChatMessage, Kwargs};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let request = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = vec![0; 16384];
        let n = socket.read(&mut request).await.unwrap();
        let text = String::from_utf8_lossy(&request[..n]).to_string();
        let body = r#"{"id":"m","type":"message","role":"assistant","content":[{"type":"text","text":"ok"}],"model":"m","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}"#;
        socket
            .write_all(format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).as_bytes())
            .await
            .unwrap();
        text
    });
    let dir = root.join("plugins");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("pooled.ts"),
        r#"
import { HttpError, AuthError, NetworkError } from "openagentd";
export const provider = {
  id: "pooled", label: "Pooled", kind: "api_key", supportsMultipleCredentials: true,
  credentials: [{ name: "PLUGIN_KEY", label: "Key", secret: true }],
  build(ctx) {
    const key = ctx.credentials.get("PLUGIN_KEY");
    if (key === "network") throw new NetworkError("temporary connection failure");
    return {
      base: "anthropic", options: { apiKey: key, baseUrl: ctx.credentials.get("TEST_BASE") },
      beforeCall() {
        if (key === "limited") throw new HttpError(429, "quota", { body: "quota" });
        if (key === "rejected") throw new AuthError("revoked login");
      },
    };
  },
};
"#,
    )
    .unwrap();
    std::fs::write(
        dir.join("legacy.ts"),
        r#"
export const provider = { id: "legacy", label: "Legacy", kind: "api_key", build() { return { base: "anthropic", options: { apiKey: "legacy" } }; } };
"#,
    )
    .unwrap();
    let first = store::update(|f| {
        let mut a = store::Credential::new("Limited");
        a.values.insert("PLUGIN_KEY".into(), "limited".into());
        a.values.insert("TEST_BASE".into(), base.clone());
        let mut b = store::Credential::new("Backup");
        b.values.insert("PLUGIN_KEY".into(), "backup".into());
        b.values.insert("TEST_BASE".into(), base);
        f.provider_mut("pooled").extend([a.clone(), b]);
        a.id
    })
    .unwrap();
    assert!(appv3_providers::pool::is_poolable("pooled"));
    assert!(!appv3_providers::pool::is_poolable("legacy"));
    std::env::set_var("PLUGIN_KEY", "exported");
    assert!(appv3_providers::pool::env_pinned("pooled"));
    std::env::remove_var("PLUGIN_KEY");
    let transient = store::update(|f| {
        let mut c = store::Credential::new("Transient");
        c.values = f.provider("pooled")[0].values.clone();
        c.values.insert("PLUGIN_KEY".into(), "network".into());
        f.provider_mut("pooled").insert(0, c.clone());
        c.id
    })
    .unwrap();
    let p = tokio::task::spawn_blocking(|| appv3_providers::build_provider(Some("pooled:m"), Kwargs::new())).await.unwrap().unwrap();
    assert!(store::cooldown("pooled", &transient).is_none(), "a transient build failure must not mark a healthy account as rejected for ten minutes");
    store::update(|f| {
        f.remove("pooled", &transient);
    })
    .unwrap();
    let messages = [ChatMessage::user("hello")];
    let error = p.chat(&messages, None, &Kwargs::new()).await.unwrap_err();
    assert_eq!(error.header(appv3_providers::pool::CREDENTIAL_HEADER), Some(first.as_str()));
    assert_eq!(p.rotate_credential(&error, "quota", 60.0).as_deref(), Some("Backup"));
    p.chat(&messages, None, &Kwargs::new()).await.unwrap();
    assert!(request.await.unwrap().to_lowercase().contains("x-api-key: backup"));
    store::update(|f| {
        f.provider_mut("pooled")[1].values.insert("PLUGIN_KEY".into(), "rejected".into());
        let mut last = store::Credential::new("Last");
        last.values.insert("PLUGIN_KEY".into(), "last".into());
        f.provider_mut("pooled").push(last);
    })
    .unwrap();
    let error = p.chat(&messages, None, &Kwargs::new()).await.unwrap_err();
    assert_eq!(error.status(), Some(401), "a plugin AuthError is a rejected credential, not an opaque failure");
    assert_eq!(p.rotate_credential(&error, "auth", 60.0).as_deref(), Some("Last"));
}
