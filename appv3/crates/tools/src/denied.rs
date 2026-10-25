//! Path denylist — port of `app/agent/denied_paths.py` (+ `denied_paths_config`).

use crate::ToolError;
use regex::Regex;
use std::path::{Component, Path, PathBuf};

pub const SESSIONS_DIR: &str = "sessions";
pub const DEFAULT_DENIED_PATTERNS: &[&str] = &["**/.env", "**/.env.*"];

pub fn sessions_root() -> PathBuf {
    appv3_core::settings().data_dir.join(SESSIONS_DIR)
}

pub fn session_artifacts_dir(session_id: Option<&str>) -> PathBuf {
    match session_id {
        Some(s) if !s.is_empty() => sessions_root().join(s),
        _ => sessions_root(),
    }
}

/// Where the bundled skills are materialised (`appv3_agent::skills`). It sits
/// inside the denied cache dir, so it is exempted for reads only: skills point
/// the agent at their reference files, which OpenAgentd itself rewrites.
pub fn builtin_skills_root() -> PathBuf {
    appv3_core::settings().cache_dir.join("v3-builtin-skills")
}

/// Files in the config dir that hold secrets: the credential store, its
/// lock, and the dotenv backup the migration keeps. Agent tools never
/// touch them.
pub fn secret_config_files() -> Vec<PathBuf> {
    let cfg = &appv3_core::settings().config_dir;
    vec![cfg.join(appv3_core::credentials::FILE_NAME), cfg.join(format!(".{}.lock", appv3_core::credentials::FILE_NAME)), cfg.join(".env.migrated")]
}

/// Python `fnmatch.translate` → anchored regex.
pub fn fnmatch_translate(pat: &str) -> String {
    let chars: Vec<char> = pat.chars().collect();
    let mut i = 0;
    let mut res = String::from("(?s)^");
    while i < chars.len() {
        let c = chars[i];
        i += 1;
        match c {
            '*' => {
                while i < chars.len() && chars[i] == '*' {
                    i += 1;
                }
                res.push_str(".*");
            }
            '?' => res.push('.'),
            '[' => {
                let mut j = i;
                if j < chars.len() && chars[j] == '!' {
                    j += 1;
                }
                if j < chars.len() && chars[j] == ']' {
                    j += 1;
                }
                while j < chars.len() && chars[j] != ']' {
                    j += 1;
                }
                if j >= chars.len() {
                    res.push_str("\\[");
                } else {
                    let mut stuff: String = chars[i..j].iter().collect();
                    stuff = stuff.replace('\\', "\\\\");
                    i = j + 1;
                    if let Some(rest) = stuff.strip_prefix('!') {
                        stuff = format!("^{rest}");
                    } else if stuff.starts_with('^') {
                        stuff = format!("\\{stuff}");
                    }
                    res.push('[');
                    res.push_str(&stuff);
                    res.push(']');
                }
            }
            c => res.push_str(&regex::escape(&c.to_string())),
        }
    }
    res.push('$');
    res
}

pub fn fnmatch(name: &str, pat: &str) -> bool {
    Regex::new(&fnmatch_translate(pat)).map(|r| r.is_match(name)).unwrap_or(false)
}

/// Compile a denied-path glob. Case-insensitive on Windows, where `.ENV`
/// names the same file as `.env`.
fn pattern_regex(pat: &str) -> Option<Regex> {
    if cfg!(windows) {
        Regex::new(&format!("(?i){}", fnmatch_translate(&pat.replace('\\', "/")))).ok()
    } else {
        Regex::new(&fnmatch_translate(pat)).ok()
    }
}

/// The string denied patterns are matched against. v2 matches `str(path)`,
/// so on Windows `**/.env` never matched `C:\ws\.env`; v3 matches the
/// `/`-separated form there so the default patterns work on every OS.
fn pattern_subject(resolved: &Path) -> String {
    let s = resolved.to_string_lossy();
    if cfg!(windows) {
        s.replace('\\', "/")
    } else {
        s.into_owned()
    }
}

/// Lexical + symlink-resolving `Path.resolve()` (non-strict: missing tails ok).
pub fn resolve(p: &Path) -> PathBuf {
    if let Ok(c) = dunce::canonicalize(p) {
        return c;
    }
    // Resolve the longest existing ancestor, then append the rest lexically.
    let mut existing = p.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = vec![];
    loop {
        if let Ok(c) = dunce::canonicalize(&existing) {
            let mut out = c;
            for t in tail.iter().rev() {
                match Path::new(t).components().next() {
                    Some(Component::ParentDir) => {
                        out.pop();
                    }
                    Some(Component::CurDir) => {}
                    _ => out.push(t),
                }
            }
            return out;
        }
        match (existing.file_name().map(|s| s.to_os_string()), existing.parent()) {
            (Some(name), Some(parent)) => {
                tail.push(name);
                existing = parent.to_path_buf();
            }
            _ => return normalize(p),
        }
    }
}

fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Would v2's `DeniedPathsConfig(...)` constructor raise? It catches
/// `(ValueError, OSError)` from `load_config()`; YAML-constructor exceptions
/// such as `KeyError` (`!!bool maybe`) or `AttributeError` escape it.
pub fn default_config_escapes() -> bool {
    let cfg = appv3_core::settings().config_dir.clone();
    let mut path = cfg.join("denied_paths.yaml");
    if !path.exists() {
        path = cfg.join("sandbox.yaml");
    }
    let Ok(text) = std::fs::read_to_string(&path) else { return false };
    matches!(appv3_core::pyyaml::safe_load_py(&text), Err(e) if !e.is_yaml_error() && e.kind != "ValueError")
}

pub fn load_denied_patterns() -> Vec<String> {
    let cfg = appv3_core::settings().config_dir.clone();
    let mut path = cfg.join("denied_paths.yaml");
    if !path.exists() {
        let legacy = cfg.join("sandbox.yaml");
        if legacy.exists() {
            path = legacy;
        } else {
            return DEFAULT_DENIED_PATTERNS.iter().map(|s| s.to_string()).collect();
        }
    }
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return vec![],
    };
    let raw = match appv3_core::pyyaml::safe_load_py(&text) {
        Ok(p) if !p.truthy() => serde_json::Value::Null,
        Ok(p) => p.to_json(),
        Err(_) => return vec![],
    };
    match raw.get("denied_patterns") {
        Some(serde_json::Value::Array(seq)) => seq.iter().filter_map(|v| v.as_str()).filter(|s| !s.trim().is_empty()).map(String::from).collect(),
        None if raw.is_object() || raw.is_null() => DEFAULT_DENIED_PATTERNS.iter().map(|s| s.to_string()).collect(),
        _ => vec![],
    }
}

#[derive(Debug)]
pub struct DeniedPaths {
    pub workspace_root: PathBuf,
    pub session_id: Option<String>,
    pub denied_roots: Vec<PathBuf>,
    pub denied_patterns: Vec<(String, Regex)>,
    pub shell_denied_roots: Vec<PathBuf>,
    /// Readable (not writable) despite a denied root; denied patterns still apply.
    pub read_only_roots: Vec<PathBuf>,
    shielded: Vec<(PathBuf, Vec<PathBuf>)>,
}

impl DeniedPaths {
    pub fn new(workspace: &Path, session_id: Option<String>) -> Self {
        Self::with(workspace, session_id, None, None)
    }

    pub fn with(workspace: &Path, session_id: Option<String>, roots: Option<Vec<PathBuf>>, patterns: Option<Vec<String>>) -> Self {
        let _ = std::fs::create_dir_all(workspace);
        let workspace_root = resolve(workspace);
        let s = appv3_core::settings();
        let secret_files = secret_config_files();
        let denied_roots: Vec<PathBuf> =
            roots.unwrap_or_else(|| [vec![s.data_dir.clone(), s.state_dir.clone(), s.cache_dir.clone()], secret_config_files()].concat()).iter().map(|p| resolve(p)).collect();
        let pats = patterns.unwrap_or_else(load_denied_patterns);
        let denied_patterns = pats.into_iter().filter_map(|p| pattern_regex(&p).map(|r| (p, r))).collect();
        let mut shell_denied_roots = vec![resolve(&s.config_dir).join("memory")];
        shell_denied_roots.extend(secret_files.iter().map(|p| resolve(p)));
        let state_root = resolve(&s.state_dir);
        let mut allowed = vec![workspace_root.clone(), state_root.join("logs"), state_root.join("otel"), state_root.join("telemetry")];
        if let Some(sid) = session_id.as_deref().filter(|s| !s.is_empty()) {
            allowed.push(resolve(&session_artifacts_dir(Some(sid))));
        }
        let shielded = denied_roots.iter().map(|d| (d.clone(), allowed.iter().filter(|a| a.starts_with(d)).cloned().collect())).collect();
        let read_only_roots = vec![resolve(&builtin_skills_root())];
        Self { workspace_root, session_id, denied_roots, denied_patterns, shell_denied_roots, read_only_roots, shielded }
    }

    fn is_denied(&self, resolved: &Path) -> Option<String> {
        for (denied, shields) in &self.shielded {
            if shields.iter().any(|s| resolved.starts_with(s)) {
                continue;
            }
            if resolved.starts_with(denied) {
                return Some(denied.display().to_string());
            }
        }
        let s = pattern_subject(resolved);
        self.denied_patterns.iter().find(|(_, rx)| rx.is_match(&s)).map(|(p, _)| p.clone())
    }

    fn is_denied_for_read(&self, resolved: &Path) -> Option<String> {
        if self.read_only_roots.iter().any(|r| resolved.starts_with(r)) {
            let s = pattern_subject(resolved);
            return self.denied_patterns.iter().find(|(_, rx)| rx.is_match(&s)).map(|(p, _)| p.clone());
        }
        self.is_denied(resolved)
    }

    fn is_shell_denied(&self, resolved: &Path) -> Option<String> {
        self.shell_denied_roots.iter().find(|d| resolved.starts_with(d)).map(|d| d.display().to_string())
    }

    /// v2 `validate_path` — raises PermissionError text on denial.
    pub fn validate_path(&self, path: &str) -> Result<PathBuf, ToolError> {
        self.validate_with(path, Self::is_denied)
    }

    /// [`validate_path`](Self::validate_path) for read-only tools (`read`,
    /// `grep`, `glob`): also admits [`read_only_roots`](Self::read_only_roots).
    pub fn validate_read_path(&self, path: &str) -> Result<PathBuf, ToolError> {
        self.validate_with(path, Self::is_denied_for_read)
    }

    fn validate_with(&self, path: &str, check: fn(&Self, &Path) -> Option<String>) -> Result<PathBuf, ToolError> {
        if path.starts_with('~') {
            return Err(ToolError::Execution(format!("Tilde paths are not allowed: {path}")));
        }
        let p = Path::new(path);
        let candidate = if p.is_absolute() { p.to_path_buf() } else { self.workspace_root.join(p) };
        let resolved = resolve(&candidate);
        if let Some(d) = check(self, &resolved) {
            tracing::warn!("path_denied path={} denied_root={}", resolved.display(), d);
            return Err(ToolError::Execution(format!("Path '{}' is inside a denied root: {}", resolved.display(), d)));
        }
        Ok(resolved)
    }

    pub fn is_denied_path(&self, path: &Path) -> bool {
        self.is_denied_path_with(path, Self::is_denied)
    }

    /// [`is_denied_path`](Self::is_denied_path) for read-only tools.
    pub fn is_denied_read_path(&self, path: &Path) -> bool {
        self.is_denied_path_with(path, Self::is_denied_for_read)
    }

    fn is_denied_path_with(&self, path: &Path, check: fn(&Self, &Path) -> Option<String>) -> bool {
        if check(self, path).is_some() {
            return true;
        }
        match std::fs::symlink_metadata(path) {
            Ok(m) if m.file_type().is_symlink() => check(self, &resolve(path)).is_some(),
            // `Path.is_symlink()` is False for missing/unreadable paths.
            _ => false,
        }
    }

    pub fn display_path(&self, resolved: &Path) -> String {
        match resolved.strip_prefix(&self.workspace_root) {
            Ok(r) => {
                let s = r.display().to_string();
                if s.is_empty() {
                    ".".into()
                } else {
                    s
                }
            }
            Err(_) => resolved.display().to_string(),
        }
    }

    /// For a missing absolute `raw` path whose workspace-relative reading
    /// exists (`/web/src` for the workspace's `web/src`): a sentence naming
    /// it, prefixed with a space. Empty otherwise. Paths are not rewritten:
    /// `/` stays the machine root.
    pub fn absolute_path_hint(&self, raw: &str) -> String {
        let p = Path::new(raw);
        if !raw.starts_with('/') || p.exists() {
            return String::new();
        }
        let rel = raw.trim_start_matches('/').trim_end_matches('/');
        if rel.is_empty() || !self.workspace_root.join(rel).exists() {
            return String::new();
        }
        format!(" `{raw}` is an absolute path. Did you mean `{rel}` (workspace-relative)?")
    }

    /// v2 `check_command`: shell-tokenise and look for denied path tokens.
    pub fn check_command(&self, command_line: &str) -> Option<String> {
        let tokens = split_command(command_line)?;
        for raw in tokens {
            let token = raw.trim_matches(|c| c == '"' || c == '\'');
            if !looks_path_like(token) {
                continue;
            }
            let p = Path::new(token);
            let candidate = if p.is_absolute() { p.to_path_buf() } else { self.workspace_root.join(p) };
            let resolved = resolve(&candidate);
            let hit = self.is_denied(&resolved).or_else(|| self.is_shell_denied(&resolved));
            if hit.is_some() {
                tracing::warn!("path_command_denied token={} resolved={}", token, resolved.display());
                return hit;
            }
        }
        None
    }
}

/// Split a command line into words. POSIX shells: `shlex` rules, as v2.
/// Windows: `\` is a path separator, not an escape (v2's `shlex.split` turns
/// `C:\data\x` into `C:datax`, so absolute denied paths slipped through);
/// quotes group, and unbalanced quotes fail like shlex does.
fn split_command(line: &str) -> Option<Vec<String>> {
    if cfg!(windows) {
        split_windows(line)
    } else {
        shlex::split(line)
    }
}

fn split_windows(line: &str) -> Option<Vec<String>> {
    let (mut out, mut cur, mut quote, mut in_word) = (vec![], String::new(), None::<char>, false);
    for c in line.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => cur.push(c),
            None if c == '"' || c == '\'' => (quote, in_word) = (Some(c), true),
            None if c.is_whitespace() => {
                if in_word {
                    out.push(std::mem::take(&mut cur));
                    in_word = false;
                }
            }
            None => {
                cur.push(c);
                in_word = true;
            }
        }
    }
    if quote.is_some() {
        return None;
    }
    if in_word {
        out.push(cur);
    }
    Some(out)
}

fn looks_path_like(token: &str) -> bool {
    if token.is_empty() || token.starts_with('-') {
        return false;
    }
    if token.starts_with('~') || token.starts_with('.') || token.contains('/') || token.contains('\\') {
        return true;
    }
    Path::new(token).extension().map(|e| !e.is_empty()).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fnmatch_matches_python() {
        assert!(fnmatch("/a/b/.env", "**/.env"));
        assert!(fnmatch("/a/.env.local", "**/.env.*"));
        assert!(!fnmatch("/a/env", "**/.env"));
        assert!(fnmatch("foo.py", "*.py"));
        assert!(fnmatch("a/b.py", "*.py"), "fnmatch * crosses /");
        assert!(fnmatch("x1", "x[0-9]"));
        assert!(!fnmatch("xa", "x[!a]"));
    }

    #[test]
    fn the_credential_store_is_denied_to_file_and_shell_tools() {
        let tmp = tempfile::tempdir().unwrap();
        let d = DeniedPaths::new(&tmp.path().join("ws"), None);
        let cfg = &appv3_core::settings().config_dir;
        for f in [appv3_core::credentials::FILE_NAME, ".env.migrated"] {
            let p = cfg.join(f);
            assert!(d.validate_path(p.to_str().unwrap()).is_err(), "{f} writable");
            assert!(d.validate_read_path(p.to_str().unwrap()).is_err(), "{f} readable");
            assert!(d.check_command(&format!("cat {}", p.display())).is_some(), "{f} reachable from the shell");
        }
    }

    #[test]
    fn validate_denies_roots_and_patterns() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        let denied = tmp.path().join("data");
        std::fs::create_dir_all(&denied).unwrap();
        let d = DeniedPaths::with(&ws, None, Some(vec![denied.clone()]), Some(vec!["**/.env".into()]));
        assert!(d.validate_path("src/a.py").is_ok());
        assert!(d.validate_path(denied.join("x.db").to_str().unwrap()).is_err());
        assert!(d.validate_path(".env").is_err());
        if cfg!(windows) {
            assert!(d.validate_path(".ENV").is_err(), "Windows paths are case-insensitive");
        }
        assert!(d.validate_path("~/x").is_err());
        assert_eq!(d.display_path(&d.workspace_root.join("a/b.txt")), "a/b.txt");
        assert!(d.check_command(&format!("cat {}", denied.join("x").display())).is_some());
    }

    #[test]
    fn read_only_roots_allow_reads_but_not_writes_or_shell() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        let cache = tmp.path().join("cache");
        let skills = cache.join("v3-builtin-skills/self-healing/references");
        std::fs::create_dir_all(&skills).unwrap();
        std::fs::write(skills.join("mcp.md"), "x").unwrap();
        std::fs::write(cache.join("other.bin"), "x").unwrap();
        let mut d = DeniedPaths::with(&ws, None, Some(vec![cache.clone()]), Some(vec!["**/.env".into()]));
        d.read_only_roots = vec![resolve(&cache.join("v3-builtin-skills"))];
        let reference = skills.join("mcp.md");
        let reference = reference.to_str().unwrap();
        assert!(d.validate_read_path(reference).is_ok());
        assert!(d.validate_path(reference).is_err(), "write tools keep the cache denial");
        let resolved = resolve(Path::new(reference));
        assert!(!d.is_denied_read_path(&resolved));
        assert!(d.is_denied_path(&resolved));
        assert!(d.check_command(&format!("cat {reference}")).is_some(), "shell keeps the cache denial");
        assert!(d.validate_read_path(cache.join("other.bin").to_str().unwrap()).is_err(), "only the read-only root is exempt");
        assert!(d.validate_read_path(skills.join(".env").to_str().unwrap()).is_err(), "denied patterns still apply");
        assert!(d.validate_read_path("~/x").is_err());
    }

    #[test]
    fn windows_command_split_keeps_backslashes() {
        assert_eq!(split_windows(r#"type C:\data\x.db "C:\Program Files\a b" ''"#).unwrap(), vec!["type", r"C:\data\x.db", r"C:\Program Files\a b", ""]);
        assert_eq!(split_windows(r#"echo "unterminated"#), None);
    }
}
