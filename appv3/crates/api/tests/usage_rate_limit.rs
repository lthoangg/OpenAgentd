//! Usage throttling is account-scoped and must not poison inference credentials.
use appv3_api::{create_app, AppState, ConnInfo, Policy};
use appv3_providers::creds::CredentialStore;
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::net::SocketAddr;
use tower::ServiceExt;

const PLUGIN: &str = r#"
import { HttpError } from 'openagentd';
const calls = {};
export const provider = {
  id: 'usage-test', label: 'Usage test', kind: 'oauth', description: 'fixture',
  supportsMultipleCredentials: true,
  credentials: [{name:'USAGE_FIXTURE_PIN',label:'Key',secret:true}],
  build() { throw new Error('unused'); },
  login() {},
  oauthCallback(code, emit, ctx) { ctx.credentials.writeOAuth({limited: false}); emit('success', {}); },
  isConfigured(c) { return !!c.readOAuth(); },
  discoverModels(c) { return [String(calls[c.credentialId] || 0)]; },
  getUsage(c) {
    const id = c.credentialId;
    if (!id) return {provider:'usage-test',limits:[{limit_id:'environment'}]};
    calls[id] = (calls[id] || 0) + 1;
    if (c.readOAuth().limited) throw new HttpError(429, 'private-upstream-body', {
      body: 'private-upstream-body', headers: [['Retry-After', '188'], ['Authorization', 'never-forward-this']]
    });
    return { provider: 'usage-test', limits: [{limit_id:'five_hour', primary:{used_percent:0}}] };
  },
};
"#;

async fn get(app: &axum::Router, uri: &str) -> (StatusCode, axum::http::HeaderMap, Value) {
    request(app, "GET", uri, None).await
}

async fn request(app: &axum::Router, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, axum::http::HeaderMap, Value) {
    let local: SocketAddr = "127.0.0.1:8000".parse().unwrap();
    let mut req =
        Request::builder().method(method).uri(uri).header("content-type", "application/json").body(body.map(|v| Body::from(v.to_string())).unwrap_or_else(Body::empty)).unwrap();
    req.extensions_mut().insert(ConnectInfo(ConnInfo { local: Some(local), remote: Some("127.0.0.1:50000".parse().unwrap()) }));
    let response = app.clone().oneshot(req).await.unwrap();
    let (parts, body) = response.into_parts();
    let bytes = body.collect().await.unwrap().to_bytes();
    (parts.status, parts.headers, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn rate_limits_share_one_account_gate_without_affecting_other_accounts() {
    let temp = tempfile::tempdir().unwrap();
    for name in ["config", "data", "cache", "state", "plugins", "workspace"] {
        std::fs::create_dir_all(temp.path().join(name)).unwrap();
    }
    for (key, name) in [("CONFIG", "config"), ("DATA", "data"), ("CACHE", "cache"), ("STATE", "state"), ("WORKSPACE", "workspace")] {
        std::env::set_var(format!("OPENAGENTD_{key}_DIR"), temp.path().join(name));
    }
    std::env::set_var("OPENAGENTD_PLUGINS_DIRS", temp.path().join("plugins"));
    std::env::set_var("HOME", temp.path().join("home"));
    std::env::set_var("OPENAGENTD_ENV", "production");
    std::env::set_var("OPENAGENTD_MODEL_REGISTRY_REFRESH", "false");
    for key in ["OPENAGENTD_ACCESS_KEY", "OPENAGENTD_DESKTOP_TOKEN", "DATABASE_URL", "OPENAGENTD_DATABASE_URL"] {
        std::env::remove_var(key);
    }
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
    std::fs::write(temp.path().join("plugins/usage.ts"), PLUGIN).unwrap();
    appv3_core::credentials::update(|file| {
        for (id, limited) in [("a", true), ("b", false)] {
            file.provider_mut("usage-test").push(appv3_core::credentials::Credential {
                id: id.into(),
                label: id.into(),
                oauth: Some(json!({"limited":limited})),
                ..Default::default()
            });
        }
    })
    .unwrap();
    let pool = appv3_db::create_pool(&appv3_core::settings().database_path).await.unwrap();
    appv3_db::migrations::run_migrations(&pool).await.unwrap();
    let app = create_app(AppState { pool }, Policy::from_env());
    assert!(appv3_providers::plugin::find_provider_plugin("usage-test").is_some(), "{:?}", appv3_jsplugin::problems());
    let path = "/api/settings/providers/usage-test/usage?credential_id=a";
    let (status, headers, body) = get(&app, path).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert_eq!(headers["retry-after"], "188");
    assert_eq!(body["detail"]["code"], "usage_rate_limited");
    assert!(body["detail"]["retry_at"].as_i64().is_some());
    assert!(!body.to_string().contains("private-upstream-body"));
    assert!(!body.to_string().contains("never-forward-this"));

    let (s, _, _) = get(&app, path).await;
    assert_eq!(s, StatusCode::TOO_MANY_REQUESTS);
    let plugin = appv3_providers::plugin::find_provider_plugin("usage-test").unwrap();
    assert_eq!(plugin.discover_models(&CredentialStore::for_account("usage-test", "a")).await.unwrap(), ["1"]);
    assert!(appv3_core::credentials::cooldown("usage-test", "a").is_none());

    let (s, _, body) = get(&app, "/api/settings/providers/usage-test/usage?credential_id=b").await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(body["limits"][0]["primary"]["used_percent"], 0.0);
    assert!(body["updated_at"].as_i64().is_some());
    let updated_at = body["updated_at"].clone();

    // Summary and profile reads share the resolved account, even under force refresh.
    appv3_core::credentials::set_current("usage-test", "a");
    let (_, _, summary) = get(&app, "/api/settings/providers/usage-summary?force_refresh=true").await;
    let item = summary["items"].as_array().unwrap().iter().find(|i| i["provider"] == "usage-test").unwrap();
    assert_eq!(item["status"], "rate_limited");
    // With two accounts the tray names the one whose limits it shows.
    assert_eq!(item["account"], "a");
    assert_eq!(plugin.discover_models(&CredentialStore::for_account("usage-test", "a")).await.unwrap(), ["1"]);

    // A refresh that hits a limit retains the exact timestamp of its last good reading.
    appv3_core::credentials::update(|file| file.find_mut("usage-test", "b").unwrap().oauth = Some(json!({"limited": true}))).unwrap();
    let (status, _, body) = get(&app, "/api/settings/providers/usage-test/usage?credential_id=b&force_refresh=true").await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body["detail"]["last_good"]["updated_at"], updated_at);
    assert_eq!(body["detail"]["last_good"]["stale"], true);
    appv3_core::credentials::set_current("usage-test", "b");
    let (_, _, summary) = get(&app, "/api/settings/providers/usage-summary?force_refresh=true").await;
    let item = summary["items"].as_array().unwrap().iter().find(|i| i["provider"] == "usage-test").unwrap();
    assert_eq!(item["status"], "rate_limited");
    assert_eq!(item["stale"], true);
    assert_eq!(item["usage"]["updated_at"], updated_at);
    assert_eq!(item["account"], "b");
    assert_eq!(plugin.discover_models(&CredentialStore::for_account("usage-test", "b")).await.unwrap(), ["2"]);

    // Disabling a profile prevents its fetch; toggling it back does not evade Retry-After.
    let (status, _, _) = request(&app, "PATCH", "/api/settings/providers/usage-test/credentials/a", Some(json!({"disabled":true}))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(get(&app, path).await.0, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(get(&app, &format!("{path}&api_key=ignored-candidate")).await.0, StatusCode::UNPROCESSABLE_ENTITY);
    request(&app, "PATCH", "/api/settings/providers/usage-test/credentials/a", Some(json!({"disabled":false}))).await;
    assert_eq!(get(&app, path).await.0, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(plugin.discover_models(&CredentialStore::for_account("usage-test", "a")).await.unwrap(), ["1"]);

    // A successful reconnect invalidates that identity, not other profiles' cooldown.
    let (status, _, _) = request(&app, "POST", "/api/auth/usage-test/callback", Some(json!({"code":"new-login", "credential_id":"a"}))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(get(&app, path).await.0, StatusCode::OK);
    assert_eq!(get(&app, "/api/settings/providers/usage-test/usage?credential_id=b").await.0, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(request(&app, "DELETE", "/api/settings/providers/usage-test/credentials/b", None).await.0, StatusCode::OK);
    let (status, _, body) = get(&app, "/api/settings/providers/usage-test/usage?credential_id=b").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["detail"]["code"], "usage_credentials");

    // Environment usage must not borrow the active stored profile's identity or cache.
    std::env::set_var("USAGE_FIXTURE_PIN", "fixture-only");
    let (status, _, body) = get(&app, "/api/settings/providers/usage-test/usage").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["limits"][0]["limit_id"], "environment");
    std::env::remove_var("USAGE_FIXTURE_PIN");

    // Revoked tokens must not reveal a still-cached successful reading.
    appv3_core::credentials::update(|file| file.find_mut("usage-test", "a").unwrap().oauth = None).unwrap();
    let (status, _, body) = get(&app, path).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["detail"]["code"], "usage_credentials");

    // Reject a disabled reset before any upstream mutation (the fake row has no token).
    appv3_core::credentials::update(|file| {
        file.provider_mut("codex").push(appv3_core::credentials::Credential { id: "disabled-reset".into(), disabled: true, ..Default::default() })
    })
    .unwrap();
    let (status, _, _) = request(&app, "POST", "/api/settings/providers/codex/reset?credential_id=disabled-reset", None).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}
