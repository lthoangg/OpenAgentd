//! What a plugin bundle's code reads through `credentialStore(id).get(name)`: the value stored for its own
//! provider, plus the exported environment variables its `permissions.env` lists. Not another provider's
//! values, not the named secrets (MCP client secrets), not any other exported variable, and never a search
//! over every provider. A single-file plugin's lookups, and Rust callers', stay as they were.
//!
//! Its own test binary: the settings, the natives and the credentials gate are process-wide.

use appv3_core::credentials as store;
use appv3_jsplugin::{set_credentials_gate, JsError, JsPlugin, LoadOptions, Mode, Sandbox, Target};
use appv3_providers::creds::CredentialStore;
use appv3_providers::js_plugin::JsProviderPlugin;
use appv3_providers::plugin::ProviderPlugin;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{Arc, OnceLock};

/// The bundle that reads, and the provider its code declares.
const PLUGIN: &str = "cred-probe";
const PROVIDER: &str = "probe-own";

/// Settings, natives, stored credentials and the gate: process-wide, so set up once.
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
        // Exported before the server starts: one the bundle lists in `permissions.env`, one it does not.
        std::env::set_var("PROBE_LISTED", "exported-listed");
        std::env::set_var("PROBE_UNLISTED", "exported-unlisted");
        appv3_core::settings::install(appv3_core::settings::Settings::from_env());
        appv3_providers::js_plugin::register_natives();
        store::update(|f| {
            let mut own = store::Credential::new("own");
            own.values.insert("PROBE_OWN_KEY".into(), "own-secret".into());
            f.provider_mut(PROVIDER).push(own);
            let mut other = store::Credential::new("other");
            other.values.insert("PROBE_OTHER_KEY".into(), "other-secret".into());
            f.provider_mut("other-prov").push(other);
            f.secrets.insert("PROBE_NAMED_SECRET".into(), "named-secret".into());
        })
        .unwrap();
        // The server accepts a bundle's provider for the plugin that owns it.
        set_credentials_gate(Arc::new(|plugin: &str, id: &str| plugin == PLUGIN && id == PROVIDER));
        root
    })
    .path()
}

const BUNDLE_CODE: &str = r#"
import { credentialStore, native } from "openagentd";
export default { provider: {
  id: "probe-own", label: "Probe", kind: "api_key", build() { return {}; },
  isConfigured(c: any) { return !!c.get("PROBE_OWN_KEY"); },
  get(name: string, dflt?: string) { return credentialStore("probe-own").get(name, dflt); },
  typed(name: string, value: string) { return credentialStore("probe-own", { [name]: value }).get(name); },
  from(provider: string, name: string) { return credentialStore(provider).get(name); },
  raw(arg: any) { return native("creds.get", arg); },
} };
"#;

struct Loaded {
    _dir: tempfile::TempDir,
    js: Arc<JsPlugin>,
}

/// The bundle's code, loaded in its sandbox like the server loads it, with `env` as its `permissions.env`.
fn load(env: &[&str]) -> Loaded {
    let root = setup();
    let dir = tempfile::tempdir_in(root).unwrap();
    let bundle = dir.path().join("bundle");
    std::fs::create_dir_all(&bundle).unwrap();
    let entry = bundle.join("plugin.ts");
    std::fs::write(&entry, BUNDLE_CODE).unwrap();
    let mut sandbox = Sandbox { plugin: PLUGIN.into(), root: bundle, data_dir: dir.path().join("data"), permissions: Default::default() };
    sandbox.permissions.env = env.iter().map(|n| n.to_string()).collect();
    let js = JsPlugin::load_with(&entry, LoadOptions { sandbox: Some(sandbox) }).unwrap();
    Loaded { _dir: dir, js }
}

#[allow(clippy::result_large_err)] // JsError carries name, message, stack and props
fn call(l: &Loaded, method: &str, args: &[Value]) -> Result<Value, JsError> {
    l.js.call_blocking(&Target::export("default.provider"), method, args, Mode::Value).map(|r| r.value)
}

#[test]
fn a_bundle_reads_its_own_providers_stored_values_and_the_variables_it_lists() {
    let listing = load(&["PROBE_LISTED"]);
    let get = |name: &str| call(&listing, "get", &[json!(name)]).unwrap();
    assert_eq!(get("PROBE_OWN_KEY"), "own-secret");
    assert_eq!(get("PROBE_LISTED"), "exported-listed");
    assert_eq!(get("PROBE_UNLISTED"), "", "an exported variable the bundle does not list");
    assert_eq!(get("PATH"), "", "no exported variable is readable by default");
    assert_eq!(get("PROBE_NAMED_SECRET"), "", "a named secret (an MCP client secret)");
    assert_eq!(get("PROBE_OTHER_KEY"), "", "another provider's value");
    assert_eq!(call(&listing, "get", &[json!("PROBE_UNLISTED"), json!("fallback")]).unwrap(), "fallback");
    // A value typed in (being tried before it is saved) comes first.
    assert_eq!(call(&listing, "typed", &[json!("PROBE_UNLISTED"), json!("typed")]).unwrap(), "typed");
    // Another provider's store is refused outright.
    let e = call(&listing, "from", &[json!("other-prov"), json!("PROBE_OTHER_KEY")]).unwrap_err();
    assert_eq!((e.name.as_str(), e.props["permission"].as_str()), ("PermissionError", Some("credentials")), "{e:?}");

    // Without `permissions.env` no exported variable is readable at all.
    let bare = load(&[]);
    assert_eq!(call(&bare, "get", &[json!("PROBE_LISTED")]).unwrap(), "");
    assert_eq!(call(&bare, "get", &[json!("PROBE_OWN_KEY")]).unwrap(), "own-secret");
}

#[test]
fn a_store_the_host_hands_over_is_read_the_same_way() {
    let l = load(&[]);
    let plugin = JsProviderPlugin::from_bundle(&l.js).unwrap().expect("the code exports a provider");
    let own = store::snapshot().provider(PROVIDER)[0].id.clone();
    let configured = |s: CredentialStore| plugin.is_configured(&s);
    // The credential in use, and one named account's row.
    assert_eq!(configured(CredentialStore::for_provider(PROVIDER, Default::default())), Some(true));
    assert_eq!(configured(CredentialStore::for_account(PROVIDER, &own)), Some(true));
    // A row that is gone, and a pick without the value, read empty: they never fall back to another credential.
    assert_eq!(configured(CredentialStore::for_account(PROVIDER, "gone")), Some(false));
    assert_eq!(configured(CredentialStore::for_credential(PROVIDER, Default::default())), Some(false));
    let pick = |v: &str| CredentialStore::for_credential(PROVIDER, [("PROBE_OWN_KEY".to_string(), v.to_string())].into_iter().collect());
    assert_eq!(configured(pick("a value from the pool")), Some(true));
    // Typed values count first.
    let typed = CredentialStore::for_credential(PROVIDER, Default::default()).with_overrides([("PROBE_OWN_KEY".to_string(), "typed".to_string())].into_iter().collect());
    assert_eq!(configured(typed), Some(true));
}

/// A single-file plugin (no policy, nothing tagged) reaches the native as before.
fn single_file() -> (tempfile::TempDir, Arc<JsPlugin>) {
    let dir = tempfile::tempdir_in(setup()).unwrap();
    let file = dir.path().join("probe.ts");
    std::fs::write(&file, r#"import { native } from "openagentd"; export function raw(arg: any) { return native("creds.get", arg); }"#).unwrap();
    let js = JsPlugin::load(&file).unwrap();
    (dir, js)
}

fn raw(js: &JsPlugin, arg: Value) -> Value {
    js.call_blocking(&Target::export(""), "raw", &[arg], Mode::Value).unwrap().value
}

#[test]
fn without_the_sandbox_tag_the_native_looks_up_as_it_always_did() {
    let (_dir, js) = single_file();
    let get = |provider: &str, name: &str| raw(&js, json!({"provider": provider, "name": name}));
    // No provider id: every provider is searched, then the named secrets.
    assert_eq!(get("", "PROBE_OWN_KEY"), "own-secret");
    assert_eq!(get("", "PROBE_OTHER_KEY"), "other-secret");
    assert_eq!(get("", "PROBE_NAMED_SECRET"), "named-secret");
    // With one: its credential, then the named secrets; the exported environment wins over both.
    assert_eq!(get("other-prov", "PROBE_OTHER_KEY"), "other-secret");
    assert_eq!(get("other-prov", "PROBE_OWN_KEY"), "");
    assert_eq!(get("other-prov", "PROBE_NAMED_SECRET"), "named-secret");
    assert_eq!(get(PROVIDER, "PROBE_UNLISTED"), "exported-unlisted");
    assert_eq!(get("", "PROBE_LISTED"), "exported-listed");
    // The same through the Rust store the plugins' hosts use.
    let rust = |provider: &str, name: &str| CredentialStore::for_provider(provider, Default::default()).get(name);
    assert_eq!(rust("", "PROBE_OWN_KEY"), "own-secret");
    assert_eq!(rust("", "PROBE_NAMED_SECRET"), "named-secret");
    assert_eq!(rust(PROVIDER, "PROBE_UNLISTED"), "exported-unlisted");
}

/// What the host tags a bundle's calls with is what makes the native strict. A single-file plugin can tag its
/// own call too, which is how the native is exercised here with any provider id.
#[test]
fn with_the_sandbox_tag_the_native_reads_one_providers_values_and_the_listed_variables() {
    let (_dir, js) = single_file();
    let tagged = |provider: &str, name: &str, env: &[&str]| raw(&js, json!({"provider": provider, "name": name, "$sandbox": {"env": env}}));

    // No usable provider id: nothing is searched and nothing is read, whatever is listed.
    for name in ["PROBE_OWN_KEY", "PROBE_OTHER_KEY", "PROBE_NAMED_SECRET", "PROBE_LISTED"] {
        assert_eq!(tagged("", name, &["PROBE_LISTED"]), "", "{name} with no provider id");
    }
    for id in ["../x", "a/b", ".hidden", "a b"] {
        assert_eq!(tagged(id, "PROBE_NAMED_SECRET", &["PROBE_LISTED"]), "", "{id:?}");
        assert_eq!(tagged(id, "PROBE_LISTED", &["PROBE_LISTED"]), "", "{id:?}");
    }

    // Exactly that provider's stored value: not another's, and no named secrets.
    assert_eq!(tagged("other-prov", "PROBE_OTHER_KEY", &[]), "other-secret");
    assert_eq!(tagged("other-prov", "PROBE_OWN_KEY", &[]), "", "no search over the providers");
    assert_eq!(tagged("other-prov", "PROBE_NAMED_SECRET", &[]), "", "no named secrets");
    assert_eq!(tagged(PROVIDER, "PROBE_NAMED_SECRET", &[]), "");

    // An exported variable only when it is listed, by its exact name.
    assert_eq!(tagged(PROVIDER, "PROBE_UNLISTED", &[]), "");
    assert_eq!(tagged(PROVIDER, "PROBE_UNLISTED", &["PROBE_LISTED"]), "");
    assert_eq!(tagged(PROVIDER, "PROBE_LISTED", &["PROBE_LISTED"]), "exported-listed");
    assert_eq!(tagged(PROVIDER, "PROBE_LISTED", &["PROBE_", "PROBE_*", "*", ""]), "", "no prefix or wildcard");
    if !cfg!(windows) {
        assert_eq!(tagged(PROVIDER, "PROBE_LISTED", &["probe_listed"]), "", "names are case-sensitive here");
    }

    // A tag that does not list names lists none.
    for tag in [json!(null), json!(true), json!({}), json!({"env": "PROBE_LISTED"}), json!({"env": [5, null]})] {
        let got = raw(&js, json!({"provider": PROVIDER, "name": "PROBE_LISTED", "$sandbox": tag}));
        assert_eq!(got, "", "{tag}");
    }

    // Typed values come first; a pinned credential is read instead of the one in use, and never falls back to it.
    let with = |extra: Value| {
        let mut arg = json!({"provider": PROVIDER, "name": "PROBE_OWN_KEY", "$sandbox": {"env": []}});
        arg.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        raw(&js, arg)
    };
    assert_eq!(with(json!({})), "own-secret");
    assert_eq!(with(json!({"overrides": {"PROBE_OWN_KEY": "typed"}})), "typed");
    assert_eq!(with(json!({"pinned": {"PROBE_OWN_KEY": "pinned"}})), "pinned");
    assert_eq!(with(json!({"pinned": {}})), "");
    assert_eq!(with(json!({"pinned": {"PROBE_OTHER": "x"}, "overrides": {}})), "");
}
