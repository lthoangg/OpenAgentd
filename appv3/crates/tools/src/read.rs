//! `read` — port of `filesystem/read.py` + `handlers.py`.

use crate::args::Args;
use crate::{outline, Tool, ToolContext, ToolError, ToolOutput, ToolResult};
use appv3_providers::ContentBlock;
use async_trait::async_trait;
use base64::Engine;
use serde_json::Value;
use std::path::Path;

pub const MAX_READ_BYTES: usize = 5_242_880;
pub const MAX_CONTEXT_CHARS: usize = 50_000;
pub const MAX_LINE_CHARS: usize = 2_000;
pub const MAX_IMAGE_BYTES: u64 = 10_485_760;
/// Directory listings show this many entries, then how many more there are.
pub const MAX_DIR_ENTRIES: usize = 500;
/// A NUL byte this early means binary content, which is not decoded.
const BINARY_SNIFF_BYTES: usize = 8192;

const IMAGE_EXT: &[&str] = &[".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico", ".tiff", ".tif"];
const DOC_EXT: &[&str] = &[".pdf", ".docx"];

pub fn ext_of(p: &Path) -> String {
    p.extension().map(|e| format!(".{}", e.to_string_lossy().to_lowercase())).unwrap_or_default()
}

pub fn classify_file(p: &Path) -> &'static str {
    let e = ext_of(p);
    if IMAGE_EXT.contains(&e.as_str()) {
        "image"
    } else if DOC_EXT.contains(&e.as_str()) {
        "document"
    } else {
        "text"
    }
}

pub fn image_mime(p: &Path) -> String {
    match ext_of(p).as_str() {
        ".png" => "image/png",
        ".jpg" | ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".bmp" => "image/bmp",
        ".svg" => "image/svg+xml",
        ".ico" => "image/vnd.microsoft.icon",
        ".tiff" | ".tif" => "image/tiff",
        ".pdf" => "application/pdf",
        ".docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        _ => "application/octet-stream",
    }
    .to_string()
}

fn py_len(s: &str) -> usize {
    s.chars().count()
}

pub(crate) fn fmt_thousands(n: usize) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

pub fn cap_long_lines(text: &str) -> std::borrow::Cow<'_, str> {
    // A line within MAX_LINE_CHARS bytes is within it in chars too, so only
    // longer lines are counted; most files have none and are not copied.
    if text.split('\n').all(|l| l.len() <= MAX_LINE_CHARS || py_len(l) <= MAX_LINE_CHARS) {
        return std::borrow::Cow::Borrowed(text);
    }
    let trailing = text.ends_with('\n');
    let body = if trailing { &text[..text.len() - 1] } else { text };
    let capped: Vec<String> = body
        .split('\n')
        .map(|l| {
            if py_len(l) > MAX_LINE_CHARS {
                format!("{}… (line truncated to {} chars)", l.chars().take(MAX_LINE_CHARS).collect::<String>(), MAX_LINE_CHARS)
            } else {
                l.to_string()
            }
        })
        .collect();
    std::borrow::Cow::Owned(capped.join("\n") + if trailing { "\n" } else { "" })
}

fn cap_for_context(text: &str, rel: &str) -> String {
    let n = py_len(text);
    if n <= MAX_CONTEXT_CHARS {
        return text.to_string();
    }
    let preview: String = text.chars().take(MAX_CONTEXT_CHARS).collect();
    format!(
        "{}\n\n[read output truncated for LLM context: {rel} is {} characters; shown first {}. Use offset and limit to read a smaller line range, or shell tools such as grep/sed/head/tail for targeted inspection.]",
        preview.trim_end(),
        fmt_thousands(n),
        fmt_thousands(MAX_CONTEXT_CHARS)
    )
}

/// Decode as UTF-8, else Latin-1 (v2 behaviour).
pub fn decode_text(raw: &[u8]) -> String {
    match std::str::from_utf8(raw) {
        Ok(s) => s.to_string(),
        Err(_) => raw.iter().map(|b| *b as char).collect(),
    }
}

/// Python `str.splitlines(keepends=True)`.
pub fn splitlines_keepends(text: &str) -> Vec<&str> {
    let mut out = vec![];
    let mut start = 0;
    let mut chars = text.char_indices().peekable();
    while let Some((idx, c)) = chars.next() {
        let is_break = matches!(c, '\n' | '\r' | '\x0b' | '\x0c' | '\x1c' | '\x1d' | '\x1e' | '\u{85}' | '\u{2028}' | '\u{2029}');
        if is_break {
            let mut end = idx + c.len_utf8();
            if c == '\r' && chars.next_if(|&(_, n)| n == '\n').is_some() {
                end += 1;
            }
            out.push(&text[start..end]);
            start = end;
        }
    }
    if start < text.len() {
        out.push(&text[start..]);
    }
    out
}

pub fn read_text(resolved: &Path, rel: &str, offset: i64, limit: Option<i64>) -> std::io::Result<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(resolved)?;
    let mut raw = Vec::new();
    (&mut f).take((MAX_READ_BYTES + 1) as u64).read_to_end(&mut raw)?;
    if raw.len() > MAX_READ_BYTES {
        tracing::warn!("file_read_truncated path={} size={}", resolved.display(), raw.len());
        raw.truncate(MAX_READ_BYTES);
    }
    if raw[..raw.len().min(BINARY_SNIFF_BYTES)].contains(&0) {
        let size = f.metadata().map(|m| m.len() as usize).unwrap_or(raw.len());
        return Ok(format!("[{rel} is a binary file ({} bytes); not shown. Use the shell (for example `file` or `xxd | head`) to inspect it.]", fmt_thousands(size)));
    }
    let text = decode_text(&raw);
    if offset == 1 && limit.is_none() {
        return Ok(cap_for_context(&cap_long_lines(&text), rel));
    }
    let lines = splitlines_keepends(&text);
    let total = lines.len();
    let start = (offset - 1).max(0) as usize;
    if start >= total {
        return Ok(format!("[no content: offset {offset} is past the end of {rel}, which has {total} lines]"));
    }
    let end = match limit {
        None => total,
        Some(l) => total.min(start + l as usize),
    };
    let header = format!("[{}-{}/{}]\n", start + 1, end, total);
    let selected = lines[start..end].concat();
    let body = cap_long_lines(&selected);
    Ok(cap_for_context(&(header + &body), rel))
}

pub fn format_directory(resolved: &Path) -> std::io::Result<String> {
    // Sort on the kinds readdir reports; stat only the entries shown.
    let mut entries: Vec<(bool, String, std::path::PathBuf)> = std::fs::read_dir(resolved)?
        .filter_map(|e| e.ok())
        .map(|e| {
            let p = e.path();
            let is_file = match e.file_type() {
                Ok(t) if t.is_file() => true,
                Ok(t) if t.is_dir() => false,
                _ => p.is_file(),
            };
            (is_file, e.file_name().to_string_lossy().to_string(), p)
        })
        .collect();
    entries.sort_by(|a, b| (a.0, &a.1).cmp(&(b.0, &b.1)));
    if entries.is_empty() {
        return Ok("(empty directory)".into());
    }
    let shown: Vec<String> = entries
        .iter()
        .take(MAX_DIR_ENTRIES)
        .map(|(f, n, p)| if *f { format!("[f] {n}  ({} bytes)", std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)) } else { format!("[d] {n}/") })
        .collect();
    let mut out = shown.join("\n");
    if entries.len() > MAX_DIR_ENTRIES {
        out.push_str(&format!("\n\n[{} more entries not shown ({} in total). Use glob with a pattern to find specific files.]", entries.len() - MAX_DIR_ENTRIES, entries.len()));
    }
    Ok(out)
}

pub fn handle_image(resolved: &Path, rel: &str) -> Result<ToolOutput, ToolError> {
    let size = std::fs::metadata(resolved)?.len();
    if size > MAX_IMAGE_BYTES {
        return Err(ToolError::Execution(format!("Image '{rel}' is {} KB — exceeds the {} KB limit for vision input.", size / 1024, MAX_IMAGE_BYTES / 1024)));
    }
    let raw = std::fs::read(resolved)?;
    // Shrink before encoding: one decode, one base64 pass (images::MAX_IMAGE_EDGE).
    let (label, raw, media_type) = match appv3_providers::images::fit_image_bytes(&raw, appv3_providers::images::MAX_IMAGE_EDGE) {
        Some(f) => (format!("[Image: {rel} (resized {}×{} → {}×{})]", f.from.0, f.from.1, f.to.0, f.to.1), f.bytes, f.media_type.to_string()),
        None => {
            let mt = appv3_providers::images::sniff_media_type(&raw).map(String::from).unwrap_or_else(|| image_mime(resolved));
            (format!("[Image: {rel}]"), raw, mt)
        }
    };
    Ok(ToolOutput::Parts {
        parts: vec![ContentBlock::text(label), ContentBlock::ImageData { data: base64::engine::general_purpose::STANDARD.encode(raw).into(), media_type }],
        mcp_app: None,
    })
}

/// Documents (PDF, DOCX) → Markdown via `anydoc`, like v2's `handle_document`.
///
/// A PDF with no extractable text layer (a scan) fails with `NeedsOcr`; the
/// raw bytes then go to a vision model instead. Encryption is reported as
/// itself, because neither a retry nor a vision model can read it.
pub fn handle_document(resolved: &Path, rel: &str) -> Result<ToolOutput, ToolError> {
    let mt = image_mime(resolved);
    let size = std::fs::metadata(resolved)?.len();
    if size > MAX_IMAGE_BYTES {
        return Ok(ToolOutput::Parts {
            parts: vec![ContentBlock::text(format!(
                "[Document: {rel}] ({mt}, {} bytes)\nFile exceeds the {} KB limit for processing.",
                fmt_thousands(size as usize),
                MAX_IMAGE_BYTES / 1024
            ))],
            mcp_app: None,
        });
    }
    let raw = std::fs::read(resolved)?;
    let converted = match crate::web::convert_document(&raw) {
        Ok(md) => Some(md),
        Err(anydoc::ConvertError::Encrypted) => {
            tracing::info!("document_encrypted path={rel} size={}", raw.len());
            return Ok(ToolOutput::Parts {
                parts: vec![ContentBlock::text(format!(
                    "[Document: {rel}] ({mt}, {} bytes)\nThe document is encrypted or password-protected, so its text cannot be extracted.",
                    fmt_thousands(raw.len())
                ))],
                mcp_app: None,
            });
        }
        Err(e) => {
            tracing::debug!("document_conversion_failed path={rel} error={e}");
            None
        }
    };
    if let Some(md) = converted.filter(|m| !m.is_empty()) {
        return Ok(ToolOutput::Parts { parts: vec![ContentBlock::text(format!("[Document: {rel}]\n{md}"))], mcp_app: None });
    }
    if ext_of(resolved) == ".pdf" {
        tracing::info!("document_pdf_vision_fallback path={rel} size={}", raw.len());
        return Ok(ToolOutput::Parts {
            parts: vec![
                ContentBlock::text(format!("[Document: {rel}] (PDF — raw, text extraction failed)")),
                ContentBlock::ImageData { data: base64::engine::general_purpose::STANDARD.encode(&raw).into(), media_type: "application/pdf".into() },
            ],
            mcp_app: None,
        });
    }
    Ok(ToolOutput::Parts {
        parts: vec![ContentBlock::text(format!(
            "[Document: {rel}] ({mt}, {} bytes)\nUnable to extract text. File may be corrupted or in an unsupported format.",
            fmt_thousands(raw.len())
        ))],
        mcp_app: None,
    })
}

pub struct ReadTool;

#[async_trait]
impl Tool for ReadTool {
    fn name(&self) -> &str {
        "read"
    }
    async fn run(&self, ctx: &ToolContext, args: Value) -> ToolResult {
        let mut a = Args::new("read", &args);
        let path = a.req_str(&["path", "file_path", "filename", "filepath"]);
        // offset/limit validators: strip non-digits from strings, clamp to >=1
        let offset = match a.raw(&["offset"]) {
            None | Some(Value::Null) => 1,
            Some(Value::String(s)) => {
                let d: String = s.chars().filter(|c| c.is_ascii_digit()).collect();
                d.parse::<i64>().map(|n| n.max(1)).unwrap_or(1)
            }
            Some(_) => a.opt_int(&["offset"], Some(1), None).unwrap_or(1),
        };
        let limit = match a.raw(&["limit"]) {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) if s.is_empty() || s.trim().eq_ignore_ascii_case("all") => None,
            Some(Value::String(s)) => {
                let d: String = s.chars().filter(|c| c.is_ascii_digit()).collect();
                d.parse::<i64>().ok().map(|n| n.max(1))
            }
            Some(_) => a.opt_int(&["limit"], Some(1), None),
        };
        let outline_flag = a.bool_or(&["outline"], false);
        a.finish()?;

        let denied = ctx.denied.clone();
        tokio::task::spawn_blocking(move || -> ToolResult {
            let resolved = denied.validate_read_path(&path)?;
            let rel = denied.display_path(&resolved);
            if !resolved.exists() {
                return Err(ToolError::Execution(format!("File not found: {rel}")));
            }
            if resolved.is_dir() {
                return Ok(ToolOutput::Text(format_directory(&resolved)?));
            }
            if !resolved.is_file() {
                return Err(ToolError::Execution(format!("Path is not a regular file: {rel}")));
            }
            if outline_flag {
                return Ok(ToolOutput::Text(outline::generate_file_outline(&resolved, &rel)?));
            }
            match classify_file(&resolved) {
                "image" => handle_image(&resolved, &rel),
                "document" => handle_document(&resolved, &rel),
                _ => Ok(ToolOutput::Text(read_text(&resolved, &rel, offset, limit)?)),
            }
        })
        .await
        .map_err(ToolError::exec)?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paginates_like_v2() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("a.txt");
        std::fs::write(&p, "l1\nl2\nl3\n").unwrap();
        assert_eq!(read_text(&p, "a.txt", 1, None).unwrap(), "l1\nl2\nl3\n");
        assert_eq!(read_text(&p, "a.txt", 2, Some(1)).unwrap(), "[2-2/3]\nl2\n");
        assert_eq!(read_text(&p, "a.txt", 9, None).unwrap(), "[no content: offset 9 is past the end of a.txt, which has 3 lines]");
    }

    use crate::web::tests::{minimal_docx, minimal_pdf};

    fn doc(name: &str, bytes: &[u8]) -> (String, bool) {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join(name);
        std::fs::write(&p, bytes).unwrap();
        let ToolOutput::Parts { parts, .. } = handle_document(&p, name).unwrap() else { panic!("parts") };
        let text = parts.iter().filter_map(|b| if let ContentBlock::Text { text, .. } = b { Some(text.clone()) } else { None }).collect::<Vec<_>>().join("\n");
        let has_pdf = parts.iter().any(|b| matches!(b, ContentBlock::ImageData { media_type, .. } if media_type == "application/pdf"));
        (text, has_pdf)
    }

    #[test]
    fn pdf_and_docx_convert_to_text() {
        let (t, raw) = doc("report.pdf", &minimal_pdf("Hello Anydoc World", false));
        assert!(t.starts_with("[Document: report.pdf]\n") && t.contains("Hello Anydoc World"), "{t}");
        assert!(!raw, "converted text must not also send the raw bytes");
        let (t, _) = doc("notes.docx", &minimal_docx("Hello from DOCX"));
        assert_eq!(t, "[Document: notes.docx]\nHello from DOCX");
    }

    #[test]
    fn unreadable_pdf_falls_back_to_vision_and_other_formats_report_failure() {
        // No text layer (here: not a PDF at all) → the raw bytes go to a vision model.
        let (t, raw) = doc("scan.pdf", b"%PDF-1.4\nnot really a pdf");
        assert_eq!(t, "[Document: scan.pdf] (PDF — raw, text extraction failed)");
        assert!(raw);
        let (t, raw) = doc("broken.docx", b"this is not a docx at all");
        assert!(t.contains("Unable to extract text. File may be corrupted or in an unsupported format."), "{t}");
        assert!(!raw);
    }

    #[test]
    fn encrypted_document_says_it_is_password_protected() {
        let (t, raw) = doc("payroll.pdf", &minimal_pdf("secret", true));
        assert!(t.contains("The document is encrypted or password-protected"), "{t}");
        assert!(!raw);
    }

    #[test]
    fn large_images_are_resized_before_encoding_and_small_ones_sent_as_is() {
        use appv3_providers::images::{dimensions_b64, fixtures};
        let d = tempfile::tempdir().unwrap();
        let big = d.path().join("big.png");
        std::fs::write(&big, fixtures::png(2400, 1600)).unwrap();
        let ToolOutput::Parts { parts, .. } = handle_image(&big, "big.png").unwrap() else { panic!("parts") };
        assert_eq!(parts[0], ContentBlock::text("[Image: big.png (resized 2400×1600 → 2000×1333)]"));
        let ContentBlock::ImageData { data, media_type } = &parts[1] else { panic!("image") };
        assert_eq!((dimensions_b64(data), media_type.as_str()), (Some((2000, 1333)), "image/png"));

        let small_bytes = fixtures::jpeg(320, 200);
        let small = d.path().join("small.jpg");
        std::fs::write(&small, &small_bytes).unwrap();
        let ToolOutput::Parts { parts, .. } = handle_image(&small, "small.jpg").unwrap() else { panic!("parts") };
        assert_eq!(parts[0], ContentBlock::text("[Image: small.jpg]"));
        assert_eq!(parts[1], ContentBlock::ImageData { data: base64::engine::general_purpose::STANDARD.encode(&small_bytes).into(), media_type: "image/jpeg".into() });
    }

    #[test]
    fn image_media_type_comes_from_the_bytes_not_the_extension() {
        use appv3_providers::images::fixtures;
        let d = tempfile::tempdir().unwrap();
        let jpeg_bytes = fixtures::jpeg(64, 48);
        let p = d.path().join("shot.png");
        std::fs::write(&p, &jpeg_bytes).unwrap();
        let ToolOutput::Parts { parts, .. } = handle_image(&p, "shot.png").unwrap() else { panic!("parts") };
        let ContentBlock::ImageData { media_type, .. } = &parts[1] else { panic!("image") };
        assert_eq!(media_type, "image/jpeg");
    }

    #[test]
    fn splitlines_follows_python() {
        assert_eq!(splitlines_keepends("a\nb\r\nc\rd\x0be\u{2028}f\u{85}g"), ["a\n", "b\r\n", "c\r", "d\x0b", "e\u{2028}", "f\u{85}", "g"]);
        assert_eq!(splitlines_keepends("x\n\n"), ["x\n", "\n"]);
        assert_eq!(splitlines_keepends("\r"), ["\r"]);
        assert!(splitlines_keepends("").is_empty());
    }

    #[test]
    fn long_lines_and_large_files_are_capped() {
        assert_eq!(cap_long_lines("short\nlines\n"), "short\nlines\n");
        let long = "é".repeat(MAX_LINE_CHARS + 5);
        let input = format!("ok\n{long}\nend");
        let capped = cap_long_lines(&input);
        assert_eq!(capped, format!("ok\n{}… (line truncated to {MAX_LINE_CHARS} chars)\nend", "é".repeat(MAX_LINE_CHARS)));
        // Exactly at the limit (in chars, though over it in bytes): kept.
        let edge = "é".repeat(MAX_LINE_CHARS);
        assert_eq!(cap_long_lines(&format!("{edge}\n{edge}\n")), format!("{edge}\n{edge}\n"));
        let big = "abcdefghi\n".repeat(MAX_CONTEXT_CHARS / 5);
        let out = cap_for_context(&big, "big.txt");
        assert!(out.starts_with("abcdefghi\n"), "{}", &out[..20]);
        assert!(out.ends_with(&format!("[read output truncated for LLM context: big.txt is {} characters; shown first 50,000. Use offset and limit to read a smaller line range, or shell tools such as grep/sed/head/tail for targeted inspection.]", fmt_thousands(MAX_CONTEXT_CHARS * 2))));
        assert_eq!(cap_for_context("small", "s"), "small");
    }

    #[test]
    fn small_directories_list_dirs_then_files() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir(d.path().join("sub")).unwrap();
        std::fs::write(d.path().join("b.txt"), "hey").unwrap();
        std::fs::write(d.path().join("a.txt"), "x").unwrap();
        assert_eq!(format_directory(d.path()).unwrap(), "[d] sub/\n[f] a.txt  (1 bytes)\n[f] b.txt  (3 bytes)");
        let e = tempfile::tempdir().unwrap();
        assert_eq!(format_directory(e.path()).unwrap(), "(empty directory)");
    }

    #[test]
    fn large_directories_are_capped() {
        let d = tempfile::tempdir().unwrap();
        for i in 0..10 {
            std::fs::create_dir(d.path().join(format!("d{i:02}"))).unwrap();
        }
        for i in 0..(MAX_DIR_ENTRIES + 90) {
            std::fs::write(d.path().join(format!("f{i:04}")), "").unwrap();
        }
        let out = format_directory(d.path()).unwrap();
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), MAX_DIR_ENTRIES + 2, "entries, a blank line, the note");
        assert_eq!(lines[0], "[d] d00/");
        assert_eq!(lines[10], "[f] f0000  (0 bytes)");
        assert_eq!(lines[MAX_DIR_ENTRIES + 1], format!("[100 more entries not shown ({} in total). Use glob with a pattern to find specific files.]", MAX_DIR_ENTRIES + 100));
    }

    #[test]
    fn binary_files_are_reported_not_decoded() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("blob.bin");
        let mut bytes = b"MZ\x90\x00\x03".to_vec();
        bytes.extend(std::iter::repeat_n(0xffu8, 2000));
        std::fs::write(&p, &bytes).unwrap();
        assert_eq!(
            read_text(&p, "blob.bin", 1, None).unwrap(),
            "[blob.bin is a binary file (2,005 bytes); not shown. Use the shell (for example `file` or `xxd | head`) to inspect it.]"
        );
        // Latin-1 text without NUL bytes still decodes as before.
        let t = d.path().join("latin.txt");
        std::fs::write(&t, b"caf\xe9\n").unwrap();
        assert_eq!(read_text(&t, "latin.txt", 1, None).unwrap(), "café\n");
    }
}
