//! Provider plugins and several credentials, over the real router: plugins
//! that opt in (`supportsMultipleCredentials`) get per-account sign-in,
//! usage, models and sign-out; plugins that did not keep one credential and
//! refuse credential-specific calls instead of ignoring them.
//!
//! Settings and the plugin registry are process-global, so this file is its
//! own test binary with one test and fixture plugins written to a temp dir.

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

const MULTI: &str = r#"
export const provider = {
  id: "multi", label: "Multi", description: "multi", kind: "oauth", supportsMultipleCredentials: true,
  credentials: [{ name: "MULTI_REGION", label: "Region", secret: false, required: false }],
  build(ctx) { const t = ctx.credentials.readOAuth(); throw new Error("built with " + (t ? t.access_token : "no token")); },
  login(emit, ctx) {
    emit("device_code", { code: "ABCD" });
    ctx.credentials.writeOAuth({ access_token: "tok-" + ctx.credentialId });
    emit("success", { message: "ok" });
  },
  oauthCallback(code, emit, ctx) {
    ctx.credentials.writeOAuth({ access_token: "cb-" + code });
    emit("success", {});
  },
  isConfigured(c) { return !!c.readOAuth(); },
  getUsage(c) { return { provider: "multi", limits: [{ limit_id: "m", limit_name: String((c.readOAuth() || {}).access_token) }] }; },
  discoverModels(c) { const t = c.readOAuth(); return ["model-" + (t ? t.access_token : "none")]; },
};
"#;

const MULTIFAIL: &str = r#"
export const provider = {
  id: "multifail", label: "Multi fail", description: "fails", kind: "oauth", supportsMultipleCredentials: true,
  build() { throw new Error("not used"); },
  login(emit, ctx) { throw new Error("boom"); },
};
"#;

// An opted-in key plugin whose per-account check differs from its
// provider-wide one, so the two paths of `provider_is_configured` are told apart.
const KEYED: &str = r#"
export const provider = {
  id: "keyed", label: "Keyed", description: "keyed", kind: "api_key", supportsMultipleCredentials: true,
  credentials: [
    { name: "KEYED_KEY", label: "Key", secret: true, required: true },
    { name: "KEYED_TOKEN", label: "Token", secret: true, required: false },
  ],
  build() { throw new Error("fixture does not build"); },
  isConfigured(c) { return c.credentialId ? !!c.readOAuth() : !!c.get("KEYED_KEY"); },
};
"#;

const LEGACY: &str = r#"
export const provider = {
  id: "legacy", label: "Legacy", description: "legacy", kind: "oauth",
  credentials: [{ name: "LEGACY_KEY", label: "Key", secret: true, required: true }],
  build() { throw new Error("not used"); },
  login(emit) { emit("success", { message: "legacy" }); },
  oauthCallback(code, emit) { emit("success", {}); },
  isConfigured(c) { return !!c.get("LEGACY_KEY"); },
  getUsage(c) { return { provider: "legacy", limits: [{ limit_id: "l", limit_name: "legacy" }] }; },
};
"#;

struct Client {
    app: Router,
}

impl Client {
    async fn send(&self, mut req: Request<Body>) -> (StatusCode, Vec<u8>) {
        let local: SocketAddr = "127.0.0.1:8000".parse().unwrap();
        req.extensions_mut().insert(ConnectInfo(ConnInfo { local: Some(local), remote: Some("127.0.0.1:50000".parse().unwrap()) }));
        let resp = self.app.clone().oneshot(req).await.unwrap();
        let (parts, body) = resp.into_parts();
        let bytes = tokio::time::timeout(Duration::from_secs(20), body.collect()).await.expect("response body ended").unwrap().to_bytes().to_vec();
        (parts.status, bytes)
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
        let (s, bytes) = self.send(b.body(body).unwrap()).await;
        (s, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }
    /// A sign-in stream, read to its end.
    async fn sse(&self, uri: &str) -> (StatusCode, Vec<(String, Value)>) {
        let (s, raw) = self.send(Request::get(uri).body(Body::empty()).unwrap()).await;
        let text = String::from_utf8_lossy(&raw).replace("\r\n", "\n");
        let mut out = vec![];
        for block in text.split("\n\n") {
            let (mut ev, mut data) = ("message".to_string(), String::new());
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
        (s, out)
    }
}

fn rows(provider: &str) -> Vec<appv3_core::credentials::Credential> {
    appv3_core::credentials::load().unwrap().provider(provider).to_vec()
}

fn provider<'a>(list: &'a Value, id: &str) -> &'a Value {
    list["providers"].as_array().unwrap().iter().find(|p| p["id"] == id).unwrap_or_else(|| panic!("provider {id} missing"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn plugin_credentials_over_http() {
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
    for k in ["OPENAGENTD_DESKTOP_TOKEN", "OPENAGENTD_ACCESS_KEY", "DATABASE_URL", "OPENAGENTD_DATABASE_URL", "LEGACY_KEY", "MULTI_REGION", "KEYED_KEY", "KEYED_TOKEN"] {
        std::env::remove_var(k);
    }
    std::fs::create_dir_all(r.join("plugins")).unwrap();
    for (name, src) in [("multi.js", MULTI), ("multifail.js", MULTIFAIL), ("legacy.js", LEGACY), ("keyed.js", KEYED)] {
        std::fs::write(r.join("plugins").join(name), src).unwrap();
    }
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
    let s = appv3_core::settings();
    std::fs::create_dir_all(s.database_path.parent().unwrap()).unwrap();
    let pool = appv3_db::create_pool(&s.database_path).await.unwrap();
    appv3_db::migrations::run_migrations(&pool).await.unwrap();
    let c = Client { app: create_app(AppState { pool }, Policy::from_env()) };
    let store_text = || std::fs::read_to_string(r.join("config").join(appv3_core::credentials::FILE_NAME)).unwrap_or_default();

    // ── capability flags ─────────────────────────────────────────────────
    let (st, list) = c.json("GET", "/api/settings/providers", None).await;
    assert_eq!(st, StatusCode::OK, "{list}");
    for (id, multiple, usage) in [("multi", true, true), ("legacy", false, false), ("openrouter", true, true), ("anthropic", true, false)] {
        let p = provider(&list, id);
        assert_eq!(p["supports_multiple_credentials"], json!(multiple), "{id}: {p}");
        assert_eq!(p["supports_credential_usage"], json!(usage), "{id}: {p}");
    }
    assert_eq!(provider(&list, "multi")["is_configured"], json!(false));

    // ── sign in: each login reserves its own row and says which ─────────
    let (st, ev) = c.sse("/api/auth/multi/login").await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(ev[0].0, "started", "{ev:?}");
    let a = ev[0].1["credential_id"].as_str().expect("started names the account").to_string();
    let success = ev.iter().find(|(e, _)| e == "success").expect("success event");
    assert_eq!(success.1["credential_id"], json!(a), "{ev:?}");
    assert!(ev.iter().all(|(_, d)| d["credential_id"] == json!(a)), "every event is tagged: {ev:?}");
    assert_eq!(rows("multi").len(), 1);
    assert_eq!(rows("multi")[0].oauth.as_ref().unwrap()["access_token"], json!(format!("tok-{a}")));

    let (_, ev) = c.sse("/api/auth/multi/login").await;
    let b = ev[0].1["credential_id"].as_str().unwrap().to_string();
    assert_ne!(a, b);
    assert_eq!(rows("multi").len(), 2, "a second sign-in adds an account");
    // Reconnecting an account reuses its row; an unknown one is refused.
    let (st, ev) = c.sse(&format!("/api/auth/multi/login?credential_id={a}")).await;
    assert_eq!((st, ev[0].1["credential_id"].clone()), (StatusCode::OK, json!(a)));
    assert_eq!(rows("multi").len(), 2);
    let (st, _) = c.sse("/api/auth/multi/login?credential_id=cred_gone").await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    assert_eq!(rows("multi").len(), 2, "an unknown account is not created");

    // Configured status comes from the scoped accounts, and no secret shows.
    let (_, list) = c.json("GET", "/api/settings/providers", None).await;
    assert_eq!(provider(&list, "multi")["is_configured"], json!(true));
    let (_, creds) = c.json("GET", "/api/settings/providers/multi/credentials", None).await;
    assert_eq!(creds["credentials"].as_array().unwrap().len(), 2);
    for body in [list.to_string(), creds.to_string()] {
        assert!(!body.contains("tok-") && !body.contains("access_token"), "token leaked: {body}");
    }

    // ── pasted code binds to the account named in the request ───────────
    let (st, v) = c.json("POST", "/api/auth/multi/callback", Some(json!({"code": "abc"}))).await;
    assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY, "credential_id is required: {v}");
    let (st, v) = c.json("POST", "/api/auth/multi/callback", Some(json!({"code": "abc", "credential_id": "cred_gone"}))).await;
    assert_eq!(st, StatusCode::NOT_FOUND, "{v}");
    let (st, v) = c.json("POST", "/api/auth/multi/callback", Some(json!({"code": "abc", "credential_id": a}))).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!((v["ok"].clone(), v["credential_id"].clone()), (json!(true), json!(a)));
    let after: Vec<_> = rows("multi");
    assert_eq!(after.iter().find(|x| x.id == a).unwrap().oauth.as_ref().unwrap()["access_token"], json!("cb-abc"));
    assert_eq!(after.iter().find(|x| x.id == b).unwrap().oauth.as_ref().unwrap()["access_token"], json!(format!("tok-{b}")), "the other account is untouched");

    // ── usage and models read the named account, not the active one ─────
    let name = |v: &Value| v["limits"][0]["limit_name"].clone();
    let (st, v) = c.json("GET", &format!("/api/settings/providers/multi/usage?credential_id={b}"), None).await;
    assert_eq!((st, name(&v)), (StatusCode::OK, json!(format!("tok-{b}"))), "{v}");
    let (_, v) = c.json("GET", &format!("/api/settings/providers/multi/usage?credential_id={a}"), None).await;
    assert_eq!(name(&v), json!("cb-abc"));
    let (st, _) = c.json("GET", "/api/settings/providers/multi/usage?credential_id=cred_gone", None).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    let (st, v) = c.json("POST", "/api/settings/providers/multi/models", Some(json!({"credential_id": b}))).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["models"], json!([format!("model-tok-{b}")]));
    let (st, _) = c.json("POST", "/api/settings/providers/multi/models", Some(json!({"credential_id": "cred_gone"}))).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    let (st, _) = c.json("POST", "/api/settings/providers/multi/test", Some(json!({"model": "x", "credential_id": "cred_gone"}))).await;
    assert_eq!(st, StatusCode::NOT_FOUND);

    // ── a failed sign-in leaves no empty row; a reconnect keeps its row ──
    let (st, ev) = c.sse("/api/auth/multifail/login").await;
    assert_eq!(st, StatusCode::OK);
    let failed = ev.iter().find(|(e, _)| e == "failed").unwrap_or_else(|| panic!("no failed event: {ev:?}"));
    assert!(failed.1["credential_id"].is_string(), "{failed:?}");
    assert!(rows("multifail").is_empty(), "the reserved row is dropped: {}", store_text());

    // ── sign out one account, then all; keys pasted by hand stay ────────
    let (st, v) = c.json("POST", "/api/settings/providers/multi/credentials", Some(json!({"label": "Eu", "extra": {"MULTI_REGION": "eu"}}))).await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    assert_eq!(v["status"], json!("needs_reconnect"), "settings alone are not a connected account: {v}");
    assert_eq!(v["status"], json!("needs_reconnect"), "settings alone are not a connected OAuth account: {v}");
    let pasted = v["id"].as_str().unwrap().to_string();
    let (st, _) = c.json("DELETE", "/api/auth/multi?credential_id=cred_gone", None).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    let (st, v) = c.json("DELETE", &format!("/api/auth/multi?credential_id={b}"), None).await;
    assert_eq!((st, v["credential_id"].clone()), (StatusCode::OK, json!(b)));
    let ids: Vec<String> = rows("multi").into_iter().map(|c| c.id).collect();
    assert_eq!(ids, [a.clone(), pasted.clone()]);
    // A removed account is never recreated by a late callback.
    let (st, _) = c.json("POST", "/api/auth/multi/callback", Some(json!({"code": "late", "credential_id": b}))).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    assert_eq!(rows("multi").len(), 2);
    let (st, _) = c.json("DELETE", "/api/auth/multi", None).await;
    assert_eq!(st, StatusCode::OK);
    let ids: Vec<String> = rows("multi").into_iter().map(|c| c.id).collect();
    assert_eq!(ids, [pasted], "only OAuth accounts are signed out");
    let (_, list) = c.json("GET", "/api/settings/providers", None).await;
    assert_eq!(provider(&list, "multi")["is_configured"], json!(false));
    assert!(!store_text().contains("tok-") && !store_text().contains("cb-abc"));

    // ── a plugin that did not opt in keeps one credential ───────────────
    let add = |key: &str| json!({"label": "K", "api_key": key});
    let (st, v) = c.json("POST", "/api/settings/providers/legacy/credentials", Some(add("k1"))).await;
    assert_eq!(st, StatusCode::CREATED, "the first credential is a normal save: {v}");
    let (st, v) = c.json("POST", "/api/settings/providers/legacy/credentials", Some(add("k2"))).await;
    assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY, "{v}");
    assert!(v["detail"].as_str().unwrap().contains("single credential"), "{v}");
    assert_eq!(rows("legacy").len(), 1);
    // Extras stored by hand are kept, and single-credential save still works.
    appv3_core::credentials::update(|f| {
        let mut extra = appv3_core::credentials::Credential::new("Extra");
        extra.values.insert("LEGACY_KEY".into(), "k-extra".into());
        f.provider_mut("legacy").push(extra);
    })
    .unwrap();
    let (st, v) = c.json("PUT", "/api/settings/providers/legacy", Some(json!({"api_key": "k1b"}))).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(rows("legacy").len(), 2);
    let (st, v) = c.json("GET", "/api/settings/providers/legacy/usage", None).await;
    assert_eq!((st, name(&v)), (StatusCode::OK, json!("legacy")), "plain usage works: {v}");
    let cid = rows("legacy")[0].id.clone();
    let (st, ev) = c.sse(&format!("/api/auth/legacy/login?credential_id={cid}")).await;
    assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY, "{ev:?}");
    let (st, v) = c.json("GET", &format!("/api/settings/providers/legacy/usage?credential_id={cid}"), None).await;
    assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY, "{v}");
    let (st, v) = c.json("POST", "/api/auth/legacy/callback", Some(json!({"code": "x", "credential_id": cid}))).await;
    assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY, "{v}");
    let (st, v) = c.json("DELETE", &format!("/api/auth/legacy?credential_id={cid}"), None).await;
    assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY, "{v}");
    let (st, v) = c.json("POST", "/api/auth/legacy/callback", Some(json!({"code": "x"}))).await;
    assert_eq!(st, StatusCode::OK, "the legacy callback is unchanged: {v}");
    assert!(v.get("credential_id").is_none(), "{v}");
    let (st, ev) = c.sse("/api/auth/legacy/login").await;
    assert_eq!(st, StatusCode::OK);
    assert!(ev.iter().any(|(e, d)| e == "success" && d.get("credential_id").is_none()), "{ev:?}");
    let (st, _) = c.json("DELETE", "/api/auth/legacy", None).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(rows("legacy").len(), 2, "signing out never deletes stored credentials");

    // ── an exported variable pins an opted-in key plugin beside stored rows ──
    let (st, v) = c.json("POST", "/api/settings/providers/keyed/credentials", Some(json!({"label": "Stored", "extra": {"KEYED_KEY": "stored-key"}}))).await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    let configured = |list: &Value| provider(list, "keyed")["is_configured"].clone();
    let (_, list) = c.json("GET", "/api/settings/providers", None).await;
    assert_eq!(configured(&list), json!(false), "the stored row fails the plugin's per-account check");
    // The pin names a different variable than the row holds: the provider-wide
    // check must see the environment only, not the stored account's key.
    std::env::set_var("KEYED_TOKEN", "pinned-token");
    let (_, list) = c.json("GET", "/api/settings/providers", None).await;
    assert_eq!(configured(&list), json!(false), "no cross-account fallback to the stored key");
    std::env::set_var("KEYED_KEY", "pinned-key");
    let (_, list) = c.json("GET", "/api/settings/providers", None).await;
    assert_eq!(configured(&list), json!(true), "the exported key pins the provider even with enabled rows");
    std::env::remove_var("KEYED_KEY");
    std::env::remove_var("KEYED_TOKEN");
    let (_, list) = c.json("GET", "/api/settings/providers", None).await;
    assert_eq!(configured(&list), json!(false));

    // ── saving without an id updates the stored row, however stale `current` is ──
    let base = "/api/settings/providers/openrouter";
    let (st, one) = c.json("POST", &format!("{base}/credentials"), Some(json!({"label": "One", "api_key": "sk-or-one-1111"}))).await;
    assert_eq!(st, StatusCode::CREATED, "{one}");
    let (_, two) = c.json("POST", &format!("{base}/credentials"), Some(json!({"label": "Two", "api_key": "sk-or-two-2222"}))).await;
    let (one, two) = (one["id"].as_str().unwrap().to_string(), two["id"].as_str().unwrap().to_string());
    appv3_core::credentials::set_current("openrouter", &one);
    let (st, _) = c.json("DELETE", &format!("{base}/credentials/{one}"), None).await;
    assert_eq!(st, StatusCode::OK);
    appv3_core::credentials::set_current("openrouter", &one); // stale: the row is gone
    let (st, v) = c.json("PUT", base, Some(json!({"api_key": "sk-or-new-3333"}))).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["credential_id"], json!(two), "the remaining row is updated: {v}");
    let stored = rows("openrouter");
    assert_eq!(stored.len(), 1, "no Default row is created beside it");
    assert_eq!((stored[0].label.as_str(), stored[0].value("OPENROUTER_API_KEY")), ("Two", Some("sk-or-new-3333")));
    let (st, v) = c.json("PUT", base, Some(json!({"api_key": "sk-or-x", "credential_id": one}))).await;
    assert_eq!(st, StatusCode::NOT_FOUND, "an explicit removed id is not recreated: {v}");
    assert_eq!(rows("openrouter").len(), 1);
    // With no stored row at all, the first save still creates one.
    let (st, _) = c.json("DELETE", &format!("{base}/credentials/{two}"), None).await;
    assert_eq!(st, StatusCode::OK);
    appv3_core::credentials::set_current("openrouter", &two);
    let (st, v) = c.json("PUT", base, Some(json!({"api_key": "sk-or-first-4444"}))).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(rows("openrouter").iter().map(|r| r.label.clone()).collect::<Vec<_>>(), ["Default"]);

    // ── default (no credential_id) requests use the signed-in account, scoped ──
    let left = rows("multi");
    for r in &left {
        let (st, _) = c.json("DELETE", &format!("/api/settings/providers/multi/credentials/{}", r.id), None).await;
        assert_eq!(st, StatusCode::OK);
    }
    let (_, ev) = c.sse("/api/auth/multi/login").await;
    let x = ev[0].1["credential_id"].as_str().unwrap().to_string();
    // A pending sign-in (an empty reserved row) sits first in priority order.
    appv3_core::credentials::update(|f| {
        let pending = appv3_core::credentials::Credential::new("Pending");
        f.provider_mut("multi").insert(0, pending);
    })
    .unwrap();
    appv3_core::credentials::clear_current("multi");
    let pending = rows("multi")[0].id.clone();
    assert_ne!(pending, x);
    for order in [[pending.clone(), x.clone()], [x.clone(), pending.clone()], [pending.clone(), x.clone()]] {
        let (st, v) = c.json("PUT", "/api/settings/providers/multi/credentials/order", Some(json!({"ids": order}))).await;
        assert_eq!(st, StatusCode::OK, "{v}");
        let in_use: Vec<(String, bool)> = v["credentials"].as_array().unwrap().iter().map(|c| (c["id"].as_str().unwrap().to_string(), c["in_use"].as_bool().unwrap())).collect();
        assert!(in_use.contains(&(x.clone(), true)) && in_use.contains(&(pending.clone(), false)), "the pending row is never in use: {in_use:?}");
        let (st, v) = c.json("POST", "/api/settings/providers/multi/models", Some(json!({}))).await;
        assert_eq!(st, StatusCode::OK, "{v}");
        assert_eq!(v["models"], json!([format!("model-tok-{x}")]), "default discovery reads the signed-in account: {v}");
        let (st, v) = c.json("GET", "/api/settings/providers/multi/usage", None).await;
        assert_eq!(st, StatusCode::OK, "{v}");
        assert_eq!(v["limits"][0]["limit_name"], json!(format!("tok-{x}")));
        let (st, v) = c.json("POST", "/api/settings/providers/multi/test", Some(json!({"model": "m"}))).await;
        assert_eq!((st, v["ok"].clone()), (StatusCode::OK, json!(false)), "the fixture cannot build: {v}");
        assert!(v["error"].as_str().unwrap().contains(&format!("built with tok-{x}")), "the default test builds with the signed-in account: {v}");
    }
    assert_eq!(rows("multi").len(), 2, "default requests never create or drop rows");
}
