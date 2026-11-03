//! In-process snapshot engine on `gix` — the default for `track`/`restore`.
//!
//! It produces the same repo layout, index and tree hashes as the git CLI
//! engine in `snapshot.rs` (which v2 uses), so both versions keep sharing
//! snapshot repos:
//! - candidate paths = tracked changes (`diff-files`) + untracked files
//!   honouring the workspace `.gitignore`s and global excludes
//!   (`ls-files --others --exclude-standard`), untracked files over the size
//!   cap skipped;
//! - staging = `git add --all` per path: `.gitattributes` clean filters,
//!   symlinks stored as links, executable bit (kept from the index when
//!   `core.filemode=false`, as on Windows), nested repos as gitlinks;
//! - the index is written without the stale cache-tree extension, so the git
//!   CLI (v2) keeps producing correct trees from it;
//! - `write-tree`, `commit-tree` + `update-ref` for the snapshot ref.
//!
//! No `git` executable is needed. Repack/prune maintenance stays on the CLI.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use gix::bstr::{BStr, BString, ByteSlice};
use gix::index::entry::{Mode, Stage, Stat};
use gix::ObjectId;

pub(crate) type Error = Box<dyn std::error::Error + Send + Sync>;
pub(crate) type Result<T> = std::result::Result<T, Error>;

const USER_EMAIL: &str = "snapshot@openagentd.local";
const USER_NAME: &str = "openagentd-snapshot";

/// Open the snapshot repo with the same per-call overrides the CLI engine
/// passes (`CORE_FLAGS` + `--work-tree`).
pub(crate) fn open(gitdir: &Path, workspace: &Path) -> Result<gix::Repository> {
    let overrides =
        [format!("core.worktree={}", workspace.display()), "core.longpaths=true".into(), "core.symlinks=true".into(), "core.autocrlf=false".into(), "core.fsmonitor=false".into()];
    let opts = gix::open::Options::default().config_overrides(overrides).open_path_as_is(true);
    Ok(gix::open_opts(gitdir, opts)?)
}

/// `git init` with `GIT_DIR`/`GIT_WORK_TREE` plus the snapshot config keys.
pub(crate) fn init(gitdir: &Path, workspace: &Path) -> Result<()> {
    for d in ["objects/info", "objects/pack", "refs/heads", "refs/tags", "info", "hooks"] {
        std::fs::create_dir_all(gitdir.join(d))?;
    }
    let branch = gix::config::File::from_globals()
        .ok()
        .and_then(|f| f.string("init.defaultBranch").map(|s| s.to_str_lossy().trim().to_string()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "master".into());
    std::fs::write(gitdir.join("description"), "Unnamed repository; edit this file 'description' to name the repository.\n")?;
    std::fs::write(
        gitdir.join("info/exclude"),
        "# git ls-files --others --exclude-from=.git/info/exclude\n# Lines that start with '#' are comments.\n# For a project mostly in C, the following would be a good set of\n# exclude patterns (uncomment them if you want to use them):\n# *.[oa]\n# *~\n",
    )?;
    let mut cfg = String::from("[core]\n\trepositoryformatversion = 0\n");
    cfg.push_str(&format!("\tfilemode = {}\n", cfg!(unix)));
    cfg.push_str("\tbare = false\n\tlogallrefupdates = true\n");
    cfg.push_str(&format!("\tworktree = {}\n", config_value(&workspace.to_string_lossy())));
    std::fs::write(gitdir.join("config"), &cfg)?;
    // Same probes as `git init`: case-insensitive filesystem, macOS unicode.
    if gitdir.join("CoNfIg").exists() {
        cfg.push_str("\tignorecase = true\n");
    }
    if cfg!(target_os = "macos") {
        cfg.push_str("\tprecomposeunicode = true\n");
    }
    cfg.push_str("\tautocrlf = false\n\tlongpaths = true\n\tsymlinks = true\n\tfsmonitor = false\n");
    cfg.push_str(&format!("[user]\n\temail = {USER_EMAIL}\n\tname = {USER_NAME}\n"));
    std::fs::write(gitdir.join("config"), cfg)?;
    std::fs::write(gitdir.join("HEAD"), format!("ref: refs/heads/{branch}\n"))?;
    Ok(())
}

/// Quote a git-config value the way `git config` writes it.
fn config_value(v: &str) -> String {
    let escaped = v.replace('\\', "\\\\").replace('"', "\\\"");
    if escaped.starts_with(' ') || escaped.ends_with(' ') || escaped.contains(['#', ';']) {
        format!("\"{escaped}\"")
    } else {
        escaped
    }
}

/// `git rev-parse --path-format=absolute --git-common-dir` in `worktree`.
pub(crate) fn common_git_dir(worktree: &Path) -> Option<PathBuf> {
    let repo = gix::discover(worktree).ok()?;
    Some(dunce::canonicalize(repo.common_dir()).unwrap_or_else(|_| repo.common_dir().to_path_buf()))
}

fn load_index(repo: &gix::Repository) -> Result<gix::index::File> {
    match repo.open_index() {
        Ok(i) => Ok(i),
        Err(e) if e.downcast_any_ref::<gix::index::file::init::OpenError>().is_some_and(|o| o.source.kind() == std::io::ErrorKind::NotFound) => {
            Ok(gix::index::File::from_state(gix::index::State::new(repo.object_hash()), repo.index_path()))
        }
        Err(e) => Err(e.into()),
    }
}

/// Outcome of bringing the index up to date with the worktree.
struct Staged {
    /// Entries were added, removed or re-hashed.
    content: bool,
    /// The index must be written (content changes or refreshed stat data).
    dirty: bool,
}

/// `list_candidate_paths` + `stage`, applied to `index` in memory.
fn stage_changes(repo: &gix::Repository, workspace: &Path, index: &mut gix::index::File, max_untracked: u64) -> Result<Staged> {
    use gix::status::index_worktree::Item;
    use gix::status::plumbing::index_as_worktree::{Change, EntryStatus};

    let mut removed: Vec<BString> = vec![];
    let mut restage: Vec<BString> = vec![];
    let mut stat_fix: Vec<(BString, Stat)> = vec![];
    let iter = repo
        .status(gix::progress::Discard)?
        .index(gix::worktree::IndexPersistedOrInMemory::InMemory(index.clone()))
        .untracked_files(gix::status::UntrackedFiles::Files)
        .index_worktree_submodules(gix::status::Submodule::Given { ignore: gix::submodule::config::Ignore::Dirty, check_dirty: false })
        .index_worktree_rewrites(None)
        .into_index_worktree_iter(Vec::<BString>::new())?;
    for item in iter {
        match item? {
            Item::Modification { rela_path, status, .. } => match status {
                EntryStatus::Change(Change::Removed) => removed.push(rela_path),
                EntryStatus::NeedsUpdate(stat) => stat_fix.push((rela_path, stat)),
                _ => restage.push(rela_path),
            },
            Item::DirectoryContents { entry, .. } => {
                if entry.status != gix::dir::entry::Status::Untracked {
                    continue;
                }
                // Like the CLI engine: skip untracked files over the cap (and
                // anything `stat` can't follow, e.g. dangling symlinks).
                match std::fs::metadata(workspace.join(gix::path::from_bstr(entry.rela_path.as_bstr())?)) {
                    Ok(m) if m.len() > max_untracked => continue,
                    Ok(_) => restage.push(entry.rela_path),
                    Err(_) => continue,
                }
            }
            Item::Rewrite { .. } => {}
        }
    }

    for (path, stat) in &stat_fix {
        if let Some(e) = index.entry_mut_by_path_and_stage(path.as_bstr(), Stage::Unconflicted) {
            e.stat = *stat;
        }
    }
    if removed.is_empty() && restage.is_empty() {
        return Ok(Staged { content: false, dirty: !stat_fix.is_empty() });
    }

    let filemode = repo.config_snapshot().boolean("core.filemode").unwrap_or(cfg!(unix));
    let mut upserts: Vec<(BString, ObjectId, Mode, Stat)> = vec![];
    {
        let (mut pipeline, _) = repo.filter_pipeline(None)?;
        for path in restage {
            let existing = index.entry_by_path(path.as_bstr()).map(|e| e.mode);
            match pipeline.worktree_file_to_object(path.as_bstr(), index)? {
                None => removed.push(path),
                Some((id, kind, _)) => {
                    use gix::objs::tree::EntryKind;
                    let mut mode = match kind {
                        EntryKind::Blob => Mode::FILE,
                        EntryKind::BlobExecutable => Mode::FILE_EXECUTABLE,
                        EntryKind::Link => Mode::SYMLINK,
                        EntryKind::Commit => Mode::COMMIT,
                        EntryKind::Tree => continue,
                    };
                    if !filemode && (mode == Mode::FILE || mode == Mode::FILE_EXECUTABLE) {
                        mode = if existing == Some(Mode::FILE_EXECUTABLE) { Mode::FILE_EXECUTABLE } else { Mode::FILE };
                    }
                    let abs = workspace.join(gix::path::from_bstr(path.as_bstr())?);
                    let stat = gix::index::fs::Metadata::from_path_no_follow(&abs).ok().and_then(|m| Stat::from_fs(&m).ok()).unwrap_or_default();
                    upserts.push((path, id, mode, stat));
                }
            }
        }
    }

    // Drop replaced entries, including directory/file conflicts: a file
    // replacing a directory removes `path/…`, a file under a former file
    // path removes that file (`git add` with ADD_CACHE_OK_TO_REPLACE).
    let mut drop: HashSet<BString> = removed.into_iter().collect();
    let mut parents: HashSet<BString> = HashSet::new();
    for (path, ..) in &upserts {
        drop.insert(path.clone());
        let mut p: &[u8] = path.as_ref();
        while let Some(pos) = p.rfind_byte(b'/') {
            p = &p[..pos];
            parents.insert(p.into());
        }
    }
    let upsert_paths: HashSet<&[u8]> = upserts.iter().map(|(p, ..)| p.as_bytes()).collect();
    index.remove_entries(|_, path, _| {
        if drop.contains(path) || parents.contains(path) {
            return true;
        }
        let mut p: &[u8] = path.as_ref();
        while let Some(pos) = p.rfind_byte(b'/') {
            p = &p[..pos];
            if upsert_paths.contains(p) {
                return true;
            }
        }
        false
    });
    for (path, id, mode, stat) in &upserts {
        index.dangerously_push_entry(*stat, *id, gix::index::entry::Flags::empty(), *mode, path.as_bstr());
    }
    index.sort_entries();
    Ok(Staged { content: true, dirty: true })
}

fn write_index(index: &mut gix::index::File) -> Result<()> {
    // gix writes the cache-tree as-is; a stale one would make `git write-tree`
    // (v2) produce wrong trees, so drop it after any change.
    index.remove_tree();
    index.write(gix::index::write::Options::default())?;
    Ok(())
}

/// `git write-tree` over the stage-0 entries of `index`.
fn write_tree(repo: &gix::Repository, index: &gix::index::State) -> Result<ObjectId> {
    let entries: Vec<(&BStr, Mode, ObjectId)> = index.entries().iter().filter(|e| e.stage() == Stage::Unconflicted).map(|e| (e.path(index), e.mode, e.id)).collect();
    build_tree(repo, &entries.iter().map(|(p, m, id)| (p.as_bytes(), *m, *id)).collect::<Vec<_>>())
}

fn build_tree(repo: &gix::Repository, entries: &[(&[u8], Mode, ObjectId)]) -> Result<ObjectId> {
    use gix::objs::tree::{Entry, EntryKind};
    let mut out: Vec<Entry> = Vec::new();
    let mut i = 0;
    while i < entries.len() {
        let (rel, mode, id) = entries[i];
        match rel.find_byte(b'/') {
            Some(pos) => {
                let name = &rel[..pos];
                let mut j = i;
                let mut sub = Vec::new();
                while j < entries.len() && entries[j].0.len() > pos && entries[j].0[pos] == b'/' && &entries[j].0[..pos] == name {
                    sub.push((&entries[j].0[pos + 1..], entries[j].1, entries[j].2));
                    j += 1;
                }
                let oid = build_tree(repo, &sub)?;
                out.push(Entry { mode: EntryKind::Tree.into(), filename: name.into(), oid });
                i = j;
            }
            None => {
                let Some(m) = mode.to_tree_entry_mode() else {
                    i += 1;
                    continue;
                };
                out.push(Entry { mode: m, filename: rel.into(), oid: id });
                i += 1;
            }
        }
    }
    out.sort();
    write_if_missing(repo, &gix::objs::Tree { entries: out })
}

fn write_if_missing(repo: &gix::Repository, tree: &gix::objs::Tree) -> Result<ObjectId> {
    use gix::objs::WriteTo;
    let mut buf = Vec::new();
    tree.write_to(&mut buf)?;
    let id = gix::objs::compute_hash(repo.object_hash(), gix::objs::Kind::Tree, &buf)?;
    if !repo.has_object(id) {
        repo.write_object(tree)?;
    }
    Ok(id)
}

/// `rev-parse --verify` the snapshot ref, else `commit-tree` + `update-ref`.
fn ensure_ref(repo: &gix::Repository, tree: ObjectId) -> Result<()> {
    let name = format!("{}/{}", crate::snapshot::SNAPSHOT_REF_PREFIX, tree);
    if repo.try_find_reference(name.as_str())?.is_some() {
        return Ok(());
    }
    let commit = repo.new_commit("snapshot\n", tree, Vec::<ObjectId>::new())?;
    repo.reference(name.as_str(), commit.id, gix::refs::transaction::PreviousValue::Any, "snapshot")?;
    Ok(())
}

/// Snapshot `workspace` into the repo at `gitdir` → tree hash. When nothing
/// changed and `last` is known, returns `last` without writing anything.
pub(crate) fn track(gitdir: &Path, workspace: &Path, last: Option<&str>, max_untracked: u64) -> Result<String> {
    let repo = open(gitdir, workspace)?;
    let mut index = load_index(&repo)?;
    let staged = stage_changes(&repo, workspace, &mut index, max_untracked)?;
    if staged.dirty {
        write_index(&mut index)?;
    }
    if let (false, Some(last)) = (staged.content, last) {
        return Ok(last.to_string());
    }
    let tree = write_tree(&repo, &index)?;
    ensure_ref(&repo, tree)?;
    Ok(tree.to_string())
}

/// Changed paths from a restore, in path order.
pub(crate) struct Restored {
    pub added: Vec<String>,
    pub modified: Vec<String>,
    pub removed: Vec<String>,
}

fn flatten_tree(repo: &gix::Repository, id: ObjectId, prefix: &[u8], out: &mut BTreeMap<BString, (Mode, ObjectId)>) -> Result<()> {
    let tree = repo.find_tree(id)?;
    for e in tree.decode()?.entries {
        let mut path = prefix.to_vec();
        if !path.is_empty() {
            path.push(b'/');
        }
        path.extend_from_slice(e.filename);
        if e.mode.is_tree() {
            flatten_tree(repo, e.oid.to_owned(), &path, out)?;
        } else {
            out.insert(path.into(), (Mode::from(e.mode), e.oid.to_owned()));
        }
    }
    Ok(())
}

/// `diff-index -R --cached <snapshot>` + `checkout-index -f` for the added and
/// modified paths. Deleting the extras is left to the caller.
pub(crate) fn restore(gitdir: &Path, workspace: &Path, snapshot: &str, skip_stage: bool, max_untracked: u64) -> Result<Restored> {
    let repo = open(gitdir, workspace)?;
    let mut index = load_index(&repo)?;
    if !skip_stage && stage_changes(&repo, workspace, &mut index, max_untracked)?.dirty {
        write_index(&mut index)?;
    }
    let tree_id = ObjectId::from_hex(snapshot.as_bytes())?;
    let mut snap = BTreeMap::new();
    flatten_tree(&repo, tree_id, b"", &mut snap)?;
    let cur: BTreeMap<BString, (Mode, ObjectId)> =
        index.entries().iter().filter(|e| e.stage() == Stage::Unconflicted).map(|e| (e.path(&index).to_owned(), (e.mode, e.id))).collect();
    let (mut added, mut modified, mut removed) = (vec![], vec![], vec![]);
    for (path, want) in &snap {
        match cur.get(path) {
            None => added.push(path.clone()),
            Some(have) if have != want => modified.push(path.clone()),
            Some(_) => {}
        }
    }
    for path in cur.keys() {
        if !snap.contains_key(path) {
            removed.push(path.clone());
        }
    }
    let (mut pipeline, _) = repo.filter_pipeline(None)?;
    for path in added.iter().chain(modified.iter()) {
        let (mode, id) = snap[path];
        checkout_entry(&repo, &mut pipeline, workspace, path.as_bstr(), mode, id)?;
    }
    let s = |v: Vec<BString>| v.into_iter().map(|p| p.to_str_lossy().into_owned()).collect();
    Ok(Restored { added: s(added), modified: s(modified), removed: s(removed) })
}

/// `checkout-index -f` for one entry: replaces whatever is at the path
/// (including a directory) and any file blocking a parent directory.
fn checkout_entry(repo: &gix::Repository, pipeline: &mut gix::filter::Pipeline<'_>, workspace: &Path, rela: &BStr, mode: Mode, id: ObjectId) -> Result<()> {
    let target = workspace.join(gix::path::from_bstr(rela)?);
    clear_path(workspace, &target)?;
    if mode == Mode::COMMIT {
        std::fs::create_dir_all(&target)?;
        return Ok(());
    }
    let data = repo.find_blob(id)?.detach().data;
    if mode == Mode::SYMLINK {
        return write_symlink(&target, &data);
    }
    use gix::filter::plumbing::driver::apply::{Delay, MaybeDelayed};
    use gix::filter::plumbing::pipeline::convert::{to_worktree, ToWorktreeOutcome};
    let opts = to_worktree::Options { can_delay: Delay::Forbid, ..Default::default() };
    let bytes: Vec<u8> = match pipeline.convert_to_worktree(&data, rela, opts)? {
        ToWorktreeOutcome::Unchanged(b) => b.to_vec(),
        ToWorktreeOutcome::Buffer(b) => b.to_vec(),
        ToWorktreeOutcome::Process(MaybeDelayed::Immediate(mut r)) => {
            let mut v = Vec::new();
            std::io::Read::read_to_end(&mut r, &mut v)?;
            v
        }
        ToWorktreeOutcome::Process(MaybeDelayed::Delayed(_)) => return Err("filter driver delayed output".into()),
    };
    write_file(&target, &bytes, mode == Mode::FILE_EXECUTABLE)
}

fn clear_path(workspace: &Path, target: &Path) -> Result<()> {
    if let Ok(md) = std::fs::symlink_metadata(target) {
        if md.is_dir() {
            std::fs::remove_dir_all(target)?;
        } else {
            std::fs::remove_file(target)?;
        }
    }
    // A file (or symlink) where a parent directory must go.
    let mut blockers = vec![];
    let mut d = target.parent();
    while let Some(p) = d {
        if p == workspace || !p.starts_with(workspace) {
            break;
        }
        blockers.push(p.to_path_buf());
        d = p.parent();
    }
    for p in blockers.iter().rev() {
        match std::fs::symlink_metadata(p) {
            Ok(md) if !md.is_dir() => std::fs::remove_file(p)?,
            _ => {}
        }
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    Ok(())
}

fn write_file(target: &Path, bytes: &[u8], executable: bool) -> Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(if executable { 0o777 } else { 0o666 });
    }
    let _ = executable;
    opts.open(target)?.write_all(bytes)?;
    Ok(())
}

fn write_symlink(target: &Path, link_to: &[u8]) -> Result<()> {
    let dest = gix::path::from_bstr(link_to.as_bstr())?.into_owned();
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&dest, target)?;
        Ok(())
    }
    #[cfg(windows)]
    {
        // Needs Developer Mode or the symlink privilege; otherwise write the
        // link text as a file, like git does without symlink support.
        if std::os::windows::fs::symlink_file(&dest, target).is_err() {
            write_file(target, link_to, false)?;
        }
        Ok(())
    }
}
