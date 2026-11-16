//! The workspace's crate layers: a crate may depend only on crates in a lower
//! layer, so `core` stays a leaf and runtime crates never reach up into
//! `agent`, `api` or `cli`. Cargo rejects cycles between normal dependencies
//! but not an upward edge, nor a cycle through dev-dependencies.
//!
//! Adding a crate or an edge that this test refuses: put the crate in the
//! lowest layer above everything it depends on, and update `appv3/AGENTS.md`'s
//! crate map if the layering itself changes.

use std::collections::BTreeMap;
use std::path::Path;

/// Lowest first. Crates in the same layer may not depend on each other.
const LAYERS: &[&[&str]] =
    &[&["core", "kernel", "plugins"], &["db", "memory", "jsplugin"], &["providers"], &["tools"], &["terminal", "preview"], &["agent"], &["mcp"], &["api"], &["cli"]];

fn layer_of(name: &str) -> Option<usize> {
    LAYERS.iter().position(|layer| layer.contains(&name))
}

/// The `appv3-*` crates named in any `[*dependencies]` section (normal, dev,
/// build, or target-specific) of a crate manifest, as a key
/// (`appv3-core.workspace = true`) or as a table (`[dependencies.appv3-core]`).
fn internal_deps(manifest: &str) -> Vec<(String, String)> {
    fn crate_name(rest: &str) -> String {
        rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect()
    }
    let mut section = String::new();
    let mut deps = Vec::new();
    for line in manifest.lines().map(str::trim) {
        if line.starts_with('[') {
            section = line.to_string();
            if let Some((table, rest)) = section.trim_matches(['[', ']']).rsplit_once(".appv3-") {
                if table.ends_with("dependencies") {
                    deps.push((crate_name(rest), section.clone()));
                }
            }
            continue;
        }
        if !section.trim_end_matches(']').ends_with("dependencies") {
            continue;
        }
        if let Some(rest) = line.strip_prefix("appv3-") {
            deps.push((crate_name(rest), section.clone()));
        }
    }
    deps
}

fn workspace_crates() -> BTreeMap<String, String> {
    let crates_dir = Path::new(env!("CARGO_MANIFEST_DIR")).parent().expect("crates dir");
    let mut out = BTreeMap::new();
    for entry in std::fs::read_dir(crates_dir).expect("read crates dir") {
        let dir = entry.expect("crate entry").path();
        let manifest = dir.join("Cargo.toml");
        if manifest.is_file() {
            let name = dir.file_name().expect("crate name").to_string_lossy().into_owned();
            out.insert(name, std::fs::read_to_string(&manifest).expect("read manifest"));
        }
    }
    out
}

#[test]
fn every_crate_has_a_layer() {
    let crates = workspace_crates();
    assert!(crates.len() >= LAYERS.iter().map(|l| l.len()).sum::<usize>(), "found only {:?}", crates.keys());
    let missing: Vec<_> = crates.keys().filter(|name| layer_of(name).is_none()).collect();
    assert!(missing.is_empty(), "crates without a layer: {missing:?}; add each to LAYERS in {}", file!());
    let gone: Vec<_> = LAYERS.iter().flat_map(|l| l.iter()).filter(|name| !crates.contains_key(**name)).collect();
    assert!(gone.is_empty(), "LAYERS names crates that no longer exist: {gone:?}");
}

#[test]
fn crates_depend_only_on_lower_layers() {
    let mut violations = Vec::new();
    for (name, manifest) in workspace_crates() {
        let Some(from) = layer_of(&name) else { continue };
        for (dep, section) in internal_deps(&manifest) {
            match layer_of(&dep) {
                Some(to) if to < from => {}
                Some(to) => violations.push(format!("{name} (layer {from}) -> {dep} (layer {to}) in {section}")),
                None => violations.push(format!("{name} -> unknown crate appv3-{dep} in {section}")),
            }
        }
    }
    assert!(violations.is_empty(), "dependencies that do not point to a lower layer:\n  {}", violations.join("\n  "));
}

#[test]
fn reads_every_dependency_section() {
    let manifest = "[package]\nname = \"appv3-x\"\n\n[dependencies]\nappv3-core.workspace = true\nserde = \"1\"\n\n[target.'cfg(unix)'.dependencies]\nappv3-db = { path = \"../db\" }\n\n[dev-dependencies]\nappv3-agent.workspace = true\n\n[features]\nappv3-fake = []\n\n[build-dependencies.appv3-tools]\nworkspace = true\n";
    let names: Vec<_> = internal_deps(manifest).into_iter().map(|(name, _)| name).collect();
    assert_eq!(names, ["core", "db", "agent", "tools"]);
}
