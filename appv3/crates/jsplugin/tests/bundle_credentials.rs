//! A plugin bundle's credentials: only for the provider its default export declares.

use appv3_jsplugin::{register_native, JsError, JsPlugin, LoadOptions, Mode, Sandbox, Target, ToolCtx};
use appv3_plugins::Permissions;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

/// The cache folder the token files live under (settings are process-wide, so set once).
fn cache() -> PathBuf {
    static ROOT: OnceLock<tempfile::TempDir> = OnceLock::new();
    ROOT.get_or_init(|| {
        let d = tempfile::tempdir().unwrap();
        std::env::set_var("OPENAGENTD_CACHE_DIR", d.path().join("cache"));
        appv3_core::settings::install(appv3_core::settings::Settings::from_env());
        register_native("creds.get", Arc::new(|a: Value| Ok(json!(format!("secret-of-{}", a["provider"].as_str().unwrap_or(""))))));
        register_native("creds.oauth", Arc::new(|a: Value| Ok(json!({"provider": a["provider"], "action": a["action"]}))));
        d
    })
    .path()
    .join("cache")
}

struct Loaded {
    _dir: tempfile::TempDir,
    plugin: Arc<JsPlugin>,
}

fn load(src: &str) -> Loaded {
    cache();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("bundle");
    std::fs::create_dir_all(&root).unwrap();
    let entry = root.join("index.ts");
    std::fs::write(&entry, src).unwrap();
    let sandbox = Sandbox { plugin: "acme".into(), root, data_dir: dir.path().join("data"), permissions: Permissions::default() };
    let plugin = JsPlugin::load_with(&entry, LoadOptions { sandbox: Some(sandbox) }).unwrap();
    Loaded { _dir: dir, plugin }
}

#[allow(clippy::result_large_err)] // JsError carries name, message, stack and props
fn call(l: &Loaded, method: &str, args: &[Value]) -> Result<Value, JsError> {
    l.plugin.call_blocking(&Target::export("default.provider"), method, args, Mode::Value).map(|r| r.value)
}

fn refused(e: &JsError, permission: &str, text: &str) {
    assert_eq!(e.name, "PermissionError", "{e:?}");
    assert_eq!(e.props["permission"], permission, "{e:?}");
    assert!(e.message.starts_with("plugin acme may not "), "{}", e.message);
    assert!(e.message.contains(text), "{} (wanted {text})", e.message);
}

const PROVIDER: &str = r#"
import { credentialStore, fs } from "openagentd";

export default {
  provider: {
    id: "mine",
    label: "Mine",
    kind: "api_key",
    build() { return {}; },
    own() {
      const c = credentialStore("mine");
      const path = c.tokenPath("state.json");
      c.writeJson("state.json", { n: 1 });
      const read = c.readJson("state.json");
      const viaFs = fs.readText(path);
      c.remove("state.json");
      return { secret: c.get("api_key"), path, read, viaFs, gone: fs.exists(path), oauth: c.readOAuth() };
    },
    fromHost(c: any) { return c.get("api_key"); },
    other() { return credentialStore("other").get("api_key"); },
    otherPath() { return credentialStore("other").tokenPath("x.json"); },
    otherOAuth() { return credentialStore("other").readOAuth(); },
    file(path: string) { return fs.readText(path); },
  },
};
"#;

#[test]
fn a_bundle_uses_the_credentials_of_its_own_provider() {
    let l = load(PROVIDER);
    let own = call(&l, "own", &[]).unwrap();
    assert_eq!(own["secret"], "secret-of-mine");
    assert_eq!(own["oauth"], json!({"provider": "mine", "action": "read"}));
    let token = cache().join("provider-plugins").join("mine").join("state.json");
    assert_eq!(Path::new(own["path"].as_str().unwrap()), token);
    assert_eq!(own["read"], json!({"n": 1}));
    assert_eq!(own["viaFs"], "{\"n\": 1}");
    assert_eq!(own["gone"], false);
    // A store the host hands over works the same way.
    let store = |id: &str| json!({"$oadCredentials": {"providerId": id, "credentialId": null, "overrides": {}}});
    assert_eq!(call(&l, "fromHost", &[store("mine")]).unwrap(), "secret-of-mine");
    // The provider's token folder is readable through `fs` too; a missing file reads as null.
    assert_eq!(call(&l, "file", &[json!(token.to_str().unwrap())]).unwrap(), Value::Null);
}

#[test]
fn the_credentials_of_any_other_provider_are_refused() {
    let l = load(PROVIDER);
    let want = "may not use the credentials of provider other (only those of its own provider, mine)";
    refused(&call(&l, "other", &[]).unwrap_err(), "credentials", want);
    refused(&call(&l, "otherPath", &[]).unwrap_err(), "credentials", want);
    refused(&call(&l, "otherOAuth", &[]).unwrap_err(), "credentials", want);
    let store = json!({"$oadCredentials": {"providerId": "other", "credentialId": null, "overrides": {}}});
    refused(&call(&l, "fromHost", &[store]).unwrap_err(), "credentials", want);
    // Neither can its files be reached through `fs`.
    let theirs = cache().join("provider-plugins").join("other").join("x.json");
    refused(&call(&l, "file", &[json!(theirs.to_str().unwrap())]).unwrap_err(), "fs", "may not read ");
    let cache_root = cache().join("settings.yaml");
    refused(&call(&l, "file", &[json!(cache_root.to_str().unwrap())]).unwrap_err(), "fs", "may not read ");
}

#[tokio::test(flavor = "multi_thread")]
async fn without_a_default_export_provider_no_credentials_are_available() {
    let src = r#"
import { credentialStore, defineTool } from "openagentd";
// Only the default export counts; a v1-style named `provider` does not.
export const provider = { id: "mine", label: "Mine", kind: "api_key", build() { return {}; } };
export default { tools: [defineTool({ name: "t", description: "d", input: { type: "object" }, run() { return credentialStore("mine").get("k"); } })] };
"#;
    let l = load(src);
    let e = l.plugin.run_tool("t", json!({}), ToolCtx::default()).await.unwrap_err();
    refused(&e, "credentials", "may not use the credentials of provider mine (its default export declares no provider)");
}

#[test]
fn a_provider_id_that_is_not_a_plain_name_opens_no_folder() {
    let src = r#"
import { credentialStore, fs } from "openagentd";
export default { provider: { id: "..", label: "x", kind: "api_key", build() { return {}; },
  file(path: string) { return fs.readText(path); },
  token() { return credentialStore("..").tokenPath("x.json"); } } };
"#;
    let l = load(src);
    // `<cache>/provider-plugins/..` is the cache folder itself: it must not become readable.
    let target = cache().join("provider-plugins").join("..").join("x.json");
    refused(&call(&l, "file", &[json!(target.to_str().unwrap())]).unwrap_err(), "fs", "may not read ");
    assert!(call(&l, "token", &[]).unwrap_err().message.contains("Invalid provider token directory"));
}
