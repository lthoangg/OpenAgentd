//! A plugin bundle's `provider` works as a provider plugin while its module
//! runs, and is gone once the module stops. This is its own test binary: the
//! kernel, the settings and the model registry are process-wide.

use appv3_jsplugin::{JsPlugin, LoadOptions, Sandbox};
use appv3_kernel::{Module, Registrar};
use appv3_providers::catalog;
use appv3_providers::creds::CredentialStore;
use appv3_providers::js_plugin::JsProviderPlugin;
use appv3_providers::plugin::{bundle_provider_owner, find_provider_plugin, provider_plugins, BuildContext, BundleProvider, PluginInfo, PluginRef, ProviderPlugin};
use appv3_providers::{LlmProvider, ProviderError, ProviderResult};
use std::path::Path;
use std::sync::{Arc, OnceLock};

/// A single-file provider plugin: bundles' providers come after it.
const SINGLE_FILE: &str = r#"
export const provider = { id: "single-file-test", label: "Single File", kind: "api_key", build() { return { base: "anthropic", options: { apiKey: "k" } }; } };
"#;

/// The code of a plugin bundle that provides a provider (a v2 module).
const BUNDLE_CODE: &str = r#"
export default {
  provider: {
    id: "bundle-test",
    label: "Bundle Test",
    description: "Provided by a plugin bundle.",
    kind: "api_key",
    credentials: [{ name: "BUNDLE_TEST_KEY", label: "API key", secret: true }],
    build(ctx: any) {
      return { base: "anthropic", options: { apiKey: ctx.credentials.get("BUNDLE_TEST_KEY") || "unset", baseUrl: "http://127.0.0.1:9" } };
    },
    isConfigured(c: any) { return c.get("BUNDLE_TEST_KEY") === "yes"; },
    discoverModels() { return ["bundle-model-1", "bundle-model-2"]; },
  },
};
"#;

/// The root of everything this binary writes. The settings are process-wide,
/// so they are installed once, before anything reads them.
fn setup() -> &'static Path {
    static ROOT: OnceLock<tempfile::TempDir> = OnceLock::new();
    ROOT.get_or_init(|| {
        let root = tempfile::tempdir().unwrap();
        for (key, dir) in [
            ("OPENAGENTD_CONFIG_DIR", "config"),
            ("OPENAGENTD_CACHE_DIR", "cache"),
            ("OPENAGENTD_DATA_DIR", "data"),
            ("OPENAGENTD_STATE_DIR", "state"),
            ("OPENAGENTD_WORKSPACE_DIR", "workspace"),
        ] {
            std::env::set_var(key, root.path().join(dir));
        }
        std::env::set_var("OPENAGENTD_PLUGINS_DIRS", root.path().join("plugins"));
        appv3_core::settings::install(appv3_core::settings::Settings::from_env());
        std::fs::create_dir_all(root.path().join("plugins")).unwrap();
        std::fs::write(root.path().join("plugins").join("single.ts"), SINGLE_FILE).unwrap();
        // A model the registry knows, for a bundle's alias to point at.
        std::fs::create_dir_all(root.path().join("config")).unwrap();
        std::fs::write(root.path().join("config").join("model_registry.yaml"), "\"openai:base-model\":\n  limits:\n    context_length: 1234\n").unwrap();
        // The server's rule for a bundle's credentials: its provider is accepted, and its module runs.
        appv3_jsplugin::set_credentials_gate(Arc::new(|plugin: &str, id: &str| bundle_provider_owner(id).is_some_and(|module| &*module == format!("plugin:{plugin}").as_str())));
        root
    })
    .path()
}

/// The kernel is global: one test at a time changes what it runs.
static GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// A bundle's code, loaded in its sandbox like the server loads it.
fn load(name: &str, code: &str) -> Arc<JsPlugin> {
    let root = setup().join("bundles").join(name);
    let file = root.join("dev.openagentd").join("plugin.ts");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, code).unwrap();
    let sandbox = Sandbox { plugin: name.into(), root, data_dir: setup().join("plugin-data").join(name), permissions: Default::default() };
    JsPlugin::load_with(&file, LoadOptions { sandbox: Some(sandbox) }).unwrap()
}

/// What a bundle's module does for providers: hands the kernel its provider
/// each time it starts.
struct Bundle {
    id: String,
    provider: PluginRef,
}

#[async_trait::async_trait]
impl Module for Bundle {
    fn id(&self) -> &str {
        &self.id
    }
    fn register(&self, r: &mut Registrar) -> anyhow::Result<()> {
        r.add(BundleProvider(self.provider.clone()));
        Ok(())
    }
}

/// Starts a module that provides `provider`.
async fn run(id: &str, provider: PluginRef) {
    let k = appv3_kernel::global();
    k.add(Bundle { id: id.into(), provider }).unwrap();
    k.start(id).await.unwrap();
}

/// A provider plugin that is not JavaScript: only its identity matters.
struct Stub(PluginInfo);

#[async_trait::async_trait]
impl ProviderPlugin for Stub {
    fn info(&self) -> &PluginInfo {
        &self.0
    }
    fn build(&self, _: BuildContext) -> ProviderResult<Arc<dyn LlmProvider>> {
        Err(ProviderError::Other("a stub builds nothing".into()))
    }
}

fn stub(id: &str, label: &str) -> PluginRef {
    Arc::new(Stub(PluginInfo { id: id.into(), label: label.into(), kind: "api_key".into(), ..Default::default() }))
}

fn plugin_ids() -> Vec<String> {
    provider_plugins().iter().map(|p| p.info().id.clone()).collect()
}

/// Labels of the provider plugins that have id `id`.
fn plugin_labels(id: &str) -> Vec<String> {
    provider_plugins().iter().filter(|p| p.info().id == id).map(|p| p.info().label.clone()).collect()
}

fn catalog_ids() -> Vec<String> {
    catalog::all_providers().iter().filter_map(|e| e["id"].as_str().map(String::from)).collect()
}

fn store(value: &str) -> CredentialStore {
    CredentialStore::for_credential("bundle-test", [("BUNDLE_TEST_KEY".to_string(), value.to_string())].into_iter().collect())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bundles_provider_comes_and_goes_with_its_module() {
    setup();
    let _gate = GATE.lock().await;
    let k = appv3_kernel::global();
    let js = load("bundle-test", BUNDLE_CODE);
    let plugin: PluginRef = Arc::new(JsProviderPlugin::from_bundle(&js).unwrap().expect("the code exports a provider"));
    assert_eq!(plugin.info().id, "bundle-test");

    // Its module is not running: nothing offers it.
    assert!(!plugin_ids().contains(&"bundle-test".to_string()));
    assert!(find_provider_plugin("bundle-test").is_none());
    assert!(!catalog_ids().contains(&"bundle-test".to_string()));
    assert!(catalog::find("bundle-test").is_none());

    run("plugin:bundle-test", plugin.clone()).await;

    // The plugin list: single files first, then the bundle's provider.
    let ids = plugin_ids();
    let at = |id: &str| ids.iter().position(|i| i == id).unwrap_or_else(|| panic!("{id} is not listed: {ids:?}"));
    assert!(at("single-file-test") < at("bundle-test"), "{ids:?}");
    let found = find_provider_plugin("bundle-test").expect("found while its module runs");
    assert_eq!(found.info().label, "Bundle Test");
    assert_eq!(found.source(), Some(js.path.as_path()));

    // The catalog: builtins first, the bundle's entry after the single files.
    let all = catalog::all_providers();
    let builtins = catalog::builtin_providers();
    assert!(all.len() > builtins.len() && all.iter().zip(builtins).all(|(a, b)| a == b), "the builtins lead, unchanged");
    let entry = all.iter().find(|e| e["id"] == "bundle-test").expect("in the catalog").clone();
    assert_eq!((entry["label"].as_str(), entry["kind"].as_str(), entry["env_var"].as_str()), (Some("Bundle Test"), Some("api_key"), Some("BUNDLE_TEST_KEY")));
    assert_eq!(entry["credentials"][0]["name"], "BUNDLE_TEST_KEY");
    let order = catalog_ids();
    assert!(order.iter().position(|i| i == "single-file-test") < order.iter().position(|i| i == "bundle-test"), "{order:?}");
    assert_eq!(catalog::find("bundle-test"), Some(entry));

    // Calls reach the bundle's code: sync and async, through its provider object.
    assert_eq!(found.is_configured(&store("yes")), Some(true));
    assert_eq!(found.is_configured(&store("no")), Some(false));
    assert!(found.has_discover_models());
    assert_eq!(found.discover_models(&store("yes")).await.unwrap(), ["bundle-model-1", "bundle-model-2"]);
    let ctx = BuildContext { provider_id: "bundle-test".into(), model: "bundle-model-1".into(), model_kwargs: Default::default(), credentials: store("yes") };
    let instance = found.build(ctx).unwrap_or_else(|e| panic!("build failed: {e}"));
    assert_eq!((instance.model(), instance.provider_name()), ("bundle-model-1", Some("bundle-test")));
    drop(instance);

    // Stopping the module takes it away from all three.
    k.stop("plugin:bundle-test").await;
    assert!(!plugin_ids().contains(&"bundle-test".to_string()));
    assert!(find_provider_plugin("bundle-test").is_none());
    assert!(!catalog_ids().contains(&"bundle-test".to_string()));
    assert!(catalog::find("bundle-test").is_none());
    // And the credentials with it: the code of a plugin that is not running reads none.
    assert_eq!(found.is_configured(&store("yes")), Some(false));

    // Starting it again brings it back; removing it ends it for good.
    k.start("plugin:bundle-test").await.unwrap();
    assert!(find_provider_plugin("bundle-test").is_some() && catalog::find("bundle-test").is_some());
    k.remove("plugin:bundle-test").await;
    assert!(find_provider_plugin("bundle-test").is_none() && catalog::find("bundle-test").is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_provider_id_that_is_taken_is_skipped_until_it_is_free() {
    setup();
    let _gate = GATE.lock().await;
    let k = appv3_kernel::global();
    run("plugin:dup-a", stub("dup-test", "First")).await;
    run("plugin:dup-b", stub("dup-test", "Second")).await;
    // The id of a single-file plugin and the id of a built-in provider are taken too.
    run("plugin:dup-c", stub("single-file-test", "From a bundle")).await;
    run("plugin:dup-d", stub("openai", "From a bundle")).await;

    assert_eq!(plugin_labels("dup-test"), ["First"], "the first bundle keeps the id");
    assert_eq!(plugin_labels("single-file-test"), ["Single File"]);
    assert!(plugin_labels("openai").is_empty());
    let all = catalog::all_providers();
    for id in ["dup-test", "single-file-test", "openai"] {
        assert_eq!(all.iter().filter(|e| e["id"] == id).count(), 1, "{id} is listed once");
    }
    assert_eq!(catalog::find("dup-test").unwrap()["label"], "First");
    assert_ne!(catalog::find("openai").unwrap()["label"], "From a bundle", "a built-in's entry stays the built-in's");
    assert!(find_provider_plugin("openai").is_none());

    // When the first one stops, the id is free for the next.
    k.stop("plugin:dup-a").await;
    assert_eq!(plugin_labels("dup-test"), ["Second"]);
    assert_eq!(catalog::find("dup-test").unwrap()["label"], "Second");
    assert_eq!(find_provider_plugin("dup-test").unwrap().info().label, "Second");

    for id in ["plugin:dup-a", "plugin:dup-b", "plugin:dup-c", "plugin:dup-d"] {
        k.remove(id).await;
    }
    assert!(plugin_labels("dup-test").is_empty() && catalog::find("dup-test").is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_model_registry_follows_the_aliases_of_a_running_bundle() {
    setup();
    let _gate = GATE.lock().await;
    let limit = || appv3_providers::registry::get_model_limits(Some("alias-test:alias-model")).context_length;
    assert_eq!(limit(), None, "no bundle, no alias");

    let info = PluginInfo {
        id: "alias-test".into(),
        label: "Alias".into(),
        kind: "api_key".into(),
        model_registry_aliases: vec![("alias-model".into(), "openai:base-model".into())],
        ..Default::default()
    };
    run("plugin:alias-test", Arc::new(Stub(info))).await;
    assert_eq!(limit(), Some(1234), "the alias applies once the bundle runs");

    appv3_kernel::global().stop("plugin:alias-test").await;
    assert_eq!(limit(), None, "and is gone with it");
    appv3_kernel::global().remove("plugin:alias-test").await;
}

/// The credentials gate asks who owns a provider id: the module whose provider is *accepted*, and nobody
/// for a built-in provider, a single file's id, or a provider that was skipped.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_provider_belongs_to_the_module_that_has_it_accepted() {
    setup();
    let _gate = GATE.lock().await;
    let k = appv3_kernel::global();
    let owner = |id: &str| bundle_provider_owner(id).map(|m| m.to_string());
    assert_eq!(owner("owner-test"), None, "no module offers it yet");

    run("plugin:owner-a", stub("owner-test", "First")).await;
    run("plugin:owner-b", stub("owner-test", "Second")).await;
    run("plugin:owner-c", stub("openai", "From a bundle")).await;
    run("plugin:owner-d", stub("single-file-test", "From a bundle")).await;

    assert_eq!(owner("owner-test").as_deref(), Some("plugin:owner-a"), "the first module that has the id keeps it");
    assert_eq!(plugin_labels("owner-test"), ["First"], "the owner is the provider the lists show");
    for taken in ["openai", "single-file-test"] {
        assert_eq!(owner(taken), None, "{taken} is not a bundle's");
    }
    // A built-in provider no bundle declares, an id nobody has, and the empty id have no owner either.
    for id in ["anthropic", "codex", "nobody-has-this", ""] {
        assert_eq!(owner(id), None, "{id:?}");
    }

    // The owner follows the modules: when the first stops, the id is free for the next.
    k.stop("plugin:owner-a").await;
    assert_eq!(owner("owner-test").as_deref(), Some("plugin:owner-b"));
    k.stop("plugin:owner-b").await;
    assert_eq!(owner("owner-test"), None, "no module is running with it");
    k.start("plugin:owner-a").await.unwrap();
    assert_eq!(owner("owner-test").as_deref(), Some("plugin:owner-a"));

    for id in ["plugin:owner-a", "plugin:owner-b", "plugin:owner-c", "plugin:owner-d"] {
        k.remove(id).await;
    }
    assert_eq!(owner("owner-test"), None);
}

/// Ids that differ in ASCII case only are one id: `provider-plugins/<id>` is the same folder for both on a
/// case-insensitive file system, so a twin of a taken id is no more accepted than the same id.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ids_that_differ_only_in_case_are_one_id() {
    setup();
    let _gate = GATE.lock().await;
    let k = appv3_kernel::global();
    let owner = |id: &str| bundle_provider_owner(id).map(|m| m.to_string());
    run("plugin:case-a", stub("Case-Test", "First")).await;
    run("plugin:case-b", stub("case-test", "Twin")).await;
    run("plugin:case-c", stub("OpenAI", "Twin of a built-in")).await;
    run("plugin:case-d", stub("Single-File-Test", "Twin of a single file")).await;

    assert_eq!(plugin_labels("Case-Test"), ["First"]);
    for twin in ["case-test", "OpenAI", "Single-File-Test"] {
        assert!(plugin_labels(twin).is_empty(), "{twin} is skipped");
        assert_eq!(owner(twin), None, "{twin} has no owner");
    }
    assert_eq!(owner("Case-Test").as_deref(), Some("plugin:case-a"));

    // When the first stops, the twin may have the id, spelled as it spells it.
    k.stop("plugin:case-a").await;
    assert_eq!(owner("case-test").as_deref(), Some("plugin:case-b"));
    assert_eq!(owner("Case-Test"), None);
    for id in ["plugin:case-a", "plugin:case-b", "plugin:case-c", "plugin:case-d"] {
        k.remove(id).await;
    }
}

#[test]
fn a_module_without_a_provider_has_none() {
    setup();
    let tools_only = load("tools-only", r#"export default { tools: [{ name: "hello", description: "Say hello.", input: { type: "object" }, run() { return "hi"; } }] };"#);
    assert!(JsProviderPlugin::from_bundle(&tools_only).unwrap().is_none());
    let no_default = load("no-default", "export const answer = 42;");
    assert!(JsProviderPlugin::from_bundle(&no_default).unwrap().is_none());
    // A single file's named `provider` export is not a bundle's provider.
    let named = load("named-export", r#"export const provider = { id: "named", label: "Named", kind: "api_key", build() { return {}; } };"#);
    assert!(JsProviderPlugin::from_bundle(&named).unwrap().is_none());
}

#[test]
fn an_invalid_provider_is_refused_with_the_reason_and_nothing_is_recorded() {
    setup();
    let ok = r#"kind: "api_key", build() { return {}; }"#;
    let cases: Vec<(String, &str)> = vec![
        ("provider: 5".into(), "provider must be an object, got number"),
        ("provider: null".into(), "provider must be an object, got null"),
        (format!(r#"provider: {{ id: "", label: "L", {ok} }}"#), "invalid provider id ''"),
        (format!(r#"provider: {{ id: "a:b", label: "L", {ok} }}"#), "invalid provider id 'a:b'"),
        // A provider that could use no credentials is no provider: the id must be a plain name.
        (format!(r#"provider: {{ id: "../openai", label: "L", {ok} }}"#), "invalid provider id '../openai': use 1 to 64 letters"),
        (format!(r#"provider: {{ id: "a/b", label: "L", {ok} }}"#), "invalid provider id 'a/b'"),
        (format!(r#"provider: {{ id: "a b", label: "L", {ok} }}"#), "invalid provider id 'a b'"),
        (format!(r#"provider: {{ id: ".hidden", label: "L", {ok} }}"#), "invalid provider id '.hidden'"),
        (format!(r#"provider: {{ id: "acme.", label: "L", {ok} }}"#), "invalid provider id 'acme.'"),
        (format!(r#"provider: {{ id: "{}", label: "L", {ok} }}"#, "a".repeat(65)), "invalid provider id 'aaaa"),
        (r#"provider: { id: "no-build", label: "L", kind: "api_key" }"#.into(), "provider plugin 'no-build' must define build"),
        (r#"provider: { id: "no-login", label: "L", kind: "oauth", build() { return {}; } }"#.into(), "oauth provider plugin 'no-login' must define login"),
        (format!(r#"provider: {{ id: "openai", label: "L", {ok} }}"#), "provider id 'openai' belongs to a built-in provider"),
        (format!(r#"provider: {{ id: "OpenAI", label: "L", {ok} }}"#), "provider id 'OpenAI' belongs to a built-in provider"),
    ];
    for (i, (provider, want)) in cases.iter().enumerate() {
        let js = load(&format!("invalid-{i}"), &format!("export default {{ {provider} }};"));
        let err = match JsProviderPlugin::from_bundle(&js) {
            Err(e) => e,
            Ok(_) => panic!("accepted: {provider}"),
        };
        assert!(err.contains(want), "{provider}\n  got: {err}\n  want: {want}");
        assert!(!appv3_jsplugin::problems().iter().any(|(p, _)| *p == js.path), "{provider}: a bundle shows its own problem, nothing is recorded");
    }
}

/// A single file's validation is unchanged: it still logs and records its problem.
#[test]
fn a_single_file_provider_is_still_checked_as_before() {
    setup();
    let dir = setup().join("v1");
    std::fs::create_dir_all(&dir).unwrap();
    let bad = dir.join("bad.ts");
    std::fs::write(&bad, r#"export const provider = { id: "a:b", label: "L", kind: "api_key", build() { return {}; } };"#).unwrap();
    let js = JsPlugin::load(&bad).unwrap();
    assert!(JsProviderPlugin::from_plugin(&js).is_none());
    let problems: Vec<String> = appv3_jsplugin::problems().into_iter().filter(|(p, _)| *p == bad).map(|(_, m)| m).collect();
    assert_eq!(problems.len(), 1, "{problems:?}");
    assert!(problems[0].starts_with("invalid provider plugin id in ") && problems[0].ends_with(": 'a:b'"), "{}", problems[0]);
}
