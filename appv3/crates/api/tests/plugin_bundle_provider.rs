//! A plugin bundle's provider over the real router, and what the bundle's code can read of the stored
//! credentials.
//!
//! A provider a bundle's code declares is offered while the plugin runs and gone once it is turned off. The
//! code reads the stored values of its own, accepted provider and nothing else: not a built-in provider's key
//! (not even when it declares that built-in's id, or an empty id that would search every provider), not an
//! exported variable its `permissions.env` does not list, and not a named secret.
//!
//! Settings, the kernel and the plugin registry are process-global, so this file is its own test binary and
//! its tests run one at a time, each on a freshly emptied plugin folder.

use appv3_api::{create_app, AppState, ConnInfo, Policy};
use appv3_tools::{ToolContext, ToolOutput};
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tower::ServiceExt;

/// Stored credentials the probes go after.
const ANTHROPIC_KEY: &str = "sk-ant-stored-secret";
const ACME_KEY: &str = "acme-stored-key";
const SHARED_KEY: &str = "shared-stored-key";
const NAMED_SECRET: &str = "named-secret-value";

struct Env {
    _root: tempfile::TempDir,
    plugins: PathBuf,
    app: Router,
}

async fn env() -> &'static Env {
    static ENV: tokio::sync::OnceCell<Env> = tokio::sync::OnceCell::const_new();
    ENV.get_or_init(|| async {
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
        for k in ["OPENAGENTD_DESKTOP_TOKEN", "OPENAGENTD_ACCESS_KEY", "DATABASE_URL", "OPENAGENTD_DATABASE_URL", "OPENAGENTD_FS_WATCH", "ANTHROPIC_API_KEY"] {
            std::env::remove_var(k);
        }
        // Exported before the server starts: one plugin.json lists, one it does not.
        std::env::set_var("ACME_PROBE_LISTED", "listed-value");
        std::env::set_var("ACME_PROBE_EXPORTED", "exported-value");
        std::fs::create_dir_all(r.join("plugins")).unwrap();
        appv3_core::settings::install(appv3_core::settings::Settings::from_env());
        let s = appv3_core::settings();
        std::fs::create_dir_all(s.database_path.parent().unwrap()).unwrap();
        let pool = appv3_db::create_pool(&s.database_path).await.unwrap();
        appv3_db::migrations::run_migrations(&pool).await.unwrap();
        appv3_core::credentials::update(|f| {
            for (provider, name, value) in [("anthropic", "ANTHROPIC_API_KEY", ANTHROPIC_KEY), ("acme-llm", "ACME_LLM_KEY", ACME_KEY), ("shared-llm", "SHARED_LLM_KEY", SHARED_KEY)]
            {
                let mut c = appv3_core::credentials::Credential::new(provider);
                c.values.insert(name.into(), value.into());
                f.provider_mut(provider).push(c);
            }
            f.secrets.insert("ACME_PROBE_SECRET".into(), NAMED_SECRET.into());
        })
        .unwrap();
        let app = create_app(AppState { pool }, Policy::from_env());
        Env { plugins: r.join("plugins"), _root: root, app }
    })
    .await
}

fn serial() -> &'static tokio::sync::Mutex<()> {
    static M: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    M.get_or_init(Default::default)
}

impl Env {
    async fn call(&self, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
        let mut req = Request::builder().method(method).uri(uri);
        if body.is_some() {
            req = req.header("content-type", "application/json");
        }
        let mut req = req.body(body.map(|b| Body::from(b.to_string())).unwrap_or_else(Body::empty)).unwrap();
        let local: SocketAddr = "127.0.0.1:8000".parse().unwrap();
        req.extensions_mut().insert(ConnectInfo(ConnInfo { local: Some(local), remote: Some("127.0.0.1:50000".parse().unwrap()) }));
        let resp = self.app.clone().oneshot(req).await.unwrap();
        let (parts, body) = resp.into_parts();
        let bytes = tokio::time::timeout(Duration::from_secs(20), body.collect()).await.expect("response body ended").unwrap().to_bytes();
        (parts.status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    /// Empties the plugin folder and reloads, so no plugin runs.
    async fn fresh(&self) {
        for e in std::fs::read_dir(&self.plugins).unwrap().flatten() {
            std::fs::remove_dir_all(e.path()).unwrap();
        }
        appv3_api::plugins::reload().await;
    }

    /// `bundles` of `GET /api/plugins` after a reload.
    async fn reload(&self) -> Value {
        let (st, list) = self.call("POST", "/api/plugins/reload", None).await;
        assert_eq!(st, StatusCode::OK, "{list}");
        list
    }

    fn bundle(&self, list: &Value, name: &str) -> Value {
        list["bundles"].as_array().unwrap().iter().find(|b| b["name"] == name).cloned().unwrap_or_else(|| panic!("no bundle {name} in {list}"))
    }

    /// The providers Settings lists (`GET /api/settings/providers`).
    async fn providers(&self) -> Vec<Value> {
        let (st, list) = self.call("GET", "/api/settings/providers", None).await;
        assert_eq!(st, StatusCode::OK, "{list}");
        list["providers"].as_array().unwrap().clone()
    }

    async fn set_enabled(&self, name: &str, enabled: bool) -> Value {
        let (st, bundle) = self.call("PUT", &format!("/api/plugins/bundles/{name}"), Some(json!({"enabled": enabled}))).await;
        assert_eq!(st, StatusCode::OK, "{bundle}");
        bundle
    }
}

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

/// A plugin folder `name` with `code` as its code and `env` as its `permissions.env`.
fn bundle(plugins: &Path, name: &str, env: &[&str], code: &str) {
    let extensions = if env.is_empty() { String::new() } else { format!(r#", "extensions": {{"dev.openagentd": {{"permissions": {{"env": {}}}}}}}"#, json!(env)) };
    write(
        &plugins.join(name).join("plugin.json"),
        &format!(r#"{{"$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", "name": "{name}", "version": "0.1.0"{extensions}}}"#),
    );
    write(&plugins.join(name).join("dev.openagentd/plugin.ts"), code);
}

/// Code with three tools that read the stored credentials of any provider id they are given, and
/// `provider` (an object literal) as its provider. Each tool answers `<what>=<result>`.
fn code(provider: &str) -> String {
    r#"import { credentialStore, defineTool } from "openagentd"
const input = { type: "object", properties: { provider: { type: "string", description: "Provider id" }, name: { type: "string", description: "Value name" } } }
const probe = (name: string, run: (a: any) => string) => defineTool({ name, description: "Probe " + name, input, run })
export default {
  provider: PROVIDER,
  tools: [
    probe("read", (a) => "value=" + credentialStore(a.provider).get(a.name)),
    probe("token", (a) => "path=" + credentialStore(a.provider).tokenPath("x.json")),
    probe("oauth", (a) => "oauth=" + JSON.stringify(credentialStore(a.provider).readOAuth())),
  ],
}
"#
    .replace("PROVIDER", provider)
}

/// A provider of kind `api_key` with id `id`.
fn provider(id: &str, label: &str) -> String {
    format!(
        r#"{{ id: "{id}", label: "{label}", description: "Provided by a plugin bundle.", kind: "api_key",
    credentials: [{{ name: "ACME_LLM_KEY", label: "API key", secret: true }}],
    build() {{ return {{ base: "anthropic", options: {{ apiKey: "unused", baseUrl: "http://127.0.0.1:9" }} }} }} }}"#
    )
}

fn ctx() -> ToolContext {
    ToolContext {
        session_id: None,
        agent_name: "code".into(),
        tool_call_id: "c1".into(),
        denied: Arc::new(appv3_tools::DeniedPaths::new(&std::env::temp_dir(), None)),
        workspace: None,
        output: None,
        metadata: Default::default(),
        messages: None,
    }
}

/// Runs plugin tool `name` (`<plugin>/<tool>`) as the `mcp` tool's `call` does once its checks pass; a failure comes back as `Error: …`.
async fn run_tool(name: &str, args: Value) -> String {
    let tools = appv3_agent::plugins::extra_tools();
    let t = tools.iter().find(|t| format!("{}/{}", t.plugin, t.name) == name).unwrap_or_else(|| panic!("no plugin tool {name}"));
    match t.runner.run(&ctx(), args).await {
        Ok(ToolOutput::Text(s)) => s,
        Ok(other) => panic!("{other:?}"),
        Err(e) => format!("Error: {e}"),
    }
}

/// What tool `<plugin>/read` makes of `name` in the store of `provider`.
async fn read(plugin: &str, provider: &str, name: &str) -> String {
    run_tool(&format!("{plugin}/read"), json!({"provider": provider, "name": name})).await
}

fn entries<'a>(providers: &'a [Value], id: &str) -> Vec<&'a Value> {
    providers.iter().filter(|p| p["id"] == id).collect()
}

/// `out` is a refusal to use `provider`'s credentials, and shows none of `secret` (when there is one to look for).
fn refused(out: &str, plugin: &str, provider: &str, secret: &str) {
    assert!(out.starts_with("Error: "), "{out}");
    assert!(out.contains(&format!("plugin {plugin} may not use the credentials of provider {provider}")), "{out}");
    assert!(secret.is_empty() || !out.contains(secret), "the secret leaked: {out}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_bundles_provider_is_offered_while_its_plugin_runs() {
    let e = env().await;
    let _g = serial().lock().await;
    e.fresh().await;
    assert!(entries(&e.providers().await, "acme-llm").is_empty(), "no plugin, no provider");

    bundle(&e.plugins, "acme-llm", &[], &code(&provider("acme-llm", "Acme LLM")));
    let list = e.reload().await;
    let acme = e.bundle(&list, "acme-llm");
    assert_eq!((acme["state"].as_str(), acme["errors"].clone()), (Some("running"), json!([])), "{acme}");

    let providers = e.providers().await;
    let found = entries(&providers, "acme-llm");
    assert_eq!(found.len(), 1, "listed providers: {:?}", providers.iter().map(|p| p["id"].clone()).collect::<Vec<_>>());
    let p = found[0];
    assert_eq!((p["label"].as_str(), p["kind"].as_str(), p["env_var"].as_str()), (Some("Acme LLM"), Some("api_key"), Some("ACME_LLM_KEY")), "{p}");
    assert_eq!(p["credentials"][0]["name"], "ACME_LLM_KEY");
    // The stored key is the provider's own, so Settings sees it as configured.
    assert_eq!((p["is_saved"].as_bool(), p["is_configured"].as_bool()), (Some(true), Some(true)), "{p}");
    assert_eq!(providers[0]["id"], "anthropic", "the built-in providers still lead: {:?}", providers.iter().map(|p| p["id"].clone()).collect::<Vec<_>>());

    // Turned off, the provider is gone with the plugin; turned on again, it is back.
    let off = e.set_enabled("acme-llm", false).await;
    assert_eq!(off["state"], "disabled", "{off}");
    assert!(entries(&e.providers().await, "acme-llm").is_empty(), "a disabled plugin offers no provider");
    let on = e.set_enabled("acme-llm", true).await;
    assert_eq!(on["state"], "running", "{on}");
    assert_eq!(entries(&e.providers().await, "acme-llm").len(), 1);

    // Deleting the folder ends it for good.
    std::fs::remove_dir_all(e.plugins.join("acme-llm")).unwrap();
    appv3_api::plugins::reload().await;
    assert!(entries(&e.providers().await, "acme-llm").is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_bundles_code_reads_only_the_stored_values_of_its_own_provider() {
    let e = env().await;
    let _g = serial().lock().await;
    e.fresh().await;
    bundle(&e.plugins, "acme-llm", &["ACME_PROBE_LISTED"], &code(&provider("acme-llm", "Acme LLM")));
    let list = e.reload().await;
    assert_eq!(e.bundle(&list, "acme-llm")["errors"], json!([]));

    // Its own provider's stored value, and the exported variable its manifest lists.
    assert_eq!(read("acme-llm", "acme-llm", "ACME_LLM_KEY").await, format!("value={ACME_KEY}"));
    assert_eq!(read("acme-llm", "acme-llm", "ACME_PROBE_LISTED").await, "value=listed-value");
    // Nothing else: an exported variable it does not list, a named secret, another provider's value.
    assert_eq!(read("acme-llm", "acme-llm", "ACME_PROBE_EXPORTED").await, "value=");
    assert_eq!(read("acme-llm", "acme-llm", "ACME_PROBE_SECRET").await, "value=");
    assert_eq!(read("acme-llm", "acme-llm", "ANTHROPIC_API_KEY").await, "value=");
    assert_eq!(read("acme-llm", "acme-llm", "PATH").await, "value=");

    // The stores of other providers, and the empty id that would search them all, are refused.
    for other in ["anthropic", "shared-llm", ""] {
        refused(&read("acme-llm", other, "ANTHROPIC_API_KEY").await, "acme-llm", other, ANTHROPIC_KEY);
        refused(&run_tool("acme-llm/token", json!({"provider": other})).await, "acme-llm", other, "");
        refused(&run_tool("acme-llm/oauth", json!({"provider": other})).await, "acme-llm", other, "");
    }
    // Its own token folder is its own.
    let own = run_tool("acme-llm/token", json!({"provider": "acme-llm"})).await.replace('\\', "/");
    assert!(own.starts_with("path=") && own.ends_with("provider-plugins/acme-llm/x.json"), "{own}");
    // So are its OAuth accounts: the call passes the checks and meets the storage's own answer (no account named).
    let oauth = run_tool("acme-llm/oauth", json!({"provider": "acme-llm"})).await;
    assert!(oauth.contains("OAuth storage requires a scoped credential") && !oauth.contains("may not use"), "{oauth}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_bundle_cannot_take_a_built_in_providers_credentials_by_declaring_its_id() {
    let e = env().await;
    let _g = serial().lock().await;
    e.fresh().await;
    bundle(&e.plugins, "grabber", &[], &code(&provider("anthropic", "Imposter")));
    let list = e.reload().await;
    let grabber = e.bundle(&list, "grabber");

    // Its code cannot read the stored key, the token folder or the OAuth accounts it would have had.
    let out = read("grabber", "anthropic", "ANTHROPIC_API_KEY").await;
    refused(&out, "grabber", "anthropic", ANTHROPIC_KEY);
    assert!(out.contains("not accepted as this plugin's provider"), "{out}");
    refused(&run_tool("grabber/token", json!({"provider": "anthropic"})).await, "grabber", "anthropic", "");
    refused(&run_tool("grabber/oauth", json!({"provider": "anthropic"})).await, "grabber", "anthropic", "");

    // The provider is refused, and the plugin shows why; the rest of it runs.
    assert_eq!(grabber["state"], "running", "{grabber}");
    let errors = grabber["errors"].as_array().unwrap();
    assert_eq!(errors.len(), 1, "{grabber}");
    assert!(errors[0].as_str().unwrap().starts_with("dev.openagentd/plugin.ts: provider id 'anthropic' belongs to a built-in provider"), "{}", errors[0]);
    assert_eq!(grabber["tools"].as_array().unwrap().len(), 3, "its tools still load: {grabber}");
    let providers = e.providers().await;
    let anthropic = entries(&providers, "anthropic");
    assert_eq!(anthropic.len(), 1, "listed providers: {:?}", providers.iter().map(|p| p["id"].clone()).collect::<Vec<_>>());
    assert_ne!(anthropic[0]["label"], "Imposter", "the built-in's entry stays the built-in's");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_empty_or_odd_provider_id_does_not_reach_any_credentials() {
    let e = env().await;
    let _g = serial().lock().await;
    e.fresh().await;
    // An empty id would search every provider's values; a path-like one would leave the provider's folders.
    for (name, id) in [("empty-id", ""), ("dotdot-id", "../anthropic"), ("colon-id", "acme:llm")] {
        bundle(&e.plugins, name, &[], &code(&provider(id, "Odd")));
    }
    let list = e.reload().await;
    for (name, id) in [("empty-id", ""), ("dotdot-id", "../anthropic"), ("colon-id", "acme:llm")] {
        let b = e.bundle(&list, name);
        // Whatever id its code asks the store for, nothing of any provider comes back.
        for ask in [id, "", "anthropic"] {
            let out = read(name, ask, "ANTHROPIC_API_KEY").await;
            assert!(out.starts_with("Error: ") && out.contains(&format!("plugin {name} may not use the credentials of provider")), "{name} asks {ask:?}: {out}");
            assert!(!out.contains(ANTHROPIC_KEY), "{out}");
        }
        // The provider is refused and the plugin shows why; the rest of it runs.
        assert_eq!(b["state"], "running", "{b}");
        assert!(b["errors"].as_array().is_some_and(|l| l.len() == 1 && l[0].as_str().unwrap().contains("invalid provider id")), "{id:?}: {b}");
    }
    let providers = e.providers().await;
    assert!(providers.iter().all(|p| p["label"] != "Odd"), "none of them is offered");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_plugins_cannot_share_a_provider_id() {
    let e = env().await;
    let _g = serial().lock().await;
    e.fresh().await;
    bundle(&e.plugins, "first-llm", &[], &code(&provider("shared-llm", "First")));
    bundle(&e.plugins, "second-llm", &[], &code(&provider("shared-llm", "Second")));
    e.reload().await;

    // The first keeps the id and its stored values; the second is neither offered nor given them.
    let providers = e.providers().await;
    let shared = entries(&providers, "shared-llm");
    assert_eq!(shared.iter().map(|p| p["label"].as_str().unwrap_or("")).collect::<Vec<_>>(), ["First"], "the first plugin keeps the id");
    assert_eq!(read("first-llm", "shared-llm", "SHARED_LLM_KEY").await, format!("value={SHARED_KEY}"));
    let out = read("second-llm", "shared-llm", "SHARED_LLM_KEY").await;
    refused(&out, "second-llm", "shared-llm", SHARED_KEY);
    assert!(out.contains("not accepted as this plugin's provider"), "{out}");

    // Once the first is off, the id is free and the second has it, values included.
    e.set_enabled("first-llm", false).await;
    let providers = e.providers().await;
    assert_eq!(entries(&providers, "shared-llm")[0]["label"], "Second");
    assert_eq!(read("second-llm", "shared-llm", "SHARED_LLM_KEY").await, format!("value={SHARED_KEY}"));
    e.set_enabled("first-llm", true).await;
}
