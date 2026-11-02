//! A plugin's `getUsage()` failing with HTTP 429 reaches Rust as a typed
//! `RateLimited` carrying only the validated `Retry-After` wait; every other
//! failure keeps its previous mapping.

use appv3_providers::creds::CredentialStore;
use appv3_providers::js_plugin::JsProviderPlugin;
use appv3_providers::plugin::{PluginUsageError, ProviderPlugin};

const PLUGIN: &str = r#"
import { HttpError, ValueError, AuthError } from "openagentd";
const LEAK = "sk-ant-LEAKED-token";
export const provider = {
  id: "limited", label: "Limited", kind: "api_key",
  credentials: [{ name: "MODE", label: "Mode", secret: false }],
  build() { return { base: "anthropic", options: { apiKey: "unused" } }; },
  getUsage(c) {
    const mode = c.get("MODE");
    const sensitive = [["set-cookie", "session=" + LEAK], ["authorization", "Bearer " + LEAK], ["x-request-id", LEAK]];
    const limited = (headers) => new HttpError(429, "Too Many Requests " + LEAK, { body: '{"error":"' + LEAK + '"}', headers });
    switch (mode) {
      case "seconds": throw limited([["Retry-After", "188"], ...sensitive]);
      case "object": throw limited({ "retry-after": "42", "set-cookie": LEAK });
      case "date": throw limited([["retry-after", new Date(Date.now() + 120_000).toUTCString()]]);
      case "longest": throw limited([["retry-after", "10"], ["Retry-After", "300"]]);
      case "none": throw limited(sensitive);
      case "bare": throw new HttpError(429, "Too Many Requests " + LEAK);
      case "negative": throw limited([["retry-after", "-5"]]);
      case "overflow": throw limited([["retry-after", "99999999999999999999999"]]);
      case "garbage": throw limited([["retry-after", "NaN"]]);
      case "http500": throw new HttpError(500, "upstream exploded", { headers: [["retry-after", "30"]] });
      case "http503": throw new HttpError(503, "busy", { headers: [["retry-after", "30"]] });
      case "auth": throw new AuthError("sign in again " + LEAK);
      case "http401": throw new HttpError(401, "Unauthorized " + LEAK, { body: LEAK, headers: [["retry-after", "30"], ["set-cookie", LEAK]] });
      case "http403": throw new HttpError(403, "Forbidden " + LEAK, { body: LEAK });
      case "invalid": throw new ValueError("bad credentials");
      case "plain": throw new Error("boom");
      default: return { provider: "limited", limits: [] };
    }
  },
};
"#;

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
    std::env::set_var("OPENAGENTD_PLUGINS_DIRS", root.join("plugins"));
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
    appv3_providers::js_plugin::register_natives();
}

async fn usage(plugin: &JsProviderPlugin, mode: &str) -> Result<serde_json::Value, PluginUsageError> {
    plugin.get_usage(&CredentialStore::for_credential("limited", [("MODE".to_string(), mode.to_string())].into_iter().collect())).await
}

fn rate_limited(retry_after: Option<u64>) -> Result<serde_json::Value, PluginUsageError> {
    Err(PluginUsageError::RateLimited { retry_after })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn plugin_429_becomes_a_typed_rate_limit_without_forwarding_upstream_text() {
    let root = tempfile::tempdir().unwrap();
    setup(root.path());
    let path = root.path().join("limited.ts");
    std::fs::write(&path, PLUGIN).unwrap();
    let plugin = JsProviderPlugin::from_plugin(&appv3_jsplugin::JsPlugin::load(&path).unwrap()).unwrap();

    assert_eq!(usage(&plugin, "ok").await.unwrap()["provider"], "limited");
    assert_eq!(usage(&plugin, "seconds").await, rate_limited(Some(188)));
    assert_eq!(usage(&plugin, "object").await, rate_limited(Some(42)), "headers given as an object");
    assert_eq!(usage(&plugin, "longest").await, rate_limited(Some(300)), "the wait is never shortened");
    let Err(PluginUsageError::RateLimited { retry_after: Some(date) }) = usage(&plugin, "date").await else { panic!("an HTTP-date wait is honored") };
    assert!((118..=121).contains(&date), "{date}");

    // No usable wait is still a rate limit, never a generic failure.
    for mode in ["none", "bare", "negative", "overflow", "garbage"] {
        let got = usage(&plugin, mode).await;
        assert_eq!(got, rate_limited(None), "{mode}");
        let shown = format!("{got:?}");
        assert!(!shown.contains("LEAKED") && !shown.contains("Too Many"), "{mode}: {shown}");
    }
    let shown = format!("{:?}", usage(&plugin, "seconds").await);
    assert!(!shown.contains("LEAKED") && !shown.contains("session") && !shown.contains("Bearer"), "{shown}");

    // Everything else keeps its previous behavior, Retry-After or not.
    assert_eq!(usage(&plugin, "http500").await, Err(PluginUsageError::Other("upstream exploded".into())));
    assert_eq!(usage(&plugin, "http503").await, Err(PluginUsageError::Other("busy".into())));
    assert_eq!(usage(&plugin, "invalid").await, Err(PluginUsageError::Value("bad credentials".into())));
    assert_eq!(usage(&plugin, "plain").await, Err(PluginUsageError::Other("boom".into())));

    // Rejected credentials are a credential problem (Reconnect), never a rate limit
    // or a generic outage, and the upstream text is not forwarded.
    for mode in ["auth", "http401", "http403"] {
        let got = usage(&plugin, mode).await;
        assert_eq!(got, Err(PluginUsageError::Value("Provider credentials were rejected.".into())), "{mode}");
        assert!(!format!("{got:?}").contains("LEAKED"), "{mode}");
    }
}
