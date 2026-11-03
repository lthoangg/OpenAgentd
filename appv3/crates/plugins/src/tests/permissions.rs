//! `extensions["dev.openagentd"].permissions`.

use std::path::PathBuf;

use serde_json::{json, Value};

use super::{warned, Fixture};
use crate::{Bundle, Net, Permissions};

/// A bundle whose manifest carries `permissions` in the `dev.openagentd` namespace.
fn bundle_with(permissions: Value) -> Bundle {
    let fixture = Fixture::agent_plugins("demo");
    fixture.manifest("demo", json!({ "extensions": { "dev.openagentd": { "permissions": permissions } } }));
    fixture.bundle()
}

/// Same, loaded with `home` as the home folder.
fn bundle_with_home(permissions: Value, home: Option<&std::path::Path>) -> Bundle {
    let fixture = Fixture::agent_plugins("demo");
    fixture.manifest("demo", json!({ "extensions": { "dev.openagentd": { "permissions": permissions } } }));
    crate::loader::load_with(fixture.root(), fixture.data_root(), home).unwrap()
}

/// The one warning of a bundle with invalid permissions.
fn invalid_permissions_warning(bundle: &Bundle) -> &str {
    assert_eq!(bundle.warnings.len(), 1, "{:?}", bundle.warnings);
    &bundle.warnings[0]
}

#[test]
fn permissions_default_to_nothing_without_an_extensions_block() {
    assert_eq!(Fixture::agent_plugins("demo").bundle().permissions, Permissions::default());
}

#[test]
fn permissions_default_to_nothing_without_the_dev_openagentd_namespace() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.manifest("demo", json!({ "extensions": { "com.example.client": { "permissions": { "net": true } } } }));
    assert_eq!(fixture.bundle().permissions, Permissions::default());
}

#[test]
fn permissions_default_to_nothing_when_the_namespace_has_no_permissions() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.manifest("demo", json!({ "extensions": { "dev.openagentd": {} } }));
    let bundle = fixture.bundle();

    assert_eq!(bundle.permissions, Permissions::default());
    assert!(bundle.warnings.is_empty());
}

#[test]
fn net_true_allows_any_host() {
    assert_eq!(bundle_with(json!({ "net": true })).permissions.net, Net::Any);
}

#[test]
fn net_false_allows_no_host() {
    assert_eq!(bundle_with(json!({ "net": false })).permissions.net, Net::None);
}

#[test]
fn net_absent_allows_no_host() {
    assert_eq!(bundle_with(json!({ "listen": true })).permissions.net, Net::None);
}

#[test]
fn net_list_allows_those_hosts() {
    let bundle = bundle_with(json!({ "net": ["api.github.com", "example.org"] }));
    assert_eq!(bundle.permissions.net, Net::Hosts(vec!["api.github.com".to_string(), "example.org".to_string()]));
}

#[test]
fn net_hosts_are_lowercased() {
    let bundle = bundle_with(json!({ "net": ["API.GitHub.com", "*.Example.COM"] }));
    assert_eq!(bundle.permissions.net, Net::Hosts(vec!["api.github.com".to_string(), "*.example.com".to_string()]));
}

#[test]
fn net_wildcard_subdomain_host_is_accepted() {
    let bundle = bundle_with(json!({ "net": ["*.example.com"] }));
    assert_eq!(bundle.permissions.net, Net::Hosts(vec!["*.example.com".to_string()]));
    assert!(bundle.warnings.is_empty());
}

#[test]
fn net_ipv4_address_is_accepted() {
    let bundle = bundle_with(json!({ "net": ["127.0.0.1"] }));
    assert_eq!(bundle.permissions.net, Net::Hosts(vec!["127.0.0.1".to_string()]));
}

#[test]
fn net_empty_list_allows_no_host() {
    assert_eq!(bundle_with(json!({ "net": [] })).permissions.net, Net::None);
}

#[test]
fn net_repeated_host_is_listed_once() {
    let bundle = bundle_with(json!({ "net": ["a.com", "A.com", "b.com"] }));
    assert_eq!(bundle.permissions.net, Net::Hosts(vec!["a.com".to_string(), "b.com".to_string()]));
}

#[test]
fn net_host_with_a_scheme_is_invalid() {
    let bundle = bundle_with(json!({ "net": ["https://api.github.com"] }));
    assert!(invalid_permissions_warning(&bundle).contains("net[0]"));
    assert_eq!(bundle.permissions, Permissions::default());
}

#[test]
fn net_host_with_a_port_or_a_path_is_invalid() {
    for host in ["api.github.com:443", "api.github.com/v3", "*", "*.", ".example.com", "exa mple.com", "ex_ample.com"] {
        let bundle = bundle_with(json!({ "net": [host] }));
        assert_eq!(bundle.permissions, Permissions::default(), "{host}");
        assert!(warned(&bundle, "invalid permissions"), "{host}: {:?}", bundle.warnings);
    }
}

#[test]
fn net_that_is_a_string_is_invalid() {
    let bundle = bundle_with(json!({ "net": "yes" }));
    assert!(invalid_permissions_warning(&bundle).contains("net: expected true, false or an array of host names"));
}

#[test]
fn net_entry_that_is_not_a_string_is_invalid() {
    let bundle = bundle_with(json!({ "net": [5] }));
    assert!(invalid_permissions_warning(&bundle).contains("net[0]: expected a string"));
}

#[test]
fn listen_true_is_read() {
    assert!(bundle_with(json!({ "listen": true })).permissions.listen);
}

#[test]
fn listen_defaults_to_false() {
    assert!(!bundle_with(json!({ "net": true })).permissions.listen);
}

#[test]
fn listen_that_is_not_a_boolean_is_invalid() {
    let bundle = bundle_with(json!({ "listen": "yes" }));
    assert!(invalid_permissions_warning(&bundle).contains("listen: expected true or false"));
}

#[test]
fn fs_absolute_path_is_kept_when_it_does_not_exist() {
    let fixture = Fixture::empty();
    let path = fixture.real_root().join("not").join("there");
    let bundle = bundle_with(json!({ "fs": [path] }));

    assert_eq!(bundle.permissions.fs, [path]);
}

#[test]
fn fs_dot_dot_in_a_missing_path_is_resolved_textually() {
    let fixture = Fixture::empty();
    let base = fixture.real_root();
    let bundle = bundle_with(json!({ "fs": [base.join("a").join("..").join("b")] }));

    assert_eq!(bundle.permissions.fs, [base.join("b")]);
}

#[test]
fn fs_existing_path_is_canonicalised() {
    let fixture = Fixture::empty();
    let existing = fixture.root().join("sub");
    std::fs::create_dir(&existing).unwrap();
    let bundle = bundle_with(json!({ "fs": [fixture.root().join("sub").join(".")] }));

    assert_eq!(bundle.permissions.fs, [dunce::canonicalize(&existing).unwrap()]);
}

#[cfg(unix)]
#[test]
fn fs_existing_symlinked_folder_is_replaced_by_its_target() {
    let fixture = Fixture::empty();
    std::fs::create_dir(fixture.path("real")).unwrap();
    fixture.symlink(&fixture.path("real"), "link");
    let bundle = bundle_with(json!({ "fs": [fixture.root().join("link")] }));

    assert_eq!(bundle.permissions.fs, [fixture.real_root().join("real")]);
}

#[test]
fn fs_home_prefix_expands_to_the_home_folder() {
    let home = Fixture::empty();
    let bundle = bundle_with_home(json!({ "fs": ["~/notes", "~/"] }), Some(home.root()));

    // `~/notes` does not exist, so it stays as written; `~/` is the (existing) home folder.
    assert_eq!(bundle.permissions.fs, [home.root().join("notes"), home.real_root()]);
}

#[test]
fn fs_home_prefix_expands_to_the_canonical_path_when_it_exists() {
    let home = Fixture::empty();
    std::fs::create_dir(home.path("notes")).unwrap();
    let bundle = bundle_with_home(json!({ "fs": ["~/notes"] }), Some(home.root()));

    assert_eq!(bundle.permissions.fs, [dunce::canonicalize(home.path("notes")).unwrap()]);
}

#[test]
fn fs_home_prefix_without_a_home_folder_is_invalid() {
    let bundle = bundle_with_home(json!({ "fs": ["~/notes"] }), None);
    assert!(invalid_permissions_warning(&bundle).contains("no home folder is known"));
    assert_eq!(bundle.permissions, Permissions::default());
}

#[test]
fn fs_relative_path_is_invalid() {
    let bundle = bundle_with(json!({ "fs": ["data/notes"] }));
    assert!(invalid_permissions_warning(&bundle).contains("fs[0]: 'data/notes' is not an absolute path or a '~/' path"));
}

#[test]
fn fs_tilde_without_a_slash_is_invalid() {
    let bundle = bundle_with(json!({ "fs": ["~"] }));
    assert!(warned(&bundle, "fs[0]"), "{:?}", bundle.warnings);
}

#[test]
fn fs_that_is_not_an_array_is_invalid() {
    let bundle = bundle_with(json!({ "fs": "/tmp" }));
    assert!(invalid_permissions_warning(&bundle).contains("fs: expected an array of paths"));
}

#[test]
fn fs_repeated_path_is_listed_once() {
    let fixture = Fixture::empty();
    let path = fixture.real_root().join("x");
    let bundle = bundle_with(json!({ "fs": [path, path] }));

    assert_eq!(bundle.permissions.fs, [path]);
}

#[test]
fn subprocess_bare_names_are_read() {
    let bundle = bundle_with(json!({ "subprocess": ["git", "node"] }));
    assert_eq!(bundle.permissions.subprocess, ["git", "node"]);
}

#[test]
fn subprocess_name_with_a_path_separator_is_invalid() {
    for name in ["/usr/bin/git", "./git", "bin\\git"] {
        let bundle = bundle_with(json!({ "subprocess": [name] }));
        assert_eq!(bundle.permissions, Permissions::default(), "{name}");
        assert!(warned(&bundle, "subprocess[0]"), "{name}: {:?}", bundle.warnings);
    }
}

#[test]
fn subprocess_name_with_a_space_is_invalid() {
    let bundle = bundle_with(json!({ "subprocess": ["git status"] }));
    assert!(warned(&bundle, "subprocess[0]"), "{:?}", bundle.warnings);
}

#[test]
fn env_variable_names_are_read() {
    let bundle = bundle_with(json!({ "env": ["GITHUB_TOKEN", "HOME"] }));
    assert_eq!(bundle.permissions.env, ["GITHUB_TOKEN", "HOME"]);
}

#[test]
fn env_name_with_an_equals_sign_is_invalid() {
    let bundle = bundle_with(json!({ "env": ["A=B"] }));
    assert!(invalid_permissions_warning(&bundle).contains("env[0]"));
}

#[test]
fn all_permissions_can_be_combined() {
    let fixture = Fixture::empty();
    let folder = fixture.real_root().join("shared");
    let bundle = bundle_with(json!({ "net": ["api.example.com"], "listen": true, "fs": [folder], "subprocess": ["git"], "env": ["TOKEN"] }));

    assert_eq!(
        bundle.permissions,
        Permissions {
            net: Net::Hosts(vec!["api.example.com".to_string()]),
            listen: true,
            fs: vec![PathBuf::from(&folder)],
            subprocess: vec!["git".to_string()],
            env: vec!["TOKEN".to_string()]
        }
    );
    assert!(bundle.warnings.is_empty());
}

#[test]
fn invalid_permissions_warn_and_give_the_default() {
    // One bad value voids the valid ones next to it: the code gets nothing.
    let bundle = bundle_with(json!({ "net": true, "listen": true, "env": [""] }));

    let warning = invalid_permissions_warning(&bundle);
    assert!(warning.starts_with("plugin.json: invalid permissions ("), "{warning}");
    assert!(warning.ends_with("); the plugin's code gets no permissions"), "{warning}");
    assert_eq!(bundle.permissions, Permissions::default());
}

#[test]
fn permissions_that_are_not_an_object_are_invalid() {
    let bundle = bundle_with(json!(["net"]));
    assert!(invalid_permissions_warning(&bundle).contains("invalid permissions (expected an object)"));
}

#[test]
fn invalid_permissions_do_not_fail_the_load() {
    let bundle = bundle_with(json!({ "net": 3 }));
    assert_eq!(bundle.name, "demo");
}

#[test]
fn unknown_permission_warns_but_the_rest_apply() {
    let bundle = bundle_with(json!({ "net": true, "bluetooth": true }));

    assert_eq!(bundle.warnings, ["plugin.json: unknown permission 'bluetooth' ignored"]);
    assert_eq!(bundle.permissions.net, Net::Any);
}
