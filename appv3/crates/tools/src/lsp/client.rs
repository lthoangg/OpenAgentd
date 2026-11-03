//! A stdio JSON-RPC LSP client.

use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::{oneshot, Notify};
use tokio::task::JoinHandle;

pub type LspResult<T> = Result<T, String>;

/// `asyncio.Event` equivalent (set / clear / wait).
#[derive(Default)]
pub struct Event {
    flag: AtomicBool,
    notify: Notify,
}

impl Event {
    pub fn set(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }
    pub fn clear(&self) {
        self.flag.store(false, Ordering::SeqCst);
    }
    pub fn is_set(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }
    pub async fn wait(&self) {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.is_set() {
                return;
            }
            notified.await;
        }
    }
}

/// `PurePosixPath.as_uri()` — `file://` + percent-quoted path (safe `/`).
pub fn path_as_uri(p: &Path) -> String {
    let s = p.to_string_lossy();
    let mut out = String::from("file://");
    for b in s.as_bytes() {
        let c = *b as char;
        if c.is_ascii_alphanumeric() || "_.-~/".contains(c) {
            out.push(c);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

/// `Path.from_uri()` (Python 3.13+), POSIX flavour.
pub fn path_from_uri(uri: &str) -> Result<PathBuf, String> {
    let repr = crate::py_repr_str(uri);
    let Some(mut path) = uri.strip_prefix("file:") else {
        return Err(format!("URI does not start with 'file:': {repr}"));
    };
    if let Some(rest) = path.strip_prefix("//localhost/") {
        path = &path[path.len() - rest.len() - 1..];
    } else if path.starts_with("//") {
        let rest = &path[2..];
        if rest.starts_with('/') {
            path = rest;
        } else {
            return Err("file:// scheme is supported only on localhost".into());
        }
    }
    let decoded = urlencoding::decode_binary(path.as_bytes());
    let decoded = String::from_utf8_lossy(&decoded).into_owned();
    if !decoded.starts_with('/') {
        return Err(format!("URI is not absolute: {repr}"));
    }
    Ok(PathBuf::from(decoded))
}

#[derive(Default)]
struct Inner {
    id: i64,
    pending: HashMap<i64, oneshot::Sender<LspResult<Value>>>,
    latest: HashMap<String, Vec<Value>>,
    events: HashMap<String, Arc<Event>>,
    locks: HashMap<String, Arc<tokio::sync::Mutex<()>>>,
    open_docs: HashMap<String, i64>,
}

pub struct LspClient {
    pub command: Vec<String>,
    pub workspace_root: PathBuf,
    init_options: Option<Value>,
    env: Option<Vec<(String, String)>>,
    inner: Arc<Mutex<Inner>>,
    stdin: tokio::sync::Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    read_task: Mutex<Option<JoinHandle<()>>>,
    last_used: Mutex<Instant>,
}

impl LspClient {
    pub fn new(command: Vec<String>, workspace_root: PathBuf, init_options: Option<Value>, env: Option<Vec<(String, String)>>) -> Self {
        Self {
            command,
            workspace_root,
            init_options,
            env,
            inner: Arc::new(Mutex::new(Inner::default())),
            stdin: tokio::sync::Mutex::new(None),
            child: Mutex::new(None),
            read_task: Mutex::new(None),
            last_used: Mutex::new(Instant::now()),
        }
    }

    pub fn last_used_at(&self) -> Instant {
        *self.last_used.lock().unwrap()
    }

    fn touch(&self) {
        *self.last_used.lock().unwrap() = Instant::now();
    }

    /// `self.process is not None`.
    pub fn has_process(&self) -> bool {
        self.child.lock().unwrap().is_some()
    }

    /// `self.process and self.process.returncode is None`.
    pub fn is_running(&self) -> bool {
        match self.child.lock().unwrap().as_mut() {
            Some(c) => matches!(c.try_wait(), Ok(None)),
            None => false,
        }
    }

    /// `self.process and self.process.returncode is not None`.
    pub fn process_died(&self) -> bool {
        match self.child.lock().unwrap().as_mut() {
            Some(c) => matches!(c.try_wait(), Ok(Some(_))),
            None => false,
        }
    }

    pub async fn start(&self) -> LspResult<()> {
        tracing::info!("Starting LSP server: {} in {}", py_list_repr(&self.command), self.workspace_root.display());
        let mut cmd = tokio::process::Command::new(&self.command[0]);
        appv3_core::proctree::hide_window(&mut cmd);
        cmd.args(&self.command[1..]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).current_dir(&self.workspace_root).kill_on_drop(true);
        if let Some(env) = &self.env {
            cmd.env_clear();
            cmd.envs(env.iter().cloned());
        }
        let mut child = cmd.spawn().map_err(|e| crate::lsp::py_os_error(&e, &self.command[0]))?;
        let stdout = child.stdout.take();
        *self.stdin.lock().await = child.stdin.take();
        *self.child.lock().unwrap() = Some(child);
        if let Some(stdout) = stdout {
            let inner = self.inner.clone();
            *self.read_task.lock().unwrap() = Some(tokio::spawn(read_loop(stdout, inner)));
        }
        self.touch();
        if let Err(e) = self.initialize().await {
            tracing::warn!("Failed to initialize LSP server {}: {}", py_list_repr(&self.command), e);
            return Err(e);
        }
        Ok(())
    }

    async fn initialize(&self) -> LspResult<()> {
        let root_uri = path_as_uri(&self.workspace_root);
        let name = self.workspace_root.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let mut params = json!({
            "processId": std::process::id(),
            "rootPath": self.workspace_root.to_string_lossy(),
            "rootUri": root_uri,
            "workspaceFolders": [{"uri": root_uri, "name": name}],
            "capabilities": {
                "workspace": {"workspaceFolders": true},
                "textDocument": {
                    "publishDiagnostics": {
                        "relatedInformation": true,
                        "versionSupport": false,
                        "tagSupport": {"valueSet": [1, 2]},
                        "codeDescriptionSupport": true,
                        "dataSupport": true,
                    },
                    "documentSymbol": {"hierarchicalDocumentSymbolSupport": true},
                },
            },
        });
        if let Some(opts) = &self.init_options {
            if !crate::lsp::py_falsy(opts) {
                params["initializationOptions"] = opts.clone();
            }
        }
        self.send_request("initialize", Some(params)).await?;
        self.send_message(&json!({"jsonrpc": "2.0", "method": "initialized", "params": {}})).await
    }

    /// Clear stale diagnostics for *uri* and return a fresh event.
    pub fn reset_diagnostics(&self, uri: &str) -> Arc<Event> {
        let mut g = self.inner.lock().unwrap();
        g.latest.remove(uri);
        let ev = Arc::new(Event::default());
        g.events.insert(uri.to_string(), ev.clone());
        ev
    }

    pub fn get_diagnostics(&self, uri: &str) -> Vec<Value> {
        self.inner.lock().unwrap().latest.get(uri).cloned().unwrap_or_default()
    }

    pub fn diagnostics_lock(&self, uri: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.inner.lock().unwrap().locks.entry(uri.to_string()).or_default().clone()
    }

    pub async fn open_or_update_document(&self, uri: &str, language_id: &str, text: &str) -> LspResult<()> {
        let existing = {
            let mut g = self.inner.lock().unwrap();
            match g.open_docs.get(uri).copied() {
                Some(v) => {
                    g.open_docs.insert(uri.to_string(), v + 1);
                    Some(v + 1)
                }
                None => {
                    g.open_docs.insert(uri.to_string(), 1);
                    None
                }
            }
        };
        let msg = match existing {
            Some(version) => json!({
                "jsonrpc": "2.0",
                "method": "textDocument/didChange",
                "params": {"textDocument": {"uri": uri, "version": version}, "contentChanges": [{"text": text}]},
            }),
            None => json!({
                "jsonrpc": "2.0",
                "method": "textDocument/didOpen",
                "params": {"textDocument": {"uri": uri, "languageId": language_id, "version": 1, "text": text}},
            }),
        };
        self.send_message(&msg).await
    }

    pub async fn close_document(&self, uri: &str) -> LspResult<()> {
        if self.inner.lock().unwrap().open_docs.remove(uri).is_none() {
            return Ok(());
        }
        self.send_message(&json!({"jsonrpc": "2.0", "method": "textDocument/didClose", "params": {"textDocument": {"uri": uri}}})).await
    }

    pub async fn send_message(&self, msg: &Value) -> LspResult<()> {
        let mut guard = self.stdin.lock().await;
        let Some(stdin) = guard.as_mut().filter(|_| self.has_process()) else {
            return Err("LSP server not running".into());
        };
        let body = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
        let mut frame = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
        frame.extend_from_slice(&body);
        stdin.write_all(&frame).await.map_err(|e| py_io_error(&e))?;
        stdin.flush().await.map_err(|e| py_io_error(&e))?;
        drop(guard);
        self.touch();
        Ok(())
    }

    pub async fn send_request(&self, method: &str, params: Option<Value>) -> LspResult<Value> {
        let (tx, rx) = oneshot::channel();
        let req_id = {
            let mut g = self.inner.lock().unwrap();
            g.id += 1;
            let id = g.id;
            g.pending.insert(id, tx);
            id
        };
        struct Pending(Arc<Mutex<Inner>>, i64);
        impl Drop for Pending {
            fn drop(&mut self) {
                self.0.lock().unwrap().pending.remove(&self.1);
            }
        }
        let _guard = Pending(self.inner.clone(), req_id);
        let mut msg = Map::new();
        msg.insert("jsonrpc".into(), json!("2.0"));
        msg.insert("id".into(), json!(req_id));
        msg.insert("method".into(), json!(method));
        if let Some(p) = params {
            msg.insert("params".into(), p);
        }
        self.send_message(&Value::Object(msg)).await?;
        match rx.await {
            Ok(r) => r,
            Err(_) => Err("LSP server stopped".into()),
        }
    }

    pub async fn stop(&self) {
        let read_task = self.read_task.lock().unwrap().take();
        if self.has_process() {
            if self.is_running() {
                let graceful = async {
                    match tokio::time::timeout(Duration::from_secs(1), self.send_request("shutdown", None)).await {
                        Ok(Ok(_)) => {}
                        Ok(Err(e)) => return Err(e),
                        Err(_) => return Err("TimeoutError()".into()),
                    }
                    self.send_message(&json!({"jsonrpc": "2.0", "method": "exit", "params": {}})).await
                };
                if let Err(e) = graceful.await {
                    tracing::debug!("lsp_graceful_shutdown_failed error={}", e);
                }
            }
            let child = self.child.lock().unwrap().take();
            if let Some(mut child) = child {
                if matches!(child.try_wait(), Ok(None)) {
                    terminate(&child);
                    let _ = child.wait().await;
                }
            }
            *self.stdin.lock().await = None;
        }
        if let Some(t) = read_task {
            t.abort();
            let _ = t.await;
        }
        let mut g = self.inner.lock().unwrap();
        for (_, tx) in g.pending.drain() {
            let _ = tx.send(Err("LSP server stopped".into()));
        }
        for ev in g.events.values() {
            ev.set();
        }
        g.locks.clear();
    }
}

fn terminate(child: &Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        let _ = nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), nix::sys::signal::Signal::SIGTERM);
    }
    #[cfg(not(unix))]
    {
        let _ = child;
    }
}

fn py_io_error(e: &std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::BrokenPipe => "[Errno 32] Broken pipe".into(),
        std::io::ErrorKind::ConnectionReset => "Connection lost".into(),
        _ => e.to_string(),
    }
}

/// Python `repr(list[str])`.
pub fn py_list_repr(items: &[String]) -> String {
    format!("[{}]", items.iter().map(|s| crate::py_repr_str(s)).collect::<Vec<_>>().join(", "))
}

async fn read_loop(stdout: ChildStdout, inner: Arc<Mutex<Inner>>) {
    let mut reader = BufReader::new(stdout);
    let res: Result<(), String> = async {
        loop {
            let mut content_length: Option<usize> = None;
            loop {
                let mut line = Vec::new();
                let n = reader.read_until(b'\n', &mut line).await.map_err(|e| e.to_string())?;
                if n == 0 {
                    return Ok(());
                }
                let s = String::from_utf8_lossy(&line);
                let s = s.trim();
                if s.is_empty() {
                    break;
                }
                if let Some((k, v)) = s.split_once(':') {
                    if k.trim().to_lowercase() == "content-length" {
                        content_length = Some(v.trim().parse::<usize>().map_err(|_| format!("invalid literal for int() with base 10: {}", crate::py_repr_str(v.trim())))?);
                    }
                }
            }
            let Some(len) = content_length else { continue };
            let mut body = vec![0u8; len];
            if reader.read_exact(&mut body).await.is_err() {
                tracing::debug!("LspClient stdout EOF or incomplete read");
                return Ok(());
            }
            if body.is_empty() {
                return Ok(());
            }
            let message: Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
            handle_message(&inner, message)?;
        }
    }
    .await;
    if let Err(e) = res {
        tracing::error!("Error in LspClient read loop: {}", e);
    }
    let mut g = inner.lock().unwrap();
    for (_, tx) in g.pending.drain() {
        let _ = tx.send(Err("LSP server stopped".into()));
    }
    for ev in g.events.values() {
        ev.set();
    }
}

fn as_req_id(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64)),
        Value::Bool(b) => Some(*b as i64),
        _ => None,
    }
}

fn handle_message(inner: &Arc<Mutex<Inner>>, message: Value) -> Result<(), String> {
    let Value::Object(m) = message else {
        return Err("argument of type is not iterable".into());
    };
    if m.contains_key("id") && !m.contains_key("method") {
        let Some(id) = as_req_id(&m["id"]) else {
            return Ok(());
        };
        let tx = inner.lock().unwrap().pending.remove(&id);
        if let Some(tx) = tx {
            if let Some(err) = m.get("error") {
                let Value::Object(e) = err else {
                    return Err("'error' object has no attribute 'get'".into());
                };
                let msg = match e.get("message") {
                    Some(Value::String(s)) => s.clone(),
                    Some(other) => crate::lsp::py_str(other),
                    None => "LSP error".into(),
                };
                let _ = tx.send(Err(msg));
            } else {
                let _ = tx.send(Ok(m.get("result").cloned().unwrap_or(Value::Null)));
            }
        }
    } else if let Some(method) = m.get("method") {
        if method.as_str() == Some("textDocument/publishDiagnostics") {
            let empty = Value::Object(Map::new());
            let params = m.get("params").unwrap_or(&empty);
            let Value::Object(p) = params else {
                return Err("'params' object has no attribute 'get'".into());
            };
            if let Some(Value::String(uri)) = p.get("uri").filter(|u| !crate::lsp::py_falsy(u)) {
                let diags = match p.get("diagnostics") {
                    Some(Value::Array(a)) => a.clone(),
                    _ => vec![],
                };
                let mut g = inner.lock().unwrap();
                g.latest.insert(uri.clone(), diags);
                if let Some(ev) = g.events.get(uri) {
                    ev.set();
                }
            }
        }
    }
    Ok(())
}
