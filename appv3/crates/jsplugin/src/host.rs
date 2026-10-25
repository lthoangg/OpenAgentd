//! Native functions behind the `openagentd` module. JS reaches them through
//! two entry points: `__n.sync(name, argJson)` and `__n.async(name, argJson)`,
//! both returning a JSON envelope `{"ok": value}` / `{"err": {name, message, props}}`
//! that the prelude unwraps (throwing on `err`).

use rquickjs::prelude::Async;
use rquickjs::{Ctx, Function, Object};
use serde_json::{json, Map, Value};
use std::cell::{Cell, OnceCell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// A synchronous JSON → JSON function other crates expose to plugins
/// (`native(name, arg)` in JS).
pub type NativeFn = Arc<dyn Fn(Value) -> Result<Value, String> + Send + Sync>;
/// A Rust closure handed to one JS call (`{"$oadCallback": id}` in the args).
pub type CallbackFn = Arc<dyn Fn(Vec<Value>) -> Value + Send + Sync>;

fn natives() -> &'static Mutex<HashMap<String, NativeFn>> {
    static N: OnceLock<Mutex<HashMap<String, NativeFn>>> = OnceLock::new();
    N.get_or_init(Default::default)
}

/// Register (or replace) a native function callable from plugins.
pub fn register_native(name: &str, f: NativeFn) {
    natives().lock().unwrap().insert(name.to_string(), f);
}

fn callbacks() -> &'static Mutex<HashMap<u64, CallbackFn>> {
    static C: OnceLock<Mutex<HashMap<u64, CallbackFn>>> = OnceLock::new();
    C.get_or_init(Default::default)
}

/// A registered callback; unregistered on drop. `marker()` is the JSON value
/// to place in a call's arguments — JS receives a function.
pub struct Callback(u64);

impl Callback {
    pub fn new(f: CallbackFn) -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        callbacks().lock().unwrap().insert(id, f);
        Callback(id)
    }
    pub fn marker(&self) -> Value {
        json!({"$oadCallback": self.0})
    }
}

impl Drop for Callback {
    fn drop(&mut self) {
        callbacks().lock().unwrap().remove(&self.0);
    }
}

pub struct NativeError {
    pub name: &'static str,
    pub message: String,
    pub props: Value,
}

impl NativeError {
    fn new(name: &'static str, message: impl Into<String>) -> Self {
        Self { name, message: message.into(), props: json!({}) }
    }
    fn error(message: impl Into<String>) -> Self {
        Self::new("Error", message)
    }
    fn type_error(message: impl Into<String>) -> Self {
        Self::new("TypeError", message)
    }
}

type NResult = Result<Value, NativeError>;

fn envelope(r: NResult) -> String {
    match r {
        Ok(v) => format!("{{\"ok\":{}}}", serde_json::to_string(&v).unwrap_or_else(|_| "null".into())),
        Err(e) => json!({"err": {"name": e.name, "message": e.message, "props": e.props}}).to_string(),
    }
}

/// Per-runtime state (lives on the plugin's thread).
pub struct HostState {
    pub plugin: String,
    /// Built on first `fetch`: loading the native root store costs ~100 ms, and
    /// most plugins (tool hooks) never make a request.
    client: OnceCell<reqwest::Client>,
    next_id: Cell<u64>,
    servers: RefCell<HashMap<u64, Rc<tokio::net::TcpListener>>>,
    conns: RefCell<HashMap<u64, tokio::net::TcpStream>>,
    regexes: RefCell<crate::re::Regexes>,
}

impl HostState {
    pub fn new(plugin: &str) -> Rc<Self> {
        Rc::new(Self {
            plugin: plugin.to_string(),
            client: OnceCell::new(),
            next_id: Cell::new(1),
            servers: RefCell::default(),
            conns: RefCell::default(),
            regexes: RefCell::default(),
        })
    }
    fn id(&self) -> u64 {
        let id = self.next_id.get();
        self.next_id.set(id + 1);
        id
    }
    fn client(&self) -> &reqwest::Client {
        self.client.get_or_init(|| reqwest::Client::builder().pool_idle_timeout(Duration::from_secs(90)).build().expect("reqwest client"))
    }
}

pub fn install(ctx: &Ctx<'_>, st: Rc<HostState>) -> rquickjs::Result<()> {
    let n = Object::new(ctx.clone())?;
    let plugin = st.plugin.clone();
    n.set(
        "log",
        Function::new(ctx.clone(), move |level: String, msg: String| match level.as_str() {
            "debug" => tracing::debug!(target: "plugin", "[{}] {}", plugin, msg),
            "warn" => tracing::warn!(target: "plugin", "[{}] {}", plugin, msg),
            "error" => tracing::error!(target: "plugin", "[{}] {}", plugin, msg),
            _ => tracing::info!(target: "plugin", "[{}] {}", plugin, msg),
        })?,
    )?;
    let s1 = st.clone();
    n.set(
        "sync",
        Function::new(ctx.clone(), move |name: String, arg: String| -> String {
            let arg: Value = serde_json::from_str(&arg).unwrap_or(Value::Null);
            envelope(sync_call(&s1, &name, arg))
        })?,
    )?;
    // Regex ops take the haystack as a plain JS string: routing it through
    // the JSON envelope would escape and re-parse every tool output per call.
    let s3 = st.clone();
    n.set(
        "re",
        Function::new(ctx.clone(), move |op: String, id: f64, text: String| -> String {
            let re = s3.regexes.borrow();
            let id = if id >= 0.0 { id as u64 } else { u64::MAX };
            let r = match op.as_str() {
                "test" => re.test(id, &text).map(|b| json!(b)),
                "first" => re.exec(id, &text, false),
                _ => re.exec(id, &text, true),
            };
            envelope(r.map_err(NativeError::error))
        })?,
    )?;
    let s2 = st;
    n.set(
        "async",
        Function::new(
            ctx.clone(),
            Async(move |name: String, arg: String| {
                let st = s2.clone();
                async move {
                    let arg: Value = serde_json::from_str(&arg).unwrap_or(Value::Null);
                    Ok::<String, rquickjs::Error>(envelope(async_call(st, &name, arg).await))
                }
            }),
        )?,
    )?;
    ctx.globals().set("__n", n)?;
    Ok(())
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("")
}

fn bytes_arg(v: &Value) -> Result<Vec<u8>, NativeError> {
    if let Some(h) = v.get("hex").and_then(|x| x.as_str()) {
        return hex::decode(h).map_err(|e| NativeError::type_error(e.to_string()));
    }
    Ok(s(v, "text").as_bytes().to_vec())
}

fn sync_call(st: &HostState, name: &str, arg: Value) -> NResult {
    use base64::Engine;
    match name {
        "platform" => Ok(json!(match std::env::consts::OS {
            "macos" => "macos",
            "windows" => "windows",
            "linux" => "linux",
            other => other,
        })),
        "version" => Ok(json!(appv3_core::VERSION)),
        "randomHex" => {
            let n = arg.get("n").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
            if n > 1 << 20 {
                return Err(NativeError::new("RangeError", "randomBytes: too many bytes requested"));
            }
            let mut b = vec![0u8; n];
            rand::fill(&mut b[..]);
            Ok(json!(hex::encode(b)))
        }
        "uuid" => Ok(json!(if arg.get("version").and_then(|x| x.as_i64()) == Some(7) { uuid::Uuid::now_v7() } else { uuid::Uuid::new_v4() }.to_string())),
        "sha256" => {
            use sha2::Digest;
            Ok(json!(hex::encode(sha2::Sha256::digest(bytes_arg(&arg)?))))
        }
        "base64Encode" => {
            let b = bytes_arg(&arg)?;
            let url = arg.get("url").and_then(|x| x.as_bool()).unwrap_or(false);
            let pad = arg.get("pad").and_then(|x| x.as_bool()).unwrap_or(!url);
            use base64::engine::general_purpose as gp;
            let out = match (url, pad) {
                (true, true) => gp::URL_SAFE.encode(b),
                (true, false) => gp::URL_SAFE_NO_PAD.encode(b),
                (false, true) => gp::STANDARD.encode(b),
                (false, false) => gp::STANDARD_NO_PAD.encode(b),
            };
            Ok(json!(out))
        }
        "base64Decode" => {
            let text = s(&arg, "text").trim_end_matches('=');
            let url = arg.get("url").and_then(|x| x.as_bool()).unwrap_or(false);
            use base64::engine::general_purpose as gp;
            let r = if url { gp::URL_SAFE_NO_PAD.decode(text) } else { gp::STANDARD_NO_PAD.decode(text) };
            r.map(|b| json!(hex::encode(b))).map_err(|e| NativeError::type_error(e.to_string()))
        }
        "utf8Encode" => Ok(json!(hex::encode(s(&arg, "text").as_bytes()))),
        "utf8Decode" => Ok(json!(String::from_utf8_lossy(&bytes_arg(&arg)?).into_owned())),
        "envGet" => Ok(appv3_core::env::os_environ(s(&arg, "name")).map(Value::String).unwrap_or(Value::Null)),
        "envAll" => {
            let mut m = Map::new();
            let mut names: Vec<String> = std::env::vars_os().filter_map(|(k, _)| k.into_string().ok()).collect();
            names.sort();
            for k in names {
                if let Some(v) = appv3_core::env::os_environ(&k) {
                    m.insert(k, json!(v));
                }
            }
            Ok(Value::Object(m))
        }
        "which" => Ok(which(s(&arg, "name")).map(|p| json!(p.to_string_lossy())).unwrap_or(Value::Null)),
        "tokenPath" => {
            let component = |v: &str| !v.is_empty() && v != "." && v != ".." && v.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.'));
            let provider = s(&arg, "provider");
            if !component(provider) {
                return Err(NativeError::error("Invalid provider token directory"));
            }
            let mut dir = appv3_core::settings().cache_dir.join("provider-plugins").join(provider);
            let file = s(&arg, "file");
            if let Some(id) = arg.get("credentialId").and_then(|c| c.as_str()) {
                if !component(id) || !component(file) {
                    return Err(NativeError::error("Account token paths require plain directory and file names"));
                }
                dir = dir.join(id);
            }
            std::fs::create_dir_all(&dir).map_err(|e| NativeError::error(e.to_string()))?;
            Ok(json!(dir.join(file.replace('/', "_")).to_string_lossy()))
        }
        "readText" => Ok(std::fs::read_to_string(s(&arg, "path")).map(Value::String).unwrap_or(Value::Null)),
        "writeText" => std::fs::write(s(&arg, "path"), s(&arg, "text")).map(|_| Value::Null).map_err(|e| NativeError::error(e.to_string())),
        "exists" => Ok(json!(std::path::Path::new(s(&arg, "path")).exists())),
        "remove" => match std::fs::remove_file(s(&arg, "path")) {
            Ok(()) => Ok(json!(true)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!(false)),
            Err(e) => Err(NativeError::error(e.to_string())),
        },
        "mkdir" => std::fs::create_dir_all(s(&arg, "path")).map(|_| Value::Null).map_err(|e| NativeError::error(e.to_string())),
        "pyJsonDumps" => Ok(json!(appv3_core::pyjson::dumps(arg.get("value").unwrap_or(&Value::Null)))),
        "reCompile" => st.regexes.borrow_mut().compile(s(&arg, "pattern"), s(&arg, "flags")).map_err(|e| NativeError::new("SyntaxError", e)),
        "parseIso" => Ok(parse_iso_ts(arg.get("text").and_then(|x| x.as_str())).map(|t| json!(t)).unwrap_or(Value::Null)),
        "parseQuery" => {
            let mut m = Map::new();
            for (k, v) in parse_qs(s(&arg, "text")) {
                m.entry(k).or_insert_with(|| json!([])).as_array_mut().unwrap().push(json!(v));
            }
            Ok(Value::Object(m))
        }
        "urlQuery" => Ok(json!(url_query(s(&arg, "text")))),
        "close" => {
            let id = arg.get("id").and_then(|x| x.as_u64()).unwrap_or(0);
            Ok(json!(st.servers.borrow_mut().remove(&id).is_some()))
        }
        "callback" => {
            let id = arg.get("id").and_then(|x| x.as_u64()).unwrap_or(0);
            let f = callbacks().lock().unwrap().get(&id).cloned();
            match f {
                Some(f) => Ok(f(arg.get("args").and_then(|a| a.as_array()).cloned().unwrap_or_default())),
                None => Err(NativeError::error("callback is no longer valid")),
            }
        }
        "native" => {
            let n = s(&arg, "name").to_string();
            let f = natives().lock().unwrap().get(&n).cloned();
            match f {
                Some(f) => f(arg.get("arg").cloned().unwrap_or(Value::Null)).map_err(NativeError::error),
                None => Err(NativeError::type_error(format!("native function '{n}' is not available"))),
            }
        }
        other => Err(NativeError::type_error(format!("unknown native '{other}'"))),
    }
}

async fn async_call(st: Rc<HostState>, name: &str, arg: Value) -> NResult {
    match name {
        "sleep" => {
            let ms = arg.get("ms").and_then(|x| x.as_f64()).unwrap_or(0.0).max(0.0);
            tokio::time::sleep(Duration::from_secs_f64(ms / 1000.0)).await;
            Ok(Value::Null)
        }
        "fetch" => fetch(&st, &arg).await,
        "run" => run(&arg).await,
        "listen" => {
            let host = s(&arg, "host").to_string();
            let port = arg.get("port").and_then(|x| x.as_u64()).unwrap_or(0) as u16;
            let l = tokio::net::TcpListener::bind((host.as_str(), port)).await.map_err(|e| NativeError::error(e.to_string()))?;
            let port = l.local_addr().map(|a| a.port()).unwrap_or(port);
            let id = st.id();
            st.servers.borrow_mut().insert(id, Rc::new(l));
            Ok(json!({"id": id, "port": port}))
        }
        "accept" => accept(&st, &arg).await,
        "respond" => {
            let conn = arg.get("conn").and_then(|x| x.as_u64()).unwrap_or(0);
            let Some(mut sock) = st.conns.borrow_mut().remove(&conn) else {
                return Err(NativeError::error("connection already answered"));
            };
            let status = arg.get("status").and_then(|x| x.as_u64()).unwrap_or(200);
            let mut head = format!("HTTP/1.0 {status} {}\r\nServer: openagentd\r\nDate: {}\r\n", s(&arg, "reason"), chrono::Utc::now().format("%a, %d %b %Y %H:%M:%S GMT"));
            for h in arg.get("headers").and_then(|x| x.as_array()).into_iter().flatten() {
                if let (Some(k), Some(v)) = (h.get(0).and_then(|x| x.as_str()), h.get(1).and_then(|x| x.as_str())) {
                    head.push_str(&format!("{k}: {v}\r\n"));
                }
            }
            head.push_str("\r\n");
            let _ = sock.write_all(head.as_bytes()).await;
            if let Some(b) = arg.get("body").and_then(|x| x.as_str()) {
                let _ = sock.write_all(b.as_bytes()).await;
            }
            let _ = sock.shutdown().await;
            Ok(Value::Null)
        }
        other => Err(NativeError::type_error(format!("unknown native '{other}'"))),
    }
}

async fn fetch(st: &HostState, arg: &Value) -> NResult {
    let method = reqwest::Method::from_bytes(s(arg, "method").as_bytes()).map_err(|e| NativeError::type_error(e.to_string()))?;
    let mut req = st.client().request(method, s(arg, "url"));
    for h in arg.get("headers").and_then(|x| x.as_array()).into_iter().flatten() {
        if let (Some(k), Some(v)) = (h.get(0).and_then(|x| x.as_str()), h.get(1).and_then(|x| x.as_str())) {
            req = req.header(k, v);
        }
    }
    if let Some(b) = arg.get("body").and_then(|x| x.as_str()) {
        req = req.body(b.to_string());
    }
    if let Some(ms) = arg.get("timeoutMs").and_then(|x| x.as_f64()) {
        req = req.timeout(Duration::from_secs_f64(ms.max(0.0) / 1000.0));
    }
    let net = |e: reqwest::Error| {
        let mut msg = e.to_string();
        let mut src = std::error::Error::source(&e);
        while let Some(s) = src {
            msg.push_str(&format!(": {s}"));
            src = s.source();
        }
        NativeError { name: "NetworkError", message: msg, props: json!({"timeout": e.is_timeout(), "connect": e.is_connect()}) }
    };
    let resp = req.send().await.map_err(net)?;
    let status = resp.status();
    let url = resp.url().to_string();
    let headers: Vec<Value> = resp.headers().iter().map(|(k, v)| json!([k.as_str(), String::from_utf8_lossy(v.as_bytes())])).collect();
    let bytes = resp.bytes().await.map_err(net)?;
    Ok(json!({
        "status": status.as_u16(),
        "statusText": status.canonical_reason().unwrap_or(""),
        "url": url,
        "headers": headers,
        "body": String::from_utf8_lossy(&bytes),
    }))
}

async fn run(arg: &Value) -> NResult {
    let mut cmd = tokio::process::Command::new(s(arg, "cmd"));
    appv3_core::proctree::hide_window(&mut cmd);
    for a in arg.get("args").and_then(|x| x.as_array()).into_iter().flatten() {
        cmd.arg(a.as_str().unwrap_or(""));
    }
    if let Some(cwd) = arg.get("cwd").and_then(|x| x.as_str()) {
        cmd.current_dir(cwd);
    }
    let input = arg.get("input").and_then(|x| x.as_str()).map(String::from);
    cmd.stdin(if input.is_some() { std::process::Stdio::piped() } else { std::process::Stdio::null() })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| NativeError::error(e.to_string()))?;
    if let (Some(text), Some(mut stdin)) = (input, child.stdin.take()) {
        tokio::spawn(async move {
            let _ = stdin.write_all(text.as_bytes()).await;
        });
    }
    let wait = child.wait_with_output();
    let out = match arg.get("timeoutMs").and_then(|x| x.as_f64()) {
        Some(ms) => match tokio::time::timeout(Duration::from_secs_f64(ms.max(0.0) / 1000.0), wait).await {
            Ok(r) => r,
            Err(_) => return Ok(json!({"code": null, "stdout": "", "stderr": "", "timedOut": true})),
        },
        None => wait.await,
    }
    .map_err(|e| NativeError::error(e.to_string()))?;
    Ok(json!({
        "code": out.status.code(),
        "stdout": String::from_utf8_lossy(&out.stdout),
        "stderr": String::from_utf8_lossy(&out.stderr),
        "timedOut": false,
    }))
}

async fn accept(st: &HostState, arg: &Value) -> NResult {
    let id = arg.get("id").and_then(|x| x.as_u64()).unwrap_or(0);
    let Some(listener) = st.servers.borrow().get(&id).cloned() else {
        return Err(NativeError::error("server is closed"));
    };
    let fut = async {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else { continue };
            let mut buf = vec![0u8; 16384];
            let mut n = 0;
            loop {
                match sock.read(&mut buf[n..]).await {
                    Ok(0) | Err(_) => break,
                    Ok(k) => {
                        n += k;
                        if buf[..n].windows(4).any(|w| w == b"\r\n\r\n") || n == buf.len() {
                            break;
                        }
                    }
                }
            }
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let mut lines = req.split("\r\n");
            let first = lines.next().unwrap_or("");
            let mut parts = first.split_whitespace();
            let method = parts.next().unwrap_or("").to_string();
            let target = parts.next().unwrap_or("/").to_string();
            let headers: Vec<Value> = lines.take_while(|l| !l.is_empty()).filter_map(|l| l.split_once(':').map(|(k, v)| json!([k.trim(), v.trim()]))).collect();
            let no_frag = target.split_once('#').map(|(a, _)| a).unwrap_or(&target).to_string();
            let (path, query) = match no_frag.split_once('?') {
                Some((p, q)) => (p.to_string(), q.to_string()),
                None => (no_frag.clone(), String::new()),
            };
            let conn = st.id();
            st.conns.borrow_mut().insert(conn, sock);
            return json!({"conn": conn, "method": method, "target": target, "path": path, "query": query, "headers": headers});
        }
    };
    match arg.get("timeoutMs").and_then(|x| x.as_f64()) {
        Some(ms) => Ok(tokio::time::timeout(Duration::from_secs_f64(ms.max(0.0) / 1000.0), fut).await.unwrap_or(Value::Null)),
        None => Ok(fut.await),
    }
}

pub use appv3_core::which::which;

fn unquote_plus(s: &str) -> String {
    let s = s.replace('+', " ");
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hexv = |c: u8| (c as char).to_digit(16);
            if let (Some(h), Some(l)) = (hexv(bytes[i + 1]), hexv(bytes[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Python `parse_qs(qs)` (blank values dropped), in first-seen key order.
pub fn parse_qs(qs: &str) -> Vec<(String, String)> {
    let mut out = vec![];
    for pair in qs.split('&') {
        let Some((k, v)) = pair.split_once('=') else { continue };
        if v.is_empty() {
            continue;
        }
        out.push((unquote_plus(k), unquote_plus(v)));
    }
    out
}

/// `urlparse(text).query`.
pub fn url_query(text: &str) -> &str {
    let no_frag = text.split_once('#').map(|(a, _)| a).unwrap_or(text);
    no_frag.split_once('?').map(|(_, q)| q).unwrap_or("")
}

/// `int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())`.
pub fn parse_iso_ts(value: Option<&str>) -> Option<i64> {
    let s = value.filter(|s| !s.is_empty())?.replace('Z', "+00:00");
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&s) {
        return Some(dt.timestamp());
    }
    for fmt in ["%Y-%m-%dT%H:%M:%S%.f%:z", "%Y-%m-%d %H:%M:%S%.f%:z"] {
        if let Ok(dt) = chrono::DateTime::parse_from_str(&s, fmt) {
            return Some(dt.timestamp());
        }
    }
    use chrono::TimeZone;
    for fmt in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S%.f"] {
        if let Ok(ndt) = chrono::NaiveDateTime::parse_from_str(&s, fmt) {
            return chrono::Local.from_local_datetime(&ndt).single().map(|d| d.timestamp());
        }
    }
    if let Ok(d) = chrono::NaiveDate::parse_from_str(&s, "%Y-%m-%d") {
        return chrono::Local.from_local_datetime(&d.and_hms_opt(0, 0, 0)?).single().map(|d| d.timestamp());
    }
    None
}
