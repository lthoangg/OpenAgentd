//! With no credentials gate set, no plugin bundle gets credentials. This is how a program that runs no plugin
//! providers loads bundle code (the CLI's one-off code check): the code loads, and may even declare a provider,
//! but it reads nothing of any provider's credentials, OAuth documents or token folder.
//!
//! Its own test binary: the gate is process-wide, and nothing here ever sets it.

use appv3_jsplugin::{register_native, JsError, JsPlugin, LoadOptions, Mode, Sandbox, Target};
use appv3_plugins::Permissions;
use serde_json::{json, Value};
use std::sync::Arc;

const CODE: &str = r#"
import { credentialStore, fs } from "openagentd";
export default { provider: { id: "mine", label: "Mine", kind: "api_key", build() { return {}; },
  get() { return credentialStore("mine").get("api_key"); },
  oauth() { return credentialStore("mine").readOAuth(); },
  token() { return credentialStore("mine").tokenPath("state.json"); },
  load() { return credentialStore("mine").readJson("state.json"); },
  save() { credentialStore("mine").writeJson("state.json", { n: 1 }); return true; },
  file(path: string) { return fs.readText(path); },
} };
"#;

#[allow(clippy::result_large_err)] // JsError carries name, message, stack and props
fn call(p: &JsPlugin, method: &str, args: &[Value]) -> Result<Value, JsError> {
    p.call_blocking(&Target::export("default.provider"), method, args, Mode::Value).map(|r| r.value)
}

#[test]
fn without_a_gate_a_bundle_gets_no_credentials_for_any_provider() {
    let root = tempfile::tempdir().unwrap();
    std::env::set_var("OPENAGENTD_CACHE_DIR", root.path().join("cache"));
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
    // Natives that would hand out a secret if the check let a call through.
    register_native("creds.get", Arc::new(|_: Value| Ok(json!("leaked"))));
    register_native("creds.oauth", Arc::new(|_: Value| Ok(json!({"access_token": "leaked"}))));

    let bundle = root.path().join("bundle");
    std::fs::create_dir_all(&bundle).unwrap();
    let entry = bundle.join("index.ts");
    std::fs::write(&entry, CODE).unwrap();
    let sandbox = Sandbox { plugin: "acme".into(), root: bundle, data_dir: root.path().join("data"), permissions: Permissions::default() };
    let p = JsPlugin::load_with(&entry, LoadOptions { sandbox: Some(sandbox) }).unwrap();
    assert_eq!(p.describe["default"]["provider"]["id"], "mine", "the code loads and declares its provider");

    let want = "may not use the credentials of provider mine (no provider accepted";
    for method in ["get", "oauth", "token", "load", "save"] {
        let e = call(&p, method, &[]).unwrap_err();
        assert_eq!(e.name, "PermissionError", "{method}: {e:?}");
        assert_eq!(e.props["permission"], "credentials", "{method}: {e:?}");
        assert!(e.message.starts_with("plugin acme may not use the credentials of provider mine"), "{method}: {}", e.message);
        assert!(e.message.contains(want), "{method}: {} (wanted {want})", e.message);
    }
    // The provider's token folder is closed to `fs` too.
    let token_file = root.path().join("cache").join("provider-plugins").join("mine").join("state.json");
    let e = call(&p, "file", &[json!(token_file.to_str().unwrap())]).unwrap_err();
    assert_eq!((e.name.as_str(), e.props["permission"].as_str()), ("PermissionError", Some("fs")), "{e:?}");
    assert!(e.message.contains("may not read "), "{}", e.message);

    // A single-file plugin has no policy and no gate to ask: it is unchanged.
    let v1 = root.path().join("v1.ts");
    std::fs::write(&v1, r#"import { credentialStore } from "openagentd"; export function secret() { return credentialStore("mine").get("api_key"); }"#).unwrap();
    let p = JsPlugin::load(&v1).unwrap();
    assert_eq!(p.call_blocking(&Target::export(""), "secret", &[], Mode::Value).unwrap().value, json!("leaked"));
}
