//! The fixture bundles in `tests/fixtures/` are shared with other crates'
//! tests; this pins what they contain.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use appv3_plugins::{discover, load, Bundle, McpServer, Net, Permissions, Skill, Transport};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures")
}

fn load_fixture(name: &str, data_root: &Path) -> Bundle {
    load(&fixtures().join(name), data_root).unwrap_or_else(|e| panic!("fixture {name} must load: {e}"))
}

#[test]
fn changelog_tools_loads_as_an_agent_plugins_bundle() {
    let data = tempfile::tempdir().unwrap();
    let bundle = load_fixture("changelog-tools", data.path());
    let root = dunce::canonicalize(fixtures().join("changelog-tools")).unwrap();

    assert_eq!(bundle.root, root);
    assert_eq!(bundle.name, "changelog-tools");
    assert_eq!(bundle.version.as_deref(), Some("1.2.0"));
    assert_eq!(bundle.description.as_deref(), Some("Drafts release notes from a changelog."));
    assert_eq!(bundle.data_dir, data.path().join("changelog-tools"));
    assert!(bundle.warnings.is_empty(), "unexpected warnings: {:?}", bundle.warnings);
}

#[test]
fn changelog_tools_has_the_release_notes_skill() {
    let data = tempfile::tempdir().unwrap();
    let bundle = load_fixture("changelog-tools", data.path());
    let root = dunce::canonicalize(fixtures().join("changelog-tools")).unwrap();

    assert_eq!(
        bundle.skills,
        vec![Skill {
            name: "release-notes".to_string(),
            dir: root.join("skills").join("release-notes"),
            description: "Draft release notes from a changelog. Use when asked to summarize what changed between two versions.".to_string(),
        }]
    );
}

#[test]
fn changelog_tools_has_the_echo_stdio_server() {
    let data = tempfile::tempdir().unwrap();
    let bundle = load_fixture("changelog-tools", data.path());
    let root = dunce::canonicalize(fixtures().join("changelog-tools")).unwrap();

    let expected_env = BTreeMap::from([
        ("PLUGIN_ROOT".to_string(), root.to_str().unwrap().to_string()),
        ("PLUGIN_DATA".to_string(), data.path().join("changelog-tools").to_str().unwrap().to_string()),
    ]);
    assert_eq!(
        bundle.mcp_servers,
        vec![McpServer {
            name: "echo".to_string(),
            transport: Transport::Stdio { command: root.join("bin").join("echo-mcp").to_str().unwrap().to_string(), args: vec![], env: expected_env, cwd: root.clone() },
        }]
    );
}

#[test]
fn changelog_tools_has_code_and_permissions() {
    let data = tempfile::tempdir().unwrap();
    let bundle = load_fixture("changelog-tools", data.path());
    let root = dunce::canonicalize(fixtures().join("changelog-tools")).unwrap();

    assert_eq!(bundle.code, Some(root.join("dev.openagentd").join("plugin.ts")));
    assert_eq!(bundle.permissions, Permissions { net: Net::Hosts(vec!["api.github.com".to_string()]), env: vec!["GITHUB_TOKEN".to_string()], ..Permissions::default() });
}

#[cfg(unix)]
#[test]
fn changelog_tools_echo_server_is_executable_and_exits_cleanly() {
    use std::os::unix::fs::PermissionsExt;

    let script = fixtures().join("changelog-tools").join("bin").join("echo-mcp");
    let mode = std::fs::metadata(&script).unwrap().permissions().mode();
    assert_ne!(mode & 0o111, 0, "{} must keep its executable bit", script.display());
    let status = std::process::Command::new(&script).status().unwrap();
    assert!(status.success());
}

#[test]
fn review_kit_loads_as_an_agent_plugins_bundle() {
    let data = tempfile::tempdir().unwrap();
    let bundle = load_fixture("review-kit", data.path());
    let root = dunce::canonicalize(fixtures().join("review-kit")).unwrap();

    assert_eq!(bundle.root, root);
    assert_eq!(bundle.name, "review-kit");
    assert_eq!(bundle.version.as_deref(), Some("0.3.1"));
    assert_eq!(bundle.description.as_deref(), Some("Code review helpers."));
    assert_eq!(bundle.code, None);
    assert_eq!(bundle.permissions, Permissions::default());
    assert!(bundle.warnings.is_empty(), "unexpected warnings: {:?}", bundle.warnings);
}

#[test]
fn review_kit_has_the_code_review_skill() {
    let data = tempfile::tempdir().unwrap();
    let bundle = load_fixture("review-kit", data.path());
    let root = dunce::canonicalize(fixtures().join("review-kit")).unwrap();

    assert_eq!(
        bundle.skills,
        vec![Skill {
            name: "code-review".to_string(),
            dir: root.join("skills").join("code-review"),
            description: "Review a diff for bugs, risky changes, and missing tests. Use before merging a change.".to_string(),
        }]
    );
}

#[test]
fn review_kit_has_the_docs_http_server() {
    let data = tempfile::tempdir().unwrap();
    let bundle = load_fixture("review-kit", data.path());

    assert_eq!(
        bundle.mcp_servers,
        vec![McpServer { name: "docs".to_string(), transport: Transport::Http { url: "https://docs.example.com/mcp".to_string(), headers: BTreeMap::new() } }]
    );
}

#[test]
fn both_fixtures_are_found_by_discover() {
    let found = discover(&[fixtures()]);
    let names: Vec<_> = found.iter().map(|p| p.file_name().unwrap().to_str().unwrap().to_string()).collect();
    assert_eq!(names, ["changelog-tools", "review-kit"]);
}
