//! Port of `app/services/lsp/managed.py` — managed Bun/TypeScript LSP and
//! on-demand PyPI ruff/ty wheels under `{CACHE_DIR}/lsp`.

use super::is_executable;
use regex::Regex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant};

pub const BUN_VERSION: &str = "1.3.14";
pub const TYPESCRIPT_LANGUAGE_SERVER_VERSION: &str = "6.0.0";
pub const TYPESCRIPT_VERSION: &str = "6.0.3";
const MAX_DOWNLOAD_BYTES: u64 = 150 * 1024 * 1024;
const INSTALL_PROMPT_COOLDOWN: Duration = Duration::from_secs(300);
pub const PYTHON_TOOL_NAMES: [&str; 2] = ["ruff", "ty"];
const MAX_MANAGED_PYTHON_VERSIONS: usize = 2;

const RESOURCE_PACKAGE_JSON: &[u8] = include_bytes!("../../resources/lsp/package.json");
const RESOURCE_BUN_LOCK: &[u8] = include_bytes!("../../resources/lsp/bun.lock");

const BUN_ASSETS: &[(&str, &str, &str, &str)] = &[
    ("darwin", "arm64", "bun-darwin-aarch64.zip", "d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620"),
    ("darwin", "x86_64", "bun-darwin-x64-baseline.zip", "3e35ad6f53971a9834bf9e6786e2adf72b5f1921cc9a9c5fde073d2972944076"),
    ("linux", "aarch64", "bun-linux-aarch64.zip", "a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b"),
    ("linux", "x86_64", "bun-linux-x64-baseline.zip", "a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7"),
    ("linux-musl", "aarch64", "bun-linux-aarch64-musl.zip", "b98e0ad3625c5c00d1d5b5ff55605c7adddbfae151861e68ade57b2d3b8703bb"),
    ("linux-musl", "x86_64", "bun-linux-x64-musl-baseline.zip", "56a7d6806cf155536c0178f0ea5fbd098e684fa509ebdb4fc0a7e19fb65382dc"),
    ("windows", "arm64", "bun-windows-aarch64.zip", "89841f5a57f2348b67ec0839b718f4bf4ea7d07c371c9ba4b77b6c790f918953"),
    ("windows", "x86_64", "bun-windows-x64-baseline.zip", "538f9c846355d9e847b2671bc00c47da4229a0befb24df3282b739770f3b475f"),
];

/// Test seams (v2 tests monkeypatch the equivalent module attributes).
#[derive(Debug, Clone)]
pub struct Endpoints {
    pub pypi_base: String,
    pub bun_release_base: String,
    /// URL prefix (a local mock) treated as `https` by the scheme checks.
    pub https_alias: Option<String>,
    /// Override the pinned Bun archive sha256 (mock archives).
    pub bun_sha256_override: Option<String>,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self { pypi_base: "https://pypi.org".into(), bun_release_base: "https://github.com/oven-sh/bun/releases/download".into(), https_alias: None, bun_sha256_override: None }
    }
}

fn endpoints_lock() -> &'static RwLock<Endpoints> {
    static E: OnceLock<RwLock<Endpoints>> = OnceLock::new();
    E.get_or_init(|| RwLock::new(Endpoints::default()))
}

pub fn set_endpoints(e: Endpoints) {
    *endpoints_lock().write().unwrap() = e;
}

fn endpoints() -> Endpoints {
    endpoints_lock().read().unwrap().clone()
}

/// Python exception categories that v2 callers branch on.
#[derive(Debug, Clone)]
pub enum InstallError {
    Permission(String),
    Value(String),
    Runtime(String),
    Other(String),
}

impl std::fmt::Display for InstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InstallError::Permission(s) | InstallError::Value(s) | InstallError::Runtime(s) | InstallError::Other(s) => f.write_str(s),
        }
    }
}

impl InstallError {
    fn io(e: std::io::Error, path: &Path) -> Self {
        let msg = super::py_os_error(&e, &path.to_string_lossy());
        if e.kind() == std::io::ErrorKind::PermissionDenied {
            InstallError::Permission(msg)
        } else {
            InstallError::Other(msg)
        }
    }
    /// `repr(exc)` for log lines.
    pub fn py_repr(&self) -> String {
        let (cls, s) = match self {
            InstallError::Permission(s) => ("PermissionError", s),
            InstallError::Value(s) => ("ValueError", s),
            InstallError::Runtime(s) => ("RuntimeError", s),
            InstallError::Other(s) => ("Exception", s),
        };
        format!("{cls}({})", crate::py_repr_str(s))
    }
}

type IResult<T> = Result<T, InstallError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedLspStatus {
    pub state: &'static str,
    pub detail: Option<String>,
    pub downloads_enabled: bool,
    pub ty_available: bool,
    pub ruff_available: bool,
}

fn executable_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn is_exec_file(p: &Path) -> bool {
    p.is_file() && (cfg!(windows) || is_executable(p))
}

/// uv-tool / sidecar layouts: binaries beside the running executable.
fn packaged_bin_dirs() -> Vec<PathBuf> {
    let mut out = vec![];
    if let Some(dir) = std::env::current_exe().ok().and_then(|p| dunce::canonicalize(p).ok()).and_then(|p| p.parent().map(Path::to_path_buf)) {
        out.push(dir.clone());
        if let Some(parent) = dir.parent() {
            out.push(parent.join("bin"));
        }
    }
    out
}

pub fn find_packaged_python_command(name: &str) -> Option<Vec<String>> {
    let exe = executable_name(name);
    for d in packaged_bin_dirs() {
        let cand = d.join(&exe);
        if is_exec_file(&cand) {
            return Some(vec![cand.to_string_lossy().into_owned(), "server".into()]);
        }
    }
    None
}

pub fn downloads_enabled() -> bool {
    let v = std::env::var("OPENAGENTD_DISABLE_LSP_DOWNLOAD").unwrap_or_default();
    !["1", "true", "yes", "on"].contains(&super::py_strip(&v).to_lowercase().as_str())
}

pub fn find_project_tsserver(project_root: &Path) -> Option<PathBuf> {
    let root = crate::denied::resolve(project_root);
    let cand = root.join("node_modules/typescript/lib/tsserver.js");
    let resolved = crate::denied::resolve(&cand);
    (resolved.starts_with(&root) && resolved.is_file()).then_some(resolved)
}

#[derive(Debug, Clone)]
pub struct BunAsset {
    pub filename: String,
    pub url: String,
    pub sha256: String,
    pub executable_member: String,
}

fn sha256_hex(b: &[u8]) -> String {
    let d = Sha256::digest(b);
    d.iter().map(|x| format!("{x:02x}")).collect()
}

fn open_zip(payload: &[u8]) -> IResult<zip::ZipArchive<std::io::Cursor<&[u8]>>> {
    zip::ZipArchive::new(std::io::Cursor::new(payload)).map_err(|_| InstallError::Other("File is not a zip file".into()))
}

fn read_member(archive: &mut zip::ZipArchive<std::io::Cursor<&[u8]>>, member: &str, too_big: &str) -> IResult<Option<Vec<u8>>> {
    let Ok(mut f) = archive.by_name(member) else {
        return Ok(None);
    };
    if f.size() > MAX_DOWNLOAD_BYTES {
        return Err(InstallError::Value(too_big.into()));
    }
    let mut out = Vec::with_capacity(f.size() as usize);
    f.read_to_end(&mut out).map_err(|e| InstallError::Other(e.to_string()))?;
    Ok(Some(out))
}

pub fn verified_bun_binary(payload: &[u8], asset: &BunAsset) -> IResult<Vec<u8>> {
    if sha256_hex(payload) != asset.sha256 {
        return Err(InstallError::Value("Bun archive checksum verification failed".into()));
    }
    let mut archive = open_zip(payload)?;
    if !archive.file_names().any(|n| n.is_ok_and(|n| n == asset.executable_member)) {
        return Err(InstallError::Value("Bun archive does not contain the expected executable".into()));
    }
    read_member(&mut archive, &asset.executable_member, "Bun executable exceeds the size limit")?
        .ok_or_else(|| InstallError::Value("Bun archive does not contain the expected executable".into()))
}

/// Python `platform.system()` / `platform.machine()`.
pub fn py_platform() -> (&'static str, &'static str) {
    let system = match std::env::consts::OS {
        "macos" => "Darwin",
        "linux" => "Linux",
        "windows" => "Windows",
        o => o,
    };
    let machine = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "arm64",
        ("windows", "x86_64") => "AMD64",
        ("windows", "aarch64") => "ARM64",
        (_, a) => a,
    };
    (system, machine)
}

fn is_musl() -> bool {
    cfg!(target_env = "musl")
}

fn platform_wheel_patterns() -> Vec<Regex> {
    let (system, machine) = py_platform();
    let (system, machine) = (system.to_lowercase(), machine.to_lowercase());
    let arm = machine == "arm64" || machine == "aarch64";
    match system.as_str() {
        "darwin" => {
            let arch = if arm { "arm64" } else { "x86_64" };
            vec![Regex::new(&format!(r"macosx_\d+_\d+_{arch}\.whl$")).unwrap(), Regex::new(r"macosx_\d+_\d+_universal2\.whl$").unwrap()]
        }
        "windows" => {
            let arch = if ["amd64", "x86_64", "x64"].contains(&machine.as_str()) { "amd64" } else { "arm64" };
            vec![Regex::new(&format!(r"win_{arch}\.whl$")).unwrap()]
        }
        "linux" => {
            let arch = if arm { "aarch64" } else { "x86_64" };
            if is_musl() {
                vec![Regex::new(&format!(r"musllinux_\d+_\d+_{arch}\.whl$")).unwrap()]
            } else {
                vec![Regex::new(&format!(r"manylinux_\d+_\d+_{arch}\.whl$")).unwrap()]
            }
        }
        _ => vec![],
    }
}

pub fn select_python_tool_wheel(name: &str, version: &str, urls: &[Value]) -> IResult<(String, String)> {
    let patterns = platform_wheel_patterns();
    let prefix = format!("{name}-{version}-py3-none-");
    for entry in urls {
        let filename = entry.get("filename").and_then(Value::as_str).unwrap_or("");
        if !filename.starts_with(&prefix) || !filename.ends_with(".whl") {
            continue;
        }
        if patterns.iter().any(|p| p.is_match(filename)) {
            let digest = entry.get("digests").filter(|d| !super::py_falsy(d)).and_then(|d| d.get("sha256")).filter(|d| !super::py_falsy(d));
            let Some(digest) = digest else {
                return Err(InstallError::Value(format!("wheel missing sha256 digest: {filename}")));
            };
            let url = entry.get("url").ok_or_else(|| InstallError::Other("'url'".into()))?;
            return Ok((super::py_str(url), super::py_str(digest)));
        }
    }
    let (s, m) = py_platform();
    Err(InstallError::Value(format!("no {name} {version} wheel for {s}/{m}")))
}

pub fn verified_python_tool_binary(payload: &[u8], name: &str, version: &str, expected_sha256: &str) -> IResult<Vec<u8>> {
    if sha256_hex(payload) != expected_sha256 {
        return Err(InstallError::Value(format!("{name} wheel checksum verification failed")));
    }
    let exe = executable_name(name);
    let members = [format!("{name}-{version}.data/scripts/{exe}"), format!("{name}-{version}.data/scripts/{name}")];
    let mut archive = open_zip(payload)?;
    for m in &members {
        if let Some(b) = read_member(&mut archive, m, &format!("{name} executable exceeds the size limit"))? {
            return Ok(b);
        }
    }
    Err(InstallError::Value(format!("{name} wheel does not contain the expected executable member")))
}

fn replace_executable(path: &Path, binary: &[u8]) -> IResult<()> {
    let parent = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent).map_err(|e| InstallError::io(e, parent))?;
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, binary).map_err(|e| InstallError::io(e, &tmp))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).map_err(|e| InstallError::io(e, &tmp))?;
    }
    std::fs::rename(&tmp, path).map_err(|e| InstallError::io(e, &tmp))
}

/// Shared clients (native-root loading is expensive). httpx's `timeout=N`
/// bounds each connect/read, not the whole transfer, hence `read_timeout`.
fn http_client(timeout: u64) -> &'static reqwest::Client {
    static SHORT: OnceLock<reqwest::Client> = OnceLock::new();
    static LONG: OnceLock<reqwest::Client> = OnceLock::new();
    let cell = if timeout <= 30 { &SHORT } else { &LONG };
    cell.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(timeout))
            .read_timeout(Duration::from_secs(timeout))
            .redirect(reqwest::redirect::Policy::limited(20))
            .build()
            .unwrap_or_default()
    })
}

fn status_error(resp: &reqwest::Response) -> Option<InstallError> {
    let st = resp.status();
    if st.is_client_error() || st.is_server_error() {
        let kind = if st.is_client_error() { "Client error" } else { "Server error" };
        return Some(InstallError::Other(format!(
            "{kind} '{} {}' for url '{}'\nFor more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/{}",
            st.as_u16(),
            st.canonical_reason().unwrap_or(""),
            resp.url(),
            st.as_u16()
        )));
    }
    None
}

fn scheme_ok(url: &reqwest::Url) -> bool {
    url.scheme() == "https" || endpoints().https_alias.map(|a| url.as_str().starts_with(&a)).unwrap_or(false)
}

async fn download(url: &str) -> IResult<Vec<u8>> {
    let resp = http_client(120).get(url).send().await.map_err(|e| InstallError::Other(e.to_string()))?;
    if let Some(e) = status_error(&resp) {
        return Err(e);
    }
    if !scheme_ok(resp.url()) {
        return Err(InstallError::Value("Managed LSP download redirected to a non-HTTPS URL".into()));
    }
    let mut payload: Vec<u8> = vec![];
    let mut resp = resp;
    while let Some(chunk) = resp.chunk().await.map_err(|e| InstallError::Other(e.to_string()))? {
        payload.extend_from_slice(&chunk);
        if payload.len() as u64 > MAX_DOWNLOAD_BYTES {
            return Err(InstallError::Value("Managed LSP download exceeds the size limit".into()));
        }
    }
    Ok(payload)
}

async fn pypi_json(name: &str, version: Option<&str>) -> IResult<Value> {
    let base = endpoints().pypi_base;
    let url = match version {
        Some(v) => format!("{base}/pypi/{name}/{v}/json"),
        None => format!("{base}/pypi/{name}/json"),
    };
    let resp = http_client(30).get(&url).send().await.map_err(|e| InstallError::Other(e.to_string()))?;
    if let Some(e) = status_error(&resp) {
        return Err(e);
    }
    if !scheme_ok(resp.url()) {
        return Err(InstallError::Value("PyPI metadata fetch redirected to a non-HTTPS URL".into()));
    }
    let body = resp.bytes().await.map_err(|e| InstallError::Other(e.to_string()))?;
    serde_json::from_slice(&body).map_err(|e| InstallError::Value(crate::py_json_error(&e)))
}

fn valid_version(v: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    // Python `$` also matches before one trailing newline.
    R.get_or_init(|| Regex::new(r"^[0-9][A-Za-z0-9._+!-]*$").unwrap()).is_match(v.strip_suffix('\n').unwrap_or(v))
}

#[derive(Default)]
struct State {
    state: Option<&'static str>,
    detail: Option<String>,
    announced: HashMap<String, Instant>,
}

pub struct ManagedLspTools {
    root_override: Option<PathBuf>,
    install_lock: tokio::sync::Mutex<()>,
    st: Mutex<State>,
}

pub fn managed_lsp_tools() -> &'static ManagedLspTools {
    static M: OnceLock<ManagedLspTools> = OnceLock::new();
    M.get_or_init(|| ManagedLspTools::new(None))
}

impl ManagedLspTools {
    pub fn new(root: Option<PathBuf>) -> Self {
        Self { root_override: root, install_lock: tokio::sync::Mutex::new(()), st: Mutex::new(State::default()) }
    }

    pub fn root(&self) -> PathBuf {
        self.root_override.clone().unwrap_or_else(|| appv3_core::settings().cache_dir.join("lsp"))
    }
    fn bin_dir(&self) -> PathBuf {
        self.root().join("bin")
    }
    fn packages_dir(&self) -> PathBuf {
        self.root().join("typescript")
    }
    pub fn bun_path(&self) -> PathBuf {
        self.bin_dir().join(executable_name("bun"))
    }
    pub fn typescript_language_server_path(&self) -> PathBuf {
        self.packages_dir().join("node_modules/typescript-language-server/lib/cli.mjs")
    }
    pub fn managed_tsserver_path(&self) -> PathBuf {
        self.packages_dir().join("node_modules/typescript/lib/tsserver.js")
    }

    fn managed_packages_current(&self) -> bool {
        let Ok(text) = std::fs::read_to_string(self.packages_dir().join("package.json")) else {
            return false;
        };
        let Ok(v) = serde_json::from_str::<Value>(&text) else {
            return false;
        };
        let Some(deps) = v.get("dependencies") else {
            return false;
        };
        let want = json!({"typescript": TYPESCRIPT_VERSION, "typescript-language-server": TYPESCRIPT_LANGUAGE_SERVER_VERSION});
        // dict equality is order-insensitive.
        match (deps, &want) {
            (Value::Object(a), Value::Object(b)) => a.len() == b.len() && a.iter().all(|(k, v)| b.get(k) == Some(v)),
            _ => false,
        }
    }

    pub fn typescript_command(&self, project_root: &Path) -> Option<(Vec<String>, PathBuf)> {
        if !(is_exec_file(&self.bun_path()) && self.managed_packages_current() && self.typescript_language_server_path().is_file() && self.managed_tsserver_path().is_file()) {
            return None;
        }
        let tsserver = find_project_tsserver(project_root).unwrap_or_else(|| self.managed_tsserver_path());
        Some((vec![self.bun_path().to_string_lossy().into_owned(), self.typescript_language_server_path().to_string_lossy().into_owned(), "--stdio".into()], tsserver))
    }

    pub fn status(&self) -> ManagedLspStatus {
        let cwd = std::env::current_dir().unwrap_or_default();
        let ready = self.typescript_command(&cwd).is_some();
        let (st, detail) = {
            let g = self.st.lock().unwrap();
            (g.state, g.detail.clone())
        };
        let state = if st == Some("installing") {
            "installing"
        } else if ready {
            "ready"
        } else if st == Some("error") {
            "error"
        } else {
            "missing"
        };
        ManagedLspStatus {
            state,
            detail: if state == "error" { detail } else { None },
            downloads_enabled: downloads_enabled(),
            ty_available: self.python_tool_available("ty"),
            ruff_available: self.python_tool_available("ruff"),
        }
    }

    fn python_tool_available(&self, name: &str) -> bool {
        let path = std::env::var("PATH").unwrap_or_default();
        find_packaged_python_command(name).is_some() || super::which_in(name, &path).is_some() || self.python_tool_command(name, None).is_some()
    }

    pub async fn announce_typescript_required(&self, project_root: &Path) {
        let key = crate::denied::resolve(project_root).to_string_lossy().into_owned();
        {
            let mut g = self.st.lock().unwrap();
            let now = Instant::now();
            if let Some(last) = g.announced.get(&key) {
                if now.duration_since(*last) < INSTALL_PROMPT_COOLDOWN {
                    return;
                }
            }
            if g.announced.len() >= 200 {
                g.announced.clear();
            }
            g.announced.insert(key.clone(), now);
        }
        super::publish(
            "lsp_install_required",
            json!({
                "component": "typescript",
                "workspace": key,
                "downloads_enabled": downloads_enabled(),
                "language_server_version": TYPESCRIPT_LANGUAGE_SERVER_VERSION,
                "typescript_version": TYPESCRIPT_VERSION,
            }),
        );
    }

    pub fn asset(&self) -> IResult<BunAsset> {
        let (system, machine) = py_platform();
        let mut system = system.to_lowercase();
        if system == "linux" && is_musl() {
            system = "linux-musl".into();
        }
        let mut machine = machine.to_lowercase();
        if machine == "amd64" || machine == "x64" {
            machine = "x86_64".into();
        } else if machine == "arm64" || machine == "aarch64" {
            machine = if system == "darwin" || system == "windows" { "arm64".into() } else { "aarch64".into() };
        }
        let Some((_, _, filename, sha)) = BUN_ASSETS.iter().find(|(s, m, _, _)| *s == system && *m == machine) else {
            return Err(InstallError::Runtime(format!("Managed TypeScript LSP is unsupported on {system}/{machine}")));
        };
        let ep = endpoints();
        let directory = filename.trim_end_matches(".zip");
        let mut asset = BunAsset {
            filename: filename.to_string(),
            url: format!("{}/bun-v{BUN_VERSION}/{filename}", ep.bun_release_base),
            sha256: sha.to_string(),
            executable_member: format!("{directory}/{}", executable_name("bun")),
        };
        if let Some(sha) = ep.bun_sha256_override {
            asset.sha256 = sha;
        }
        Ok(asset)
    }

    fn set_state(&self, state: &'static str, detail: Option<String>) {
        let mut g = self.st.lock().unwrap();
        g.state = Some(state);
        g.detail = detail;
    }

    pub async fn install_typescript(&self) -> IResult<ManagedLspStatus> {
        if !downloads_enabled() {
            return Err(InstallError::Permission("Managed LSP downloads are disabled by OPENAGENTD_DISABLE_LSP_DOWNLOAD".into()));
        }
        let _g = self.install_lock.lock().await;
        let cwd = std::env::current_dir().unwrap_or_default();
        if self.typescript_command(&cwd).is_some() {
            return Ok(self.status());
        }
        self.set_state("installing", None);
        match self.install_typescript_inner(&cwd).await {
            Ok(()) => {
                self.set_state("ready", None);
                self.st.lock().unwrap().announced.clear();
                tracing::info!("managed_lsp_typescript_ready version={} typescript={}", TYPESCRIPT_LANGUAGE_SERVER_VERSION, TYPESCRIPT_VERSION);
                Ok(self.status())
            }
            Err(e) => {
                let detail = match &e {
                    InstallError::Permission(s) | InstallError::Value(s) => s.clone(),
                    _ => "TypeScript component installation failed; see backend logs.".into(),
                };
                self.set_state("error", Some(detail));
                tracing::warn!("managed_lsp_typescript_install_failed error={}", e.py_repr());
                Err(e)
            }
        }
    }

    async fn install_typescript_inner(&self, cwd: &Path) -> IResult<()> {
        let asset = self.asset()?;
        let payload = download(&asset.url).await?;
        let a2 = asset.clone();
        let binary = tokio::task::spawn_blocking(move || verified_bun_binary(&payload, &a2)).await.map_err(|e| InstallError::Other(e.to_string()))??;
        replace_executable(&self.bun_path(), &binary)?;
        let pk = self.packages_dir();
        std::fs::create_dir_all(&pk).map_err(|e| InstallError::io(e, &pk))?;
        for (name, bytes) in [("package.json", RESOURCE_PACKAGE_JSON), ("bun.lock", RESOURCE_BUN_LOCK)] {
            let p = pk.join(name);
            std::fs::write(&p, bytes).map_err(|e| InstallError::io(e, &p))?;
        }
        let bun = self.bun_path();
        let mut cmd = tokio::process::Command::new(&bun);
        appv3_core::proctree::hide_window(&mut cmd);
        cmd.arg("install")
            .arg(format!("--cwd={}", pk.display()))
            .arg("--frozen-lockfile")
            .arg("--ignore-scripts")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .stdin(std::process::Stdio::null())
            .env("BUN_INSTALL_CACHE_DIR", self.root().join("bun-cache"))
            .kill_on_drop(true);
        let child = cmd.spawn().map_err(|e| InstallError::io(e, &bun))?;
        let out = match tokio::time::timeout(Duration::from_secs(180), child.wait_with_output()).await {
            Ok(r) => r.map_err(|e| InstallError::Other(e.to_string()))?,
            Err(_) => return Err(InstallError::Runtime("Bun package installation timed out".into())),
        };
        if !out.status.success() {
            let code = exit_code(&out.status);
            return Err(InstallError::Runtime(format!("Bun package installation failed with exit code {code}")));
        }
        if self.typescript_command(cwd).is_none() {
            return Err(InstallError::Runtime("TypeScript language-server installation is incomplete".into()));
        }
        Ok(())
    }

    // ── Managed Python tools (ruff / ty) ──────────────────────────────────

    fn python_dirs(&self, name: &str) -> Vec<(PathBuf, std::time::SystemTime)> {
        let root = self.root().join("python");
        let Ok(rd) = std::fs::read_dir(&root) else {
            return vec![];
        };
        let prefix = format!("{name}-");
        rd.flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(&prefix))
            .filter(|e| e.path().is_dir())
            .filter_map(|e| {
                let m = std::fs::metadata(e.path()).ok()?.modified().ok()?;
                Some((e.path(), m))
            })
            .collect()
    }

    pub fn python_tool_version(&self, name: &str) -> Option<String> {
        let dirs = self.python_dirs(name);
        let mut newest: Option<&(PathBuf, std::time::SystemTime)> = None;
        for d in &dirs {
            if newest.map(|n| d.1 > n.1).unwrap_or(true) {
                newest = Some(d);
            }
        }
        let n = newest?.0.file_name()?.to_string_lossy().into_owned();
        Some(n[name.len() + 1..].to_string())
    }

    pub fn python_tool_command(&self, name: &str, version: Option<&str>) -> Option<Vec<String>> {
        let version = match version {
            Some(v) => v.to_string(),
            None => self.python_tool_version(name)?,
        };
        let exe = self.root().join("python").join(format!("{name}-{version}")).join(executable_name(name));
        is_exec_file(&exe).then(|| vec![exe.to_string_lossy().into_owned(), "server".into()])
    }

    pub async fn ensure_python_tool(&self, name: &str, version: Option<&str>) -> Option<Vec<String>> {
        if let Some(c) = self.python_tool_command(name, version) {
            return Some(c);
        }
        let _g = self.install_lock.lock().await;
        if let Some(c) = self.python_tool_command(name, version) {
            return Some(c);
        }
        match self.install_python_tool(name, version, false).await {
            Ok(c) => Some(c),
            Err(e) => {
                tracing::warn!("managed_python_tool_install_failed name={} version={} error={}", name, version.unwrap_or("None"), e.py_repr());
                None
            }
        }
    }

    pub async fn install_python_tool(&self, name: &str, version: Option<&str>, force: bool) -> IResult<Vec<String>> {
        if !PYTHON_TOOL_NAMES.contains(&name) {
            return Err(InstallError::Value(format!("unsupported python tool: {}", crate::py_repr_str(name))));
        }
        let resolved = match version {
            None => {
                let data = pypi_json(name, None).await?;
                match data.get("info").and_then(|i| i.get("version")) {
                    Some(v) => super::py_str(v),
                    None => return Err(InstallError::Other(if data.get("info").is_none() { "'info'".into() } else { "'version'".into() })),
                }
            }
            Some(v) => {
                if !valid_version(v) {
                    return Err(InstallError::Value(format!("invalid python tool version: {}", crate::py_repr_str(v))));
                }
                v.to_string()
            }
        };
        if let Some(c) = self.python_tool_command(name, Some(&resolved)) {
            if !force {
                return Ok(c);
            }
        }
        let data = pypi_json(name, Some(&resolved)).await?;
        let urls: Vec<Value> = match data.get("urls") {
            Some(Value::Array(a)) => a.clone(),
            _ => vec![],
        };
        let (url, digest) = select_python_tool_wheel(name, &resolved, &urls)?;
        let payload = download(&url).await?;
        let (n2, r2) = (name.to_string(), resolved.clone());
        let binary = tokio::task::spawn_blocking(move || verified_python_tool_binary(&payload, &n2, &r2, &digest)).await.map_err(|e| InstallError::Other(e.to_string()))??;
        let exe = self.root().join("python").join(format!("{name}-{resolved}")).join(executable_name(name));
        replace_executable(&exe, &binary)?;
        self.prune_python_tool_versions(name);
        let Some(cmd) = self.python_tool_command(name, Some(&resolved)) else {
            return Err(InstallError::Runtime(format!("managed {name} install is incomplete")));
        };
        tracing::info!("managed_python_tool_ready name={} version={}", name, resolved);
        Ok(cmd)
    }

    fn prune_python_tool_versions(&self, name: &str) {
        let mut dirs = self.python_dirs(name);
        dirs.sort_by_key(|d| std::cmp::Reverse(d.1));
        for (stale, _) in dirs.iter().skip(MAX_MANAGED_PYTHON_VERSIONS) {
            let _ = std::fs::remove_dir_all(stale);
        }
    }
}

fn exit_code(st: &std::process::ExitStatus) -> i32 {
    if let Some(c) = st.code() {
        return c;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(s) = st.signal() {
            return -s;
        }
    }
    -1
}
