//! `config_changed` global events for the settings UI (v3-only).
//!
//! Agents, skills, commands, snippets, plugins, `mcp.json` and the other
//! config files can be edited outside the UI (an editor, `git pull` of a
//! dotfiles repo, the agent itself). The UI otherwise refetches them on a
//! timer or on focus. This watches the config roots and publishes a debounced
//! `config_changed` event naming the affected resources. Like the workspace
//! watcher it is only an accelerator: consumers re-read the files, and
//! `OPENAGENTD_FS_WATCH=off` disables it. Config trees are small, so one
//! recursive native watch per root is fine on every OS (including inotify).

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::json;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::OnceLock;
use std::time::Duration;

pub const EVENT: &str = "config_changed";
const DEBOUNCE: Duration = Duration::from_millis(300);

/// Where each resource lives; the first matching rule wins.
pub struct Layout {
    pub agents: PathBuf,
    pub skills: Vec<PathBuf>,
    pub commands: PathBuf,
    pub snippets: PathBuf,
    pub mcp: PathBuf,
    pub plugins: Vec<PathBuf>,
    pub config: PathBuf,
}

/// `p` with symlinks resolved, as the OS reports watched paths (macOS FSEvents
/// gives `/private/tmp/...` for `/tmp/...`). Paths that do not exist yet
/// (`mcp.json` before the first save) resolve through their parent.
fn resolved(p: &Path) -> PathBuf {
    if let Ok(c) = dunce::canonicalize(p) {
        return c;
    }
    match (p.parent(), p.file_name()) {
        (Some(parent), Some(name)) => dunce::canonicalize(parent).map(|c| c.join(name)).unwrap_or_else(|_| p.to_path_buf()),
        _ => p.to_path_buf(),
    }
}

impl Layout {
    fn from_settings() -> Self {
        let s = appv3_core::settings();
        let home = appv3_core::home::home_dir();
        Layout {
            agents: s.agents_dir.clone(),
            skills: vec![s.skills_dir.clone(), home.join(".agents/skills")],
            commands: s.commands_dir(),
            snippets: s.snippets_dir(),
            mcp: s.mcp_config_path(),
            plugins: s.plugins_dirs.clone(),
            config: s.config_dir.clone(),
        }
        .resolved()
    }

    fn resolved(self) -> Self {
        Layout {
            agents: resolved(&self.agents),
            skills: self.skills.iter().map(|p| resolved(p)).collect(),
            commands: resolved(&self.commands),
            snippets: resolved(&self.snippets),
            mcp: resolved(&self.mcp),
            plugins: self.plugins.iter().map(|p| resolved(p)).collect(),
            config: resolved(&self.config),
        }
    }

    /// Directories to watch: existing roots not already covered by another root.
    fn roots(&self) -> Vec<PathBuf> {
        let mut all: Vec<PathBuf> =
            [&self.config, &self.agents].into_iter().cloned().chain(self.skills.iter().cloned()).chain(self.plugins.iter().cloned()).filter(|p| p.is_dir()).collect();
        all.sort();
        all.dedup();
        let mut out: Vec<PathBuf> = vec![];
        for p in all {
            if !out.iter().any(|r| p.starts_with(r)) {
                out.push(p);
            }
        }
        out
    }

    /// The resource a changed path belongs to, or `None` for noise.
    pub fn classify(&self, path: &Path) -> Option<&'static str> {
        let name = path.file_name()?.to_string_lossy();
        // Editor swap/backup files, atomic-write temporaries, OS litter.
        if name.ends_with('~')
            || name.ends_with(".swp")
            || name.ends_with(".tmp")
            || name == ".DS_Store"
            || name.starts_with(".#")
            || path.components().any(|c| c.as_os_str() == "__pycache__")
        {
            return None;
        }
        let under = |root: &Path| path.starts_with(root);
        if path == self.mcp {
            Some("mcp")
        } else if under(&self.agents) {
            Some("agents")
        } else if self.skills.iter().any(|r| under(r)) {
            Some("skills")
        } else if under(&self.commands) {
            Some("commands")
        } else if under(&self.snippets) {
            Some("snippets")
        } else if self.plugins.iter().any(|r| under(r)) {
            Some("plugins")
        } else if under(&self.config) {
            Some("settings")
        } else {
            None
        }
    }
}

fn disabled() -> bool {
    matches!(std::env::var("OPENAGENTD_FS_WATCH").unwrap_or_default().trim().to_ascii_lowercase().as_str(), "off" | "0" | "false" | "no")
}

/// Start watching the config roots (once per process).
pub fn start() {
    static STARTED: OnceLock<()> = OnceLock::new();
    if disabled() || STARTED.set(()).is_err() {
        return;
    }
    let _ = std::thread::Builder::new().name("oad-config-watch".into()).spawn(|| {
        let layout = Layout::from_settings();
        let (tx, rx) = channel::<Event>();
        let mut watcher = match RecommendedWatcher::new(
            move |r: notify::Result<Event>| {
                if let Ok(ev) = r {
                    let _ = tx.send(ev);
                }
            },
            Config::default(),
        ) {
            Ok(w) => w,
            Err(e) => return tracing::warn!("config_watch_unavailable err={}", e),
        };
        let roots = layout.roots();
        for r in &roots {
            if let Err(e) = watcher.watch(r, RecursiveMode::Recursive) {
                tracing::warn!("config_watch_failed root={} err={}", r.display(), e);
            }
        }
        tracing::debug!("config_watch_started roots={:?}", roots);
        run(&layout, rx, appv3_agent::broadcaster::publish);
        drop(watcher);
    });
}

/// Debounce loop: one event per burst, listing every resource touched.
fn run(layout: &Layout, rx: std::sync::mpsc::Receiver<Event>, publish: impl Fn(&str, serde_json::Value)) {
    let collect = |ev: Event, out: &mut BTreeSet<&'static str>| {
        if matches!(ev.kind, EventKind::Access(_)) {
            return;
        }
        if ev.need_rescan() {
            out.extend(["agents", "skills", "commands", "snippets", "mcp", "plugins", "settings"]);
        }
        out.extend(ev.paths.iter().filter_map(|p| layout.classify(p)));
    };
    loop {
        let Ok(first) = rx.recv() else { return };
        let mut resources = BTreeSet::new();
        collect(first, &mut resources);
        let open = loop {
            match rx.recv_timeout(DEBOUNCE) {
                Ok(ev) => collect(ev, &mut resources),
                Err(RecvTimeoutError::Timeout) => break true,
                Err(RecvTimeoutError::Disconnected) => break false,
            }
        };
        if !resources.is_empty() {
            publish(EVENT, json!({"resources": resources.into_iter().collect::<Vec<_>>()}));
        }
        if !open {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn layout(root: &Path) -> Layout {
        Layout {
            agents: root.join("agents"),
            skills: vec![root.join("skills"), root.join("home/.agents/skills")],
            commands: root.join("commands"),
            snippets: root.join("snippets"),
            mcp: root.join("mcp.json"),
            plugins: vec![root.join("plugins")],
            config: root.to_path_buf(),
        }
    }

    #[test]
    fn classify_maps_paths_to_resources() {
        let l = layout(Path::new("/cfg"));
        assert_eq!(l.classify(Path::new("/cfg/mcp.json")), Some("mcp"));
        assert_eq!(l.classify(Path::new("/cfg/agents/code.md")), Some("agents"));
        assert_eq!(l.classify(Path::new("/cfg/skills/x/SKILL.md")), Some("skills"));
        assert_eq!(l.classify(Path::new("/cfg/home/.agents/skills/y/SKILL.md")), Some("skills"));
        assert_eq!(l.classify(Path::new("/cfg/commands/review.md")), Some("commands"));
        assert_eq!(l.classify(Path::new("/cfg/plugins/scrub.ts")), Some("plugins"));
        assert_eq!(l.classify(Path::new("/cfg/config.toml")), Some("settings"));
        assert_eq!(l.classify(Path::new("/cfg/agents/.code.md.swp")), None);
        assert_eq!(l.classify(Path::new("/cfg/plugins/__pycache__/x.pyc")), None);
        assert_eq!(l.classify(Path::new("/elsewhere/file")), None);
    }

    #[test]
    fn roots_skip_nested_and_missing() {
        let d = tempfile::tempdir().unwrap();
        for sub in ["agents", "skills", "plugins"] {
            std::fs::create_dir_all(d.path().join(sub)).unwrap();
        }
        let ext = tempfile::tempdir().unwrap();
        let mut l = layout(d.path());
        l.plugins.push(ext.path().to_path_buf());
        let mut want = vec![d.path().to_path_buf(), ext.path().to_path_buf()];
        want.sort();
        assert_eq!(l.roots(), want);
    }

    /// Event paths arrive symlink-resolved; a config dir reached through a
    /// symlink (macOS `/tmp`) must still classify.
    #[cfg(unix)]
    #[test]
    fn resolves_symlinked_config_dirs() {
        let real = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(real.path().join("skills/a")).unwrap();
        let links = tempfile::tempdir().unwrap();
        let link = links.path().join("cfg");
        std::os::unix::fs::symlink(real.path(), &link).unwrap();
        let l = layout(&link).resolved();
        let real = dunce::canonicalize(real.path()).unwrap();
        assert_eq!(l.classify(&real.join("skills/a/SKILL.md")), Some("skills"));
        assert_eq!(l.classify(&real.join("mcp.json")), Some("mcp"), "missing file resolves via its parent");
    }

    #[test]
    fn bursts_are_debounced_into_one_event() {
        let l = layout(Path::new("/cfg"));
        let (tx, rx) = channel();
        let ev = |p: &str| Event::new(EventKind::Modify(notify::event::ModifyKind::Any)).add_path(PathBuf::from(p));
        tx.send(ev("/cfg/skills/a/SKILL.md")).unwrap();
        tx.send(ev("/cfg/mcp.json")).unwrap();
        tx.send(ev("/cfg/skills/a/.SKILL.md.swp")).unwrap();
        drop(tx);
        let got: Arc<Mutex<Vec<serde_json::Value>>> = Arc::default();
        let sink = got.clone();
        run(&l, rx, move |e, v| {
            assert_eq!(e, EVENT);
            sink.lock().unwrap().push(v);
        });
        assert_eq!(*got.lock().unwrap(), vec![json!({"resources": ["mcp", "skills"]})]);
    }
}
