use super::*;

#[tokio::test]
async fn track_restore_roundtrip() {
    if !is_available() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path().join("ws");
    std::fs::create_dir_all(ws.join("sub")).unwrap();
    std::fs::write(ws.join("a.txt"), "one").unwrap();
    std::fs::write(ws.join("sub/b.txt"), "bee").unwrap();
    // Use an explicit gitdir under tmp by pointing snapshot internals at it.
    let gitdir = tmp.path().join("snap");
    assert!(init_repo(&gitdir, &ws).await);
    let paths = list_candidate_paths(&gitdir, &ws).await;
    assert_eq!(paths.len(), 2);
    assert!(stage(&gitdir, &ws, &paths).await);
    let (gd, wt) = (p(&gitdir), p(&ws));
    let t1 = git(&wt_args(&gd, &wt, &["write-tree"]), Some(&ws), &[], None).await.text().trim().to_string();
    assert_eq!(t1.len(), 40);
    std::fs::write(ws.join("a.txt"), "two").unwrap();
    std::fs::write(ws.join("c.txt"), "new").unwrap();
    std::fs::remove_file(ws.join("sub/b.txt")).unwrap();
    let live = list_candidate_paths(&gitdir, &ws).await;
    stage(&gitdir, &ws, &live).await;
    let d = git(&wt_args(&gd, &wt, &["diff-index", "-R", "--cached", "--name-status", "-r", "-z", "--no-renames", &t1]), Some(&ws), &[], None).await;
    let s = String::from_utf8_lossy(&d.stdout).replace('\0', "|");
    assert!(s.contains("M|a.txt") && s.contains("A|sub/b.txt") && s.contains("D|c.txt"), "{s}");
    delete_extras(&ws, &["c.txt".into()]);
    assert!(!ws.join("c.txt").exists());
}

#[tokio::test]
async fn repack_drops_alternates_whose_repo_was_deleted() {
    if !is_available() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path().join("ws");
    std::fs::create_dir_all(&ws).unwrap();
    let gitdir = tmp.path().join("snap");
    assert!(init_repo(&gitdir, &ws).await);
    let live = tmp.path().join("live-objects");
    std::fs::create_dir_all(&live).unwrap();
    let gone = tmp.path().join("deleted-repo/.git/objects");
    let alternates = gitdir.join("objects/info/alternates");
    std::fs::create_dir_all(alternates.parent().unwrap()).unwrap();
    std::fs::write(&alternates, format!("{}\n{}\n", p(&gone), p(&live))).unwrap();

    repack(&gitdir).await;

    assert_eq!(std::fs::read_to_string(&alternates).unwrap(), format!("{}\n", p(&live)));
    let o = git(&gd_args(&p(&gitdir), &["repack", "-a", "-d", "-q", "-l"]), None, &[], None).await;
    assert_eq!(o.code, 0, "{}", o.err());
}

#[tokio::test]
async fn repack_removes_alternates_file_when_every_entry_is_gone() {
    if !is_available() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path().join("ws");
    std::fs::create_dir_all(&ws).unwrap();
    let gitdir = tmp.path().join("snap");
    assert!(init_repo(&gitdir, &ws).await);
    let alternates = gitdir.join("objects/info/alternates");
    std::fs::create_dir_all(alternates.parent().unwrap()).unwrap();
    std::fs::write(&alternates, format!("{}\n", p(&tmp.path().join("gone/.git/objects")))).unwrap();

    repack(&gitdir).await;

    assert!(!alternates.exists());
}

// ── gix engine vs git CLI engine ────────────────────────────────────────

fn sh(dir: &Path, args: &[&str]) {
    // Both workspaces must produce the same nested commit (its hash is
    // the gitlink in the tree), so pin the dates and ignore the
    // developer's global config.
    let st = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", if cfg!(windows) { "NUL" } else { "/dev/null" })
        .env("GIT_AUTHOR_DATE", "@1700000000 +0000")
        .env("GIT_COMMITTER_DATE", "@1700000000 +0000")
        .output()
        .unwrap();
    assert!(st.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&st.stderr));
}

fn write(ws: &Path, rel: &str, data: &[u8]) {
    let p = ws.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, data).unwrap();
}

/// One mutation step applied identically to both workspaces.
fn mutate(ws: &Path, step: usize) {
    match step {
        0 => {
            write(ws, "a.txt", b"alpha\n");
            write(ws, "dir/b.txt", b"bee\n");
            write(ws, "dir/sub/c.md", b"# c\n");
            write(ws, "space name.txt", b"s\n");
            write(ws, "\u{fc}n\u{ef}.txt", b"unicode\n");
            write(ws, "empty.txt", b"");
            write(ws, ".gitignore", b"ignored/\n*.log\n");
            write(ws, "ignored/x.txt", b"no\n");
            write(ws, "debug.log", b"no\n");
            write(ws, ".gitattributes", b"*.crlf text eol=lf\n");
            write(ws, "file.crlf", b"one\r\ntwo\r\n");
            write(ws, "big.bin", &vec![b'x'; (MAX_FILE_SIZE + 1) as usize]);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                write(ws, "run.sh", b"#!/bin/sh\n");
                std::fs::set_permissions(ws.join("run.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
                std::os::unix::fs::symlink("a.txt", ws.join("link")).unwrap();
            }
        }
        1 => {
            write(ws, "a.txt", b"alpha two\n");
            std::fs::remove_file(ws.join("dir/b.txt")).unwrap();
            write(ws, "dir/new.txt", b"new\n");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(ws.join("run.sh"), std::fs::Permissions::from_mode(0o644)).unwrap();
            }
        }
        2 => {
            // file → directory and directory → file
            std::fs::remove_file(ws.join("a.txt")).unwrap();
            write(ws, "a.txt/inner", b"inner\n");
            std::fs::remove_dir_all(ws.join("dir/sub")).unwrap();
            write(ws, "dir/sub", b"now a file\n");
        }
        3 => {
            // stat-only change: same bytes rewritten
            write(ws, "space name.txt", b"s\n");
        }
        4 => {
            // embedded repository → gitlink
            write(ws, "nested/readme", b"n\n");
            let n = ws.join("nested");
            sh(&n, &["init", "-q"]);
            sh(&n, &["-c", "user.name=t", "-c", "user.email=t@t", "add", "."]);
            sh(&n, &["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "n"]);
        }
        _ => unreachable!(),
    }
}

#[tokio::test]
async fn gix_engine_matches_git_cli() {
    if !is_available() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let (ws_g, ws_c) = (tmp.path().join("ws_gix"), tmp.path().join("ws_cli"));
    let (gd_g, gd_c) = (tmp.path().join("snap_gix"), tmp.path().join("snap_cli"));
    std::fs::create_dir_all(&ws_g).unwrap();
    std::fs::create_dir_all(&ws_c).unwrap();
    // Same canonical paths the real callers pass.
    let (ws_g, ws_c) = (resolve(&ws_g), resolve(&ws_c));
    crate::snapshot_gix::init(&gd_g, &ws_g).unwrap();
    assert!(init_repo_cli(&gd_c, &ws_c).await);
    let key_c = ("cli".to_string(), ws_c.clone());
    let mut last_g: Option<String> = None;
    let mut first = None;
    for step in 0..5 {
        mutate(&ws_g, step);
        mutate(&ws_c, step);
        let tg = crate::snapshot_gix::track(&gd_g, &ws_g, last_g.as_deref(), MAX_FILE_SIZE).unwrap();
        let tc = track_cli("cli", &gd_c, &ws_c, &key_c).await.unwrap();
        LAST_HASHES.lock().unwrap().insert(key_c.clone(), tc.clone());
        assert_eq!(tg, tc, "tree mismatch after step {step}");
        // Every step changes the snapshot except the stat-only one.
        assert_eq!(last_g.as_deref() == Some(tg.as_str()), step == 3, "step {step} tree {tg} vs previous {last_g:?}");
        last_g = Some(tg.clone());
        first.get_or_insert(tg);
        // The index gix wrote must give git (v2) the same tree.
        let (gd, wt) = (p(&gd_g), p(&ws_g));
        let cli_tree = git(&wt_args(&gd, &wt, &["write-tree"]), Some(&ws_g), &[], None).await.text().trim().to_string();
        assert_eq!(cli_tree, last_g.clone().unwrap(), "git write-tree disagrees with gix index after step {step}");
    }
    // The big untracked file and ignored paths are not in the snapshot.
    let (gd, wt) = (p(&gd_g), p(&ws_g));
    let ls = git(&wt_args(&gd, &wt, &["ls-files", "-s"]), Some(&ws_g), &[], None).await.text();
    assert!(!ls.contains("big.bin") && !ls.contains("debug.log") && !ls.contains("ignored/"), "{ls}");
    assert!(ls.contains("160000") && ls.contains("\tnested"), "gitlink missing: {ls}");

    // Restore the first snapshot with gix; re-tracking must reproduce it.
    let first = first.unwrap();
    let r = crate::snapshot_gix::restore(&gd_g, &ws_g, &first, false, MAX_FILE_SIZE).unwrap();
    delete_extras(&ws_g, &r.removed);
    assert!(r.added.contains(&"dir/b.txt".to_string()), "{:?}", r.added);
    assert!(r.removed.contains(&"dir/new.txt".to_string()), "{:?}", r.removed);
    assert_eq!(std::fs::read(ws_g.join("a.txt")).unwrap(), b"alpha\n");
    assert_eq!(std::fs::read(ws_g.join("dir/sub/c.md")).unwrap(), b"# c\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert!(std::fs::metadata(ws_g.join("run.sh")).unwrap().permissions().mode() & 0o111 != 0);
        assert_eq!(std::fs::read_link(ws_g.join("link")).unwrap(), Path::new("a.txt"));
    }
    let again = crate::snapshot_gix::track(&gd_g, &ws_g, None, MAX_FILE_SIZE).unwrap();
    // `nested/` (an untracked repo dir after restore) re-adds as a gitlink.
    let (gd, wt) = (p(&gd_g), p(&ws_g));
    let d = git(&wt_args(&gd, &wt, &["diff-tree", "-r", "--name-only", &first, &again]), Some(&ws_g), &[], None).await.text();
    assert!(d.trim().is_empty() || d.trim() == "nested", "restore not faithful: {d}");
}
