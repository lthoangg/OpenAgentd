use appv3_jsplugin::{JsPlugin, Mode, Target};
use serde_json::json;

#[test]
fn account_caches_are_isolated_and_reject_path_components() {
    let root = tempfile::tempdir().unwrap();
    std::env::set_var("OPENAGENTD_CACHE_DIR", root.path().join("cache"));
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
    let path = root.path().join("cache.ts");
    std::fs::write(
        &path,
        r#"
export function cache(c, file, value) {
  if (value !== null) c.writeJson(file, { value });
  return { path: c.tokenPath(file), data: c.readJson(file) };
}
export function remove(c, file) { c.remove(file); return c.readJson(file); }
"#,
    )
    .unwrap();
    let plugin = JsPlugin::load(&path).unwrap();
    let store = |id: Option<&str>| json!({"$oadCredentials": {"providerId": "demo", "credentialId": id}});
    let a = plugin.call_blocking(&Target::export(""), "cache", &[store(Some("account-a")), json!("pending.json"), json!("a")], Mode::Value).unwrap().value;
    let b = plugin.call_blocking(&Target::export(""), "cache", &[store(Some("account-b")), json!("pending.json"), json!("b")], Mode::Value).unwrap().value;
    assert_ne!(a["path"], b["path"]);
    let a = plugin.call_blocking(&Target::export(""), "cache", &[store(Some("account-a")), json!("pending.json"), json!(null)], Mode::Value).unwrap().value;
    assert_eq!(a["data"]["value"], "a");
    let legacy = plugin.call_blocking(&Target::export(""), "cache", &[store(None), json!("pending.json"), json!("legacy")], Mode::Value).unwrap().value;
    assert_eq!(legacy["path"], root.path().join("cache/provider-plugins/demo/pending.json").to_string_lossy().as_ref());
    for file in ["..", ".", "../token.json", "..\\token.json", "/tmp/token.json", "C:\\token.json"] {
        assert!(plugin.call_blocking(&Target::export(""), "cache", &[store(Some("account-a")), json!(file), json!(null)], Mode::Value).is_err(), "accepted {file:?}");
    }
    assert!(plugin.call_blocking(&Target::export(""), "cache", &[store(Some("../escape")), json!("pending.json"), json!(null)], Mode::Value).is_err());
    let removed = plugin.call_blocking(&Target::export(""), "remove", &[store(Some("account-a")), json!("pending.json")], Mode::Value).unwrap().value;
    assert_eq!(removed, json!({}));
    let b = plugin.call_blocking(&Target::export(""), "cache", &[store(Some("account-b")), json!("pending.json"), json!(null)], Mode::Value).unwrap().value;
    assert_eq!(b["data"]["value"], "b");
}
