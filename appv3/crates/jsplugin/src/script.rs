//! Agent scripts: a model-written JavaScript / TypeScript snippet that calls
//! the agent's tools as `await tools.<name>(args)` (the `script` tool).
//!
//! Each run gets a fresh QuickJS runtime on its own thread. The code has no
//! natives of its own: no `fetch`, file system, process or environment. Its
//! globals are `tools`, `console`, `sleep(ms)` and `args`, and every
//! `tools.x(...)` and `sleep` is a request to the caller of [`run_script`],
//! which runs the tool (with whatever checks it applies) and answers. So the
//! code can do nothing the agent could not do with direct tool calls.
//!
//! The caller's future owns everything that outlives JavaScript: the logs,
//! the pending tool calls and the time limit. When the limit passes, or the
//! future is dropped (the user stopped the turn), the pending calls are
//! dropped with it, their promises reject, and the watchdog aborts any
//! JavaScript still running on the script's thread.
//!
//! Top-level `await` and `return` work: the body is wrapped in an async
//! function, with `import` declarations hoisted onto the wrapper's line so
//! line numbers in errors match the code as written (unless it needed
//! TypeScript stripping, which regenerates the code). A script run from a
//! file may import modules from its own folder and below, and nothing else.

use crate::runtime::{normalize, PluginLoader};
use crate::sandbox::ImportJail;
use crate::transpile;
use futures::stream::{FuturesUnordered, StreamExt};
use rquickjs::loader::{ImportAttributes, Resolver};
use rquickjs::prelude::Async;
use rquickjs::{AsyncContext, AsyncRuntime, Ctx, Function, Module, Promise};
use serde_json::{json, Value};
use std::cell::Cell;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};

/// Heap cap of one script's runtime.
const MEMORY_LIMIT: usize = 64 << 20;
const THREAD_STACK: usize = 16 << 20;
const JS_STACK: usize = 4 << 20;
const TICK: Duration = Duration::from_millis(250);
/// The name inline code runs under (and errors point at).
const INLINE_NAME: &str = "script";

/// What a host call resolves to: the tool's text, or the error it threw.
pub type HostFuture = Pin<Box<dyn Future<Output = Result<String, String>> + Send>>;
/// Runs `tools.<name>(args)` for the script.
pub type HostCallFn = Arc<dyn Fn(String, Value) -> HostFuture + Send + Sync>;

/// The code to run.
#[derive(Debug, Clone)]
pub struct ScriptSource {
    pub code: String,
    /// The file the code was read from: its folder is where imports may come from.
    pub file: Option<PathBuf>,
    /// The `args` global.
    pub args: Value,
}

/// Limits of one run.
#[derive(Debug, Clone)]
pub struct ScriptLimits {
    /// Wall-clock limit of the whole run, tool calls included.
    pub timeout: Duration,
    /// Longest JavaScript may run without yielding.
    pub busy: Duration,
    /// Most `tools.*` calls.
    pub max_calls: usize,
    /// Most characters of logs and return value together.
    pub max_output: usize,
}

impl Default for ScriptLimits {
    fn default() -> Self {
        Self { timeout: Duration::from_secs(270), busy: crate::BUSY_LIMIT, max_calls: 200, max_output: 50_000 }
    }
}

/// How a run ended.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ScriptOutcome {
    /// `console.*` lines, newline-joined, cut at the output limit.
    pub logs: String,
    /// The returned value: a string as is, anything else as JSON. `None` for `undefined`.
    pub value: Option<String>,
    /// Why the script failed: a syntax error, an uncaught exception (with its line), a refusal.
    pub error: Option<String>,
    /// The time limit stopped it.
    pub timed_out: bool,
    /// Output was cut at the limit.
    pub truncated: bool,
    /// `tools.*` calls the host was asked to run.
    pub calls: usize,
}

impl ScriptOutcome {
    fn failed(error: String) -> Self {
        Self { error: Some(error), ..Default::default() }
    }
}

/// Run `src` under `limits`, asking `host` for every tool call. Never panics
/// on bad code: every failure is in [`ScriptOutcome::error`].
pub async fn run_script(src: ScriptSource, limits: ScriptLimits, host: HostCallFn) -> ScriptOutcome {
    let prepared = match prepare(&src) {
        Ok(p) => p,
        Err(e) => return ScriptOutcome::failed(e),
    };
    let (req_tx, mut req_rx) = mpsc::unbounded_channel::<Req>();
    let (done_tx, mut done_rx) = oneshot::channel::<Result<Option<String>, String>>();
    let cancel = Arc::new(AtomicBool::new(false));
    // Cancels the script's thread however this future ends (finished, timed out, dropped).
    struct CancelOnDrop(Arc<AtomicBool>);
    impl Drop for CancelOnDrop {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    let _guard = CancelOnDrop(cancel.clone());
    let args = serde_json::to_string(&src.args).unwrap_or_else(|_| "null".into());
    let busy = limits.busy;
    let thread = std::thread::Builder::new().name("agent-script".into()).stack_size(THREAD_STACK).spawn(move || thread_main(prepared, args, busy, cancel, req_tx, done_tx));
    if let Err(e) = thread {
        return ScriptOutcome::failed(format!("could not start the script: {e}"));
    }

    let mut out = Output::new(limits.max_output);
    let mut calls = 0usize;
    type Answered = Pin<Box<dyn Future<Output = (oneshot::Sender<String>, Result<String, String>)> + Send>>;
    let mut pending: FuturesUnordered<Answered> = FuturesUnordered::new();
    let deadline = tokio::time::sleep(limits.timeout);
    tokio::pin!(deadline);
    let mut outcome = ScriptOutcome::default();
    loop {
        tokio::select! {
            biased;
            done = &mut done_rx => {
                // Logs sent before the script finished are already queued.
                while let Ok(req) = req_rx.try_recv() {
                    if let Req::Log(line) = req {
                        out.push(&line);
                    }
                }
                match done {
                    Ok(Ok(value)) => outcome.value = value,
                    Ok(Err(e)) => outcome.error = Some(e),
                    Err(_) => outcome.error = Some("the script stopped unexpectedly".into()),
                }
                break;
            }
            Some(req) = req_rx.recv() => match req {
                Req::Log(line) => out.push(&line),
                Req::Call { name, args, reply } => {
                    let args: Value = serde_json::from_str(&args).unwrap_or(Value::Null);
                    if name == "__sleep" {
                        let ms = args.get("ms").and_then(Value::as_f64).unwrap_or(0.0).clamp(0.0, limits.timeout.as_millis() as f64);
                        pending.push(Box::pin(async move {
                            tokio::time::sleep(Duration::from_millis(ms as u64)).await;
                            (reply, Ok(String::new()))
                        }));
                    } else if calls >= limits.max_calls {
                        let _ = reply.send(envelope(Err(format!("too many tool calls: a script may make at most {}", limits.max_calls))));
                    } else {
                        calls += 1;
                        let fut = host(name, args);
                        pending.push(Box::pin(async move { (reply, fut.await) }));
                    }
                }
            },
            Some((reply, result)) = pending.next(), if !pending.is_empty() => {
                let _ = reply.send(envelope(result));
            }
            _ = &mut deadline => {
                while let Ok(req) = req_rx.try_recv() {
                    if let Req::Log(line) = req {
                        out.push(&line);
                    }
                }
                outcome.timed_out = true;
                outcome.error = Some(format!("stopped after {} s, the time limit of a script", limits.timeout.as_secs()));
                break;
            }
        }
    }
    if let Some(v) = outcome.value.take() {
        outcome.value = Some(out.take_value(&v));
    }
    outcome.calls = calls;
    outcome.truncated = out.truncated;
    outcome.logs = out.text;
    outcome
}

/// Logs and the return value, cut at one shared limit.
struct Output {
    text: String,
    room: usize,
    truncated: bool,
}

impl Output {
    fn new(limit: usize) -> Self {
        Self { text: String::new(), room: limit, truncated: false }
    }
    fn cut(&mut self, s: &str) -> String {
        let n = s.chars().count();
        if n <= self.room {
            self.room -= n;
            return s.to_string();
        }
        self.truncated = true;
        let kept: String = s.chars().take(self.room).collect();
        self.room = 0;
        kept
    }
    fn push(&mut self, line: &str) {
        if self.truncated {
            return;
        }
        let line = self.cut(line);
        if !self.text.is_empty() {
            self.text.push('\n');
        }
        self.text.push_str(&line);
    }
    fn take_value(&mut self, v: &str) -> String {
        if self.truncated {
            return String::new();
        }
        self.cut(v)
    }
}

enum Req {
    Log(String),
    /// `tools.<name>(args)` (or `__sleep`); `reply` takes a JSON envelope.
    Call {
        name: String,
        args: String,
        reply: oneshot::Sender<String>,
    },
}

fn envelope(r: Result<String, String>) -> String {
    match r {
        Ok(text) => json!({"ok": true, "text": text}).to_string(),
        Err(error) => json!({"ok": false, "error": error}).to_string(),
    }
}

/// The code as it will run.
struct Prepared {
    /// Module name: the file's path, or [`INLINE_NAME`].
    name: String,
    js: String,
    /// Where imports may come from.
    jail: ImportJail,
    /// The source the error lines point into.
    lines_of: String,
}

/// Hoist imports, wrap the body in an async function, strip TypeScript.
fn prepare(src: &ScriptSource) -> Result<Prepared, String> {
    use oxc_allocator::Allocator;
    use oxc_span::{GetSpan, SourceType};
    let code = src.code.as_str();
    let shown = src.file.as_ref().map(|f| f.display().to_string()).unwrap_or_else(|| INLINE_NAME.to_string());
    // Regular expressions are checked here too: QuickJS would reject a bad
    // one without saying where.
    let opts = oxc_parser::ParseOptions { allow_return_outside_function: true, parse_regular_expression: true, ..Default::default() };
    let alloc = Allocator::default();
    let is_js = oxc_parser::Parser::new(&alloc, code, SourceType::mjs()).with_options(opts).parse().diagnostics.is_empty();
    let alloc = Allocator::default();
    let parsed = oxc_parser::Parser::new(&alloc, code, SourceType::ts().with_module(true)).with_options(opts).parse();
    if !parsed.diagnostics.is_empty() {
        let d = &parsed.diagnostics[0];
        let at = d.labels.first().map(|l| line_col(code, l.offset()));
        return Err(match at {
            Some((line, col)) => format!("SyntaxError at line {line}, column {col}: {}", d.message),
            None => format!("SyntaxError: {}", d.message),
        });
    }
    let mut imports = String::new();
    let mut body = code.to_string();
    for stmt in &parsed.program.body {
        if !stmt.is_module_declaration() {
            continue;
        }
        let span = stmt.span();
        let (start, end) = (span.start as usize, span.end as usize);
        if !matches!(stmt, oxc_ast::ast::Statement::ImportDeclaration(_)) {
            let (line, _) = line_col(code, span.start);
            return Err(format!("SyntaxError at line {line}: a script cannot export; return the value instead"));
        }
        let text = &code[start..end];
        imports.push_str(&text.replace(['\n', '\r'], " "));
        if !text.trim_end().ends_with(';') {
            imports.push(';');
        }
        imports.push(' ');
        // Blank the import out of the body, keeping its line breaks.
        let blank: String = text.chars().map(|c| if c == '\n' || c == '\r' { c } else { ' ' }).collect();
        body.replace_range(start..end, &blank);
    }
    let wrapped = format!("{imports}globalThis.__oad_main = async function (args) {{{body}\n}};\n");
    let js = if is_js { wrapped } else { transpile::transpile(Path::new("script.ts"), &wrapped).map_err(|e| e.replacen("script.ts:", "SyntaxError at ", 1))? };
    let (name, roots) = match &src.file {
        Some(f) => {
            let real = dunce::canonicalize(f).map_err(|e| format!("cannot open {shown}: {e}"))?;
            let dir = real.parent().map(Path::to_path_buf).unwrap_or_default();
            (real.to_string_lossy().into_owned(), vec![dir])
        }
        None => (INLINE_NAME.to_string(), vec![]),
    };
    let lines_of = if is_js { code.to_string() } else { js.clone() };
    Ok(Prepared { name, js, jail: ImportJail::new(&shown, roots), lines_of })
}

fn line_col(src: &str, offset: u32) -> (usize, usize) {
    let upto = &src[..(offset as usize).min(src.len())];
    let line = upto.matches('\n').count() + 1;
    let col = upto.rsplit('\n').next().map(|l| l.chars().count()).unwrap_or(0) + 1;
    (line, col)
}

/// The JavaScript every script starts with: `console`, `tools`, `sleep`,
/// `ToolError`, and the helpers the host calls. `__s` (the two natives) is
/// captured and removed from the global scope.
const BOOT: &str = r#"(() => {
  const s = globalThis.__s; delete globalThis.__s;
  const fmt = (v) => {
    if (typeof v === "string") return v;
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    try { const j = JSON.stringify(v, (k, x) => typeof x === "bigint" ? String(x) : x, 2); return j === undefined ? String(v) : j; }
    catch { return String(v); }
  };
  const log = (...a) => s.log(a.map(fmt).join(" "));
  globalThis.console = { log, info: log, warn: log, error: log, debug: log };
  class ToolError extends Error {
    constructor(tool, message) { super(message); this.name = "ToolError"; this.tool = tool; }
  }
  globalThis.ToolError = ToolError;
  const call = async (name, a, site) => {
    const r = JSON.parse(await s.call(name, JSON.stringify(a === undefined ? {} : a)));
    if (r.ok) return r.text;
    const e = new ToolError(name, r.error);
    // The stack of the call site, so the error names the script's line.
    if (site) e.stack = site.stack;
    throw e;
  };
  globalThis.tools = new Proxy({}, {
    get: (_, name) => typeof name === "string" && name !== "then" ? (a) => call(name, a, new Error()) : undefined,
  });
  globalThis.sleep = async (ms) => { await call("__sleep", { ms: Number(ms) || 0 }); };
  globalThis.__oad_finish = async (argsJson) => {
    const v = await globalThis.__oad_main(JSON.parse(argsJson));
    return v === undefined ? null : fmt(v);
  };
  globalThis.__oad_err = (e) => {
    if (e instanceof Error) return JSON.stringify({ name: e.name, message: e.message, stack: e.stack || "", line: e.lineNumber || 0 });
    return JSON.stringify({ name: "Error", message: fmt(e), stack: "" });
  };
})();"#;

thread_local! {
    static INTERRUPTED: Cell<bool> = const { Cell::new(false) };
}

fn thread_main(p: Prepared, args: String, busy: Duration, cancel: Arc<AtomicBool>, req_tx: mpsc::UnboundedSender<Req>, done_tx: oneshot::Sender<Result<Option<String>, String>>) {
    let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            let _ = done_tx.send(Err(e.to_string()));
            return;
        }
    };
    let local = tokio::task::LocalSet::new();
    local.block_on(&rt, async move {
        let last_tick = Rc::new(Cell::new(Instant::now()));
        let beat = last_tick.clone();
        let ticker = tokio::task::spawn_local(async move {
            loop {
                tokio::time::sleep(TICK).await;
                beat.set(Instant::now());
            }
        });
        let qrt = match AsyncRuntime::new() {
            Ok(r) => r,
            Err(e) => {
                let _ = done_tx.send(Err(e.to_string()));
                return;
            }
        };
        qrt.set_memory_limit(MEMORY_LIMIT).await;
        qrt.set_max_stack_size(JS_STACK).await;
        let stop = cancel.clone();
        qrt.set_interrupt_handler(Some(Box::new(move || {
            if stop.load(Ordering::SeqCst) || last_tick.get().elapsed() > busy {
                last_tick.set(Instant::now());
                INTERRUPTED.with(|f| f.set(true));
                return true;
            }
            false
        })))
        .await;
        let refused = Rc::new(std::cell::RefCell::new(None::<String>));
        qrt.set_loader(ScriptResolver { jail: p.jail.clone(), refused: refused.clone() }, PluginLoader).await;
        let ctx = match AsyncContext::full(&qrt).await {
            Ok(c) => c,
            Err(e) => {
                let _ = done_tx.send(Err(e.to_string()));
                return;
            }
        };
        let busy_s = busy.as_secs();
        let run = ctx.async_with(async |ctx| -> Result<Option<String>, String> {
            let r: rquickjs::Result<Option<String>> = async {
                install(&ctx, req_tx)?;
                ctx.eval::<(), _>(BOOT)?;
                let (_m, done) = Module::declare(ctx.clone(), p.name.clone(), p.js.clone())?.eval()?;
                done.into_future::<()>().await?;
                let finish: Function = ctx.globals().get("__oad_finish")?;
                let pr: Promise = finish.call((args,))?;
                pr.into_future::<Option<String>>().await
            }
            .await;
            r.map_err(|e| match refused.borrow_mut().take() {
                // QuickJS cuts a resolve error short; report the refusal whole.
                Some(msg) => {
                    let _ = ctx.catch();
                    format!("ImportError: {msg}")
                }
                None => script_error(&ctx, e, &p, busy_s),
            })
        });
        let driver = tokio::task::spawn_local(qrt.drive());
        let result = tokio::select! {
            r = run => Some(r),
            _ = wait_cancel(&cancel) => None,
        };
        driver.abort();
        ticker.abort();
        if let Some(r) = result {
            let _ = done_tx.send(r);
        }
        drop(ctx);
        drop(qrt);
    });
}

async fn wait_cancel(cancel: &AtomicBool) {
    while !cancel.load(Ordering::SeqCst) {
        tokio::time::sleep(TICK).await;
    }
}

fn install(ctx: &Ctx<'_>, req_tx: mpsc::UnboundedSender<Req>) -> rquickjs::Result<()> {
    let s = rquickjs::Object::new(ctx.clone())?;
    let log_tx = req_tx.clone();
    s.set(
        "log",
        Function::new(ctx.clone(), move |line: String| {
            let _ = log_tx.send(Req::Log(line));
        })?,
    )?;
    s.set(
        "call",
        Function::new(
            ctx.clone(),
            Async(move |name: String, args: String| {
                let tx = req_tx.clone();
                async move {
                    let (reply, rx) = oneshot::channel();
                    if tx.send(Req::Call { name, args, reply }).is_err() {
                        return Ok::<String, rquickjs::Error>(envelope(Err("the script was stopped".into())));
                    }
                    Ok(rx.await.unwrap_or_else(|_| envelope(Err("the script was stopped".into()))))
                }
            }),
        )?,
    )?;
    ctx.globals().set("__s", s)?;
    Ok(())
}

/// A caught failure as one line for the model: name, message and the line it came from.
fn script_error(ctx: &Ctx<'_>, e: rquickjs::Error, p: &Prepared, busy_s: u64) -> String {
    if INTERRUPTED.with(|f| f.replace(false)) {
        let _ = ctx.catch();
        return format!("TimeoutError: the script ran JavaScript for more than {busy_s} s without awaiting anything; interrupted");
    }
    if !matches!(e, rquickjs::Error::Exception) {
        return e.to_string();
    }
    let caught = ctx.catch();
    let json = ctx.globals().get::<_, Function>("__oad_err").ok().and_then(|f| f.call::<_, String>((caught.clone(),)).ok());
    let Some(v) = json.and_then(|s| serde_json::from_str::<Value>(&s).ok()) else {
        return format!("{caught:?}");
    };
    let name = v.get("name").and_then(Value::as_str).unwrap_or("Error");
    let mut message = v.get("message").and_then(Value::as_str).unwrap_or("").to_string();
    // The usual slip: treating a tool's text as an array (`files.map(...)`).
    if name == "TypeError" && message == "not a function" {
        message.push_str(" (a tools.* result is a string: split it, e.g. text.split(\"\\n\"), before using array methods)");
    }
    let stack = v.get("stack").and_then(Value::as_str).unwrap_or("");
    // A compile-time error carries its line instead of a stack.
    let line = error_line(stack, &p.name).or_else(|| v.get("line").and_then(Value::as_u64).map(|n| n as usize).filter(|n| *n > 0));
    match line {
        Some(line) => {
            let text = p.lines_of.lines().nth(line - 1).map(str::trim).unwrap_or("");
            let text: String = text.chars().take(160).collect();
            if text.is_empty() {
                format!("{name} at line {line}: {message}")
            } else {
                format!("{name} at line {line}: {message}\n  {line} | {text}")
            }
        }
        None => format!("{name}: {message}"),
    }
}

/// The first line number the stack gives inside the script's own module.
fn error_line(stack: &str, module: &str) -> Option<usize> {
    let pats = [format!("({module}:"), format!("at {module}:")];
    stack.lines().find_map(|l| {
        let at = pats.iter().find_map(|p| l.find(p.as_str()).map(|i| i + p.len()))?;
        l[at..].split(|c: char| !c.is_ascii_digit()).next()?.parse().ok().filter(|n| *n > 0)
    })
}

/// Relative imports only, inside the jail.
struct ScriptResolver {
    jail: ImportJail,
    /// The last refusal, in full.
    refused: Rc<std::cell::RefCell<Option<String>>>,
}

impl Resolver for ScriptResolver {
    fn resolve<'js>(&mut self, _ctx: &Ctx<'js>, base: &str, name: &str, _attrs: Option<ImportAttributes<'js>>) -> rquickjs::Result<String> {
        let refuse = |msg: String| {
            *self.refused.borrow_mut() = Some(msg.clone());
            Err(rquickjs::Error::new_resolving_message(base, name, msg))
        };
        let relative = name.starts_with("./") || name.starts_with("../") || (cfg!(windows) && (name.starts_with(".\\") || name.starts_with("..\\")));
        if !relative || base == INLINE_NAME {
            return refuse(format!("cannot import {name}: a script may import only relative files next to its own file"));
        }
        let dir = Path::new(base).parent().unwrap_or(Path::new("/"));
        let p = normalize(&dir.join(name));
        let s = p.to_string_lossy();
        let candidates = [p.clone(), PathBuf::from(format!("{s}.ts")), PathBuf::from(format!("{s}.js")), p.join("index.ts"), p.join("index.js")];
        let Some(c) = candidates.iter().find(|c| c.is_file()) else {
            return refuse(format!("cannot import {name}: file not found"));
        };
        match self.jail.check(c, name) {
            Ok(real) => Ok(real.to_string_lossy().into_owned()),
            Err(_) => refuse(format!("cannot import {name}: it is outside the script's own folder")),
        }
    }
}

#[cfg(test)]
mod tests;
