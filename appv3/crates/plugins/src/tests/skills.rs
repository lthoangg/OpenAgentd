//! Skill discovery under `skills/`, and the `SKILL.md` frontmatter.

use serde_json::json;

use super::{skill_names, warned, Fixture};
use crate::skills::{parse_frontmatter, Frontmatter};

/// The parsed `(name, description)` of a frontmatter block.
fn parse(text: &str) -> (Option<String>, Option<String>) {
    let Frontmatter { name, description } = parse_frontmatter(text);
    (name, description)
}

/// The description parsed from `description_lines` placed in a frontmatter block.
fn description(description_lines: &str) -> Option<String> {
    parse(&format!("---\nname: x\n{description_lines}\n---\nbody\n")).1
}

#[test]
fn skills_come_from_the_immediate_child_folders_of_skills() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.skill("summarize", "Summarize a document.").skill("deploy", "Deploy the service.");
    let bundle = fixture.bundle();

    assert_eq!(skill_names(&bundle), ["deploy", "summarize"]);
    assert_eq!(bundle.skills[1].description, "Summarize a document.");
    assert!(bundle.warnings.is_empty(), "{:?}", bundle.warnings);
}

#[test]
fn skill_dir_is_the_canonical_skill_folder() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.skill("summarize", "Summarize a document.");
    let bundle = fixture.bundle();

    assert_eq!(bundle.skills[0].dir, fixture.real_root().join("skills").join("summarize"));
}

#[test]
fn skills_are_sorted_by_folder_name() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.skill("zeta", "Z.").skill("alpha", "A.").skill("mid", "M.");
    assert_eq!(skill_names(&fixture.bundle()), ["alpha", "mid", "zeta"]);
}

#[test]
fn skills_nested_deeper_than_one_level_are_not_found() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.skill("top", "Top level.");
    fixture.write("skills/group/nested/SKILL.md", "---\nname: nested\ndescription: Too deep.\n---\n");
    let bundle = fixture.bundle();

    assert_eq!(skill_names(&bundle), ["top"]);
    assert!(bundle.warnings.is_empty(), "{:?}", bundle.warnings);
}

#[test]
fn skill_md_inside_the_skills_folder_itself_is_not_a_skill() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.write("skills/SKILL.md", "---\nname: x\ndescription: Not a skill folder.\n---\n");
    assert!(fixture.bundle().skills.is_empty());
}

#[test]
fn skill_md_at_the_root_is_not_a_skill() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.write("SKILL.md", "---\ndescription: Not a skill here.\n---\n");
    assert!(fixture.bundle().skills.is_empty());
}

#[test]
fn skills_key_in_the_manifest_is_an_unknown_field_and_names_no_skills() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.manifest("demo", json!({ "skills": "./extra" }));
    fixture.write("extra/x/SKILL.md", "---\ndescription: X.\n---\n");
    let bundle = fixture.bundle();

    assert!(bundle.skills.is_empty());
    assert_eq!(bundle.warnings, ["plugin.json: unknown field 'skills' ignored"]);
}

#[test]
fn folder_without_a_skill_md_is_not_a_skill() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.write("skills/notes/README.md", "just notes");
    let bundle = fixture.bundle();

    assert!(bundle.skills.is_empty());
    assert!(bundle.warnings.is_empty(), "{:?}", bundle.warnings);
}

#[test]
fn plain_files_in_skills_are_ignored() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.write("skills/readme.txt", "hello");
    fixture.skill("real", "A real skill.");
    assert_eq!(skill_names(&fixture.bundle()), ["real"]);
}

#[test]
fn a_file_named_skill_md_in_lowercase_is_not_a_skill() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.write("skills/quiet/skill.md", "---\nname: quiet\ndescription: Wrong case.\n---\n");
    assert!(fixture.bundle().skills.is_empty());
}

#[test]
fn missing_skills_folder_is_not_an_error() {
    let bundle = Fixture::agent_plugins("demo").bundle();
    assert!(bundle.skills.is_empty());
    assert!(bundle.warnings.is_empty());
}

#[test]
fn skills_that_is_a_file_warns_and_gives_no_skills() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.write("skills", "not a folder");
    let bundle = fixture.bundle();

    assert!(bundle.skills.is_empty());
    assert_eq!(bundle.warnings, ["skills: not a directory; skills ignored"]);
}

#[test]
fn skill_without_a_description_is_skipped_with_a_warning() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.write("skills/broken/SKILL.md", "---\nname: broken\n---\nBody.\n");
    let bundle = fixture.bundle();

    assert!(bundle.skills.is_empty());
    assert_eq!(bundle.warnings, ["skills/broken/SKILL.md: missing description; skipped"]);
}

#[test]
fn skill_with_an_empty_description_is_skipped() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.write("skills/empty/SKILL.md", "---\nname: empty\ndescription: \"\"\n---\n");
    let bundle = fixture.bundle();

    assert!(bundle.skills.is_empty());
    assert!(warned(&bundle, "skills/empty/SKILL.md: missing description; skipped"));
}

#[test]
fn skill_without_frontmatter_is_skipped_as_missing_its_description() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.write("skills/bare/SKILL.md", "# Just a title\n\nNo frontmatter here.\n");
    let bundle = fixture.bundle();

    assert!(bundle.skills.is_empty());
    assert!(warned(&bundle, "skills/bare/SKILL.md: missing description; skipped"));
}

#[test]
fn one_bad_skill_does_not_hide_the_others() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.skill("good", "A good skill.");
    fixture.write("skills/bad/SKILL.md", "no frontmatter");
    fixture.skill("also-good", "Another good skill.");
    let bundle = fixture.bundle();

    assert_eq!(skill_names(&bundle), ["also-good", "good"]);
    assert_eq!(bundle.warnings.len(), 1);
}

#[test]
fn skill_name_that_differs_from_the_folder_warns_and_keeps_the_folder_name() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.write("skills/folder/SKILL.md", "---\nname: other\ndescription: Named differently.\n---\n");
    let bundle = fixture.bundle();

    assert_eq!(skill_names(&bundle), ["folder"]);
    assert_eq!(bundle.warnings, ["skills/folder/SKILL.md: name 'other' differs from the folder name 'folder'; using 'folder'"]);
}

#[test]
fn skill_without_a_name_in_its_frontmatter_loads_without_a_warning() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.write("skills/anon/SKILL.md", "---\ndescription: No name given.\n---\n");
    let bundle = fixture.bundle();

    assert_eq!(skill_names(&bundle), ["anon"]);
    assert!(bundle.warnings.is_empty());
}

#[test]
fn skill_md_that_is_a_directory_is_skipped_with_a_warning() {
    let fixture = Fixture::agent_plugins("demo");
    std::fs::create_dir_all(fixture.path("skills/odd/SKILL.md")).unwrap();
    let bundle = fixture.bundle();

    assert!(bundle.skills.is_empty());
    assert_eq!(bundle.warnings, ["skills/odd/SKILL.md: not a regular file; skipped"]);
}

#[cfg(unix)]
#[test]
fn skill_md_symlinked_outside_the_root_is_skipped_with_a_warning() {
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("SKILL.md"), "---\nname: evil\ndescription: From outside.\n---\n").unwrap();
    let fixture = Fixture::agent_plugins("demo");
    fixture.symlink(&outside.path().join("SKILL.md"), "skills/evil/SKILL.md");
    let bundle = fixture.bundle();

    assert!(bundle.skills.is_empty());
    assert_eq!(bundle.warnings, ["skills/evil/SKILL.md: resolves outside the plugin folder; skipped"]);
}

#[cfg(unix)]
#[test]
fn skill_folder_symlinked_outside_the_root_is_skipped_with_a_warning() {
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("SKILL.md"), "---\nname: evil\ndescription: From outside.\n---\n").unwrap();
    let fixture = Fixture::agent_plugins("demo");
    fixture.symlink(outside.path(), "skills/evil");
    let bundle = fixture.bundle();

    assert!(bundle.skills.is_empty());
    assert!(warned(&bundle, "skills/evil/SKILL.md: ") && warned(&bundle, "resolves outside the plugin folder; skipped"), "{:?}", bundle.warnings);
}

#[cfg(unix)]
#[test]
fn skill_folder_outside_the_root_is_skipped_even_when_its_skill_md_links_back_inside() {
    let outside = tempfile::tempdir().unwrap();
    let fixture = Fixture::agent_plugins("demo");
    fixture.skill("inner", "Inside the plugin.");
    std::os::unix::fs::symlink(fixture.path("skills/inner/SKILL.md"), outside.path().join("SKILL.md")).unwrap();
    fixture.symlink(outside.path(), "skills/trick");
    let bundle = fixture.bundle();

    assert_eq!(skill_names(&bundle), ["inner"]);
    assert!(warned(&bundle, "skills/trick/SKILL.md: the folder resolves outside the plugin folder; skipped"), "{:?}", bundle.warnings);
}

#[cfg(unix)]
#[test]
fn skill_folder_symlinked_inside_the_root_loads_under_the_link_name() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.skill("real", "The real one.");
    fixture.symlink(&fixture.path("skills/real"), "skills/alias");
    let bundle = fixture.bundle();

    assert_eq!(skill_names(&bundle), ["alias", "real"]);
    assert_eq!(bundle.skills[0].dir, fixture.real_root().join("skills").join("real"));
}

#[cfg(unix)]
#[test]
fn skills_folder_symlinked_outside_the_root_is_ignored_with_a_warning() {
    let outside = tempfile::tempdir().unwrap();
    std::fs::create_dir(outside.path().join("a")).unwrap();
    std::fs::write(outside.path().join("a/SKILL.md"), "---\nname: a\ndescription: Outside.\n---\n").unwrap();
    let fixture = Fixture::agent_plugins("demo");
    fixture.symlink(outside.path(), "skills");
    let bundle = fixture.bundle();

    assert!(bundle.skills.is_empty());
    assert_eq!(bundle.warnings, ["skills: resolves outside the plugin folder; skills ignored"]);
}

#[test]
fn frontmatter_plain_values() {
    assert_eq!(parse("---\nname: release-notes\ndescription: Draft release notes.\n---\nBody"), (Some("release-notes".to_string()), Some("Draft release notes.".to_string())));
}

#[test]
fn frontmatter_double_quoted_value_is_unquoted() {
    assert_eq!(description("description: \"Use when: asked to deploy\""), Some("Use when: asked to deploy".to_string()));
}

#[test]
fn frontmatter_double_quoted_value_decodes_escapes() {
    assert_eq!(description(r#"description: "say \"hi\" \\ done""#), Some(r#"say "hi" \ done"#.to_string()));
}

#[test]
fn frontmatter_single_quoted_value_is_unquoted() {
    assert_eq!(description("description: 'It''s fine'"), Some("It's fine".to_string()));
}

#[test]
fn frontmatter_plain_value_may_contain_a_colon_and_space() {
    assert_eq!(description("description: Use this when: the user asks"), Some("Use this when: the user asks".to_string()));
}

#[test]
fn frontmatter_plain_value_loses_a_trailing_comment() {
    assert_eq!(description("description: Draft notes # internal"), Some("Draft notes".to_string()));
}

#[test]
fn frontmatter_hash_inside_a_word_is_not_a_comment() {
    assert_eq!(description("description: Review C# and F# code"), Some("Review C# and F# code".to_string()));
}

#[test]
fn frontmatter_hash_inside_quotes_is_kept() {
    assert_eq!(description("description: \"Fix bug #12 now\""), Some("Fix bug #12 now".to_string()));
}

#[test]
fn frontmatter_folded_block_joins_the_lines_with_spaces() {
    assert_eq!(description("description: >\n  First line\n  second line\n"), Some("First line second line".to_string()));
}

#[test]
fn frontmatter_literal_block_joins_the_lines_with_spaces() {
    assert_eq!(description("description: |\n  First line\n  second line\n"), Some("First line second line".to_string()));
}

#[test]
fn frontmatter_block_with_a_chomping_indicator_is_a_block() {
    assert_eq!(description("description: >-\n  Folded\n  and chomped"), Some("Folded and chomped".to_string()));
}

#[test]
fn frontmatter_block_stops_at_the_next_key() {
    let text = "---\ndescription: >\n  One\n  two\nname: after\n---\n";
    assert_eq!(parse(text), (Some("after".to_string()), Some("One two".to_string())));
}

#[test]
fn frontmatter_value_continued_on_an_indented_line() {
    assert_eq!(description("description: Draft release notes\n  from a changelog."), Some("Draft release notes from a changelog.".to_string()));
}

#[test]
fn frontmatter_value_on_the_line_after_the_key() {
    assert_eq!(description("description:\n  On its own line."), Some("On its own line.".to_string()));
}

#[test]
fn frontmatter_other_keys_and_nested_values_are_skipped() {
    let text = "---\nlicense: MIT\nmetadata:\n  author: someone\n  description: nested, not ours\nname: n\ndescription: Real one.\nallowed-tools: Read Grep\n---\n";
    assert_eq!(parse(text), (Some("n".to_string()), Some("Real one.".to_string())));
}

#[test]
fn frontmatter_with_windows_line_endings() {
    assert_eq!(parse("---\r\nname: n\r\ndescription: With CRLF.\r\n---\r\nBody\r\n"), (Some("n".to_string()), Some("With CRLF.".to_string())));
}

#[test]
fn frontmatter_after_a_byte_order_mark() {
    assert_eq!(parse("\u{feff}---\nname: n\ndescription: Has a BOM.\n---\n").1, Some("Has a BOM.".to_string()));
}

#[test]
fn frontmatter_must_start_on_the_first_line() {
    assert_eq!(parse("\n---\nname: n\ndescription: Late.\n---\n"), (None, None));
}

#[test]
fn frontmatter_that_is_never_closed_is_empty() {
    assert_eq!(parse("---\nname: n\ndescription: Open ended.\n"), (None, None));
}

#[test]
fn frontmatter_key_needs_a_space_after_the_colon() {
    assert_eq!(description("description:no-space"), None);
}

#[test]
fn frontmatter_empty_value_is_empty() {
    assert_eq!(description("description:"), Some(String::new()));
}

#[test]
fn frontmatter_unterminated_quote_keeps_the_text() {
    assert_eq!(description("description: \"never closed"), Some("\"never closed".to_string()));
}

#[test]
fn frontmatter_text_after_the_closing_delimiter_is_not_read() {
    assert_eq!(parse("---\nname: n\n---\ndescription: in the body\n").1, None);
}

#[test]
fn skill_description_may_use_a_block_scalar_in_a_real_file() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.write("skills/long/SKILL.md", "---\nname: long\ndescription: >\n  A long description that\n  spans two lines.\n---\n");
    assert_eq!(fixture.bundle().skills[0].description, "A long description that spans two lines.");
}

#[cfg(unix)]
#[test]
fn skills_folder_symlinked_inside_the_root_is_read() {
    let fixture = Fixture::agent_plugins("demo");
    fixture.skill("real-skill", "Lives elsewhere in the plugin.");
    std::fs::rename(fixture.path("skills"), fixture.path("shared-skills")).unwrap();
    fixture.symlink(&fixture.path("shared-skills"), "skills");
    let bundle = fixture.bundle();

    assert_eq!(skill_names(&bundle), ["real-skill"]);
    assert!(bundle.warnings.is_empty(), "{:?}", bundle.warnings);
}

#[test]
fn frontmatter_parser_does_not_panic_on_odd_input() {
    for text in ["", "---", "---\n---", "---\n...\n", "\u{feff}", "\u{feff}---\r\n", "---\r\n---\r\n"] {
        let _ = parse_frontmatter(text);
    }
    // Lines inside a closed block, so the value parsers run.
    let lines = [
        "description: \"é\\",
        "description: 'é",
        "description: \"\\é\"",
        "description: é # ü",
        "description: #",
        "description: >",
        "description: >é\n  x",
        "description: |+2 # c\n  é",
        "description: \"",
        "description: '",
        "description: \"\\",
        ":",
        ": x",
        "description",
        "name:\tx\ndescription:\t'y'",
        "description: 日本\n  語",
    ];
    for line in lines {
        let _ = parse_frontmatter(&format!("---\n{line}\n---\n"));
    }
}
