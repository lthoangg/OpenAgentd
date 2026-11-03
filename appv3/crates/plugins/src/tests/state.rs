//! `plugins.json`: `disabled` and `set_enabled`.

use std::collections::BTreeSet;

use crate::{disabled, set_enabled};

fn set(names: &[&str]) -> BTreeSet<String> {
    names.iter().map(|name| name.to_string()).collect()
}

#[test]
fn nothing_is_disabled_when_the_file_is_missing() {
    let dir = tempfile::tempdir().unwrap();
    assert!(disabled(dir.path()).is_empty());
}

#[test]
fn nothing_is_disabled_when_the_config_dir_is_missing() {
    let dir = tempfile::tempdir().unwrap();
    assert!(disabled(&dir.path().join("not-created")).is_empty());
}

#[test]
fn nothing_is_disabled_when_the_file_is_not_json() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("plugins.json"), "{ nope").unwrap();
    assert!(disabled(dir.path()).is_empty());
}

#[test]
fn nothing_is_disabled_when_the_file_has_another_shape() {
    let dir = tempfile::tempdir().unwrap();
    for text in ["[]", "\"x\"", "{}", "{\"disabled\": \"a\"}", "{\"disabled\": {\"a\": 1}}", "null"] {
        std::fs::write(dir.path().join("plugins.json"), text).unwrap();
        assert!(disabled(dir.path()).is_empty(), "{text}");
    }
}

#[test]
fn entries_that_are_not_strings_are_ignored() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("plugins.json"), "{\"disabled\": [\"a\", 5, null, \"b\", [\"c\"]]}").unwrap();
    assert_eq!(disabled(dir.path()), set(&["a", "b"]));
}

#[test]
fn disabling_a_plugin_is_read_back() {
    let dir = tempfile::tempdir().unwrap();
    set_enabled(dir.path(), "alpha", false).unwrap();
    assert_eq!(disabled(dir.path()), set(&["alpha"]));
}

#[test]
fn enabling_a_plugin_again_removes_it() {
    let dir = tempfile::tempdir().unwrap();
    set_enabled(dir.path(), "alpha", false).unwrap();
    set_enabled(dir.path(), "beta", false).unwrap();
    set_enabled(dir.path(), "alpha", true).unwrap();
    assert_eq!(disabled(dir.path()), set(&["beta"]));
}

#[test]
fn enabling_a_plugin_that_was_never_disabled_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    set_enabled(dir.path(), "alpha", false).unwrap();
    set_enabled(dir.path(), "other", true).unwrap();
    assert_eq!(disabled(dir.path()), set(&["alpha"]));
}

#[test]
fn disabling_twice_lists_the_plugin_once() {
    let dir = tempfile::tempdir().unwrap();
    set_enabled(dir.path(), "alpha", false).unwrap();
    set_enabled(dir.path(), "alpha", false).unwrap();

    let text = std::fs::read_to_string(dir.path().join("plugins.json")).unwrap();
    assert_eq!(serde_json::from_str::<serde_json::Value>(&text).unwrap(), serde_json::json!({ "disabled": ["alpha"] }));
}

#[test]
fn the_file_lists_names_sorted() {
    let dir = tempfile::tempdir().unwrap();
    for name in ["zeta", "alpha", "mid"] {
        set_enabled(dir.path(), name, false).unwrap();
    }

    let text = std::fs::read_to_string(dir.path().join("plugins.json")).unwrap();
    assert_eq!(serde_json::from_str::<serde_json::Value>(&text).unwrap(), serde_json::json!({ "disabled": ["alpha", "mid", "zeta"] }));
}

#[test]
fn an_unsorted_file_is_read_and_rewritten_sorted_and_unique() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("plugins.json"), "{\"disabled\": [\"b\", \"a\", \"b\"]}").unwrap();
    assert_eq!(disabled(dir.path()), set(&["a", "b"]));

    set_enabled(dir.path(), "c", false).unwrap();
    let text = std::fs::read_to_string(dir.path().join("plugins.json")).unwrap();
    assert_eq!(serde_json::from_str::<serde_json::Value>(&text).unwrap(), serde_json::json!({ "disabled": ["a", "b", "c"] }));
}

#[test]
fn set_enabled_creates_the_config_dir() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("a").join("b");
    set_enabled(&config, "alpha", false).unwrap();

    assert_eq!(disabled(&config), set(&["alpha"]));
}

#[test]
fn set_enabled_replaces_an_invalid_file() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("plugins.json"), "{ nope").unwrap();
    set_enabled(dir.path(), "alpha", false).unwrap();

    assert_eq!(disabled(dir.path()), set(&["alpha"]));
}

#[test]
fn set_enabled_keeps_other_keys_of_the_file() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("plugins.json"), "{\"other\": {\"x\": 1}, \"disabled\": [\"a\"]}").unwrap();
    set_enabled(dir.path(), "b", false).unwrap();

    let text = std::fs::read_to_string(dir.path().join("plugins.json")).unwrap();
    let document: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(document["other"], serde_json::json!({ "x": 1 }));
    assert_eq!(document["disabled"], serde_json::json!(["a", "b"]));
}

#[test]
fn set_enabled_leaves_no_temporary_file_behind() {
    let dir = tempfile::tempdir().unwrap();
    set_enabled(dir.path(), "alpha", false).unwrap();
    set_enabled(dir.path(), "alpha", true).unwrap();

    let files: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(files, ["plugins.json"]);
}

#[test]
fn set_enabled_rejects_an_empty_name() {
    let dir = tempfile::tempdir().unwrap();
    let error = set_enabled(dir.path(), "", false).unwrap_err();

    assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
    assert!(!dir.path().join("plugins.json").exists());
}

#[test]
fn set_enabled_reports_a_config_dir_that_cannot_be_created() {
    let dir = tempfile::tempdir().unwrap();
    let blocker = dir.path().join("file");
    std::fs::write(&blocker, "x").unwrap();

    assert!(set_enabled(&blocker.join("config"), "alpha", false).is_err());
}

#[test]
fn concurrent_writers_do_not_lose_changes() {
    let dir = tempfile::tempdir().unwrap();
    let handles: Vec<_> = (0..8)
        .map(|i| {
            let path = dir.path().to_path_buf();
            std::thread::spawn(move || set_enabled(&path, &format!("plugin-{i}"), false).unwrap())
        })
        .collect();
    for handle in handles {
        handle.join().unwrap();
    }

    assert_eq!(disabled(dir.path()).len(), 8);
}
