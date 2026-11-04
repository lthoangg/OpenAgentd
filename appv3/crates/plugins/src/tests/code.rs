//! `dev.openagentd/plugin.ts` and `plugin.js`.

use super::Fixture;

#[test]
fn plugin_ts_is_the_code() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.write("dev.openagentd/plugin.ts", "export default {}");

    assert_eq!(fixture.bundle().code, Some(fixture.real_root().join("dev.openagentd").join("plugin.ts")));
}

#[test]
fn plugin_js_is_the_code_when_there_is_no_ts() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.write("dev.openagentd/plugin.js", "export default {}");

    assert_eq!(fixture.bundle().code, Some(fixture.real_root().join("dev.openagentd").join("plugin.js")));
}

#[test]
fn plugin_ts_wins_over_plugin_js() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.write("dev.openagentd/plugin.js", "export default {}");
    fixture.write("dev.openagentd/plugin.ts", "export default {}");
    let bundle = fixture.bundle();

    assert_eq!(bundle.code, Some(fixture.real_root().join("dev.openagentd").join("plugin.ts")));
    assert!(bundle.warnings.is_empty());
}

#[test]
fn no_code_without_the_namespace_folder() {
    let bundle = Fixture::agent_plugins("demo").bundle();

    assert_eq!(bundle.code, None);
    assert!(bundle.warnings.is_empty());
}

#[test]
fn other_files_in_the_namespace_folder_are_not_the_code() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.write("dev.openagentd/helper.ts", "export const x = 1");
    fixture.write("dev.openagentd/plugin.mjs", "export default {}");

    assert_eq!(fixture.bundle().code, None);
}

#[test]
fn plugin_ts_at_the_root_is_not_the_code() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.write("plugin.ts", "export default {}");

    assert_eq!(fixture.bundle().code, None);
}

#[test]
fn plugin_ts_that_is_a_folder_is_ignored_with_a_warning() {
    let fixture = Fixture::agent_plugins("demo");
    std::fs::create_dir_all(fixture.path("dev.openagentd/plugin.ts")).unwrap();
    let bundle = fixture.bundle();

    assert_eq!(bundle.code, None);
    assert_eq!(bundle.warnings, ["dev.openagentd/plugin.ts: not a regular file; ignored"]);
}

#[cfg(unix)]
#[test]
fn plugin_ts_symlinked_outside_the_root_is_ignored_with_a_warning() {
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("evil.ts"), "export default {}").unwrap();
    let fixture = Fixture::agent_plugins("demo");
    fixture.symlink(&outside.path().join("evil.ts"), "dev.openagentd/plugin.ts");
    let bundle = fixture.bundle();

    assert_eq!(bundle.code, None);
    assert_eq!(bundle.warnings, ["dev.openagentd/plugin.ts: resolves outside the plugin folder; ignored"]);
}

#[cfg(unix)]
#[test]
fn namespace_folder_symlinked_outside_the_root_gives_no_code() {
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("plugin.js"), "export default {}").unwrap();
    let fixture = Fixture::agent_plugins("demo");
    fixture.symlink(outside.path(), "dev.openagentd");
    let bundle = fixture.bundle();

    assert_eq!(bundle.code, None);
    assert_eq!(bundle.warnings, ["dev.openagentd/plugin.js: resolves outside the plugin folder; ignored"]);
}

#[cfg(unix)]
#[test]
fn plugin_js_inside_the_root_is_used_when_plugin_ts_escapes() {
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("evil.ts"), "export default {}").unwrap();
    let fixture = Fixture::agent_plugins("demo");
    fixture.symlink(&outside.path().join("evil.ts"), "dev.openagentd/plugin.ts");
    fixture.write("dev.openagentd/plugin.js", "export default {}");
    let bundle = fixture.bundle();

    assert_eq!(bundle.code, Some(fixture.real_root().join("dev.openagentd").join("plugin.js")));
    assert_eq!(bundle.warnings.len(), 1);
}

#[cfg(unix)]
#[test]
fn plugin_ts_symlinked_inside_the_root_resolves_to_its_target() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.write("src/main.ts", "export default {}");
    fixture.symlink(&fixture.path("src/main.ts"), "dev.openagentd/plugin.ts");

    assert_eq!(fixture.bundle().code, Some(fixture.real_root().join("src").join("main.ts")));
}
