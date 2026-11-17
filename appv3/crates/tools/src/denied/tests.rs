use super::*;

#[test]
fn fnmatch_matches_python() {
    assert!(fnmatch("/a/b/.env", "**/.env"));
    assert!(fnmatch("/a/.env.local", "**/.env.*"));
    assert!(!fnmatch("/a/env", "**/.env"));
    assert!(fnmatch("foo.py", "*.py"));
    assert!(fnmatch("a/b.py", "*.py"), "fnmatch * crosses /");
    assert!(fnmatch("x1", "x[0-9]"));
    assert!(!fnmatch("xa", "x[!a]"));
}

#[test]
fn the_credential_store_is_denied_to_file_and_shell_tools() {
    let tmp = tempfile::tempdir().unwrap();
    let d = DeniedPaths::new(&tmp.path().join("ws"), None);
    let cfg = &appv3_core::settings().config_dir;
    for f in [appv3_core::credentials::FILE_NAME, ".env.migrated", appv3_core::runtime_settings::DOTENV_BACKUP] {
        let p = cfg.join(f);
        assert!(d.validate_path(p.to_str().unwrap()).is_err(), "{f} writable");
        assert!(d.validate_read_path(p.to_str().unwrap()).is_err(), "{f} readable");
        assert!(d.check_command(&format!("cat {}", p.display())).is_some(), "{f} reachable from the shell");
    }
}

#[test]
fn validate_denies_roots_and_patterns() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path().join("ws");
    let denied = tmp.path().join("data");
    std::fs::create_dir_all(&denied).unwrap();
    let d = DeniedPaths::with(&ws, None, Some(vec![denied.clone()]), Some(vec!["**/.env".into()]));
    assert!(d.validate_path("src/a.py").is_ok());
    assert!(d.validate_path(denied.join("x.db").to_str().unwrap()).is_err());
    assert!(d.validate_path(".env").is_err());
    if cfg!(windows) {
        assert!(d.validate_path(".ENV").is_err(), "Windows paths are case-insensitive");
    }
    assert!(d.validate_path("~/x").is_err());
    assert_eq!(d.display_path(&d.workspace_root.join("a/b.txt")), "a/b.txt");
    assert!(d.check_command(&format!("cat {}", denied.join("x").display())).is_some());
}

#[test]
fn read_only_roots_allow_reads_but_not_writes_or_shell() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path().join("ws");
    let cache = tmp.path().join("cache");
    let skills = cache.join("v3-builtin-skills/self-healing/references");
    std::fs::create_dir_all(&skills).unwrap();
    std::fs::write(skills.join("mcp.md"), "x").unwrap();
    std::fs::write(cache.join("other.bin"), "x").unwrap();
    let mut d = DeniedPaths::with(&ws, None, Some(vec![cache.clone()]), Some(vec!["**/.env".into()]));
    d.read_only_roots = vec![resolve(&cache.join("v3-builtin-skills"))];
    let reference = skills.join("mcp.md");
    let reference = reference.to_str().unwrap();
    assert!(d.validate_read_path(reference).is_ok());
    assert!(d.validate_path(reference).is_err(), "write tools keep the cache denial");
    let resolved = resolve(Path::new(reference));
    assert!(!d.is_denied_read_path(&resolved));
    assert!(d.is_denied_path(&resolved));
    assert!(d.check_command(&format!("cat {reference}")).is_some(), "shell keeps the cache denial");
    assert!(d.validate_read_path(cache.join("other.bin").to_str().unwrap()).is_err(), "only the read-only root is exempt");
    assert!(d.validate_read_path(skills.join(".env").to_str().unwrap()).is_err(), "denied patterns still apply");
    assert!(d.validate_read_path("~/x").is_err());
}

#[test]
fn relative_tokens_follow_cd_and_workdir() {
    // Prod: worktrees live under the denied data dir, and `cd mobile && ls ../node_modules`
    // was resolved against the workspace root, so it hit the data dir and was blocked.
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    let ws = data.join("worktrees/repo/feature");
    std::fs::create_dir_all(ws.join("mobile/android")).unwrap();
    let d = DeniedPaths::with(&ws, None, Some(vec![data.clone()]), Some(vec![]));
    assert!(d.check_command("cd mobile/android && ls ../node_modules").is_none());
    assert!(d.check_command("cd mobile; cat ../README.md").is_none());
    assert!(d.check_command_at("ls ../x.ts", &ws.join("mobile")).is_none(), "workdir is the base");
    // Leaving the workspace into the denied root is still blocked, cd or not.
    assert!(d.check_command("ls ../x").is_some());
    assert!(d.check_command("cd mobile && cat ../../openagentd.db").is_some());
    assert!(d.check_command("cd .. && ls").is_some());
    let hit = d.check_command_at("cd mobile && cat ../../../x.db", &ws).unwrap();
    assert_eq!(hit.token, "../../../x.db");
}

#[test]
fn windows_command_split_keeps_backslashes() {
    assert_eq!(split_windows(r#"type C:\data\x.db "C:\Program Files\a b" ''"#).unwrap(), vec!["type", r"C:\data\x.db", r"C:\Program Files\a b", ""]);
    assert_eq!(split_windows(r#"echo "unterminated"#), None);
}
