//! The bundle fingerprint: what changes it and what does not.

use std::time::{Duration, SystemTime};

use serde_json::json;

use super::Fixture;

/// Sets a file's modification time `ahead` into the future, leaving its content alone.
fn touch(fixture: &Fixture, relative: &str, ahead: Duration) {
    let file = std::fs::OpenOptions::new().write(true).open(fixture.path(relative)).unwrap();
    file.set_modified(SystemTime::now() + ahead).unwrap();
}

/// A bundle with a skill, MCP file, and code, so every kind of input exists.
fn full_bundle() -> Fixture {
    let fixture = Fixture::agent_plugins("demo");
    fixture.skill("notes", "Take notes.");
    fixture.mcp(json!({ "s": { "type": "stdio", "command": "npx" } }));
    fixture.write("dev.openagentd/plugin.ts", "export default {}");
    fixture
}

#[test]
fn fingerprint_is_the_same_for_an_unchanged_bundle() {
    let fixture = full_bundle();
    assert_eq!(fixture.bundle().fingerprint, fixture.bundle().fingerprint);
}

#[test]
fn fingerprint_differs_between_different_bundles() {
    // Different lengths, so the result does not depend on the clock's resolution.
    assert_ne!(Fixture::agent_plugins("one").bundle().fingerprint, Fixture::agent_plugins("a-much-longer-name").bundle().fingerprint);
}

#[test]
fn fingerprint_changes_after_editing_a_skill_md() {
    let fixture = full_bundle();
    let before = fixture.bundle().fingerprint;
    fixture.skill("notes", "Take better notes, with more words.");

    assert_ne!(fixture.bundle().fingerprint, before);
}

#[test]
fn fingerprint_changes_when_only_a_modification_time_changes() {
    let fixture = full_bundle();
    let before = fixture.bundle().fingerprint;
    touch(&fixture, "skills/notes/SKILL.md", Duration::from_secs(3600));

    assert_ne!(fixture.bundle().fingerprint, before);
}

#[test]
fn fingerprint_changes_after_editing_the_manifest() {
    let fixture = full_bundle();
    let before = fixture.bundle().fingerprint;
    fixture.manifest("demo", json!({ "version": "2.0.0" }));

    assert_ne!(fixture.bundle().fingerprint, before);
}

#[test]
fn fingerprint_changes_after_editing_mcp_json() {
    let fixture = full_bundle();
    let before = fixture.bundle().fingerprint;
    fixture.mcp(json!({ "s": { "type": "stdio", "command": "node" } }));

    assert_ne!(fixture.bundle().fingerprint, before);
}

#[test]
fn fingerprint_changes_after_editing_the_code() {
    let fixture = full_bundle();
    let before = fixture.bundle().fingerprint;
    fixture.write("dev.openagentd/plugin.ts", "export default { changed: true }");

    assert_ne!(fixture.bundle().fingerprint, before);
}

#[test]
fn fingerprint_changes_after_adding_a_file_deep_in_the_code_folder() {
    let fixture = full_bundle();
    let before = fixture.bundle().fingerprint;
    fixture.write("dev.openagentd/lib/deep/util.ts", "export const x = 1");

    assert_ne!(fixture.bundle().fingerprint, before);
}

#[test]
fn fingerprint_changes_when_a_skill_is_added() {
    let fixture = full_bundle();
    let before = fixture.bundle().fingerprint;
    fixture.skill("more", "Another skill.");

    assert_ne!(fixture.bundle().fingerprint, before);
}

#[test]
fn fingerprint_changes_when_a_skipped_skill_is_fixed() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.write("skills/broken/SKILL.md", "no frontmatter");
    let before = fixture.bundle().fingerprint;
    fixture.skill("broken", "Now it has a description.");

    assert_ne!(fixture.bundle().fingerprint, before);
}

#[test]
fn fingerprint_changes_when_mcp_json_appears() {
    let fixture = Fixture::agent_plugins("demo");
    let before = fixture.bundle().fingerprint;
    fixture.mcp(json!({}));

    assert_ne!(fixture.bundle().fingerprint, before);
}

#[test]
fn fingerprint_ignores_node_modules_and_git_under_the_code_folder() {
    let fixture = full_bundle();
    let before = fixture.bundle().fingerprint;
    fixture.write("dev.openagentd/node_modules/dep/index.js", "module.exports = 1");
    fixture.write("dev.openagentd/.git/HEAD", "ref: refs/heads/main");
    fixture.write("dev.openagentd/lib/node_modules/inner/x.js", "x");

    assert_eq!(fixture.bundle().fingerprint, before);
}

#[test]
fn fingerprint_ignores_files_that_do_not_define_the_bundle() {
    let fixture = full_bundle();
    let before = fixture.bundle().fingerprint;
    fixture.write("README.md", "docs");
    fixture.write("skills/notes/references/extra.md", "reference material");
    fixture.write("bin/helper.sh", "echo");
    fixture.write("data/cache.bin", "cache");

    assert_eq!(fixture.bundle().fingerprint, before);
}

#[cfg(unix)]
#[test]
fn fingerprint_follows_a_symlinked_code_file_to_its_target() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.write("src/main.ts", "export default {}");
    fixture.symlink(&fixture.path("src/main.ts"), "dev.openagentd/plugin.ts");
    let before = fixture.bundle().fingerprint;
    fixture.write("src/main.ts", "export default { changed: true }");

    assert_ne!(fixture.bundle().fingerprint, before);
}
