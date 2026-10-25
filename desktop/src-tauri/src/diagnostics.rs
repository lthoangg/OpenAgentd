//! Help → "Export Diagnostics…": copies the desktop and backend logs, plus a
//! short `about.txt`, into a folder under Downloads that the user can attach
//! to a bug report.
//!
//! The backend log records shell-tool commands and provider requests, which
//! can carry the user's own API keys and tokens, so every copied line goes
//! through [`redact_secrets`] first. Redaction is best-effort; `about.txt`
//! asks the user to look the files over before sharing them.

use std::io;
use std::path::{Path, PathBuf};

pub(crate) const REDACTED: &str = "[REDACTED]";

/// Line-by-line so a quoted value never runs past its own line.
pub(crate) fn redact_secrets(text: &str) -> String {
    text.split_inclusive('\n').map(redact_line).collect()
}

/// Prefixes of provider keys that also show up bare, outside any
/// `name=value` pair (pasted into a command, echoed in an error).
const KEY_PREFIXES: &[&str] = &[
    "sk-",
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "ghr_",
    "github_pat_",
    "glpat-",
    "xoxb-",
    "xoxp-",
    "AKIA",
    "AIza",
];
/// A bare prefix match only counts when this many key characters follow,
/// so ordinary words such as `sk-learn` stay readable.
const BARE_KEY_MIN_TAIL: usize = 16;

fn redact_line(line: &str) -> String {
    let bytes = line.as_bytes();
    let mut out = String::with_capacity(line.len());
    // `copied` and `pos` only ever stop on ASCII bytes, so slicing is
    // always on a char boundary.
    let mut copied = 0;
    let mut pos = 0;
    while pos < bytes.len() {
        let span = match bytes[pos] {
            b'=' | b':' => assigned_secret(line, pos),
            _ if starts_word(bytes, pos) => {
                auth_scheme_secret(bytes, pos).or_else(|| bare_key(line, pos))
            }
            _ => None,
        };
        match span {
            Some((start, end)) => {
                out.push_str(&line[copied..start]);
                out.push_str(REDACTED);
                copied = end;
                pos = end;
            }
            None => pos += 1,
        }
    }
    out.push_str(&line[copied..]);
    out
}

fn is_name_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.')
}

fn starts_word(bytes: &[u8], pos: usize) -> bool {
    bytes[pos].is_ascii_alphabetic() && (pos == 0 || !is_name_byte(bytes[pos - 1]))
}

fn is_line_end(b: u8) -> bool {
    matches!(b, b'\n' | b'\r')
}

/// `NAME=value`, `NAME: value`, `"NAME": "value"` where NAME names a secret.
/// Returns the byte span of the value, or `None` when it is empty.
fn assigned_secret(line: &str, sep: usize) -> Option<(usize, usize)> {
    let bytes = line.as_bytes();
    let mut name_end = sep;
    if name_end > 0 && matches!(bytes[name_end - 1], b'"' | b'\'') {
        name_end -= 1;
    }
    let mut name_start = name_end;
    while name_start > 0 && is_name_byte(bytes[name_start - 1]) {
        name_start -= 1;
    }
    if name_start == name_end || !is_secret_name(&line[name_start..name_end]) {
        return None;
    }
    let mut start = sep + 1;
    // `PASSWORD= next` is an empty assignment, but JSON and YAML put a
    // space after the colon.
    if bytes[sep] == b':' {
        while start < bytes.len() && bytes[start] == b' ' {
            start += 1;
        }
    }
    let end = if start < bytes.len() && matches!(bytes[start], b'"' | b'\'') {
        let quote = bytes[start];
        start += 1;
        (start..bytes.len())
            .find(|&i| bytes[i] == quote || is_line_end(bytes[i]))
            .unwrap_or(bytes.len())
    } else {
        (start..bytes.len())
            .find(|&i| {
                let b = bytes[i];
                b.is_ascii_whitespace()
                    || matches!(
                        b,
                        b'&' | b',' | b';' | b'"' | b'\'' | b')' | b']' | b'}' | b'<' | b'>'
                    )
            })
            .unwrap_or(bytes.len())
    };
    (end > start).then_some((start, end))
}

/// True when the last word of NAME (split on `_`, `-`, `.` and camelCase)
/// is a secret word: `OPENAI_API_KEY`, `accessToken`, `client_secret`.
/// `max_tokens` and `monkey` do not match.
fn is_secret_name(name: &str) -> bool {
    let last = name.rsplit(['_', '-', '.']).next().unwrap_or(name);
    let b = last.as_bytes();
    let start = (1..b.len())
        .rev()
        .find(|&i| b[i].is_ascii_uppercase() && b[i - 1].is_ascii_lowercase())
        .unwrap_or(0);
    matches!(
        last[start..].to_ascii_lowercase().as_str(),
        "token" | "key" | "apikey" | "secret" | "password" | "passwd"
    )
}

/// The credential after `Bearer `. (`Basic ` is left alone: it is too
/// common in ordinary prose to redact the word after it.)
fn auth_scheme_secret(bytes: &[u8], pos: usize) -> Option<(usize, usize)> {
    const SCHEME: &[u8] = b"bearer ";
    if bytes.len() < pos + SCHEME.len()
        || !bytes[pos..pos + SCHEME.len()].eq_ignore_ascii_case(SCHEME)
    {
        return None;
    }
    let start = pos + SCHEME.len();
    let end = (start..bytes.len())
        .find(|&i| bytes[i].is_ascii_whitespace() || matches!(bytes[i], b'"' | b'\'' | b','))
        .unwrap_or(bytes.len());
    (end > start).then_some((start, end))
}

/// A bare provider key such as `sk-…`; the prefix stays so the reader can
/// still tell which provider it belonged to.
fn bare_key(line: &str, pos: usize) -> Option<(usize, usize)> {
    let bytes = line.as_bytes();
    let prefix = KEY_PREFIXES.iter().find(|p| line[pos..].starts_with(*p))?;
    let start = pos + prefix.len();
    let end = (start..bytes.len())
        .find(|&i| !(bytes[i].is_ascii_alphanumeric() || matches!(bytes[i], b'_' | b'-')))
        .unwrap_or(bytes.len());
    (end - start >= BARE_KEY_MIN_TAIL).then_some((start, end))
}

/// Desktop logs rotate to `desktop_<time>.log`, backend logs to
/// `backend.log.<n>`.
fn is_exported_log(file_name: &str) -> bool {
    (file_name.starts_with("desktop") || file_name.starts_with("backend"))
        && file_name.contains(".log")
}

/// Writes `about` and redacted copies of the logs in `log_dir` into a new
/// folder under `dest_root`, and returns that folder.
pub(crate) fn export_to(
    log_dir: &Path,
    dest_root: &Path,
    about: &str,
    stamp: &str,
) -> io::Result<PathBuf> {
    let folder = dest_root.join(format!("OpenAgentd Diagnostics {stamp}"));
    std::fs::create_dir_all(&folder)?;
    let entries = match std::fs::read_dir(log_dir) {
        Ok(entries) => entries.collect::<io::Result<Vec<_>>>()?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(e),
    };
    for entry in entries {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !is_exported_log(name) || !entry.file_type()?.is_file() {
            continue;
        }
        let raw = std::fs::read(entry.path())?;
        std::fs::write(
            folder.join(name),
            redact_secrets(&String::from_utf8_lossy(&raw)),
        )?;
    }
    std::fs::write(folder.join("about.txt"), about)?;
    Ok(folder)
}

pub(crate) fn about_text(version: &str, identifier: &str, exported_at: &str) -> String {
    format!(
        "OpenAgentd Diagnostics\n\
         Version: {version}\n\
         Identifier: {identifier}\n\
         OS: {} ({})\n\
         Exported: {exported_at}\n\
         \n\
         Values that look like API keys, tokens and passwords were replaced with {REDACTED}.\n\
         This is best-effort: please look the logs over before sharing them.\n",
        std::env::consts::OS,
        std::env::consts::ARCH,
    )
}

/// Help menu entry point. Runs the file copy off the main thread, then
/// reveals the folder; a failure is shown in a dialog rather than only logged.
pub fn export_from_menu(app: &tauri::AppHandle) {
    use tauri::Manager;
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    use tauri_plugin_opener::OpenerExt;

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let now = time::OffsetDateTime::now_utc();
        let stamp = format!(
            "{:04}{:02}{:02}-{:02}{:02}{:02}",
            now.year(),
            u8::from(now.month()),
            now.day(),
            now.hour(),
            now.minute(),
            now.second()
        );
        let exported_at = format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:{:02} UTC",
            now.year(),
            u8::from(now.month()),
            now.day(),
            now.hour(),
            now.minute(),
            now.second()
        );
        let about = about_text(
            env!("CARGO_PKG_VERSION"),
            &app.config().identifier,
            &exported_at,
        );
        let paths = app.path().app_log_dir().and_then(|logs| {
            let dest = app
                .path()
                .download_dir()
                .or_else(|_| app.path().home_dir())?;
            Ok((logs, dest))
        });
        let result = match paths {
            Ok((logs, dest)) => tauri::async_runtime::spawn_blocking(move || {
                export_to(&logs, &dest, &about, &stamp)
            })
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r.map_err(|e| e.to_string())),
            Err(e) => Err(e.to_string()),
        };
        match result {
            Ok(folder) => {
                log::info!("diagnostics_exported path={}", folder.display());
                if let Err(e) = app.opener().reveal_item_in_dir(&folder) {
                    log::warn!("failed to reveal diagnostics {}: {e}", folder.display());
                }
            }
            Err(e) => {
                log::warn!("diagnostics_export_failed error={e}");
                app.dialog()
                    .message(format!(
                        "OpenAgentd could not save the diagnostics folder.\n\n{e}"
                    ))
                    .title("Export Diagnostics")
                    .kind(MessageDialogKind::Error)
                    .show(|_| {});
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_bearer_tokens() {
        assert_eq!(
            redact_secrets("GET /api authorization: Bearer abc.def-123 ok"),
            "GET /api authorization: Bearer [REDACTED] ok"
        );
    }

    #[test]
    fn redacts_secret_query_parameters_and_keeps_the_rest() {
        assert_eq!(
            redact_secrets("GET https://x.dev/sse?session=42&access_token=s3cr3t&page=2"),
            "GET https://x.dev/sse?session=42&access_token=[REDACTED]&page=2"
        );
    }

    #[test]
    fn redacts_env_style_assignments() {
        assert_eq!(
            redact_secrets("$ OPENAI_API_KEY=sk-abc123 GITHUB_TOKEN='ghx' DB_PASSWORD=\"p w\" run"),
            "$ OPENAI_API_KEY=[REDACTED] GITHUB_TOKEN='[REDACTED]' DB_PASSWORD=\"[REDACTED]\" run"
        );
    }

    #[test]
    fn redacts_json_and_camel_case_fields() {
        assert_eq!(
            redact_secrets(
                r#"{"apiKey": "k1", "accessToken":"t1", "client_secret": "c1", "name": "n"}"#
            ),
            r#"{"apiKey": "[REDACTED]", "accessToken":"[REDACTED]", "client_secret": "[REDACTED]", "name": "n"}"#
        );
    }

    #[test]
    fn keeps_fields_that_only_look_like_secrets() {
        let line = "max_tokens=4096 monkey=1 keyboard: us tokens: 12 http://localhost:5173 a::key";
        assert_eq!(redact_secrets(line), line);
    }

    #[test]
    fn keeps_empty_secret_values() {
        let line = "TOKEN='' KEY=\"\" PASSWORD= done";
        assert_eq!(redact_secrets(line), line);
    }

    #[test]
    fn redacts_bare_provider_keys_but_keeps_their_prefix() {
        assert_eq!(
            redact_secrets("using sk-proj-AbCdEf0123456789xyz and ghp_0123456789abcdefABCD now"),
            "using sk-[REDACTED] and ghp_[REDACTED] now"
        );
        assert_eq!(
            redact_secrets("pip install sk-learn"),
            "pip install sk-learn"
        );
    }

    #[test]
    fn keeps_line_breaks_and_non_ascii_text() {
        assert_eq!(
            redact_secrets("xin chào token=abc\nnext \"line\" é\r\n"),
            "xin chào token=[REDACTED]\nnext \"line\" é\r\n"
        );
    }

    #[test]
    fn a_quoted_value_does_not_run_past_its_line() {
        assert_eq!(
            redact_secrets("secret=\"unterminated\nnext line"),
            "secret=\"[REDACTED]\nnext line"
        );
    }

    #[test]
    fn export_copies_redacted_logs_and_skips_other_files() {
        let logs = tempfile::tempdir().unwrap();
        let downloads = tempfile::tempdir().unwrap();
        std::fs::write(logs.path().join("desktop.log"), "start token=abc\n").unwrap();
        std::fs::write(logs.path().join("desktop_2026-10-25_10-00-00.log"), "old\n").unwrap();
        std::fs::write(logs.path().join("backend.log"), "$ export API_KEY=xyz\n").unwrap();
        std::fs::write(logs.path().join("backend.log.1"), "rotated\n").unwrap();
        std::fs::write(logs.path().join("notes.txt"), "private\n").unwrap();

        let folder = export_to(
            logs.path(),
            downloads.path(),
            "about me\n",
            "20261025-160458",
        )
        .unwrap();

        assert_eq!(
            folder,
            downloads
                .path()
                .join("OpenAgentd Diagnostics 20261025-160458")
        );
        let read = |name: &str| std::fs::read_to_string(folder.join(name)).unwrap();
        assert_eq!(read("desktop.log"), "start token=[REDACTED]\n");
        assert_eq!(read("desktop_2026-10-25_10-00-00.log"), "old\n");
        assert_eq!(read("backend.log"), "$ export API_KEY=[REDACTED]\n");
        assert_eq!(read("backend.log.1"), "rotated\n");
        assert_eq!(read("about.txt"), "about me\n");
        assert!(!folder.join("notes.txt").exists());
    }

    #[test]
    fn export_works_when_the_log_folder_is_missing() {
        let downloads = tempfile::tempdir().unwrap();
        let missing = downloads.path().join("no-logs-yet");

        let folder = export_to(&missing, downloads.path(), "about\n", "s").unwrap();

        assert_eq!(
            std::fs::read_to_string(folder.join("about.txt")).unwrap(),
            "about\n"
        );
    }

    #[test]
    fn about_names_the_version_and_platform_and_warns_to_review() {
        let about = about_text("3.31.0", "dev.openagentd.app", "2026-10-25 16:04:58 UTC");
        assert!(about.contains("Version: 3.31.0"));
        assert!(about.contains(&format!(
            "OS: {} ({})",
            std::env::consts::OS,
            std::env::consts::ARCH
        )));
        assert!(about.contains("look the logs over before sharing"));
    }
}
