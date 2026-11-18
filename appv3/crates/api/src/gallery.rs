//! The connector gallery: ready-made connectors a user turns on in one click.
//!
//! The list lives on openagentd.dev, so a new connector reaches every install
//! without an update. It is signed (Ed25519, detached `<url>.sig`, base64)
//! with the project's key; a list without a valid signature is ignored.
//! The server keeps the last good list in its cache and falls back to the
//! copy this build ships. Entries are data only: an `https` address and how
//! it signs in, never a program to run.
//!
//! Settings (environment, or the config dir's `.env`):
//! `OPENAGENTD_GALLERY=off` uses only the shipped copy and never calls out;
//! `OPENAGENTD_GALLERY_URL` and `OPENAGENTD_GALLERY_KEY` (base64 Ed25519
//! public key) point at an organization's own signed list.

use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

pub const DEFAULT_URL: &str = "https://account.openagentd.dev/connectors/v1.json";
/// The project's gallery signing key (public half).
pub const DEFAULT_PUBLIC_KEY: &str = "Wo7CH+2AvMHnlZpwCeCfzvokD8Aspnt3qq8NKLF+hAE=";
/// The copy this build ships: the first-run and offline list.
pub const BUNDLED: &str = include_str!("../data/gallery.json");
/// How long a fetched list is used before the next open fetches again.
const FRESH_FOR: Duration = Duration::from_secs(15 * 60);
const FETCH_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_BYTES: usize = 512 * 1024;
/// The longest logo path the gallery accepts.
const MAX_ICON_PATH: usize = 4096;

#[derive(Clone, Debug, PartialEq)]
pub enum Auth {
    /// Works without an account.
    None,
    /// Signs in at the service (MCP authorization).
    OAuth,
    /// The user pastes a key; it goes in `header` as `template` with `{key}` replaced.
    Key { header: String, template: String, key_url: Option<String>, key_label: Option<String> },
}

/// A connector's logo: one SVG path the app draws in the text colour.
#[derive(Clone, Debug, PartialEq)]
pub struct Icon {
    pub path: String,
    pub view_box: String,
}

impl Icon {
    pub fn to_json(&self) -> Value {
        json!({"path": self.path, "view_box": self.view_box})
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub url: String,
    pub auth: Auth,
    /// Addresses this connector had before: a server still on one is offered the update.
    pub previous_urls: Vec<String>,
    pub icon: Option<Icon>,
}

impl Entry {
    pub fn to_json(&self) -> Value {
        let auth = match &self.auth {
            Auth::None => json!("none"),
            Auth::OAuth => json!("oauth"),
            Auth::Key { header, template, key_url, key_label } => json!({"header": header, "template": template, "key_url": key_url, "key_label": key_label}),
        };
        json!({"type": "connector", "id": self.id, "name": self.name, "description": self.description, "category": self.category, "url": self.url, "auth": auth, "icon": self.icon.as_ref().map(Icon::to_json)})
    }
}

#[derive(Clone, Debug)]
pub struct Gallery {
    pub entries: Vec<Entry>,
    /// `cloud` (fetched now), `cache` (an earlier fetch) or `bundled`.
    pub source: &'static str,
}

// ── parsing ─────────────────────────────────────────────────────────────────

fn version_tuple(v: &str) -> Option<(u64, u64, u64)> {
    let mut it = v.trim().trim_start_matches('v').split(['.', '-', '+']).map(|p| p.parse::<u64>().ok());
    Some((it.next()??, it.next().flatten().unwrap_or(0), it.next().flatten().unwrap_or(0)))
}

/// Whether this build is at least `min`.
fn app_at_least(min: &str, app: &str) -> bool {
    match (version_tuple(min), version_tuple(app)) {
        (Some(m), Some(a)) => a >= m,
        _ => false,
    }
}

fn https_url(v: Option<&Value>) -> Option<String> {
    let s = v?.as_str()?;
    let u = reqwest::Url::parse(s).ok()?;
    // Debug builds also take a plain-HTTP address on this machine, for a local test list.
    let local_test = cfg!(debug_assertions) && u.scheme() == "http" && matches!(u.host_str(), Some("127.0.0.1" | "localhost"));
    ((u.scheme() == "https" || local_test) && u.host_str().is_some() && u.username().is_empty() && u.password().is_none()).then(|| s.to_string())
}

fn short_str(v: Option<&Value>, max: usize) -> Option<String> {
    let s = v?.as_str()?.trim();
    (!s.is_empty() && s.chars().count() <= max).then(|| s.to_string())
}

fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty() && b.len() <= 40 && b[0].is_ascii_lowercase() && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// A logo the app can draw safely: path commands and numbers only (never
/// markup), within a size cap, on a four-number view box. Anything else is
/// dropped and the entry keeps its monogram.
fn parse_icon(v: Option<&Value>) -> Option<Icon> {
    let o = v?.as_object()?;
    let path = o.get("path")?.as_str()?;
    let path_ok = !path.is_empty() && path.len() <= MAX_ICON_PATH && path.bytes().all(|c| b"MmLlHhVvCcSsQqTtAaZz0123456789 .,eE+-".contains(&c));
    let view_box = o.get("view_box")?.as_str()?;
    let nums: Vec<&str> = view_box.split(' ').collect();
    let box_ok = nums.len() == 4 && nums.iter().all(|n| n.parse::<f64>().is_ok_and(f64::is_finite));
    (path_ok && box_ok).then(|| Icon { path: path.to_string(), view_box: view_box.to_string() })
}

/// One connector entry, or `None` when this build should not show it:
/// another type (a plugin), an auth kind it does not know, a newer
/// `min_app`, or anything malformed.
fn parse_entry(v: &Value, app: &str) -> Option<Entry> {
    if v.get("type").and_then(Value::as_str) != Some("connector") {
        return None;
    }
    if let Some(min) = v.get("min_app") {
        if !app_at_least(min.as_str()?, app) {
            return None;
        }
    }
    let id = v.get("id")?.as_str()?.to_string();
    if !valid_id(&id) {
        return None;
    }
    let auth = match v.get("auth")? {
        Value::String(s) if s == "none" => Auth::None,
        Value::String(s) if s == "oauth" => Auth::OAuth,
        Value::Object(o) => {
            let header = short_str(o.get("header"), 64).filter(|h| h.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'))?;
            let template = short_str(o.get("template"), 200).filter(|t| t.contains("{key}"))?;
            Auth::Key { header, template, key_url: https_url(o.get("key_url")), key_label: short_str(o.get("key_label"), 60) }
        }
        _ => return None,
    };
    let previous_urls = v.get("previous_urls").and_then(Value::as_array).map(|a| a.iter().filter_map(|u| https_url(Some(u))).collect()).unwrap_or_default();
    Some(Entry {
        id,
        name: short_str(v.get("name"), 60)?,
        description: short_str(v.get("description"), 300)?,
        category: short_str(v.get("category"), 30).unwrap_or_else(|| "other".into()),
        url: https_url(v.get("url"))?,
        auth,
        previous_urls,
        icon: parse_icon(v.get("icon")),
    })
}

/// The entries of a gallery document this build can show.
pub fn parse(text: &str, app: &str) -> Result<Vec<Entry>, String> {
    let doc: Value = serde_json::from_str(text).map_err(|e| format!("not JSON: {e}"))?;
    if doc.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("unknown gallery version".into());
    }
    let entries = doc.get("entries").and_then(Value::as_array).ok_or("no entries")?;
    let mut out: Vec<Entry> = vec![];
    for e in entries.iter().filter_map(|v| parse_entry(v, app)) {
        if !out.iter().any(|o| o.id == e.id) {
            out.push(e);
        }
    }
    Ok(out)
}

// ── signature ───────────────────────────────────────────────────────────────

fn decode_key(b64: &str) -> Option<VerifyingKey> {
    let raw = base64::engine::general_purpose::STANDARD.decode(b64.trim()).ok()?;
    VerifyingKey::from_bytes(&raw.try_into().ok()?).ok()
}

fn verifying_key() -> Option<VerifyingKey> {
    let custom = std::env::var("OPENAGENTD_GALLERY_KEY").ok().filter(|v| !v.trim().is_empty());
    decode_key(custom.as_deref().unwrap_or(DEFAULT_PUBLIC_KEY))
}

/// Whether `sig_b64` is `key`'s signature over exactly `body`.
pub fn verify(body: &[u8], sig_b64: &str, key: &VerifyingKey) -> bool {
    let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(sig_b64.trim()) else { return false };
    let Ok(sig) = Signature::from_slice(&raw) else { return false };
    key.verify(body, &sig).is_ok()
}

// ── fetch + cache ───────────────────────────────────────────────────────────

/// Where the list comes from, or `None` when the cloud list is off.
fn source_url() -> Option<String> {
    if std::env::var("OPENAGENTD_GALLERY").is_ok_and(|v| v.trim().eq_ignore_ascii_case("off")) {
        return None;
    }
    Some(std::env::var("OPENAGENTD_GALLERY_URL").ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| DEFAULT_URL.to_string()))
}

fn cache_dir() -> PathBuf {
    appv3_core::settings().cache_dir.join("gallery")
}

struct Cached {
    body: String,
    sig: String,
    url: String,
    fetched: SystemTime,
}

fn read_cache() -> Option<Cached> {
    let d = cache_dir();
    let meta: Value = serde_json::from_str(&std::fs::read_to_string(d.join("meta.json")).ok()?).ok()?;
    let fetched = SystemTime::UNIX_EPOCH + Duration::from_secs(meta.get("fetched_at")?.as_u64()?);
    Some(Cached {
        body: std::fs::read_to_string(d.join("v1.json")).ok()?,
        sig: std::fs::read_to_string(d.join("v1.json.sig")).ok()?,
        url: meta.get("url")?.as_str()?.to_string(),
        fetched,
    })
}

fn write_cache(c: &Cached) -> std::io::Result<()> {
    let d = cache_dir();
    std::fs::create_dir_all(&d)?;
    std::fs::write(d.join("v1.json"), &c.body)?;
    std::fs::write(d.join("v1.json.sig"), &c.sig)?;
    let secs = c.fetched.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    std::fs::write(d.join("meta.json"), json!({"url": c.url, "fetched_at": secs}).to_string())
}

async fn get_text(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let r = client.get(url).timeout(FETCH_TIMEOUT).send().await.map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(format!("HTTP {}", r.status().as_u16()));
    }
    let bytes = r.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err("too large".into());
    }
    String::from_utf8(bytes.to_vec()).map_err(|_| "not UTF-8".into())
}

/// A cached or fetched list's entries, when its signature holds.
fn checked(body: &str, sig: &str, key: Option<&VerifyingKey>) -> Option<Vec<Entry>> {
    let key = key?;
    if !verify(body.as_bytes(), sig, key) {
        tracing::warn!("gallery_signature_invalid");
        return None;
    }
    parse(body, env!("CARGO_PKG_VERSION")).map_err(|e| tracing::warn!("gallery_unreadable error={}", e)).ok()
}

fn bundled() -> Gallery {
    Gallery { entries: parse(BUNDLED, env!("CARGO_PKG_VERSION")).unwrap_or_default(), source: "bundled" }
}

/// The entries `known()` hands out, and when they were read.
static KNOWN: Mutex<Option<(Instant, Arc<Vec<Entry>>)>> = Mutex::new(None);
const KNOWN_FOR: Duration = Duration::from_secs(60);

fn remember(entries: &[Entry]) {
    *KNOWN.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), Arc::new(entries.to_vec())));
}

/// The last good list, from memory: re-read from disk (and its signature
/// re-checked) at most once a minute. The connectors list polls every
/// second and names each connector's gallery entry with this.
pub fn known() -> Arc<Vec<Entry>> {
    if let Some((at, entries)) = KNOWN.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if at.elapsed() < KNOWN_FOR {
            return entries.clone();
        }
    }
    let entries = last_good().entries;
    remember(&entries);
    Arc::new(entries)
}

/// The last good list without calling out: the cache when its signature
/// holds, else the shipped copy. For the agent's view of the gallery.
pub fn last_good() -> Gallery {
    if let Some(url) = source_url() {
        if let Some(entries) = read_cache().filter(|c| c.url == url).and_then(|c| checked(&c.body, &c.sig, verifying_key().as_ref())) {
            return Gallery { entries, source: "cache" };
        }
    }
    bundled()
}

/// Let the agent's `mcp(action='servers')` list the gallery.
pub fn install_agent_view() {
    use appv3_mcp::admin::{GalleryAuth, GalleryHint};
    appv3_mcp::admin::set_gallery_source(|| {
        last_good()
            .entries
            .into_iter()
            .map(|e| GalleryHint {
                auth: match e.auth {
                    Auth::None => GalleryAuth::None,
                    Auth::OAuth => GalleryAuth::OAuth,
                    Auth::Key { .. } => GalleryAuth::Key,
                },
                id: e.id,
                name: e.name,
                url: e.url,
            })
            .collect()
    });
}

/// The gallery: the cloud list when it is on and its signature holds (a
/// fetch at most every 15 minutes, or now with `refresh`), else the last
/// good one, else the shipped copy.
pub async fn load(refresh: bool) -> Gallery {
    let g = load_uncached(refresh).await;
    remember(&g.entries);
    g
}

async fn load_uncached(refresh: bool) -> Gallery {
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _g = LOCK.lock().await;
    let Some(url) = source_url() else { return bundled() };
    let key = verifying_key();
    let cached = read_cache().filter(|c| c.url == url);
    let fresh = cached.as_ref().is_some_and(|c| c.fetched.elapsed().is_ok_and(|e| e < FRESH_FOR));
    if fresh && !refresh {
        if let Some(entries) = cached.as_ref().and_then(|c| checked(&c.body, &c.sig, key.as_ref())) {
            return Gallery { entries, source: "cache" };
        }
    }
    let client = reqwest::Client::new();
    let fetched = async {
        let body = get_text(&client, &url).await?;
        let sig = get_text(&client, &format!("{url}.sig")).await?;
        Ok::<_, String>((body, sig))
    }
    .await;
    match fetched {
        Ok((body, sig)) => {
            if let Some(entries) = checked(&body, &sig, key.as_ref()) {
                let c = Cached { body, sig, url, fetched: SystemTime::now() };
                if let Err(e) = write_cache(&c) {
                    tracing::warn!("gallery_cache_write_failed error={}", e);
                }
                return Gallery { entries, source: "cloud" };
            }
        }
        Err(e) => tracing::info!("gallery_fetch_failed url={} error={}", url, e),
    }
    if let Some(entries) = cached.as_ref().and_then(|c| checked(&c.body, &c.sig, key.as_ref())) {
        return Gallery { entries, source: "cache" };
    }
    bundled()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shipped_list_parses_and_has_every_kind() {
        let entries = parse(BUNDLED, env!("CARGO_PKG_VERSION")).unwrap();
        assert!(entries.len() >= 10, "{}", entries.len());
        assert!(entries.iter().any(|e| e.id == "context7" && e.auth == Auth::None));
        assert!(entries.iter().any(|e| e.id == "notion" && e.auth == Auth::OAuth));
        assert!(entries.iter().any(|e| matches!(e.auth, Auth::Key { .. })));
    }

    /// The list in `account-pages/` is what gets published: its signature
    /// must hold under the key this build trusts.
    #[test]
    fn the_published_list_is_signed_with_the_project_key() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../account-pages/connectors");
        let body = std::fs::read(dir.join("v1.json")).unwrap();
        let sig = std::fs::read_to_string(dir.join("v1.json.sig")).unwrap();
        assert!(verify(&body, &sig, &decode_key(DEFAULT_PUBLIC_KEY).unwrap()), "re-sign it: python3 scripts/gallery.py sign --key <key>");
    }

    #[test]
    fn entries_this_build_cannot_show_are_skipped() {
        let doc = json!({"version": 1, "entries": [
            {"type": "connector", "id": "ok", "name": "Ok", "description": "d", "url": "https://ok.example/mcp", "auth": "none"},
            {"type": "plugin", "id": "kit", "name": "Kit", "description": "d", "source": "https://github.com/a/b", "rev": "abc", "sha256": "00"},
            {"type": "connector", "id": "future", "name": "F", "description": "d", "url": "https://f.example/mcp", "auth": "none", "min_app": "99.0.0"},
            {"type": "connector", "id": "newauth", "name": "N", "description": "d", "url": "https://n.example/mcp", "auth": "passkey"},
            {"type": "connector", "id": "plain", "name": "P", "description": "d", "url": "http://p.example/mcp", "auth": "none"},
            {"type": "connector", "id": "Bad Id", "name": "B", "description": "d", "url": "https://b.example/mcp", "auth": "none"},
            {"type": "connector", "id": "ok", "name": "Dup", "description": "d", "url": "https://dup.example/mcp", "auth": "none"},
            {"type": "connector", "id": "older", "name": "O", "description": "d", "url": "https://o.example/mcp", "auth": "none", "min_app": "1.0.0"}
        ]});
        let ids: Vec<String> = parse(&doc.to_string(), "3.60.0").unwrap().into_iter().map(|e| e.id).collect();
        assert_eq!(ids, ["ok", "older"]);
        assert!(parse(r#"{"version": 2, "entries": []}"#, "3.60.0").is_err());
    }

    #[test]
    fn a_signature_covers_exactly_the_signed_bytes() {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
        let body = br#"{"version":1,"entries":[]}"#;
        let sig = base64::engine::general_purpose::STANDARD.encode(ed25519_dalek::Signer::sign(&sk, body).to_bytes());
        let vk = sk.verifying_key();
        assert!(verify(body, &sig, &vk));
        assert!(!verify(br#"{"version":1,"entries":[{}]}"#, &sig, &vk), "an edited list");
        assert!(!verify(body, "", &vk), "an unsigned list");
        let other = ed25519_dalek::SigningKey::from_bytes(&[8u8; 32]).verifying_key();
        assert!(!verify(body, &sig, &other), "another key");
        assert!(decode_key(DEFAULT_PUBLIC_KEY).is_some());
    }

    #[test]
    fn an_icon_is_kept_only_when_it_is_plain_path_data() {
        let entry = |icon: Value| {
            let doc = json!({"version": 1, "entries": [{"type": "connector", "id": "x", "name": "X", "description": "d", "url": "https://x.example/mcp", "auth": "none", "icon": icon}]});
            parse(&doc.to_string(), "3.60.0").unwrap().remove(0)
        };
        let good = entry(json!({"path": "M24 0V24l-9.365-8.045V24H0V0Z", "view_box": "0 0 24 24"}));
        assert_eq!(good.icon, Some(Icon { path: "M24 0V24l-9.365-8.045V24H0V0Z".into(), view_box: "0 0 24 24".into() }));
        assert_eq!(good.to_json()["icon"]["view_box"], "0 0 24 24");
        for bad in [
            json!({"path": "M0 0\"/><script>", "view_box": "0 0 24 24"}),
            json!({"path": "M0 0", "view_box": "0 0 24"}),
            json!({"path": "M0 0", "view_box": "0 0 NaN 24"}),
            json!({"path": "M0 ".repeat(2000), "view_box": "0 0 24 24"}),
            json!("notion.svg"),
        ] {
            let e = entry(bad.clone());
            assert_eq!(e.icon, None, "{bad}");
            assert_eq!(e.id, "x", "the entry stays");
        }
    }

    #[test]
    fn the_shipped_list_has_logos() {
        let entries = parse(BUNDLED, env!("CARGO_PKG_VERSION")).unwrap();
        assert!(entries.iter().filter(|e| e.icon.is_some()).count() >= 16);
        assert!(entries.iter().any(|e| e.id == "context7" && e.icon.is_none()), "no logo: the app shows a monogram");
    }
}
