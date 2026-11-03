//! What a plugin bundle's code may do, and the checks the host natives make.
//!
//! A bundle is loaded with a [`Sandbox`]. The natives in `host.rs` ask the
//! [`Policy`] built from it before they touch the network, the file system,
//! a process or the environment, and a refusal reaches the plugin as a
//! `PermissionError` that names the plugin and what was denied. A
//! single-file (v1) plugin has no policy and keeps full access.
//!
//! Paths are checked after resolving symbolic links (for a path that does
//! not exist yet, through its nearest existing ancestor), and the resolved
//! path is what the native then uses, so a link inside an allowed folder
//! cannot lead out of it.

use appv3_plugins::{Net, Permissions};
use serde_json::{json, Value};
use std::cell::OnceCell;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// How [`JsPlugin::load_with`](crate::JsPlugin::load_with) loads a plugin file.
#[derive(Debug, Clone, Default)]
pub struct LoadOptions {
    /// `None`: a v1 single-file plugin, unrestricted as today.
    pub sandbox: Option<Sandbox>,
}

/// The limits a plugin bundle's code runs under.
///
/// Without any permission the code can read the bundle's own files, read and
/// write its data folder, and use only pure computation (hashing, regular
/// expressions, timers, logging). Everything else is granted by
/// [`Permissions`]:
///
/// * `net`: which hosts `fetch` may reach; a redirect to another host is refused too.
/// * `listen`: `listen()` may open a port, on a loopback address only.
/// * `fs`: more folders (absolute paths) it may read and write.
/// * `subprocess`: the programs `subprocess.run` / `which` accept, by file name.
/// * `env`: the variables `env.get` / `env.all` return.
///
/// Credentials are available for the provider the module's default export
/// declares, and no other.
#[derive(Debug, Clone)]
pub struct Sandbox {
    /// Plugin name, used in error messages.
    pub plugin: String,
    /// Bundle root: readable. Module imports are limited to it (and to the
    /// folder of the entry file, which normally lies inside it).
    pub root: PathBuf,
    /// Readable and writable; created on load if missing.
    pub data_dir: PathBuf,
    pub permissions: Permissions,
}

/// A refused access. Reaches the plugin as a `PermissionError`.
#[derive(Debug, Clone)]
pub(crate) struct Denied {
    /// The permission that would allow it: `net`, `listen`, `fs`,
    /// `subprocess`, `env`, `credentials` or `native`.
    pub permission: &'static str,
    /// What was refused: a host, a path, a program, a variable name.
    pub target: String,
    /// `plugin NAME may not …`, with the permission to add where there is one.
    pub message: String,
}

impl Denied {
    fn new(plugin: &str, permission: &'static str, target: &str, what: String) -> Self {
        tracing::warn!(target: "plugin", "[{plugin}] permission denied: {what}");
        Self { permission, target: target.to_string(), message: format!("plugin {plugin} {what}") }
    }
}

impl std::fmt::Display for Denied {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Denied {}

/// How a file-system native uses a path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Access {
    Read,
    Write,
    Remove,
    Create,
}

impl Access {
    fn verb(self) -> &'static str {
        match self {
            Access::Read => "read",
            Access::Write => "write",
            Access::Remove => "remove",
            Access::Create => "create",
        }
    }
    fn writes(self) -> bool {
        self != Access::Read
    }
}

/// Natives other crates register that only compute (no I/O, no secrets).
const PURE_NATIVES: &[&str] = &["gemini.convertMessages", "gemini.normalizeTurns", "gemini.convertTools", "http.statusMessage"];

/// Redirects `fetch` follows, like reqwest's default.
const REDIRECT_LIMIT: usize = 10;

/// A path component made of ASCII letters, digits, `_`, `-` and `.` only
/// (and not `.` / `..`): safe to join under a directory.
pub(crate) fn plain_component(v: &str) -> bool {
    !v.is_empty() && v != "." && v != ".." && v.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.'))
}

/// `host` (as `Url::host_str` gives it) matches a `net` permission entry:
/// exactly, or for `*.example.com` any subdomain of `example.com` (not
/// `example.com` itself). Case-insensitive; a trailing dot and the brackets
/// around an IPv6 address do not matter.
fn host_allowed(net: &Net, host: &str) -> bool {
    let plain = |s: &str| s.trim().trim_end_matches('.').trim_matches(['[', ']']).to_ascii_lowercase();
    let host = plain(host);
    match net {
        Net::Any => true,
        Net::None => false,
        Net::Hosts(list) => list.iter().any(|entry| {
            let entry = plain(entry);
            match entry.strip_prefix("*.") {
                Some(suffix) => !suffix.is_empty() && host.len() > suffix.len() + 1 && host.ends_with(suffix) && host.as_bytes()[host.len() - suffix.len() - 1] == b'.',
                None => !entry.is_empty() && host == entry,
            }
        }),
    }
}

/// The network rule, shared with reqwest's redirect policy (which outlives
/// any one request).
struct NetRule {
    plugin: String,
    net: Net,
}

impl NetRule {
    /// `url` may be fetched (`redirect` false) or followed from a redirect.
    fn check(&self, url: &reqwest::Url, redirect: bool) -> Result<(), Denied> {
        if matches!(self.net, Net::Any) {
            return Ok(());
        }
        let host = url.host_str().unwrap_or("");
        if !host.is_empty() && host_allowed(&self.net, host) {
            return Ok(());
        }
        let shown = if host.is_empty() { url.as_str() } else { host };
        let what =
            if redirect { format!("may not follow a redirect to {shown} (add it to permissions.net)") } else { format!("may not fetch {shown} (add it to permissions.net)") };
        Err(Denied::new(&self.plugin, "net", shown, what))
    }
}

/// A redirect the policy refused; found again in the error reqwest returns.
#[derive(Debug)]
struct BlockedRedirect(Denied);

impl std::fmt::Display for BlockedRedirect {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0.message)
    }
}

impl std::error::Error for BlockedRedirect {}

/// The refusal behind a failed request, when the error is a blocked redirect.
pub(crate) fn blocked_redirect(err: &(dyn std::error::Error + 'static)) -> Option<Denied> {
    let mut cur = Some(err);
    while let Some(e) = cur {
        if let Some(b) = e.downcast_ref::<BlockedRedirect>() {
            return Some(b.0.clone());
        }
        cur = e.source();
    }
    None
}

/// `path` made absolute with every symbolic link resolved: the canonical
/// path when it exists, otherwise the canonical path of its nearest existing
/// ancestor followed by the names that do not exist yet. `None` when that
/// cannot be done safely: a `..` among the missing names, or something that
/// exists but cannot be resolved (a dangling or looping link).
fn resolve(path: &Path) -> Option<PathBuf> {
    let abs = if path.is_absolute() { path.to_path_buf() } else { std::env::current_dir().ok()?.join(path) };
    let mut missing: Vec<OsString> = vec![];
    let mut cur: &Path = &abs;
    loop {
        match dunce::canonicalize(cur) {
            Ok(mut real) => {
                real.extend(missing.iter().rev());
                return Some(real);
            }
            Err(_) => {
                if cur.symlink_metadata().is_ok() {
                    return None;
                }
                missing.push(cur.file_name()?.to_os_string());
                cur = cur.parent()?;
            }
        }
    }
}

/// Like [`resolve`] but leaves the last name alone, so removing a link
/// removes the link and not what it points to.
fn resolve_entry(path: &Path) -> Option<PathBuf> {
    let abs = if path.is_absolute() { path.to_path_buf() } else { std::env::current_dir().ok()?.join(path) };
    let name = abs.file_name()?;
    Some(resolve(abs.parent()?)?.join(name))
}

/// Whether the program named `cmd` is the permitted `allowed` entry. Windows
/// ignores case and the executable extension.
fn same_program(allowed: &str, cmd_name: &str) -> bool {
    if cfg!(windows) {
        let bare = |s: &str| {
            let l = s.to_ascii_lowercase();
            for ext in [".exe", ".cmd", ".bat", ".com"] {
                if let Some(stem) = l.strip_suffix(ext) {
                    return stem.to_string();
                }
            }
            l
        };
        bare(allowed) == bare(cmd_name)
    } else {
        allowed == cmd_name
    }
}

/// Module imports of a bundle stay inside its folder.
#[derive(Debug, Clone)]
pub(crate) struct ImportJail {
    plugin: String,
    roots: Vec<PathBuf>,
}

impl ImportJail {
    /// The resolved path of `file` (an existing module file, imported as
    /// `shown`), if it may be loaded. QuickJS cuts an import error short at
    /// 255 bytes, after a prefix that holds the importing file's path, so the
    /// message stays brief and names the import as written.
    pub(crate) fn check(&self, file: &Path, shown: &str) -> Result<PathBuf, Denied> {
        let real = dunce::canonicalize(file).map_err(|_| Denied::new(&self.plugin, "fs", shown, format!("may not import {shown} (it cannot be resolved)")))?;
        if self.roots.iter().any(|r| real.starts_with(r)) {
            Ok(real)
        } else {
            Err(Denied::new(&self.plugin, "fs", shown, format!("may not import {shown} (outside its folder)")))
        }
    }
}

/// A [`Sandbox`] prepared for checking: folders resolved, lists normalised.
pub(crate) struct Policy {
    plugin: String,
    root: PathBuf,
    data_dir: PathBuf,
    fs: Vec<PathBuf>,
    net: Arc<NetRule>,
    listen: bool,
    subprocess: Vec<String>,
    env: Vec<String>,
    import_roots: Vec<PathBuf>,
    /// `default.provider.id`, known once the module has been evaluated.
    provider: OnceCell<String>,
    /// The declared provider's token folder, resolved on first use.
    token_root: OnceCell<Option<PathBuf>>,
}

impl Policy {
    /// Prepare `sb` for the plugin whose entry module is `entry`; creates the data folder.
    pub(crate) fn new(sb: Sandbox, entry: &Path) -> Result<Self, String> {
        let Sandbox { plugin, root, data_dir, permissions } = sb;
        std::fs::create_dir_all(&data_dir).map_err(|e| format!("plugin {plugin}: cannot create its data folder {}: {e}", data_dir.display()))?;
        let resolved = |what: &str, p: &Path| resolve(p).ok_or_else(|| format!("plugin {plugin}: cannot resolve {what} {}", p.display()));
        let root = resolved("its folder", &root)?;
        let data_dir = resolved("its data folder", &data_dir)?;
        let mut fs = vec![];
        for p in &permissions.fs {
            if !p.is_absolute() {
                return Err(format!("plugin {plugin}: permissions.fs entry {} must be an absolute path", p.display()));
            }
            fs.push(resolved("permissions.fs entry", p)?);
        }
        // The entry module normally sits inside the root; if it does not,
        // its own folder is still importable from.
        let mut import_roots = vec![root.clone()];
        if let Some(dir) = entry.parent().and_then(resolve) {
            if !import_roots.contains(&dir) {
                import_roots.push(dir);
            }
        }
        Ok(Self {
            net: Arc::new(NetRule { plugin: plugin.clone(), net: permissions.net }),
            plugin,
            root,
            data_dir,
            fs,
            listen: permissions.listen,
            subprocess: permissions.subprocess,
            env: permissions.env,
            import_roots,
            provider: OnceCell::new(),
            token_root: OnceCell::new(),
        })
    }

    fn deny(&self, permission: &'static str, target: &str, what: String) -> Denied {
        Denied::new(&self.plugin, permission, target, what)
    }

    pub(crate) fn import_jail(&self) -> ImportJail {
        ImportJail { plugin: self.plugin.clone(), roots: self.import_roots.clone() }
    }

    /// What the module's `bundle` export reports.
    pub(crate) fn bundle_info(&self) -> Value {
        json!({"name": self.plugin, "root": self.root.to_string_lossy(), "dataDir": self.data_dir.to_string_lossy()})
    }

    /// Record the provider id the module's default export declares; only its credentials become usable.
    pub(crate) fn declare_provider(&self, id: &str) {
        let _ = self.provider.set(id.to_string());
    }

    // ── net ─────────────────────────────────────────────────────────────────

    pub(crate) fn check_fetch(&self, url: &reqwest::Url) -> Result<(), Denied> {
        self.net.check(url, false)
    }

    /// reqwest's default redirect policy, except that a redirect to a host
    /// `net` does not allow fails the request before any connection.
    pub(crate) fn redirect_policy(&self) -> reqwest::redirect::Policy {
        let net = self.net.clone();
        reqwest::redirect::Policy::custom(move |attempt| match net.check(attempt.url(), true) {
            Ok(()) if attempt.previous().len() > REDIRECT_LIMIT => attempt.error("too many redirects"),
            Ok(()) => attempt.follow(),
            Err(d) => attempt.error(BlockedRedirect(d)),
        })
    }

    // ── listen ──────────────────────────────────────────────────────────────

    pub(crate) fn check_listen(&self, host: &str) -> Result<(), Denied> {
        if !self.listen {
            return Err(self.deny("listen", host, "may not listen on a local port (set permissions.listen to true)".into()));
        }
        let loopback = host.eq_ignore_ascii_case("localhost") || host.trim_matches(['[', ']']).parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback());
        if loopback {
            Ok(())
        } else {
            Err(self.deny("listen", host, format!("may not listen on {host} (only loopback addresses such as 127.0.0.1 are allowed)")))
        }
    }

    // ── subprocess ──────────────────────────────────────────────────────────

    fn program_allowed(&self, cmd: &str) -> bool {
        let Some(name) = Path::new(cmd).file_name().and_then(|n| n.to_str()) else { return false };
        self.subprocess.iter().any(|a| same_program(a, name))
    }

    /// `cmd` may be started: its file name is in `subprocess`. A bare name is
    /// looked up on `PATH`; a path must be absolute and outside every folder
    /// the plugin can write to (it could not have put a program there).
    pub(crate) fn check_run(&self, cmd: &str) -> Result<(), Denied> {
        if !self.program_allowed(cmd) {
            return Err(self.deny("subprocess", cmd, format!("may not run {cmd} (add it to permissions.subprocess)")));
        }
        if cmd.chars().any(std::path::is_separator) {
            if !Path::new(cmd).is_absolute() {
                return Err(self.deny("subprocess", cmd, format!("may not run {cmd} (use the program's name or an absolute path)")));
            }
            let writable = self.fs_roots(true);
            match resolve(Path::new(cmd)) {
                Some(real) if !writable.iter().any(|r| real.starts_with(r)) => {}
                Some(_) => return Err(self.deny("subprocess", cmd, format!("may not run {cmd} (it is in a folder the plugin can write to)"))),
                None => return Err(self.deny("subprocess", cmd, format!("may not run {cmd} (its path cannot be resolved)"))),
            }
        }
        Ok(())
    }

    /// `which(name)` answers only for programs the plugin may run.
    pub(crate) fn check_which(&self, name: &str) -> Result<(), Denied> {
        if self.program_allowed(name) {
            Ok(())
        } else {
            Err(self.deny("subprocess", name, format!("may not look up {name} (add it to permissions.subprocess)")))
        }
    }

    // ── env ─────────────────────────────────────────────────────────────────

    pub(crate) fn env_allowed(&self, name: &str) -> bool {
        self.env.iter().any(|e| if cfg!(windows) { e.eq_ignore_ascii_case(name) } else { e == name })
    }

    pub(crate) fn check_env(&self, name: &str) -> Result<(), Denied> {
        if self.env_allowed(name) {
            Ok(())
        } else {
            Err(self.deny("env", name, format!("may not read the environment variable {name} (add it to permissions.env)")))
        }
    }

    // ── credentials and other natives ───────────────────────────────────────

    /// Credentials, token files and the like of provider `id`: only for the
    /// provider this plugin's default export declares.
    pub(crate) fn check_provider(&self, id: &str) -> Result<(), Denied> {
        match self.provider.get() {
            Some(own) if own == id => Ok(()),
            Some(own) => Err(self.deny("credentials", id, format!("may not use the credentials of provider {id} (only those of its own provider, {own})"))),
            None => Err(self.deny("credentials", id, format!("may not use the credentials of provider {id} (its default export declares no provider)"))),
        }
    }

    /// A registered native (`native(name, arg)` in JS): pure computation is
    /// open, credentials follow [`Policy::check_provider`], the rest is denied.
    pub(crate) fn check_native(&self, name: &str, arg: &Value) -> Result<(), Denied> {
        match name {
            "creds.get" | "creds.oauth" => self.check_provider(arg.get("provider").and_then(Value::as_str).unwrap_or("")),
            n if PURE_NATIVES.contains(&n) => Ok(()),
            _ => Err(self.deny("native", name, format!("may not call the native function '{name}' (not available to plugin bundles)"))),
        }
    }

    // ── file system ─────────────────────────────────────────────────────────

    /// The declared provider's token folder (`credentialStore(...).tokenPath`
    /// and the JSON helpers built on it live there).
    fn token_root(&self) -> Option<&Path> {
        let id = self.provider.get()?;
        self.token_root
            .get_or_init(|| {
                if !plain_component(id) {
                    return None;
                }
                resolve(&appv3_core::settings().cache_dir.join("provider-plugins").join(id))
            })
            .as_deref()
    }

    /// Folders `Access` may reach: reads also cover the bundle folder.
    fn fs_roots(&self, write: bool) -> Vec<&Path> {
        let mut v: Vec<&Path> = vec![];
        if !write {
            v.push(&self.root);
        }
        v.push(&self.data_dir);
        v.extend(self.fs.iter().map(PathBuf::as_path));
        v.extend(self.token_root());
        v
    }

    /// The path a file-system native may use for `raw`. Anything below an
    /// allowed folder passes, except names the server never serves from a
    /// folder (`.git`, `.env*`, `.ssh`, `credentials.yaml` …).
    pub(crate) fn fs_path(&self, raw: &str, access: Access) -> Result<PathBuf, Denied> {
        let deny = |why: &str| self.deny("fs", raw, format!("may not {} {raw} ({why})", access.verb()));
        let path = Path::new(raw);
        let Some(real) = (if access == Access::Remove { resolve_entry(path) } else { resolve(path) }) else {
            return Err(deny("the path cannot be resolved"));
        };
        let mut protected = false;
        for root in self.fs_roots(access.writes()) {
            let Ok(rel) = real.strip_prefix(root) else { continue };
            if appv3_core::security::is_denied_path(rel) {
                protected = true;
                continue;
            }
            return Ok(real);
        }
        Err(deny(if protected {
            "that name is protected"
        } else if access.writes() {
            "writes are limited to its data folder and permissions.fs"
        } else {
            "reads are limited to its own folder, its data folder and permissions.fs"
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hosts(list: &[&str]) -> Net {
        Net::Hosts(list.iter().map(|s| s.to_string()).collect())
    }

    #[test]
    fn host_patterns() {
        let n = hosts(&["api.example.com", "*.example.org", "LocalHost"]);
        for ok in ["api.example.com", "API.Example.COM", "api.example.com.", "a.example.org", "a.b.example.org", "localhost"] {
            assert!(host_allowed(&n, ok), "{ok}");
        }
        for no in ["example.com", "x.api.example.com", "example.org", "evilexample.org", ".example.org", "example.org.evil.com", "127.0.0.1", ""] {
            assert!(!host_allowed(&n, no), "{no}");
        }
        assert!(!host_allowed(&Net::None, "localhost"));
        assert!(host_allowed(&Net::Any, "anything.test"));
        assert!(!host_allowed(&hosts(&[]), "localhost"));
        assert!(!host_allowed(&hosts(&["*", "*.", ""]), "a.com"));
        assert!(host_allowed(&hosts(&["[::1]", "127.0.0.1"]), "[::1]"));
        assert!(host_allowed(&hosts(&["::1"]), "[::1]"));
        assert!(host_allowed(&hosts(&["[::1]"]), "::1"));
        assert!(!host_allowed(&hosts(&["::1"]), "[::2]"));
    }

    #[test]
    fn url_checks_name_the_plugin_and_the_permission() {
        let rule = NetRule { plugin: "changelog-tools".into(), net: hosts(&["*.example.org"]) };
        let url = |s: &str| reqwest::Url::parse(s).unwrap();
        assert!(rule.check(&url("https://api.example.org/x"), false).is_ok());
        let e = rule.check(&url("https://example.com/x"), false).unwrap_err();
        assert_eq!(e.message, "plugin changelog-tools may not fetch example.com (add it to permissions.net)");
        assert_eq!((e.permission, e.target.as_str()), ("net", "example.com"));
        let e = rule.check(&url("https://example.com/x"), true).unwrap_err();
        assert_eq!(e.message, "plugin changelog-tools may not follow a redirect to example.com (add it to permissions.net)");
        // A URL without a host never passes a host list, but `net: true` takes anything.
        assert!(rule.check(&url("file:///etc/passwd"), false).is_err());
        let any = NetRule { plugin: "p".into(), net: Net::Any };
        assert!(any.check(&url("file:///etc/passwd"), false).is_ok());
    }

    #[test]
    fn program_names() {
        assert!(same_program("git", "git"));
        assert!(!same_program("git", "gitk"));
        assert!(!same_program("git", "Git") || cfg!(windows));
        assert_eq!(same_program("git", "git.exe"), cfg!(windows));
    }

    #[test]
    fn plain_components() {
        for ok in ["a", "a-b_c.d", "123"] {
            assert!(plain_component(ok), "{ok}");
        }
        for no in ["", ".", "..", "a/b", "a\\b", "a b", "é", "../x"] {
            assert!(!plain_component(no), "{no:?}");
        }
    }

    #[test]
    fn resolve_follows_existing_parts_and_appends_missing_ones() {
        let d = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(d.path()).unwrap();
        std::fs::create_dir(base.join("a")).unwrap();
        assert_eq!(resolve(&base.join("a")), Some(base.join("a")));
        assert_eq!(resolve(&base.join("a/b/c.txt")), Some(base.join("a").join("b").join("c.txt")));
        assert_eq!(resolve(&base.join("a/../a/x")), Some(base.join("a").join("x")));
        // `..` after a name that does not exist cannot be resolved without the file system.
        assert_eq!(resolve(&base.join("a/nope/../x")), None);
        assert_eq!(resolve(&base.join("a/nope/..")), None);
        // Removing keeps the last name.
        assert_eq!(resolve_entry(&base.join("a/b")), Some(base.join("a").join("b")));
        assert_eq!(resolve_entry(&base.join("a/..")), None);
    }

    #[cfg(unix)]
    #[test]
    fn resolve_sees_through_links_and_refuses_dangling_ones() {
        let d = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(d.path()).unwrap();
        std::fs::create_dir(base.join("real")).unwrap();
        std::os::unix::fs::symlink(base.join("real"), base.join("link")).unwrap();
        std::os::unix::fs::symlink(base.join("gone"), base.join("dangling")).unwrap();
        assert_eq!(resolve(&base.join("link/f")), Some(base.join("real").join("f")));
        assert_eq!(resolve(&base.join("dangling")), None);
        assert_eq!(resolve(&base.join("dangling/f")), None);
        // A link is removed, not followed.
        assert_eq!(resolve_entry(&base.join("link")), Some(base.join("link")));
    }

    fn policy(dir: &Path, perms: Permissions) -> Policy {
        let root = dir.join("bundle");
        std::fs::create_dir_all(&root).unwrap();
        Policy::new(Sandbox { plugin: "demo".into(), root: root.clone(), data_dir: dir.join("data"), permissions: perms }, &root.join("index.ts")).unwrap()
    }

    #[test]
    fn files_follow_the_folders_a_plugin_may_use() {
        let d = tempfile::tempdir().unwrap();
        let extra = d.path().join("extra");
        std::fs::create_dir_all(&extra).unwrap();
        let p = policy(d.path(), Permissions { fs: vec![extra.clone()], ..Default::default() });
        assert!(d.path().join("data").is_dir(), "the data folder is created");
        let s = |p: &Path| p.to_string_lossy().into_owned();
        let (root, data) = (d.path().join("bundle"), d.path().join("data"));

        assert!(p.fs_path(&s(&root.join("notes.txt")), Access::Read).is_ok());
        assert!(p.fs_path(&s(&data.join("state.json")), Access::Read).is_ok());
        assert!(p.fs_path(&s(&data.join("state.json")), Access::Write).is_ok());
        assert!(p.fs_path(&s(&data.join("a/b/c")), Access::Create).is_ok());
        assert!(p.fs_path(&s(&extra.join("x.txt")), Access::Write).is_ok());
        assert!(p.fs_path(&s(&extra.join("x.txt")), Access::Remove).is_ok());

        let e = p.fs_path(&s(&root.join("notes.txt")), Access::Write).unwrap_err();
        assert!(e.message.starts_with("plugin demo may not write "), "{}", e.message);
        assert!(e.message.contains("permissions.fs"), "{}", e.message);
        assert_eq!((e.permission, e.target.as_str()), ("fs", root.join("notes.txt").to_str().unwrap()));
        assert!(p.fs_path(&s(&root.join("n")), Access::Remove).is_err());
        assert!(p.fs_path(&s(&root.join("n")), Access::Create).is_err());
        assert!(p.fs_path(&s(d.path()), Access::Read).is_err());
        assert!(p.fs_path(&s(&d.path().join("other.txt")), Access::Read).is_err());
        // `..` out of an allowed folder, with and without the middle part existing.
        assert!(p.fs_path(&s(&data.join("../other.txt")), Access::Read).is_err());
        assert!(p.fs_path(&s(&data.join("nope/../../other.txt")), Access::Read).is_err());
        // Names that are never served from a folder stay protected inside it.
        assert!(p.fs_path(&s(&data.join(".env")), Access::Write).unwrap_err().message.contains("protected"));
        assert!(p.fs_path(&s(&extra.join(".git/config")), Access::Read).is_err());
        assert!(p.fs_path(&s(&data.join(".envrc")), Access::Write).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_cannot_lead_out_of_an_allowed_folder() {
        let d = tempfile::tempdir().unwrap();
        let p = policy(d.path(), Permissions::default());
        let outside = d.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "s").unwrap();
        let data = d.path().join("data");
        std::os::unix::fs::symlink(&outside, data.join("out")).unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), data.join("file")).unwrap();
        let s = |p: &Path| p.to_string_lossy().into_owned();
        assert!(p.fs_path(&s(&data.join("out/secret.txt")), Access::Read).is_err());
        assert!(p.fs_path(&s(&data.join("out/new.txt")), Access::Write).is_err());
        assert!(p.fs_path(&s(&data.join("file")), Access::Read).is_err());
        // Removing the link itself is fine; what it points to is not touched.
        let real = p.fs_path(&s(&data.join("file")), Access::Remove).unwrap();
        assert_eq!(real, dunce::canonicalize(&data).unwrap().join("file"));
    }

    #[test]
    fn listen_needs_the_permission_and_a_loopback_address() {
        let d = tempfile::tempdir().unwrap();
        let off = policy(d.path(), Permissions::default());
        assert!(off.check_listen("127.0.0.1").unwrap_err().message.contains("permissions.listen"));
        let on = policy(d.path(), Permissions { listen: true, ..Default::default() });
        for ok in ["127.0.0.1", "::1", "[::1]", "localhost", "LOCALHOST", "127.1.2.3"] {
            assert!(on.check_listen(ok).is_ok(), "{ok}");
        }
        for no in ["0.0.0.0", "::", "192.168.1.5", "example.com", ""] {
            assert!(on.check_listen(no).is_err(), "{no:?}");
        }
    }

    #[test]
    fn programs_env_and_natives() {
        let d = tempfile::tempdir().unwrap();
        let p = policy(d.path(), Permissions { subprocess: vec!["git".into()], env: vec!["HOME".into()], ..Default::default() });
        assert!(p.check_run("git").is_ok());
        assert!(p.check_which("git").is_ok());
        let e = p.check_run("rm").unwrap_err();
        assert_eq!(e.message, "plugin demo may not run rm (add it to permissions.subprocess)");
        assert!(p.check_which("rm").is_err());
        // A program path is accepted when the name matches and it is not in a writable folder.
        if cfg!(unix) {
            assert!(p.check_run("/usr/bin/git").is_ok());
            assert!(p.check_run("bin/git").is_err());
            let data_git = d.path().join("data").join("git");
            std::fs::write(&data_git, "#!/bin/sh\n").unwrap();
            assert!(p.check_run(data_git.to_str().unwrap()).unwrap_err().message.contains("can write to"));
        }
        assert!(p.check_env("HOME").is_ok());
        let e = p.check_env("SECRET_TOKEN").unwrap_err();
        assert_eq!(e.message, "plugin demo may not read the environment variable SECRET_TOKEN (add it to permissions.env)");
        assert!(!p.env_allowed("PATH"));

        // Credentials: nothing before a provider is declared, then only that one.
        let arg = |id: &str| json!({"provider": id});
        assert!(p.check_native("creds.get", &arg("mine")).is_err());
        p.declare_provider("mine");
        assert!(p.check_native("creds.get", &arg("mine")).is_ok());
        assert!(p.check_native("creds.oauth", &arg("mine")).is_ok());
        assert!(p.check_native("creds.get", &arg("other")).unwrap_err().message.contains("only those of its own provider, mine"));
        assert!(p.check_provider("mine").is_ok());
        // Pure natives pass; anything else registered by the host does not.
        assert!(p.check_native("http.statusMessage", &Value::Null).is_ok());
        assert!(p.check_native("gemini.convertTools", &Value::Null).is_ok());
        assert!(p.check_native("db.query", &Value::Null).unwrap_err().message.contains("'db.query'"));
    }

    #[test]
    fn relative_permission_folders_are_rejected() {
        let d = tempfile::tempdir().unwrap();
        let sb = Sandbox {
            plugin: "demo".into(),
            root: d.path().into(),
            data_dir: d.path().join("data"),
            permissions: Permissions { fs: vec!["relative/dir".into()], ..Default::default() },
        };
        let e = Policy::new(sb, &d.path().join("index.ts")).err().unwrap();
        assert!(e.contains("must be an absolute path"), "{e}");
    }

    #[test]
    fn imports_stay_in_the_bundle_folder() {
        let d = tempfile::tempdir().unwrap();
        let p = policy(d.path(), Permissions::default());
        std::fs::write(d.path().join("bundle/lib.ts"), "").unwrap();
        std::fs::write(d.path().join("outside.ts"), "").unwrap();
        let jail = p.import_jail();
        assert!(jail.check(&d.path().join("bundle/lib.ts"), "./lib.ts").is_ok());
        let e = jail.check(&d.path().join("bundle/../outside.ts"), "../outside.ts").unwrap_err();
        assert!(e.message.starts_with("plugin demo may not import "), "{}", e.message);
        assert_eq!(e.message, "plugin demo may not import ../outside.ts (outside its folder)");
    }
}
