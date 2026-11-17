//! `agentd` commands against the real binary in throw-away `HOME`/XDG
//! roots. Nothing here touches real user data.

use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

struct Sandbox {
    root: tempfile::TempDir,
}

impl Sandbox {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("home")).unwrap();
        Sandbox { root }
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.root.path().join(rel)
    }

    fn write(&self, rel: &str, content: &str) -> PathBuf {
        let p = self.path(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, content).unwrap();
        p
    }

    fn run(&self, args: &[&str]) -> Output {
        self.run_bin(env!("CARGO_BIN_EXE_agentd"), args)
    }

    fn run_bin(&self, bin: &str, args: &[&str]) -> Output {
        self.run_bin_with(bin, args, &[])
    }

    fn run_with(&self, args: &[&str], env: &[(&str, &str)]) -> Output {
        self.run_bin_with(env!("CARGO_BIN_EXE_agentd"), args, env)
    }

    fn run_bin_with(&self, bin: &str, args: &[&str], env: &[(&str, &str)]) -> Output {
        let mut cmd = Command::new(bin);
        cmd.args(args).current_dir(self.root.path()).stdin(Stdio::null());
        for (k, d) in [
            ("OPENAGENTD_DATA_DIR", "data"),
            ("OPENAGENTD_CONFIG_DIR", "config"),
            ("OPENAGENTD_STATE_DIR", "state"),
            ("OPENAGENTD_CACHE_DIR", "cache"),
            ("OPENAGENTD_WORKSPACE_DIR", "ws"),
            ("HOME", "home"),
            ("USERPROFILE", "home"),
        ] {
            cmd.env(k, self.path(d));
        }
        cmd.env("OPENAGENTD_ENV", "production")
            .env("NO_COLOR", "1")
            .env("OPENAGENTD_MODEL_REGISTRY_REFRESH", "false")
            .env("OPENAGENTD_SNAPSHOT_MAINTENANCE_ENABLED", "false")
            // No release lookups from tests: a closed port answers at once.
            .env("OPENAGENTD_RELEASES_URL", "http://127.0.0.1:9");
        for k in [
            "OPENAGENTD_DESKTOP_TOKEN",
            "OPENAGENTD_ACCESS_KEY",
            "OPENAGENTD_HANDSHAKE_FILE",
            "DATABASE_URL",
            "OPENAGENTD_DATABASE_URL",
            "AGENTS_DIR",
            "OPENAGENTD_AGENTS_DIR",
            "SKILLS_DIR",
            "OPENAGENTD_SKILLS_DIR",
            "RUST_LOG",
            "LOG_LEVEL",
            "OPENAGENTD_LOG_LEVEL",
            "OPENAI_API_KEY",
            "AGENTD_AGENT",
        ] {
            cmd.env_remove(k);
        }
        for (k, v) in env {
            cmd.env(k, v);
        }
        cmd.output().expect("run agentd")
    }
}

fn stdout(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).into_owned()
}

fn stderr(o: &Output) -> String {
    String::from_utf8_lossy(&o.stderr).into_owned()
}

fn code(o: &Output) -> i32 {
    o.status.code().unwrap_or(-1)
}

#[test]
fn version_prints_the_release_string() {
    let o = Sandbox::new().run(&["--version"]);
    assert_eq!(code(&o), 0);
    assert_eq!(stdout(&o), format!("agentd v{}\n", env!("CARGO_PKG_VERSION")));
}

#[test]
fn remote_login_help_works_under_both_names() {
    let sb = Sandbox::new();
    for name in ["remote", "cloud"] {
        let o = sb.run(&[name, "login", "--help"]);
        assert_eq!(code(&o), 0, "agentd {name} login --help: {}", stderr(&o));
        let usage = format!("Usage: agentd{} remote login", std::env::consts::EXE_SUFFIX);
        assert!(stdout(&o).contains(&usage), "{}", stdout(&o));
    }
}

#[test]
fn cloud_approve_refuses_without_a_terminal_or_under_an_agent() {
    let sb = Sandbox::new();
    // Answers piped in (stdin is not a terminal): `printf 'y\ny\n' | agentd cloud approve`.
    let o = sb.run(&["cloud", "approve"]);
    assert_eq!(code(&o), 1, "{}", stderr(&o));
    assert!(stderr(&o).contains("Run this in Terminal"), "{}", stderr(&o));
    // Anything an agent runs carries the marker.
    let o = sb.run_with(&["cloud", "approve"], &[("AGENTD_AGENT", "1")]);
    assert_eq!(code(&o), 1, "{}", stderr(&o));
    assert!(stderr(&o).contains("An agent cannot approve devices"), "{}", stderr(&o));
}

#[test]
fn cloud_recover_needs_a_person_at_a_terminal() {
    let sb = Sandbox::new();
    // The recovery code is never taken from a pipe or an agent's shell: it signs a roster.
    let o = sb.run(&["cloud", "recover"]);
    assert_eq!(code(&o), 1, "{}", stderr(&o));
    assert!(stderr(&o).contains("Run this in Terminal"), "{}", stderr(&o));
    let o = sb.run_with(&["cloud", "recover"], &[("AGENTD_AGENT", "1")]);
    assert_eq!(code(&o), 1, "{}", stderr(&o));
    assert!(stderr(&o).contains("An agent cannot approve devices"), "{}", stderr(&o));
}

/// A cloud that hands out one device code and denies it on the first poll.
fn denying_cloud() -> String {
    use axum::routing::post;
    use axum::{Form, Json};
    use std::collections::HashMap;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async move {
            let code = |Form(form): Form<HashMap<String, String>>| async move {
                let auth: [u8; 32] = openagentd_cloud::encoding::from_b64_array(&form["auth_pub"]).unwrap();
                Json(serde_json::json!({
                    "device_code": "dc", "user_code": "BCDF-GHJK", "device_id": openagentd_cloud::keys::device_id(&auth),
                    "expires_in": 600, "interval": 1
                }))
            };
            let token = || async { (axum::http::StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "access_denied" }))) };
            let app = axum::Router::new().route("/v1/device/code", post(code)).route("/v1/device/token", post(token));
            axum::serve(tokio::net::TcpListener::from_std(listener).unwrap(), app).await.unwrap();
        });
    });
    base
}

#[test]
fn cloud_login_without_a_terminal_offers_only_the_browser_way() {
    let sb = Sandbox::new();
    let cloud = denying_cloud();
    let o = sb.run_with(&["cloud", "login"], &[("OPENAGENTD_CLOUD_API", &cloud), ("OPENAGENTD_CLOUD_ACCOUNT", "https://account.openagentd.dev")]);
    let out = stdout(&o);
    assert!(out.contains("https://account.openagentd.dev/device?code=BCDF-GHJK"), "{out}");
    // Nobody could type the phone's number back, so no scan code is drawn.
    assert!(!out.contains("Scan with OpenAgentd on your phone") && !out.contains('▀'), "{out}");
    assert!(out.contains("denied"), "{out}");
    assert_eq!(code(&o), 1);
}

#[test]
fn an_unknown_mode_is_refused() {
    let o = Sandbox::new().run_with(&["doctor"], &[("OPENAGENTD_ENV", "staging")]);
    assert_ne!(code(&o), 0);
    assert!(stderr(&o).contains("OPENAGENTD_ENV"), "{}", stderr(&o));
}

/// `server start --cloud` starts the server, then signs in as `agentd cloud
/// login` does; the server keeps running whatever the sign-in's outcome.
// Unix only, like serve_shutdown.rs: on Windows the daemon inherits the
// CLI's captured stdout pipe, so the test's `output()` never sees it close.
#[cfg(unix)]
#[test]
fn start_with_cloud_signs_in_once_the_server_answers() {
    let sb = Sandbox::new();
    let cloud = denying_cloud();
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port().to_string();
    let env = [("OPENAGENTD_CLOUD_API", cloud.as_str()), ("OPENAGENTD_CLOUD_ACCOUNT", "https://account.openagentd.dev")];
    let o = sb.run_with(&["server", "start", "--port", &port, "--cloud"], &env);
    let running = sb.run(&["server", "status", "--port", &port]);
    let _ = sb.run(&["server", "stop"]);
    let out = stdout(&o);
    assert!(out.contains("agentd server stop"), "the server started first:\n{out}{}", stderr(&o));
    assert!(out.contains("https://account.openagentd.dev/device?code=BCDF-GHJK"), "then the sign-in:\n{out}");
    assert!(out.contains("denied"), "{out}");
    assert!(!out.contains("From anywhere:"), "no hint next to the sign-in itself:\n{out}");
    assert_eq!(code(&running), 0, "still running after the sign-in:\n{}", stdout(&running));
}

#[test]
fn doctor_moves_server_settings_out_of_dotenv_and_names_the_rest() {
    let sb = Sandbox::new();
    sb.write("config/.env", "LOG_LEVEL=WARNING\nOPENAGENTD_FS_WATCH=false\n");
    let o = sb.run(&["doctor"]);
    let yaml = std::fs::read_to_string(sb.path("config/server.yaml")).unwrap();
    assert!(yaml.contains("log_level: WARNING"), "{yaml}");
    assert_eq!(std::fs::read_to_string(sb.path("config/.env")).unwrap(), "OPENAGENTD_FS_WATCH=false\n");
    let out = stdout(&o);
    assert!(out.contains("deprecated") && out.contains("OPENAGENTD_FS_WATCH"), "{out}");
}

#[test]
fn openagentd_alias_forwards_to_agentd() {
    let sb = Sandbox::new();
    let o = sb.run_bin(env!("CARGO_BIN_EXE_openagentd"), &["--version"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(stdout(&o), format!("agentd v{}\n", env!("CARGO_PKG_VERSION")));
    assert_eq!(stderr(&o), "", "no deprecation note off a terminal");
    let o = sb.run_bin(env!("CARGO_BIN_EXE_openagentd"), &["bogus"]);
    assert_eq!(code(&o), 2, "exit codes are forwarded");
}

#[test]
fn bare_agentd_prints_help_without_starting_a_server() {
    let sb = Sandbox::new();
    let o = sb.run(&[]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    let out = stdout(&o);
    assert!(out.contains("Usage: agentd") && out.contains("server"), "{out}");
    assert!(!sb.path("state/openagentd.pid").exists(), "no daemon may start");
}

#[test]
fn unknown_commands_are_usage_errors() {
    let o = Sandbox::new().run(&["bogus"]);
    assert_eq!(code(&o), 2);
    assert!(stderr(&o).contains("error:"), "{}", stderr(&o));
}

#[test]
fn status_of_a_stopped_server_fails_and_health_is_the_same_command() {
    let sb = Sandbox::new();
    for cmd in ["status", "health"] {
        let o = sb.run(&["server", cmd]);
        assert_eq!(code(&o), 1, "server {cmd}");
        assert!(stdout(&o).contains("stopped"), "{}", stdout(&o));
    }
    let o = sb.run(&["server", "logs"]);
    assert_eq!(code(&o), 1);
    assert!(stderr(&o).contains("no server log"), "{}", stderr(&o));
    let o = sb.run(&["server", "status", "--qr"]);
    assert_eq!(code(&o), 1);
    assert!(stdout(&o).contains("stopped") && !stdout(&o).contains('█'), "{}", stdout(&o));
}

#[test]
fn public_needs_an_access_key_and_conflicts_with_host() {
    let sb = Sandbox::new();
    let o = sb.run(&["server", "start", "--public", "--qr"]);
    assert_eq!(code(&o), 1);
    assert!(stderr(&o).contains("refusing to listen on 0.0.0.0"), "{}", stderr(&o));
    assert!(!sb.path("state/openagentd.pid").exists(), "no daemon may start");
    let o = sb.run(&["server", "start", "--public", "--host", "1.2.3.4"]);
    assert_eq!(code(&o), 2);
    assert!(stderr(&o).contains("cannot be used with"), "{}", stderr(&o));
}

/// `server start` used to print "Stop: agentd server stop" (and, with
/// `--qr`, the pairing code) and exit 0 while the server it spawned died on
/// a port something else already had.
#[test]
fn start_says_why_the_server_did_not_start() {
    let sb = Sandbox::new();
    let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = taken.local_addr().unwrap().port().to_string();
    let o = sb.run(&["server", "start", "--port", &port, "--qr"]);
    assert_eq!(code(&o), 1, "{}{}", stdout(&o), stderr(&o));
    assert!(stderr(&o).contains(&format!("port {port} is already in use")), "{}", stderr(&o));
    let out = stdout(&o);
    assert!(!out.contains("agentd server stop") && !out.contains("--qr needs"), "nothing started, so nothing to stop or scan:\n{out}");
    assert!(!sb.path("state/openagentd.pid").exists(), "no daemon may start");
}

fn provider_line(out: &str, id: &str) -> String {
    out.lines().find(|l| l.trim_start().starts_with(id)).unwrap_or_else(|| panic!("no {id} line in:\n{out}")).to_string()
}

#[test]
fn auth_list_shows_logins_and_logout_removes_them() {
    let sb = Sandbox::new();
    let out = stdout(&sb.run(&["auth", "list"]));
    for id in ["codex", "copilot", "grok"] {
        assert!(provider_line(&out, id).contains("not logged in"), "{out}");
    }
    // A legacy token file is migrated into credentials.yaml on first use and
    // left in place (never deleted); logout removes the stored account.
    let token = sb.write("cache/codex_oauth.json", "{}");
    let out = stdout(&sb.run(&["auth"]));
    assert!(!provider_line(&out, "codex").contains("not logged in"), "{out}");
    let store = sb.path("config/credentials.yaml");
    assert!(std::fs::read_to_string(&store).unwrap().contains("codex"));

    let o = sb.run(&["auth", "logout", "codex"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert!(stdout(&o).contains("Logged out of codex"), "{}", stdout(&o));
    assert!(!std::fs::read_to_string(&store).unwrap().contains("codex:"));
    assert!(token.exists(), "legacy files are kept as a backup");
    let out = stdout(&sb.run(&["auth", "list"]));
    assert!(provider_line(&out, "codex").contains("not logged in"), "{out}");
    assert!(stdout(&sb.run(&["auth", "logout", "codex"])).contains("was not logged in"));
}

#[test]
fn doctor_reads_provider_keys_from_the_config_env() {
    let sb = Sandbox::new();
    sb.write("config/.env", "OPENAI_API_KEY=test-key\n");
    sb.write("config/agents/code.md", "---\nname: code\nmodel: openai:gpt-5.5\n---\n\nYou write code.\n");
    let o = sb.run(&["doctor"]);
    let out = stdout(&o);
    assert_eq!(code(&o), 0, "{out}");
    assert!(out.contains("API key: OPENAI_API_KEY"), "{out}");
    assert!(out.contains("Main agent key is set: OPENAI_API_KEY"), "{out}");
}

#[test]
fn doctor_fails_an_oauth_lead_provider_without_a_login() {
    let sb = Sandbox::new();
    sb.write("config/agents/code.md", "---\nname: code\nmodel: codex:gpt-5.5\n---\n");
    let o = sb.run(&["doctor"]);
    assert_eq!(code(&o), 1);
    assert!(stdout(&o).contains("run `agentd auth codex`"), "{}", stdout(&o));
    sb.write("cache/codex_oauth.json", "{}");
    let o = sb.run(&["doctor"]);
    assert_eq!(code(&o), 0, "{}", stdout(&o));
    assert!(stdout(&o).contains("Main agent provider 'codex' is logged in"));
}

#[test]
fn cleanup_without_a_database_skips_and_creates_nothing() {
    let sb = Sandbox::new();
    let o = sb.run(&["cleanup"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert!(stdout(&o).contains("dry run") && stdout(&o).contains("Database not initialized"), "{}", stdout(&o));
    assert!(!sb.path("data/openagentd.db").exists());
}

/// Old managed worktrees go through git (`git worktree list` and the sidebar
/// stop listing them); one holding uncommitted work is kept.
#[test]
fn cleanup_removes_old_worktrees_through_git_and_keeps_work() {
    let sb = Sandbox::new();
    let git = |dir: &std::path::Path, args: &[&str]| {
        let o = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
        assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stdout).to_string()
    };
    let app = sb.path("app");
    std::fs::create_dir_all(&app).unwrap();
    git(&app, &["init", "-q", "-b", "main"]);
    for (k, v) in [("user.name", "t"), ("user.email", "t@t"), ("commit.gpgsign", "false")] {
        git(&app, &["config", k, v]);
    }
    std::fs::write(app.join("a.txt"), "a\n").unwrap();
    git(&app, &["add", "."]);
    git(&app, &["commit", "-qm", "init"]);
    let app = appv3_db::resolve_path(&app.display().to_string());
    let app = std::path::Path::new(&app);
    // Where OpenAgentd puts this repository's worktrees with the data dir set.
    let root = sb.path("data/worktrees").join(appv3_agent::worktrees::repo_folder(app));
    let (old, wip) = (root.join("old"), root.join("wip"));
    git(app, &["worktree", "add", "-q", "-b", "oad/old", old.to_str().unwrap()]);
    git(app, &["worktree", "add", "-q", "-b", "oad/wip", wip.to_str().unwrap()]);
    std::fs::write(wip.join("notes.txt"), "unsaved\n").unwrap();
    let old_path = appv3_db::resolve_path(&old.display().to_string());
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let pool = appv3_db::create_pool(sb.path("data/openagentd.db")).await.unwrap();
        appv3_db::upsert_coding_workspace(&pool, &old_path, "worktree", Some(&app.display().to_string()), None, true, false).await.unwrap();
        pool.close().await;
    });

    let o = sb.run(&["cleanup", "--apply", "--older-than-days", "0"]);
    assert_eq!(code(&o), 0, "{}\n{}", stdout(&o), stderr(&o));
    assert!(!old.exists(), "the old worktree is removed: {}", stdout(&o));
    assert!(wip.is_dir(), "the one with uncommitted work stays");
    let listed = git(app, &["worktree", "list", "--porcelain"]);
    assert!(!listed.contains("/old\n") && listed.contains("/wip\n"), "git no longer lists it: {listed}");
    assert!(!git(app, &["branch", "--list"]).contains("oad/old"), "its merged branch goes too");
    rt.block_on(async {
        let pool = appv3_db::create_pool(sb.path("data/openagentd.db")).await.unwrap();
        let row = appv3_db::get_workspace_by_path(&pool, &old_path).await.unwrap().unwrap();
        assert!(row.deleted_at.is_some(), "the sidebar row is marked removed");
    });
}

#[test]
fn transfer_round_trip_redacts_secrets() {
    let sb = Sandbox::new();
    sb.write("config/agents/code.md", "---\nname: code\n---\nbody\n");
    sb.write("config/.env", "OPENAI_API_KEY=sk-secret\nLOG_LEVEL=INFO\n");
    let archive = sb.path("out/a.tar.gz");
    std::fs::create_dir_all(archive.parent().unwrap()).unwrap();
    let o = sb.run(&["transfer", "export", "-o", archive.to_str().unwrap()]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));

    let other = sb.path("other");
    let o = sb.run(&["transfer", "import", archive.to_str().unwrap(), "--config-dir", other.to_str().unwrap()]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(std::fs::read_to_string(other.join("agents/code.md")).unwrap(), "---\nname: code\n---\nbody\n");
    assert_eq!(std::fs::read_to_string(other.join(".env")).unwrap(), "OPENAI_API_KEY=\nLOG_LEVEL=INFO\n");

    let o = sb.run(&["transfer", "import", archive.to_str().unwrap(), "--config-dir", other.to_str().unwrap()]);
    assert!(stdout(&o).contains("Skipped 2 existing file(s)"), "{}", stdout(&o));

    let bad = sb.write("bad.tar.gz", "not an archive");
    let o = sb.run(&["transfer", "import", bad.to_str().unwrap(), "--config-dir", other.to_str().unwrap()]);
    assert_eq!(code(&o), 1);
    assert!(stderr(&o).contains("not a valid tar.gz archive"), "{}", stderr(&o));
}

#[test]
fn transfer_leaves_the_credential_store_out_unless_secrets_are_included() {
    let sb = Sandbox::new();
    sb.write("config/agents/code.md", "---\nname: code\n---\nbody\n");
    let store = "version: 1\nproviders:\n  openai:\n  - id: cred_a\n    label: Personal\n    values:\n      OPENAI_API_KEY: sk-test-transfer-1234\n";
    sb.write("config/credentials.yaml", store);
    std::fs::create_dir_all(sb.path("out")).unwrap();

    let plain = sb.path("out/plain.tar.gz");
    let o = sb.run(&["transfer", "export", "-o", plain.to_str().unwrap()]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert!(stdout(&o).contains("credentials.yaml left out"), "{}", stdout(&o));
    let other = sb.path("other");
    let o = sb.run(&["transfer", "import", plain.to_str().unwrap(), "--config-dir", other.to_str().unwrap()]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert!(other.join("agents/code.md").is_file());
    assert!(!other.join("credentials.yaml").exists(), "the store stays home by default");

    let full = sb.path("out/full.tar.gz");
    let o = sb.run(&["transfer", "export", "-o", full.to_str().unwrap(), "--include-secrets"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    let third = sb.path("third");
    let o = sb.run(&["transfer", "import", full.to_str().unwrap(), "--config-dir", third.to_str().unwrap()]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert!(std::fs::read_to_string(third.join("credentials.yaml")).unwrap().contains("sk-test-transfer-1234"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(third.join("credentials.yaml")).unwrap().permissions().mode() & 0o777, 0o600);
    }
}

#[test]
fn run_rejects_unknown_sessions_and_missing_workspaces() {
    let sb = Sandbox::new();
    let o = sb.run(&["run", "--prompt", "hi", "--session", "01900000-0000-7000-8000-000000000000"]);
    assert_eq!(code(&o), 1);
    assert!(stderr(&o).contains("session not found"), "{}", stderr(&o));

    let o = sb.run(&["run", "--prompt", "hi", "-C", sb.path("missing").to_str().unwrap()]);
    assert_eq!(code(&o), 1);
    assert!(stderr(&o).contains("does not exist"), "{}", stderr(&o));

    let o = sb.run(&["run", "--prompt", "  "]);
    assert_eq!(code(&o), 1);
    assert!(stderr(&o).contains("must not be blank"), "{}", stderr(&o));
}
