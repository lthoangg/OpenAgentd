//! Git's ignore rules as seen from a search root, the way
//! `git ls-files --exclude-standard` applies them (so `grep` / `glob` agree
//! with the panel's listing): every `.gitignore` from a path's directory up to
//! the repository root, the deepest deciding first, then `.git/info/exclude`,
//! then the user's global excludes file. Outside a repository only the
//! `.gitignore`s from the search root down apply.
//!
//! A search under `repo/app` therefore honours `repo/.gitignore`
//! (`app/target/`), and `web/.gitignore` (`dist`) applies to `web/dist/` in a
//! search from the repository root.

use ignore::gitignore::{gitconfig_excludes_path, Gitignore, GitignoreBuilder};
use ignore::Match;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

/// Cheap to clone; clones share the per-directory cache.
#[derive(Clone)]
pub struct Ignores(Arc<Inner>);

struct Inner {
    /// The search root that relative paths are relative to.
    root: PathBuf,
    /// The repository root, or `root` outside a repository: the last
    /// directory whose `.gitignore` applies.
    top: PathBuf,
    /// `.git/info/exclude`, then the global excludes file (repository only).
    repo_wide: Vec<Gitignore>,
    /// Each directory's own `.gitignore`, loaded on first use.
    per_dir: RwLock<HashMap<PathBuf, Option<Arc<Gitignore>>>>,
}

fn build(base: &Path, file: &Path) -> Option<Gitignore> {
    if !file.is_file() {
        return None;
    }
    let mut b = GitignoreBuilder::new(base);
    let _ = b.add(file);
    b.build().ok().filter(|g| !g.is_empty())
}

/// The nearest directory at or above `dir` holding `.git` (a directory, or
/// the file a linked worktree has).
fn repo_root(dir: &Path) -> Option<PathBuf> {
    dir.ancestors().find(|d| d.join(".git").exists()).map(Path::to_path_buf)
}

impl Ignores {
    pub fn load(root: &Path) -> Self {
        let repo = repo_root(root);
        let mut repo_wide = vec![];
        if let Some(top) = &repo {
            repo_wide.extend(build(top, &top.join(".git").join("info").join("exclude")));
            if let Some(global) = gitconfig_excludes_path() {
                repo_wide.extend(build(top, &global));
            }
        }
        Ignores(Arc::new(Inner { root: root.to_path_buf(), top: repo.unwrap_or_else(|| root.to_path_buf()), repo_wide, per_dir: RwLock::default() }))
    }

    fn dir_rules(&self, dir: &Path) -> Option<Arc<Gitignore>> {
        if let Some(hit) = self.0.per_dir.read().unwrap().get(dir) {
            return hit.clone();
        }
        let rules = build(dir, &dir.join(".gitignore")).map(Arc::new);
        self.0.per_dir.write().unwrap().insert(dir.to_path_buf(), rules.clone());
        rules
    }

    /// Whether `rel` (`/`-separated, relative to the search root) is ignored
    /// by its own name, its parent directories taken as not ignored — what a
    /// top-down walk that never enters an ignored directory needs.
    pub fn matched(&self, rel: &str, is_dir: bool) -> bool {
        let abs = rel.split('/').filter(|s| !s.is_empty()).fold(self.0.root.clone(), |p, s| p.join(s));
        let mut dir = abs.parent();
        while let Some(d) = dir {
            if let Some(rules) = self.dir_rules(d) {
                match rules.matched(&abs, is_dir) {
                    Match::Ignore(_) => return true,
                    Match::Whitelist(_) => return false,
                    Match::None => {}
                }
            }
            if d == self.0.top || !d.starts_with(&self.0.top) {
                break;
            }
            dir = d.parent();
        }
        for rules in &self.0.repo_wide {
            match rules.matched(&abs, is_dir) {
                Match::Ignore(_) => return true,
                Match::Whitelist(_) => return false,
                Match::None => {}
            }
        }
        false
    }

    /// Whether `rel` or any directory above it (up to the search root) is
    /// ignored: an ignored directory hides everything inside it, as in git.
    pub fn matched_or_any_parent(&self, rel: &str, is_dir: bool) -> bool {
        let parts: Vec<&str> = rel.split('/').filter(|s| !s.is_empty()).collect();
        (1..parts.len()).any(|n| self.matched(&parts[..n].join("/"), true)) || self.matched(rel, is_dir)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, rel: &str, body: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }

    #[test]
    fn nested_gitignores_apply_to_their_own_subtree_and_the_deepest_wins() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        write(r, ".gitignore", "*.log\n");
        write(r, "web/.gitignore", "dist\n!keep.log\n");
        let ig = Ignores::load(r);
        assert!(ig.matched("web/dist", true));
        assert!(!ig.matched("dist", true), "web/.gitignore must not reach the root");
        assert!(ig.matched("a.log", false));
        assert!(ig.matched("web/x.log", false));
        assert!(!ig.matched("web/keep.log", false), "a deeper `!` re-includes");
        assert!(ig.matched_or_any_parent("web/dist/app.js", false));
        assert!(!ig.matched_or_any_parent("web/src/app.js", false));
    }

    #[test]
    fn a_subfolder_search_honours_the_repository_rules_above_it() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        std::fs::create_dir_all(r.join(".git/info")).unwrap();
        write(r, ".git/info/exclude", "scratch/\n");
        write(r, ".gitignore", "app/target/\n");
        std::fs::create_dir_all(r.join("app/target")).unwrap();
        let ig = Ignores::load(&r.join("app"));
        assert!(ig.matched("target", true));
        assert!(ig.matched("scratch", true));
        assert!(!ig.matched("src", true));
        // Outside a repository, rules above the search root do not apply.
        let outside = tempfile::tempdir().unwrap();
        write(outside.path(), ".gitignore", "app/target/\n");
        assert!(!Ignores::load(&outside.path().join("app")).matched("target", true));
    }
}
