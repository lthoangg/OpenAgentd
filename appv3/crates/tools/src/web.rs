//! The `web_fetch` / `web_search` tools.
//!
//! HTML → Markdown follows v2's conversion: main-content extraction
//! (the `trafilatura` crate, a port of go-trafilatura, standing in for Python
//! trafilatura), with v2's fallback to `html2txt` (ported below) when the
//! extraction is empty or lost the page's code blocks. Binary documents
//! convert through `anydoc`, the crate v2's `firecrawl-anydoc` wraps.
//!
//! Difference (inherent): search scrapes DuckDuckGo's HTML endpoint instead of
//! the `ddgs` library, then falls back to Exa MCP exactly like v2.
//!
//! v3 addition: known anti-bot interstitials become a typed "browser
//! verification" error instead of junk content.

use crate::args::Args;
use crate::{Tool, ToolContext, ToolError, ToolOutput, ToolResult};
use async_trait::async_trait;
use htmd::element_handler::{HandlerResult, Handlers};
use htmd::Element;
use markup5ever_rcdom::{Node, NodeData};
use serde_json::{json, Value};
use std::borrow::Cow;
use std::net::IpAddr;
use std::sync::LazyLock;
use std::time::Duration;
use unicode_normalization::UnicodeNormalization;

const MAX_RESPONSE_MB: usize = 50;
const MAX_RESPONSE_BYTES: usize = MAX_RESPONSE_MB * 1024 * 1024;
const DEFAULT_TIMEOUT: f64 = 30.0;
const MAX_TIMEOUT: f64 = 120.0;
const MAX_REDIRECTS: usize = 10;
/// Error bodies are read only this far, to look for anti-bot markers.
const MAX_ERROR_BODY_BYTES: usize = 256 * 1024;
/// A 2xx body larger than this is a real page, never an interstitial; the
/// size bound keeps articles that merely mention a marker from tripping it.
const MAX_INTERSTITIAL_BYTES: usize = 100 * 1024;
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

fn accept(fmt: &str) -> &'static str {
    match fmt {
        "markdown" => "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1",
        "html" => "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, */*;q=0.1",
        _ => "text/plain;q=1.0, text/html;q=0.9, */*;q=0.1",
    }
}

#[derive(Debug)]
struct FetchError {
    message: String,
    hint: Option<String>,
}

fn fe(message: &str, hint: Option<String>) -> FetchError {
    FetchError { message: message.into(), hint }
}

fn render(e: FetchError) -> String {
    match e.hint {
        Some(h) => format!("Fetch failed: {}\n{h}", e.message),
        None => format!("Fetch failed: {}", e.message),
    }
}

fn blocked(vendor: &str) -> FetchError {
    fe("Browser verification required.", Some(format!("Direct HTTP fetching was blocked by {vendor} anti-bot protection. Try another source or use a browser-capable tool.")))
}

/// Which anti-bot product answered instead of the page, if any. Headers are
/// authoritative; body markers are ones only interstitials carry. Vendors
/// whose headers or scripts also appear on normal pages count only on errors.
fn bot_wall(status: u16, headers: &reqwest::header::HeaderMap, body: &[u8]) -> Option<&'static str> {
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).map(|v| v.trim().to_ascii_lowercase());
    if header("cf-mitigated").as_deref() == Some("challenge") {
        return Some("Cloudflare");
    }
    if header("x-vercel-mitigated").as_deref() == Some("challenge") {
        return Some("Vercel");
    }
    if matches!(header("x-amzn-waf-action").as_deref(), Some("challenge" | "captcha")) {
        return Some("AWS WAF");
    }
    let error = status >= 400;
    if !error && body.len() > MAX_INTERSTITIAL_BYTES {
        return None;
    }
    let has = |needle: &str| memchr::memmem::find(body, needle.as_bytes()).is_some();
    if has("window._cf_chl_opt") {
        return Some("Cloudflare");
    }
    if has("name=\"js_challenge\"") {
        return Some("Reddit");
    }
    if !error {
        return None;
    }
    if headers.contains_key("x-datadome") || has("captcha-delivery.com") {
        return Some("DataDome");
    }
    if has("px-captcha") || has("_pxAppId") {
        return Some("PerimeterX");
    }
    if has("blocked by network security") {
        return Some("Reddit");
    }
    None
}

fn is_global(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            !(v.is_private()
                || v.is_loopback()
                || v.is_link_local()
                || v.is_broadcast()
                || v.is_documentation()
                || v.is_unspecified()
                || o[0] == 0
                || (o[0] == 100 && (o[1] & 0xc0) == 64)
                || (o[0] == 192 && o[1] == 0 && o[2] == 0)
                || (o[0] == 198 && (o[1] & 0xfe) == 18)
                || o[0] >= 240)
        }
        IpAddr::V6(v) => {
            let s = v.segments();
            if let Some(m) = v.to_ipv4_mapped() {
                return is_global(IpAddr::V4(m));
            }
            !(v.is_loopback() || v.is_unspecified() || (s[0] & 0xfe00) == 0xfc00 || (s[0] & 0xffc0) == 0xfe80 || s[0] == 0x2001 && s[1] == 0xdb8 || s[0] == 0x100 && s[1] == 0)
        }
    }
}

async fn validate_destination(url: &reqwest::Url) -> Result<(), FetchError> {
    let scheme = url.scheme().to_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(fe("Unsafe URL.", Some("Only http:// and https:// URLs are supported.".into())));
    }
    let Some(host) = url.host_str() else {
        return Err(fe("Unsafe URL.", Some("The URL has no host.".into())));
    };
    if !url.username().is_empty() || url.password().is_some() {
        return Err(fe("Unsafe URL.", Some("URLs containing embedded credentials are not allowed.".into())));
    }
    if appv3_core::settings().web_fetch_allow_private_network {
        return Ok(());
    }
    let port = url.port_or_known_default().unwrap_or(443);
    let host = host.trim_start_matches('[').trim_end_matches(']').to_string();
    let addrs = tokio::net::lookup_host((host.as_str(), port)).await.map_err(|e| fe("Network error.", Some(format!("DNS resolution failed: {e}"))))?;
    for a in addrs {
        if !is_global(a.ip()) {
            return Err(fe("Unsafe URL.", Some(format!("The destination resolves to a non-public address ({}).", a.ip()))));
        }
    }
    Ok(())
}

fn http_error(status: u16) -> FetchError {
    let reason = reqwest::StatusCode::from_u16(status).ok().and_then(|s| s.canonical_reason()).unwrap_or("HTTP error");
    match status {
        404 | 410 => fe(&format!("{status} {reason}."), Some("The page may have moved or been removed. Use web_search to find the current URL.".into())),
        401 | 403 => fe(&format!("{status} {reason}."), Some("The server denied the request or requires authentication/browser access.".into())),
        429 => fe("429 Too Many Requests.", Some("The server is rate limiting requests. Retry later or use another source.".into())),
        _ => {
            let retry = matches!(status, 408 | 425) || status >= 500;
            fe(&format!("{status} {reason}."), Some(if retry { "Retrying may succeed." } else { "Check the URL and request parameters." }.into()))
        }
    }
}

fn client() -> reqwest::Client {
    static C: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    C.get_or_init(|| reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).pool_max_idle_per_host(10).build().unwrap()).clone()
}

struct Fetched {
    status: u16,
    content_type: Option<String>,
    content: Vec<u8>,
}

async fn fetch(url: reqwest::Url, fmt: &str, timeout: f64) -> Result<Fetched, FetchError> {
    let mut current = url;
    let mut redirects = 0;
    loop {
        validate_destination(&current).await?;
        let resp = client()
            .get(current.clone())
            .header("User-Agent", USER_AGENT)
            .header("Accept", accept(fmt))
            .header("Accept-Language", "en-US,en;q=0.9")
            .timeout(Duration::from_secs_f64(timeout))
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    fe("Request timed out.", Some("The request timed out. Retrying may succeed.".into()))
                } else {
                    fe("Network error.", Some("The request could not reach the server. Retrying may succeed.".into()))
                }
            })?;
        let status = resp.status().as_u16();
        if (300..400).contains(&status) {
            let Some(loc) = resp.headers().get("location").and_then(|v| v.to_str().ok()) else {
                return Err(http_error(status));
            };
            if redirects >= MAX_REDIRECTS {
                return Err(fe("Too many redirects.", Some("The URL redirected more than the allowed limit.".into())));
            }
            current = current.join(loc).map_err(|e| fe("Unsafe URL.", Some(e.to_string())))?;
            redirects += 1;
            continue;
        }
        if status >= 400 {
            let headers = resp.headers().clone();
            let body = read_body(resp, MAX_ERROR_BODY_BYTES, true).await.unwrap_or_default();
            return Err(match bot_wall(status, &headers, &body) {
                Some(vendor) => blocked(vendor),
                None => http_error(status),
            });
        }
        let content_type = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).map(String::from);
        if let Some(e) = reject_before_body(content_type.as_deref(), fmt) {
            return Err(e);
        }
        if let Some(len) = resp.content_length() {
            if len as usize > MAX_RESPONSE_BYTES {
                return Err(too_large(len as usize));
            }
        }
        let headers = resp.headers().clone();
        let content = read_body(resp, MAX_RESPONSE_BYTES, false).await?;
        let html = is_html(parse_ct(content_type.as_deref()).0.as_deref());
        if let Some(vendor) = bot_wall(status, &headers, &content).filter(|_| html) {
            return Err(blocked(vendor));
        }
        return Ok(Fetched { status, content_type, content });
    }
}

/// Streams the body up to `limit` bytes: past it, `truncate` keeps the head,
/// otherwise the response is rejected as too large.
async fn read_body(resp: reqwest::Response, limit: usize, truncate: bool) -> Result<Vec<u8>, FetchError> {
    use futures::StreamExt;
    let mut content = vec![];
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| fe("Network error.", Some("The request could not reach the server. Retrying may succeed.".into())))?;
        content.extend_from_slice(&chunk);
        if content.len() > limit {
            if truncate {
                content.truncate(limit);
                break;
            }
            return Err(too_large(content.len()));
        }
    }
    Ok(content)
}

fn too_large(size: usize) -> FetchError {
    fe("Response too large.", Some(format!("The response exceeded the {MAX_RESPONSE_MB} MB limit ({size} bytes received; limit {MAX_RESPONSE_BYTES} bytes).")))
}

fn parse_ct(ct: Option<&str>) -> (Option<String>, Option<String>) {
    let Some(ct) = ct else { return (None, None) };
    let mut parts = ct.split(';');
    let mime = parts.next().map(|m| m.trim().to_lowercase()).filter(|m| !m.is_empty());
    let charset = parts.filter_map(|p| p.trim().strip_prefix("charset=")).next().map(|c| c.trim_matches('"').to_lowercase());
    (mime, charset)
}

/// Content-based type for responses with a generic type.
fn sniff_mime(content: &[u8]) -> Option<String> {
    let sample = &content[..content.len().min(8192)];
    let stripped = &sample[sample.iter().position(|b| !b.is_ascii_whitespace() && *b != 0x0b).unwrap_or(sample.len())..];
    let lower = stripped.to_ascii_lowercase();
    if stripped.starts_with(b"%PDF-") {
        return Some("application/pdf".into());
    }
    let html_in_head = lower[..lower.len().min(1024)].windows(5).any(|w| w == b"<html");
    if lower.starts_with(b"<!doctype html") || lower.starts_with(b"<html") || html_in_head {
        return Some("text/html".into());
    }
    if lower.starts_with(b"<?xml") {
        return Some("application/xml".into());
    }
    // Looks like text: no NUL byte and the (possibly cut) sample decodes.
    if !sample.contains(&0) && std::str::from_utf8(sample).is_ok() {
        return Some("text/plain".into());
    }
    None
}

fn is_textual(m: Option<&str>) -> bool {
    matches!(m, Some(m) if m.starts_with("text/") || ["application/json", "application/xml", "application/xhtml+xml", "application/markdown", "application/javascript"].contains(&m))
}

fn is_html(m: Option<&str>) -> bool {
    matches!(m, Some("text/html" | "application/xhtml+xml"))
}

/// Types that say nothing about the body; the real type is sniffed from it.
fn is_generic_mime(m: Option<&str>) -> bool {
    matches!(m, None | Some("" | "application/octet-stream" | "binary/octet-stream"))
}

/// `raw` needs text and `html` needs HTML; other formats convert anything.
fn format_mismatch(mime: Option<&str>, fmt: &str) -> Option<FetchError> {
    match fmt {
        "raw" if !is_textual(mime) => {
            Some(fe("Cannot return raw binary content.", Some(format!("The response is {}. Use format=\"markdown\" or format=\"text\" instead.", mime.unwrap_or("binary data")))))
        }
        "html" if !is_html(mime) => Some(fe(
            "Cannot return HTML for this content type.",
            Some(format!("The response is {}. Use format=\"markdown\" or format=\"text\" instead.", mime.unwrap_or("unknown content"))),
        )),
        _ => None,
    }
}

/// Rejects a `raw`/`html` request from the declared type alone, so a large
/// binary body is never downloaded just to be refused.
fn reject_before_body(ct: Option<&str>, fmt: &str) -> Option<FetchError> {
    let (declared, _) = parse_ct(ct);
    if is_generic_mime(declared.as_deref()) {
        return None;
    }
    format_mismatch(declared.as_deref(), fmt)
}

/// HTML beyond this is converted from its head only: extraction costs about
/// 0.5 s of CPU per MB, and 5 MB already yields ~2.5 MB of text, far more
/// than a model reads. `format="html"` still returns the whole page.
const MAX_HTML_CONVERT_BYTES: usize = 5 * 1024 * 1024;

// ── HTML → Markdown / text ──────────────────────────────────────────────────

/// v2 wraps fragments so the parsers see a body.
fn wrap_body(html: &str) -> Cow<'_, str> {
    if html.to_lowercase().contains("<body") {
        Cow::Borrowed(html)
    } else {
        Cow::Owned(format!("<html><body>{html}</body></html>"))
    }
}

/// HTML → Markdown: `trafilatura.extract(html, output_format="markdown",
/// include_tables=True, include_links=True)`. Pages the extractor cannot read
/// as an article (landing pages, app shells) fall back to a structural
/// conversion of the whole body, so headings, lists and links survive; the
/// flat `html2txt` dump is the last resort.
pub fn html_to_markdown(html: &str) -> String {
    let html = wrap_body(html);
    let extracted = extract_markdown(&html);
    let dropped = match &extracted {
        None => true,
        Some(e) => e.trim().is_empty() || (html.to_lowercase().contains("<pre") && !e.contains("```")),
    };
    if dropped {
        let structured = structured_markdown(&html);
        if !structured.is_empty() {
            return structured;
        }
        let text = html2txt(&html);
        if !text.is_empty() {
            return text;
        }
    } else if let Some(e) = &extracted {
        // Article extraction keeps paragraphs and drops everything else on a
        // page that is not an article. If the page has headings the extraction
        // lost and the structural conversion holds much more, prefer it.
        if e.chars().count() >= MIN_EXTRACTED_SIZE && !has_heading(e) {
            let structured = structured_markdown(&html);
            if has_heading(&structured) && e.chars().count() * 10 < structured.chars().count() * 7 {
                return structured;
            }
        }
    }
    extracted.unwrap_or_default()
}

fn has_heading(md: &str) -> bool {
    md.lines().any(|l| l.starts_with("# ") || l.starts_with("## ") || l.starts_with("### "))
}

/// The whole body as Markdown, minus chrome (navigation, footers, asides,
/// consent banners) and non-content tags.
fn structured_markdown(html: &str) -> String {
    let doc = parse_html(html);
    let body_sel = scraper::Selector::parse("body").unwrap();
    let Some(body) = doc.select(&body_sel).next() else {
        return String::new();
    };
    let mut kept = String::new();
    clean_serialize(&body, &mut kept);
    let md = markdown_converter().convert(&kept).unwrap_or_default();
    // Empty links (icon-only anchors) and whitespace-only lines are noise.
    static EMPTY_LINK: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"\[\]\([^)]*\)").unwrap());
    static BLANKS: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"\n[ \t]*\n(?:[ \t]*\n)+").unwrap());
    let md = EMPTY_LINK.replace_all(&md, "");
    let md = BLANKS.replace_all(&md, "\n\n");
    md.trim().nfc().collect()
}

/// Serialises `node`'s children, dropping what `basic_clean_removes` and
/// interactive/navigation elements cover.
fn clean_serialize(node: &scraper::ElementRef<'_>, out: &mut String) {
    for child in node.children() {
        match child.value() {
            scraper::Node::Text(t) => out.push_str(&escape_text(t)),
            scraper::Node::Element(e) => {
                if basic_clean_removes(e) || matches!(e.name(), "nav" | "head" | "form" | "select" | "dialog" | "noscript" | "source" | "canvas" | "video" | "audio") {
                    continue;
                }
                // Images only help as captioned references; inline data: URIs
                // and tracking pixels would drown the page.
                if e.name() == "img" && (e.attr("alt").is_none_or(|a| a.trim().is_empty()) || e.attr("src").is_none_or(|s| s.is_empty() || s.starts_with("data:"))) {
                    continue;
                }
                let Some(el) = scraper::ElementRef::wrap(child) else { continue };
                out.push('<');
                out.push_str(e.name());
                for (k, v) in e.attrs() {
                    if matches!(k, "href" | "src" | "alt" | "title" | "colspan" | "rowspan" | "class") {
                        out.push_str(&format!(" {k}=\"{}\"", v.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;")));
                    }
                }
                out.push('>');
                if !matches!(e.name(), "br" | "hr" | "img" | "input" | "meta" | "link") {
                    clean_serialize(&el, out);
                    out.push_str(&format!("</{}>", e.name()));
                }
            }
            _ => {}
        }
    }
}

fn escape_text(t: &str) -> String {
    t.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// HTML → text: `trafilatura.html2txt` — the whole body as one line.
pub fn html_to_text(html: &str) -> String {
    html2txt(&wrap_body(html))
}

/// Main content (plus comments, which Python trafilatura includes by default)
/// as Markdown, NFC-normalised like trafilatura's output.
fn extract_markdown(html: &str) -> Option<String> {
    let opts = trafilatura::Options::default().with_links(true).with_fallback(true);
    let r = trafilatura::extract(html, &opts).ok()?;
    // Short pages end in the baseline extractor. There go-trafilatura's last
    // step appends the whole document's text, unseparated, to the paragraphs
    // it already found; Python's replaces everything with the cleaned body's
    // text runs, one per line. The crate only gets there when the body holds
    // at most ~100 characters, so reproduce Python's result for those pages.
    if r.content_text.chars().count() < MIN_EXTRACTED_SIZE {
        let dump = body_text_runs(html);
        if dump.chars().count() <= MIN_CONTENT_LENGTH {
            return Some(dump.nfc().collect());
        }
    }
    let conv = markdown_converter();
    let mut out = conv.convert(&r.content_html).unwrap_or_default().trim().to_string();
    if !r.comments_html.trim().is_empty() {
        out = format!("{out}\n{}", conv.convert(&r.comments_html).unwrap_or_default()).trim().to_string();
    }
    Some(out.nfc().collect())
}

/// trafilatura's `MIN_EXTRACTED_SIZE` (baseline rescue below this) and
/// `baseline._MIN_CONTENT_LENGTH`.
const MIN_EXTRACTED_SIZE: usize = 250;
const MIN_CONTENT_LENGTH: usize = 100;

/// The last step of Python trafilatura's `baseline()`: after basic cleaning,
/// `"\n".join(trim(t) for t in body.itertext() if trim(t))` without control
/// characters.
fn body_text_runs(html: &str) -> String {
    fn walk(node: &scraper::ElementRef<'_>, runs: &mut Vec<String>) {
        for child in node.children() {
            match child.value() {
                scraper::Node::Text(t) => {
                    let run = t.split(py_space).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ");
                    if !run.is_empty() {
                        runs.push(run);
                    }
                }
                scraper::Node::Element(e) if !basic_clean_removes(e) => {
                    if let Some(el) = scraper::ElementRef::wrap(child) {
                        walk(&el, runs);
                    }
                }
                _ => {}
            }
        }
    }
    let doc = parse_html(html);
    let body_sel = scraper::Selector::parse("body").unwrap();
    let Some(body) = doc.select(&body_sel).next() else {
        return String::new();
    };
    let mut runs = vec![];
    walk(&body, &mut runs);
    runs.join("\n").chars().filter(|c| printable_or_space(*c)).collect()
}

/// htmd with code blocks rendered like Python trafilatura: go-trafilatura
/// hands code over as `<pre>` or as a bare block-level `<code>`, and Python
/// fences any code that spans lines. htmd alone only fences `<pre><code>`.
fn markdown_converter() -> htmd::HtmlToMarkdown {
    htmd::HtmlToMarkdown::builder()
        .skip_tags(vec!["script", "style", "noscript", "svg", "iframe"])
        .add_handler(vec!["pre"], |_: &dyn Handlers, el: Element| Some(fenced(&node_text(el.node))))
        .add_handler(vec!["code"], |h: &dyn Handlers, el: Element| {
            let text = node_text(el.node);
            if text.contains('\n') {
                Some(fenced(&text))
            } else {
                h.fallback(el)
            }
        })
        .build()
}

fn node_text(node: &Node) -> String {
    fn walk(node: &Node, out: &mut String) {
        for c in node.children.borrow().iter() {
            match &c.data {
                NodeData::Text { contents } => out.push_str(&contents.borrow()),
                NodeData::Element { .. } => walk(c, out),
                _ => {}
            }
        }
    }
    let mut out = String::new();
    walk(node, &mut out);
    out
}

fn fenced(text: &str) -> HandlerResult {
    let body = text.trim_matches('\n');
    if body.trim().is_empty() {
        return "".into();
    }
    let fence = if body.contains("````") {
        "`````"
    } else if body.contains("```") {
        "````"
    } else {
        "```"
    };
    format!("\n\n{fence}\n{body}\n{fence}\n\n").into()
}

/// `trafilatura.baseline._BLOCK_ELEMS`.
const BLOCK_ELEMS: &[&str] = &[
    "address",
    "article",
    "aside",
    "blockquote",
    "br",
    "dd",
    "div",
    "dl",
    "dt",
    "figcaption",
    "figure",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hr",
    "li",
    "main",
    "nav",
    "ol",
    "p",
    "pre",
    "section",
    "summary",
    "table",
    "td",
    "th",
    "tr",
    "ul",
];

/// `trafilatura.settings._COOKIE_CONSENT_RE`.
static COOKIE_CONSENT: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r"(?i)cookie[-_]?(?:banner|bar|consent|law|notice|policy|description)|notice[-_]{0,2}cookie|consent[-_]?(?:banner|manager|sdk)|borlabs|cookiebot|cmplz|onetrust|moove[-_]?gdpr",
    )
    .unwrap()
});

/// `BASIC_CLEAN_XPATH`: aside, footer-ish divs, footer, script, style, svg,
/// template, fencedframe and cookie-consent containers.
fn basic_clean_removes(el: &scraper::node::Element) -> bool {
    let tag = el.name();
    if matches!(tag, "aside" | "fencedframe" | "footer" | "script" | "style" | "svg" | "template") {
        return true;
    }
    // `contains(@class|@id, 'footer')` tests the first of the two attributes.
    if tag == "div" && el.attr("class").or_else(|| el.attr("id")).is_some_and(|v| v.contains("footer")) {
        return true;
    }
    ["class", "id"].iter().any(|a| el.attr(a).is_some_and(|v| COOKIE_CONSENT.is_match(v)))
}

/// Python `str.isspace()`.
fn py_space(c: char) -> bool {
    c.is_whitespace() || ('\x1c'..='\x1f').contains(&c)
}

/// `return_printables_and_spaces`: Python `isprintable() or isspace()` — drops
/// control (Cc), format (Cf, e.g. U+200B) and private-use (Co) characters.
fn printable_or_space(c: char) -> bool {
    py_space(c)
        || !(c.is_control()
            || matches!(c as u32,
                0xAD | 0x600..=0x605 | 0x61C | 0x6DD | 0x70F | 0x890..=0x891 | 0x8E2 | 0x180E | 0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x2064
                | 0x2066..=0x206F | 0xFEFF | 0xFFF9..=0xFFFB | 0xE000..=0xF8FF | 0x110BD | 0x110CD | 0x13430..=0x1343F | 0x1BCA0..=0x1BCA3
                | 0x1D173..=0x1D17A | 0xE0001 | 0xE0020..=0xE007F | 0xF0000..))
}

/// Port of `trafilatura.baseline.html2txt(html, clean=True)`: drop the
/// basic-cleaning sections, space block boundaries (stripping control
/// characters from block elements' `text`/`tail` like lxml writes them), then
/// collapse all whitespace.
pub fn html2txt(html: &str) -> String {
    let doc = parse_html(html);
    let body_sel = scraper::Selector::parse("body").unwrap();
    let Some(body) = doc.select(&body_sel).next() else {
        return String::new();
    };
    let mut out = String::new();
    txt_walk(&body, &mut out);
    out.split(py_space).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ")
}

/// Parse like lxml does: with scripting disabled, so `<noscript>` content is
/// markup (html5ever's default treats it as raw text).
fn parse_html(html: &str) -> scraper::Html {
    use html5ever::tendril::TendrilSink;
    let opts = html5ever::ParseOpts { tree_builder: html5ever::tree_builder::TreeBuilderOpts { scripting_enabled: false, ..Default::default() }, ..Default::default() };
    html5ever::driver::parse_document(scraper::HtmlTreeSink::new(scraper::Html::new_document()), opts).one(html)
}

fn txt_walk(node: &scraper::ElementRef<'_>, out: &mut String) {
    // Which lxml slot the next text lands in: the parent's `.text` or the
    // previous kept sibling's `.tail`. Only block elements' slots are cleaned.
    let mut slot_is_block = BLOCK_ELEMS.contains(&node.value().name());
    for child in node.children() {
        match child.value() {
            scraper::Node::Text(t) => {
                if slot_is_block {
                    out.extend(t.chars().filter(|c| printable_or_space(*c)));
                } else {
                    out.push_str(t);
                }
            }
            scraper::Node::Element(e) => {
                if basic_clean_removes(e) {
                    // Deleted with its tail kept: the tail joins the current slot.
                    continue;
                }
                let block = BLOCK_ELEMS.contains(&e.name());
                if block {
                    out.push(' ');
                }
                if let Some(el) = scraper::ElementRef::wrap(child) {
                    txt_walk(&el, out);
                }
                if block {
                    out.push(' ');
                }
                slot_is_block = block;
            }
            // Comments/PIs contribute no text, but their tail is a new slot.
            _ => slot_is_block = false,
        }
    }
}

/// PDF/DOCX/office bytes → Markdown (`anydoc.to_markdown_bytes(...).strip()`).
pub fn convert_document(data: &[u8]) -> Result<String, anydoc::ConvertError> {
    anydoc::to_markdown_bytes(data, None).map(|s| s.trim().to_string())
}

fn process(content: &[u8], ct: Option<&str>, fmt: &str) -> Result<String, FetchError> {
    process_capped(content, ct, fmt, MAX_HTML_CONVERT_BYTES)
}

fn process_capped(content: &[u8], ct: Option<&str>, fmt: &str, html_cap: usize) -> Result<String, FetchError> {
    let (declared, charset) = parse_ct(ct);
    let mime = if is_generic_mime(declared.as_deref()) { sniff_mime(content) } else { declared.clone() };
    let textual = is_textual(mime.as_deref());
    let decoded = if textual {
        let enc = charset.as_deref().and_then(|c| encoding_rs::Encoding::for_label(c.as_bytes())).unwrap_or(encoding_rs::UTF_8);
        let (s, _, bad) = enc.decode(content);
        if bad && enc != encoding_rs::UTF_8 {
            Some(String::from_utf8_lossy(content).into_owned())
        } else {
            Some(s.into_owned())
        }
    } else {
        None
    };
    if let Some(e) = format_mismatch(mime.as_deref(), fmt) {
        return Err(e);
    }
    let html = is_html(mime.as_deref());
    match fmt {
        "raw" | "html" => Ok(decoded.unwrap_or_default()),
        _ => {
            if textual && html {
                let mut d = decoded.unwrap_or_default();
                let full_len = d.len();
                if full_len > html_cap {
                    let mut cut = html_cap;
                    while !d.is_char_boundary(cut) {
                        cut -= 1;
                    }
                    d.truncate(cut);
                }
                let mut out = if fmt == "markdown" { html_to_markdown(&d) } else { html_to_text(&d) };
                if full_len > html_cap && !out.trim().is_empty() {
                    out.push_str(&format!(
                        "\n\n[Truncated: the page has {full_len} bytes of HTML; only the first {html_cap} were converted. Use format=\"html\" for the full page.]"
                    ));
                }
                Ok(out)
            } else if textual {
                Ok(decoded.unwrap_or_default())
            } else {
                convert_document(content).map_err(|e| fe("Content conversion failed.", Some(e.to_string())))
            }
        }
    }
}

pub struct WebFetchTool;

#[async_trait]
impl Tool for WebFetchTool {
    fn name(&self) -> &str {
        "web_fetch"
    }
    async fn run(&self, _ctx: &ToolContext, args: Value) -> ToolResult {
        let mut a = Args::new("web_fetch", &args);
        let mut url = a.req_str(&["url", "uri", "link"]);
        let fmt = a.literal(&["format"], &["markdown", "html", "text", "raw"], "markdown");
        let timeout = a.opt_int(&["timeout"], Some(1), Some(120));
        if !url.is_empty() {
            if !url.contains("://") {
                url = format!("https://{url}");
            }
            match reqwest::Url::parse(&url) {
                Ok(u) if (u.scheme() == "http" || u.scheme() == "https") && u.host_str().is_some() => {}
                _ => a.err("url", "Value error, url must be an http(s) URL with a host"),
            }
        }
        a.finish()?;
        let timeout_s = timeout.map(|t| t as f64).unwrap_or(DEFAULT_TIMEOUT).min(MAX_TIMEOUT);
        let parsed = reqwest::Url::parse(&url).map_err(ToolError::exec)?;
        let res = match fetch(parsed, &fmt, timeout_s).await {
            Err(e) => render(e),
            Ok(f) if f.status == 204 => "Fetch succeeded but the server returned no content.".into(),
            Ok(f) if f.content.is_empty() => "Fetch succeeded but the response body was empty.".into(),
            // Extraction is CPU-bound (tens of ms on large pages); v2 runs it
            // under `to_thread` too.
            Ok(f) => match tokio::task::spawn_blocking(move || process(&f.content, f.content_type.as_deref(), &fmt)).await.map_err(ToolError::exec)? {
                Err(e) => render(e),
                Ok(c) if c.trim().is_empty() => "Fetch succeeded, but no readable page content could be extracted. The page may require JavaScript rendering.".into(),
                Ok(c) => c,
            },
        };
        Ok(ToolOutput::Text(res))
    }
}

async fn ddg_search(query: &str, max: usize, page: i64, safesearch: &str) -> Vec<Value> {
    let kp = match safesearch {
        "on" => "1",
        "off" => "-2",
        _ => "-1",
    };
    let s = ((page.max(1) - 1) * 10).to_string();
    let resp = client()
        .post("https://html.duckduckgo.com/html/")
        .header("User-Agent", USER_AGENT)
        .form(&[("q", query), ("kp", kp), ("s", &s), ("b", "")])
        .timeout(Duration::from_secs(15))
        .send()
        .await;
    let Ok(resp) = resp else { return vec![] };
    let Ok(html) = resp.text().await else {
        return vec![];
    };
    let doc = scraper::Html::parse_document(&html);
    let result_sel = scraper::Selector::parse("div.result").unwrap();
    let a_sel = scraper::Selector::parse("a.result__a").unwrap();
    let snip_sel = scraper::Selector::parse(".result__snippet").unwrap();
    let mut out = vec![];
    for r in doc.select(&result_sel) {
        let Some(a) = r.select(&a_sel).next() else {
            continue;
        };
        let mut href = a.value().attr("href").unwrap_or("").to_string();
        if let Some(i) = href.find("uddg=") {
            let enc = href[i + 5..].split('&').next().unwrap_or("");
            href = urlencoding::decode(enc).map(|c| c.into_owned()).unwrap_or(href);
        }
        if href.contains("duckduckgo.com/y.js") {
            continue;
        }
        let title: String = a.text().collect::<String>().trim().to_string();
        let body: String = r.select(&snip_sel).next().map(|s| s.text().collect::<String>().trim().to_string()).unwrap_or_default();
        out.push(json!({"title": title, "href": href, "body": body}));
        if out.len() >= max {
            break;
        }
    }
    out
}

fn parse_exa_text(text: &str) -> Vec<Value> {
    let mut blocks: Vec<String> = vec![];
    let mut cur = String::new();
    for line in text.trim().split('\n') {
        if line.starts_with("Title:") && !cur.trim().is_empty() {
            blocks.push(std::mem::take(&mut cur));
        }
        cur.push_str(line);
        cur.push('\n');
    }
    if !cur.trim().is_empty() {
        blocks.push(cur);
    }
    let mut out = vec![];
    for b in blocks {
        let (mut title, mut url, mut body, mut hl) = (String::new(), String::new(), vec![], false);
        for line in b.trim().lines() {
            if let Some(t) = line.strip_prefix("Title:") {
                title = t.trim().into();
            } else if let Some(u) = line.strip_prefix("URL:") {
                url = u.trim().into();
            } else if line.starts_with("Published:") || line.starts_with("Author:") {
                continue;
            } else if line.starts_with("Highlights:") {
                hl = true;
            } else {
                let _ = hl;
                body.push(line.to_string());
            }
        }
        if !title.is_empty() || !url.is_empty() {
            out.push(json!({"title": title, "href": url, "body": body.join("\n").trim()}));
        }
    }
    out
}

async fn exa_search(query: &str, max: usize) -> Result<Value, String> {
    let data = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "web_search_exa", "arguments": {"query": query, "numResults": max}}});
    // Reused like `client()`, but with reqwest's default redirect policy: a
    // fresh client per search rebuilt the native root store and lost pooling.
    static EXA: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    let resp = EXA
        .get_or_init(reqwest::Client::new)
        .post("https://mcp.exa.ai/mcp")
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .timeout(Duration::from_secs(30))
        .json(&data)
        .send()
        .await
        .map_err(|_| "No result found".to_string())?;
    if !resp.status().is_success() {
        return Err("No result found".into());
    }
    let ct = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let text = resp.text().await.map_err(|_| "No result found".to_string())?;
    let payload: Value = if ct.contains("text/event-stream") || text.starts_with("event:") {
        text.lines().filter_map(|l| l.strip_prefix("data:")).filter_map(|d| serde_json::from_str::<Value>(d.trim()).ok()).find(|v| v.is_object()).unwrap_or(json!({}))
    } else {
        serde_json::from_str(&text).unwrap_or(json!({}))
    };
    if let Some(e) = payload.get("error") {
        return Err(format!("Error: {}", model_json(e)));
    }
    match payload.get("result") {
        Some(Value::Object(r)) => {
            let content = r.get("content").and_then(|c| c.as_array()).cloned().unwrap_or_default();
            if r.get("isError").and_then(|v| v.as_bool()).unwrap_or(false) {
                let msg = content.first().and_then(|c| c.get("text")).and_then(|t| t.as_str()).unwrap_or("Unknown error");
                return Err(format!("Error: {msg}"));
            }
            if let Some(t) = content.first().and_then(|c| c.get("text")).and_then(|t| t.as_str()) {
                let e = parse_exa_text(t);
                if !e.is_empty() {
                    return Ok(Value::Array(e));
                }
            }
            Err("No result found".into())
        }
        Some(Value::Array(a)) => Ok(Value::Array(a.clone())),
        _ => Err("No result found".into()),
    }
}

/// JSON text handed to the model: compact with non-ASCII verbatim, since
/// `\uXXXX` escapes cost several tokens per character.
fn model_json(v: &Value) -> String {
    v.to_string()
}

pub struct WebSearchTool;

#[async_trait]
impl Tool for WebSearchTool {
    fn name(&self) -> &str {
        "web_search"
    }
    async fn run(&self, _ctx: &ToolContext, args: Value) -> ToolResult {
        let mut a = Args::new("web_search", &args);
        let query = a.req_str(&["query", "q", "search_query"]);
        let max = a.opt_int(&["max_results"], Some(1), Some(20)).unwrap_or(5) as usize;
        let page = a.opt_int(&["page"], Some(1), None).unwrap_or(1);
        let safesearch = a.literal(&["safesearch"], &["on", "moderate", "off"], "moderate");
        a.finish()?;
        let results = ddg_search(&query, max, page, &safesearch).await;
        if !results.is_empty() {
            return Ok(ToolOutput::Text(model_json(&Value::Array(results))));
        }
        Ok(ToolOutput::Text(match exa_search(&query, max).await {
            Ok(v) => model_json(&v),
            Err(s) => s,
        }))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn search_results_reach_the_model_as_compact_utf8() {
        let results = json!([{"title": "Hướng dẫn cài đặt", "href": "https://example.vn/a", "body": "日本語のテキスト"}]);
        assert_eq!(model_json(&results), r#"[{"title":"Hướng dẫn cài đặt","href":"https://example.vn/a","body":"日本語のテキスト"}]"#);
    }

    /// A valid single-page PDF with a text layer (exact xref offsets), as in
    /// v2's `test_document_conversion._minimal_pdf`. `encrypt` adds a
    /// standard-security-handler `/Encrypt` dictionary to the trailer.
    pub(crate) fn minimal_pdf(text: &str, encrypt: bool) -> Vec<u8> {
        let stream = format!("BT /F1 24 Tf 72 700 Td ({text}) Tj ET");
        let mut objs = vec![
            "<</Type/Catalog/Pages 2 0 R>>".to_string(),
            "<</Type/Pages/Kids[3 0 R]/Count 1>>".into(),
            "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>".into(),
            format!("<</Length {}>>stream\n{stream}\nendstream", stream.len()),
            "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>".into(),
        ];
        if encrypt {
            objs.push("<</Filter/Standard/V 1/R 2/O(0123456789abcdef0123456789abcdef)/U(0123456789abcdef0123456789abcdef)/P -4>>".into());
        }
        let mut out = b"%PDF-1.4\n".to_vec();
        let mut offsets = vec![];
        for (i, body) in objs.iter().enumerate() {
            offsets.push(out.len());
            out.extend(format!("{} 0 obj\n{body}\nendobj\n", i + 1).bytes());
        }
        let xref_at = out.len();
        let size = objs.len() + 1;
        out.extend(format!("xref\n0 {size}\n0000000000 65535 f \n").bytes());
        for o in offsets {
            out.extend(format!("{o:010} 00000 n \n").bytes());
        }
        let enc = if encrypt { format!("/Encrypt {} 0 R/ID[<00112233445566778899aabbccddeeff><00112233445566778899aabbccddeeff>]", objs.len()) } else { String::new() };
        out.extend(format!("trailer<</Size {size}/Root 1 0 R{enc}>>\nstartxref\n{xref_at}\n%%EOF\n").bytes());
        out
    }

    /// A minimal DOCX package (v2's `_minimal_docx`).
    pub(crate) fn minimal_docx(text: &str) -> Vec<u8> {
        use std::io::Write;
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            let opts = zip::write::SimpleFileOptions::default();
            let parts = [
                ("[Content_Types].xml", "<?xml version='1.0'?><Types xmlns='http://schemas.openxmlformats.org/package/2006/content-types'><Default Extension='xml' ContentType='application/xml'/><Override PartName='/word/document.xml' ContentType='application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'/></Types>".to_string()),
                ("_rels/.rels", "<?xml version='1.0'?><Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'><Relationship Id='rId1' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument' Target='word/document.xml'/></Relationships>".into()),
                ("word/document.xml", format!("<?xml version='1.0'?><w:document xmlns:w='http://schemas.openxmlformats.org/wordprocessingml/2006/main'><w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>")),
            ];
            for (name, body) in parts {
                z.start_file(name, opts).unwrap();
                z.write_all(body.as_bytes()).unwrap();
            }
            z.finish().unwrap();
        }
        buf.into_inner()
    }

    const PAGE: &str = r#"<!doctype html>
<html><head><title>T</title>
<style>.nav{margin:0;padding:2px;--tw-ring:0}</style>
<script>!function(){window.__x=1;var a=2}()</script>
</head><body>
<nav><ul><li><a href="/a">Nav A</a></li><li><a href="/b">Nav B</a></li></ul></nav>
<article>
<h1>Installing the thing</h1>
<p>This guide explains how to install the thing on your machine in a few steps,
covering prerequisites, the install command itself, and how to verify it.</p>
<pre><code>pip install thing
thing --version</code></pre>
<p>After running the command above the binary is on your PATH and you can
verify the installation by printing its version number as shown.</p>
</article>
<footer>Copyright 2026</footer>
</body></html>"#;

    #[test]
    fn html_is_extracted_without_boilerplate_or_scripts() {
        let md = process(PAGE.as_bytes(), Some("text/html; charset=utf-8"), "markdown").unwrap();
        assert!(md.contains("Installing the thing"), "{md}");
        assert!(md.contains("```\npip install thing\nthing --version\n```"), "{md}");
        assert!(!md.contains("window.__x") && !md.contains("--tw-ring"), "{md}");
        assert!(!md.contains("Nav A"), "{md}");
    }

    #[test]
    fn html_falls_back_when_extraction_drops_code_blocks() {
        let tabbed = "<html><body><article><h1>Install</h1><p>Pick your package manager below to install the tool locally.</p><starlight-tabs><div class=\"tablist-wrapper\"><ul role=\"tablist\"><li role=\"presentation\"><a role=\"tab\">npm</a></li></ul><section><pre><code>npm install demo-pkg</code></pre></section></div></starlight-tabs></article></body></html>";
        assert!(process(tabbed.as_bytes(), Some("text/html"), "markdown").unwrap().contains("npm install demo-pkg"));
    }

    #[test]
    fn code_blocks_are_fenced_like_python_trafilatura() {
        let conv = markdown_converter();
        // go-trafilatura's bare block <code> and a plain <pre> both fence; one-line code stays inline.
        let md = conv.convert("<p>Run <code>ls</code> now.</p><code>a = 1\nb = 2</code><pre>x ``` y\nz</pre>").unwrap();
        assert!(md.contains("Run `ls` now."), "{md}");
        assert!(md.contains("```\na = 1\nb = 2\n```"), "{md}");
        assert!(md.contains("````\nx ``` y\nz\n````"), "{md}");
    }

    #[test]
    fn json_is_returned_verbatim() {
        let body = r#"{"status":"ok","items":[1,2,3]}"#;
        assert_eq!(process(body.as_bytes(), Some("application/json"), "markdown").unwrap(), body);
    }

    #[test]
    fn pdf_and_docx_responses_are_converted() {
        assert!(process(&minimal_pdf("Hello Anydoc World", false), Some("application/pdf"), "markdown").unwrap().contains("Hello Anydoc World"));
        // Generic content type: sniffed as PDF from the bytes.
        assert!(process(&minimal_pdf("Sniffed PDF", false), Some("application/octet-stream"), "text").unwrap().contains("Sniffed PDF"));
        assert!(process(&minimal_docx("Hello from DOCX"), Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "markdown")
            .unwrap()
            .contains("Hello from DOCX"));
        let err = process(b"\x89PNG\r\n\x1a\n\x00\x00", Some("image/png"), "markdown").unwrap_err();
        assert_eq!(err.message, "Content conversion failed.");
    }

    #[test]
    fn oversized_html_is_converted_from_a_capped_prefix_with_a_note() {
        let page = format!("<html><body><p>{}</p><p>LATE_MARKER</p></body></html>", "word ".repeat(400));
        let out = process_capped(page.as_bytes(), Some("text/html"), "text", 1000).unwrap();
        assert!(out.starts_with("word word"), "{out}");
        assert!(!out.contains("LATE_MARKER"), "{out}");
        assert!(
            out.ends_with(&format!("[Truncated: the page has {} bytes of HTML; only the first 1000 were converted. Use format=\"html\" for the full page.]", page.len())),
            "{out}"
        );
        let whole = process_capped(page.as_bytes(), Some("text/html"), "text", page.len()).unwrap();
        assert!(whole.contains("LATE_MARKER") && !whole.contains("[Truncated:"), "{whole}");
    }

    #[test]
    fn raw_and_html_mismatches_are_rejected_before_the_body() {
        assert_eq!(reject_before_body(Some("image/png"), "raw").unwrap().message, "Cannot return raw binary content.");
        assert_eq!(reject_before_body(Some("application/json; charset=utf-8"), "html").unwrap().message, "Cannot return HTML for this content type.");
        // Generic or missing types are sniffed from the body, so they must be read.
        assert!(reject_before_body(Some("application/octet-stream"), "raw").is_none());
        assert!(reject_before_body(None, "html").is_none());
        assert!(reject_before_body(Some("text/html"), "html").is_none());
        assert!(reject_before_body(Some("text/plain"), "raw").is_none());
        // Binary documents are converted for markdown/text.
        assert!(reject_before_body(Some("application/pdf"), "markdown").is_none());
    }

    #[test]
    fn html2txt_matches_trafilatura_baseline() {
        let html = "<html><body><div>One<p>Two\u{200b}</p>tail\u{200b}</div><span>in\u{200b}line</span><aside>side</aside><footer>foot</footer><div class=\"page-footer\">pf</div><div id=\"cookie-banner\">ck</div><script>s()</script><ul><li>a</li><li>b</li></ul>\u{a0}end</body></html>";
        // Block text/tail lose control characters; inline text keeps them.
        assert_eq!(html2txt(html), "One Two tail in\u{200b}line a b end");
        assert_eq!(html_to_text("<p>frag <b>ment</b></p>"), "frag ment");
    }

    #[test]
    fn sniff_matches_v2() {
        assert_eq!(sniff_mime(b"  %PDF-1.7").as_deref(), Some("application/pdf"));
        assert_eq!(sniff_mime(b"<!-- x --><meta><html>").as_deref(), Some("text/html"));
        assert_eq!(sniff_mime(b"<?xml version='1.0'?><a/>").as_deref(), Some("application/xml"));
        assert_eq!(sniff_mime(b"plain").as_deref(), Some("text/plain"));
        assert_eq!(sniff_mime(b"a\x00b"), None);
    }

    #[test]
    fn private_addresses_blocked() {
        assert!(!is_global("127.0.0.1".parse().unwrap()));
        assert!(!is_global("10.1.2.3".parse().unwrap()));
        assert!(!is_global("169.254.1.1".parse().unwrap()));
        assert!(!is_global("::1".parse().unwrap()));
        assert!(is_global("8.8.8.8".parse().unwrap()));
    }

    fn headers(pairs: &[(&'static str, &'static str)]) -> reqwest::header::HeaderMap {
        pairs.iter().map(|(k, v)| (reqwest::header::HeaderName::from_static(k), reqwest::header::HeaderValue::from_static(v))).collect()
    }

    #[test]
    fn anti_bot_interstitials_are_recognised() {
        let none = headers(&[]);
        assert_eq!(bot_wall(403, &headers(&[("cf-mitigated", "Challenge")]), b""), Some("Cloudflare"));
        assert_eq!(bot_wall(429, &headers(&[("x-vercel-mitigated", "challenge")]), b""), Some("Vercel"));
        assert_eq!(bot_wall(202, &headers(&[("x-amzn-waf-action", "challenge")]), b""), Some("AWS WAF"));
        assert_eq!(bot_wall(200, &none, b"<script>window._cf_chl_opt={}</script>"), Some("Cloudflare"));
        assert_eq!(bot_wall(200, &none, br#"<input type="hidden" name="js_challenge" value="1"/>"#), Some("Reddit"));
        assert_eq!(bot_wall(403, &none, b"You've been blocked by network security."), Some("Reddit"));
        assert_eq!(bot_wall(403, &none, b"<script src='https://ct.captcha-delivery.com/c.js'>"), Some("DataDome"));
        assert_eq!(bot_wall(403, &none, b"<div id='px-captcha'></div>"), Some("PerimeterX"));
        // DataDome tags normal pages too; only an error is a block.
        assert_eq!(bot_wall(200, &headers(&[("x-datadome", "protected")]), b"<p>shop</p>"), None);
        assert_eq!(bot_wall(403, &headers(&[("x-datadome", "protected")]), b""), Some("DataDome"));
        // A full page that merely mentions a marker is content, not a wall.
        let article = format!("<p>{}</p><code>window._cf_chl_opt</code>", "x".repeat(MAX_INTERSTITIAL_BYTES));
        assert_eq!(bot_wall(200, &none, article.as_bytes()), None);
        assert_eq!(bot_wall(404, &none, b"<h1>Not found</h1>"), None);
    }

    #[test]
    fn process_html_markdown() {
        let md = process(b"<html><body><h1>Hi</h1><p>there <a href='/x'>link</a></p><script>x()</script></body></html>", Some("text/html; charset=utf-8"), "markdown").unwrap();
        // A page this short ends in trafilatura's baseline: v2 returns the body's text runs.
        assert_eq!(md, "Hi\nthere\nlink");
        assert!(process(b"\x89PNG\x00\x00", Some("image/png"), "raw").is_err());
    }

    /// A landing page: the article extractor keeps only the paragraphs, so the
    /// structural conversion must supply the headings and links.
    fn landing_page() -> String {
        let section = |n: usize| {
            format!(
                "<section><h2>Feature {n} heading</h2><p>Feature {n} explains in a full sentence what the product does for you and why that matters to a team.</p><a href=\"/f{n}\">Learn more {n}</a></section>"
            )
        };
        let sections: String = (1..=5).map(section).collect();
        format!(
            "<html><head><title>T</title></head><body><nav><a href=\"/nav-only\">NavOnlyLink</a></nav><div><h1>The Product Headline</h1>{sections}</div><footer>FooterOnlyText</footer><script>track()</script></body></html>"
        )
    }

    #[test]
    fn landing_pages_keep_headings_and_links() {
        let md = html_to_markdown(&landing_page());
        assert!(md.contains("# The Product Headline"), "{md}");
        assert!(md.contains("## Feature 3 heading"), "{md}");
        assert!(md.contains("[Learn more 2](/f2)"), "{md}");
        assert!(!md.contains("NavOnlyLink") && !md.contains("FooterOnlyText") && !md.contains("track()"), "{md}");
    }

    #[test]
    fn structural_fallback_drops_data_uri_images_and_empty_links() {
        let html = "<html><body><a href=\"/\"><img src=\"data:image/svg+xml,%3csvg%3e\" alt=\"Logo\"></a><img src=\"/pixel.gif\"><h1>Only a heading</h1></body></html>";
        let md = structured_markdown(html);
        assert_eq!(md, "# Only a heading");
    }
}
