//! `plugin.json`: what loads, what only warns, and what rejects the plugin.

use serde_json::json;

use super::{warned, Fixture};
use crate::{Permissions, PLUGIN_SCHEMA};

/// The error of a plugin whose manifest has the given `name`.
fn rejection_for_name(name: &str) -> String {
    Fixture::agent_plugins(name).load().expect_err("the name must be rejected")
}

#[test]
fn minimal_manifest_loads() {
    let bundle = Fixture::agent_plugins("minimal-plugin").bundle();

    assert_eq!(bundle.name, "minimal-plugin");
    assert_eq!(bundle.version, None);
    assert_eq!(bundle.description, None);
    assert!(bundle.skills.is_empty());
    assert!(bundle.mcp_servers.is_empty());
    assert_eq!(bundle.code, None);
    assert_eq!(bundle.permissions, Permissions::default());
    assert!(bundle.warnings.is_empty(), "{:?}", bundle.warnings);
}

#[test]
fn full_manifest_loads_without_warnings() {
    let fixture = Fixture::agent_plugins("x");
    fixture.write_json(
        "plugin.json",
        &json!({
            "$schema": PLUGIN_SCHEMA,
            "name": "plugin-name",
            "version": "1.2.0",
            "description": "Brief plugin description",
            "author": { "name": "Author Name", "email": "author@example.com", "url": "https://example.com" },
            "homepage": "https://docs.example.com/plugin",
            "repository": "https://github.com/example/plugin",
            "license": "MIT",
            "keywords": ["keyword1", "keyword2"],
            "extensions": { "com.example.client": { "setting": true } }
        }),
    );
    let bundle = fixture.bundle();

    assert_eq!(bundle.name, "plugin-name");
    assert_eq!(bundle.version.as_deref(), Some("1.2.0"));
    assert_eq!(bundle.description.as_deref(), Some("Brief plugin description"));
    assert!(bundle.warnings.is_empty(), "{:?}", bundle.warnings);
}

#[test]
fn bundle_root_is_the_canonical_folder() {
    let fixture = Fixture::agent_plugins("demo");
    assert_eq!(fixture.bundle().root, fixture.real_root());
}

#[test]
fn data_dir_is_the_data_root_plus_the_sanitised_name() {
    let fixture = Fixture::agent_plugins("acme.tools");
    assert_eq!(fixture.bundle().data_dir, fixture.data_root().join("acme-tools"));
}

#[test]
fn loading_does_not_create_the_data_dir() {
    let fixture = Fixture::agent_plugins("demo");
    let bundle = fixture.bundle();
    assert!(!bundle.data_dir.exists());
}

/// Every path under `root` with its length and modification time.
fn snapshot(root: &std::path::Path) -> Vec<(std::path::PathBuf, u64, Option<std::time::SystemTime>)> {
    let mut found = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir).unwrap().flatten() {
            let metadata = std::fs::symlink_metadata(entry.path()).unwrap();
            found.push((entry.path(), metadata.len(), metadata.modified().ok()));
            if metadata.is_dir() {
                pending.push(entry.path());
            }
        }
    }
    found.sort();
    found
}

#[test]
fn loading_leaves_the_plugin_folder_and_the_data_root_untouched() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.skill("notes", "Take notes.").script("bin/tool").write("dev.openagentd/plugin.ts", "export default {}");
    fixture.mcp(json!({ "s": { "type": "stdio", "command": "./bin/tool", "cwd": "${PLUGIN_DATA}/run" } }));
    let before = (snapshot(fixture.root()), snapshot(fixture.data_root()));
    fixture.bundle();

    assert_eq!((snapshot(fixture.root()), snapshot(fixture.data_root())), before);
}

#[test]
fn manifest_with_a_utf8_bom_loads() {
    let fixture = Fixture::empty();
    fixture.write("plugin.json", &format!("\u{feff}{{\"$schema\": \"{PLUGIN_SCHEMA}\", \"name\": \"demo\"}}"));
    assert_eq!(fixture.bundle().name, "demo");
}

#[test]
fn unknown_top_level_field_warns_and_the_plugin_still_loads() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.manifest("demo", json!({ "commands": "./commands" }));
    let bundle = fixture.bundle();

    assert_eq!(bundle.warnings, ["plugin.json: unknown field 'commands' ignored"]);
}

#[test]
fn every_unknown_top_level_field_gets_its_own_warning() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.manifest("demo", json!({ "hooks": {}, "main": "x.js" }));
    let bundle = fixture.bundle();

    assert_eq!(bundle.warnings, ["plugin.json: unknown field 'hooks' ignored", "plugin.json: unknown field 'main' ignored"]);
}

#[test]
fn missing_schema_is_rejected() {
    let fixture = Fixture::empty();
    fixture.write_json("plugin.json", &json!({ "name": "demo" }));
    let error = fixture.load().unwrap_err();

    assert_eq!(error, "unsupported Agent Plugins version: missing required field '$schema'");
}

#[test]
fn other_schema_version_is_rejected_as_unsupported() {
    let fixture = Fixture::empty();
    let other = "https://agent-plugins.org/schemas/2.0.0/plugin.schema.json";
    fixture.write_json("plugin.json", &json!({ "$schema": other, "name": "demo" }));

    assert_eq!(fixture.load().unwrap_err(), format!("unsupported Agent Plugins version: {other}"));
}

#[test]
fn schema_that_is_not_a_string_is_rejected_as_unsupported() {
    let fixture = Fixture::empty();
    fixture.write_json("plugin.json", &json!({ "$schema": 1, "name": "demo" }));

    assert_eq!(fixture.load().unwrap_err(), "unsupported Agent Plugins version: 1");
}

#[test]
fn missing_name_is_rejected() {
    let fixture = Fixture::empty();
    fixture.write_json("plugin.json", &json!({ "$schema": PLUGIN_SCHEMA }));
    let error = fixture.load().unwrap_err();

    assert!(error.contains("'name'"), "{error}");
}

#[test]
fn name_that_is_not_a_string_is_rejected() {
    let fixture = Fixture::empty();
    fixture.write_json("plugin.json", &json!({ "$schema": PLUGIN_SCHEMA, "name": 7 }));
    let error = fixture.load().unwrap_err();

    assert!(error.contains("'name' must be a string"), "{error}");
}

#[test]
fn name_with_an_uppercase_letter_is_rejected() {
    let error = rejection_for_name("My-Plugin");
    assert!(error.contains("'name'") && error.contains("a-z"), "{error}");
}

#[test]
fn name_starting_with_a_hyphen_is_rejected() {
    let error = rejection_for_name("-start");
    assert!(error.contains("'name'") && error.contains("start and end"), "{error}");
}

#[test]
fn name_ending_with_a_dot_is_rejected() {
    let error = rejection_for_name("end.");
    assert!(error.contains("'name'") && error.contains("start and end"), "{error}");
}

#[test]
fn name_with_a_double_hyphen_is_rejected() {
    let error = rejection_for_name("has--double");
    assert!(error.contains("'name'") && error.contains("'--'"), "{error}");
}

#[test]
fn name_with_a_double_dot_is_rejected() {
    let error = rejection_for_name("too.many..dots");
    assert!(error.contains("'name'") && error.contains("'..'"), "{error}");
}

#[test]
fn empty_name_is_rejected() {
    let error = rejection_for_name("");
    assert!(error.contains("'name'") && error.contains("1 to 64"), "{error}");
}

#[test]
fn name_with_an_underscore_or_a_space_is_rejected() {
    assert!(rejection_for_name("has_underscore").contains("'name'"));
    assert!(rejection_for_name("has space").contains("'name'"));
}

#[test]
fn name_of_65_characters_is_rejected() {
    let error = rejection_for_name(&"a".repeat(65));
    assert!(error.contains("'name'") && error.contains("1 to 64"), "{error}");
}

#[test]
fn name_of_64_characters_is_accepted() {
    let name = "a".repeat(64);
    assert_eq!(Fixture::agent_plugins(&name).bundle().name, name);
}

#[test]
fn names_with_hyphens_dots_and_digits_are_accepted() {
    for name in ["my-plugin", "acme.tools", "lint3r", "a", "3d", "a-b.c-d"] {
        assert_eq!(Fixture::agent_plugins(name).bundle().name, name);
    }
}

#[test]
fn author_with_an_extra_field_is_rejected() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.manifest("demo", json!({ "author": { "name": "A", "twitter": "@a" } }));
    let error = fixture.load().unwrap_err();

    assert!(error.contains("'author'") && error.contains("'twitter'"), "{error}");
}

#[test]
fn author_field_that_is_not_a_string_is_rejected() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.manifest("demo", json!({ "author": { "name": 5 } }));
    let error = fixture.load().unwrap_err();

    assert!(error.contains("'author.name' must be a string"), "{error}");
}

#[test]
fn author_that_is_not_an_object_is_rejected() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.manifest("demo", json!({ "author": "Someone" }));
    let error = fixture.load().unwrap_err();

    assert!(error.contains("'author' must be an object"), "{error}");
}

#[test]
fn author_with_only_some_fields_is_accepted() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.manifest("demo", json!({ "author": { "email": "a@example.com" } }));
    assert!(fixture.bundle().warnings.is_empty());
}

#[test]
fn a_wrong_type_in_a_permitted_field_is_rejected() {
    let wrong = [("version", json!(1)), ("description", json!([])), ("homepage", json!(true)), ("repository", json!({})), ("license", json!(null))];
    for (field, value) in wrong {
        let fixture = Fixture::agent_plugins("demo");
        fixture.manifest("demo", json!({ field: value }));
        let error = fixture.load().unwrap_err();
        assert!(error.contains(&format!("'{field}' must be a string")), "{field}: {error}");
    }
}

#[test]
fn keywords_that_are_not_all_strings_are_rejected() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.manifest("demo", json!({ "keywords": ["fine", 2] }));
    let error = fixture.load().unwrap_err();

    assert!(error.contains("'keywords' must be an array of strings"), "{error}");
}

#[test]
fn version_urls_and_emails_are_not_validated() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.manifest("demo", json!({ "version": "banana", "homepage": "not a url", "author": { "email": "nope" }, "license": "Proprietary" }));
    let bundle = fixture.bundle();

    assert_eq!(bundle.version.as_deref(), Some("banana"));
    assert!(bundle.warnings.is_empty(), "{:?}", bundle.warnings);
}

#[test]
fn manifest_that_is_not_a_json_object_is_rejected() {
    let fixture = Fixture::empty();
    fixture.write("plugin.json", "[]");
    let error = fixture.load().unwrap_err();

    assert!(error.contains("must be a JSON object"), "{error}");
}

#[test]
fn manifest_with_invalid_json_is_rejected() {
    let fixture = Fixture::empty();
    fixture.write("plugin.json", "{ not json");
    let error = fixture.load().unwrap_err();

    assert!(error.starts_with("plugin.json: is not valid JSON"), "{error}");
}

#[test]
fn manifest_larger_than_one_mebibyte_is_rejected() {
    let fixture = Fixture::empty();
    fixture.write("plugin.json", &format!("{{\"$schema\": \"{PLUGIN_SCHEMA}\", \"name\": \"demo\"}}{}", " ".repeat(1024 * 1024 + 1)));
    let error = fixture.load().unwrap_err();

    assert!(error.contains("larger than"), "{error}");
}

#[test]
fn non_object_extensions_warns_and_the_plugin_still_loads() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.manifest("demo", json!({ "extensions": "nope" }));
    let bundle = fixture.bundle();

    assert_eq!(bundle.warnings, ["plugin.json: 'extensions' is not an object; ignored"]);
    assert_eq!(bundle.permissions, Permissions::default());
}

#[test]
fn other_extension_namespaces_are_ignored_without_validation() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.manifest("demo", json!({ "extensions": { "com.example.client": "not even an object", "org.other": [1, 2, 3] } }));
    assert!(fixture.bundle().warnings.is_empty());
}

#[test]
fn own_extension_namespace_that_is_not_an_object_warns() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.manifest("demo", json!({ "extensions": { "dev.openagentd": true } }));
    let bundle = fixture.bundle();

    assert!(warned(&bundle, "extensions[\"dev.openagentd\"] is not an object"), "{:?}", bundle.warnings);
}

#[test]
fn folder_without_a_manifest_is_rejected() {
    let fixture = Fixture::empty();
    let error = fixture.load().unwrap_err();

    assert_eq!(error, "no plugin.json found");
}

#[test]
fn missing_folder_is_rejected() {
    let fixture = Fixture::empty();
    let error = crate::load(&fixture.path("nope"), fixture.data_root()).unwrap_err();

    assert!(error.contains("cannot open plugin folder"), "{error}");
}

#[test]
fn a_file_is_not_a_plugin_folder() {
    let fixture = Fixture::empty();
    fixture.write("file.txt", "x");
    let error = crate::load(&fixture.path("file.txt"), fixture.data_root()).unwrap_err();

    assert!(error.contains("is not a folder"), "{error}");
}

#[test]
fn manifest_that_is_a_directory_is_rejected() {
    let fixture = Fixture::empty();
    std::fs::create_dir(fixture.path("plugin.json")).unwrap();
    let error = fixture.load().unwrap_err();

    assert!(error.contains("plugin.json: not a regular file"), "{error}");
}

#[test]
fn invalid_manifest_rejects_the_plugin_even_when_components_are_fine() {
    let fixture = Fixture::agent_plugins("Bad Name");
    fixture.skill("fine", "A fine skill.");
    assert!(fixture.load().is_err());
}

#[cfg(unix)]
#[test]
fn manifest_symlinked_outside_the_root_is_rejected() {
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("plugin.json"), format!("{{\"$schema\": \"{PLUGIN_SCHEMA}\", \"name\": \"evil\"}}")).unwrap();
    let fixture = Fixture::empty();
    fixture.symlink(&outside.path().join("plugin.json"), "plugin.json");
    let error = fixture.load().unwrap_err();

    assert_eq!(error, "plugin.json: resolves outside the plugin folder");
}

#[cfg(unix)]
#[test]
fn manifest_that_is_a_dangling_symlink_is_reported_as_not_existing() {
    let fixture = Fixture::empty();
    fixture.symlink(&fixture.path("nowhere.json"), "plugin.json");

    assert_eq!(fixture.load().unwrap_err(), "plugin.json: does not exist");
}

#[cfg(unix)]
#[test]
fn manifest_symlinked_inside_the_root_is_accepted() {
    let fixture = Fixture::empty();
    fixture.write_json("real/manifest.json", &json!({ "$schema": PLUGIN_SCHEMA, "name": "linked" }));
    fixture.symlink(&fixture.path("real/manifest.json"), "plugin.json");

    assert_eq!(fixture.bundle().name, "linked");
}
