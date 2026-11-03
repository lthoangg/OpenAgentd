//! Where a plugin comes from, and how its files are staged: a local folder
//! or a git URL, copied or cloned next to the installed plugins.

use super::render::{exact, inline};
use crate::ui::dim;
use anyhow::{anyhow, bail, Context, Result};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

/// Longest `git clone` may run before it is stopped.
const CLONE_TIMEOUT: Duration = Duration::from_secs(300);
/// Set by an enclosing git hook, and would send `git clone` somewhere else.
const GIT_ENV_RESET: [&str; 7] = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_PREFIX"];

// ── showing paths and URLs ──────────────────────────────────────────────────

/// A path for a message: its text exactly, with escapes shown.
pub(super) fn pth(p: &Path) -> String {
    exact(&p.to_string_lossy())
}

/// `url` without the user information of a `scheme://user:secret@host` URL
/// (a token in a URL must not be echoed). `ssh://user@host` keeps its user,
/// which is no secret.
fn redact(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else { return url.to_string() };
    let (authority, tail) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
    match authority.rsplit_once('@') {
        Some((userinfo, host)) if !scheme.eq_ignore_ascii_case("ssh") || userinfo.contains(':') => format!("{scheme}://{host}{tail}"),
        _ => url.to_string(),
    }
}

// ── sources ─────────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Source {
    Folder(PathBuf),
    Git(String),
}

/// `user@host:path`: git's short form of an ssh URL.
fn is_scp_like(s: &str) -> bool {
    let Some((user_host, path)) = s.split_once(':') else { return false };
    let Some((user, host)) = user_host.split_once('@') else { return false };
    let word = |w: &str, extra: &str| !w.is_empty() && w.chars().all(|c| c.is_ascii_alphanumeric() || extra.contains(c));
    !path.is_empty() && word(user, "._-+") && word(host, "._-") && !host.starts_with('-')
}

/// Where `source` points: an existing folder, or a git URL of a kind that is
/// accepted (`https://`, `ssh://`, `user@host:path`, `file://`). Everything
/// else is refused with the reason: remote helpers (`ext::`, `fd::`), plain
/// `http://` and `git://`, and anything that starts with `-`.
pub(super) fn parse_source(source: &str) -> Result<Source, String> {
    let shown = || exact(&redact(source));
    if source.is_empty() {
        return Err("the source is empty".to_string());
    }
    if source.starts_with('-') {
        return Err(format!("{} is not accepted: a source must not start with '-'", shown()));
    }
    if source.chars().any(char::is_control) {
        return Err("the source holds a control character".to_string());
    }
    let path = Path::new(source);
    if path.is_dir() {
        return Ok(Source::Folder(path.to_path_buf()));
    }
    // `transport::address`, a remote helper such as `ext::sh -c ...`.
    if let Some((helper, _)) = source.split_once("::") {
        if !helper.is_empty() && helper.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c)) {
            return Err(format!("{helper}:: remote helpers are not accepted; use https://, ssh://, user@host:path or file://"));
        }
    }
    let accepted = "use https://, ssh://, user@host:path or file://";
    match source.split_once("://") {
        Some((scheme, rest)) => {
            let host = rest.split('/').next().unwrap_or("").rsplit('@').next().unwrap_or("");
            match scheme.to_ascii_lowercase().as_str() {
                "file" if !rest.is_empty() => Ok(Source::Git(source.to_string())),
                "https" | "ssh" if !host.is_empty() && !host.starts_with('-') => Ok(Source::Git(source.to_string())),
                "https" | "ssh" if host.starts_with('-') => Err(format!("{} is not accepted: a host must not start with '-'", shown())),
                "file" | "https" | "ssh" => Err(format!("{} has no usable host or path", shown())),
                "http" => Err(format!("plain http:// URLs are not accepted; {accepted}")),
                other if other.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c)) => Err(format!("{other}:// URLs are not accepted; {accepted}")),
                _ => Err(format!("{} is not accepted; {accepted}", shown())),
            }
        }
        None if is_scp_like(source) => Ok(Source::Git(source.to_string())),
        None if path.exists() => Err(format!("{} is not a folder", shown())),
        None => Err(format!("{} is not a folder or a git URL; {accepted}", shown())),
    }
}

// ── staging ─────────────────────────────────────────────────────────────────

/// `sub` inside `base` (a canonical folder): the canonical subfolder.
fn select_subfolder(base: &Path, sub: &Path) -> Result<PathBuf> {
    if sub.as_os_str().is_empty() {
        bail!("--path is empty");
    }
    let leaves = || anyhow!("--path {} leaves the source folder; it must name a folder inside it", exact(&sub.to_string_lossy()));
    if climbs_out(sub) {
        return Err(leaves());
    }
    let real = dunce::canonicalize(base.join(sub)).map_err(|_| anyhow!("--path {} does not exist in the source", exact(&sub.to_string_lossy())))?;
    // Links inside the source can still lead out of it.
    if !real.starts_with(base) {
        return Err(leaves());
    }
    if !real.is_dir() {
        bail!("--path {} is not a folder", exact(&sub.to_string_lossy()));
    }
    Ok(real)
}

/// Whether `sub`, joined to a folder, would leave it by its own text: it is
/// absolute, or has more `..` than names before them.
fn climbs_out(sub: &Path) -> bool {
    let mut depth = 0i32;
    for part in sub.components() {
        match part {
            Component::Normal(_) => depth += 1,
            Component::ParentDir => {
                depth -= 1;
                if depth < 0 {
                    return true;
                }
            }
            Component::RootDir | Component::Prefix(_) => return true,
            Component::CurDir => {}
        }
    }
    false
}

fn has_manifest(folder: &Path) -> bool {
    folder.join("plugin.json").is_file()
}

/// A link copied as a link (on Windows, of the kind it points to).
fn copy_link(from: &Path, to: &Path) -> Result<()> {
    let target = std::fs::read_link(from).with_context(|| format!("read the link {}", pth(from)))?;
    #[cfg(unix)]
    std::os::unix::fs::symlink(&target, to).with_context(|| format!("copy the link {}", pth(from)))?;
    #[cfg(windows)]
    {
        let made = if from.is_dir() { std::os::windows::fs::symlink_dir(&target, to) } else { std::os::windows::fs::symlink_file(&target, to) };
        made.with_context(|| format!("copy the link {}", pth(from)))?;
    }
    Ok(())
}

/// Copies the folder `from` to `to` (which must not exist), leaving out
/// `.git` and `node_modules` at any depth, and `skip` (the staging folder,
/// when the source holds the plugins folder). Links are copied as links and
/// checked afterwards by [`check_links`]; anything that is not a file, folder
/// or link is refused (copying a FIFO would block).
fn copy_tree(from: &Path, to: &Path, skip: &Path) -> Result<()> {
    std::fs::create_dir(to).with_context(|| format!("create {}", pth(to)))?;
    let mut stack = vec![(from.to_path_buf(), to.to_path_buf())];
    while let Some((src_dir, dst_dir)) = stack.pop() {
        for entry in std::fs::read_dir(&src_dir).with_context(|| format!("read {}", pth(&src_dir)))? {
            let entry = entry?;
            let name = entry.file_name();
            let src = entry.path();
            if name == ".git" || name == "node_modules" || src == skip {
                continue;
            }
            let dst = dst_dir.join(&name);
            let kind = entry.file_type()?;
            if kind.is_dir() {
                std::fs::create_dir(&dst).with_context(|| format!("create {}", pth(&dst)))?;
                stack.push((src, dst));
            } else if kind.is_symlink() {
                copy_link(&src, &dst)?;
            } else if kind.is_file() {
                std::fs::copy(&src, &dst).with_context(|| format!("copy {}", pth(&src)))?;
            } else {
                bail!("{} is not a regular file, folder or link; refusing to copy it", pth(&src));
            }
        }
    }
    Ok(())
}

/// Refuses a plugin folder (`root`, canonical) that holds a link leading
/// outside it, or one that cannot be followed: such a link would make the
/// installed plugin read files that were never part of it.
pub(super) fn check_links(root: &Path) -> Result<()> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).with_context(|| format!("read {}", pth(&dir)))? {
            let entry = entry?;
            let path = entry.path();
            let kind = entry.file_type()?;
            if kind.is_dir() {
                stack.push(path);
            } else if kind.is_symlink() {
                let shown = exact(&path.strip_prefix(root).unwrap_or(&path).to_string_lossy());
                match dunce::canonicalize(&path) {
                    Ok(real) if real.starts_with(root) => {}
                    Ok(real) => bail!("{shown} is a link to {}, outside the plugin folder; refusing to install it", exact(&real.to_string_lossy())),
                    Err(_) => bail!("{shown} is a link that cannot be followed; refusing to install it"),
                }
            }
        }
    }
    Ok(())
}

/// The last lines git wrote, with the URL as it was given replaced by its
/// redacted form.
fn git_failure(log: &str, url: &str) -> String {
    let lines: Vec<&str> = log.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let tail = lines[lines.len().saturating_sub(3)..].join(" ");
    let shown = redact(url);
    inline(&tail.replace(url, &shown), 400)
}

/// `git clone --depth 1` of `url` into `dest`. The transports are pinned to
/// the accepted kinds, nothing may prompt, and a clone that does not finish
/// is stopped.
fn git_clone(url: &str, dest: &Path, workdir: &Path) -> Result<()> {
    let log_path = workdir.join("git.log");
    let log = std::fs::File::create(&log_path).context("create the git log")?;
    let mut cmd = std::process::Command::new("git");
    appv3_core::proctree::hide_window_std(&mut cmd);
    cmd.args(["clone", "--depth", "1", "--quiet", "--", url])
        .arg(dest)
        .current_dir(workdir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ALLOW_PROTOCOL", "https:ssh:file")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log);
    // A hook of the user's git may run here; it needs neither a git context
    // from an enclosing hook nor the server's access key.
    for var in GIT_ENV_RESET.iter().chain(appv3_core::auth::CHILD_ENV_SECRETS.iter()) {
        cmd.env_remove(var);
    }
    let mut child = cmd.spawn().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => anyhow!("git is not installed (or not on PATH); it is needed to add a plugin from a git URL"),
        _ => anyhow!("cannot run git: {e}"),
    })?;
    let deadline = Instant::now() + CLONE_TIMEOUT;
    let status = loop {
        if let Some(status) = child.try_wait().context("wait for git")? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!("git did not finish fetching {} within {} minutes", exact(&redact(url)), CLONE_TIMEOUT.as_secs() / 60);
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    if !status.success() {
        let why = git_failure(&std::fs::read_to_string(&log_path).unwrap_or_default(), url);
        bail!("git could not fetch {}: {}", exact(&redact(url)), if why.is_empty() { status.to_string() } else { why });
    }
    Ok(())
}

/// Puts the plugin's files into `stage` and returns the plugin folder
/// (canonical, inside `stage`): a copy of a local folder, or a shallow
/// clone without its `.git`; then `sub` when given.
pub(super) fn stage_source(source: &Source, sub: Option<&Path>, stage: &Path) -> Result<PathBuf> {
    let target = stage.join("src");
    match source {
        Source::Folder(dir) => {
            let base = dunce::canonicalize(dir).with_context(|| format!("open {}", pth(dir)))?;
            // Only the plugin's own folder is copied.
            let from = match sub {
                Some(sub) => select_subfolder(&base, sub)?,
                None => base,
            };
            if !has_manifest(&from) {
                bail!("{} has no plugin.json", exact(&from.to_string_lossy()));
            }
            copy_tree(&from, &target, stage)?;
            Ok(target)
        }
        Source::Git(url) => {
            println!();
            println!("  {}", dim(&format!("Fetching {} ...", exact(&redact(url)))));
            git_clone(url, &target, stage)?;
            // The history is not part of the plugin (and `.git` may be a file).
            let git_dir = target.join(".git");
            if std::fs::symlink_metadata(&git_dir).is_ok_and(|m| m.is_dir()) {
                std::fs::remove_dir_all(&git_dir).context("remove the clone's .git")?;
            } else if git_dir.exists() {
                std::fs::remove_file(&git_dir).context("remove the clone's .git")?;
            }
            let base = dunce::canonicalize(&target)?;
            match sub {
                Some(sub) => select_subfolder(&base, sub),
                None => Ok(base),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cmd::plugin::testing::put;

    #[test]
    fn a_path_in_a_message_shows_its_escapes() {
        assert_eq!(pth(Path::new("/a/b\u{1b}c")), r"/a/b\u{1b}c");
    }

    #[test]
    fn urls_lose_their_credentials() {
        assert_eq!(redact("https://tok@github.com/acme/x.git"), "https://github.com/acme/x.git");
        assert_eq!(redact("https://user:secret@example.com/x"), "https://example.com/x");
        assert_eq!(redact("https://example.com/x"), "https://example.com/x");
        assert_eq!(redact("ssh://git@github.com/acme/x.git"), "ssh://git@github.com/acme/x.git");
        assert_eq!(redact("ssh://git:pw@host/x"), "ssh://host/x");
        assert_eq!(redact("git@github.com:acme/x.git"), "git@github.com:acme/x.git");
        assert_eq!(redact("file:///tmp/x"), "file:///tmp/x");
        let log = "Cloning...\nfatal: unable to access 'https://tok@h.example/x.git/': Could not resolve host\n";
        let why = git_failure(log, "https://tok@h.example/x.git/");
        assert!(why.contains("https://h.example/x.git/") && !why.contains("tok"), "{why}");
    }

    #[test]
    fn only_folders_and_the_accepted_git_urls_are_sources() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(parse_source(dir.path().to_str().unwrap()), Ok(Source::Folder(dir.path().to_path_buf())));
        for ok in [
            "https://github.com/acme/tools.git",
            "HTTPS://github.com/acme/tools",
            "https://user:tok@example.com/x.git",
            "ssh://git@github.com/acme/tools.git",
            "git@github.com:acme/tools.git",
            "file:///tmp/some/repo",
        ] {
            assert_eq!(parse_source(ok), Ok(Source::Git(ok.to_string())), "{ok}");
        }
        for (bad, why) in [
            ("", "empty"),
            ("ext::sh -c touch /tmp/x", "ext:: remote helpers"),
            ("fd::17", "fd:: remote helpers"),
            ("http://example.com/x.git", "plain http://"),
            ("git://example.com/x.git", "git:// URLs"),
            ("ftp://example.com/x", "ftp:// URLs"),
            ("-oProxyCommand=touch /tmp/x", "must not start with '-'"),
            ("--upload-pack=touch /tmp/x", "must not start with '-'"),
            ("ssh://-oProxyCommand=touch/x", "host must not start with '-'"),
            ("https://-evil/x", "host must not start with '-'"),
            ("u@-oProxyCommand=touch:x", "not a folder or a git URL"),
            ("https://", "no usable host"),
            ("file://", "no usable host"),
            ("just-a-name", "not a folder or a git URL"),
            ("with\nnewline", "control character"),
        ] {
            let e = parse_source(bad).expect_err(bad);
            assert!(e.contains(why), "{bad:?}: {e}");
        }
        // A file is not a folder.
        let file = dir.path().join("file.txt");
        std::fs::write(&file, "x").unwrap();
        assert!(parse_source(file.to_str().unwrap()).unwrap_err().contains("is not a folder"));
        // The refusal never echoes a token.
        assert!(!parse_source("ext::https://tok@h/x").unwrap_err().contains("tok"));
        assert!(!parse_source("ftp://tok@h/x").unwrap_err().contains("tok"));
    }

    #[test]
    fn a_subfolder_stays_inside_the_source() {
        let d = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(d.path()).unwrap();
        std::fs::create_dir_all(base.join("a/b")).unwrap();
        std::fs::write(base.join("file"), "").unwrap();
        let pick = |p: &str| select_subfolder(&base, Path::new(p));
        assert_eq!(pick("a/b").unwrap(), base.join("a/b"));
        assert_eq!(pick("a/../a/b").unwrap(), base.join("a/b"));
        assert_eq!(pick(".").unwrap(), base);
        for escape in ["..", "../x", "a/../../x", "a/b/../../..", "/etc", "/"] {
            assert!(pick(escape).unwrap_err().to_string().contains("leaves the source folder"), "{escape}");
        }
        assert!(pick("nope").unwrap_err().to_string().contains("does not exist"));
        assert!(pick("file").unwrap_err().to_string().contains("is not a folder"));
        assert!(pick("").unwrap_err().to_string().contains("is empty"));
        assert!(climbs_out(Path::new("../a")) && climbs_out(Path::new("a/../..")) && !climbs_out(Path::new("a/../b")) && !climbs_out(Path::new("./a")));
    }

    #[cfg(unix)]
    #[test]
    fn a_link_cannot_carry_a_subfolder_out_of_the_source() {
        let d = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(d.path()).unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), base.join("out")).unwrap();
        let e = select_subfolder(&base, Path::new("out")).unwrap_err().to_string();
        assert!(e.contains("leaves the source folder"), "{e}");
    }

    #[test]
    fn copying_leaves_out_git_and_node_modules() {
        let d = tempfile::tempdir().unwrap();
        let src = dunce::canonicalize(d.path()).unwrap().join("src");
        for (rel, body) in [
            ("plugin.json", "{}"),
            ("skills/x/SKILL.md", "s"),
            (".git/config", "g"),
            ("node_modules/pkg/index.js", "n"),
            ("deep/node_modules/y", "n"),
            ("deep/.git", "gitlink: elsewhere"),
            ("deep/keep.txt", "k"),
            ("bin/run", "#!/bin/sh\n"),
            ("staging/inside.txt", "s"),
        ] {
            put(&src, rel, body);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(src.join("bin/run"), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let dst = d.path().join("dst");
        copy_tree(&src, &dst, &src.join("staging")).unwrap();
        let mut copied: Vec<String> = vec![];
        let mut stack = vec![dst.clone()];
        while let Some(dir) = stack.pop() {
            for e in std::fs::read_dir(dir).unwrap().flatten() {
                let rel = e.path().strip_prefix(&dst).unwrap().to_string_lossy().replace('\\', "/");
                if e.file_type().unwrap().is_dir() {
                    stack.push(e.path());
                }
                copied.push(rel);
            }
        }
        copied.sort();
        assert_eq!(copied, ["bin", "bin/run", "deep", "deep/keep.txt", "plugin.json", "skills", "skills/x", "skills/x/SKILL.md"]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_ne!(std::fs::metadata(dst.join("bin/run")).unwrap().permissions().mode() & 0o111, 0, "the executable bit is kept");
        }
    }

    #[cfg(unix)]
    #[test]
    fn links_are_copied_as_links_when_they_stay_inside() {
        let d = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(d.path()).unwrap();
        let src = base.join("src");
        put(&src, "skills/real/SKILL.md", "s");
        std::os::unix::fs::symlink("real", src.join("skills/alias")).unwrap();
        let dst = base.join("dst");
        copy_tree(&src, &dst, &base.join("none")).unwrap();
        assert_eq!(std::fs::read_link(dst.join("skills/alias")).unwrap(), Path::new("real"));
        check_links(&dst).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_link_out_of_the_plugin_is_refused() {
        let d = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(d.path()).unwrap();
        let secret = base.join("secret.txt");
        std::fs::write(&secret, "s").unwrap();
        for (name, target, why) in [("escape", secret.clone(), "outside the plugin folder"), ("gone", base.join("missing"), "cannot be followed")] {
            let root = base.join(format!("plugin-{name}"));
            put(&root, "plugin.json", "{}");
            std::os::unix::fs::symlink(&target, root.join("skills-link")).unwrap();
            let e = check_links(&root).unwrap_err().to_string();
            assert!(e.contains("skills-link") && e.contains(why), "{e}");
            // Copying a source that holds one carries the link over, and the check then refuses it.
            let staged = base.join(format!("staged-{name}"));
            copy_tree(&root, &staged, &base.join("none")).unwrap();
            assert!(check_links(&staged).is_err());
        }
        // A link to a folder inside is fine even when it is absolute.
        let ok = base.join("plugin-ok");
        put(&ok, "a/file", "f");
        std::os::unix::fs::symlink(ok.join("a"), ok.join("b")).unwrap();
        check_links(&ok).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_is_refused_not_opened() {
        let d = tempfile::tempdir().unwrap();
        let src = d.path().join("src");
        put(&src, "plugin.json", "{}");
        let fifo = std::ffi::CString::new(src.join("pipe").to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o644) }, 0);
        let e = copy_tree(&src, &d.path().join("dst"), &d.path().join("none")).unwrap_err().to_string();
        assert!(e.contains("is not a regular file, folder or link"), "{e}");
    }
}
