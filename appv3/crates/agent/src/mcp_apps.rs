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
//! and is given to the model with the session's next user message. Reports
//! live in memory: a panel reports again when it is shown after a restart.

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

pub const HTML_KEY: &str = "html";
pub const HTML_SHA_KEY: &str = "html_sha256";

/// The longest report passed to the model; the rest is cut.
pub const MAX_CONTEXT_CHARS: usize = 24_000;
/// Panels of one session whose reports are kept; the oldest goes first.
const MAX_PANELS: usize = 16;

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

struct Report {
    tool_call_id: String,
    label: String,
    text: String,
    delivered: bool,
}

fn reports() -> &'static Mutex<HashMap<String, Vec<Report>>> {
    static R: OnceLock<Mutex<HashMap<String, Vec<Report>>>> = OnceLock::new();
    R.get_or_init(Default::default)
}

/// Session ids arrive with and without dashes.
fn session_key(session_id: &str) -> String {
    session_id.chars().filter(|c| *c != '-').flat_map(char::to_lowercase).collect()
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
    let mut text = text.trim().to_string();
    if text.chars().count() > MAX_CONTEXT_CHARS {
        text = text.chars().take(MAX_CONTEXT_CHARS).collect::<String>() + "\n[cut: the report was longer]";
    }
    let mut all = reports().lock().unwrap();
    let panels = all.entry(session_key(session_id)).or_default();
    let at = panels.iter().position(|r| r.tool_call_id == tool_call_id);
    if text.is_empty() {
        if let Some(i) = at {
            panels.remove(i);
        }
        return;
    }
    match at {
        Some(i) if panels[i].text == text => {}
        Some(i) => {
            panels[i].text = text;
            panels[i].delivered = false;
        }
        None => {
            if panels.len() >= MAX_PANELS {
                panels.remove(0);
            }
            panels.push(Report { tool_call_id: tool_call_id.into(), label: label.into(), text, delivered: false });
        }
    }
}

/// The reports the model has not seen yet, as one note; they then count as
/// seen. `None` when no panel reported anything new.
pub fn take_model_context(session_id: &str) -> Option<String> {
    let mut all = reports().lock().unwrap();
    let panels = all.get_mut(&session_key(session_id))?;
    let mut out: Vec<String> = vec![];
    for r in panels.iter_mut().filter(|r| !r.delivered) {
        r.delivered = true;
        out.push(format!("<mcp_app_context app={}>\n{}\n</mcp_app_context>", Value::String(r.label.clone()), r.text));
    }
    if out.is_empty() {
        return None;
    }
    Some(format!("Current state reported by the MCP app panel in this conversation. It replaces what the same panel reported before.\n\n{}", out.join("\n\n")))
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
}
