//! Transport-neutral agent entry points — port of `app/services/agent_service.py`.

use crate::broadcaster;
use crate::events::Envelope;
use crate::session::{session_uploads_dir, AgentSession, SessionError, UserMessage};
use crate::stream_store::store;
use serde_json::{json, Value};
use std::path::Path;

pub const ATTACHMENT_SIZE_LIMIT: usize = 50 * 1024 * 1024;
pub const GLOBAL_SIZE_LIMIT: usize = 50 * 1024 * 1024;
pub const MENTION_MAX_BYTES: usize = 500 * 1024;
pub const MAX_FILENAME_LEN: usize = 200;
const FILENAME_STEM_MAX_LEN: usize = 160;

pub const MIME_CATEGORY: &[(&str, &str)] = &[
    ("text/plain", "text"),
    ("text/csv", "text"),
    ("text/tab-separated-values", "text"),
    ("text/markdown", "text"),
    ("application/json", "text"),
    ("application/x-ndjson", "text"),
    ("text/javascript", "text"),
    ("application/javascript", "text"),
    ("text/typescript", "text"),
    ("application/typescript", "text"),
    ("text/x-python", "text"),
    ("text/x-python-script", "text"),
    ("text/x-go", "text"),
    ("text/x-rustsrc", "text"),
    ("text/x-ruby", "text"),
    ("text/x-java-source", "text"),
    ("text/x-csrc", "text"),
    ("text/x-c++src", "text"),
    ("text/x-chdr", "text"),
    ("text/x-csharp", "text"),
    ("text/x-sh", "text"),
    ("application/x-sh", "text"),
    ("text/x-shellscript", "text"),
    ("application/x-shellscript", "text"),
    ("application/x-yaml", "text"),
    ("text/yaml", "text"),
    ("text/x-yaml", "text"),
    ("application/toml", "text"),
    ("text/x-toml", "text"),
    ("application/xml", "text"),
    ("text/xml", "text"),
    ("text/css", "text"),
    ("text/x-sql", "text"),
    ("application/x-sql", "text"),
    ("text/x-rsrc", "text"),
    ("text/x-scala", "text"),
    ("text/x-swift", "text"),
    ("text/x-kotlin", "text"),
    ("text/x-php", "text"),
    ("application/x-httpd-php", "text"),
    ("image/svg+xml", "text"),
    ("text/html", "document"),
    ("application/xhtml+xml", "document"),
    ("image/jpeg", "image"),
    ("image/png", "image"),
    ("image/gif", "image"),
    ("image/webp", "image"),
    ("image/bmp", "image"),
    ("image/tiff", "image"),
    ("application/pdf", "document"),
    ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "document"),
    ("audio/mpeg", "audio"),
    ("audio/mp4", "audio"),
    ("audio/wav", "audio"),
    ("audio/webm", "audio"),
    ("audio/ogg", "audio"),
    ("audio/flac", "audio"),
    ("video/mp4", "video"),
    ("video/webm", "video"),
    ("video/ogg", "video"),
    ("video/quicktime", "video"),
];
pub const EXT_CATEGORY: &[(&str, &str)] = &[
    (".txt", "text"),
    (".csv", "text"),
    (".tsv", "text"),
    (".md", "text"),
    (".markdown", "text"),
    (".json", "text"),
    (".ndjson", "text"),
    (".jsonl", "text"),
    (".py", "text"),
    (".pyi", "text"),
    (".js", "text"),
    (".mjs", "text"),
    (".cjs", "text"),
    (".jsx", "text"),
    (".ts", "text"),
    (".tsx", "text"),
    (".go", "text"),
    (".rs", "text"),
    (".rb", "text"),
    (".java", "text"),
    (".kt", "text"),
    (".kts", "text"),
    (".swift", "text"),
    (".c", "text"),
    (".cpp", "text"),
    (".cc", "text"),
    (".cxx", "text"),
    (".h", "text"),
    (".hpp", "text"),
    (".cs", "text"),
    (".php", "text"),
    (".sh", "text"),
    (".bash", "text"),
    (".zsh", "text"),
    (".fish", "text"),
    (".ps1", "text"),
    (".sql", "text"),
    (".graphql", "text"),
    (".gql", "text"),
    (".proto", "text"),
    (".tf", "text"),
    (".tfvars", "text"),
    (".scala", "text"),
    (".clj", "text"),
    (".ex", "text"),
    (".exs", "text"),
    (".lua", "text"),
    (".r", "text"),
    (".R", "text"),
    (".jl", "text"),
    (".dart", "text"),
    (".vim", "text"),
    (".yaml", "text"),
    (".yml", "text"),
    (".toml", "text"),
    (".ini", "text"),
    (".cfg", "text"),
    (".conf", "text"),
    (".env", "text"),
    (".xml", "text"),
    (".svg", "text"),
    (".css", "text"),
    (".scss", "text"),
    (".sass", "text"),
    (".less", "text"),
    (".mdx", "text"),
    (".rst", "text"),
    (".tex", "text"),
    (".log", "text"),
    (".diff", "text"),
    (".patch", "text"),
    (".jpg", "image"),
    (".jpeg", "image"),
    (".png", "image"),
    (".gif", "image"),
    (".webp", "image"),
    (".bmp", "image"),
    (".tif", "image"),
    (".tiff", "image"),
    (".pdf", "document"),
    (".docx", "document"),
    (".html", "document"),
    (".htm", "document"),
    (".mp3", "audio"),
    (".m4a", "audio"),
    (".wav", "audio"),
    (".ogg", "audio"),
    (".flac", "audio"),
    (".mp4", "video"),
    (".webm", "video"),
    (".mov", "video"),
];

const MAGIC_BYTES: &[(&str, &[&[u8]])] = &[
    ("image/jpeg", &[b"\xff\xd8\xff"]),
    ("image/png", &[b"\x89PNG\r\n\x1a\n"]),
    ("image/gif", &[b"GIF87a", b"GIF89a"]),
    ("image/webp", &[b"RIFF"]),
    ("image/bmp", &[b"BM"]),
    ("application/pdf", &[b"%PDF"]),
    ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", &[b"PK"]),
];

fn lookup(table: &[(&str, &'static str)], key: &str) -> Option<&'static str> {
    table.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

/// Python `PurePath.name`.
pub fn py_name(p: &str) -> String {
    let t = p.trim_end_matches('/');
    t.rsplit('/').next().unwrap_or("").to_string()
}

/// Python `PurePath.suffix`.
pub fn py_suffix(name: &str) -> String {
    let n = py_name(name);
    match n.rfind('.') {
        Some(i) if i > 0 && i < n.len() - 1 => n[i..].to_string(),
        _ => String::new(),
    }
}

/// Python `PurePath.stem`.
pub fn py_stem(name: &str) -> String {
    let n = py_name(name);
    let suf = py_suffix(&n);
    n[..n.len() - suf.len()].to_string()
}

/// `html.escape`.
pub fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#x27;")
}

pub fn categorize(filename: &str, content_type: Option<&str>) -> Option<&'static str> {
    let mime = content_type.unwrap_or("").split(';').next().unwrap_or("").trim().to_lowercase();
    if !mime.is_empty() {
        if let Some(c) = lookup(MIME_CATEGORY, &mime) {
            return Some(c);
        }
    }
    lookup(EXT_CATEGORY, &py_suffix(filename).to_lowercase())
}

fn validate_magic(data: &[u8], mime: &str) -> bool {
    let Some((_, sigs)) = MAGIC_BYTES.iter().find(|(m, _)| *m == mime) else {
        return true;
    };
    sigs.iter().any(|s| !data.is_empty() && data.starts_with(s))
}

fn ext_mime_consistent(filename: &str, mime: &str) -> bool {
    match (lookup(EXT_CATEGORY, &py_suffix(filename).to_lowercase()), lookup(MIME_CATEGORY, mime)) {
        (Some(a), Some(b)) => a == b,
        _ => true,
    }
}

fn default_ext(category: &str) -> &'static str {
    match category {
        "text" => ".txt",
        "image" => ".jpg",
        "document" => ".pdf",
        "audio" => ".mp3",
        "video" => ".mp4",
        _ => ".bin",
    }
}

fn truncate_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// `_sanitize_upload_filename`.
pub fn sanitize_upload_filename(raw: &str, category: &str) -> String {
    let leaf = py_name(if raw.is_empty() { "upload" } else { raw });
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"[\x00-\x1f\x7f/\\]+").unwrap());
    let mut cleaned = RE.replace_all(&leaf, "_").trim().trim_matches('.').to_string();
    if cleaned.is_empty() {
        cleaned = format!("upload{}", default_ext(category));
    }
    let ext_source = cleaned.split("#L").next().unwrap_or("").to_string();
    let mut ext = py_suffix(&ext_source);
    if ext.is_empty() {
        ext = default_ext(category).to_string();
    }
    let mut stem = py_stem(&ext_source);
    if stem.is_empty() {
        stem = "upload".into();
    }
    stem = truncate_chars(&stem, FILENAME_STEM_MAX_LEN).trim_end().to_string();
    if stem.is_empty() {
        stem = "upload".into();
    }
    let candidate = format!("{stem}{ext}");
    if candidate.chars().count() <= MAX_FILENAME_LEN {
        return candidate;
    }
    let allowed = 1usize.max(MAX_FILENAME_LEN.saturating_sub(ext.chars().count()));
    format!("{}{ext}", truncate_chars(&stem, allowed).trim_end())
}

/// `_dedupe_upload_filename`.
pub fn dedupe_upload_filename(dir: &Path, filename: &str) -> String {
    let mut candidate = filename.to_string();
    let stem = {
        let s = py_stem(filename);
        if s.is_empty() {
            "upload".to_string()
        } else {
            s
        }
    };
    let ext = py_suffix(filename);
    let mut i = 1;
    while dir.join(&candidate).exists() {
        let suffix = format!(" ({i})");
        let allowed = 1usize.max(MAX_FILENAME_LEN.saturating_sub(ext.chars().count() + suffix.chars().count()));
        let mut trimmed = truncate_chars(&stem, allowed).trim_end().to_string();
        if trimmed.is_empty() {
            trimmed = "upload".into();
        }
        candidate = format!("{trimmed}{suffix}{ext}");
        i += 1;
    }
    candidate
}

#[derive(Debug, Clone)]
pub struct RawAttachment {
    pub filename: String,
    pub content_type: Option<String>,
    pub data: Vec<u8>,
    pub source: Option<String>,
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct AttachmentError {
    pub message: String,
    pub status: u16,
}

fn att_err(m: String, status: u16) -> AttachmentError {
    AttachmentError { message: m, status }
}

async fn persist_attachment(att: &RawAttachment, category: &str, dir: &Path, session_id: &str) -> Result<Value, AttachmentError> {
    let data = &att.data;
    if data.is_empty() {
        return Err(att_err(format!("'{}' is empty (0 bytes).", att.filename), 422));
    }
    if data.len() > ATTACHMENT_SIZE_LIMIT {
        return Err(att_err(format!("'{}' is {} KB — exceeds the {} KB limit for {category} files.", att.filename, data.len() / 1024, ATTACHMENT_SIZE_LIMIT / 1024), 413));
    }
    let mut mime = att.content_type.clone().unwrap_or_default().split(';').next().unwrap_or("").trim().to_string();
    if mime.is_empty() {
        mime = "application/octet-stream".into();
    }
    let original = if att.filename.is_empty() { "upload".to_string() } else { att.filename.clone() };
    let safe_storage = sanitize_upload_filename(&original, category);
    let safe_original = html_escape(&safe_storage);
    if !validate_magic(data, &mime) {
        return Err(att_err(format!("'{safe_original}' content does not match its declared type '{mime}'."), 422));
    }
    if !ext_mime_consistent(&safe_storage, &mime) {
        return Err(att_err(format!("'{safe_original}' extension does not match its content type '{mime}'."), 422));
    }
    std::fs::create_dir_all(dir).map_err(|e| att_err(e.to_string(), 500))?;
    let filename = dedupe_upload_filename(dir, &safe_storage);
    let dest = dir.join(&filename);
    tokio::fs::write(&dest, data).await.map_err(|e| att_err(e.to_string(), 500))?;
    let mut meta = json!({
        "filename": filename,
        "path": dest.display().to_string(),
        "workspace_path": dest.display().to_string(),
        "original_name": safe_original,
        "media_type": mime,
        "category": category,
        "url": format!("/api/agent/{session_id}/uploads/{filename}"),
    });
    if let Some(s) = att.source.as_deref().filter(|s| !s.is_empty()) {
        meta["source"] = json!(s);
    }
    Ok(meta)
}

/// `validate_and_persist_attachments`.
pub async fn validate_and_persist_attachments(attachments: &[RawAttachment], session_id: Option<&str>, workspace: Option<&str>) -> Result<(String, Vec<Value>), AttachmentError> {
    let mut valid = vec![];
    let mut total = 0usize;
    for a in attachments {
        if a.filename.is_empty() {
            continue;
        }
        let cat = categorize(&a.filename, a.content_type.as_deref()).unwrap_or("file");
        total += a.data.len();
        if total > GLOBAL_SIZE_LIMIT {
            return Err(att_err("Total upload size exceeds the global limit.".into(), 413));
        }
        valid.push((a, cat));
    }
    let sid = session_id.map(String::from).unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
    let dir = session_uploads_dir(&sid, workspace);
    let mut metas = vec![];
    for (a, cat) in valid {
        metas.push(persist_attachment(a, cat, &dir, &sid).await?);
    }
    Ok((sid, metas))
}

#[derive(Debug, thiserror::Error)]
pub enum DispatchError {
    #[error(transparent)]
    Attachment(#[from] AttachmentError),
    #[error(transparent)]
    Session(#[from] SessionError),
}

#[derive(Default, Clone)]
pub struct Dispatch {
    pub content: String,
    pub session_id: Option<String>,
    pub attachments: Vec<RawAttachment>,
    pub mention_context_blocks: Option<Vec<String>>,
    pub workspace: Option<String>,
    pub model: Option<String>,
    pub model_provided: bool,
    pub thinking_level: Option<String>,
    pub thinking_level_provided: bool,
    pub service_tier: Option<String>,
    pub mentions: Option<Vec<String>>,
    pub origin: String,
    /// Extra keys stored on the user message row.
    pub extra: Option<serde_json::Map<String, Value>>,
}

/// `dispatch_user_message` → `(session_id, n_attachments, message_id)`.
pub async fn dispatch_user_message(session: &AgentSession, d: Dispatch) -> Result<(String, usize, String), DispatchError> {
    let sid = d.session_id.clone().unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
    let metas = if d.attachments.is_empty() { vec![] } else { validate_and_persist_attachments(&d.attachments, Some(&sid), d.workspace.as_deref()).await?.1 };
    let n = metas.len();
    let (_, mid) = session
        .handle_user_message(UserMessage {
            content: d.content,
            session_id: sid.clone(),
            interrupt: false,
            attachment_metas: if metas.is_empty() { None } else { Some(metas) },
            mention_context_blocks: d.mention_context_blocks.filter(|b| !b.is_empty()),
            workspace: d.workspace,
            model_provided: d.model_provided || d.model.is_some(),
            model: d.model,
            thinking_level_provided: d.thinking_level_provided || d.thinking_level.is_some(),
            thinking_level: d.thinking_level,
            service_tier: d.service_tier,
            mentions: d.mentions,
            origin: if d.origin.is_empty() { "user".into() } else { d.origin },
            extra: d.extra,
        })
        .await?;
    tracing::info!("agent_service_dispatched session_id={} attachments={}", sid, n);
    Ok((sid, n, mid))
}

/// `interrupt_agent` → cancelled agent names.
pub async fn interrupt_agent(session: &AgentSession, session_id: Option<&str>) -> Vec<String> {
    let effective = session_id.map(String::from).or_else(|| Some(session.session_id())).filter(|s| !s.is_empty());
    if let Some(sid) = &effective {
        match crate::snapshot::release_queued(&session.pool, sid).await {
            Ok(r) if !r.is_empty() => tracing::info!("agent_interrupt_released_queued session_id={} count={}", sid, r.len()),
            Ok(_) => {}
            Err(e) => tracing::warn!("agent_interrupt_release_queue_failed session_id={} error={}", sid, e),
        }
    }
    session.dismiss_pending_question("dismissed", effective.as_deref()).await;
    let mut names = vec![];
    if session.is_busy() {
        names.push(session.name());
        session.handle_stop().await;
    }
    if let Some(sid) = &effective {
        store().push_event(sid, &Envelope::from_parts("done", json!({})), true);
        store().mark_done(sid);
        broadcaster::publish("session_turn_completed", json!({"session_id": sid, "status": "stopped"}));
    }
    tracing::info!("agent_interrupt session_id={:?} cancelled={:?}", session_id, names);
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filenames_match_python_pathlib() {
        assert_eq!(py_suffix("a.tar.gz"), ".gz");
        assert_eq!(py_suffix(".bashrc"), "");
        assert_eq!(py_stem(".bashrc"), ".bashrc");
        assert_eq!(sanitize_upload_filename("../../etc/passwd", "text"), "passwd.txt");
        assert_eq!(sanitize_upload_filename("", "image"), "upload.jpg");
        assert_eq!(sanitize_upload_filename("main.py#L10-20", "text"), "main.py");
        assert_eq!(categorize("x.PNG", None), Some("image"));
        assert_eq!(categorize("x.bin", Some("image/png; q=1")), Some("image"));
        assert!(!validate_magic(b"nope", "image/png"));
        assert_eq!(html_escape("<a'>"), "&lt;a&#x27;&gt;");
    }
}
