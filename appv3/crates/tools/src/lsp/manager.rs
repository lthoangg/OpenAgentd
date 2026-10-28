//! Port of `app/services/lsp/manager.py`.

use super::client::{path_as_uri, py_list_repr, Event, LspClient};
use super::managed::{find_packaged_python_command, find_project_tsserver, managed_lsp_tools};
use super::{py_str, py_strip};
use crate::denied::resolve;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::task::JoinHandle;

const USER_PATH_TIMEOUT: Duration = Duration::from_secs(3);
const CLIENT_START_TIMEOUT: Duration = Duration::from_secs(15);
const PATH_OUTPUT_PREFIX: &str = "__OPENAGENTD_PATH__";
pub const MAX_DIAGNOSTICS_PER_FILE: usize = 20;
const UNSUPPORTED_TTL: Duration = Duration::from_secs(300);
const IDLE_STOP: Duration = Duration::from_secs(300);
const CLEANUP_INTERVAL: Duration = Duration::from_secs(60);

pub const EXTENSION_TO_LANG: &[(&str, &str)] = &[
    (".py", "python"),
    (".ts", "typescript"),
    (".tsx", "typescriptreact"),
    (".js", "javascript"),
    (".jsx", "javascriptreact"),
    (".go", "go"),
    (".c", "c"),
    (".cpp", "cpp"),
    (".h", "c"),
    (".hpp", "cpp"),
];

const TS_FAMILY: &[&str] = &["typescript", "typescriptreact", "javascript", "javascriptreact"];

fn ts_family(lang: &str) -> bool {
    TS_FAMILY.contains(&lang)
}

/// `Path.suffix.lower()` → language id.
pub fn lang_for_path(p: &Path) -> Option<&'static str> {
    let suffix = py_suffix(p)?.to_lowercase();
    EXTENSION_TO_LANG.iter().find(|(e, _)| *e == suffix).map(|(_, l)| *l)
}

/// Python `PurePath.suffix` (".tar.gz" → ".gz", ".bashrc" → "").
pub fn py_suffix(p: &Path) -> Option<String> {
    let name = p.file_name()?.to_string_lossy().into_owned();
    let i = name.rfind('.')?;
    if i == 0 || i + 1 == name.len() {
        return None;
    }
    Some(name[i..].to_string())
}

fn sv(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

fn python_multi_servers() -> Vec<Vec<String>> {
    vec![sv(&["ty", "server"]), sv(&["ruff", "server"]), sv(&["pyright-langserver", "--stdio"]), sv(&["pylsp"])]
}

/// `ruff` by name, also as a managed or packaged absolute path.
fn is_ruff(cmd: &[String]) -> bool {
    let name = Path::new(&cmd[0]).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    name == "ruff" || name == "ruff.exe"
}

/// Start `cmds` in order, keeping those that start. Python's type checkers
/// (ty, pyright, pylsp) overlap, so only the first one that starts runs, in
/// the order given (ty first); a later one is never started. ruff is a
/// linter and starts beside it. Other languages start every command.
async fn start_servers<T, F, Fut>(lang_id: &str, cmds: Vec<Vec<String>>, mut start: F) -> Vec<T>
where
    F: FnMut(Vec<String>) -> Fut,
    Fut: std::future::Future<Output = Option<T>>,
{
    let mut started = vec![];
    let mut have_checker = false;
    for cmd in cmds {
        let checker = lang_id == "python" && !is_ruff(&cmd);
        if checker && have_checker {
            continue;
        }
        if let Some(client) = start(cmd).await {
            have_checker |= checker;
            started.push(client);
        }
    }
    started
}

fn lsp_commands(lang: &str) -> Vec<Vec<String>> {
    match lang {
        "python" => vec![sv(&["pyright-langserver", "--stdio"]), sv(&["pylsp"]), sv(&["ruff", "server"])],
        l if ts_family(l) => vec![sv(&["typescript-language-server", "--stdio"]), sv(&["vtsls", "--stdio"])],
        "go" => vec![sv(&["gopls"])],
        "c" | "cpp" => vec![sv(&["clangd"])],
        _ => vec![],
    }
}

// ── login-shell PATH ────────────────────────────────────────────────────────

fn user_path_cache() -> &'static tokio::sync::Mutex<Option<String>> {
    static C: OnceLock<tokio::sync::Mutex<Option<String>>> = OnceLock::new();
    C.get_or_init(|| tokio::sync::Mutex::new(None))
}

/// The user's login-shell PATH, not the minimal GUI-app PATH.
pub async fn get_user_path(force_refresh: bool) -> String {
    let mut g = user_path_cache().lock().await;
    if let Some(p) = g.as_ref().filter(|_| !force_refresh) {
        return p.clone();
    }
    let probe = async {
        let shell_bin = crate::shell::acceptable();
        let argv = crate::shell::build_argv(&shell_bin, &format!("printf \"{PATH_OUTPUT_PREFIX}%s\\n\" \"$PATH\""));
        let child = appv3_core::proctree::hide_window(&mut tokio::process::Command::new(&shell_bin))
            .args(&argv)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| e.to_string())?;
        let out = tokio::time::timeout(USER_PATH_TIMEOUT, child.wait_with_output()).await.map_err(|_| "TimeoutError()".to_string())?.map_err(|e| e.to_string())?;
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout).into_owned();
            for line in text.lines().rev() {
                if let Some(rest) = line.strip_prefix(PATH_OUTPUT_PREFIX) {
                    let p = py_strip(rest);
                    if !p.is_empty() {
                        return Ok(Some(p.to_string()));
                    }
                }
            }
        }
        Ok::<_, String>(None)
    };
    match probe.await {
        Ok(Some(p)) => {
            *g = Some(p.clone());
            return p;
        }
        Ok(None) => {}
        Err(e) => tracing::debug!("lsp_login_shell_path_probe_failed error={}", e),
    }
    let p = std::env::var("PATH").unwrap_or_default();
    *g = Some(p.clone());
    p
}

/// Test seam: pre-seed (or clear) the cached login-shell PATH.
pub async fn set_cached_user_path(p: Option<String>) {
    *user_path_cache().lock().await = p;
}

// ── project root / detection ────────────────────────────────────────────────

pub fn find_project_root(file_path: &Path, workspace_root: &Path, lang_id: &str) -> PathBuf {
    let file_path = resolve(file_path);
    let workspace_root = resolve(workspace_root);
    let js_locks = ["bun.lockb", "bun.lock", "yarn.lock", "package-lock.json", "pnpm-lock.yaml"];
    let strong: Vec<&str> = match lang_id {
        "typescript" | "typescriptreact" => [&["tsconfig.json", "tsconfig.app.json"][..], &js_locks[..]].concat(),
        "javascript" | "javascriptreact" => [&["jsconfig.json"][..], &js_locks[..]].concat(),
        "rust" => vec!["Cargo.toml", "Cargo.lock"],
        "python" => vec!["pyproject.toml", "setup.py", "setup.cfg", "pyrightconfig.json", "venv", ".venv"],
        "go" => vec!["go.mod", "go.work"],
        "c" | "cpp" => vec!["compile_commands.json", "compile_flags.txt", ".clangd"],
        _ => vec![],
    };
    let weak: Vec<&str> = match lang_id {
        l if ts_family(l) => vec!["package.json"],
        "python" => vec!["requirements.txt", "Pipfile", "setup.cfg"],
        _ => vec![],
    };
    if strong.is_empty() && weak.is_empty() {
        return workspace_root;
    }
    let mut weak_candidate: Option<PathBuf> = None;
    let mut curr = file_path.parent().map(Path::to_path_buf).unwrap_or_else(|| file_path.clone());
    while curr.exists() && curr.parent().is_some() {
        for t in &strong {
            if curr.join(t).exists() {
                return curr;
            }
        }
        if weak.iter().any(|t| curr.join(t).exists()) {
            weak_candidate = Some(curr.clone());
        }
        if curr == workspace_root {
            break;
        }
        curr = curr.parent().unwrap().to_path_buf();
    }
    weak_candidate.unwrap_or(workspace_root)
}

fn load_pyproject(project_root: &Path) -> Option<Result<toml::Table, String>> {
    let p = project_root.join("pyproject.toml");
    if !p.exists() {
        return None;
    }
    Some(std::fs::read_to_string(&p).map_err(|e| e.to_string()).and_then(|t| t.parse::<toml::Table>().map_err(|e| e.message().to_string())))
}

fn toml_str(v: &toml::Value) -> String {
    match v {
        toml::Value::String(s) => s.clone(),
        toml::Value::Integer(i) => i.to_string(),
        toml::Value::Boolean(b) => {
            if *b {
                "True".into()
            } else {
                "False".into()
            }
        }
        _ => String::new(),
    }
}

fn toml_list(v: Option<&toml::Value>) -> Vec<String> {
    match v {
        Some(toml::Value::Array(a)) => a.iter().map(toml_str).collect(),
        Some(toml::Value::String(s)) => s.chars().map(String::from).collect(),
        _ => vec![],
    }
}

fn dependency_haystack(data: &toml::Table) -> Vec<String> {
    let mut out = vec![];
    let project = data.get("project").and_then(|p| p.as_table());
    if let Some(project) = project {
        out.extend(toml_list(project.get("dependencies")));
        if let Some(od) = project.get("optional-dependencies").and_then(|o| o.as_table()) {
            for g in od.values() {
                out.extend(toml_list(Some(g)));
            }
        }
    }
    if let Some(dg) = data.get("dependency-groups").and_then(|o| o.as_table()) {
        for g in dg.values() {
            out.extend(toml_list(Some(g)));
        }
    }
    out
}

/// `_split_dep_spec` — `(name, exact-version-or-None)`.
pub fn split_dep_spec(dep: &str) -> (String, Option<String>) {
    static EXTRAS: OnceLock<Regex> = OnceLock::new();
    static NAME: OnceLock<Regex> = OnceLock::new();
    let base = py_strip(dep.split(';').next().unwrap_or(""));
    let base = EXTRAS.get_or_init(|| Regex::new(r"\[[^\]]*\]").unwrap()).splitn(base, 2).next().unwrap_or("");
    let base = py_strip(base);
    let Some(m) = NAME.get_or_init(|| Regex::new(r"^[A-Za-z0-9_.-]+").unwrap()).find(base) else {
        return (String::new(), None);
    };
    let name = m.as_str().to_lowercase();
    let rest = py_strip(&base[m.end()..]);
    if let Some(v) = rest.strip_prefix("===") {
        return (name, Some(py_strip(v).to_string()));
    }
    if let Some(v) = rest.strip_prefix("==") {
        return (name, Some(py_strip(v).to_string()));
    }
    (name, None)
}

fn python_tools_from_pyproject(project_root: &Path) -> Vec<Vec<String>> {
    let data = match load_pyproject(project_root) {
        None => return vec![],
        Some(Err(e)) => {
            tracing::warn!("Failed to parse pyproject.toml for LSP detection: {}", e);
            return vec![];
        }
        Some(Ok(d)) => d,
    };
    let haystack = dependency_haystack(&data);
    let tool_tables: Vec<String> = data.get("tool").and_then(|t| t.as_table()).map(|t| t.keys().cloned().collect()).unwrap_or_default();
    let declares = |name: &str| tool_tables.iter().any(|t| t == name) || haystack.iter().any(|d| split_dep_spec(d).0 == name);
    let mut cmds = vec![];
    if declares("ty") {
        cmds.push(sv(&["ty", "server"]));
    }
    if declares("ruff") {
        cmds.push(sv(&["ruff", "server"]));
    }
    if declares("pyright") || project_root.join("pyrightconfig.json").exists() {
        cmds.push(sv(&["pyright-langserver", "--stdio"]));
    }
    if declares("python-lsp-server") || declares("pylsp") {
        cmds.push(sv(&["pylsp"]));
    }
    cmds
}

/// Exact `==` pins for ty/ruff (in declaration order).
pub fn detect_project_python_tool_versions(project_root: &Path) -> Vec<(String, Option<String>)> {
    let Some(Ok(data)) = load_pyproject(project_root) else {
        return vec![];
    };
    let mut out: Vec<(String, Option<String>)> = vec![];
    for dep in dependency_haystack(&data) {
        let (name, spec) = split_dep_spec(&dep);
        if (name == "ty" || name == "ruff") && !out.iter().any(|(n, _)| *n == name) {
            out.push((name, spec));
        }
    }
    out
}

pub fn detect_project_lsp_commands(lang_id: &str, project_root: &Path) -> Vec<Vec<String>> {
    if lang_id == "python" {
        return python_tools_from_pyproject(project_root);
    }
    if ts_family(lang_id) && ["package.json", "tsconfig.json", "jsconfig.json"].iter().any(|m| project_root.join(m).exists()) {
        return vec![sv(&["typescript-language-server", "--stdio"])];
    }
    vec![]
}

fn build_ts_init_options(project_root: &Path) -> Value {
    let mut options = Map::new();
    options.insert("preferences".into(), json!({"includeInlayParameterNameHints": "none"}));
    let tsserver = find_project_tsserver(project_root).or_else(|| managed_lsp_tools().typescript_command(project_root).map(|(_, t)| t));
    if let Some(t) = tsserver {
        options.insert("tsserver".into(), json!({"path": t.to_string_lossy()}));
    }
    let mut tsconfig_path = project_root.join("tsconfig.json");
    if !tsconfig_path.exists() {
        tsconfig_path = project_root.join("tsconfig.app.json");
    }
    if tsconfig_path.exists() {
        let parsed = std::fs::read_to_string(&tsconfig_path).map_err(|e| e.to_string()).and_then(|t| serde_json::from_str::<Value>(&t).map_err(|e| crate::py_json_error(&e)));
        match parsed {
            Ok(Value::Object(tsconfig)) => {
                let compiler = tsconfig.get("compilerOptions").cloned().unwrap_or(json!({}));
                let mut target = Map::new();
                if let Value::Object(c) = &compiler {
                    if let Some(t) = c.get("types") {
                        let list = match t {
                            Value::Array(a) => Value::Array(a.clone()),
                            Value::String(s) => Value::Array(s.chars().map(|c| json!(c.to_string())).collect()),
                            Value::Object(o) => Value::Array(o.keys().map(|k| json!(k)).collect()),
                            other => other.clone(),
                        };
                        target.insert("types".into(), list);
                    }
                    if let Some(p) = c.get("paths") {
                        target.insert("paths".into(), p.clone());
                    }
                    if let Some(b) = c.get("baseUrl") {
                        target.insert("baseUrl".into(), b.clone());
                    }
                }
                options.insert("compilerOptions".into(), Value::Object(target));
            }
            Ok(_) => tracing::warn!("Failed to read tsconfig for LSP init options: 'list' object has no attribute 'get'"),
            Err(e) => tracing::warn!("Failed to read tsconfig for LSP init options: {}", e),
        }
    }
    if project_root.join("bun.lockb").exists() || project_root.join("bun.lock").exists() {
        let co = options.entry("compilerOptions").or_insert_with(|| json!({}));
        if let Value::Object(co) = co {
            let types = co.entry("types").or_insert_with(|| json!([]));
            if let Value::Array(a) = types {
                if !a.iter().any(|t| t == "bun-types") {
                    a.push(json!("bun-types"));
                }
            }
        }
    }
    Value::Object(options)
}

fn build_python_init_options(project_root: &Path) -> Option<Value> {
    for name in [".venv", "venv", "env", ".env"] {
        let venv = project_root.join(name);
        if venv.is_dir() {
            let mut py = venv.join("bin/python");
            if !py.exists() {
                py = venv.join("Scripts/python.exe");
            }
            if py.exists() {
                return Some(json!({
                    "pythonPath": py.to_string_lossy(),
                    "venvPath": venv.parent().unwrap_or(Path::new("")).to_string_lossy(),
                    "venv": name,
                }));
            }
        }
    }
    None
}

pub fn build_init_options(lang_id: &str, project_root: &Path) -> Option<Value> {
    if ts_family(lang_id) {
        return Some(build_ts_init_options(project_root));
    }
    if lang_id == "python" {
        return build_python_init_options(project_root);
    }
    None
}

fn read_diagnostics_file(file_path: &Path) -> Result<(String, String), std::io::Error> {
    let resolved = resolve(file_path);
    let text = std::fs::read(&resolved)?;
    let text = String::from_utf8(text).map_err(|e| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("'utf-8' codec can't decode byte 0x{:02x} in position {}: invalid start byte", e.as_bytes()[e.utf8_error().valid_up_to()], e.utf8_error().valid_up_to()),
        )
    })?;
    Ok((path_as_uri(&resolved), text))
}

// ── manager ─────────────────────────────────────────────────────────────────

type ClientKey = (String, String, Vec<String>);
type InitKey = (String, String);

/// The language a server is keyed by: the TS family shares one server per
/// project, since `typescript-language-server` serves all four and the
/// language id is still sent with each document.
fn server_lang(lang_id: &str) -> &str {
    if ts_family(lang_id) {
        "typescript"
    } else {
        lang_id
    }
}

fn client_key(ws: &str, lang_id: &str, cmd: &[String]) -> ClientKey {
    (ws.to_string(), server_lang(lang_id).to_string(), cmd.to_vec())
}

pub struct LspManager {
    clients: Mutex<Vec<(ClientKey, Arc<LspClient>)>>,
    init_locks: Mutex<Vec<(InitKey, Arc<tokio::sync::Mutex<()>>)>>,
    cleanup: Mutex<Option<JoinHandle<()>>>,
    stopping: AtomicBool,
    unsupported: Mutex<HashMap<String, Instant>>,
}

pub fn lsp_manager() -> &'static LspManager {
    static M: OnceLock<LspManager> = OnceLock::new();
    M.get_or_init(LspManager::new)
}

impl Default for LspManager {
    fn default() -> Self {
        Self::new()
    }
}

impl LspManager {
    pub fn new() -> Self {
        Self { clients: Mutex::new(vec![]), init_locks: Mutex::new(vec![]), cleanup: Mutex::new(None), stopping: AtomicBool::new(false), unsupported: Mutex::new(HashMap::new()) }
    }

    fn get_client(&self, key: &ClientKey) -> Option<Arc<LspClient>> {
        self.clients.lock().unwrap().iter().find(|(k, _)| k == key).map(|(_, c)| c.clone())
    }
    fn set_client(&self, key: ClientKey, c: Arc<LspClient>) {
        let mut g = self.clients.lock().unwrap();
        if let Some(slot) = g.iter_mut().find(|(k, _)| *k == key) {
            slot.1 = c;
        } else {
            g.push((key, c));
        }
    }
    fn pop_client_if(&self, key: &ClientKey, c: &Arc<LspClient>) {
        self.clients.lock().unwrap().retain(|(k, x)| !(k == key && Arc::ptr_eq(x, c)));
    }
    fn init_lock(&self, key: InitKey) -> Arc<tokio::sync::Mutex<()>> {
        let mut g = self.init_locks.lock().unwrap();
        if let Some((_, l)) = g.iter().find(|(k, _)| *k == key) {
            return l.clone();
        }
        let l = Arc::new(tokio::sync::Mutex::new(()));
        g.push((key, l.clone()));
        l
    }

    /// Number of cached clients (diagnostic/test helper).
    pub fn client_count(&self) -> usize {
        self.clients.lock().unwrap().len()
    }

    fn is_unsupported(&self, lang: &str) -> bool {
        let mut g = self.unsupported.lock().unwrap();
        match g.get(lang) {
            None => false,
            Some(t) if t.elapsed() > UNSUPPORTED_TTL => {
                g.remove(lang);
                false
            }
            Some(_) => true,
        }
    }

    fn mark_unsupported(&self, lang: &str) {
        self.unsupported.lock().unwrap().insert(lang.to_string(), Instant::now());
    }

    pub fn start(&'static self) {
        let mut g = self.cleanup.lock().unwrap();
        if g.is_none() {
            *g = Some(tokio::spawn(async move { self.cleanup_loop().await }));
        }
    }

    async fn cleanup_loop(&self) {
        loop {
            tokio::time::sleep(CLEANUP_INTERVAL).await;
            self.cleanup_once(IDLE_STOP).await;
            if self.stopping.load(Ordering::SeqCst) {
                return;
            }
        }
    }

    /// One pass of `_cleanup_loop` (public for tests).
    pub async fn cleanup_once(&self, idle: Duration) {
        let snapshot: Vec<(ClientKey, Arc<LspClient>)> = self.clients.lock().unwrap().clone();
        let locks: Vec<(InitKey, Arc<tokio::sync::Mutex<()>>)> = self.init_locks.lock().unwrap().clone();
        for (init_key, lock) in locks {
            let _g = lock.lock().await;
            if self.stopping.load(Ordering::SeqCst) {
                return;
            }
            let mut to_remove = vec![];
            for (key, client) in snapshot.iter().filter(|(k, _)| k.0 == init_key.0 && k.1 == init_key.1) {
                if !self.get_client(key).map(|c| Arc::ptr_eq(&c, client)).unwrap_or(false) {
                    continue;
                }
                if client.last_used_at().elapsed() > idle {
                    tracing::info!("Stopping idle LSP client for key={}", key_repr(key));
                    client.stop().await;
                    to_remove.push((key.clone(), client.clone()));
                } else if client.process_died() {
                    tracing::warn!("LSP client process died for key={}", key_repr(key));
                    client.stop().await;
                    to_remove.push((key.clone(), client.clone()));
                }
            }
            for (k, c) in to_remove {
                self.pop_client_if(&k, &c);
            }
        }
    }

    pub async fn detect_commands(&self, lang_id: &str, project_root: Option<&Path>, semantic_only: bool) -> Vec<Vec<String>> {
        let user_path = get_user_path(false).await;
        let declared: Vec<(String, Option<String>)> = match (lang_id, project_root) {
            ("python", Some(r)) => detect_project_python_tool_versions(r),
            _ => vec![],
        };
        let resolve_cmd = |cmd: &Vec<String>| -> Option<Vec<String>> {
            if super::which_in(&cmd[0], &user_path).is_some() {
                return Some(cmd.clone());
            }
            if cmd[0] == "ty" || cmd[0] == "ruff" {
                if let Some(p) = find_packaged_python_command(&cmd[0]) {
                    return Some(p);
                }
                let v = declared.iter().find(|(n, _)| *n == cmd[0]).and_then(|(_, v)| v.clone());
                if let Some(m) = managed_lsp_tools().python_tool_command(&cmd[0], v.as_deref()) {
                    return Some(m);
                }
            }
            None
        };
        let semantic_ok = |cmd: &Vec<String>| lang_id != "python" || !is_ruff(cmd);
        if let Some(root) = project_root {
            let project_cmds =
                || -> Vec<Vec<String>> { detect_project_lsp_commands(lang_id, root).iter().filter_map(&resolve_cmd).filter(|r| !semantic_only || semantic_ok(r)).collect() };
            let first = project_cmds();
            if !first.is_empty() {
                // Every diagnostics pass resolves this; debug keeps it out of the info log.
                tracing::debug!("Using project-configured LSP for {}: {}", lang_id, cmds_repr(&first));
                return first;
            }
            if lang_id == "python" && !declared.is_empty() {
                for (tool, version) in &declared {
                    managed_lsp_tools().ensure_python_tool(tool, version.as_deref()).await;
                }
                let second = project_cmds();
                if !second.is_empty() {
                    tracing::info!("Using managed Python LSP for {}: {}", lang_id, cmds_repr(&second));
                    return second;
                }
            }
        }
        match appv3_core::runtime_settings::load_runtime_settings() {
            Ok(cfg) => {
                let mut custom = cfg.lsp.get(lang_id).cloned().unwrap_or_default();
                if custom.is_empty() && lang_id == "typescriptreact" {
                    custom = cfg.lsp.get("typescript").cloned().unwrap_or_default();
                } else if custom.is_empty() && lang_id == "javascriptreact" {
                    custom = cfg.lsp.get("javascript").cloned().unwrap_or_default();
                }
                if !custom.is_empty() && (!semantic_only || semantic_ok(&custom)) {
                    return vec![custom];
                }
            }
            Err(e) => tracing::warn!("Failed to load runtime settings for LSP command: {}", e),
        }
        if lang_id == "python" {
            return python_multi_servers().iter().filter_map(&resolve_cmd).filter(|r| !semantic_only || semantic_ok(r)).collect();
        }
        for cmd in lsp_commands(lang_id) {
            if resolve_cmd(&cmd).is_some() {
                return vec![cmd];
            }
        }
        if let (Some(root), true) = (project_root, ts_family(lang_id)) {
            if let Some((cmd, _)) = managed_lsp_tools().typescript_command(root) {
                return vec![cmd];
            }
            managed_lsp_tools().announce_typescript_required(root).await;
        }
        vec![]
    }

    pub async fn get_clients(&self, workspace_root: &Path, lang_id: &str, semantic_only: bool) -> Vec<Arc<LspClient>> {
        if self.is_unsupported(lang_id) {
            return vec![];
        }
        let ws = workspace_root.to_string_lossy().into_owned();
        let lock = self.init_lock((ws.clone(), server_lang(lang_id).to_string()));
        let _g = lock.lock().await;
        if self.stopping.load(Ordering::SeqCst) {
            return vec![];
        }
        let cmds = self.detect_commands(lang_id, Some(workspace_root), semantic_only).await;
        if cmds.is_empty() {
            tracing::info!("No LSP server found for language: {}", lang_id);
            if !semantic_only && !ts_family(lang_id) {
                self.mark_unsupported(lang_id);
            }
            return vec![];
        }
        let clients = start_servers(lang_id, cmds, |cmd| self.start_client(&ws, workspace_root, lang_id, cmd)).await;
        if clients.is_empty() && !semantic_only {
            self.mark_unsupported(lang_id);
        }
        clients
    }

    /// The cached client for `cmd` if it still runs, else a newly started one.
    async fn start_client(&self, ws: &str, workspace_root: &Path, lang_id: &str, cmd: Vec<String>) -> Option<Arc<LspClient>> {
        let key = client_key(ws, lang_id, &cmd);
        if let Some(existing) = self.get_client(&key) {
            if existing.is_running() {
                return Some(existing);
            }
            existing.stop().await;
            self.pop_client_if(&key, &existing);
        }
        let mut env: Vec<(String, String)> = std::env::vars().filter(|(k, _)| k != "PATH").collect();
        env.push(("PATH".into(), get_user_path(false).await));
        let client = Arc::new(LspClient::new(cmd.clone(), workspace_root.to_path_buf(), build_init_options(lang_id, workspace_root), Some(env)));
        match tokio::time::timeout(CLIENT_START_TIMEOUT, client.start()).await {
            Ok(Ok(())) => {
                self.set_client(key, client.clone());
                return Some(client);
            }
            Ok(Err(e)) => tracing::warn!("Failed to start LSP client {} for {}: {}", py_list_repr(&cmd), lang_id, e),
            Err(_) => tracing::warn!("Timed out starting LSP client {} for {} after {}s", py_list_repr(&cmd), lang_id, CLIENT_START_TIMEOUT.as_secs_f64()),
        }
        client.stop().await;
        None
    }

    pub async fn get_diagnostics(&self, file_path: &Path, workspace_root: &Path) -> Vec<Value> {
        let Some(lang_id) = lang_for_path(file_path) else {
            return vec![];
        };
        let (f, w) = (file_path.to_path_buf(), workspace_root.to_path_buf());
        let proj_root = tokio::task::spawn_blocking(move || find_project_root(&f, &w, lang_id)).await.unwrap_or_else(|_| workspace_root.to_path_buf());
        let clients = self.get_clients(&proj_root, lang_id, false).await;
        if clients.is_empty() {
            return vec![];
        }
        let (uri, content) = match read_diagnostics_file(file_path) {
            Ok(x) => x,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                tracing::debug!("LSP diagnostics skipped, file not found: {}", file_path.display());
                return vec![];
            }
            Err(e) => {
                tracing::warn!("Failed to read file for LSP diagnostics: {}", super::py_os_error(&e, &file_path.to_string_lossy()));
                return vec![];
            }
        };
        let results = futures::future::join_all(clients.iter().map(|c| self.diagnostics_from(c, &uri, lang_id, &content))).await;
        results.into_iter().flatten().collect()
    }

    async fn diagnostics_from(&self, client: &LspClient, uri: &str, lang_id: &str, content: &str) -> Vec<Value> {
        let lock = client.diagnostics_lock(uri);
        let _g = lock.lock().await;
        let event = client.reset_diagnostics(uri);
        if let Err(e) = client.open_or_update_document(uri, lang_id, content).await {
            tracing::error!("Failed to open document on LSP server: {}", e);
            return vec![];
        }
        let ts = ts_family(lang_id);
        let current = || client.get_diagnostics(uri);
        let diags = if ts {
            await_settled(current, &event, Some(ts_problem_count(client, uri)), 10.0, 1.0).await
        } else {
            await_settled(current, &event, None::<std::future::Ready<Result<usize, String>>>, 3.0, 0.25).await
        };
        if let Err(e) = client.close_document(uri).await {
            tracing::warn!("Failed to send didClose to LSP: {}", e);
        }
        diags
    }

    /// Compact, read-only navigation request against LSP clients.
    pub async fn navigation(&self, operation: &str, workspace_root: &Path, file_path: Option<&Path>, line: i64, character: i64, query: &str) -> Vec<Value> {
        let method = match operation {
            "go_to_definition" => "textDocument/definition",
            "find_references" => "textDocument/references",
            "document_symbol" => "textDocument/documentSymbol",
            "workspace_symbol" => "workspace/symbol",
            "hover" => "textDocument/hover",
            "find_implementations" => "textDocument/implementation",
            _ => return vec![],
        };
        let Some(file_path) = file_path else {
            return vec![];
        };
        let Some(lang_id) = lang_for_path(file_path) else {
            return vec![];
        };
        let project_root = find_project_root(file_path, workspace_root, lang_id);
        let clients = self.get_clients(&project_root, lang_id, true).await;
        if clients.is_empty() {
            return vec![];
        }
        let uri = path_as_uri(&resolve(file_path));
        let Ok(bytes) = std::fs::read(file_path) else {
            return vec![];
        };
        let Ok(content) = String::from_utf8(bytes) else {
            return vec![];
        };
        let params = match operation {
            "workspace_symbol" => json!({"query": query}),
            "document_symbol" => json!({"textDocument": {"uri": uri}}),
            _ => {
                let mut p = json!({"textDocument": {"uri": uri}, "position": {"line": line, "character": character}});
                if operation == "find_references" {
                    p["context"] = json!({"includeDeclaration": true});
                }
                p
            }
        };
        let request = |client: Arc<LspClient>, m: &'static str| {
            let (uri, content, params) = (uri.clone(), content.clone(), params.clone());
            async move {
                let lock = client.diagnostics_lock(&uri);
                let _g = lock.lock().await;
                let r = async {
                    client.open_or_update_document(&uri, lang_id, &content).await?;
                    match tokio::time::timeout(Duration::from_secs(5), client.send_request(m, Some(params))).await {
                        Ok(r) => r,
                        Err(_) => Err("TimeoutError".to_string()),
                    }
                }
                .await;
                let _ = client.close_document(&uri).await;
                r
            }
        };
        let collect = |responses: &[Result<Value, String>]| -> Vec<Value> {
            let mut out = vec![];
            fn flatten(op: &str, uri: &str, symbol: &Map<String, Value>, out: &mut Vec<Value>) {
                let mut symbol = symbol.clone();
                if op == "document_symbol" && !symbol.contains_key("location") {
                    let range = symbol.get("selectionRange").or_else(|| symbol.get("range")).cloned();
                    if let Some(r @ Value::Object(_)) = range {
                        symbol.insert("location".into(), json!({"uri": uri, "range": r}));
                    }
                }
                let children = symbol.get("children").cloned();
                out.push(Value::Object(symbol));
                if op == "document_symbol" {
                    if let Some(Value::Array(ch)) = children {
                        for c in ch {
                            if let Value::Object(c) = c {
                                flatten(op, uri, &c, out);
                            }
                        }
                    }
                }
            }
            for r in responses.iter().flatten() {
                match r {
                    Value::Array(items) => {
                        for i in items {
                            if let Value::Object(o) = i {
                                flatten(operation, &uri, o, &mut out);
                            }
                        }
                    }
                    Value::Object(o) => flatten(operation, &uri, o, &mut out),
                    _ => {}
                }
            }
            out
        };
        let responses = futures::future::join_all(clients.iter().map(|c| request(c.clone(), method))).await;
        let has_exc = responses.iter().any(|r| r.is_err());
        let mut results = collect(&responses);
        if operation == "go_to_definition" && results.is_empty() && !has_exc {
            let mut futs = vec![];
            for c in &clients {
                futs.push(request(c.clone(), "textDocument/declaration"));
            }
            for c in &clients {
                futs.push(request(c.clone(), "textDocument/typeDefinition"));
            }
            let fb = futures::future::join_all(futs).await;
            results = collect(&fb);
        }
        results
    }

    pub async fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        let task = self.cleanup.lock().unwrap().take();
        if let Some(t) = task {
            t.abort();
            let _ = t.await;
        }
        let locks: Vec<(InitKey, Arc<tokio::sync::Mutex<()>>)> = self.init_locks.lock().unwrap().clone();
        for (init_key, lock) in locks {
            let _g = lock.lock().await;
            let matching: Vec<(ClientKey, Arc<LspClient>)> = self.clients.lock().unwrap().iter().filter(|(k, _)| k.0 == init_key.0 && k.1 == init_key.1).cloned().collect();
            for (k, c) in matching {
                tracing::info!("Stopping LSP client for key={}", key_repr(&k));
                c.stop().await;
                self.pop_client_if(&k, &c);
            }
        }
        self.stopping.store(false, Ordering::SeqCst);
    }
}

fn cmds_repr(cmds: &[Vec<String>]) -> String {
    format!("[{}]", cmds.iter().map(|c| py_list_repr(c)).collect::<Vec<_>>().join(", "))
}

fn key_repr(k: &ClientKey) -> String {
    let tuple =
        if k.2.len() == 1 { format!("({},)", crate::py_repr_str(&k.2[0])) } else { format!("({})", k.2.iter().map(|s| crate::py_repr_str(s)).collect::<Vec<_>>().join(", ")) };
    format!("({}, {}, {})", crate::py_repr_str(&k.0), crate::py_repr_str(&k.1), tuple)
}

/// Ask a TypeScript server, through `typescript.tsserverRequest`, how many
/// syntax and type errors and warnings the open file has. tsserver answers
/// these synchronous requests only after checking the file, so the answer
/// says when the check is done: a clean file needs no quiet-period wait.
async fn ts_problem_count(client: &LspClient, uri: &str) -> Result<usize, String> {
    let ask = |kind: &'static str| client.send_request("workspace/executeCommand", Some(json!({"command": "typescript.tsserverRequest", "arguments": [kind, {"file": uri}]})));
    let (syntactic, semantic) = futures::future::join(ask("syntacticDiagnosticsSync"), ask("semanticDiagnosticsSync")).await;
    Ok(ts_problems(&syntactic?)? + ts_problems(&semantic?)?)
}

/// Errors and warnings in a tsserver diagnostics response (suggestions are
/// hints, which the report leaves out anyway).
fn ts_problems(response: &Value) -> Result<usize, String> {
    if response.get("success") != Some(&Value::Bool(true)) {
        return Err("tsserver request failed".into());
    }
    let Some(Value::Array(body)) = response.get("body") else {
        return Err("tsserver response has no diagnostics".into());
    };
    Ok(body.iter().filter(|d| matches!(d.get("category").and_then(Value::as_str), Some("error" | "warning"))).count())
}

/// Wait for the diagnostics of a just-opened document. Published problems
/// return at once. A clean result is only final once the server has had time
/// to publish late passes (TypeScript publishes syntax, then semantic
/// diagnostics): with a `check` that reports when the server has checked the
/// file, a clean answer returns as soon as it says so; without one (or if it
/// fails) the result must stay quiet for `settle` seconds.
async fn await_settled<B>(current: impl Fn() -> Vec<Value>, event: &Event, check: Option<B>, overall: f64, settle: f64) -> Vec<Value>
where
    B: std::future::Future<Output = Result<usize, String>>,
{
    let deadline = tokio::time::Instant::now() + Duration::from_secs_f64(overall);
    let Some(check) = check else {
        return await_quiet(&current, event, deadline, settle).await;
    };
    tokio::pin!(check);
    let mut checked = false;
    loop {
        event.clear();
        let diags = current();
        if !diags.is_empty() {
            return diags;
        }
        tokio::select! {
            _ = event.wait() => {}
            problems = &mut check, if !checked => {
                checked = true;
                match problems {
                    Ok(0) => return current(),
                    // Problems found: wait for the publish that carries them.
                    Ok(_) => {}
                    Err(e) => {
                        tracing::debug!("lsp_check_unavailable error={}", e);
                        return await_quiet(&current, event, deadline, settle).await;
                    }
                }
            }
            _ = tokio::time::sleep_until(deadline) => {
                tracing::warn!("Timeout waiting for LSP diagnostics");
                return current();
            }
        }
    }
}

/// The first publish, then `settle` seconds without a newer one.
async fn await_quiet(current: &impl Fn() -> Vec<Value>, event: &Event, deadline: tokio::time::Instant, settle: f64) -> Vec<Value> {
    if tokio::time::timeout_at(deadline, event.wait()).await.is_err() {
        tracing::warn!("Timeout waiting for LSP diagnostics");
        return current();
    }
    if !current().is_empty() {
        return current();
    }
    loop {
        event.clear();
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        let wait = remaining.min(Duration::from_secs_f64(settle));
        if tokio::time::timeout(wait, event.wait()).await.is_err() {
            break;
        }
        if !current().is_empty() {
            break;
        }
    }
    current()
}

// ── report formatting ───────────────────────────────────────────────────────

fn num_or(v: Option<&Value>, default: f64) -> Value {
    match v {
        Some(n @ Value::Number(_)) => n.clone(),
        Some(Value::Bool(b)) => json!(*b as i64),
        _ => json!(default as i64),
    }
}

fn num_f(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}

fn plus_one(v: &Value) -> String {
    match v {
        Value::Number(n) if n.is_f64() => appv3_core::pyjson::float_repr(n.as_f64().unwrap_or(0.0) + 1.0),
        Value::Number(n) => (n.as_i64().unwrap_or(0) + 1).to_string(),
        _ => "1".into(),
    }
}

fn start_of(d: &Value) -> Map<String, Value> {
    d.get("range").and_then(|r| r.get("start")).and_then(|s| s.as_object()).cloned().unwrap_or_default()
}

/// Format errors/warnings for *file_path* as the `[LSP Diagnostics]` block.
pub fn format_diagnostics(diagnostics: &[Value], file_path: &Path, workspace_root: &Path) -> Option<String> {
    if diagnostics.is_empty() {
        return None;
    }
    let rel_path = match file_path.strip_prefix(workspace_root) {
        Ok(r) => {
            let s = r.to_string_lossy().into_owned();
            if s.is_empty() {
                ".".into()
            } else {
                s
            }
        }
        Err(_) => file_path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
    };
    let severity = |d: &Value| num_or(d.get("severity"), 1.0);
    let mut relevant: Vec<&Value> = diagnostics
        .iter()
        .filter(|d| match d.get("severity") {
            None => true,
            Some(Value::Number(n)) => n.as_f64() == Some(1.0) || n.as_f64() == Some(2.0),
            Some(Value::Bool(true)) => true,
            _ => false,
        })
        .collect();
    relevant.sort_by(|a, b| {
        let ka = (num_f(&severity(a)), num_f(&num_or(start_of(a).get("line"), 0.0)), num_f(&num_or(start_of(a).get("character"), 0.0)));
        let kb = (num_f(&severity(b)), num_f(&num_or(start_of(b).get("line"), 0.0)), num_f(&num_or(start_of(b).get("character"), 0.0)));
        ka.partial_cmp(&kb).unwrap_or(std::cmp::Ordering::Equal)
    });
    if relevant.is_empty() {
        return None;
    }
    let total = relevant.len();
    let capped = &relevant[..total.min(MAX_DIAGNOSTICS_PER_FILE)];
    type Group = ((bool, String, String), Vec<(String, String)>);
    let mut grouped: Vec<Group> = vec![];
    for d in capped {
        let is_error = num_f(&severity(d)) == 1.0;
        let msg = match d.get("message") {
            None => String::new(),
            Some(Value::String(s)) => py_strip(s).to_string(),
            Some(other) => py_strip(&py_str(other)).to_string(),
        };
        let source = match d.get("source") {
            None => "LSP".to_string(),
            Some(v) => py_str(v),
        };
        let start = start_of(d);
        let loc = (plus_one(&num_or(start.get("line"), 0.0)), plus_one(&num_or(start.get("character"), 0.0)));
        let key = (is_error, msg, source);
        match grouped.iter_mut().find(|(k, _)| *k == key) {
            Some((_, locs)) => locs.push(loc),
            None => grouped.push((key, vec![loc])),
        }
    }
    let mut lines = vec![];
    for ((is_error, msg, source), locs) in &grouped {
        let sev = if *is_error { "error" } else { "warning" };
        let mut loc = format!("{rel_path}:{}:{}", locs[0].0, locs[0].1);
        for (l, c) in &locs[1..] {
            loc.push_str(&format!(", {l}:{c}"));
        }
        lines.push(format!("- {loc}: {sev}: {msg} ({source})"));
    }
    if total > capped.len() {
        lines.push(format!("- …and {} more in {rel_path}", total - capped.len()));
    }
    Some(format!("[LSP Diagnostics]\n{}", lines.join("\n")))
}

/// Run LSP diagnostics on the given file and return a formatted report.
pub async fn check_lsp_diagnostics(file_path: &Path, workspace_root: &Path) -> Option<String> {
    let diagnostics = lsp_manager().get_diagnostics(file_path, workspace_root).await;
    format_diagnostics(&diagnostics, file_path, workspace_root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dep_specs() {
        assert_eq!(split_dep_spec("ruff==0.16.1"), ("ruff".into(), Some("0.16.1".into())));
        assert_eq!(split_dep_spec("ty>=0.0.33,<0.1"), ("ty".into(), None));
        assert_eq!(split_dep_spec("Ruff[x] === 1.2 ; python_version>'3'"), ("ruff".into(), None));
        assert_eq!(split_dep_spec("Ruff === 1.2 ; python_version>'3'"), ("ruff".into(), Some("1.2".into())));
        assert_eq!(split_dep_spec("  "), ("".into(), None));
    }

    #[test]
    fn suffixes() {
        assert_eq!(py_suffix(Path::new("a/b.PY")), Some(".PY".into()));
        assert_eq!(py_suffix(Path::new(".bashrc")), None);
        assert_eq!(lang_for_path(Path::new("x.tsx")), Some("typescriptreact"));
    }

    /// One `typescript-language-server` serves `.ts`, `.tsx`, `.js` and
    /// `.jsx`; keying it by language started a second server per project.
    #[test]
    fn ts_family_files_share_one_server_per_project_and_command() {
        let cmd = sv(&["typescript-language-server", "--stdio"]);
        let ts = client_key("/w", "typescript", &cmd);
        for lang in ["typescriptreact", "javascript", "javascriptreact"] {
            assert_eq!(client_key("/w", lang, &cmd), ts, "{lang}");
        }
        assert_ne!(client_key("/other", "typescript", &cmd), ts, "a project gets its own server");
        assert_ne!(client_key("/w", "typescript", &sv(&["other-ts-server"])), ts, "a different command is a different server");
        assert_ne!(client_key("/w", "python", &sv(&["ty", "server"])).1, ts.1);
    }

    /// Start `cmds` with a fake launcher: names in `failing` fail to start.
    /// Returns what started and every attempt, in order.
    async fn start_with(lang: &str, cmds: &[&[&str]], failing: &[&str]) -> (Vec<String>, Vec<String>) {
        let attempts = Mutex::new(vec![]);
        let started = start_servers(lang, cmds.iter().map(|c| sv(c)).collect(), |cmd| {
            attempts.lock().unwrap().push(cmd[0].clone());
            let ok = !failing.contains(&cmd[0].as_str());
            async move { ok.then(|| cmd[0].clone()) }
        })
        .await;
        (started, attempts.into_inner().unwrap())
    }

    #[tokio::test]
    async fn python_runs_one_type_checker_beside_ruff() {
        let all: &[&[&str]] = &[&["ty", "server"], &["ruff", "server"], &["pyright-langserver", "--stdio"], &["pylsp"]];
        // ty wins; pyright and pylsp are never started.
        let (started, attempts) = start_with("python", all, &[]).await;
        assert_eq!(started, ["ty", "ruff"]);
        assert_eq!(attempts, ["ty", "ruff"]);
        // ty fails to start: pyright takes over, pylsp still skipped.
        let (started, _) = start_with("python", all, &["ty"]).await;
        assert_eq!(started, ["ruff", "pyright-langserver"]);
        // Only pylsp left.
        let (started, _) = start_with("python", all, &["ty", "pyright-langserver"]).await;
        assert_eq!(started, ["ruff", "pylsp"]);
        // A managed ruff is an absolute path; it is still the linter.
        let (started, _) = start_with("python", &[&["/cache/ruff-0.1/ruff", "server"], &["ty", "server"]], &[]).await;
        assert_eq!(started, ["/cache/ruff-0.1/ruff", "ty"]);
    }

    #[tokio::test]
    async fn other_languages_start_every_command() {
        let (started, _) = start_with("go", &[&["gopls"], &["other"]], &[]).await;
        assert_eq!(started, ["gopls", "other"]);
    }

    #[test]
    fn report_groups_and_caps() {
        let mut diags = vec![];
        for i in 0..22 {
            diags.push(json!({"severity": 2, "message": " dup ", "source": "ruff", "range": {"start": {"line": i, "character": 0}}}));
        }
        diags.push(json!({"severity": 1, "message": "boom", "range": {"start": {"line": 3, "character": 4}}}));
        diags.push(json!({"severity": 3, "message": "info"}));
        let r = format_diagnostics(&diags, Path::new("/w/a.py"), Path::new("/w")).unwrap();
        assert!(r.starts_with("[LSP Diagnostics]\n- a.py:4:5: error: boom (LSP)\n- a.py:1:1, 2:1"));
        assert!(r.ends_with("- …and 3 more in a.py"));
    }

    /// A fake server: publishes `diags` after `ms` milliseconds (paused time).
    fn publish_after(store: &Arc<Mutex<Vec<Value>>>, event: &Arc<Event>, ms: u64, diags: Vec<Value>) {
        let (store, event) = (store.clone(), event.clone());
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            *store.lock().unwrap() = diags;
            event.set();
        });
    }

    async fn check_after(ms: u64, answer: Result<usize, String>) -> Result<usize, String> {
        tokio::time::sleep(Duration::from_millis(ms)).await;
        answer
    }

    fn error_diag() -> Value {
        json!({"severity": 1, "message": "Type 'string' is not assignable to type 'number'."})
    }

    /// Waits as the TypeScript path does, returning the result and how long it took.
    async fn settle_ts(store: &Arc<Mutex<Vec<Value>>>, event: &Arc<Event>, check: impl std::future::Future<Output = Result<usize, String>>) -> (Vec<Value>, u128) {
        let start = tokio::time::Instant::now();
        let got = await_settled(|| store.lock().unwrap().clone(), event, Some(check), 10.0, 1.0).await;
        (got, start.elapsed().as_millis())
    }

    #[tokio::test(start_paused = true)]
    async fn a_clean_typescript_file_returns_when_the_server_says_it_checked_it() {
        let (store, event) = (Arc::new(Mutex::new(vec![])), Arc::new(Event::default()));
        // A warm typescript-language-server answers the check before it
        // publishes the empty result.
        publish_after(&store, &event, 360, vec![]);
        let (got, ms) = settle_ts(&store, &event, check_after(30, Ok(0))).await;
        assert!(got.is_empty());
        assert_eq!(ms, 30, "no quiet-period wait after a clean check");
    }

    #[tokio::test(start_paused = true)]
    async fn a_broken_typescript_file_still_reports_its_error() {
        let (store, event) = (Arc::new(Mutex::new(vec![])), Arc::new(Event::default()));
        // The syntax pass publishes nothing; the type error arrives later.
        publish_after(&store, &event, 100, vec![]);
        publish_after(&store, &event, 650, vec![error_diag()]);
        let (got, ms) = settle_ts(&store, &event, check_after(600, Ok(1))).await;
        assert_eq!(got, vec![error_diag()]);
        assert_eq!(ms, 650);
    }

    #[tokio::test(start_paused = true)]
    async fn a_late_error_on_a_cold_server_is_still_caught() {
        let (store, event) = (Arc::new(Mutex::new(vec![])), Arc::new(Event::default()));
        // A cold project: the first empty publish comes early, the check takes
        // seconds, and the error is published well past the 1 s quiet period.
        publish_after(&store, &event, 200, vec![]);
        publish_after(&store, &event, 5_200, vec![error_diag()]);
        let (got, _) = settle_ts(&store, &event, check_after(5_100, Ok(1))).await;
        assert_eq!(got, vec![error_diag()]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_server_without_the_check_falls_back_to_the_quiet_period() {
        let (store, event) = (Arc::new(Mutex::new(vec![])), Arc::new(Event::default()));
        publish_after(&store, &event, 300, vec![]);
        let (got, ms) = settle_ts(&store, &event, check_after(5, Err("Unknown command".into()))).await;
        assert!(got.is_empty());
        assert_eq!(ms, 1_300, "first publish, then 1 s of quiet");
    }

    #[tokio::test(start_paused = true)]
    async fn problems_that_are_never_published_end_at_the_deadline() {
        let (store, event) = (Arc::new(Mutex::new(vec![])), Arc::new(Event::default()));
        let (got, ms) = settle_ts(&store, &event, check_after(50, Ok(2))).await;
        assert!(got.is_empty());
        assert_eq!(ms, 10_000);
    }

    #[tokio::test(start_paused = true)]
    async fn other_languages_keep_the_quiet_period() {
        let (store, event) = (Arc::new(Mutex::new(vec![])), Arc::new(Event::default()));
        publish_after(&store, &event, 100, vec![]);
        let start = tokio::time::Instant::now();
        let got = await_settled(|| store.lock().unwrap().clone(), &event, None::<std::future::Ready<Result<usize, String>>>, 3.0, 0.25).await;
        assert!(got.is_empty());
        assert_eq!(start.elapsed().as_millis(), 350);
    }

    #[test]
    fn tsserver_responses_count_errors_and_warnings_only() {
        let body = json!({"success": true, "body": [{"category": "error"}, {"category": "warning"}, {"category": "suggestion"}, {"category": "message"}]});
        assert_eq!(ts_problems(&body), Ok(2));
        assert_eq!(ts_problems(&json!({"success": true, "body": []})), Ok(0));
        assert!(ts_problems(&json!({"success": false, "message": "Unknown command"})).is_err());
        assert!(ts_problems(&Value::Null).is_err());
    }

    /// Against a real `typescript-language-server`, in a throwaway project:
    /// `OAD_TS_PROBE=<project>/a.ts cargo test -p appv3-tools --lib real_typescript -- --ignored --nocapture`
    /// (the folder needs a `tsconfig.json` and `node_modules/typescript`).
    #[tokio::test]
    #[ignore]
    async fn real_typescript_server_reports_errors_and_skips_the_wait_when_clean() {
        let file = PathBuf::from(std::env::var("OAD_TS_PROBE").expect("OAD_TS_PROBE=<file.ts>"));
        let root = file.parent().unwrap().to_path_buf();
        let clean = std::fs::read_to_string(&file).unwrap();
        let broken = format!("{clean}\nexport const probe: number = \"text\";\n");
        for (label, text, expect_error) in
            [("cold clean", &clean, false), ("warm clean", &clean, false), ("warm broken", &broken, true), ("warm clean", &clean, false), ("warm broken", &broken, true)]
        {
            std::fs::write(&file, text).unwrap();
            let started = std::time::Instant::now();
            let report = check_lsp_diagnostics(&file, &root).await;
            println!("{label}: {} ms, report: {}", started.elapsed().as_millis(), report.as_deref().unwrap_or("none").replace('\n', " | "));
            assert_eq!(report.as_deref().is_some_and(|r| r.contains("not assignable")), expect_error, "{label}");
        }
        std::fs::write(&file, &clean).unwrap();
    }
}
