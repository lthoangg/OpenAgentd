//! MCP app panels: where an app's HTML is kept, and what a panel last
//! reported for the model.
//!
//! **HTML.** An app's page can be megabytes, and every call of its tool
//! returns the same page. It is written once to
//! `<data_dir>/mcp-apps/<sha256>.html`; the tool result (`extra.mcp_app`)
//! carries `html_sha256` instead of `html`. Results stored before this keep
//! their inline `html` and still load.
//!
//! **Model context.** A panel can report state for the model (what is on a
//! canvas, what the user picked). The newest report of each panel waits here
//! and is given to the model with the session's next user message. A
//! session's reports are also a file in its data folder
//! (`<data_dir>/sessions/<id>/mcp-app-reports.json`), so they outlive a
//! restart and go when the session is deleted.
//!
//! **Unused pages.** A page stays while a tool result names it. Deleting a
//! session removes the pages only it named, and every start removes pages
//! nothing names any more (results reverted, a server that stopped midway).

use appv3_db::DbPool;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

pub const HTML_KEY: &str = "html";
pub const HTML_SHA_KEY: &str = "html_sha256";

/// The longest report passed to the model; the rest is cut.
pub const MAX_CONTEXT_CHARS: usize = 24_000;
/// Panels of one session whose reports are kept; the oldest goes first.
const MAX_PANELS: usize = 16;
/// A page this new is kept even when no result names it: the result that
/// does is saved a moment after its page.
const PAGE_GRACE: Duration = Duration::from_secs(60);
const REPORTS_FILE: &str = "mcp-app-reports.json";

fn html_dir() -> PathBuf {
    appv3_core::settings::settings().data_dir.join("mcp-apps")
}

fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Move the page out of `app` into the HTML folder, leaving its hash. If the
/// file cannot be written the page stays inline, so the app still renders.
pub async fn store_html(app: &mut Value) {
    store_html_in(&html_dir(), app).await
}

async fn store_html_in(dir: &Path, app: &mut Value) {
    let Some(html) = app.get(HTML_KEY).and_then(Value::as_str).filter(|h| !h.is_empty()).map(String::from) else { return };
    let sha = sha256_hex(&html);
    let path = dir.join(format!("{sha}.html"));
    let written = async {
        if tokio::fs::try_exists(&path).await? {
            // Named again: it is new for `PAGE_GRACE` once more.
            let _ = std::fs::File::options().write(true).open(&path).and_then(|f| f.set_modified(SystemTime::now()));
            return Ok(());
        }
        tokio::fs::create_dir_all(dir).await?;
        // Two calls may store the same page at once: each writes its own
        // temporary file, and the rename is atomic.
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let tmp = dir.join(format!("{sha}.{}.{}.tmp", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)));
        tokio::fs::write(&tmp, html.as_bytes()).await?;
        tokio::fs::rename(&tmp, &path).await
    };
    match written.await {
        Ok(()) => {
            if let Some(o) = app.as_object_mut() {
                o.remove(HTML_KEY);
                o.insert(HTML_SHA_KEY.into(), json!(sha));
            }
        }
        Err(e) => tracing::warn!("mcp_app_html_store_failed path={} error={}", path.display(), e),
    }
}

/// The page of a stored `mcp_app`: inline (older results) or by its hash.
pub async fn load_html(app: &Value) -> Option<String> {
    load_html_in(&html_dir(), app).await
}

async fn load_html_in(dir: &Path, app: &Value) -> Option<String> {
    if let Some(html) = app.get(HTML_KEY).and_then(Value::as_str).filter(|h| !h.is_empty()) {
        return Some(html.to_string());
    }
    let sha = app.get(HTML_SHA_KEY).and_then(Value::as_str).filter(|s| is_sha256_hex(s))?;
    tokio::fs::read_to_string(dir.join(format!("{sha}.html"))).await.ok()
}

/// The pages named by the results of these sessions (ids in any spelling).
/// Ask before deleting the sessions, then pass the answer to
/// [`remove_unused_pages`].
pub async fn pages_of(pool: &DbPool, session_ids: &[String]) -> Vec<String> {
    appv3_db::mcp_app_page_hashes(pool, Some(session_ids)).await.unwrap_or_else(|e| {
        tracing::warn!("mcp_app_pages_lookup_failed error={}", e);
        vec![]
    })
}

/// Delete stored pages no tool result names any more: of `candidates`, or of
/// the whole folder (with temporary files a stopped write left behind).
pub async fn remove_unused_pages(pool: &DbPool, candidates: Option<Vec<String>>) {
    remove_unused_pages_in(&html_dir(), pool, candidates, PAGE_GRACE).await
}

async fn remove_unused_pages_in(dir: &Path, pool: &DbPool, candidates: Option<Vec<String>>, grace: Duration) {
    let old = |path: &Path| std::fs::metadata(path).and_then(|m| m.modified()).is_ok_and(|at| at.elapsed().is_ok_and(|age| age >= grace));
    let mut pages: Vec<(String, PathBuf)> = vec![];
    match candidates {
        Some(hashes) => pages.extend(hashes.into_iter().filter(|h| is_sha256_hex(h)).map(|h| (h.clone(), dir.join(format!("{h}.html"))))),
        None => {
            let Ok(entries) = std::fs::read_dir(dir) else { return };
            for path in entries.flatten().map(|e| e.path()) {
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
                match name.strip_suffix(".html") {
                    Some(hash) if is_sha256_hex(hash) => pages.push((hash.to_string(), path)),
                    None if name.ends_with(".tmp") && old(&path) => {
                        let _ = std::fs::remove_file(&path);
                    }
                    _ => {}
                }
            }
        }
    }
    pages.retain(|(_, path)| old(path));
    if pages.is_empty() {
        return;
    }
    let named: HashSet<String> = match appv3_db::mcp_app_page_hashes(pool, None).await {
        Ok(hashes) => hashes.into_iter().collect(),
        Err(e) => return tracing::warn!("mcp_app_pages_lookup_failed error={}", e),
    };
    for (hash, path) in pages.into_iter().filter(|(hash, _)| !named.contains(hash)) {
        match std::fs::remove_file(&path) {
            Ok(()) => tracing::info!("mcp_app_page_removed sha256={}", hash),
            Err(e) => tracing::warn!("mcp_app_page_remove_failed path={} error={}", path.display(), e),
        }
    }
}

// ── the page as the panel's frame loads it ──────────────────────────────────

/// What the frame may do: run scripts and submit forms, in an origin of its
/// own. Sent as the `sandbox` directive too, so the page is just as confined
/// when its address is opened outside a frame.
pub const FRAME_SANDBOX: &str = "allow-scripts allow-forms";

/// The sources of one `_meta.ui.csp` list that are safe to put in a policy:
/// a source is one token, and a quote, semicolon, comma or space in it could
/// add keywords or whole directives.
fn csp_sources(csp: Option<&Value>, key: &str) -> Vec<String> {
    let list = csp.and_then(|c| c.get(key)).and_then(Value::as_array);
    list.into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_graphic() && !b";,'\"<>".contains(&b)))
        .map(String::from)
        .collect()
}

/// The `Content-Security-Policy` of an app's page, from the domains its
/// resource declares (`resourceMeta.ui.csp`). Nothing here names `'self'`:
/// the page is served from the API's address and must not reach the API.
pub fn frame_csp(app: &Value) -> String {
    let csp = app.pointer("/resourceMeta/ui/csp");
    let or_none = |v: Vec<String>| if v.is_empty() { "'none'".to_string() } else { v.join(" ") };
    let resources = ["blob:".to_string(), "data:".to_string()].into_iter().chain(csp_sources(csp, "resourceDomains")).collect::<Vec<_>>().join(" ");
    [
        "default-src 'none'".to_string(),
        format!("script-src {resources} 'unsafe-inline' 'unsafe-eval'"),
        format!("style-src {resources} 'unsafe-inline'"),
        format!("img-src {resources}"),
        format!("font-src {resources}"),
        format!("media-src {resources}"),
        format!("worker-src {resources}"),
        format!("connect-src {}", or_none(csp_sources(csp, "connectDomains"))),
        format!("frame-src {}", or_none(csp_sources(csp, "frameDomains"))),
        "object-src 'none'".to_string(),
        format!("base-uri {}", or_none(csp_sources(csp, "baseUriDomains"))),
        format!("sandbox {FRAME_SANDBOX}"),
    ]
    .join("; ")
}

/// `html` with `head` (the host's own scripts) first in its `<head>`, so they
/// run before the app's. A page without a `<head>` is wrapped in one.
pub fn with_head(html: &str, head: &str) -> String {
    if head.is_empty() {
        return html.to_string();
    }
    let lower = html.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find("<head") {
        let after = from + i + "<head".len();
        match lower.as_bytes().get(after) {
            Some(b'>') => return format!("{}{head}{}", &html[..=after], &html[after + 1..]),
            Some(c) if c.is_ascii_whitespace() => {
                if let Some(end) = lower[after..].find('>') {
                    let end = after + end;
                    return format!("{}{head}{}", &html[..=end], &html[end + 1..]);
                }
                break;
            }
            _ => from = after,
        }
    }
    format!("<!doctype html><html><head>{head}</head><body>{html}</body></html>")
}

// ── model context ───────────────────────────────────────────────────────────

#[derive(Clone, Serialize, Deserialize)]
struct Report {
    tool_call_id: String,
    label: String,
    text: String,
    delivered: bool,
}

/// Every session's reports. A session's list is read from its file the
/// first time it is asked for and written back on each change.
struct Reports {
    sessions_dir: PathBuf,
    loaded: Mutex<HashMap<String, Vec<Report>>>,
}

fn reports() -> &'static Reports {
    static R: OnceLock<Reports> = OnceLock::new();
    R.get_or_init(|| Reports::new(appv3_core::settings::settings().data_dir.join("sessions")))
}

impl Reports {
    fn new(sessions_dir: PathBuf) -> Self {
        Reports { sessions_dir, loaded: Mutex::default() }
    }

    /// The session's file, in the folder deleted with the session. An id
    /// that is not a UUID has none: its reports stay in memory.
    fn file(&self, session_id: &str) -> Option<PathBuf> {
        let id = appv3_db::codec::parse_uuid(session_id)?;
        Some(self.sessions_dir.join(id.hyphenated().to_string()).join(REPORTS_FILE))
    }

    /// Run `change` on the session's reports; it answers whether it changed them.
    fn with<R>(&self, session_id: &str, change: impl FnOnce(&mut Vec<Report>) -> (R, bool)) -> R {
        let file = self.file(session_id);
        let mut all = self.loaded.lock().unwrap();
        // Session ids arrive with and without dashes.
        let panels = all.entry(appv3_db::codec::db_id(session_id)).or_insert_with(|| file.as_deref().map(read_reports).unwrap_or_default());
        let (out, changed) = change(panels);
        if let Some(file) = file.filter(|_| changed) {
            if let Err(e) = write_reports(&file, panels) {
                tracing::warn!("mcp_app_reports_save_failed path={} error={}", file.display(), e);
            }
        }
        out
    }

    fn report(&self, session_id: &str, tool_call_id: &str, label: &str, text: &str) {
        let mut text = text.trim().to_string();
        if text.chars().count() > MAX_CONTEXT_CHARS {
            text = text.chars().take(MAX_CONTEXT_CHARS).collect::<String>() + "\n[cut: the report was longer]";
        }
        self.with(session_id, |panels| {
            let at = panels.iter().position(|r| r.tool_call_id == tool_call_id);
            let changed = match at {
                Some(i) if text.is_empty() => {
                    panels.remove(i);
                    true
                }
                Some(i) if panels[i].text == text => false,
                Some(i) => {
                    panels[i].text = text;
                    panels[i].delivered = false;
                    true
                }
                None if text.is_empty() => false,
                None => {
                    if panels.len() >= MAX_PANELS {
                        panels.remove(0);
                    }
                    panels.push(Report { tool_call_id: tool_call_id.into(), label: label.into(), text, delivered: false });
                    true
                }
            };
            ((), changed)
        })
    }

    fn take(&self, session_id: &str) -> Option<String> {
        let out = self.with(session_id, |panels| {
            let mut out: Vec<String> = vec![];
            for r in panels.iter_mut().filter(|r| !r.delivered) {
                r.delivered = true;
                out.push(format!("<mcp_app_context app={}>\n{}\n</mcp_app_context>", Value::String(r.label.clone()), r.text));
            }
            let changed = !out.is_empty();
            (out, changed)
        });
        if out.is_empty() {
            return None;
        }
        Some(format!("Current state reported by the MCP app panel in this conversation. It replaces what the same panel reported before.\n\n{}", out.join("\n\n")))
    }
}

fn read_reports(file: &Path) -> Vec<Report> {
    std::fs::read(file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn write_reports(file: &Path, panels: &[Report]) -> std::io::Result<()> {
    if panels.is_empty() {
        return match std::fs::remove_file(file) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        };
    }
    if let Some(folder) = file.parent() {
        std::fs::create_dir_all(folder)?;
    }
    // Written whole, then renamed: a stop midway leaves the last full file.
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(panels)?)?;
    std::fs::rename(&tmp, file)
}

/// The text of a `ui/update-model-context` request: its text blocks, then its
/// structured content as JSON. Other block types are named, not included.
pub fn context_text(content: Option<&Value>, structured: Option<&Value>) -> String {
    let mut parts: Vec<String> = vec![];
    for b in content.and_then(Value::as_array).into_iter().flatten() {
        match b.get("type").and_then(Value::as_str) {
            Some("text") => parts.extend(b.get("text").and_then(Value::as_str).filter(|t| !t.trim().is_empty()).map(String::from)),
            Some(other) => parts.push(format!("[{other}]")),
            None => {}
        }
    }
    if let Some(s) = structured.and_then(Value::as_object).filter(|o| !o.is_empty()) {
        parts.push(Value::Object(s.clone()).to_string());
    }
    parts.join("\n")
}

/// Keep `text` as the newest report of the panel of `tool_call_id`. An empty
/// report withdraws the panel's last one; an unchanged report changes nothing,
/// so a panel that repeats itself is not passed to the model twice.
pub fn report_model_context(session_id: &str, tool_call_id: &str, label: &str, text: &str) {
    reports().report(session_id, tool_call_id, label, text)
}

/// The reports the model has not seen yet, as one note; they then count as
/// seen. `None` when no panel reported anything new.
pub fn take_model_context(session_id: &str) -> Option<String> {
    reports().take(session_id)
}

/// Drop a deleted session's reports from memory; their file went with the
/// session's folder.
pub fn forget_session(session_id: &str) {
    reports().loaded.lock().unwrap().remove(&appv3_db::codec::db_id(session_id));
}

/// `extra` of the hidden note that carries [`take_model_context`]'s text.
pub fn context_note_extra() -> Map<String, Value> {
    let mut e = Map::new();
    e.insert("hidden_from_user".into(), json!(true));
    e.insert("hidden_from_summary".into(), json!(true));
    e.insert("mcp_app_context".into(), json!(true));
    e
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_page_is_written_once_and_results_carry_its_hash() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("mcp-apps");
        let page = "<html><body>canvas</body></html>";
        let mut first = json!({"server": "canvas", "html": page});
        let mut second = json!({"server": "canvas", "html": page});
        store_html_in(&store, &mut first).await;
        store_html_in(&store, &mut second).await;

        assert!(first.get("html").is_none() && second.get("html").is_none(), "{first}");
        assert_eq!(first["html_sha256"], second["html_sha256"]);
        let files: Vec<_> = std::fs::read_dir(&store).unwrap().map(|f| f.unwrap().file_name().into_string().unwrap()).collect();
        assert_eq!(files, [format!("{}.html", first["html_sha256"].as_str().unwrap())], "one file, no leftovers");
        assert_eq!(load_html_in(&store, &second).await.as_deref(), Some(page));
    }

    #[tokio::test]
    async fn older_results_load_inline_and_a_bad_hash_loads_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load_html_in(dir.path(), &json!({"html": "<p>old</p>"})).await.as_deref(), Some("<p>old</p>"));
        std::fs::write(dir.path().join("secret.html"), "x").unwrap();
        for sha in ["../secret", "secret", "", &"g".repeat(64)] {
            assert_eq!(load_html_in(dir.path(), &json!({"html_sha256": sha})).await, None, "{sha}");
        }
        assert_eq!(load_html_in(dir.path(), &json!({"html_sha256": "a".repeat(64)})).await, None, "no such file");
    }

    #[tokio::test]
    async fn a_page_that_cannot_be_written_stays_inline() {
        let dir = tempfile::tempdir().unwrap();
        let blocked = dir.path().join("file");
        std::fs::write(&blocked, "not a folder").unwrap();
        let mut app = json!({"html": "<p>x</p>"});
        store_html_in(&blocked, &mut app).await;
        assert_eq!(app, json!({"html": "<p>x</p>"}));
    }

    #[test]
    fn the_frame_policy_names_only_declared_domains_and_never_the_host() {
        let app = json!({"resourceMeta": {"ui": {"csp": {
            "resourceDomains": ["https://cdn.example", "https://a.example; script-src *", "'unsafe-hashes'"],
            "connectDomains": ["https://api.example", "https://b.example https://c.example", "wss://live.example"],
        }}}});
        let csp = frame_csp(&app);
        assert!(csp.contains("script-src blob: data: https://cdn.example 'unsafe-inline' 'unsafe-eval';"), "{csp}");
        assert!(csp.contains("connect-src https://api.example wss://live.example;"), "{csp}");
        assert!(csp.contains("frame-src 'none';") && csp.contains("base-uri 'none';"), "{csp}");
        assert!(csp.ends_with("; sandbox allow-scripts allow-forms"), "{csp}");
        for bad in ["'self'", "a.example", "c.example", "unsafe-hashes", "allow-same-origin"] {
            assert!(!csp.contains(bad), "{bad} in {csp}");
        }
        let bare = frame_csp(&json!({"resourceMeta": null}));
        assert!(bare.contains("connect-src 'none';") && bare.contains("img-src blob: data:;"), "{bare}");
    }

    #[test]
    fn the_hosts_scripts_go_first_in_the_head() {
        let head = "<script>shim()</script>";
        assert_eq!(with_head("<html><head><script>app()</script></head></html>", head), "<html><head><script>shim()</script><script>app()</script></head></html>");
        assert_eq!(with_head("<HTML><HEAD lang=\"en\"><title>x</title>", head), "<HTML><HEAD lang=\"en\"><script>shim()</script><title>x</title>");
        assert_eq!(with_head("<header>x</header><p>app</p>", head), "<!doctype html><html><head><script>shim()</script></head><body><header>x</header><p>app</p></body></html>");
        assert_eq!(with_head("<p>é</p><head>", head), "<p>é</p><head><script>shim()</script>");
        assert_eq!(with_head("<p>app</p>", ""), "<p>app</p>");
    }

    #[test]
    fn context_text_joins_text_blocks_and_structured_content() {
        let content = json!([{"type": "text", "text": "2 shapes"}, {"type": "image", "data": "AAAA"}, {"type": "text", "text": "  "}]);
        assert_eq!(context_text(Some(&content), Some(&json!({"canvasId": "c1"}))), "2 shapes\n[image]\n{\"canvasId\":\"c1\"}");
        assert_eq!(context_text(None, Some(&json!({}))), "");
    }

    #[test]
    fn the_model_gets_each_panels_newest_report_once() {
        let dir = tempfile::tempdir().unwrap();
        let reports = Reports::new(dir.path().to_path_buf());
        let report_model_context = |sid: &str, call: &str, label: &str, text: &str| reports.report(sid, call, label, text);
        let take_model_context = |sid: &str| reports.take(sid);
        let sid = "0190aaaa-0000-7000-8000-00000000c0de";
        assert_eq!(take_model_context(sid), None);
        report_model_context(sid, "call-1", "canvas · exec", "1 shape");
        report_model_context(sid, "call-1", "canvas · exec", "2 shapes");
        report_model_context(&sid.replace('-', ""), "call-2", "chart · show", "bar chart");
        let note = take_model_context(sid).unwrap();
        assert!(note.contains("<mcp_app_context app=\"canvas · exec\">\n2 shapes\n</mcp_app_context>"), "{note}");
        assert!(note.contains("bar chart") && !note.contains("1 shape"), "{note}");
        assert_eq!(take_model_context(sid), None, "nothing new");

        report_model_context(sid, "call-1", "canvas · exec", "2 shapes");
        assert_eq!(take_model_context(sid), None, "the same report again is not new");
        report_model_context(sid, "call-1", "canvas · exec", "3 shapes");
        let note = take_model_context(sid).unwrap();
        assert!(note.contains("3 shapes") && !note.contains("bar chart"), "{note}");

        report_model_context(sid, "call-2", "chart · show", &"x".repeat(MAX_CONTEXT_CHARS + 10));
        let note = take_model_context(sid).unwrap();
        assert!(note.contains("[cut: the report was longer]") && note.len() < MAX_CONTEXT_CHARS + 400, "{}", note.len());

        report_model_context(sid, "call-1", "canvas · exec", "4 shapes");
        report_model_context(sid, "call-1", "canvas · exec", "");
        assert_eq!(take_model_context(sid), None, "an empty report withdraws the last one");
    }

    #[test]
    fn reports_wait_through_a_restart_and_go_with_the_sessions_folder() {
        let dir = tempfile::tempdir().unwrap();
        let started = || Reports::new(dir.path().to_path_buf());
        let sid = "0190aaaa-0000-7000-8000-00000000c0de";
        let folder = dir.path().join(sid);

        let first = started();
        first.report(sid, "call-1", "canvas · exec", "1 shape");
        first.report(sid, "call-2", "chart · show", "bar chart");
        assert!(first.take(sid).unwrap().contains("bar chart"));
        first.report(&sid.replace('-', ""), "call-1", "canvas · exec", "2 shapes");

        // A report the model has not seen is still there after a restart;
        // one it has seen is not given again.
        let second = started();
        let note = second.take(sid).unwrap();
        assert!(note.contains("2 shapes") && !note.contains("bar chart"), "{note}");
        let third = started();
        third.report(sid, "call-1", "canvas · exec", "2 shapes");
        assert_eq!(third.take(sid), None, "the same report again is not new after a restart either");

        // Withdrawn reports leave no file; the folder goes with the session.
        third.report(sid, "call-1", "canvas · exec", "");
        third.report(sid, "call-2", "chart · show", "");
        assert!(!folder.join(REPORTS_FILE).exists());
        third.report(sid, "call-1", "canvas · exec", "3 shapes");
        assert!(folder.join(REPORTS_FILE).exists());
        std::fs::remove_dir_all(&folder).unwrap();
        assert_eq!(started().take(sid), None);

        // Only a session id names a folder.
        first.report("../escape", "call-1", "canvas · exec", "x");
        assert!(first.take("../escape").is_some());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0, "nothing is written for an id that is not a UUID");
    }

    #[tokio::test]
    async fn a_page_goes_when_no_result_names_it() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("mcp-apps");
        let pool = appv3_db::create_pool(dir.path().join("t.db")).await.unwrap();
        let session = || async { appv3_db::create_session(&pool, appv3_db::NewSession::default()).await.unwrap().id };
        let (kept, deleted) = (session().await, session().await);
        let result = |sid: String, page: &'static str| {
            let (pool, store) = (pool.clone(), store.clone());
            async move {
                let mut app = json!({"server": "canvas", "html": page});
                store_html_in(&store, &mut app).await;
                let mut row = appv3_db::NewMessage::tool("call", "mcp", "drawn");
                row.extra = Some(json!({"mcp_app": app}).as_object().unwrap().clone());
                appv3_db::save_message(&pool, &sid, row).await.unwrap();
                format!("{}.html", app["html_sha256"].as_str().unwrap())
            }
        };
        let shared = result(kept.clone(), "<p>shared</p>").await;
        assert_eq!(result(deleted.clone(), "<p>shared</p>").await, shared);
        let own = result(deleted.clone(), "<p>own</p>").await;
        let mut unnamed = json!({"html": "<p>unnamed</p>"});
        store_html_in(&store, &mut unnamed).await;
        let unnamed = format!("{}.html", unnamed["html_sha256"].as_str().unwrap());
        std::fs::write(store.join("abc.1.2.tmp"), "half").unwrap();
        let stored = || {
            let mut names: Vec<String> = std::fs::read_dir(&store).unwrap().map(|f| f.unwrap().file_name().into_string().unwrap()).collect();
            names.sort();
            names
        };
        let sorted = |mut names: Vec<String>| {
            names.sort();
            names
        };

        // A page just written is kept: its result may not be saved yet.
        remove_unused_pages_in(&store, &pool, None, Duration::from_secs(60)).await;
        assert_eq!(stored().len(), 4);

        // Deleting a session removes the pages only it named.
        let pages = pages_of(&pool, &[appv3_db::codec::api_uuid(&deleted)]).await;
        assert_eq!(pages.len(), 2);
        appv3_db::delete_session_rows(&pool, &deleted).await.unwrap();
        remove_unused_pages_in(&store, &pool, Some(pages), Duration::ZERO).await;
        assert!(!store.join(&own).exists());
        assert_eq!(stored(), sorted(vec![shared.clone(), unnamed.clone(), "abc.1.2.tmp".into()]));

        // A start removes what nothing names, and what a stopped write left.
        remove_unused_pages_in(&store, &pool, None, Duration::ZERO).await;
        assert_eq!(stored(), std::slice::from_ref(&shared));
        assert_eq!(load_html_in(&store, &json!({"html_sha256": shared.trim_end_matches(".html")})).await.as_deref(), Some("<p>shared</p>"));
    }

    #[tokio::test]
    async fn a_page_named_again_counts_as_new() {
        let dir = tempfile::tempdir().unwrap();
        let mut app = json!({"html": "<p>x</p>"});
        store_html_in(dir.path(), &mut app).await;
        let path = dir.path().join(format!("{}.html", app["html_sha256"].as_str().unwrap()));
        let long_ago = SystemTime::now() - Duration::from_secs(3600);
        std::fs::File::options().write(true).open(&path).unwrap().set_modified(long_ago).unwrap();
        store_html_in(dir.path(), &mut json!({"html": "<p>x</p>"})).await;
        let age = std::fs::metadata(&path).unwrap().modified().unwrap().elapsed().unwrap();
        assert!(age < Duration::from_secs(60), "{age:?}");
    }
}
