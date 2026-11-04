//! A plugin bundle's credentials: only for the provider its default export declares, only under a plain id, and
//! only while the host's gate accepts that provider for this plugin.
//!
//! The gate and the natives are process-wide, so this binary sets them once. The gate decides by the plugin's
//! name, and each test loads its bundle under the name that gives it the answer it needs:
//!
//! * `acme`: the owner of provider `mine`
//! * `flip`: the owner of `mine` until `FLIP` is cleared (a module that stops)
//! * `anything`: accepts every id, so only the rule about plain names can refuse one
//! * any other name: owns nothing

use appv3_jsplugin::{register_native, set_credentials_gate, JsError, JsPlugin, LoadOptions, Mode, Sandbox, Target, ToolCtx};
use appv3_plugins::Permissions;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

/// Whether the gate still accepts provider `mine` for the plugin named `flip`.
static FLIP: AtomicBool = AtomicBool::new(true);

/// The cache folder the token files live under. The settings, the natives and the gate are process-wide: set once.
fn cache() -> PathBuf {
    static ROOT: OnceLock<tempfile::TempDir> = OnceLock::new();
    ROOT.get_or_init(|| {
        let d = tempfile::tempdir().unwrap();
        std::env::set_var("OPENAGENTD_CACHE_DIR", d.path().join("cache"));
        appv3_core::settings::install(appv3_core::settings::Settings::from_env());
        register_native("creds.get", Arc::new(|a: Value| Ok(json!(format!("secret-of-{}", a["provider"].as_str().unwrap_or(""))))));
        register_native("creds.oauth", Arc::new(|a: Value| Ok(json!({"provider": a["provider"], "action": a["action"]}))));
        // Pure natives that answer with what they were called with.
        register_native("http.statusMessage", Arc::new(|a: Value| Ok(a)));
        register_native("gemini.convertTools", Arc::new(|a: Value| Ok(a)));
        set_credentials_gate(Arc::new(|plugin: &str, id: &str| match plugin {
            "acme" => id == "mine",
            "flip" => id == "mine" && FLIP.load(Ordering::SeqCst),
            "anything" => true,
            _ => false,
        }));
        d
    })
    .path()
    .join("cache")
}

struct Loaded {
    _dir: tempfile::TempDir,
    plugin: Arc<JsPlugin>,
}

/// `src` as the code of the bundle `name`.
fn load_as(name: &str, src: &str, permissions: Permissions) -> Loaded {
    cache();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("bundle");
    std::fs::create_dir_all(&root).unwrap();
    let entry = root.join("index.ts");
    std::fs::write(&entry, src).unwrap();
    let sandbox = Sandbox { plugin: name.into(), root, data_dir: dir.path().join("data"), permissions };
    let plugin = JsPlugin::load_with(&entry, LoadOptions { sandbox: Some(sandbox) }).unwrap();
    Loaded { _dir: dir, plugin }
}

fn load(src: &str) -> Loaded {
    load_as("acme", src, Permissions::default())
}

#[allow(clippy::result_large_err)] // JsError carries name, message, stack and props
fn call(l: &Loaded, method: &str, args: &[Value]) -> Result<Value, JsError> {
    l.plugin.call_blocking(&Target::export("default.provider"), method, args, Mode::Value).map(|r| r.value)
}

/// `e` is `plugin`'s refusal of `permission`, and its message has `text`.
fn refused_for(plugin: &str, e: &JsError, permission: &str, text: &str) {
    assert_eq!(e.name, "PermissionError", "{e:?}");
    assert_eq!(e.props["permission"], permission, "{e:?}");
    assert!(e.message.starts_with(&format!("plugin {plugin} may not ")), "{}", e.message);
    assert!(e.message.contains(text), "{} (wanted {text})", e.message);
}

fn refused(e: &JsError, permission: &str, text: &str) {
    refused_for("acme", e, permission, text)
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
    refused(&call(&l, "token", &[]).unwrap_err(), "credentials", "its id is not a plain name");
}

/// A bundle whose provider has id `id` and which uses that provider's credentials every way there is.
fn provider_with_id(id: &str) -> String {
    let id = serde_json::to_string(id).unwrap();
    format!(
        r#"
import {{ credentialStore, fs }} from "openagentd";
export default {{ provider: {{ id: {id}, label: "x", kind: "api_key", build() {{ return {{}}; }},
  get() {{ return credentialStore({id}).get("api_key"); }},
  oauth() {{ return credentialStore({id}).readOAuth(); }},
  path() {{ return credentialStore({id}).tokenPath("x.json"); }},
  load() {{ return credentialStore({id}).readJson("x.json"); }},
  save() {{ credentialStore({id}).writeJson("x.json", {{ n: 1 }}); return true; }},
  fromHost(c: any) {{ return c.get("api_key"); }},
  file(path: string) {{ return fs.readText(path); }},
}} }};
"#
    )
}

/// The empty id makes a lookup search every provider, and `..` or `a/b` lead out of the provider's own
/// folder: the gate is not asked about them, whatever it would say.
#[test]
fn an_id_that_is_not_a_plain_name_gets_nothing_even_if_the_gate_accepts_it() {
    let too_long = "a".repeat(65);
    for id in ["", ".", "..", "../x", "a/b", "a\\b", ".hidden", "mine.", "a b", "a:b", "é", too_long.as_str()] {
        let l = load_as("anything", &provider_with_id(id), Permissions::default());
        for method in ["get", "oauth", "path", "load", "save"] {
            let e = call(&l, method, &[]).unwrap_err();
            refused_for("anything", &e, "credentials", "its id is not a plain name");
        }
    }
    // Plain ids go through, up to 64 characters.
    let longest = "a".repeat(64);
    for id in ["a", "Acme-LLM_2.v1", longest.as_str()] {
        let l = load_as("anything", &provider_with_id(id), Permissions::default());
        assert_eq!(call(&l, "get", &[]).unwrap(), json!(format!("secret-of-{id}")), "{id}");
        assert_eq!(call(&l, "oauth", &[]).unwrap(), json!({"provider": id, "action": "read"}), "{id}");
        let path = call(&l, "path", &[]).unwrap();
        assert_eq!(Path::new(path.as_str().unwrap()), cache().join("provider-plugins").join(id).join("x.json"), "{id}");
    }
}

/// What a provider the host has not accepted may do with the credentials of its own id: nothing.
#[test]
fn a_provider_the_host_has_not_accepted_gets_no_credentials_and_no_token_folder() {
    let l = load_as("rejected", &provider_with_id("mine"), Permissions::default());
    let why = "may not use the credentials of provider mine (it is not accepted as this plugin's provider";
    for method in ["get", "oauth", "path", "load", "save"] {
        refused_for("rejected", &call(&l, method, &[]).unwrap_err(), "credentials", why);
    }
    let store = json!({"$oadCredentials": {"providerId": "mine", "credentialId": null, "overrides": {}}});
    refused_for("rejected", &call(&l, "fromHost", &[store]).unwrap_err(), "credentials", why);
    // Its token folder stays closed to `fs` as well.
    let own_folder = cache().join("provider-plugins").join("mine").join("x.json");
    refused_for("rejected", &call(&l, "file", &[json!(own_folder.to_str().unwrap())]).unwrap_err(), "fs", "may not read ");
}

/// A module that stops loses its access at once, and the access comes back when the gate accepts it again.
#[test]
fn access_follows_the_gate_at_call_time() {
    let src = r#"
import { credentialStore, fs } from "openagentd";
export default { provider: { id: "mine", label: "Mine", kind: "api_key", build() { return {}; },
  token() { return credentialStore("mine").tokenPath("flip.json"); },
  save(n: number) { credentialStore("mine").writeJson("flip.json", { n }); return true; },
  load() { return credentialStore("mine").readJson("flip.json"); },
  secret() { return credentialStore("mine").get("api_key"); },
  oauth() { return credentialStore("mine").readOAuth(); },
  file(path: string) { return fs.readText(path); },
  write(path: string) { fs.writeText(path, "x"); return true; },
} };
"#;
    let l = load_as("flip", src, Permissions::default());
    let flip = |on: bool| FLIP.store(on, Ordering::SeqCst);
    let denied = |method: &str, args: &[Value], permission: &str, text: &str| refused_for("flip", &call(&l, method, args).unwrap_err(), permission, text);
    let why = "it is not accepted as this plugin's provider";

    flip(true);
    let path = call(&l, "token", &[]).unwrap();
    let path = path.as_str().unwrap().to_string();
    assert_eq!(call(&l, "save", &[json!(1)]).unwrap(), json!(true));
    assert_eq!(call(&l, "load", &[]).unwrap(), json!({"n": 1}));
    assert_eq!(call(&l, "file", &[json!(path)]).unwrap(), json!("{\"n\": 1}"));
    assert_eq!(call(&l, "secret", &[]).unwrap(), json!("secret-of-mine"));

    flip(false);
    for method in ["token", "load", "secret", "oauth"] {
        denied(method, &[], "credentials", why);
    }
    denied("save", &[json!(2)], "credentials", why);
    // The folder it got to know while it was accepted is closed too.
    denied("file", &[json!(path)], "fs", "may not read ");
    denied("write", &[json!(path)], "fs", "may not write ");

    flip(true);
    assert_eq!(call(&l, "load", &[]).unwrap(), json!({"n": 1}), "nothing was written while it was refused");
    assert_eq!(call(&l, "secret", &[]).unwrap(), json!("secret-of-mine"));
}

const ECHO: &str = r#"
import { native } from "openagentd";
export default { provider: { id: "mine", label: "Mine", kind: "api_key", build() { return {}; },
  echo(arg: any) { return native("http.statusMessage", arg); },
  list(arg: any) { return native("gemini.convertTools", arg); },
} };
"#;

/// A native another crate registered learns that a bundle called it, and which environment variables the
/// bundle may read: the host writes that, whatever the code put there.
#[test]
fn natives_called_by_a_bundle_learn_which_environment_variables_it_may_read() {
    let perms = Permissions { env: vec!["API_KEY_A".into(), "API_KEY_B".into()], ..Default::default() };
    let l = load_as("acme", ECHO, perms);
    let listed = json!({"env": ["API_KEY_A", "API_KEY_B"]});
    assert_eq!(call(&l, "echo", &[json!({"status": 404})]).unwrap(), json!({"status": 404, "$sandbox": listed}));
    // Whatever the code puts there is replaced.
    for forged in [json!({"env": ["PATH", "HOME"]}), json!(null), json!("all"), json!({"env": "*"}), json!([]), json!({})] {
        let got = call(&l, "echo", &[json!({"$sandbox": forged})]).unwrap();
        assert_eq!(got, json!({"$sandbox": listed}), "{forged}");
    }
    // An argument that is not an object is passed as it is.
    assert_eq!(call(&l, "list", &[json!([1, 2])]).unwrap(), json!([1, 2]));
    assert_eq!(call(&l, "list", &[json!(null)]).unwrap(), json!(null));
    assert_eq!(call(&l, "echo", &[json!("text")]).unwrap(), json!("text"));
    // Without a permission the list is empty.
    let none = load(ECHO);
    assert_eq!(call(&none, "echo", &[json!({})]).unwrap(), json!({"$sandbox": {"env": []}}));
}

/// A single-file plugin is not a bundle: it is not tagged, and its credentials work as they always did.
#[test]
fn a_single_file_plugin_is_not_tagged_and_keeps_its_credentials() {
    cache();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("v1.ts");
    std::fs::write(
        &file,
        r#"
import { credentialStore, native } from "openagentd";
export function echo(arg: any) { return native("http.statusMessage", arg); }
export function secret() { return credentialStore("never-accepted").get("k"); }
"#,
    )
    .unwrap();
    let p = JsPlugin::load(&file).unwrap();
    let run = |method: &str, args: &[Value]| p.call_blocking(&Target::export(""), method, args, Mode::Value).unwrap().value;
    assert_eq!(run("echo", &[json!({"x": 1})]), json!({"x": 1}));
    assert_eq!(run("echo", &[json!({"$sandbox": {"env": ["X"]}})]), json!({"$sandbox": {"env": ["X"]}}));
    assert_eq!(run("secret", &[]), json!("secret-of-never-accepted"));
}
