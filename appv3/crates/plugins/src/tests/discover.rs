//! `discover` and `data_dir_name`.

use std::path::PathBuf;

use serde_json::json;
use tempfile::TempDir;

use crate::{data_dir_name, discover, PLUGIN_SCHEMA};

/// Makes `<dir>/<name>` an Agent Plugins folder.
fn plugin(dir: &TempDir, name: &str) -> PathBuf {
    let folder = dir.path().join(name);
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("plugin.json"), json!({ "$schema": PLUGIN_SCHEMA, "name": "x" }).to_string()).unwrap();
    folder
}

fn names(found: &[PathBuf]) -> Vec<String> {
    found.iter().map(|path| path.file_name().unwrap().to_string_lossy().into_owned()).collect()
}

#[test]
fn plugin_folders_are_sorted_by_name() {
    let dir = tempfile::tempdir().unwrap();
    plugin(&dir, "zeta");
    plugin(&dir, "alpha");
    plugin(&dir, "mid");

    assert_eq!(names(&discover(&[dir.path().to_path_buf()])), ["alpha", "mid", "zeta"]);
}

#[test]
fn paths_are_the_listed_folder_joined_with_the_name() {
    let dir = tempfile::tempdir().unwrap();
    plugin(&dir, "alpha");

    assert_eq!(discover(&[dir.path().to_path_buf()]), [dir.path().join("alpha")]);
}

#[test]
fn folders_starting_with_a_dot_or_an_underscore_are_skipped() {
    let dir = tempfile::tempdir().unwrap();
    plugin(&dir, ".hidden");
    plugin(&dir, "_template");
    plugin(&dir, "visible");

    assert_eq!(names(&discover(&[dir.path().to_path_buf()])), ["visible"]);
}

#[test]
fn folders_without_a_manifest_are_skipped() {
    let dir = tempfile::tempdir().unwrap();
    plugin(&dir, "real");
    std::fs::create_dir(dir.path().join("empty")).unwrap();
    std::fs::create_dir_all(dir.path().join("only-skills/skills/x")).unwrap();

    assert_eq!(names(&discover(&[dir.path().to_path_buf()])), ["real"]);
}

#[test]
fn plain_files_are_skipped() {
    let dir = tempfile::tempdir().unwrap();
    plugin(&dir, "real");
    std::fs::write(dir.path().join("plugin.json"), "{}").unwrap();
    std::fs::write(dir.path().join("notes.txt"), "x").unwrap();

    assert_eq!(names(&discover(&[dir.path().to_path_buf()])), ["real"]);
}

#[test]
fn a_manifest_that_is_a_folder_does_not_make_a_plugin() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("odd/plugin.json")).unwrap();

    assert!(discover(&[dir.path().to_path_buf()]).is_empty());
}

#[test]
fn plugins_nested_deeper_are_not_found() {
    let dir = tempfile::tempdir().unwrap();
    plugin(&dir, "group/inner");

    assert!(discover(&[dir.path().to_path_buf()]).is_empty());
}

#[test]
fn missing_directories_are_skipped() {
    let dir = tempfile::tempdir().unwrap();
    plugin(&dir, "real");
    let missing = dir.path().join("does-not-exist");

    assert_eq!(names(&discover(&[missing, dir.path().to_path_buf()])), ["real"]);
}

#[test]
fn a_listed_file_is_skipped() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("file.txt");
    std::fs::write(&file, "x").unwrap();

    assert!(discover(&[file]).is_empty());
}

#[test]
fn no_directories_find_nothing() {
    assert!(discover(&[]).is_empty());
}

#[test]
fn directories_keep_the_order_they_were_given_in() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    plugin(&first, "zzz");
    plugin(&second, "aaa");

    let found = discover(&[first.path().to_path_buf(), second.path().to_path_buf()]);
    assert_eq!(found, [first.path().join("zzz"), second.path().join("aaa")]);
}

#[test]
fn the_same_directory_listed_twice_gives_each_plugin_once() {
    let dir = tempfile::tempdir().unwrap();
    plugin(&dir, "a");
    plugin(&dir, "b");

    let found = discover(&[dir.path().to_path_buf(), dir.path().to_path_buf()]);
    assert_eq!(names(&found), ["a", "b"]);
}

#[test]
fn the_same_directory_reached_by_another_path_gives_each_plugin_once() {
    let dir = tempfile::tempdir().unwrap();
    plugin(&dir, "a");
    let roundabout = dir.path().join("a").join("..");

    let found = discover(&[dir.path().to_path_buf(), roundabout]);
    assert_eq!(found, [dir.path().join("a")]);
}

#[cfg(unix)]
#[test]
fn a_symlink_to_a_plugin_folder_is_found_once_at_its_first_position() {
    let dir = tempfile::tempdir().unwrap();
    let real = plugin(&dir, "real");
    std::os::unix::fs::symlink(&real, dir.path().join("alias")).unwrap();

    // `alias` sorts first, so it is the one kept; `real` is the same folder.
    assert_eq!(names(&discover(&[dir.path().to_path_buf()])), ["alias"]);
}

#[cfg(unix)]
#[test]
fn a_symlink_to_a_folder_elsewhere_is_followed() {
    let dir = tempfile::tempdir().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    let target = plugin(&elsewhere, "target");
    std::os::unix::fs::symlink(&target, dir.path().join("linked")).unwrap();

    assert_eq!(names(&discover(&[dir.path().to_path_buf()])), ["linked"]);
}

#[cfg(unix)]
#[test]
fn a_broken_symlink_is_skipped() {
    let dir = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(dir.path().join("nowhere"), dir.path().join("dangling")).unwrap();

    assert!(discover(&[dir.path().to_path_buf()]).is_empty());
}

#[test]
fn data_dir_name_keeps_letters_digits_underscores_and_hyphens() {
    assert_eq!(data_dir_name("my-plugin_2"), "my-plugin_2");
    assert_eq!(data_dir_name("MixedCase9"), "MixedCase9");
}

#[test]
fn data_dir_name_replaces_every_other_character_with_a_hyphen() {
    assert_eq!(data_dir_name("acme.tools"), "acme-tools");
    assert_eq!(data_dir_name("a b/c\\d:e"), "a-b-c-d-e");
    assert_eq!(data_dir_name(".."), "--");
}

#[test]
fn data_dir_name_replaces_each_non_ascii_character_once() {
    assert_eq!(data_dir_name("café"), "caf-");
    assert_eq!(data_dir_name("日本"), "--");
}

#[test]
fn data_dir_name_of_nothing_is_nothing() {
    assert_eq!(data_dir_name(""), "");
}
