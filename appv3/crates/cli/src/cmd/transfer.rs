//! `agentd transfer export|import`.

use crate::cli::{ExportArgs, ImportArgs};
use crate::ui::{self, bold, dim, green, tilde, Table};
use anyhow::{anyhow, bail, Context, Result};
use appv3_core::pyyaml::{safe_dump_py, safe_load_py, Py};
use std::path::{Component, Path, PathBuf};

const ARCHIVE_ROOT: &str = "openagentd-export";
const TREE_DIRS: &[&str] = &["agents", "skills", "commands", "plugins"];
const ROOT_FILES: &[&str] = &["mcp.json", "settings.yaml", "server.yaml", "multimodal.yaml", ".env", appv3_core::credentials::FILE_NAME];
/// Root files holding secrets: written owner-only on import.
const SECRET_FILES: &[&str] = &[".env", appv3_core::credentials::FILE_NAME];

/// A leading `~` as the home directory.
fn expanduser(p: &Path) -> PathBuf {
    match (p.strip_prefix("~"), appv3_core::home::home_dir_opt()) {
        (Ok(rest), Some(home)) => home.join(rest),
        _ => p.to_path_buf(),
    }
}

/// Absolute, with symlinks resolved as far as the path exists.
fn resolve(p: &Path) -> PathBuf {
    let abs = if p.is_absolute() { p.to_path_buf() } else { std::env::current_dir().unwrap_or_default().join(p) };
    appv3_tools::denied::resolve(&abs)
}

fn config_dir(arg: Option<&Path>) -> PathBuf {
    arg.filter(|p| !p.as_os_str().is_empty()).map(expanduser).unwrap_or_else(|| appv3_core::settings().config_dir.clone())
}

fn read_text(p: &Path) -> Result<String> {
    Ok(std::fs::read_to_string(p).with_context(|| format!("read {}", p.display()))?.replace("\r\n", "\n"))
}

// ── export ──────────────────────────────────────────────────────────────────

/// Blank the values of secret-looking `.env` keys, keeping line endings.
fn redact_env(content: &str) -> String {
    let re = regex::Regex::new(r"^([A-Z0-9_]*_API_KEY|[A-Z0-9_]*_SECRET(?:_KEY)?|[A-Z0-9_]*_TOKEN|[A-Z0-9_]*_PASSWORD|ACCESS_KEY|AWS_BEARER_TOKEN_BEDROCK)=(.+)$").unwrap();
    content
        .split_inclusive('\n')
        .map(|line| {
            let body = line.trim_end_matches(['\r', '\n']);
            match re.captures(body) {
                Some(m) => format!("{}={}", &m[1], &line[body.len()..]),
                None => line.to_string(),
            }
        })
        .collect()
}

/// `server.yaml` without its `access_key`.
fn redact_server_settings(content: &str) -> Result<String> {
    let raw = safe_load_py(content).map_err(|e| anyhow!("server.yaml is not valid YAML: {}", e.message))?;
    let raw = if raw.truthy() { raw } else { Py::Dict(vec![]) };
    let Py::Dict(mut items) = raw else { bail!("server.yaml must contain a YAML mapping") };
    items.retain(|(k, _)| !matches!(k, Py::Str(s) if s == "access_key"));
    Ok(safe_dump_py(&Py::Dict(items)))
}

/// Every path under `dir`, not following symlinked directories.
fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let is_real_dir = std::fs::symlink_metadata(&p).is_ok_and(|m| m.is_dir());
        out.push(p.clone());
        if is_real_dir {
            walk(&p, out);
        }
    }
}

fn posix_rel(p: &Path, base: &Path) -> String {
    p.strip_prefix(base).unwrap_or(p).components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/")
}

fn export_config(cfg: &Path, output: &Path, include_secrets: bool) -> Result<Vec<String>> {
    let file = std::fs::File::create(output).with_context(|| format!("create {}", output.display()))?;
    // An archive holding credentials.yaml is as private as the file itself.
    #[cfg(unix)]
    if include_secrets {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600)).with_context(|| format!("restrict {}", output.display()))?;
    }
    let gz = flate2::write::GzEncoder::new(file, flate2::Compression::new(9));
    let mut tar = tar::Builder::new(gz);
    tar.follow_symlinks(false);
    let mut packed = vec![];
    for d in TREE_DIRS {
        let src_dir = cfg.join(d);
        if !src_dir.is_dir() {
            continue;
        }
        let mut all = vec![];
        walk(&src_dir, &mut all);
        all.sort();
        for src in all {
            if !src.is_file() || src.components().any(|c| c.as_os_str() == "__pycache__") || src.to_string_lossy().ends_with(".pyc") {
                continue;
            }
            let rel = posix_rel(&src, cfg);
            tar.append_path_with_name(&src, format!("{ARCHIVE_ROOT}/{rel}")).with_context(|| format!("pack {rel}"))?;
            packed.push(rel);
        }
    }
    for f in ROOT_FILES {
        let src = cfg.join(f);
        if !src.is_file() {
            continue;
        }
        let arc = format!("{ARCHIVE_ROOT}/{f}");
        // The credential store is all secrets; without --include-secrets it
        // stays home (a blanked copy would import as broken credentials).
        if *f == appv3_core::credentials::FILE_NAME && !include_secrets {
            continue;
        }
        if (*f == ".env" || *f == "server.yaml") && !include_secrets {
            let raw = read_text(&src)?;
            let red = if *f == ".env" { redact_env(&raw) } else { redact_server_settings(&raw)? };
            let mut h = tar::Header::new_gnu();
            h.set_size(red.len() as u64);
            h.set_mode(0o644);
            h.set_mtime(0);
            h.set_uid(0);
            h.set_gid(0);
            h.set_entry_type(tar::EntryType::Regular);
            tar.append_data(&mut h, &arc, red.as_bytes()).with_context(|| format!("pack {f}"))?;
        } else {
            tar.append_path_with_name(&src, &arc).with_context(|| format!("pack {f}"))?;
        }
        packed.push(f.to_string());
    }
    tar.into_inner()?.finish()?;
    packed.sort();
    Ok(packed)
}

pub fn export(a: &ExportArgs) -> Result<()> {
    let cfg = config_dir(a.config_dir.as_deref());
    let output = match a.output.as_deref().filter(|p| !p.as_os_str().is_empty()) {
        Some(o) => resolve(&expanduser(o)),
        None => {
            let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
            std::env::current_dir()?.join(format!("openagentd-export-{stamp}.tar.gz"))
        }
    };
    ui::header("Export config", &tilde(&cfg));
    if a.include_secrets {
        ui::mark_line(
            &ui::warn_mark(),
            "--include-secrets is set: credentials.yaml (API keys, OAuth logins) and the server access key are stored in plaintext inside the archive. Only move it over a trusted, encrypted channel (e.g. local disk → SCP → remote).",
        );
        println!();
    }
    let packed = export_config(&cfg, &output, a.include_secrets)?;
    ui::mark_line(&ui::ok_mark(), &format!("Packed {} file(s) into {}", packed.len(), bold(&tilde(&output))));
    let mut table = Table::new();
    for f in &packed {
        let sensitive = matches!(f.as_str(), ".env" | "server.yaml" | "credentials.yaml");
        let note = if sensitive && !a.include_secrets { dim("secrets redacted") } else { String::new() };
        table.row([format!("   {}", dim("·")), f.clone(), note]);
    }
    table.print();
    if !a.include_secrets && cfg.join(appv3_core::credentials::FILE_NAME).is_file() {
        ui::hint("     credentials.yaml left out (pass --include-secrets to pack it)");
    }
    println!();
    ui::next("Import it on the other computer:", &format!("agentd transfer import {}", output.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()));
    println!();
    Ok(())
}

// ── import ──────────────────────────────────────────────────────────────────

struct Member {
    name: String,
    data: Vec<u8>,
}

/// Regular-file members of a `.tar.gz`, with their contents.
fn read_archive(path: &Path) -> Result<Vec<Member>> {
    use std::io::Read;
    let file = std::fs::File::open(path)?;
    let mut ar = tar::Archive::new(flate2::read::MultiGzDecoder::new(file));
    let mut out = vec![];
    for e in ar.entries()? {
        let mut e = e?;
        let et = e.header().entry_type();
        if !(et.is_file() || et == tar::EntryType::Continuous) {
            continue;
        }
        let name = String::from_utf8_lossy(&e.path_bytes()).trim_end_matches('/').to_string();
        let mut data = vec![];
        e.read_to_end(&mut data)?;
        out.push(Member { name, data });
    }
    Ok(out)
}

fn import_config(archive: &Path, cfg: &Path, force: bool) -> Result<(Vec<String>, Vec<String>)> {
    if !archive.is_file() {
        bail!("archive not found: {}", archive.display());
    }
    let members = read_archive(archive).map_err(|e| anyhow!("not a valid tar.gz archive: {e:#}"))?;
    let cfg = resolve(cfg);
    if members.is_empty() {
        bail!("not a valid openagentd export — the archive contains no files");
    }
    let prefix = format!("{ARCHIVE_ROOT}/");
    for m in &members {
        if !m.name.starts_with(&prefix) {
            bail!("not a valid openagentd export — unexpected archive root in entry {:?}; expected entries under '{ARCHIVE_ROOT}/'", m.name);
        }
    }
    // Every destination must stay inside the config root, including through
    // symlinks that already exist there.
    for m in &members {
        let rel = &m.name[prefix.len()..];
        if Path::new(rel).components().any(|c| c == Component::ParentDir) || !resolve(&cfg.join(rel)).starts_with(&cfg) {
            bail!("path traversal detected in archive entry {:?}", m.name);
        }
    }
    let (mut written, mut skipped) = (vec![], vec![]);
    for m in members {
        let rel = m.name[prefix.len()..].to_string();
        let target = resolve(&cfg.join(&rel));
        if target.exists() && !force {
            skipped.push(rel);
            continue;
        }
        if let Some(p) = target.parent() {
            std::fs::create_dir_all(p).with_context(|| format!("create {}", p.display()))?;
        }
        if SECRET_FILES.contains(&rel.as_str()) {
            let text = String::from_utf8(m.data).with_context(|| format!("{rel} is not UTF-8"))?;
            if rel == appv3_core::credentials::FILE_NAME {
                appv3_core::credentials::CredentialsFile::parse(&text).map_err(|e| anyhow!("{e}"))?;
            }
            appv3_core::secret_files::write_secret_file(&target, &text).with_context(|| format!("write {}", target.display()))?;
        } else {
            std::fs::write(&target, &m.data).with_context(|| format!("write {}", target.display()))?;
        }
        written.push(rel);
    }
    Ok((written, skipped))
}

pub fn import(a: &ImportArgs) -> Result<()> {
    let cfg = config_dir(a.config_dir.as_deref());
    let archive = resolve(&expanduser(&a.archive));
    ui::header("Import config", &format!("{} → {}", tilde(&archive), tilde(&cfg)));
    let (mut written, mut skipped) = import_config(&archive, &cfg, a.force)?;
    // A legacy archive carries provider keys in its dotenv file: move them
    // into the credential store, as the first server start would.
    if written.iter().any(|f| f == ".env") {
        let src = appv3_providers::credentials_migration::LegacySources {
            dotenv: cfg.join(".env"),
            cache_dir: appv3_core::settings().cache_dir.clone(),
            mcp_json: cfg.join("mcp.json"),
            store: cfg.join(appv3_core::credentials::FILE_NAME),
        };
        let r = appv3_providers::credentials_migration::absorb_dotenv(&src, "Imported").map_err(|e| anyhow!("{e}"))?;
        if !r.is_empty() {
            let names: Vec<String> = r.providers.iter().map(|(p, _)| p.clone()).chain(r.secrets.iter().cloned()).collect();
            ui::mark_line(&ui::ok_mark(), &format!("Moved keys from the archive's .env into credentials.yaml: {}", names.join(", ")));
        }
    }
    if !written.is_empty() {
        ui::mark_line(&ui::ok_mark(), &format!("Wrote {} file(s)", written.len()));
        written.sort();
        for f in &written {
            println!("     {} {f}", green("+"));
        }
    }
    if !skipped.is_empty() {
        ui::mark_line(&ui::idle_mark(), &format!("Skipped {} existing file(s)", skipped.len()));
        skipped.sort();
        for f in &skipped {
            println!("     {} {}", dim("·"), dim(f));
        }
        ui::hint("     Pass --force to overwrite them.");
    }
    println!();
    ui::next("Next:", "agentd server start");
    println!();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_secrets_are_blanked_and_line_endings_kept() {
        let raw = "LOG_LEVEL=INFO\nOPENAI_API_KEY=sk-x\r\nGH_TOKEN=t\nACCESS_KEY=k\n# OPENAI_API_KEY=keep\nAWS_BEARER_TOKEN_BEDROCK=b";
        assert_eq!(redact_env(raw), "LOG_LEVEL=INFO\nOPENAI_API_KEY=\r\nGH_TOKEN=\nACCESS_KEY=\n# OPENAI_API_KEY=keep\nAWS_BEARER_TOKEN_BEDROCK=");
    }

    #[test]
    fn server_yaml_loses_its_access_key() {
        let out = redact_server_settings("host: 0.0.0.0\nport: 4082\naccess_key: secret\n").unwrap();
        assert!(out.contains("host: 0.0.0.0") && out.contains("port: 4082") && !out.contains("secret"), "{out}");
        assert!(redact_server_settings("").unwrap().trim() == "{}");
        assert!(redact_server_settings("- a\n- b\n").is_err());
    }
}
